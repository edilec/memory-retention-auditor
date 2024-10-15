import assert from 'node:assert/strict'
import test from 'node:test'

import { daysBetween, isExpired, parseDate } from '../src/index.mjs'
import {
  TODAY,
  apiReport,
  clean,
  cliReport,
  findingsFor,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  rowFor,
} from './support.mjs'

/**
 * The first acceptance criterion: expired and held records are distinguished.
 *
 * They are two different facts and the report keeps them apart in three places
 * a consumer can act on -- two separate fields on the row, a disposition that
 * says which one decided the outcome, and two separate summary counts -- and,
 * most importantly, in the deletion plan itself: a held record never appears in
 * it, however old it is.
 *
 * A test that only asserted the disposition would pass on a tool that had
 * quietly stopped computing expiry at all, so the age and the expiry flag are
 * asserted alongside it.
 */

const withClassAndHolds = (records, classes, holds) => fixture(records, classes, holds, [])

test('an expired record with no hold is planned for deletion', async () => {
  const report = await apiReport(withClassAndHolds(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [],
  ))

  const row = rowFor(report, 'session-1900')
  assert.equal(row.expired, true)
  assert.equal(row.held, false)
  assert.equal(row.ageDays, 256)
  assert.equal(row.disposition, 'delete')
  assert.deepEqual(report.plan.deletions, ['session-1900'])
  assert.equal(report.summary.expired, 1)
  assert.equal(report.summary.expiredAndHeld, 0)
  assert.equal(report.summary.deletePlanned, 1)
  assert.equal(report.status, 'pass')
})

test('the same record under an active hold is held, not deleted, and the plan says so', async () => {
  const report = await apiReport(withClassAndHolds(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [hold('matter-4411', 'active', ['session-1900'])],
  ))

  const row = rowFor(report, 'session-1900')
  // Both facts survive: it really is expired, and it really is held. Collapsing
  // the two into one answer is what loses the reason a record is still there.
  assert.equal(row.expired, true)
  assert.equal(row.held, true)
  assert.deepEqual(row.holds, ['matter-4411'])
  assert.equal(row.disposition, 'hold')
  assert.deepEqual(report.plan.deletions, [], 'a held record is never in the deletion plan')
  assert.equal(report.summary.expired, 1)
  assert.equal(report.summary.expiredAndHeld, 1)
  assert.equal(report.summary.deletePlanned, 0)
  assert.equal(report.summary.held, 1)
  assert.equal(report.status, 'pass', 'a hold doing its job is not a failure')
})

test('two expired records, one held, are told apart in one run', async () => {
  const report = await apiReport(withClassAndHolds(
    [
      record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' }),
      record('session-1901', 'chat-transcript', { lastAccessed: '2026-01-02' }),
    ],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [hold('matter-4411', 'active', ['session-1900'])],
  ))

  assert.equal(rowFor(report, 'session-1900').disposition, 'hold')
  assert.equal(rowFor(report, 'session-1901').disposition, 'delete')
  assert.deepEqual(report.plan.deletions, ['session-1901'])
  assert.equal(report.summary.expired, 2)
  assert.equal(report.summary.expiredAndHeld, 1)
})

test('a hold over the whole class covers a record the hold never names', async () => {
  const report = await apiReport(withClassAndHolds(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [hold('matter-4411', 'active', [], ['chat-transcript'])],
  ))

  assert.equal(rowFor(report, 'session-1900').disposition, 'hold')
  assert.deepEqual(rowFor(report, 'session-1900').holds, ['matter-4411'])
})

test('a released hold does not block a deletion', async () => {
  // The other direction: a guard that treated every hold as active would pass
  // every case above and plan nothing, ever.
  const report = await apiReport(withClassAndHolds(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [hold('matter-4411', 'released', ['session-1900'])],
  ))

  assert.equal(rowFor(report, 'session-1900').held, false)
  assert.equal(rowFor(report, 'session-1900').disposition, 'delete')
  assert.deepEqual(report.plan.deletions, ['session-1900'])
})

test('the evaluation date is an input, and stepping it past the deadline flips the disposition', async () => {
  // The clock is injected, never read: the same inventory is audited on three
  // days and the tool answers three different questions because it was asked
  // three different questions.
  const files = withClassAndHolds(
    [record('session-2031', 'chat-transcript', { lastAccessed: '2026-09-01' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [],
  )

  const before = await apiReport(files, { today: '2026-09-30' })
  assert.equal(rowFor(before, 'session-2031').ageDays, 29)
  assert.equal(rowFor(before, 'session-2031').expired, false)
  assert.equal(rowFor(before, 'session-2031').disposition, 'retain')

  // The boundary is `age >= retainDays`: a class kept for 30 days expires on
  // the thirtieth day, not the thirty-first. A day either side of that line is
  // a record destroyed early or kept late.
  const onTheDay = await apiReport(files, { today: '2026-10-01' })
  assert.equal(rowFor(onTheDay, 'session-2031').ageDays, 30)
  assert.equal(rowFor(onTheDay, 'session-2031').expired, true)
  assert.equal(rowFor(onTheDay, 'session-2031').disposition, 'delete')

  const after = await apiReport(files, { today: '2026-10-02' })
  assert.equal(rowFor(after, 'session-2031').ageDays, 31)
  assert.equal(rowFor(after, 'session-2031').expired, true)
})

test('the basis decides which date the age is measured from', async () => {
  const files = (basis) => withClassAndHolds(
    [record('session-2031', 'chat-transcript', { created: '2026-01-01', lastAccessed: '2026-09-01' })],
    [policyClass('chat-transcript', basis, 30, true, ['support-agent'])],
    [],
  )

  const fromCreated = await apiReport(files('created'))
  const fromAccess = await apiReport(files('lastAccessed'))

  assert.equal(rowFor(fromCreated, 'session-2031').ageDays, 256)
  assert.equal(rowFor(fromCreated, 'session-2031').expired, true)
  assert.equal(rowFor(fromAccess, 'session-2031').ageDays, 13)
  assert.equal(rowFor(fromAccess, 'session-2031').expired, false)
})

test('the evaluation date is stamped on the plan and reaches the human summary', async () => {
  const run = await cliReport(clean(), [], '2026-10-05')

  assert.equal(run.report.plan.evaluatedOn, '2026-10-05')
  const loud = await cliReport(clean(), [])
  assert.equal(loud.report.plan.evaluatedOn, TODAY)
})

test('a hold naming a record the inventory does not list is reported rather than ignored', async () => {
  const report = await apiReport(withClassAndHolds(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
    [hold('matter-4411', 'active', ['session-0001'])],
  ))

  assert.deepEqual(raisedRules(report), ['hold-record-unknown'])
  assert.match(findingsFor(report, 'hold-record-unknown')[0].message, /either the inventory is missing a record under hold or the hold is stale/i)
  assert.equal(report.status, 'fail')
})

test('the date arithmetic underneath is whole days in UTC, and refuses a day that does not exist', () => {
  const from = parseDate('2026-01-01').date
  const to = parseDate('2026-03-01').date

  assert.equal(daysBetween(from, to), 59, '2026 is not a leap year')
  assert.equal(isExpired(from, to, 59), true)
  assert.equal(isExpired(from, to, 60), false)
  assert.equal(parseDate('2026-02-29').ok, false)
  assert.equal(parseDate('2024-02-29').ok, true)
})

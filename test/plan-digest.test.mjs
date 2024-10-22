import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlan, serializePlan } from '../src/index.mjs'
import {
  TODAY,
  apiReport,
  clean,
  fixture,
  hold,
  policyClass,
  record,
} from './support.mjs'

/**
 * The plan is versioned, dated and identified.
 *
 * "Versioned" means three things a reviewer can act on before anybody destroys
 * anything: the policy revision the plan was produced from travels with it, the
 * day it was evaluated for travels with it, and a digest identifies the plan
 * itself so the thing that was approved can be compared with the thing that is
 * about to be run.
 */

const digestOf = (report) => report.plan.digest

test('the same inventory on the same day produces the same digest, twice', async () => {
  const first = await apiReport(clean())
  const second = await apiReport(clean())

  assert.equal(digestOf(first), digestOf(second))
  assert.match(digestOf(first), /^[0-9a-f]{64}$/)
})

test('a different evaluation date produces a different digest', async () => {
  const today = await apiReport(clean())
  const later = await apiReport(clean(), { today: '2027-01-01' })

  assert.notEqual(digestOf(today), digestOf(later))
  assert.equal(today.plan.evaluatedOn, TODAY)
  assert.equal(later.plan.evaluatedOn, '2027-01-01')
})

test('a hold that changes a disposition changes the digest', async () => {
  const expired = [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })]
  const classes = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]

  const unheld = await apiReport(fixture(expired, classes, []))
  const held = await apiReport(fixture(expired, classes, [hold('matter-4411', 'active', ['session-1900'])]))

  assert.deepEqual(unheld.plan.deletions, ['session-1900'])
  assert.deepEqual(held.plan.deletions, [])
  assert.notEqual(digestOf(unheld), digestOf(held))
})

test('a changed policy version changes the digest even when every row is identical', async () => {
  const before = await apiReport(clean())
  const files = clean()
  files['policy.json'].version = '2026-10-1'
  const after = await apiReport(files)

  assert.deepEqual(after.plan.rows, before.plan.rows, 'the rows really are identical')
  assert.notEqual(digestOf(after), digestOf(before))
  assert.equal(after.plan.version, '2026-10-1')
})

test('the document --out writes carries the plan, the date and the digest', async () => {
  const report = await apiReport(clean())
  const written = JSON.parse(serializePlan(report))

  assert.equal(written.tool, 'memory-retention-auditor')
  assert.equal(written.schemaVersion, '1')
  assert.equal(written.version, report.plan.version)
  assert.equal(written.evaluatedOn, TODAY)
  assert.equal(written.digest, report.plan.digest)
  assert.deepEqual(written.deletions, report.plan.deletions)
  assert.deepEqual(written.rows, report.plan.rows)
})

/**
 * The plan document is read on its own, so it has to say so on its own.
 *
 * `--out` wrote a signed, digested list of records to destroy from a run that
 * had exited 2 with a record it could not decide about, and nothing in the
 * artefact said the audit had not completed: the only warning was a stderr line
 * that `--json` suppresses and that a consumer reading the file never sees. The
 * README calls this document the thing a reviewer approves before anybody
 * destroys anything, which is precisely why it cannot be silent about that.
 *
 * The deletion itself stays in the list on purpose. `session-1900` is in a
 * declared class, its age was measured and no hold covers it; what the run
 * could not decide was something about a different record. Emptying the plan
 * here would answer one record's unknown by discarding another record's answer.
 */
test('the written plan carries the run status, so an incomplete run cannot be read as a clean one', async () => {
  const passing = await apiReport(clean())
  assert.equal(passing.status, 'pass')
  assert.equal(passing.plan.status, 'pass')
  assert.equal(JSON.parse(serializePlan(passing)).status, 'pass')

  const partial = await apiReport(fixture(
    [
      record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' }),
      record('voice-mystery', 'voice-note'),
    ],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))
  const written = JSON.parse(serializePlan(partial))

  assert.equal(partial.status, 'incomplete')
  assert.deepEqual(partial.plan.deletions, ['session-1900'], 'the decided record is still planned')
  assert.equal(written.status, 'incomplete', 'the artefact must say what the exit code said')
  assert.deepEqual(written.deletions, ['session-1900'])
  assert.equal(written.rows.find((row) => row.id === 'voice-mystery').disposition, 'undecided')
})

test('the status is inside the digest, so approving the bytes approves the completeness claim', async () => {
  const rows = []
  const deletions = []

  const complete = createPlan('pass', '2026-09-1', TODAY, rows, deletions)
  const incomplete = createPlan('incomplete', '2026-09-1', TODAY, rows, deletions)

  assert.notEqual(complete.digest, incomplete.digest)
  assert.equal(complete.status, 'pass')
  assert.equal(incomplete.status, 'incomplete')
})

test('an unversioned policy still produces a dated plan, and says the version is missing', async () => {
  const files = clean()
  delete files['policy.json'].version
  const report = await apiReport(files)

  assert.equal(report.plan.version, null)
  assert.equal(report.plan.evaluatedOn, TODAY)
  assert.match(report.plan.digest, /^[0-9a-f]{64}$/)
  assert.equal(report.status, 'incomplete')
})

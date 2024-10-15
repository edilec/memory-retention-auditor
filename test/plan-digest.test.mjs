import assert from 'node:assert/strict'
import test from 'node:test'

import { serializePlan } from '../src/index.mjs'
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

test('an unversioned policy still produces a dated plan, and says the version is missing', async () => {
  const files = clean()
  delete files['policy.json'].version
  const report = await apiReport(files)

  assert.equal(report.plan.version, null)
  assert.equal(report.plan.evaluatedOn, TODAY)
  assert.match(report.plan.digest, /^[0-9a-f]{64}$/)
  assert.equal(report.status, 'incomplete')
})

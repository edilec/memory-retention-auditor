import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  cliReport,
  evidence,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  rowFor,
  scriptedClock,
} from './support.mjs'

/**
 * Unknown is never a pass.
 *
 * Every case here withholds one piece of evidence and asserts three things: the
 * row for the affected record is `undecided`, the report status is
 * `incomplete`, and the process exit code is 2. The third is what makes this
 * suite hard to satisfy by accident -- a status string can be edited, a
 * disposition can be edited, and both can be edited together, but the exit code
 * is produced by the real binary from the real report.
 *
 * The stakes are asymmetric here in a way they are not for most tools: the
 * permissive reading of missing evidence is "go ahead and destroy it".
 */

const transcripts = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]

const cases = [
  [
    'a class the policy does not declare',
    fixture([record('session-2031', 'nowhere-declared')], transcripts),
    'class-unknown',
  ],
  [
    'a hold status this build does not implement',
    fixture([record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'suspended', ['session-2031'])]),
    'hold-status-unsupported',
  ],
  [
    'an evidence entry that could not be read',
    fixture(
      [record('session-1998', 'chat-transcript', { state: 'deleted' })],
      transcripts,
      [],
      [{ record: 'session-1998', method: 'shred', verifiedBy: 'ops', recordedOn: '2026-01-01' }],
    ),
    'deletion-evidence-unknown',
  ],
  [
    'two evidence entries for one deletion',
    fixture(
      [record('session-1998', 'chat-transcript', { state: 'deleted' })],
      transcripts,
      [],
      [evidence('session-1998'), evidence('session-1998', 'crypto-erase')],
    ),
    'deletion-evidence-duplicate',
  ],
  [
    'evidence that contradicts the inventory',
    fixture([record('session-2031', 'chat-transcript')], transcripts, [], [evidence('session-2031')]),
    'deletion-evidence-contradicts-state',
  ],
  [
    'a date this build will not guess at',
    fixture([record('session-2031', 'chat-transcript', { lastAccessed: '2026-02-30' })], transcripts),
    'date-invalid',
  ],
]

for (const [label, files, ruleId] of cases) {
  test(`${label} leaves the run incomplete and the exit code 2`, async () => {
    const report = await apiReport(files)

    assert.equal(raisedRules(report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.plan.deletions, [], 'nothing is proposed for deletion on missing evidence')

    const run = await cliReport(files)
    assert.equal(run.code, 2, 'the real binary exits 2')
    assert.equal(run.report.status, 'incomplete')
  })
}

test('a record whose class is unknown is undecided rather than retained', async () => {
  const report = await apiReport(fixture([record('session-2031', 'nowhere-declared')], transcripts))
  const row = rowFor(report, 'session-2031')

  assert.equal(row.disposition, 'undecided')
  assert.equal(row.retainDays, null, 'no retention period was invented')
  assert.equal(row.expired, null, 'and no expiry was inferred from one')
  assert.equal(report.summary.undecided, 1)
  assert.equal(report.summary.retained, 0)
})

test('a record entry the compiler refused makes the run incomplete even when every row that survived is clean', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript'), record('session-9999', 'chat-transcript', { state: 'archived' })],
    transcripts,
  ))

  assert.deepEqual(raisedRules(report), ['state-unsupported'])
  assert.equal(report.plan.rows.length, 1)
  assert.equal(rowFor(report, 'session-2031').disposition, 'retain')
  assert.equal(report.status, 'incomplete', 'one unread record is not a pass for the others')
  assert.equal(report.summary.undecided, 0, 'and it is not counted as a decided row either')
})

test('a document that could not be parsed produces an incomplete report on stdout, not an empty stdout', async () => {
  const run = await cliReport({ ...clean(), 'policy.json': 'not json at all' })

  assert.equal(run.code, 2)
  assert.equal(run.report.status, 'incomplete')
  assert.equal(raisedRules(run.report).includes('input-not-json'), true)
  assert.equal(run.report.findings.some((finding) => finding.location.file === 'policy.json'), true)
})

test('bytes that are not UTF-8 are refused by the decoder, never inferred from decoded text', async () => {
  const report = await apiReport({ ...clean(), 'records.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })

  assert.equal(raisedRules(report).includes('input-not-utf8'), true)
  assert.equal(report.status, 'incomplete')
})

test('four documents that compile with no record left to audit is not a pass', async () => {
  const report = await apiReport(fixture([], transcripts))

  // Without this rule the report would be `pass` with `checked: 0`: green on no
  // evidence at all, about an inventory.
  assert.equal(raisedRules(report).includes('no-records-audited'), true)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
})

test('a policy with no version produces an unversioned plan and an incomplete run', async () => {
  const files = clean()
  delete files['policy.json'].version
  const report = await apiReport(files)

  assert.deepEqual(raisedRules(report), ['policy-version-invalid'])
  assert.equal(report.plan.version, null)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1, 'the rows are still audited; nobody is handed an authoritative-looking plan')
})

test('a spent time budget withdraws every disposition and empties the plan', async () => {
  const files = fixture(
    [
      record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' }),
      record('session-1901', 'chat-transcript', { lastAccessed: '2026-01-02' }),
    ],
    transcripts,
  )

  // The first reading starts the clock and the rest stay inside the budget, so
  // the budget is only passed at the re-check *after* the loop has returned --
  // the exact shape that let a sibling tool fall through to its success branch
  // with a conclusion it had never finished checking.
  const clock = scriptedClock((call) => (call <= 3 ? 0 : 999999))
  const report = await apiReport(files, { clock, limits: { maxRuntimeMs: 1000 } })

  assert.equal(raisedRules(report).includes('time-budget-exceeded'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.undecided, 2)
  assert.equal(report.summary.deletePlanned, 0)
  assert.deepEqual(report.plan.deletions, [], 'a half-finished list of things to destroy is worse than none')
  for (const row of report.plan.rows) {
    assert.equal(row.disposition, 'undecided')
    assert.equal(row.reasons.includes('time-budget-exceeded'), true)
  }
})

test('a clean run is a pass, so the cases above are not passing on a tool that refuses everything', async () => {
  const run = await cliReport(clean())

  assert.equal(run.code, 0)
  assert.equal(run.report.status, 'pass')
  assert.equal(run.report.summary.undecided, 0)
})

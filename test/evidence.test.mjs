import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  cliReport,
  evidence,
  findingsFor,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  rowFor,
} from './support.mjs'

/**
 * The second acceptance criterion: missing deletion evidence cannot pass.
 *
 * "Cannot pass" is pinned by the process exit code of the real binary, in both
 * of the shapes this can take, because they are different facts and a tool that
 * reports the first when the second happened sends a reviewer looking for a
 * file that is sitting right there:
 *
 * - **Evidence that was not supplied.** The document was read in full and
 *   accounts for no such deletion. That is a failed audit: exit 1.
 * - **Evidence that was supplied and could not be read.** Whether it accounts
 *   for the deletion is unknown. That is an incomplete audit: exit 2, and the
 *   message says unreadable rather than absent.
 */

const deleted = (extra = {}) => record('session-1998', 'chat-transcript', { state: 'deleted', ...extra })
const transcripts = (requiresEvidence = true) =>
  [policyClass('chat-transcript', 'lastAccessed', 30, requiresEvidence, ['support-agent'])]

test('a declared deletion with no evidence fails the run, and the binary exits 1', async () => {
  const files = fixture([deleted()], transcripts(), [], [])
  const report = await apiReport(files)

  assert.deepEqual(raisedRules(report), ['deletion-evidence-missing'])
  assert.equal(rowFor(report, 'session-1998').disposition, 'unevidenced')
  assert.equal(rowFor(report, 'session-1998').evidence, null)
  assert.equal(report.summary.unevidenced, 1)
  assert.equal(report.summary.verified, 0)
  assert.equal(report.status, 'fail')

  const run = await cliReport(files)
  assert.equal(run.code, 1, 'the real binary refuses to exit 0')
})

test('a declared deletion with evidence is verified, and the run passes', async () => {
  // The other direction: a tool that failed every deletion would pass the case
  // above and be useless.
  const report = await apiReport(fixture([deleted()], transcripts(), [], [evidence('session-1998')]))

  assert.deepEqual(report.findings, [])
  assert.equal(rowFor(report, 'session-1998').disposition, 'verified')
  assert.deepEqual(rowFor(report, 'session-1998').evidence, {
    method: 'purge', verifiedBy: 'ops-platform', recordedOn: '2026-09-02',
  })
  assert.equal(report.status, 'pass')
})

test('an evidence document that could not be read is unknown, not missing, and exits 2', async () => {
  const files = { ...fixture([deleted()], transcripts(), [], []), 'evidence.json': 'not json at all' }
  const run = await cliReport(files)

  assert.equal(run.code, 2)
  assert.equal(run.report.status, 'incomplete')
  assert.equal(rowFor(run.report, 'session-1998').disposition, 'undecided')
  assert.equal(raisedRules(run.report).includes('deletion-evidence-unknown'), true)

  // The distinction, asserted in both directions so that neither message can
  // stand in for the other.
  assert.equal(raisedRules(run.report).includes('deletion-evidence-missing'), false)
  const finding = findingsFor(run.report, 'deletion-evidence-unknown')[0]
  assert.match(finding.message, /could not be read in full/)
  assert.match(finding.message, /not the same as no evidence having been supplied/)
})

test('an evidence document that is not UTF-8, or too large, is unknown in the same way', async () => {
  const cases = [
    ['not UTF-8', { ...fixture([deleted()], transcripts(), [], []), 'evidence.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }, []],
    ['too large', fixture([deleted()], transcripts(), [], [evidence('session-1998')]), ['--max-file-bytes', '2']],
  ]

  for (const [label, files, args] of cases) {
    const run = await cliReport(files, args)
    assert.equal(run.code, 2, label)
    assert.equal(raisedRules(run.report).includes('deletion-evidence-missing'), false, `${label} reported absence`)
  }
})

test('a refused evidence entry makes the whole evidence document unknown', async () => {
  // One unreadable entry means the file no longer accounts for what it claimed
  // to, so no deletion in the run is verified against it.
  const report = await apiReport(fixture(
    [deleted()],
    transcripts(),
    [],
    [{ record: 'session-1998', method: 'shred', verifiedBy: 'ops-platform', recordedOn: '2026-09-02' }],
  ))

  assert.equal(raisedRules(report).includes('method-unsupported'), true)
  assert.equal(raisedRules(report).includes('deletion-evidence-unknown'), true)
  assert.equal(rowFor(report, 'session-1998').disposition, 'undecided')
  assert.equal(report.status, 'incomplete')
})

test('two evidence entries for one deletion are ambiguous, not cumulative', async () => {
  const report = await apiReport(fixture(
    [deleted()],
    transcripts(),
    [],
    [evidence('session-1998', 'purge'), evidence('session-1998', 'crypto-erase', 'someone-else')],
  ))

  assert.equal(raisedRules(report).includes('deletion-evidence-duplicate'), true)
  assert.equal(rowFor(report, 'session-1998').disposition, 'undecided')
  assert.equal(report.status, 'incomplete')
})

test('a class that does not require evidence still verifies a declared deletion', async () => {
  const report = await apiReport(fixture([deleted()], transcripts(false), [], []))

  assert.deepEqual(report.findings, [])
  assert.equal(rowFor(report, 'session-1998').disposition, 'verified')
  assert.equal(report.status, 'pass')
})

test('whether a class requires evidence is never defaulted', async () => {
  const files = fixture([deleted()], transcripts(), [], [])
  delete files['policy.json'].classes[0].requiresEvidence
  const report = await apiReport(files)

  assert.equal(raisedRules(report).includes('class-invalid'), true)
  assert.match(findingsFor(report, 'class-invalid')[0].message, /not defaulted/)
  assert.equal(report.status, 'incomplete')
})

test('evidence naming a record the inventory does not list is reported', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    transcripts(),
    [],
    [evidence('session-0001')],
  ))

  assert.deepEqual(raisedRules(report), ['deletion-evidence-unknown-record'])
  assert.equal(report.status, 'fail')
})

test('evidence for a record the inventory calls retained is a contradiction, and leaves it undecided', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    transcripts(),
    [],
    [evidence('session-2031')],
  ))

  assert.deepEqual(raisedRules(report), ['deletion-evidence-contradicts-state'])
  // Neither document can be believed over the other, so the record is not
  // planned for deletion and not called retained either.
  assert.equal(rowFor(report, 'session-2031').disposition, 'undecided')
  assert.equal(report.status, 'incomplete')
})

test('a deletion carried out under an active hold is reported, evidence or not', async () => {
  const report = await apiReport(fixture(
    [deleted()],
    transcripts(),
    [hold('matter-4411', 'active', ['session-1998'])],
    [evidence('session-1998')],
  ))

  assert.deepEqual(raisedRules(report), ['deletion-under-hold'])
  assert.match(findingsFor(report, 'deletion-under-hold')[0].message, /should not have happened/)
  // The evidence is still recorded: what happened is known, and what is wrong
  // is that it happened at all.
  assert.equal(rowFor(report, 'session-1998').disposition, 'verified')
  assert.equal(report.status, 'fail')
})

test('a hold document that could not be read stops every deletion in the run', async () => {
  const files = {
    ...fixture(
      [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
      transcripts(),
      [],
      [],
    ),
    'holds.json': 'not json at all',
  }
  const run = await cliReport(files)

  assert.equal(raisedRules(run.report).includes('hold-coverage-unknown'), true)
  assert.match(findingsFor(run.report, 'hold-coverage-unknown')[0].message, /exactly the hold that would have stopped one/)
  assert.equal(rowFor(run.report, 'session-1900').disposition, 'undecided')
  assert.equal(rowFor(run.report, 'session-1900').held, null, 'not false: nobody knows')
  assert.deepEqual(run.report.plan.deletions, [])
  assert.equal(run.code, 2)
})

test('a refused hold entry has the same effect as an unreadable hold document', async () => {
  const report = await apiReport(fixture(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    transcripts(),
    [hold('matter-4411', 'suspended', ['session-1900'])],
    [],
  ))

  assert.equal(raisedRules(report).includes('hold-status-unsupported'), true)
  assert.equal(raisedRules(report).includes('hold-coverage-unknown'), true)
  assert.deepEqual(report.plan.deletions, [])
  assert.equal(report.status, 'incomplete')
})

/**
 * A hold that named something unreadable is not a hold that named nothing.
 *
 * `hold-covers-nothing` used to answer both: a hold whose only record
 * reference was refused reported "names no record and no class, so it protects
 * nothing in this inventory", word for word what a hold with an empty list
 * reports. That is the absent-versus-unreadable mistake this package splits so
 * carefully for deletion evidence, made about the one document that stops a
 * deletion.
 */
test('a hold whose every reference was refused is not reported as naming nothing', async () => {
  const refused = await apiReport(fixture(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    transcripts(),
    [hold('matter-4411', 'active', [42])],
    [],
  ))

  assert.equal(raisedRules(refused).includes('hold-coverage-unreadable'), true)
  assert.equal(raisedRules(refused).includes('hold-covers-nothing'), false, 'an absence was asserted about a reference that is there')
  assert.match(findingsFor(refused, 'hold-coverage-unreadable')[0].message, /not the same as naming nothing/)
  assert.equal(refused.status, 'incomplete')

  const empty = await apiReport(fixture(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    transcripts(),
    [hold('matter-4411', 'active', [], [])],
    [],
  ))

  assert.equal(raisedRules(empty).includes('hold-covers-nothing'), true)
  assert.equal(raisedRules(empty).includes('hold-coverage-unreadable'), false, 'a hold that really does name nothing')
  // The two messages must not be the same sentence, which is how the defect
  // hid: both cases were true statements about an empty list.
  assert.notEqual(
    findingsFor(refused, 'hold-coverage-unreadable')[0].message,
    findingsFor(empty, 'hold-covers-nothing')[0].message,
  )
})

test('a class reference refused on a hold is told apart from a hold that names no class', async () => {
  const report = await apiReport(fixture(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    transcripts(),
    [hold('matter-4411', 'active', [], [42])],
    [],
  ))

  assert.equal(raisedRules(report).includes('hold-coverage-unreadable'), true)
  assert.equal(raisedRules(report).includes('hold-covers-nothing'), false)
  assert.match(findingsFor(report, 'hold-coverage-unreadable')[0].message, /1 record or class reference/)
})

test('a hold with one readable reference beside a refused one is neither of those things', async () => {
  const report = await apiReport(fixture(
    [record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' })],
    transcripts(),
    [hold('matter-4411', 'active', ['session-1900', 42])],
    [],
  ))

  assert.equal(raisedRules(report).includes('hold-coverage-unreadable'), false)
  assert.equal(raisedRules(report).includes('hold-covers-nothing'), false)
  assert.equal(raisedRules(report).includes('record-reference-invalid'), true)
})

/**
 * The same absent-versus-unreadable split, one loop further on.
 *
 * `hold-record-unknown`, `hold-class-unknown` and
 * `deletion-evidence-unknown-record` all say "that document does not list it".
 * That is an absence, and a document read only in part cannot establish one:
 * the entry that was refused may be the very one the reference names. Told the
 * absence, a reviewer withdraws a hold that is doing its job.
 *
 * The split has to keep the genuine finding as well as add the honest one, so
 * each case below drives a refused entry AND a really-stale reference through
 * the same run, and asserts that the two references are answered differently.
 */
test('a hold covering a record whose entry was refused is not told the inventory lacks it', async () => {
  const report = await apiReport(fixture(
    [
      record('session-2031', 'chat-transcript'),
      record('session-0001', 'chat-transcript', { state: 42 }),
    ],
    transcripts(),
    [hold('matter-4411', 'released', ['session-0001', 'session-ghost'])],
    [],
  ))

  const unreadable = findingsFor(report, 'hold-record-unreadable')
  const unknown = findingsFor(report, 'hold-record-unknown')
  assert.equal(unreadable.length, 1)
  assert.match(unreadable[0].message, /session-0001/)
  assert.match(unreadable[0].message, /not the same as the inventory not listing it/)
  // The genuinely stale reference in the same hold still gets the old answer.
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].message, /session-ghost/)
  assert.equal(report.status, 'incomplete')
})

test('evidence claiming a record whose entry was refused is not told the inventory lacks it', async () => {
  const report = await apiReport(fixture(
    [
      record('session-2031', 'chat-transcript'),
      record('session-0001', 'chat-transcript', { state: 42 }),
    ],
    transcripts(),
    [],
    [evidence('session-0001'), evidence('session-ghost')],
  ))

  assert.equal(findingsFor(report, 'deletion-evidence-unreadable-record').length, 1)
  assert.match(findingsFor(report, 'deletion-evidence-unreadable-record')[0].message, /session-0001/)
  assert.equal(findingsFor(report, 'deletion-evidence-unknown-record').length, 1)
  assert.match(findingsFor(report, 'deletion-evidence-unknown-record')[0].message, /session-ghost/)
})

test('a hold covering a class whose entry was refused is not told the policy lacks it', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    [...transcripts(), policyClass('voice-note', 'created', 'ninety', false, ['support-agent'])],
    [hold('matter-4411', 'released', [], ['voice-note', 'class-ghost'])],
    [],
  ))

  assert.equal(findingsFor(report, 'hold-class-unreadable').length, 1)
  assert.match(findingsFor(report, 'hold-class-unreadable')[0].message, /voice-note/)
  assert.equal(findingsFor(report, 'hold-class-unknown').length, 1)
  assert.match(findingsFor(report, 'hold-class-unknown')[0].message, /class-ghost/)
})

test('a refused entry with no readable id withdraws every absence claim in that document', async () => {
  // The refused entry could have been any record, so no id can be reported as
  // absent from the inventory while one is outstanding.
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript'), record(42, 'chat-transcript')],
    transcripts(),
    [hold('matter-4411', 'released', ['session-ghost'])],
    [],
  ))

  assert.equal(findingsFor(report, 'hold-record-unreadable').length, 1)
  assert.equal(findingsFor(report, 'hold-record-unknown').length, 0)
})

test('a whole inventory that compiled still reports a stale hold as stale', async () => {
  // The other half: a split that answered "unknown" for everything would pass
  // every case above while making the stale-hold check useless.
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    transcripts(),
    [hold('matter-4411', 'released', ['session-ghost'])],
    [],
  ))

  assert.deepEqual(raisedRules(report), ['hold-record-unknown'])
  assert.equal(findingsFor(report, 'hold-record-unreadable').length, 0)
  assert.equal(report.status, 'fail')
})

test('the clean fixture passes, so every case above broke exactly one thing', async () => {
  const run = await cliReport(clean())

  assert.deepEqual(run.report.findings, [])
  assert.equal(run.code, 0)
})

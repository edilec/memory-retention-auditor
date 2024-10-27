import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, auditMemoryRetention } from '../src/index.mjs'
import {
  TODAY,
  apiReport,
  clean,
  cliReport,
  cliRun,
  evidence,
  findingsFor,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  withRoot,
} from './support.mjs'

/**
 * Every documented limit is enforced, named when it is reached, and never a
 * silent truncation.
 *
 * A limit that is accepted and ignored is the defect this section of the
 * contract exists for: one tool in this catalog accepted a configuration key
 * and never wired it through, so the documented bound was decorative. Each case
 * below lowers one limit to the point where it must bite, and asserts that the
 * finding names the limit, that the run is `incomplete`, and that the exit code
 * is 2 -- because the plan that came out of a partial walk would be a list of
 * things to destroy chosen by where the walk stopped.
 */

const transcripts = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent', 'reviewer'])]

const cases = [
  ['maxRecords', ['--max-records', '1'], 'too-many-records', fixture(
    [record('a-record', 'chat-transcript'), record('b-record', 'chat-transcript')], transcripts,
  )],
  ['maxClasses', ['--max-classes', '1'], 'too-many-classes', fixture(
    [record('a-record', 'chat-transcript')],
    [...transcripts, policyClass('other-class', 'created', 30, false, [])],
  )],
  ['maxHolds', ['--max-holds', '1'], 'too-many-holds', fixture(
    [record('a-record', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released'), hold('matter-2', 'released')],
  )],
  ['maxEvidenceEntries', ['--max-evidence-entries', '1'], 'too-many-evidence-entries', fixture(
    [record('a-record', 'chat-transcript', { state: 'deleted' })], transcripts, [],
    [evidence('a-record'), evidence('b-record')],
  )],
  ['maxRecordReferences', ['--max-record-references', '1'], 'too-many-record-references', fixture(
    [record('a-record', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', ['a-record', 'b-record'])],
  )],
  ['maxClassReferences', ['--max-class-references', '1'], 'too-many-class-references', fixture(
    [record('a-record', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', [], ['chat-transcript', 'other-class'])],
  )],
  ['maxReaders', ['--max-readers', '1'], 'too-many-readers', fixture(
    [record('a-record', 'chat-transcript', { readers: ['support-agent', 'reviewer'] })], transcripts,
  )],
  ['maxFileBytes', ['--max-file-bytes', '2'], 'input-too-large', clean()],
]

for (const [limitKey, flags, ruleId, files] of cases) {
  test(`${limitKey} is enforced, named in the finding, and makes the run incomplete`, async () => {
    const run = await cliReport(files, flags)

    assert.equal(raisedRules(run.report).includes(ruleId), true)
    assert.match(findingsFor(run.report, ruleId)[0].message, new RegExp(limitKey))
    assert.equal(run.report.status, 'incomplete')
    assert.equal(run.code, 2)
    assert.deepEqual(run.report.plan.deletions, [])
  })

  test(`${limitKey} at its default does not bite on the same input`, async () => {
    // The other half: a limit that fired at any size would pass the case above
    // while refusing every real inventory.
    const run = await cliReport(files)
    assert.equal(raisedRules(run.report).includes(ruleId), false)
  })
}

/**
 * `maxFileBytes` at its exact boundary.
 *
 * Every other limit here is a count, and a count is bitten by a case that
 * declares one more item than the bound allows: shifting any of those
 * comparisons by one fails a named test. `maxFileBytes` was the exception --
 * `info.size > limits.maxFileBytes` could be moved to `+ 1` and the whole suite
 * stayed green, because "2 bytes" is so far below any document that the
 * boundary itself was never approached.
 *
 * So this case measures the real byte length of the file it writes and drives
 * the bound at exactly that number and at one below it. The rule is
 * `size > limit`: a document of exactly `maxFileBytes` bytes is read, and one
 * byte more is refused unread.
 */
test('maxFileBytes bites at exactly one byte over the bound, and not at the bound', async () => {
  const files = clean()
  // The bound applies per document, so the number that decides whether any of
  // them is refused is the size of the largest one, written exactly as
  // `withRoot` writes it.
  const size = Math.max(...Object.values(files)
    .map((document) => Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8')))

  const atBound = await cliReport(files, ['--max-file-bytes', String(size)])
  assert.equal(
    raisedRules(atBound.report).includes('input-too-large'), false,
    `a ${size}-byte document is not over a ${size}-byte limit`,
  )
  assert.equal(atBound.code, 0, 'and the run that read every document is a pass')

  const oneBelow = await cliReport(files, ['--max-file-bytes', String(size - 1)])
  assert.equal(
    raisedRules(oneBelow.report).includes('input-too-large'), true,
    `a ${size}-byte document is over a ${size - 1}-byte limit`,
  )
  assert.match(findingsFor(oneBelow.report, 'input-too-large')[0].message, new RegExp(`is ${size} bytes`))
  assert.equal(oneBelow.report.status, 'incomplete')
  assert.equal(oneBelow.code, 2)
  assert.deepEqual(oneBelow.report.plan.deletions, [], 'a document nobody read is not a licence to destroy anything')
})

test('maxFindings truncates deliberately, says so, and is never a quiet cut', async () => {
  const report = await apiReport(fixture(
    [
      record('a-record', 'chat-transcript', { readers: ['bot-one'] }),
      record('b-record', 'chat-transcript', { readers: ['bot-two'] }),
      record('c-record', 'chat-transcript', { readers: ['bot-three'] }),
    ],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ), { limits: { maxFindings: 2 } })

  assert.equal(report.findings.length, 2)
  assert.equal(raisedRules(report).includes('too-many-findings'), true)
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /maxFindings limit of 2/)
  assert.equal(report.status, 'incomplete', 'a partial report is not a pass and not a plain fail')
})

test('an unknown limit key is refused rather than ignored', async () => {
  await assert.rejects(
    () => auditMemoryRetention({ root: '.', today: TODAY, limits: { maxRecord: 4 } }),
    /Unknown limit "maxRecord"/,
  )
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY, '--max-record', '1'])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /Unknown option/)
  })
})

test('a limit outside its range is refused, at both ends', async () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    await assert.rejects(() => auditMemoryRetention({ root: '.', today: TODAY, limits: { [key]: 0 } }), new RegExp(key))
    await assert.rejects(
      () => auditMemoryRetention({ root: '.', today: TODAY, limits: { [key]: HARD_LIMITS[key] + 1 } }),
      new RegExp(key),
    )
    await assert.rejects(() => auditMemoryRetention({ root: '.', today: TODAY, limits: { [key]: 1.5 } }), new RegExp(key))
  }
})

test('every documented default has a hard cap, and no default exceeds it', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), Object.keys(HARD_LIMITS).sort())
  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.equal(Number.isInteger(value) && value >= 1, true, key)
    assert.equal(value <= HARD_LIMITS[key], true, `${key} default is within its cap`)
  }
})

test('a limit flag that is not a positive integer is a configuration error', async () => {
  for (const value of ['0', 'abc', '-1', '1.5', '1e3']) {
    const run = await cliRun(['--root', '.', '--today', TODAY, '--max-records', value])
    assert.equal(run.code, 2, value)
    assert.equal(run.stdout, '')
  }
})

test('a repeated value flag is a configuration error rather than a silent last-wins', async () => {
  await withRoot(clean(), async (root) => {
    const limit = await cliRun(['--root', root, '--today', TODAY, '--max-records', '5', '--max-records', '500'])
    assert.equal(limit.code, 2)
    assert.equal(limit.stdout, '')
    assert.match(limit.stderr, /given more than once/)

    // The one that matters most here: two dates would audit against whichever
    // the parser happened to keep.
    const dates = await cliRun(['--root', root, '--today', TODAY, '--today', '2030-01-01'])
    assert.equal(dates.code, 2)
    assert.match(dates.stderr, /given more than once/)
  })
})

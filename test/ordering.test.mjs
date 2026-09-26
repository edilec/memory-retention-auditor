import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TODAY,
  apiReport,
  cliRun,
  evidence,
  evidenceDocument,
  fixture,
  hold,
  holdDocument,
  policyClass,
  policyDocument,
  record,
  recordDocument,
  rowFor,
  withRoot,
} from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running.
 *
 * It matters here for a concrete reason: the deletion plan is a list of records
 * somebody is about to destroy, and two correct machines disagreeing about its
 * order is two reviewers approving two different documents.
 *
 * Every case below chooses values an English collator orders the other way
 * round, pushes them through the real report path, and asserts the exact
 * emitted sequence.
 */

const collator = new Intl.Collator('en')
const disagrees = (left, right) => {
  assert.equal(left < right, true, `${left} precedes ${right} by code unit`)
  assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is what makes this a case`)
}

const expiredIn = (id, cls = 'chat-transcript') => record(id, cls, { lastAccessed: '2026-01-01' })
const transcripts = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['README-reader', 'Z-reader', 'a-reader'])]

test('the disagreements every case below relies on are real', () => {
  disagrees('Z-session', 'a-session')
  disagrees('Z-reader', 'a-reader')
  disagrees('Z-matter', 'a-matter')
  disagrees('Z.json', 'a.json')
})

test('plan rows are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [expiredIn('a-session'), expiredIn('Z-session'), expiredIn('README-session')],
    transcripts,
  ))

  assert.deepEqual(report.plan.rows.map((row) => row.id), ['README-session', 'Z-session', 'a-session'])
  assert.notDeepEqual(
    report.plan.rows.map((row) => row.id),
    [...report.plan.rows.map((row) => row.id)].sort((left, right) => collator.compare(left, right)),
    'a collator would order these rows differently',
  )
})

test('the deletion plan itself is ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [expiredIn('a-session'), expiredIn('Z-session'), expiredIn('README-session')],
    transcripts,
  ))

  // The list a reviewer signs off. Two machines disagreeing about its order is
  // two reviewers approving two different documents.
  assert.deepEqual(report.plan.deletions, ['README-session', 'Z-session', 'a-session'])
})

test('the readers on a row, and the holds over it, are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { readers: ['a-reader', 'Z-reader', 'README-reader'] })],
    transcripts,
    [
      hold('a-matter', 'active', ['session-2031']),
      hold('Z-matter', 'active', ['session-2031']),
      hold('README-matter', 'active', ['session-2031']),
    ],
  ))

  assert.deepEqual(rowFor(report, 'session-2031').readers, ['README-reader', 'Z-reader', 'a-reader'])
  assert.deepEqual(rowFor(report, 'session-2031').holds, ['README-matter', 'Z-matter', 'a-matter'])
})

test('findings are ordered by the file they were found in, by code unit', async () => {
  // The file names come from the command line, which is the one place a caller
  // can choose values an English collator orders the other way round.
  const files = {
    'Z.json': recordDocument([record('session-2031', 'chat-transcript', { readers: ['marketing-bot'] })]),
    'a.json': holdDocument([hold('matter-1', 'released', ['session-0001'])]),
    'p.json': policyDocument([policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]),
    'e.json': evidenceDocument([]),
  }

  await withRoot(files, async (root) => {
    const run = await cliRun([
      '--root', root, '--today', TODAY, '--json',
      '--records', 'Z.json', '--holds', 'a.json', '--policy', 'p.json', '--evidence', 'e.json',
    ])
    const report = JSON.parse(run.stdout)

    assert.deepEqual(report.findings.map((finding) => finding.location.file), ['Z.json', 'a.json'])
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['access-not-permitted', 'hold-record-unknown'])
  })
})

test('two findings at one pointer are ordered by their message, by code unit', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { readers: ['Z-bot', 'a-bot'] })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  // Both are access-not-permitted at `/records/0/readers`, so only the message
  // separates them -- and the message carries the reader's name.
  assert.equal(report.findings.length, 2)
  assert.match(report.findings[0].message, /"Z-bot"/)
  assert.match(report.findings[1].message, /"a-bot"/)
})

test('two runs over the same inventory and the same day produce byte-identical stdout', async () => {
  const files = fixture(
    [expiredIn('session-1900'), record('session-1998', 'chat-transcript', { state: 'deleted' })],
    transcripts,
    [hold('matter-1', 'active', ['session-1900'])],
    [evidence('session-1998')],
  )

  await withRoot(files, async (root) => {
    const first = await cliRun(['--root', root, '--today', TODAY, '--json'])
    const second = await cliRun(['--root', root, '--today', TODAY, '--json'])

    assert.equal(first.stdout, second.stdout)
    assert.equal(first.stdout.length > 0, true)
  })
})

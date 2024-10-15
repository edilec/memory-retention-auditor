import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASS_KEYS,
  EVIDENCE_KEYS,
  HOLD_KEYS,
  MAX_RETAIN_DAYS,
  RECORD_KEYS,
  describeValue,
  isIdentifier,
  isPrivateContent,
} from '../src/index.mjs'
import {
  apiReport,
  clean,
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
 * Document shape and vocabulary.
 *
 * The dialect is small and declared rather than approximated: a word this build
 * does not implement is refused, and a key it does not know is refused rather
 * than ignored so that a typo cannot disable a check. Both refusals describe
 * the offending value instead of reproducing it -- the input is a memory
 * inventory, and the pointer already says where to look.
 */

const transcripts = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]

test('an unknown key on an entry is refused, and its name is counted rather than named', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { diagnosisNotes: 'ZQXJVBMP7W' })], transcripts,
  ))

  const finding = findingsFor(report, 'record-invalid')[0]
  assert.match(finding.message, /1 unknown key\(s\)/)
  assert.equal(finding.message.includes('diagnosisNotes'), false, 'the key name is not reproduced')
  assert.equal(JSON.stringify(report).includes('ZQXJVBMP7W'), false)
  assert.equal(report.plan.rows.length, 0, 'the entry was refused, not read with the key ignored')
})

test('an unknown key on a document is refused the same way', async () => {
  const files = clean()
  files['records.json'].exportedBy = 'ops'
  const report = await apiReport(files)

  const finding = findingsFor(report, 'document-invalid')[0]
  assert.match(finding.message, /1 unknown key\(s\)/)
  assert.equal(finding.message.includes('exportedBy'), false)
})

test('the documented key lists are exactly what the compilers accept', async () => {
  const report = await apiReport(fixture(
    [record('session-1998', 'chat-transcript', {
      state: 'deleted', note: 'n', preview: 'p', subject: 's',
    })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'], { description: 'a class' })],
    [hold('matter-1', 'released', ['session-1998'], ['chat-transcript'], { description: 'a hold' })],
    [evidence('session-1998', 'purge', 'ops-platform', '2026-09-02', { description: 'an entry' })],
  ))

  assert.deepEqual(report.findings, [])
  assert.deepEqual(RECORD_KEYS, [
    'class', 'created', 'id', 'lastAccessed', 'note', 'preview', 'readers', 'state', 'subject',
  ])
  assert.deepEqual(CLASS_KEYS, ['allowedReaders', 'basis', 'description', 'id', 'requiresEvidence', 'retainDays'])
  assert.deepEqual(HOLD_KEYS, ['classes', 'description', 'id', 'records', 'status'])
  assert.deepEqual(EVIDENCE_KEYS, ['description', 'method', 'record', 'recordedOn', 'verifiedBy'])
})

test('a duplicate id refuses the second copy and says neither is authoritative', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript'), record('session-2031', 'chat-transcript', { state: 'deleted' })],
    transcripts,
  ))

  const finding = findingsFor(report, 'record-duplicate')[0]
  assert.match(finding.message, /declared twice/)
  assert.equal(finding.location.pointer, '/records/1/id')
  assert.equal(report.status, 'incomplete', 'the refused copy is evidence this run did not read')
})

test('a retention period outside its range is refused rather than clamped', async () => {
  for (const value of [-1, MAX_RETAIN_DAYS + 1, 1.5, '30', null]) {
    const report = await apiReport(fixture(
      [record('session-2031', 'chat-transcript')],
      [policyClass('chat-transcript', 'lastAccessed', value, true, ['support-agent'])],
    ))
    assert.equal(raisedRules(report).includes('retention-invalid'), true, String(value))
    assert.equal(report.status, 'incomplete', String(value))
  }
})

test('a zero-day retention period is legitimate, and is not confused with a missing one', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', 0, true, ['support-agent'])],
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(rowFor(report, 'session-2031').retainDays, 0)
  assert.equal(rowFor(report, 'session-2031').expired, true)
  assert.deepEqual(report.plan.deletions, ['session-2031'])
})

test('an omitted reference list is refused rather than read as an empty one', async () => {
  const files = fixture([record('session-2031', 'chat-transcript')], transcripts)
  delete files['records.json'].records[0].readers
  const report = await apiReport(files)

  assert.equal(raisedRules(report).includes('record-invalid'), true)
  assert.match(findingsFor(report, 'record-invalid')[0].message, /not read as "none"/)
  assert.equal(report.status, 'incomplete')
})

test('both dates are required, whichever basis the class uses', async () => {
  // Otherwise changing a class basis would turn a record into one nobody can
  // date, long after the inventory was exported.
  for (const field of ['created', 'lastAccessed']) {
    const files = fixture([record('session-2031', 'chat-transcript')], transcripts)
    delete files['records.json'].records[0][field]
    const report = await apiReport(files)

    assert.equal(raisedRules(report).includes('date-invalid'), true, field)
    assert.equal(report.status, 'incomplete', field)
  }
})

test('describeValue says what a refused value was without reproducing it', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('ZQXJVBMP7W'), 'a string of 10 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')
})

test('an id is a name, and private content is not', () => {
  assert.equal(isIdentifier('session-2031'), true)
  assert.equal(isIdentifier('chat/transcript.v2'), true)
  assert.equal(isIdentifier('-leading-dash'), false)
  assert.equal(isIdentifier('has space'), false)
  assert.equal(isIdentifier(`has${String.fromCharCode(0x202e)}bidi`), false)
  assert.equal(isIdentifier('x'.repeat(121)), false)

  // Private content is deliberately permissive about characters, because it is
  // never printed: refusing a memory preview for containing a tab would refuse
  // real inventories for no gain.
  assert.equal(isPrivateContent(`a${String.fromCharCode(10)}b`), true)
  assert.equal(isPrivateContent('x'.repeat(10000)), true)
  assert.equal(isPrivateContent('x'.repeat(10001)), false)
  assert.equal(isPrivateContent(42), false)
})

test('a document that is an array, or a list that is not one, is refused', async () => {
  const asArray = await apiReport({ ...clean(), 'holds.json': [] })
  assert.equal(raisedRules(asArray).includes('document-invalid'), true)

  const files = clean()
  files['holds.json'].holds = { 'matter-1': {} }
  const asObject = await apiReport(files)
  assert.match(findingsFor(asObject, 'document-invalid')[0].message, /must be an array/)
})

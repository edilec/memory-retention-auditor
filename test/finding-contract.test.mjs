import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, compareFindings } from '../src/index.mjs'
import {
  apiReport,
  clean,
  evidence,
  fixture,
  hold,
  policyClass,
  record,
} from './support.mjs'

/**
 * Every finding satisfies the report contract, whatever produced it.
 *
 * The sweep runs over a set of deliberately broken documents that between them
 * raise a spread of the catalog, rather than over one hand-picked finding.
 */

const broken = () => fixture(
  [
    record('Z-record', 'chat-transcript', { readers: ['marketing-bot'] }),
    record('a-record', 'nowhere-declared'),
    record('b-record', 'chat-transcript', { state: 'archived' }),
    record('c-record', 'chat-transcript', { unknownKey: 1 }),
    record('d-record', 'chat-transcript', { state: 'deleted' }),
  ],
  [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  [hold('matter-1', 'released', ['nobody-here'], ['nowhere-either'])],
  [evidence('ghost-record')],
)

test('every finding carries the contract shape and nothing outside it', async () => {
  const report = await apiReport(broken())

  assert.equal(report.findings.length > 5, true, 'the fixture really does raise a spread of rules')
  for (const finding of report.findings) {
    const keys = Object.keys(finding)
    for (const key of keys) {
      assert.equal(['ruleId', 'severity', 'message', 'location', 'suggestion'].includes(key), true, key)
    }
    assert.deepEqual(keys.slice(0, 4), ['ruleId', 'severity', 'message', 'location'])
    assert.equal(Object.hasOwn(RULE_SEVERITY, finding.ruleId), true, `${finding.ruleId} is in the table`)
    assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId])
    assert.equal(['error', 'warning', 'info'].includes(finding.severity), true)
    assert.equal(typeof finding.message, 'string')
    assert.equal(finding.message.length > 0, true)

    assert.deepEqual(Object.keys(finding.location), ['file', 'pointer'])
    assert.equal(isAbsolute(finding.location.file), false, 'a location is relative to the declared root')
    assert.equal(finding.location.pointer === '' || finding.location.pointer.startsWith('/'), true)
    if (finding.suggestion !== undefined) assert.equal(finding.suggestion.length > 0, true)
  }
})

test('findings are emitted in the documented order, and the order is not accidental', async () => {
  const report = await apiReport(broken())

  const resorted = [...report.findings].sort(compareFindings)
  assert.deepEqual(report.findings, resorted)

  // The tautology this guards against: a sort test over findings that all share
  // one file and one pointer compares a value with itself and passes however
  // the comparator is written.
  assert.equal(new Set(report.findings.map((finding) => finding.location.pointer)).size > 1, true)
  assert.equal(new Set(report.findings.map((finding) => finding.location.file)).size > 1, true)
})

test('no host path, absolute or otherwise, reaches the report', async () => {
  const report = await apiReport(broken())
  const serialised = JSON.stringify(report)

  assert.equal(serialised.includes('/var/folders'), false)
  assert.equal(serialised.includes('/private/var'), false)
  assert.equal(serialised.includes('/tmp/'), false)
})

test('a clean run carries no findings at all, so the sweep above is not vacuous', async () => {
  const report = await apiReport(clean())
  assert.deepEqual(report.findings, [])
})

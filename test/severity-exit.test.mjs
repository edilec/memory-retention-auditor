import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, auditMemoryRetention, exitCodeFor } from '../src/index.mjs'
import {
  TODAY,
  apiReport,
  clean,
  cliReport,
  cliRun,
  evidence,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  scriptedClock,
  withRoot,
} from './support.mjs'

/**
 * Severity, pinned behaviourally.
 *
 * A test that compares the severity table against a hand-written expected map
 * is three declarations agreeing with each other: a coordinated edit of the
 * table, the docs and the map passes it, and in this catalog exactly that let
 * 40 of 52 error rules be demoted with a green suite. So every rule below is
 * driven through the **real binary** over a real input, and what is asserted is
 * the **process exit code**. Demote any error rule to `warning` and its case
 * fails, because a passing run exits 0.
 *
 * Two directions are covered, and the second is the one that is usually
 * missing: an error rule must not exit 0, and a warning rule must not exit
 * anything else.
 */

const transcripts = [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]
const base = clean()
const deleted = (extra = {}) => record('session-1998', 'chat-transcript', { state: 'deleted', ...extra })

/** `[ruleId, files, extra CLI arguments, expected exit code]`. */
const ERROR_CASES = [
  ['access-not-permitted', fixture(
    [record('session-2031', 'chat-transcript', { readers: ['marketing-bot'] })], transcripts,
  ), [], 1],
  ['basis-unsupported', fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'whenever', 30, true, ['support-agent'])],
  ), [], 2],
  ['class-duplicate', fixture(
    [record('session-2031', 'chat-transcript')],
    [...transcripts, policyClass('chat-transcript', 'created', 9999, false, [])],
  ), [], 2],
  ['class-invalid', fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'], { owner: 'support' })],
  ), [], 2],
  ['class-reference-invalid', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', [], [42])],
  ), [], 2],
  ['class-unknown', fixture([record('session-2031', 'nowhere')], transcripts), [], 2],
  ['date-invalid', fixture(
    [record('session-2031', 'chat-transcript', { created: '2026-02-30' })], transcripts,
  ), [], 2],
  ['deletion-evidence-contradicts-state', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [], [evidence('session-2031')],
  ), [], 2],
  ['deletion-evidence-duplicate', fixture(
    [deleted()], transcripts, [], [evidence('session-1998'), evidence('session-1998', 'crypto-erase')],
  ), [], 2],
  ['deletion-evidence-missing', fixture([deleted()], transcripts, [], []), [], 1],
  ['deletion-evidence-unknown', { ...fixture([deleted()], transcripts, [], []), 'evidence.json': '{' }, [], 2],
  ['deletion-evidence-unknown-record', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [], [evidence('session-0001')],
  ), [], 1],
  ['deletion-under-hold', fixture(
    [deleted()], transcripts, [hold('matter-1', 'active', ['session-1998'])], [evidence('session-1998')],
  ), [], 1],
  ['document-invalid', { ...base, 'records.json': [] }, [], 2],
  ['evidence-invalid', fixture(
    [deleted()], transcripts, [], [evidence('session-1998', 'purge', 'ops-platform', '2026-09-02', { signature: 'x' })],
  ), [], 2],
  ['hold-class-unknown', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', [], ['nowhere'])],
  ), [], 1],
  ['hold-coverage-unknown', { ...base, 'holds.json': '{' }, [], 2],
  ['hold-coverage-unreadable', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'active', [42])],
  ), [], 2],
  ['hold-duplicate', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released'), hold('matter-1', 'active', ['session-2031'])],
  ), [], 2],
  ['hold-invalid', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', [], [], { owner: 'legal' })],
  ), [], 2],
  ['hold-record-unknown', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', ['session-0001'])],
  ), [], 1],
  ['hold-record-unreadable', fixture(
    [record('session-2031', 'chat-transcript'), record('session-0001', 'chat-transcript', { state: 42 })],
    transcripts, [hold('matter-1', 'released', ['session-0001'])],
  ), [], 2],
  ['hold-class-unreadable', fixture(
    [record('session-2031', 'chat-transcript')],
    [...transcripts, policyClass('voice-note', 'created', 'ninety', false, ['support-agent'])],
    [hold('matter-1', 'released', [], ['voice-note'])],
  ), [], 2],
  ['deletion-evidence-unreadable-record', fixture(
    [record('session-2031', 'chat-transcript'), record('session-0001', 'chat-transcript', { state: 42 })],
    transcripts, [], [evidence('session-0001')],
  ), [], 2],
  ['hold-status-unsupported', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'suspended', ['session-2031'])],
  ), [], 2],
  ['identifier-invalid', fixture([record(42, 'chat-transcript')], transcripts), [], 2],
  ['input-not-json', { ...base, 'records.json': '{' }, [], 2],
  ['input-not-utf8', { ...base, 'records.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }, [], 2],
  ['input-too-large', base, ['--max-file-bytes', '2'], 2],
  ['input-unreadable', { 'records.json': base['records.json'], 'policy.json': base['policy.json'] }, [], 2],
  ['method-unsupported', fixture(
    [deleted()], transcripts, [], [evidence('session-1998', 'shred')],
  ), [], 2],
  ['no-records-audited', fixture([], transcripts), [], 2],
  ['policy-version-invalid', fixture([record('session-2031', 'chat-transcript')], transcripts, [], [], 42), [], 2],
  ['reader-invalid', fixture(
    [record('session-2031', 'chat-transcript', { readers: [42] })], transcripts,
  ), [], 2],
  ['record-duplicate', fixture(
    [record('session-2031', 'chat-transcript'), record('session-2031', 'chat-transcript')], transcripts,
  ), [], 2],
  ['record-invalid', fixture(
    [record('session-2031', 'chat-transcript', { owner: 'support' })], transcripts,
  ), [], 2],
  ['record-reference-invalid', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', [42])],
  ), [], 2],
  ['retention-invalid', fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', -1, true, ['support-agent'])],
  ), [], 2],
  ['schema-version-unsupported', { ...base, 'holds.json': { schemaVersion: '2', holds: [] } }, [], 2],
  ['state-unsupported', fixture(
    [record('session-2031', 'chat-transcript', { state: 'archived' })], transcripts,
  ), [], 2],
  ['too-many-class-references', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', [], ['chat-transcript', 'other-class'])],
  ), ['--max-class-references', '1'], 2],
  ['too-many-classes', fixture(
    [record('session-2031', 'chat-transcript')],
    [...transcripts, policyClass('other-class', 'created', 30, false, [])],
  ), ['--max-classes', '1'], 2],
  ['too-many-evidence-entries', fixture(
    [deleted()], transcripts, [], [evidence('session-1998'), evidence('session-0002')],
  ), ['--max-evidence-entries', '1'], 2],
  ['too-many-findings', fixture(
    [
      record('a-record', 'chat-transcript', { readers: ['marketing-bot'] }),
      record('b-record', 'chat-transcript', { readers: ['marketing-bot'] }),
    ],
    transcripts,
  ), ['--max-findings', '1'], 2],
  ['too-many-holds', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released'), hold('matter-2', 'released')],
  ), ['--max-holds', '1'], 2],
  ['too-many-readers', fixture(
    [record('session-2031', 'chat-transcript', { readers: ['support-agent', 'reviewer'] })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent', 'reviewer'])],
  ), ['--max-readers', '1'], 2],
  ['too-many-record-references', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', ['session-2031', 'session-2032'])],
  ), ['--max-record-references', '1'], 2],
  ['too-many-records', fixture(
    [record('a-record', 'chat-transcript'), record('b-record', 'chat-transcript')], transcripts,
  ), ['--max-records', '1'], 2],
]

for (const [ruleId, files, extra, expected] of ERROR_CASES) {
  test(`${ruleId} fires and the binary exits ${expected}`, async () => {
    const run = await cliReport(files, extra)

    assert.equal(raisedRules(run.report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(run.code, expected, `${ruleId} exits ${expected}`)
    assert.notEqual(run.code, 0, `${ruleId} never exits 0`)
  })
}

test('path-escapes-root fires and the binary exits 2', async () => {
  await withRoot(clean(), async (root) => {
    await withRoot({ 'stolen.json': '{}' }, async (outside) => {
      await symlink(join(outside, 'stolen.json'), join(root, 'linked.json'))

      const run = await cliRun(['--root', root, '--today', TODAY, '--json', '--holds', 'linked.json'])
      const report = JSON.parse(run.stdout)

      assert.equal(raisedRules(report).includes('path-escapes-root'), true)
      assert.equal(run.code, 2)
    })
  })
})

/**
 * The time budget cannot be driven from the command line without waiting, so it
 * is pinned through the API and the same `exitCodeFor` the binary calls. Every
 * other error rule above is pinned by the process exit code itself.
 */
test('time-budget-exceeded fires and maps to exit 2', async () => {
  const report = await apiReport(clean(), {
    clock: scriptedClock((call) => (call === 1 ? 0 : 999999)),
    limits: { maxRuntimeMs: 1 },
  })

  assert.equal(raisedRules(report).includes('time-budget-exceeded'), true)
  assert.equal(exitCodeFor(report), 2)
})

test('every error rule in the table is pinned by an exit code above', () => {
  const pinned = new Set([...ERROR_CASES.map(([ruleId]) => ruleId), 'path-escapes-root', 'time-budget-exceeded'])
  const errorRules = Object.keys(RULE_SEVERITY).filter((ruleId) => RULE_SEVERITY[ruleId] === 'error')

  assert.deepEqual(errorRules.filter((ruleId) => !pinned.has(ruleId)), [])
})

const WARNING_CASES = [
  ['class-reference-duplicate', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', [], ['chat-transcript', 'chat-transcript'])],
  )],
  ['hold-covers-nothing', fixture(
    [record('session-2031', 'chat-transcript')], transcripts, [hold('matter-1', 'released', [], [])],
  )],
  ['reader-duplicate', fixture(
    [record('session-2031', 'chat-transcript', { readers: ['support-agent', 'support-agent'] })], transcripts,
  )],
  ['record-reference-duplicate', fixture(
    [record('session-2031', 'chat-transcript')], transcripts,
    [hold('matter-1', 'released', ['session-2031', 'session-2031'])],
  )],
]

for (const [ruleId, files] of WARNING_CASES) {
  test(`${ruleId} fires, the run still passes, and the binary exits 0`, async () => {
    const run = await cliReport(files)

    assert.equal(raisedRules(run.report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(run.report.status, 'pass')
    assert.equal(run.code, 0, `${ruleId} is a warning, so the run passes`)
  })
}

test('every warning rule in the table is pinned by an exit code above', () => {
  const pinned = new Set(WARNING_CASES.map(([ruleId]) => ruleId))
  const warningRules = Object.keys(RULE_SEVERITY).filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')

  assert.deepEqual(warningRules.filter((ruleId) => !pinned.has(ruleId)), [])
})

test('a rule id outside the table throws rather than defaulting to a severity', async () => {
  const { createFinding } = await import('../src/index.mjs')
  assert.throws(() => createFinding({ ruleId: 'not-a-real-rule', file: 'records.json', message: 'x' }), /RULE_SEVERITY/)
})

test('the options the API refuses are refused before any evidence is read', async () => {
  await assert.rejects(() => auditMemoryRetention({ root: '.', today: TODAY, nonsense: 1 }), /Unknown option/)
  await assert.rejects(() => auditMemoryRetention({ root: '.', today: TODAY, limits: { maxRecord: 5 } }), /Unknown limit/)
  await assert.rejects(() => auditMemoryRetention({ root: '.' }), /today must be a calendar date/)
  await assert.rejects(() => auditMemoryRetention({ root: '.', today: 'yesterday' }), /today must be a calendar date/)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_PRIVATE_LENGTH, PRIVATE_RECORD_KEYS } from '../src/index.mjs'
import {
  TODAY,
  apiReport,
  cliRun,
  evidence,
  findingsFor,
  fixture,
  hold,
  policyClass,
  raisedRules,
  record,
  rowFor,
  withRoot,
} from './support.mjs'

/**
 * The third acceptance criterion: private content is redacted.
 *
 * A memory inventory is a list of what an agent remembered about somebody, so
 * the rule here is stronger than "do not echo a value the tool refused": the
 * private fields are never printed at all, whether or not anything is wrong
 * with them. The canary is planted in every field that can carry free text, in
 * all four documents, and swept out of **three** channels -- stdout, stderr and
 * the plan document `--out` writes -- because a tool that redacted two of them
 * would still have published the content.
 *
 * The canary is a synthetic string. No real personal data appears in this
 * suite, in the fixtures, or in the examples.
 */

const CANARY = 'ZQXJVBMP7W-PRIVATE-CONTENT'

const planted = () => fixture(
  [record('session-2031', 'chat-transcript', {
    subject: `subject ${CANARY}`,
    preview: `preview ${CANARY}`,
    note: `note ${CANARY}`,
  })],
  [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'], { description: `class ${CANARY}` })],
  [hold('matter-4411', 'released', ['session-2031'], [], { description: `hold ${CANARY}` })],
  [evidence('session-9999', 'purge', 'ops-platform', '2026-09-02', { description: `evidence ${CANARY}` })],
)

function assertAbsent(text, label) {
  for (let length = CANARY.length; length >= 8; length -= 1) {
    assert.equal(text.includes(CANARY.slice(0, length)), false, `${label} carried ${length} characters of private content`)
  }
}

test('private content reaches neither stream, from any of the four documents', async () => {
  await withRoot(planted(), async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY])

    assert.equal(run.stdout.length > 0, true, 'the run really did report something')
    assertAbsent(run.stdout, 'stdout')
    assertAbsent(run.stderr, 'stderr')
  })
})

test('private content reaches no plan document either', async () => {
  const outRoot = await mkdtemp(join(tmpdir(), 'memory-retention-auditor-out-'))
  try {
    await withRoot(planted(), async (root) => {
      const out = join(outRoot, 'plan.json')
      const run = await cliRun(['--root', root, '--today', TODAY, '--json', '--out', out, '--out-root', outRoot])

      const written = await readFile(out, 'utf8')
      assert.equal(written.length > 0, true)
      assert.equal(run.code, 1, 'this fixture fails on the stray evidence entry, and still writes a plan')
      assertAbsent(written, 'the plan document')
    })
  } finally {
    await rm(outRoot, { recursive: true, force: true })
  }
})

test('the row says which private fields a record declares, and never what they hold', async () => {
  const report = await apiReport(planted())
  const row = rowFor(report, 'session-2031')

  // Field names, not field contents. A reviewer can see that a preview exists
  // without the report handing them the preview.
  assert.deepEqual(row.privateFields, ['note', 'preview', 'subject'])
  assert.deepEqual([...PRIVATE_RECORD_KEYS], ['note', 'preview', 'subject'])
  assert.equal(Object.hasOwn(row, 'subject'), false)
  assert.equal(Object.hasOwn(row, 'preview'), false)
  assert.equal(Object.hasOwn(row, 'note'), false)
  assertAbsent(JSON.stringify(report), 'the report')
})

test('a record that declares no private field says so by declaring none', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  assert.deepEqual(rowFor(report, 'session-2031').privateFields, [])
})

test('a private field of the wrong shape is refused by its length, never by its contents', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { preview: `${CANARY}${'x'.repeat(MAX_PRIVATE_LENGTH)}` })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  assert.equal(raisedRules(report).includes('record-invalid'), true)
  const finding = findingsFor(report, 'record-invalid')[0]
  assert.match(finding.message, /a string of \d+ character\(s\)/)
  assert.match(finding.message, /never printed by this tool/)
  assertAbsent(JSON.stringify(report), 'the refusal')
})

test('a private field that is not a string at all is described, not serialised', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { subject: { name: CANARY } })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  assert.equal(raisedRules(report).includes('record-invalid'), true)
  assert.match(findingsFor(report, 'record-invalid')[0].message, /it is an object/)
  assertAbsent(JSON.stringify(report), 'the refusal')
})

test('an unknown key is counted rather than named, because a key name can be private too', async () => {
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { [`diagnosis-${CANARY}`]: 'x' })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  const finding = findingsFor(report, 'record-invalid')[0]
  assert.match(finding.message, /1 unknown key\(s\)/)
  assert.match(finding.message, /a key name can be private before any value is/)
  assertAbsent(JSON.stringify(report), 'the unknown-key finding')
})

test('a document that is nothing but private content is not quoted back by its parse failure', async () => {
  // V8 answers `JSON.parse('ZQXJ...')` with a message that reproduces the whole
  // document, which is the one path where truncation and stripping cannot help.
  await withRoot({ ...planted(), 'records.json': CANARY }, async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY])

    assert.equal(run.code, 2)
    assertAbsent(run.stdout, 'the parse failure on stdout')
    assertAbsent(run.stderr, 'the parse failure on stderr')
    assert.match(run.stdout, /is not valid JSON/)
  })
})

test('a private field may hold anything at all, including characters a name may not', async () => {
  // Private content is never printed, so there is nothing to sanitise it for,
  // and refusing a memory preview because the conversation contained a tab
  // would refuse real inventories for no gain.
  const report = await apiReport(fixture(
    [record('session-2031', 'chat-transcript', { preview: `line one${String.fromCharCode(10)}line two${String.fromCharCode(0x1b)}[31m` })],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ))

  assert.deepEqual(report.findings, [])
  assert.deepEqual(rowFor(report, 'session-2031').privateFields, ['preview'])
  assert.equal(JSON.stringify(report).includes('[31m'), false)
})

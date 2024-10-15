import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  TODAY,
  clean,
  cliRun,
  fixture,
  policyClass,
  projectDirectory,
  record,
  withRoot,
} from './support.mjs'

/**
 * "This tool deletes nothing", proved rather than asserted.
 *
 * It is the whole reason a team would be willing to point this at a real export
 * of what their agents remember, and the tool's output is a list of things to
 * destroy -- so the claim is checked several ways, because each of them can
 * hold while the property is false:
 *
 * 1. A byte-for-byte snapshot of the input tree around a real run of the real
 *    binary -- names, sizes, contents and modification times -- for a run that
 *    passes, one that fails, one that reports incomplete, and one whose plan
 *    proposes destroying every record in the inventory.
 * 2. A read of the shipped source: the file-system imports are named exactly,
 *    and the only writing verb in the package is the one guarded `writeFile` in
 *    the binary.
 * 3. The absence of every surface that could act elsewhere: no child process,
 *    no `eval`, no credential or environment read.
 */

async function snapshot(root) {
  const rows = []
  for (const name of (await readdir(root)).sort()) {
    const info = await stat(join(root, name))
    const bytes = await readFile(join(root, name))
    rows.push({ name, size: info.size, mtimeMs: info.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex') })
  }
  return rows
}

const failing = () => fixture(
  [record('session-2031', 'chat-transcript', { readers: ['marketing-bot'] })],
  [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
)

const everythingExpired = () => fixture(
  [
    record('session-1900', 'chat-transcript', { lastAccessed: '2026-01-01' }),
    record('session-1901', 'chat-transcript', { lastAccessed: '2026-01-02' }),
  ],
  [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
)

test('a real run over a real root changes nothing in it, whatever the verdict', async () => {
  const cases = [
    ['a clean inventory', clean(), 0],
    ['an inventory the policy refuses', failing(), 1],
    ['a document that could not be parsed', { ...clean(), 'policy.json': 'not json at all' }, 2],
  ]

  for (const [label, files, expected] of cases) {
    await withRoot(files, async (root) => {
      const before = await snapshot(root)
      const run = await cliRun(['--root', root, '--today', TODAY, '--json'])

      assert.equal(run.code, expected, label)
      assert.deepEqual(await snapshot(root), before, `${label}: the input tree is byte-for-byte what it was`)
      assert.equal((await readdir(root)).length, 4, `${label}: all four documents are still there`)
    })
  }
})

test('a run that plans to destroy every record still destroys nothing', async () => {
  await withRoot(everythingExpired(), async (root) => {
    const before = await snapshot(root)
    const run = await cliRun(['--root', root, '--today', TODAY, '--json'])
    const report = JSON.parse(run.stdout)

    assert.equal(run.code, 0)
    assert.deepEqual(report.plan.deletions, ['session-1900', 'session-1901'], 'the run really did plan both deletions')
    assert.deepEqual(await snapshot(root), before, 'and carried out neither')
  })
})

async function shippedSource() {
  const parts = []
  for (const directory of ['bin', 'src']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join(String.fromCharCode(10))
}

test('the shipped source imports exactly the file-system surfaces it needs, and no more', async () => {
  const source = await shippedSource()

  // Naming the bindings that are present is the assertion that means something:
  // a list of verbs that must be absent passes on a prose mention and fails on
  // one, while this line fails the moment another verb is imported at all.
  const imports = (source.match(/import \{[^}]*\} from 'node:fs[^']*'/g) ?? []).sort()
  assert.deepEqual(imports, [
    "import { lstat, realpath, stat } from 'node:fs/promises'",
    "import { readFile, realpath, stat } from 'node:fs/promises'",
    "import { writeFile } from 'node:fs/promises'",
  ])
  assert.equal(/from 'node:fs'/.test(source), false, 'no synchronous file-system surface either')
})

test('the one writing verb in the package is the guarded destination write', async () => {
  const source = await shippedSource()

  const writes = source.match(/\bwriteFile\s*\(/g) ?? []
  assert.equal(writes.length, 1)
  assert.match(source, /await writeFile\(destination,/)

  // Matched as calls rather than as substrings: "truncated" is an honest word
  // in a comment about limits and "truncate" is a way to destroy a file.
  for (const verb of [
    'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'rename', 'copyFile', 'truncate',
    'createWriteStream', 'opendir', 'chmod', 'chown', 'utimes', 'symlink', 'link', 'cp',
  ]) {
    assert.equal(new RegExp(`\\b${verb}\\s*\\(`).test(source), false, `the source calls ${verb}()`)
  }
})

test('nothing in the package could act on the plan, or anywhere else on this machine', async () => {
  const source = await shippedSource()

  assert.equal(source.includes('node:child_process'), false, 'nothing could delete on this package behalf')
  assert.equal(source.includes('node:worker_threads'), false)
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bnew\s+Function\b/.test(source), false)
  assert.equal(/process\.env/.test(source), false, 'no environment is read')
  for (const word of ['Authorization', 'apiKey', 'accessToken', 'credentials']) {
    assert.equal(source.includes(word), false, `the source mentions ${word}`)
  }
})

test('the binary writes to the two streams the report contract allows, and reads no stream', async () => {
  const source = await readFile(join(projectDirectory, 'bin/memory-retention-auditor.mjs'), 'utf8')

  const writes = source.match(/[\w$.]*\.write\s*\(/g) ?? []
  assert.equal(writes.length > 0, true)
  for (const call of writes) {
    assert.equal(['process.stdout.write(', 'process.stderr.write('].includes(call.replace(/\s+/g, '')), true, call)
  }
  assert.equal(source.includes('process.stdin'), false)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { TODAY, cliRun, projectDirectory, raisedRules } from './support.mjs'

/**
 * The shipped examples run, and they demonstrate what the README says they do.
 *
 * `npm run check` runs the clean one on every build. An example that stopped
 * working, or that quietly started reporting something else, would otherwise be
 * documentation that nobody executes.
 */

const exampleRoot = (name) => join(projectDirectory, 'examples', name)
const runExample = (name) => cliRun(['--root', exampleRoot(name), '--today', TODAY, '--json'])

async function snapshot(root) {
  const rows = []
  for (const name of (await readdir(root)).sort()) {
    const info = await stat(join(root, name))
    const bytes = await readFile(join(root, name))
    rows.push({ name, size: info.size, mtimeMs: info.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex') })
  }
  return rows
}

test('examples/clean audits every record and exits 0', async () => {
  const run = await runExample('clean')
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.verified, 1)
  assert.deepEqual(report.plan.deletions, [])
})

test('examples/held tells an expired record apart from an expired record under hold', async () => {
  const run = await runExample('held')
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.expired, 3)
  assert.equal(report.summary.expiredAndHeld, 1)
  // The point of the example: both records are long past their retention
  // period, and only the unheld one is in the plan.
  assert.deepEqual(report.plan.deletions, ['session-1901'])
  assert.equal(report.plan.rows.find((row) => row.id === 'session-1900').disposition, 'hold')
})

test('examples/unevidenced refuses to pass a deletion nothing accounts for, and exits 1', async () => {
  const run = await runExample('unevidenced')
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 1)
  assert.equal(report.status, 'fail')
  assert.deepEqual(raisedRules(report), ['access-not-permitted', 'deletion-evidence-missing'])
  assert.equal(report.summary.unevidenced, 1)
})

test('examples/incomplete cannot pass, and says which record it could not decide', async () => {
  const run = await runExample('incomplete')
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['class-unknown'])
  assert.equal(report.summary.undecided, 1)
  assert.deepEqual(report.plan.deletions, [])
})

test('running an example changes nothing in it', async () => {
  for (const name of ['clean', 'held', 'incomplete', 'unevidenced']) {
    const root = exampleRoot(name)
    const before = await snapshot(root)
    await runExample(name)
    assert.deepEqual(await snapshot(root), before, `examples/${name} is byte-for-byte what it was`)
  }
})

test('no example carries anything that could be mistaken for real personal data', async () => {
  for (const name of ['clean', 'held', 'incomplete', 'unevidenced']) {
    for (const file of await readdir(exampleRoot(name))) {
      const text = await readFile(join(exampleRoot(name), file), 'utf8')
      assert.equal(/@/.test(text), false, `examples/${name}/${file} carries something shaped like an address`)
      assert.equal(/\+?\d{9,}/.test(text), false, `examples/${name}/${file} carries a long number`)
    }
  }
})

test('every example root holds exactly the four documents the README names', async () => {
  for (const name of ['clean', 'held', 'incomplete', 'unevidenced']) {
    assert.deepEqual(
      (await readdir(exampleRoot(name))).sort(),
      ['evidence.json', 'holds.json', 'policy.json', 'records.json'],
    )
  }
})

test('the README quick start commands are the ones that exist', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(readme.includes('--root examples/clean --today 2026-09-14'), true)
  assert.equal(manifest.scripts.example.includes('examples/clean'), true)
  assert.equal(manifest.scripts.example.includes('--today'), true)
  assert.equal(manifest.bin['memory-retention-auditor'], './bin/memory-retention-auditor.mjs')
})

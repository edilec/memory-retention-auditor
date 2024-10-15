import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, byCodeUnit, severityOf } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The severity table against the documented catalog, in both directions.
 *
 * This is worth having and it is **not** the test that defends severity. A
 * table, a catalog and a hand-written expected map are three declarations, and
 * one edit that changes all three leaves every assertion comparing them
 * satisfied: a sibling tool had 40 of its 52 error rules survive exactly that
 * flip. `test/severity-exit.test.mjs` is where severity is actually pinned, by
 * driving a real input through the real binary for every rule and asserting the
 * process exit code.
 *
 * What this file catches is a different mistake: a rule added to the code and
 * not to the documentation, or removed from one and left in the other.
 */

const DOCS = join(projectDirectory, 'docs/retention-rules.md')

async function documentedSeverities() {
  const text = await readFile(DOCS, 'utf8')
  const rows = [...text.matchAll(/^\| `([a-z][a-z0-9-]*)` \| (error|warning|info) \|/gm)]
  return new Map(rows.map((row) => [row[1], row[2]]))
}

test('every rule in the table is documented with the same severity', async () => {
  const documented = await documentedSeverities()

  for (const ruleId of Object.keys(RULE_SEVERITY).sort(byCodeUnit)) {
    assert.equal(documented.has(ruleId), true, `${ruleId} is in the table and not in docs/retention-rules.md`)
    assert.equal(documented.get(ruleId), RULE_SEVERITY[ruleId], `${ruleId} disagrees with its documented severity`)
  }
})

test('every rule documented in the catalog is in the table', async () => {
  const documented = await documentedSeverities()

  for (const ruleId of [...documented.keys()].sort(byCodeUnit)) {
    assert.equal(Object.hasOwn(RULE_SEVERITY, ruleId), true, `${ruleId} is documented and not in RULE_SEVERITY`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
})

test('the catalog is the size and shape the documentation claims', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)
  const severities = Object.values(RULE_SEVERITY)

  assert.equal(ruleIds.length, 50)
  assert.equal(severities.filter((severity) => severity === 'error').length, 46)
  assert.equal(severities.filter((severity) => severity === 'warning').length, 4)

  for (const ruleId of ruleIds) assert.match(ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/)
  assert.deepEqual([...ruleIds].sort(byCodeUnit), ruleIds, 'the table is written in the order it sorts in')
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('severityOf throws on a rule outside the table rather than defaulting one in', () => {
  assert.equal(severityOf('deletion-evidence-missing'), 'error')
  assert.throws(() => severityOf('invented-rule'), /RULE_SEVERITY/)
  assert.throws(() => severityOf(undefined), /RULE_SEVERITY/)
})

test('the documentation states what the tool cannot conclude, and the README says the same', async () => {
  // Whitespace is collapsed before the search: these documents are hard
  // wrapped, so a claim can be split across two lines and an `includes` over
  // the raw text would miss a sentence that is plainly there.
  const flatten = (text) => text.toLowerCase().replace(/\s+/g, ' ')
  const text = flatten(await readFile(DOCS, 'utf8'))
  const readme = flatten(await readFile(join(projectDirectory, 'README.md'), 'utf8'))

  for (const claim of ['deletes nothing', 'no store is inspected', 'never reported as missing']) {
    assert.equal(text.includes(claim), true, `docs/retention-rules.md does not say "${claim}"`)
  }
  assert.equal(text.includes('what this tool cannot tell you'), true)
  assert.equal(readme.includes('limits and non-goals'), true)
  assert.equal(readme.includes('deletes nothing'), true)
  assert.equal(readme.includes('no store is inspected'), true)
})

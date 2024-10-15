import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, hasForbiddenCharacter } from '../src/index.mjs'
import {
  FORBIDDEN,
  TODAY,
  cliRun,
  evidence,
  fixture,
  hold,
  policyClass,
  record,
  withRoot,
} from './support.mjs'

/**
 * Nothing forbidden reaches either stream, through any channel.
 *
 * Stripping C0 and the line separators is not sanitising: four tools in this
 * catalog did exactly that and let the C1 range through, where U+0085 (NEL)
 * forges a line in a human report and U+009B is an 8-bit control introducer
 * that needs no ESC in front of it. U+202E reverses displayed text, so a record
 * id a reviewer reads before approving a deletion can name one record on screen
 * while the plan names another.
 *
 * The channels matter as much as the classes. One tool sanitised its evidence
 * field carefully and let a page id forge whole lines, so every case below
 * plants the character in an **identifier** as well as in free text, and the
 * assertion walks the entire serialised report rather than one field somebody
 * remembered.
 */

const planted = (character) => fixture(
  [
    record(`session${character}2031`, `chat${character}transcript`, { readers: [`support${character}agent`] }),
    record('session-0002', 'chat-transcript', { [`unknown${character}key`]: 'x' }),
  ],
  [policyClass(`chat${character}transcript`, 'lastAccessed', 30, true, [`support${character}agent`])],
  [hold(`matter${character}1`, 'released', [`session${character}2031`])],
  [evidence(`session${character}9999`)],
)

/**
 * Every string anywhere in a parsed report, keys included.
 *
 * Walking the whole structure is the point: an assertion aimed at one field
 * passes while a different field carries the character.
 */
function everyString(value, seen = []) {
  if (typeof value === 'string') seen.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, seen)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      seen.push(key)
      everyString(item, seen)
    }
  }
  return seen
}

for (const [name, character] of Object.entries(FORBIDDEN)) {
  test(`${name} reaches neither stream, through an identifier, a reader, a key or a hold`, async () => {
    await withRoot(planted(character), async (root) => {
      const run = await cliRun(['--root', root, '--today', TODAY])
      const report = JSON.parse(run.stdout)

      /*
       * The report is swept as parsed values rather than as raw stdout, because
       * pretty-printed JSON is full of legitimate newlines and an `includes`
       * over the whole stream cannot tell those from a newline that arrived
       * inside an identifier.
       */
      const strings = everyString(report)
      assert.equal(strings.length > 0, true, 'the run really did produce a report to sweep')
      for (const string of strings) {
        assert.equal(hasForbiddenCharacter(string), false, `a report string carries ${name}`)
      }

      /*
       * The human summary is line-oriented, so the property that matters there
       * is that nothing forged a line: its length is exactly the four fixed
       * lines, one per finding, and the closing line an incomplete run adds.
       */
      const lines = run.stderr.replace(/\n$/, '').split(String.fromCharCode(10))
      const expected = 4 + report.findings.length + (report.status === 'incomplete' ? 1 : 0)
      assert.equal(lines.length, expected, 'a line was forged')
      assert.equal(hasForbiddenCharacter(lines.join('')), false, 'the summary carries a forbidden character')
    })
  })
}

test('a forbidden character in a file name given on the command line is refused as configuration', async () => {
  await withRoot(fixture(
    [record('session-2031', 'chat-transcript')],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  ), async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY, '--json', '--holds', `holds${FORBIDDEN['C0 LF']}.json`])

    assert.equal(run.code, 2)
    assert.equal(run.stdout, '', 'a configuration error puts no report on stdout')
    assert.equal(hasForbiddenCharacter(run.stderr.replace(/\n/g, '')), false)
  })
})

test('an unknown option, and a bad --today, are flattened before they reach stderr', async () => {
  const option = await cliRun(['--root', '.', `--nonsense${FORBIDDEN['C1 NEL']}flag`])
  assert.equal(option.code, 2)
  assert.equal(hasForbiddenCharacter(option.stderr.replace(/\n/g, '')), false)

  const today = await cliRun(['--root', '.', '--today', `2026-09-14${FORBIDDEN['bidi RLO']}`])
  assert.equal(today.code, 2)
  assert.equal(today.stdout, '')
  assert.equal(hasForbiddenCharacter(today.stderr.replace(/\n/g, '')), false)
})

test('excerpt collapses whitespace, strips the forbidden classes and bounds the length', () => {
  assert.equal(excerpt(`a${FORBIDDEN['C0 LF']}b`), 'a b')
  assert.equal(excerpt(`a${FORBIDDEN['bidi RLO']}b`), 'a b')
  assert.equal(excerpt(`a${FORBIDDEN['C1 CSI']}b`), 'a b')
  assert.equal(excerpt('a \t\n  b'), 'a b')
  assert.equal(excerpt('x'.repeat(200), 10), `${'x'.repeat(10)}...`)
  assert.equal(hasForbiddenCharacter(excerpt(Object.values(FORBIDDEN).join('x'))), false)
})

test('hasForbiddenCharacter really does see each class, so the sweeps above can fail', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`before${character}after`), true, name)
  }
  assert.equal(hasForbiddenCharacter('an ordinary identifier'), false)
})

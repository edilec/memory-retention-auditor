import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createFinding, excerpt, hasForbiddenCharacter, locationText, renderable } from '../src/index.mjs'
import {
  FORBIDDEN,
  TODAY,
  cliRun,
  evidence,
  evidenceDocument,
  fixture,
  hold,
  holdDocument,
  policyClass,
  policyDocument,
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

/**
 * A location is a path, and `excerpt` is not the function for one.
 *
 * The report contract says `location.file` is relative to the declared input
 * root, which means a consumer is entitled to resolve it. `excerpt` collapses
 * every run of whitespace, so a file genuinely named `my  records.json` was
 * reported as `my records.json` and resolving that gave ENOENT. The assertion
 * below is the resolution itself, not a string comparison, because the string
 * comparison is the thing that was wrong.
 */
test('location.file names the file on disk, spaces and all, and resolves to it', async () => {
  const files = fixture(
    [record('session-2031', 'no-such-class')],
    [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
  )
  const documents = {
    'my  records.json': files['records.json'],
    'policy.json': files['policy.json'],
    'holds.json': files['holds.json'],
    'evidence.json': files['evidence.json'],
  }

  await withRoot(documents, async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY, '--json', '--records', 'my  records.json'])
    const report = JSON.parse(run.stdout)
    const finding = report.findings.find((entry) => entry.ruleId === 'class-unknown')

    assert.notEqual(finding, undefined, 'the fixture really did raise a finding against that file')
    assert.equal(finding.location.file, 'my  records.json')
    await access(join(root, finding.location.file))
  })
})

test('locationText strips the forbidden classes without collapsing or trimming the rest', () => {
  assert.equal(locationText('a  b'), 'a  b', 'an inner run of spaces survives')
  assert.equal(locationText(' a '), ' a ', 'and so do the ends')
  assert.equal(locationText(`a${FORBIDDEN['C0 LF']}b`), 'ab')
  assert.equal(locationText(`a${FORBIDDEN['C1 NEL']}b`), 'ab')
  assert.equal(locationText(`a${FORBIDDEN['bidi RLO']}b`), 'ab')
  assert.equal(locationText(`a${FORBIDDEN['line separator']}b`), 'ab')
  assert.equal(locationText('x'.repeat(40), 10), `${'x'.repeat(10)}...`)
})

test('a control character reaching a location is stripped by createFinding itself', () => {
  const finding = createFinding({
    ruleId: 'record-invalid',
    file: `a${FORBIDDEN['C0 LF']}b.json`,
    pointer: `/records/0${FORBIDDEN['C1 CSI']}`,
    message: 'anything',
  })

  assert.equal(finding.location.file, 'ab.json')
  assert.equal(finding.location.pointer, '/records/0')
  assert.equal(hasForbiddenCharacter(finding.location.file + finding.location.pointer), false)
})

/**
 * A value that refuses to become a string.
 *
 * `JSON.parse('{"toString": {}}')` produces an object whose `toString` is not
 * callable, so `String(value)` throws. That throw lands at the sanitisation
 * boundary -- downstream of every check that would have refused the value --
 * and five tools in this catalog answered it by exiting 2 with an empty stdout,
 * the shape reserved for a configuration error, losing the findings for every
 * other input in the same run. Here the stakes are a deletion plan.
 */
const POISON = () => JSON.parse('{"toString": {}}')

test('the poison really does throw, so the cases below are not testing nothing', () => {
  assert.throws(() => String(POISON()), /convert object to primitive/)
  const list = JSON.parse('[1]')
  list.toString = {}
  assert.throws(() => String(list), /convert object to primitive/)
})

test('a value that cannot be stringified is described by its shape, never reproduced', () => {
  assert.equal(renderable(POISON()), '[object]')
  assert.equal(excerpt(POISON()), '[object]')
  assert.equal(locationText(POISON()), '[object]')

  const list = JSON.parse('["s3cret-value"]')
  list.toString = {}
  assert.equal(renderable(list), '[array]')
  assert.equal(excerpt(list).includes('s3cret'), false, 'the shape carried a member out')
})

test('ordinary values are untouched by the guard that catches the poison', () => {
  assert.equal(renderable('plain'), 'plain')
  assert.equal(renderable(42), '42')
  assert.equal(renderable(0), '0')
  assert.equal(renderable(null), 'null')
  assert.equal(renderable(undefined), 'undefined')
  assert.equal(renderable(false), 'false')
  assert.equal(renderable({ toString: () => 'a real custom toString' }), 'a real custom toString')
  assert.equal(excerpt({ toString: () => 'custom' }), 'custom')
})

test('one poisoned record does not suppress the findings for every other one', async () => {
  const documents = {
    'records.json': `{
      "schemaVersion": "1",
      "records": [
        { "id": "poisoned", "class": {"toString": {}}, "created": "2026-01-01",
          "lastAccessed": "2026-01-02", "state": "retained", "readers": ["support-agent"],
          "preview": "AKIAIOSFODNN7EXAMPLE" },
        { "id": "session-2031", "class": "chat-transcript", "created": "2026-01-01",
          "lastAccessed": "2026-01-02", "state": "deleted", "readers": ["support-agent"] }
      ]
    }`,
    'policy.json': policyDocument([policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])]),
    'holds.json': holdDocument([]),
    'evidence.json': evidenceDocument([]),
  }

  await withRoot(documents, async (root) => {
    const run = await cliRun(['--root', root, '--today', TODAY])

    assert.equal(run.code, 2, 'an unreadable input is incomplete, not a configuration error')
    assert.notEqual(run.stdout, '', 'stdout must still carry the report for the inputs that were read')
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, 'incomplete')

    const rules = new Set(report.findings.map((finding) => finding.ruleId))
    assert.equal(rules.has('class-reference-invalid'), true, 'the poisoned record was refused')
    assert.equal(rules.has('deletion-evidence-missing'), true, 'and the neighbouring record was still audited')

    const everywhere = `${run.stdout}${run.stderr}`
    assert.equal(everywhere.includes('AKIAIOSFODNN7EXAMPLE'), false, 'a neighbouring private field leaked')
    assert.equal(everywhere.includes('toString'), false, 'the poison itself was reproduced')
  })
})

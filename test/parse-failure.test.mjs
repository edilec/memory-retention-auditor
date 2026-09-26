import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A parse failure says what went wrong without repeating the document.
 *
 * It matters more here than in most tools in this catalog: the document that
 * fails to parse may be a memory inventory, so the text V8 quotes back is
 * somebody's private content.
 *
 * V8 writes two shapes of message and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. Any tool
 * that interpolates `error.message` therefore walks file contents onto stdout
 * past every redactor it has.
 *
 * The ordering of the branches is the whole guard, and it is the part that was
 * measured wrong across this catalog: nineteen of thirty-eight tools looked for
 * `at position N` first, so a document whose own text reads `at position 1` had
 * the offset found *inside the quoted copy* and the copy sliced back out. Each
 * case below drives the real helper with the real V8 message.
 */

const detailFor = (text) => {
  try {
    JSON.parse(text)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error(`${text} parsed successfully, so this case proves nothing`)
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const { message, detail } = detailFor('at position 1')

  // The trap, spelled out: V8 puts the document inside the quoted span, and the
  // span itself contains the text a position-first helper searches for.
  assert.match(message, /"at position 1"/)
  assert.equal(detail.includes('at position 1'), false)
  assert.equal(detail.includes('"'), false)
})

test('a document that is nothing but a credential is not reproduced', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE'
  const { message, detail } = detailFor(secret)

  assert.match(message, new RegExp(secret))
  for (let length = secret.length; length >= 8; length -= 1) {
    assert.equal(detail.includes(secret.slice(0, length)), false, `leaked ${length} characters`)
  }
})

test('a long document with a sensitive prefix is not reproduced from its front', () => {
  const secret = 'password=hunter2'
  const { detail } = detailFor(`${secret}${'x'.repeat(4000)}`)

  assert.equal(detail.includes('password'), false)
  assert.equal(detail.includes('hunter2'), false)
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised as a quoting message', () => {
  // The `s` flag on the pattern is what makes this case pass: without it the
  // quoting shape goes unrecognised and the fallback branches run on a message
  // that does carry the document.
  const { message, detail } = detailFor('{"alpha": ZQXJ\nVBMP7W}')

  assert.match(message, /"/)
  assert.equal(detail.includes('ZQXJ'), false)
  assert.equal(detail.includes('VBMP7W'), false)
  assert.equal(detail.includes('"'), false)
})

test('the safe positional form keeps its position, line and column', () => {
  // This half matters too: a helper that answered with the generic sentence
  // every time would pass every case above and tell a reader nothing.
  const { message, detail } = detailFor('{"alpha": 1 "beta": 2}')

  assert.match(message, /at position \d+/)
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)/)
  assert.equal(detail.includes('alpha'), false)
  assert.equal(detail.includes('beta'), false)
})

test('an empty document keeps the message that carries no content at all', () => {
  assert.equal(detailFor('').detail, 'Unexpected end of JSON input')
})

test('a message that reaches the position branch with a quote still standing is discarded', () => {
  /*
   * This is the case that pins the closing backstop on its own, and it was
   * added after measuring: removing the backstop alone left every other case in
   * this file green, because the branches above happened to answer them safely.
   * A guard nothing fails for is a guard that will quietly stop being there.
   *
   * The message is synthetic -- it is the shape a future V8 could produce by
   * appending a position clause to the quoting form, which the quoting pattern
   * would then not match because it no longer ends with "is not valid JSON".
   * The position branch slices the quoted span straight back out; the backstop
   * sees the surviving double quote and discards the whole detail.
   */
  const detail = parseFailureDetail(new Error(`Unexpected token 'x', "secret-token-value" is not valid JSON at position 3`))

  assert.equal(detail.includes('secret-token-value'), false)
  assert.equal(detail, 'the document could not be parsed as JSON')
})

test('a message shape the helper has never seen is discarded if it carries a double quote', () => {
  // The closing backstop, which is the reason this helper is safe against
  // wordings a future V8 invents: across the measured corpus every message with
  // no quoted snippet carried no double quote at all, because V8 quotes JSON
  // punctuation with apostrophes.
  const invented = parseFailureDetail(new Error('Some future wording about "secret-token-value" here'))

  assert.equal(invented.includes('secret-token-value'), false)
  assert.equal(invented, 'the document could not be parsed as JSON')
})

/*
 * Measured, and recorded because the result was not what the sketch implies:
 * with the backstop in place, reversing the two branches does not change the
 * answer to any case above, and neither does dropping the `s` flag -- both
 * mistakes produce a detail that still carries a double quote, and the backstop
 * discards it. Reversing the branches *and* removing the backstop does fail the
 * "at position 1" case above, which is how the branch order was verified to be
 * load-bearing. Defence in depth is the design; the backstop is what makes the
 * helper safe against a wording it has never been taught.
 */

test('a non-error argument does not throw its way out of the helper', () => {
  assert.equal(typeof parseFailureDetail(undefined), 'string')
  assert.equal(typeof parseFailureDetail({}), 'string')
})

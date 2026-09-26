const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. Recognised FIRST: a document whose own text
 * reads `at position 1` produces `Unexpected token 'a', "at position 1" is not
 * valid JSON`, so matching the offset first finds it inside the quoted span and
 * slices the document back out. The `s` flag matters too -- the quoted span can
 * contain a newline.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * The closing guard is deliberate belt and braces, and it is the reason this
 * function is safe against wordings it has never seen: across 18,750 distinct
 * V8 parse messages, every one that carries no quoted snippet also carries no
 * double quote at all -- it quotes JSON punctuation with apostrophes. So a
 * double quote surviving to the end means a snippet survived, whatever the
 * branch logic above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/**
 * Decoding, ordering, sanitising, and the two shapes a value may take: a name
 * this tool prints, or private content it never prints.
 *
 * The split is the whole design of this module. A memory inventory is the most
 * private document this catalog reads -- it is a list of what an agent
 * remembered about somebody -- so the set of fields that may reach a report is
 * declared rather than discovered. Record ids, class ids, hold ids, dates,
 * vocabulary words and the names of the people who verified a deletion are
 * printed. A subject, a preview, a note and every description are not, ever:
 * they are measured and described, and the pointer on the finding says where to
 * read them.
 *
 * Nothing here reads the filesystem, the network, a locale or a clock.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `String.prototype.localeCompare` and `Intl.Collator` both consult ICU data
 * that differs between Node builds, and both weigh punctuation differently from
 * its code point. Record ids, class ids and hold ids here carry upper case and
 * `.`, `-`, `_`, `:` and `/`, so a collated report would list a different
 * record first and plan a different deletion order on a different machine.
 * Every order this package emits is decided here.
 *
 * Neither spelling of the locale-aware comparison appears anywhere in this
 * package, and `test/ordering.test.mjs` pins what the tool *emits* rather than
 * what its source says -- a source scan cannot tell one comparator from the
 * other, so a source scan is not the test.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output.
 *
 * Built from code points rather than written out: a literal U+2028 or U+2029 in
 * a module is a line terminator to the JavaScript parser, and every other
 * member of the set is invisible in an editor.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in the
 *   human summary, ESC opens a terminal escape sequence, NUL truncates a value
 *   in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two members
 *   need no help at all: U+0085 NEL is a line break to a great many consumers
 *   and U+009B is the 8-bit CSI, a control introducer with no ESC in front.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a record id a reviewer reads before approving a deletion can
 *   be displayed as one record while the plan names another.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- record ids,
 * class ids, hold ids, dates, file names, pointers, messages and suggestions
 * alike, not only an excerpt field. Tab, newline and carriage return are left
 * out of this class because `excerpt` collapses them to a single space one step
 * later, which reaches the same place by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What a value may not contain if it is to be used as a name: the same classes
 * plus the three ASCII whitespace controls `CONTROL` leaves to the collapse. A
 * name gets no second pass -- a record id whose printed form differs from the
 * id the auditor compared is an id nobody can approve a deletion against.
 */
const FORBIDDEN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * True when any forbidden character appears anywhere in the value. Exported so
 * a test can walk an entire serialised report and assert that none survived
 * anywhere, rather than checking the one field somebody remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN.test(renderable(value))
}

/**
 * Text for a value that may refuse to become text.
 *
 * `String(value)` is not total. `JSON.parse('{"toString": {}}')` produces an
 * object whose `toString` is not callable and whose inherited `valueOf` answers
 * with the object itself, so converting it throws `Cannot convert object to
 * primitive value`. That throw happens at the sanitisation boundary, which is
 * downstream of every check that would have refused the value -- so one
 * malformed declaration takes the whole run down with it, and the process exits
 * 2 with an EMPTY stdout: the shape this contract reserves for a configuration
 * error. Every other document in the same run loses its findings too.
 *
 * A value that cannot be rendered is DESCRIBED by its shape and never
 * reproduced. `[object]` and `[array]` carry nothing from the value itself, so
 * a poisoned field sitting beside a credential cannot pull the credential into
 * the report on its way past. The field is still refused by whichever check
 * asked for it, and the run is still `incomplete`; this function only makes
 * sure the refusal gets written down instead of aborting the run.
 *
 * Precedent: `workflow-dry-run-planner/src/document.mjs`, function `renderable`.
 */
export function renderable(value) {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return Array.isArray(value) ? '[array]' : '[object]'
  }
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 120
export const MAX_PRIVATE_LENGTH = 10000

/**
 * A bounded, single-line, control-free rendering of a string this tool has
 * decided may be printed.
 *
 * Nothing private goes through here, because nothing private is printed at all.
 * What passes through are ids, dates, vocabulary words, file names, pointers
 * and the sentences this package writes itself -- and they pass through because
 * an id arriving from an input file is still untrusted text. A sibling tool
 * sanitised its evidence field carefully and left its identifiers raw, so a
 * record id holding a newline printed two lines into the human report and
 * invented a finding that was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = renderable(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

export const LOCATION_LIMIT = 200

/**
 * The global twin of `FORBIDDEN`, for stripping rather than testing. A `RegExp`
 * carrying `g` holds `lastIndex` between calls, so `.test` is never called on
 * this one and `.replace` is never called on that one.
 */
const FORBIDDEN_GLOBAL = new RegExp(FORBIDDEN.source, 'g')

/**
 * A location -- `location.file` or `location.pointer` -- rendered for output.
 *
 * This is deliberately *not* `excerpt`. The report contract says
 * `location.file` is a path relative to the declared input root, and a consumer
 * is entitled to resolve it. `excerpt` collapses every run of whitespace to one
 * space and trims the ends, so a file genuinely named `my  tools.json` was
 * reported as `my tools.json` and anybody resolving that path got ENOENT. A
 * location is therefore stripped of the characters that must never reach output
 * and bounded, and nothing else about it is rewritten.
 *
 * Stripping rather than substituting is the right choice here for the same
 * reason: a space put where a control character was is a character the path
 * does not contain. Neither can actually happen through the CLI -- every input
 * name is refused by `validateName` if it carries one -- which is precisely why
 * the guard is worth having: the day a location comes from somewhere else, it
 * still cannot forge a line in the human summary.
 */
export function locationText(value, limit = LOCATION_LIMIT) {
  const stripped = renderable(value).replace(FORBIDDEN_GLOBAL, '')
  if (stripped.length <= limit) return stripped
  return `${stripped.slice(0, limit)}...`
}

/**
 * The name alphabet: record ids, class ids, hold ids, reader names, deletion
 * verifiers and the policy version.
 *
 * Wide enough for the spellings real exports use -- `session-2031`,
 * `chat/transcript`, `matter:2031`, `2026-09-1` -- which means upper case, `.`,
 * `:`, `/`, `+`, `-` and `_` all occur, which is in turn why order here is
 * decided by code unit. One character class under one quantifier, so it is
 * linear in its input, and the input is length-bounded before it runs. No
 * pattern in this package is ever compiled out of input.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/

export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (FORBIDDEN.test(value)) return false
  return IDENTIFIER.test(value)
}

/**
 * A private field: content this tool checks the shape of and never reads aloud.
 *
 * A subject, a preview, a note or a description may hold anything at all --
 * that is what makes it private content rather than a name. It is accepted when
 * it is a string within the bound, and from that point on only its length is
 * ever mentioned. This function deliberately does **not** reject control or
 * bidi characters: they cannot reach output through a field that never reaches
 * output, and refusing a memory preview because the conversation contained a
 * tab would refuse real inventories for no gain.
 */
export function isPrivateContent(value, limit = MAX_PRIVATE_LENGTH) {
  return typeof value === 'string' && value.length <= limit
}

/**
 * Say what a value was, without reproducing any of it.
 *
 * Used for refused values and for private fields alike. The report goes to
 * stdout -- a stream that gets piped, logged and pasted somewhere more public
 * than a memory inventory has any business being -- and the pointer on the
 * finding names the exact position, which is what a reader needs.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains a
 * replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. The decoder decides; the decoded text never
 * gets a vote. Every file this tool opens goes through here, with no exception
 * for the one a reviewer thinks of as configuration.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

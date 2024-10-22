/**
 * memory-retention-auditor -- read a memory and session inventory, the
 * retention and access policy it answers to, the holds over it and the
 * deletion evidence supplied for it, and report what should happen next.
 *
 * ## What this tool does not do
 *
 * **It deletes nothing.** It opens no store, calls nothing, schedules nothing
 * and opens no socket. Its entire output is a report on stdout and, when
 * `--out` is given, one plan document at a path the caller named and this tool
 * checked first. The plan is a proposal for a human to approve; nothing in this
 * package can act on it.
 *
 * ## It reads private content and prints none of it
 *
 * A memory inventory is a list of what an agent remembered about somebody. The
 * fields that carry that -- `subject`, `preview`, `note`, and every
 * `description` -- are checked for shape and length and then never mentioned
 * again: a report says that a record declares a preview, never what the preview
 * said. What does reach the report is ids, class names, dates, vocabulary words
 * and the name of whoever verified a deletion.
 *
 * ## Unknown is never a pass, and "missing" is not "unreadable"
 *
 * A class nobody declared, a hold document that would not read, an evidence
 * document that would not read, or two evidence entries for one deletion, each
 * leave a record `undecided` and the run `incomplete`. Evidence that was
 * supplied and could not be read is never reported as evidence that was not
 * supplied: a reviewer told the second when the first happened stops looking
 * for a file that is sitting right there.
 *
 * ## The clock is an input
 *
 * `--today` is required and is parsed like every other date. There is no
 * `Date.now()` and no `new Date()` anywhere in this package: an auditor that
 * read the host clock would answer a different question tomorrow with nothing
 * in its output saying which question it had answered.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { buildPlan, createPlan, downgradeRows } from './audit.mjs'
import { parseDate } from './dates.mjs'
import { compileEvidence, compileHolds, compilePolicy, compileRecords } from './documents.mjs'
import { parseFailureDetail } from './parse-failure.mjs'
import { RULE_SEVERITY, severityOf } from './rules.mjs'
import {
  LOCATION_LIMIT, byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, locationText,
} from './text.mjs'

export const TOOL_ID = 'memory-retention-auditor'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_RECORDS_NAME = 'records.json'
export const DEFAULT_POLICY_NAME = 'policy.json'
export const DEFAULT_HOLDS_NAME = 'holds.json'
export const DEFAULT_EVIDENCE_NAME = 'evidence.json'

/** The four documents, in the fixed order every loop over them uses. */
const KINDS = Object.freeze(['evidence', 'holds', 'policy', 'records'])

/**
 * Limits, each enforced and each reported by name when it is reached.
 *
 * Exceeding one is never a silent truncation: it produces a finding naming the
 * limit and marks the run `incomplete`, because a partial walk of an inventory
 * is not evidence about the records nobody walked -- and the plan that came out
 * of it would be a list of things to destroy chosen by where the walk stopped.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxClassReferences: 200,
  maxClasses: 200,
  maxEvidenceEntries: 5000,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxHolds: 500,
  maxReaders: 64,
  maxRecordReferences: 500,
  maxRecords: 5000,
  maxRuntimeMs: 10000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxClassReferences: 2000,
  maxClasses: 5000,
  maxEvidenceEntries: 200000,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxHolds: 5000,
  maxReaders: 1024,
  maxRecordReferences: 5000,
  maxRecords: 200000,
  maxRuntimeMs: 600000,
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze([
  'clock', 'evidence', 'holds', 'limits', 'policy', 'records', 'root', 'today',
])

/** Raised when the run passes its time budget; turned into a finding by the caller. */
class TimeBudgetExceeded extends Error {}

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved path refuses legitimate files whenever the root is reached through
 * a symbolic link -- a `/var` that is really `/private/var` is enough -- and a
 * false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered. This is emphatically *not* the confinement: a symbolic link planted
 * inside the root passes every check in this function, and `resolveInput` is
 * what catches it by resolving the real path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

/**
 * Every file a run over these options may open.
 *
 * Exported because the write guard needs it: a destination that is a hard link
 * to an input is the same file as that input, and only device plus inode sees
 * that. A sibling tool passed only its primary input to the guard and destroyed
 * every other file it read, so the set is built in one place and the CLI takes
 * all of it rather than choosing a member.
 */
export function plannedInputs(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  return [
    resolve(options.root, validateName(options.evidence ?? DEFAULT_EVIDENCE_NAME, '--evidence')),
    resolve(options.root, validateName(options.holds ?? DEFAULT_HOLDS_NAME, '--holds')),
    resolve(options.root, validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy')),
    resolve(options.root, validateName(options.records ?? DEFAULT_RECORDS_NAME, '--records')),
  ]
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every string that reaches output is sanitised here -- file, pointer, message
 * and suggestion alike, not only an excerpt field. A sibling tool sanitised its
 * evidence carefully and left identifiers raw, so a record id holding a newline
 * forged an extra line in the human report.
 */
export function createFinding(row) {
  const finding = {
    ruleId: row.ruleId,
    severity: severityOf(row.ruleId),
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: locationText(row.file, LOCATION_LIMIT), pointer: locationText(row.pointer, LOCATION_LIMIT) },
  }
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * The message is part of the key because several rules deliberately anchor more
 * than one finding at the same pointer -- a record read by two people the class
 * does not allow, for one. No two findings share all four components, and
 * `sort` is stable, so even a tie would preserve emission order, which is
 * itself fixed by the documents.
 */
export function compareFindings(left, right) {
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message)
  )
}

function buildReport(sink, state, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: state.files.records,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or audit fewer records at a time.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  const plan = createPlan(status, state.version, state.today, state.rows, state.deletions)

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.rows.length,
      errors,
      warnings,
      records: state.records,
      classes: state.classes,
      holds: state.holds,
      activeHolds: state.activeHolds,
      evidenceEntries: state.evidenceEntries,
      expired: state.counts.expired,
      expiredAndHeld: state.counts.expiredAndHeld,
      deletePlanned: state.counts.delete,
      retained: state.counts.retain,
      held: state.counts.hold,
      verified: state.counts.verified,
      unevidenced: state.counts.unevidenced,
      undecided: state.counts.undecided,
    },
    plan,
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an unresolved
 * target refuses legitimate files, so the root is resolved too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may exist as a link that resolves nowhere. Confine the nearest
    // existing ancestor first, so a symlinked parent directory cannot decide
    // where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

const COMPILERS = Object.freeze({
  evidence: compileEvidence,
  holds: compileHolds,
  policy: compilePolicy,
  records: compileRecords,
})

function emptyState(files, today) {
  return {
    files,
    today,
    rows: [],
    deletions: [],
    counts: { retain: 0, delete: 0, hold: 0, verified: 0, unevidenced: 0, undecided: 0, expired: 0, expiredAndHeld: 0 },
    records: 0,
    classes: 0,
    holds: 0,
    activeHolds: 0,
    evidenceEntries: 0,
    version: null,
    incomplete: false,
  }
}

/**
 * Audit a memory inventory against its retention and access policy.
 *
 * @param {object} options
 * @param {string} options.root Directory holding the four documents.
 * @param {string} options.today The evaluation date, `YYYY-MM-DD`. Required:
 *   this package reads no clock, so the day an audit is judged against is an
 *   input and is stamped on the plan.
 * @param {string} [options.records] Inventory file, relative to the root.
 * @param {string} [options.policy] Retention and access policy, relative to the root.
 * @param {string} [options.holds] Holds, relative to the root.
 * @param {string} [options.evidence] Deletion evidence, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @param {Function} [options.clock] Monotonic millisecond source for the time
 *   budget only. It never reaches the report.
 * @returns {Promise<object>} the report.
 */
export async function auditMemoryRetention(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function returning milliseconds')
  }

  const parsedToday = parseDate(options.today)
  if (!parsedToday.ok) {
    throw new TypeError(
      'today must be a calendar date written as YYYY-MM-DD; it is the day the audit is evaluated against and this tool reads no clock',
    )
  }
  const today = parsedToday.date

  const names = {
    evidence: validateName(options.evidence ?? DEFAULT_EVIDENCE_NAME, '--evidence'),
    holds: validateName(options.holds ?? DEFAULT_HOLDS_NAME, '--holds'),
    policy: validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy'),
    records: validateName(options.records ?? DEFAULT_RECORDS_NAME, '--records'),
  }

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const budget = {
    check() {
      if (clock() - started > limits.maxRuntimeMs) throw new TimeBudgetExceeded()
    },
  }

  const sink = new FindingSink()
  const state = emptyState(names, today.text)

  const parsed = {}
  for (const kind of KINDS) {
    const name = names[kind]
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      // (1) An input that could not be reached is missing evidence, not a
      // verdict about it.
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep all four documents inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      parsed[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    // (2) Unreadable, undecodable or unparseable bytes are missing evidence too.
    if (loaded === null) state.incomplete = true
    parsed[kind] = loaded
  }

  const compiled = {}
  for (const kind of KINDS) {
    if (parsed[kind] === null) {
      compiled[kind] = null
      continue
    }
    const document = COMPILERS[kind](sink, names[kind], parsed[kind].value, limits)
    // (3) A document whose shape, version or size this build cannot take is a
    // document nothing was learned from.
    if (document === null) state.incomplete = true
    compiled[kind] = document
  }

  for (const kind of KINDS) {
    const document = compiled[kind]
    if (document === null) continue
    const accounted = document.entries.length + (document.duplicates ?? 0)
    // (4) An entry that did not compile was never compared against anything.
    if (accounted !== document.declared) state.incomplete = true
    // (5) A refused reference leaves an entry's reach partly unknown, which is
    // not the same as knowing it is narrow.
    if (document.refusedReferences > 0) state.incomplete = true
  }

  if (compiled.policy !== null) {
    state.version = compiled.policy.version
    state.classes = compiled.policy.entries.length
    // (6) An unversioned plan cannot be reviewed against the policy that made it.
    if (compiled.policy.version === null) state.incomplete = true
  }
  if (compiled.records !== null) state.records = compiled.records.entries.length
  if (compiled.holds !== null) {
    state.holds = compiled.holds.entries.length
    state.activeHolds = compiled.holds.entries.filter((hold) => hold.status === 'active').length
  }
  if (compiled.evidence !== null) state.evidenceEntries = compiled.evidence.entries.length

  /**
   * Hold coverage is load-bearing, and so is the readability of the evidence.
   *
   * `holdsKnown` is false whenever any part of the hold document went unread,
   * and while it is false nothing at all is planned for deletion -- the hold
   * nobody could read is exactly the hold that would have stopped one.
   * `evidenceKnown` is narrower: a duplicate leaves only the records it names
   * ambiguous, so it does not make the whole document unread.
   */
  const holdsKnown = compiled.holds !== null
    && compiled.holds.entries.length === compiled.holds.declared
    && compiled.holds.refusedReferences === 0
  const evidenceKnown = compiled.evidence !== null
    && compiled.evidence.entries.length + compiled.evidence.duplicates === compiled.evidence.declared
    && compiled.evidence.refusedReferences === 0

  if (!holdsKnown) {
    state.incomplete = true
    sink.add({
      file: names.holds,
      ruleId: 'hold-coverage-unknown',
      message: `${names.holds} was not read in full, so which records are under an active hold is unknown and nothing in this run was planned for deletion. A hold that could not be read is exactly the hold that would have stopped one.`,
      suggestion: `Fix whatever stopped ${names.holds} from being read, then re-run.`,
    })
  }

  if (compiled.records !== null && compiled.policy !== null) {
    let result = null
    let timedOut = false
    try {
      result = buildPlan(sink, names, compiled, { today, holdsKnown, evidenceKnown }, budget)
      /**
       * The re-check after the loop, and the reason this tool has one.
       *
       * A budget that can be exhausted *inside* a loop cannot be trusted to
       * have fired: a tool in this catalog ran out of steps mid-loop, broke,
       * fell through to the success branch and reported a conclusion it had
       * never finished checking. The budget is asked again here, after the loop
       * has returned, and if it has been passed every disposition is withdrawn.
       */
      budget.check()
    } catch (error) {
      if (!(error instanceof TimeBudgetExceeded)) throw error
      timedOut = true
    }

    if (timedOut) {
      // (7) A run that stopped early audited less than it was asked to, and a
      // half-finished list of things to destroy is worse than none.
      state.incomplete = true
      sink.add({
        file: names.records,
        ruleId: 'time-budget-exceeded',
        message: `The audit passed the maxRuntimeMs budget of ${limits.maxRuntimeMs} and stopped; every disposition it had reached has been withdrawn to undecided and the deletion plan is empty rather than partial.`,
        suggestion: 'Raise --max-runtime-ms, or audit fewer records at a time.',
      })
      if (result !== null) downgradeRows(result, 'time-budget-exceeded')
    }

    if (result === null) {
      // (8) An audit that never ran learned nothing about any record.
      state.incomplete = true
    } else {
      state.rows = result.rows
      state.deletions = result.deletions
      state.counts = result.counts

      // (9) An undecided record is one this run could not finish deciding
      // about. Missing evidence is never a pass.
      if (result.counts.undecided > 0) state.incomplete = true

      // (10) A deletion the inventory declares and no evidence accounts for is
      // a failure of the audit, not of its completeness -- the rule fires, the
      // run fails, and the exit code is 1 rather than 2.

      /**
       * (11) The vacuous pass, refused explicitly.
       *
       * Four documents that compile with no record left to audit would
       * otherwise report `pass` with `checked: 0` -- green on no evidence at
       * all, about an inventory. This flag is the only thing between that input
       * and a green build, so it is an error, it marks the run incomplete, and
       * `test/incomplete.test.mjs` fails when either half is removed.
       */
      if (result.rows.length === 0) {
        state.incomplete = true
        sink.add({
          file: names.records,
          pointer: '/records',
          ruleId: 'no-records-audited',
          message: `The run audited 0 of ${compiled.records.declared} declared record(s), so it has no evidence to be green on.`,
          suggestion: 'Export the inventory this policy is meant to cover, and fix whatever stopped the records that are there from compiling.',
        })
      }
    }
  }

  return buildReport(sink, state, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** The document `--out` writes: the versioned deletion plan, alone. */
export function serializePlan(report) {
  return JSON.stringify({ tool: TOOL_ID, ...report.plan }, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report) {
  const { summary, plan } = report
  const lines = [
    `${summary.checked} of ${summary.records} record(s) audited as at ${plan.evaluatedOn} against ${summary.classes} class(es),`
    + ` ${summary.holds} hold(s) of which ${summary.activeHolds} active, and ${summary.evidenceEntries} evidence entry(ies).`,
    `${summary.expired} expired, of which ${summary.expiredAndHeld} under an active hold;`
    + ` ${summary.deletePlanned} planned for deletion, ${summary.retained} retained, ${summary.held} held,`
    + ` ${summary.verified} verified, ${summary.unevidenced} unevidenced, ${summary.undecided} undecided. status ${report.status}.`,
    `plan version ${plan.version === null ? '(none declared)' : plan.version} digest ${plan.digest}`,
    'This tool deletes nothing: the plan is a proposal, and no record, store or account was touched.',
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} `
      + `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { RULE_SEVERITY, severityOf }
export { DISPOSITIONS, PLAN_SCHEMA_VERSION, buildPlan, createPlan, downgradeRows } from './audit.mjs'
export { MAX_YEAR, MIN_YEAR, daysBetween, isExpired, parseDate } from './dates.mjs'
export {
  BASES, CLASS_KEYS, DOCUMENT_SCHEMA_VERSION, EVIDENCE_DOCUMENT_KEYS, EVIDENCE_KEYS, HOLD_DOCUMENT_KEYS,
  HOLD_KEYS, HOLD_STATUSES, MAX_RETAIN_DAYS, METHODS, POLICY_DOCUMENT_KEYS, PRIVATE_RECORD_KEYS,
  RECORD_DOCUMENT_KEYS, RECORD_KEYS, STATES, compileEvidence, compileHolds, compilePolicy, compileRecords,
} from './documents.mjs'
export { DestinationError, assertWritableDestination } from './write-guard.mjs'
export { parseFailureDetail } from './parse-failure.mjs'
export {
  EXCERPT_LIMIT, LOCATION_LIMIT, MAX_IDENTIFIER_LENGTH, MAX_PRIVATE_LENGTH, byCodeUnit, decodeUtf8,
  describeValue, excerpt, hasForbiddenCharacter, isIdentifier, isPlainObject, isPrivateContent,
  locationText, renderable,
} from './text.mjs'

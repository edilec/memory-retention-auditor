/**
 * The four input documents, compiled from parsed JSON into the shapes the audit
 * works on.
 *
 * Everything here is shape and vocabulary: is this an object, does it declare a
 * version this build reads, is every key one of the documented ones, is every
 * id a name rather than something that merely prints as one, is every date a
 * date that exists, is every word on the ladder it has to be on. Nothing here
 * knows whether a record is expired, held, evidenced or readable -- those are
 * questions about the four documents together and they are answered in
 * `audit.mjs`.
 *
 * The supported dialect is small and declared rather than approximated. A word
 * this build does not implement is refused; it is never quietly read as the
 * convenient case, which for a tool that plans deletions means the case that
 * says "go ahead".
 *
 * Private content -- a subject, a preview, a note, a description -- is checked
 * for shape and length and then never mentioned again. Every message about one
 * says how long it was, never what it said.
 */

import { parseDate } from './dates.mjs'
import {
  MAX_PRIVATE_LENGTH,
  describeValue,
  excerpt,
  isIdentifier,
  isPlainObject,
  isPrivateContent,
} from './text.mjs'

/** The only document version this build reads. Anything else is unsupported, not ignored. */
export const DOCUMENT_SCHEMA_VERSION = '1'

export const RECORD_DOCUMENT_KEYS = Object.freeze(['records', 'schemaVersion'])
export const POLICY_DOCUMENT_KEYS = Object.freeze(['classes', 'schemaVersion', 'version'])
export const HOLD_DOCUMENT_KEYS = Object.freeze(['holds', 'schemaVersion'])
export const EVIDENCE_DOCUMENT_KEYS = Object.freeze(['evidence', 'schemaVersion'])

export const RECORD_KEYS = Object.freeze([
  'class', 'created', 'id', 'lastAccessed', 'note', 'preview', 'readers', 'state', 'subject',
])
export const CLASS_KEYS = Object.freeze([
  'allowedReaders', 'basis', 'description', 'id', 'requiresEvidence', 'retainDays',
])
export const HOLD_KEYS = Object.freeze(['classes', 'description', 'id', 'records', 'status'])
export const EVIDENCE_KEYS = Object.freeze(['description', 'method', 'record', 'recordedOn', 'verifiedBy'])

/** The fields of a record this tool treats as private content and never prints. */
export const PRIVATE_RECORD_KEYS = Object.freeze(['note', 'preview', 'subject'])

/** Which date a retention period is measured from. */
export const BASES = Object.freeze(['created', 'lastAccessed'])

/** What the inventory says has happened to a record so far. */
export const STATES = Object.freeze(['retained', 'deleted'])

/**
 * The hold states this build implements.
 *
 * There are exactly two, and a third word is not guessed at. `"lifted"`,
 * `"pending release"` and `"expired"` all appear in real matter-management
 * exports, and every one of them would have to be mapped onto `active` or
 * `released` by somebody who knows what the exporter meant. Reading an
 * unrecognised status as released is the single most dangerous default this
 * tool could have, so it does not have it: the hold is refused, the run is
 * incomplete, and while hold coverage is incomplete nothing is planned for
 * deletion at all.
 */
export const HOLD_STATUSES = Object.freeze(['active', 'released'])

/** How a deletion was carried out, as declared by the evidence. */
export const METHODS = Object.freeze(['purge', 'crypto-erase'])

/** The longest retention period this build reads, in days. Roughly a century. */
export const MAX_RETAIN_DAYS = 36500

/**
 * The keys of `value` that are not in `allowed`.
 *
 * Counted, never named. A key name is untrusted text from a file this tool did
 * not write, and a sibling tool that named them shipped a credential-shaped key
 * to stdout in full. In a memory inventory a key name can itself be private:
 * `patientDiagnosis` says something about the subject before any value is read.
 */
function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

const DATE_REASONS = Object.freeze({
  calendar: 'names a day that does not exist in that month',
  format: 'is not written as YYYY-MM-DD',
  range: `is outside the calendar range this build reads`,
  shape: 'is not a string',
})

/** One date field, read strictly. */
function readDate(sink, file, pointer, field, raw, required = true) {
  const value = raw[field]
  if (value === undefined && !required) return undefined
  const result = parseDate(value)
  if (!result.ok) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId: 'date-invalid',
      message: `"${field}" ${DATE_REASONS[result.reason]}; it is ${describeValue(value)}. This build reads one spelling, YYYY-MM-DD as a UTC calendar day, and never guesses at another: a retention deadline computed from a date nobody wrote is a deadline nobody declared.`,
      suggestion: 'Re-export the date as YYYY-MM-DD.',
    })
    return null
  }
  return result.date
}

/** One word, checked against one closed ladder. */
function readWord(sink, file, pointer, field, raw, ladder, ruleId, noun) {
  const value = raw[field]
  if (typeof value !== 'string' || !ladder.includes(value)) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId,
      message: `"${field}" must be one of ${ladder.join(', ')}; it is ${describeValue(value)}. This build refuses a ${noun} it does not implement rather than mapping it onto the nearest word, because for a tool that plans deletions the nearest word is the one that says go ahead.`,
      suggestion: `Re-export the document using one of ${ladder.join(', ')}.`,
    })
    return null
  }
  return value
}

/** Every private field on an entry: shape-checked, length-bounded, never read aloud. */
function readPrivateFields(sink, file, pointer, raw, keys, ruleId) {
  const present = []
  for (const key of keys) {
    if (raw[key] === undefined) continue
    if (!isPrivateContent(raw[key])) {
      sink.add({
        file,
        pointer: `${pointer}/${key}`,
        ruleId,
        message: `"${key}" holds private content, so it must be a string of at most ${MAX_PRIVATE_LENGTH} characters; it is ${describeValue(raw[key])}. Its contents are never printed by this tool, whatever they are.`,
      })
      return null
    }
    present.push(key)
  }
  return present
}

/**
 * Open a document: an object, known keys only, a known version.
 *
 * Returns the value or `null`. `null` means nothing at all was compiled from
 * the document -- deliberately, rather than a prefix being read and reported as
 * the whole, because "the first 500 records are safe to delete" is not a
 * question anybody asked.
 */
function openDocument(sink, file, value, documentKeys) {
  if (!isPlainObject(value)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} must hold a JSON object; it holds ${describeValue(value)}.`,
    })
    return null
  }
  const stray = unknownKeys(value, documentKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} declares ${stray.length} unknown key(s); known keys are ${documentKeys.join(', ')}. An unknown key is refused rather than ignored, so a typo cannot disable a check. The names are counted rather than reproduced.`,
    })
    return null
  }
  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      message: `${file} declares schemaVersion ${describeValue(value.schemaVersion)}; this build implements version "${DOCUMENT_SCHEMA_VERSION}" only and does not guess at another one.`,
      suggestion: `Re-export the document as schemaVersion "${DOCUMENT_SCHEMA_VERSION}".`,
    })
    return null
  }
  return value
}

/** Open one list inside an opened document, bounded by its limit. */
function openList(sink, file, document, spec, limits) {
  const list = document[spec.listKey]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: 'document-invalid',
      message: `"${spec.listKey}" must be an array; it is ${describeValue(list)}.`,
    })
    return null
  }
  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: spec.limitRule,
      message: `${file} declares ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; nothing was compiled from it rather than a prefix being read and reported as the whole.`,
      suggestion: `Raise ${spec.limitFlag}, or split the document.`,
    })
    return null
  }
  return list
}

/** The shared entry gate: an object, known keys only, and a usable id where one is required. */
function openEntry(sink, file, pointer, raw, spec, byId) {
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `A ${spec.noun} entry must be an object; this is ${describeValue(raw)}.`,
    })
    return false
  }
  const stray = unknownKeys(raw, spec.entryKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `This ${spec.noun} declares ${stray.length} unknown key(s); known keys are ${spec.entryKeys.join(', ')}. Nothing outside that list is read -- not the value and not the name either, because in a memory inventory a key name can be private before any value is.`,
    })
    return false
  }
  if (!spec.hasId) return true

  if (!isIdentifier(raw.id)) {
    sink.add({
      file,
      pointer: `${pointer}/id`,
      ruleId: 'identifier-invalid',
      message: `This ${spec.noun} has no usable id; it is ${describeValue(raw.id)}.`,
      suggestion: 'An id is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
    })
    return false
  }
  if (byId.has(raw.id)) {
    sink.add({
      file,
      pointer: `${pointer}/id`,
      ruleId: spec.duplicateRule,
      message: `${spec.noun} id "${excerpt(raw.id, 120)}" is declared twice, at ${byId.get(raw.id)} and here; neither copy is authoritative, so this one was refused.`,
    })
    return false
  }
  return true
}

/**
 * The ids a document declared and this build could not compile.
 *
 * "`records.json` does not list that record" is an absence, and it cannot be
 * established from a document that was only partly read: the entry that was
 * refused may be the very one the hold names. A refused entry with a readable
 * id is recorded by that id, so every other id can still be reported as
 * genuinely absent; a refused entry whose id was itself unreadable could have
 * been any id at all, which is what `anonymous` counts.
 *
 * Without this, a hold covering a record whose entry was refused was reported
 * as covering a record the inventory does not list -- "the hold is stale" said
 * about the one document in this package that stops a deletion.
 */
function refusalLedger() {
  const refusedIds = new Set()
  const state = { anonymousRefusals: 0 }
  return {
    refuse(raw) {
      if (isPlainObject(raw) && isIdentifier(raw.id)) refusedIds.add(raw.id)
      else state.anonymousRefusals += 1
    },
    result() {
      return { refusedIds, anonymousRefusals: state.anonymousRefusals }
    },
  }
}

/**
 * A list of references to entries in another document.
 *
 * A member that is not a name is refused and counted: a hold whose coverage is
 * partly unreadable has a coverage this run does not know, which is not the
 * same as knowing it covers nothing. The count travels back to the caller and
 * makes the run incomplete.
 */
function readReferences(sink, file, pointer, field, raw, spec, limits) {
  const list = raw[field]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId: spec.invalidRule,
      message: `"${field}" must be an array of ${spec.noun} ids; it is ${describeValue(list)}. An omitted list is not read as "none": this tool never infers coverage or access from an absent field.`,
    })
    return null
  }
  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId: spec.limitRule,
      message: `This entry names ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; none of them were read.`,
      suggestion: `Raise ${spec.limitFlag}, or split the entry.`,
    })
    return null
  }

  const seen = new Set()
  const values = []
  let refused = 0
  for (let index = 0; index < list.length; index += 1) {
    const member = list[index]
    if (!isIdentifier(member)) {
      refused += 1
      sink.add({
        file,
        pointer: `${pointer}/${field}/${index}`,
        ruleId: spec.referenceRule,
        message: `This ${spec.noun} reference is not a usable id; it is ${describeValue(member)}. It was refused, so what this entry reaches is only partly known.`,
      })
      continue
    }
    if (seen.has(member)) {
      sink.add({
        file,
        pointer: `${pointer}/${field}/${index}`,
        ruleId: spec.duplicateRule,
        message: `${spec.noun} "${excerpt(member, 120)}" is named twice in this list; the repeat changes nothing and was dropped.`,
      })
      continue
    }
    seen.add(member)
    values.push(member)
  }
  values.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  return { values, refused }
}

/**
 * Compile `records.json`: the memory and session inventory.
 *
 * @returns {{declared: number, entries: Array<object>, refusedReferences: number,
 *   refusedIds: Set<string>, anonymousRefusals: number}|null}
 */
export function compileRecords(sink, file, value, limits) {
  const document = openDocument(sink, file, value, RECORD_DOCUMENT_KEYS)
  if (document === null) return null
  const list = openList(sink, file, document, {
    listKey: 'records',
    limitKey: 'maxRecords',
    limitRule: 'too-many-records',
    limitFlag: '--max-records',
    noun: 'record',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'record', entryKeys: RECORD_KEYS, invalidRule: 'record-invalid', duplicateRule: 'record-duplicate', hasId: true,
  }
  const byId = new Map()
  const entries = []
  const ledger = refusalLedger()
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/records/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byId)) {
      ledger.refuse(raw)
      continue
    }

    let classId = null
    if (!isIdentifier(raw.class)) {
      sink.add({
        file,
        pointer: `${pointer}/class`,
        ruleId: 'class-reference-invalid',
        message: `"class" must be the id of a class the policy declares; it is ${describeValue(raw.class)}.`,
      })
    } else {
      classId = raw.class
    }

    const created = readDate(sink, file, pointer, 'created', raw)
    const lastAccessed = readDate(sink, file, pointer, 'lastAccessed', raw)
    const state = readWord(sink, file, pointer, 'state', raw, STATES, 'state-unsupported', 'record state')
    const readers = readReferences(sink, file, pointer, 'readers', raw, {
      noun: 'reader',
      limitKey: 'maxReaders',
      limitRule: 'too-many-readers',
      limitFlag: '--max-readers',
      invalidRule: 'record-invalid',
      referenceRule: 'reader-invalid',
      duplicateRule: 'reader-duplicate',
    }, limits)
    const privateFields = readPrivateFields(sink, file, pointer, raw, PRIVATE_RECORD_KEYS, 'record-invalid')

    if (classId === null || created === null || lastAccessed === null || state === null
      || readers === null || privateFields === null) {
      ledger.refuse(raw)
      continue
    }

    refusedReferences += readers.refused
    byId.set(raw.id, pointer)
    entries.push({
      id: raw.id,
      pointer,
      class: classId,
      created,
      lastAccessed,
      state,
      readers: readers.values,
      privateFields,
    })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { declared: list.length, entries, refusedReferences, ...ledger.result() }
}

/**
 * Compile `policy.json`: the version stamped on the plan, and one retention and
 * access rule per class.
 *
 * @returns {{version: string|null, declared: number, entries: Array<object>, refusedReferences: number,
 *   refusedIds: Set<string>, anonymousRefusals: number}|null}
 */
export function compilePolicy(sink, file, value, limits) {
  const document = openDocument(sink, file, value, POLICY_DOCUMENT_KEYS)
  if (document === null) return null

  let version = null
  if (!isIdentifier(document.version)) {
    /**
     * The plan is a versioned artefact, so an unversioned one is not produced.
     *
     * A list of records somebody is about to destroy, with nothing saying which
     * revision of the retention policy produced it, is a list nobody can review
     * against the policy it came from. The run continues -- the findings are
     * still worth having -- but the plan carries a null version, the run is
     * incomplete, and no consumer is handed a deletion plan that looks
     * authoritative and is not.
     */
    sink.add({
      file,
      pointer: '/version',
      ruleId: 'policy-version-invalid',
      message: `"version" must be a policy version id; it is ${describeValue(document.version)}. The plan is stamped with it, so without one nobody can tell which revision of the retention policy produced the list of records to destroy.`,
      suggestion: 'Stamp the policy export with the revision it came from, for example "2026-09-1".',
    })
  } else {
    version = document.version
  }

  const list = openList(sink, file, document, {
    listKey: 'classes',
    limitKey: 'maxClasses',
    limitRule: 'too-many-classes',
    limitFlag: '--max-classes',
    noun: 'class',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'class', entryKeys: CLASS_KEYS, invalidRule: 'class-invalid', duplicateRule: 'class-duplicate', hasId: true,
  }
  const byId = new Map()
  const entries = []
  const ledger = refusalLedger()
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/classes/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byId)) {
      ledger.refuse(raw)
      continue
    }

    const basis = readWord(sink, file, pointer, 'basis', raw, BASES, 'basis-unsupported', 'retention basis')

    let retainDays = null
    if (!Number.isInteger(raw.retainDays) || raw.retainDays < 0 || raw.retainDays > MAX_RETAIN_DAYS) {
      sink.add({
        file,
        pointer: `${pointer}/retainDays`,
        ruleId: 'retention-invalid',
        message: `"retainDays" must be an integer between 0 and ${MAX_RETAIN_DAYS}; it is ${describeValue(raw.retainDays)}. It was refused rather than clamped: a clamped retention period is a period nobody agreed to.`,
      })
    } else {
      retainDays = raw.retainDays
    }

    let requiresEvidence = null
    if (typeof raw.requiresEvidence !== 'boolean') {
      sink.add({
        file,
        pointer: `${pointer}/requiresEvidence`,
        ruleId: 'class-invalid',
        message: `"requiresEvidence" must be true or false; it is ${describeValue(raw.requiresEvidence)}. It is not defaulted, because defaulting it to false would let a class quietly stop needing evidence for its deletions.`,
      })
    } else {
      requiresEvidence = raw.requiresEvidence
    }

    const allowedReaders = readReferences(sink, file, pointer, 'allowedReaders', raw, {
      noun: 'reader',
      limitKey: 'maxReaders',
      limitRule: 'too-many-readers',
      limitFlag: '--max-readers',
      invalidRule: 'class-invalid',
      referenceRule: 'reader-invalid',
      duplicateRule: 'reader-duplicate',
    }, limits)
    const privateFields = readPrivateFields(sink, file, pointer, raw, ['description'], 'class-invalid')

    if (basis === null || retainDays === null || requiresEvidence === null
      || allowedReaders === null || privateFields === null) {
      ledger.refuse(raw)
      continue
    }

    refusedReferences += allowedReaders.refused
    byId.set(raw.id, pointer)
    entries.push({
      id: raw.id, pointer, basis, retainDays, requiresEvidence, allowedReaders: allowedReaders.values,
    })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { version, declared: list.length, entries, refusedReferences, ...ledger.result() }
}

/**
 * Compile `holds.json`: what may not be destroyed, by record and by class.
 *
 * @returns {{declared: number, entries: Array<object>, refusedReferences: number}|null}
 */
export function compileHolds(sink, file, value, limits) {
  const document = openDocument(sink, file, value, HOLD_DOCUMENT_KEYS)
  if (document === null) return null
  const list = openList(sink, file, document, {
    listKey: 'holds',
    limitKey: 'maxHolds',
    limitRule: 'too-many-holds',
    limitFlag: '--max-holds',
    noun: 'hold',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'hold', entryKeys: HOLD_KEYS, invalidRule: 'hold-invalid', duplicateRule: 'hold-duplicate', hasId: true,
  }
  const byId = new Map()
  const entries = []
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/holds/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byId)) continue

    const status = readWord(sink, file, pointer, 'status', raw, HOLD_STATUSES, 'hold-status-unsupported', 'hold status')
    const records = readReferences(sink, file, pointer, 'records', raw, {
      noun: 'record',
      limitKey: 'maxRecordReferences',
      limitRule: 'too-many-record-references',
      limitFlag: '--max-record-references',
      invalidRule: 'hold-invalid',
      referenceRule: 'record-reference-invalid',
      duplicateRule: 'record-reference-duplicate',
    }, limits)
    const classes = readReferences(sink, file, pointer, 'classes', raw, {
      noun: 'class',
      limitKey: 'maxClassReferences',
      limitRule: 'too-many-class-references',
      limitFlag: '--max-class-references',
      invalidRule: 'hold-invalid',
      referenceRule: 'class-reference-invalid',
      duplicateRule: 'class-reference-duplicate',
    }, limits)
    const privateFields = readPrivateFields(sink, file, pointer, raw, ['description'], 'hold-invalid')

    if (status === null || records === null || classes === null || privateFields === null) continue

    refusedReferences += records.refused + classes.refused
    byId.set(raw.id, pointer)
    /*
     * The refusals are counted per hold, not only for the document.
     *
     * A hold whose only reference was refused has an empty `records` list and
     * an empty `classes` list, which is byte-for-byte the shape of a hold that
     * named nothing at all -- and the audit used to report both as "names no
     * record and no class, so it protects nothing in this inventory". That
     * sentence asserts an absence about a reference sitting in the file, which
     * is the same absent-versus-unreadable mistake this package splits so
     * carefully for deletion evidence. These two numbers are what lets the
     * audit tell the two apart.
     */
    entries.push({
      id: raw.id,
      pointer,
      status,
      records: records.values,
      recordsRefused: records.refused,
      classes: classes.values,
      classesRefused: classes.refused,
    })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { declared: list.length, entries, refusedReferences }
}

/**
 * Compile `evidence.json`: what somebody says was destroyed, and how.
 *
 * Keyed by the record it is about. Two entries for one record are ambiguous
 * rather than cumulative, so neither is used and that record is left undecided.
 *
 * @returns {{declared: number, entries: Array<object>, ambiguous: Set<string>, duplicates: number, refusedReferences: number}|null}
 */
export function compileEvidence(sink, file, value, limits) {
  const document = openDocument(sink, file, value, EVIDENCE_DOCUMENT_KEYS)
  if (document === null) return null
  const list = openList(sink, file, document, {
    listKey: 'evidence',
    limitKey: 'maxEvidenceEntries',
    limitRule: 'too-many-evidence-entries',
    limitFlag: '--max-evidence-entries',
    noun: 'evidence entry',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'evidence entry', entryKeys: EVIDENCE_KEYS, invalidRule: 'evidence-invalid', hasId: false,
  }
  const byRecord = new Map()
  const entries = []
  const ambiguous = new Set()
  let duplicates = 0
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/evidence/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byRecord)) continue

    let record = null
    if (!isIdentifier(raw.record)) {
      refusedReferences += 1
      sink.add({
        file,
        pointer: `${pointer}/record`,
        ruleId: 'record-reference-invalid',
        message: `"record" must be the id of a record in the inventory; it is ${describeValue(raw.record)}. This entry was refused, so which record it evidenced is unknown.`,
      })
    } else {
      record = raw.record
    }

    const method = readWord(sink, file, pointer, 'method', raw, METHODS, 'method-unsupported', 'deletion method')
    const recordedOn = readDate(sink, file, pointer, 'recordedOn', raw)

    let verifiedBy = null
    if (!isIdentifier(raw.verifiedBy)) {
      sink.add({
        file,
        pointer: `${pointer}/verifiedBy`,
        ruleId: 'evidence-invalid',
        message: `"verifiedBy" must name who verified the deletion, as an id; it is ${describeValue(raw.verifiedBy)}. Evidence nobody signed is not evidence.`,
      })
    } else {
      verifiedBy = raw.verifiedBy
    }

    const privateFields = readPrivateFields(sink, file, pointer, raw, ['description'], 'evidence-invalid')
    if (record === null || method === null || recordedOn === null || verifiedBy === null || privateFields === null) continue

    if (byRecord.has(record)) {
      ambiguous.add(record)
      duplicates += 1
      sink.add({
        file,
        pointer,
        ruleId: 'deletion-evidence-duplicate',
        message: `A second evidence entry claims record "${excerpt(record, 120)}", at ${byRecord.get(record)} and here. Two accounts of one deletion are ambiguous rather than cumulative, so neither was used and that record was left undecided.`,
        suggestion: 'Declare exactly one evidence entry per deleted record.',
      })
      continue
    }
    byRecord.set(record, pointer)
    entries.push({ pointer, record, method, recordedOn, verifiedBy })
  }

  entries.sort((left, right) => (left.record === right.record ? 0 : left.record < right.record ? -1 : 1))
  /*
   * `duplicates` is reported separately from `refusedReferences` because the
   * two mean different things to the caller: a duplicate leaves exactly the
   * records it names ambiguous, while a refused entry leaves the whole document
   * partly unread. Folding them together would turn one ambiguous deletion into
   * "no evidence in this file can be trusted", which is a bigger claim than the
   * facts support.
   */
  return { declared: list.length, entries, ambiguous, duplicates, refusedReferences }
}

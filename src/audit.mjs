/**
 * The audit: one plan row per record, and the deletion plan that falls out of
 * them.
 *
 * ## What a row is, and what it is not
 *
 * A row says what four exported documents declare about one remembered record:
 * which class it belongs to, how old it is against the day the audit was
 * evaluated for, whether a hold covers it, who has read it, and -- if the
 * inventory says it has already been deleted -- whether the supplied evidence
 * accounts for that. It is a statement about declarations. **Nothing here
 * deletes anything**, opens a store, or asks a system to do either.
 *
 * ## Expired and held are different facts, and they stay different
 *
 * A record can be expired and held at the same time, and the two answers must
 * not collapse into one. `expired` and `held` are separate fields on every row,
 * and an active hold decides the disposition whatever the retention period
 * says: a held record is never planned for deletion, and it is never reported as
 * simply "retained" either, because the reason it survives is the hold and a
 * reviewer needs to see that.
 *
 * ## Unknown is never a pass
 *
 * A class nobody declared, a hold document that would not read, an evidence
 * document that would not read, two evidence entries for one deletion: each
 * leaves the record `undecided`. None of them is rounded to `retain`, and the
 * evidence cases are never reported as "no evidence was supplied" -- evidence
 * that was supplied and could not be read is a different fact, and saying the
 * first when the second happened is how a tool tells a reviewer to stop looking.
 */

import { createHash } from 'node:crypto'

import { daysBetween, isExpired } from './dates.mjs'
import { byCodeUnit, excerpt } from './text.mjs'

export const PLAN_SCHEMA_VERSION = '1'

/**
 * What the audit concluded about one record.
 *
 * - `retain` -- inside its retention period, no hold.
 * - `delete` -- past its retention period, no hold, still present. These are
 *   the records the plan proposes destroying, and the only ones.
 * - `hold` -- covered by an active hold. Expired or not, it is not for deletion.
 * - `verified` -- the inventory says it is already deleted, and the supplied
 *   evidence accounts for it.
 * - `unevidenced` -- the inventory says it is already deleted and no evidence
 *   accounts for it. An error, never a pass.
 * - `undecided` -- evidence was missing. Never a pass.
 */
export const DISPOSITIONS = Object.freeze([
  'retain', 'delete', 'hold', 'verified', 'unevidenced', 'undecided',
])

const byRowId = (left, right) => byCodeUnit(left.id, right.id)

/**
 * Build the plan.
 *
 * @param {object} sink Finding sink.
 * @param {object} files Input file names, for locations.
 * @param {object} compiled `{records, policy, holds, evidence}`.
 * @param {object} context `{today, holdsKnown, evidenceKnown}`. `today` is the
 *   injected evaluation date -- this package never reads a clock.
 * @param {object} budget `{check()}`, which throws when the time budget is spent.
 */
export function buildPlan(sink, files, compiled, context, budget) {
  const { records, policy, holds, evidence } = compiled
  const { today, holdsKnown, evidenceKnown } = context

  const classById = new Map(policy.entries.map((entry) => [entry.id, entry]))
  const recordIds = new Set(records.entries.map((entry) => entry.id))
  const evidenceByRecord = new Map((evidence?.entries ?? []).map((entry) => [entry.record, entry]))
  const ambiguousEvidence = evidence?.ambiguous ?? new Set()

  const activeHolds = (holds?.entries ?? []).filter((hold) => hold.status === 'active')
  const heldRecordIds = new Map()
  const heldClassIds = new Map()
  for (const hold of activeHolds) {
    for (const id of hold.records) {
      if (!heldRecordIds.has(id)) heldRecordIds.set(id, [])
      heldRecordIds.get(id).push(hold.id)
    }
    for (const id of hold.classes) {
      if (!heldClassIds.has(id)) heldClassIds.set(id, [])
      heldClassIds.get(id).push(hold.id)
    }
  }

  const rows = []
  const counts = {
    retain: 0, delete: 0, hold: 0, verified: 0, unevidenced: 0, undecided: 0,
    expired: 0, expiredAndHeld: 0,
  }

  for (const record of records.entries) {
    budget.check()

    const reasons = new Set()
    let undecided = false
    const fail = (ruleId, pointer, message, suggestion) => {
      reasons.add(ruleId)
      sink.add({ file: files.records, pointer, ruleId, message, ...(suggestion === undefined ? {} : { suggestion }) })
    }

    const entry = classById.get(record.class)
    let basis = null
    let retainDays = null
    let ageDays = null
    let expired = null

    if (entry === undefined) {
      undecided = true
      fail(
        'class-unknown',
        `${record.pointer}/class`,
        `Record "${excerpt(record.id, 120)}" is in class "${excerpt(record.class, 120)}", which ${files.policy} does not declare; how long it may be kept, who may read it and whether its deletion needs evidence are all unknown, and none of them was guessed at.`,
        `Declare the class in ${files.policy}, or correct the reference.`,
      )
    } else {
      basis = entry.basis
      retainDays = entry.retainDays
      const basisDate = basis === 'created' ? record.created : record.lastAccessed
      ageDays = daysBetween(basisDate, today)
      expired = isExpired(basisDate, today, retainDays)
      if (expired) counts.expired += 1

      for (const reader of record.readers) {
        if (entry.allowedReaders.includes(reader)) continue
        fail(
          'access-not-permitted',
          `${record.pointer}/readers`,
          `Record "${excerpt(record.id, 120)}" was read by "${excerpt(reader, 120)}", which the policy for class "${excerpt(record.class, 120)}" does not allow.`,
          'Withdraw the access, or declare the reader on the class deliberately.',
        )
      }
    }

    /*
     * Hold coverage is load-bearing. When any part of the hold document could
     * not be read, the set of held records is not known -- and the hold nobody
     * could read is exactly the hold that would have stopped a deletion -- so
     * no record in the run is decided at all.
     */
    let held = null
    let coveringHolds = []
    if (!holdsKnown) {
      undecided = true
      reasons.add('hold-coverage-unknown')
    } else {
      coveringHolds = [...new Set([...(heldRecordIds.get(record.id) ?? []), ...(heldClassIds.get(record.class) ?? [])])]
        .sort(byCodeUnit)
      held = coveringHolds.length > 0
      if (held && expired === true) counts.expiredAndHeld += 1
    }

    let evidenceRow = null
    let disposition = 'undecided'

    if (record.state === 'deleted') {
      if (!evidenceKnown) {
        /*
         * The distinction this rule exists for. "No evidence was supplied" is a
         * statement about the evidence document; this is a statement about this
         * run's ability to read it, and a reviewer told the first when the
         * second happened stops looking for a file that is sitting right there.
         */
        undecided = true
        fail(
          'deletion-evidence-unknown',
          record.pointer,
          `Record "${excerpt(record.id, 120)}" is recorded as deleted, and ${files.evidence} could not be read in full, so whether any evidence accounts for that deletion is unknown. This is not the same as no evidence having been supplied, and it is not reported as such.`,
          `Fix whatever stopped ${files.evidence} from being read, then re-run.`,
        )
      } else if (ambiguousEvidence.has(record.id)) {
        undecided = true
        reasons.add('deletion-evidence-duplicate')
      } else {
        const supplied = evidenceByRecord.get(record.id)
        if (supplied === undefined) {
          if (entry === undefined) {
            // Whether this class needs evidence at all is part of what was not
            // declared, so the record stays undecided rather than being failed
            // under a rule nobody can show applies.
            undecided = true
          } else if (entry.requiresEvidence) {
            disposition = 'unevidenced'
            fail(
              'deletion-evidence-missing',
              record.pointer,
              `Record "${excerpt(record.id, 120)}" is recorded as deleted and class "${excerpt(record.class, 120)}" requires evidence, and ${files.evidence} accounts for no such deletion.`,
              `Supply the deletion evidence in ${files.evidence}, or correct the record state.`,
            )
          } else {
            disposition = 'verified'
          }
        } else {
          disposition = 'verified'
          evidenceRow = {
            method: supplied.method,
            verifiedBy: supplied.verifiedBy,
            recordedOn: supplied.recordedOn.text,
          }
        }
      }

      if (held === true) {
        fail(
          'deletion-under-hold',
          record.pointer,
          `Record "${excerpt(record.id, 120)}" is recorded as deleted while hold(s) ${coveringHolds.map((id) => `"${excerpt(id, 120)}"`).join(', ')} are active over it. A hold outranks every retention rule, so this deletion should not have happened.`,
          'Investigate the deletion and report it to whoever owns the hold.',
        )
      }
    } else {
      const supplied = evidenceKnown ? evidenceByRecord.get(record.id) : undefined
      if (supplied !== undefined) {
        // Which document is right decides whether this record still exists, so
        // until somebody reconciles them its disposition is not known: planning
        // a deletion for a record that may already be gone, or calling it
        // retained when the evidence says otherwise, would both be inventions.
        undecided = true
        fail(
          'deletion-evidence-contradicts-state',
          record.pointer,
          `Record "${excerpt(record.id, 120)}" is recorded as retained, and ${files.evidence} carries evidence that it was deleted. One of the two documents is wrong and this tool cannot tell which.`,
          'Reconcile the inventory with the deletion evidence.',
        )
      }
      if (!undecided) {
        if (held === true) disposition = 'hold'
        else if (expired === true) disposition = 'delete'
        else disposition = 'retain'
      }
    }

    /*
     * A disposition is withdrawn for missing evidence and for nothing else.
     *
     * A policy violation is not missing evidence: a record read by somebody the
     * class does not allow is still a record whose age and hold status are
     * known, and reporting it as undecided would hide the violation behind a
     * word that means "come back when you have more information". The finding
     * carries the violation and the run fails on its severity; the row keeps
     * saying what should happen to the record.
     */
    if (undecided) disposition = 'undecided'
    counts[disposition] += 1

    rows.push({
      id: record.id,
      class: record.class,
      state: record.state,
      basis,
      retainDays,
      ageDays,
      expired,
      held,
      holds: coveringHolds,
      readers: record.readers,
      privateFields: record.privateFields,
      evidence: evidenceRow,
      disposition,
      reasons: [...reasons].sort(byCodeUnit),
    })
  }

  for (const hold of holds?.entries ?? []) {
    let covers = 0
    for (const id of hold.records) {
      if (recordIds.has(id)) {
        covers += 1
        continue
      }
      sink.add({
        file: files.holds,
        pointer: hold.pointer,
        ruleId: 'hold-record-unknown',
        message: `Hold "${excerpt(hold.id, 120)}" covers record "${excerpt(id, 120)}", which ${files.records} does not list. Either the inventory is missing a record under hold or the hold is stale, and this tool cannot tell which.`,
        suggestion: 'Reconcile the hold against the inventory.',
      })
    }
    for (const id of hold.classes) {
      if (classById.has(id)) {
        covers += 1
        continue
      }
      sink.add({
        file: files.holds,
        pointer: hold.pointer,
        ruleId: 'hold-class-unknown',
        message: `Hold "${excerpt(hold.id, 120)}" covers class "${excerpt(id, 120)}", which ${files.policy} does not declare.`,
        suggestion: 'Reconcile the hold against the retention policy.',
      })
    }
    if (covers === 0 && hold.records.length === 0 && hold.classes.length === 0) {
      sink.add({
        file: files.holds,
        pointer: hold.pointer,
        ruleId: 'hold-covers-nothing',
        message: `Hold "${excerpt(hold.id, 120)}" names no record and no class, so it protects nothing in this inventory.`,
        suggestion: 'Name what the hold covers, or withdraw it.',
      })
    }
  }

  for (const supplied of evidence?.entries ?? []) {
    if (recordIds.has(supplied.record)) continue
    sink.add({
      file: files.evidence,
      pointer: supplied.pointer,
      ruleId: 'deletion-evidence-unknown-record',
      message: `This evidence claims record "${excerpt(supplied.record, 120)}", which ${files.records} does not list, so there is nothing here it can account for.`,
      suggestion: 'Reconcile the evidence against the inventory.',
    })
  }

  rows.sort(byRowId)
  const deletions = rows.filter((row) => row.disposition === 'delete').map((row) => row.id).sort(byCodeUnit)
  return { rows, deletions, counts }
}

/**
 * Withdraw every disposition a partial run reached.
 *
 * Called when the time budget is spent. A budget that can run out *inside* the
 * row loop cannot be trusted to have fired before a row was decided: a tool in
 * this catalog ran out mid-loop, broke, fell through to its success branch and
 * reported a conclusion it had never finished checking. Every row becomes
 * `undecided`, the deletion plan empties -- a half-finished list of things to
 * destroy is worse than none -- and the counts are rebuilt from the rows.
 */
export function downgradeRows(result, ruleId) {
  for (const row of result.rows) {
    if (row.disposition !== 'undecided') {
      row.disposition = 'undecided'
      row.reasons = [...new Set([...row.reasons, ruleId])].sort(byCodeUnit)
    }
  }
  result.deletions = []
  for (const key of ['retain', 'delete', 'hold', 'verified', 'unevidenced']) result.counts[key] = 0
  result.counts.undecided = result.rows.length
}

/**
 * The versioned deletion plan: what `--out` writes and what the report carries.
 *
 * The digest is a SHA-256 over the serialised body, so two runs over the same
 * inventory and the same evaluation date produce the same digest, and any
 * change to a disposition, a hold or an evidence entry produces a different
 * one. It is computed from the plan alone -- no clock, no host, no run id --
 * which is what makes it usable as the thing a reviewer approves before
 * anybody destroys anything.
 */
export function createPlan(version, evaluatedOn, rows, deletions) {
  const body = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    version,
    evaluatedOn,
    deletions,
    rows,
  }
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { ...body, digest }
}

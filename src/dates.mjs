/**
 * Calendar dates, read strictly and compared in whole days.
 *
 * ## Why the date format is closed
 *
 * `new Date(string)` accepts a great deal and guesses at the rest: it reads
 * `"2025-13-45"` as a date in 2026, applies the host time zone to some
 * spellings and not others, and answers `Invalid Date` for the ones it gives up
 * on. An auditor that decides when a memory may be destroyed cannot be built on
 * a parser that guesses, so exactly one spelling is read here -- `YYYY-MM-DD`,
 * interpreted as a UTC calendar day -- and the round trip is checked, which is
 * what rejects `2025-02-30` and `2025-11-31`.
 *
 * ## Why there is no clock in this file
 *
 * There is no `Date.now()` and no `new Date()` anywhere in this package. The
 * day an audit is evaluated against is an input: `--today` is required, it is
 * parsed by the same function as every other date, and it is stamped on the
 * plan. A tool that read the host clock would answer a different question
 * tomorrow with nothing in its output saying which question it had answered,
 * and two runs over the same inventory would not produce the same bytes.
 */

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The calendar range this build reads. Outside it, a date is refused rather than clamped. */
export const MIN_YEAR = 1970
export const MAX_YEAR = 9999

const MILLISECONDS_PER_DAY = 86400000

/**
 * Read one calendar date.
 *
 * @returns {{ok: true, date: {text: string, day: number}}|{ok: false, reason: string}}
 *   `day` is the count of whole days since 1970-01-01 UTC, which is what makes
 *   a comparison between two dates a subtraction rather than a time-zone
 *   question.
 */
export function parseDate(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'shape' }
  const parts = DATE_SHAPE.exec(value)
  if (parts === null) return { ok: false, reason: 'format' }

  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (year < MIN_YEAR || year > MAX_YEAR) return { ok: false, reason: 'range' }
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: 'calendar' }

  const stamp = Date.UTC(year, month - 1, day)
  const round = new Date(stamp)
  // The round trip is the calendar check: `Date.UTC(2025, 1, 30)` is happy to
  // roll over into March, and a retention deadline computed from a date that
  // does not exist is a deadline nobody declared.
  if (round.getUTCFullYear() !== year || round.getUTCMonth() !== month - 1 || round.getUTCDate() !== day) {
    return { ok: false, reason: 'calendar' }
  }

  return { ok: true, date: { text: value, day: stamp / MILLISECONDS_PER_DAY } }
}

/** Whole days from `from` to `to`. Negative when `to` is the earlier of the two. */
export function daysBetween(from, to) {
  return to.day - from.day
}

/**
 * The day a record's retention period ends, and whether it has.
 *
 * Expiry is `age >= retainDays`: a class retained for 30 days is expired on the
 * thirtieth day after its basis date, not the thirty-first. The boundary is
 * written down because a one-day disagreement here is a record destroyed a day
 * early, and `test/expiry.test.mjs` steps a date across it in both directions.
 */
export function isExpired(basisDate, today, retainDays) {
  return daysBetween(basisDate, today) >= retainDays
}

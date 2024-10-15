import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_YEAR, MIN_YEAR, daysBetween, isExpired, parseDate } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * Dates, read strictly and compared in whole days.
 *
 * `new Date(string)` reads "2025-13-45" as a date in 2026 and applies the host
 * time zone to some spellings and not others. An auditor that decides when a
 * memory may be destroyed cannot be built on a parser that guesses, so exactly
 * one spelling is read and the calendar round trip is checked.
 */

test('one spelling is read, and it is a UTC calendar day', () => {
  assert.deepEqual(parseDate('2026-09-14').date, { text: '2026-09-14', day: 20710 })
  assert.equal(parseDate('2026-9-14').ok, false)
  assert.equal(parseDate('2026-09-14T00:00:00Z').ok, false)
  assert.equal(parseDate('14/09/2026').ok, false)
  assert.equal(parseDate('').ok, false)
  assert.equal(parseDate(20260914).ok, false)
  assert.equal(parseDate(null).ok, false)
})

test('a day that does not exist is refused rather than rolled over', () => {
  // Date.UTC(2026, 1, 30) is happy to answer with the second of March, which is
  // how a deadline nobody declared gets computed.
  assert.equal(parseDate('2026-02-30').ok, false)
  assert.equal(parseDate('2026-11-31').ok, false)
  assert.equal(parseDate('2026-13-01').ok, false)
  assert.equal(parseDate('2026-00-10').ok, false)
  assert.equal(parseDate('2026-01-00').ok, false)
  assert.equal(parseDate('2026-02-28').ok, true)
  assert.equal(parseDate('2024-02-29').ok, true, 'a real leap day is not refused')
  assert.equal(parseDate('2026-02-29').ok, false, 'and an imaginary one is')
})

test('the calendar range is closed at both ends', () => {
  assert.equal(parseDate(`${MIN_YEAR}-01-01`).ok, true)
  assert.equal(parseDate(`${MIN_YEAR - 1}-12-31`).ok, false)
  assert.equal(parseDate(`${MAX_YEAR}-12-31`).ok, true)
  assert.equal(parseDate('10000-01-01').ok, false)
})

test('a difference is whole days, and negative when the second date is earlier', () => {
  const january = parseDate('2026-01-01').date
  const march = parseDate('2026-03-01').date

  assert.equal(daysBetween(january, march), 59, '2026 is not a leap year')
  assert.equal(daysBetween(march, january), -59)
  assert.equal(daysBetween(january, january), 0)
  assert.equal(daysBetween(parseDate('2024-01-01').date, parseDate('2024-03-01').date), 60, '2024 is')
})

test('expiry is age >= retainDays, and the boundary is where it is documented', () => {
  const basis = parseDate('2026-01-01').date

  assert.equal(isExpired(basis, parseDate('2026-01-30').date, 30), false)
  assert.equal(isExpired(basis, parseDate('2026-01-31').date, 30), true)
  assert.equal(isExpired(basis, parseDate('2026-01-01').date, 0), true, 'a zero-day class expires the day it is made')
  assert.equal(isExpired(basis, parseDate('2025-12-31').date, 0), false, 'and not before it exists')
})

/**
 * The shipped source with its comments removed.
 *
 * Stripping them is the whole point of this helper: the modules below *discuss*
 * `Date.now()` at length, in the docblocks that explain why it is not called,
 * so a scan of the raw text finds the prose and fails on the documentation of
 * the very guarantee it is checking. The block comments go first, then the
 * whole-line `//` comments; no `//` appears inside a string literal anywhere in
 * this package, which is what makes the second pass safe here.
 */
async function shippedCode() {
  const parts = []
  for (const directory of ['bin', 'src']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts
    .join(String.fromCharCode(10))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
}

test('the comment stripper really does remove the prose, and keep the code', async () => {
  // Without this case the next test could pass by stripping everything.
  const code = await shippedCode()

  assert.equal(code.includes('There is no `Date.now()`'), false, 'the prose survived')
  assert.equal(code.includes('export function parseDate'), true, 'the code did not')
  assert.equal(code.length > 5000, true)
})

test('no clock is read anywhere in the shipped code', async () => {
  const code = await shippedCode()

  // `Date.UTC` is arithmetic on numbers a caller supplied; `new Date(stamp)` is
  // the round-trip check on those same numbers. Neither asks what time it is.
  assert.equal(/Date\.now\s*\(/.test(code), false, 'the code reads the wall clock')
  assert.equal(/new Date\(\s*\)/.test(code), false, 'the code constructs a date from the wall clock')
  assert.equal(/new Date\(\s*Date\.now/.test(code), false)
  assert.equal(code.includes('Date.UTC('), true, 'and it does still do calendar arithmetic')
})

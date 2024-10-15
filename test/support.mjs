/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees here can only be pinned by the second -- an exit code
 * cannot be satisfied by editing a table.
 *
 * Everything in this file builds *inputs*. Nothing in it decides what a test
 * expects: no severity, no rule id, no disposition, no count and no ordering
 * lives here, so a test cannot assert a value against the same declaration that
 * produced it.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { auditMemoryRetention } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/memory-retention-auditor.mjs')

/**
 * The evaluation date every fixture is built around.
 *
 * It is a constant rather than today's date because this package reads no
 * clock: a suite that computed its own expectations from the host clock would
 * pass on a machine whose date had drifted and fail on a Tuesday.
 */
export const TODAY = '2026-09-14'

/** One record in the inventory. Extra keys are merged so a test can break exactly one field. */
export function record(id, cls, extra = {}) {
  return {
    id,
    class: cls,
    created: '2026-08-01',
    lastAccessed: '2026-09-01',
    state: 'retained',
    readers: ['support-agent'],
    ...extra,
  }
}

/** One class in the retention and access policy. */
export function policyClass(id, basis, retainDays, requiresEvidence, allowedReaders, extra = {}) {
  return { id, basis, retainDays, requiresEvidence, allowedReaders, ...extra }
}

/** One hold. */
export function hold(id, status, records = [], classes = [], extra = {}) {
  return { id, status, records, classes, ...extra }
}

/** One deletion evidence entry. */
export function evidence(recordId, method = 'purge', verifiedBy = 'ops-platform', recordedOn = '2026-09-02', extra = {}) {
  return { record: recordId, method, verifiedBy, recordedOn, ...extra }
}

export const recordDocument = (records) => ({ schemaVersion: '1', records })
export const holdDocument = (holds) => ({ schemaVersion: '1', holds })
export const evidenceDocument = (entries) => ({ schemaVersion: '1', evidence: entries })
export const policyDocument = (classes, version = '2026-09-1') => ({ schemaVersion: '1', version, classes })

/** The four documents, as objects, under their default names. */
export const fixture = (records, classes, holds = [], entries = [], version) => ({
  'records.json': recordDocument(records),
  'policy.json': policyDocument(classes, version),
  'holds.json': holdDocument(holds),
  'evidence.json': evidenceDocument(entries),
})

/**
 * An inventory that raises nothing at all: one class, one record inside its
 * retention period, read by somebody the class allows, no hold and no evidence
 * to reconcile. Tests break exactly one thing in it so that the finding they
 * assert is the only finding there is.
 */
export const clean = () => fixture(
  [record('session-2031', 'chat-transcript')],
  [policyClass('chat-transcript', 'lastAccessed', 30, true, ['support-agent'])],
)

/**
 * Create a temporary root, write the named files into it, run `body(root)` and
 * remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'memory-retention-auditor-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => auditMemoryRetention({ root, today: TODAY, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams; never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = [], today = TODAY) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--today', today, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/** The plan row for one record id. */
export const rowFor = (report, id) => report.plan.rows.find((row) => row.id === id)

/**
 * A clock that hands out a scripted sequence of millisecond readings and counts
 * how many times it was asked.
 *
 * This is the *time budget* clock, not the evaluation date: the budget is the
 * one bound here whose firing depends on when it is checked rather than on what
 * the input contains, so tests drive it by script instead of by waiting.
 */
export function scriptedClock(readingFor) {
  const state = { calls: 0 }
  const clock = () => {
    state.calls += 1
    return readingFor(state.calls)
  }
  clock.state = state
  return clock
}

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLM': String.fromCharCode(0x200f),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})

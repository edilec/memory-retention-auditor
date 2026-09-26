#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import process from 'node:process'

import {
  DEFAULT_EVIDENCE_NAME,
  DEFAULT_HOLDS_NAME,
  DEFAULT_POLICY_NAME,
  DEFAULT_RECORDS_NAME,
  DestinationError,
  assertWritableDestination,
  auditMemoryRetention,
  excerpt,
  exitCodeFor,
  formatReport,
  plannedInputs,
  serializePlan,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `memory-retention-auditor

Audit a local memory and session inventory against its retention and access
policy, produce a deletion plan, and verify the deletion evidence supplied for
records the inventory says are already gone.

This tool DELETES NOTHING. It reads four JSON documents and writes a report;
with --out it also writes one plan document at a path you name and it checks
first. It opens no store, no socket and no account. The plan is a proposal for
somebody to approve, and nothing here can act on it.

It reads private content and prints none of it. A record's subject, preview and
note, and every description, are checked for shape and length and never read
aloud: the report says that a record declares a preview, never what it said.

An active hold outranks every retention rule. A held record is never planned for
deletion however old it is, and a record the inventory says was deleted while a
hold was active is reported as a deletion that should not have happened.

Unknown is never a pass. Evidence that was supplied and could not be read is
never reported as evidence that was not supplied.

Usage:
  memory-retention-auditor --root DIR --today YYYY-MM-DD
                           [--records FILE] [--policy FILE] [--holds FILE]
                           [--evidence FILE] [--out FILE] [--out-root DIR]
                           [--json] [--max-file-bytes N] [--max-records N]
                           [--max-classes N] [--max-holds N]
                           [--max-evidence-entries N] [--max-record-references N]
                           [--max-class-references N] [--max-readers N]
                           [--max-runtime-ms N] [--max-findings N]

Options:
  --root DIR                  Directory holding the four documents (required)
  --today YYYY-MM-DD          The day the audit is evaluated against (required)
  --records FILE              Inventory, relative to --root
                              (default ${DEFAULT_RECORDS_NAME})
  --policy FILE               Retention and access policy, relative to --root
                              (default ${DEFAULT_POLICY_NAME})
  --holds FILE                Holds, relative to --root (default ${DEFAULT_HOLDS_NAME})
  --evidence FILE             Deletion evidence, relative to --root
                              (default ${DEFAULT_EVIDENCE_NAME})
  --out FILE                  Also write the versioned deletion plan here
  --out-root DIR              Directory --out must resolve inside
                              (default: the current working directory)
  --json                      Suppress the human summary on stderr
  --max-file-bytes N          Maximum bytes per document (default 5242880)
  --max-records N             Maximum records in the inventory (default 5000)
  --max-classes N             Maximum declared classes (default 200)
  --max-holds N               Maximum declared holds (default 500)
  --max-evidence-entries N    Maximum evidence entries (default 5000)
  --max-record-references N   Maximum records named by one hold (default 500)
  --max-class-references N    Maximum classes named by one hold (default 200)
  --max-readers N             Maximum readers on one record or class (default 64)
  --max-runtime-ms N          Time budget for the audit (default 10000)
  --max-findings N            Maximum findings in one report (default 1000)
  -h, --help                  Show this help
  -v, --version               Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Why --today is required:
  No wall clock is read here. The day an audit is judged against is an input,
  it is parsed like every other date, and it is stamped on the plan -- so two
  runs over the same inventory and the same date produce the same bytes, and a
  plan always says which day produced it. The only clock this tool reads is the
  monotonic one behind --max-runtime-ms, and no reading from it reaches the
  report.

Writing the plan:
  --out is checked before anything is read and long before anything is written.
  A destination that is a symbolic link is refused unread, a destination that is
  the same file as one of the four inputs -- including through a hard link,
  which shares no path with it -- is refused, and a destination whose parent
  resolves outside --out-root is refused. A refused destination is a
  configuration error: stdout stays empty and the exit code is 2. The plan is
  written before the report reaches stdout, so a write that fails also leaves
  stdout empty rather than reporting success for an artefact that does not exist.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  Every record was matched to a declared class, every date read, hold coverage
  known in full, every reader permitted by the class, every deletion the
  inventory declares accounted for by evidence, and nothing deleted under a
  hold. It is a statement about four exported documents: no store was inspected,
  so a pass never says a record that the inventory calls deleted is actually
  gone -- only that somebody signed evidence saying so.

Exit codes:
  0  the inventory was audited and nothing contradicted the policy
  1  it was audited and at least one error-severity rule fired -- including a
     declared deletion with no evidence for it
  2  invalid configuration or a refused destination (no report on stdout), or
     evidence that could not be obtained (an "incomplete" report on stdout,
     never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-class-references', 'maxClassReferences'],
  ['--max-classes', 'maxClasses'],
  ['--max-evidence-entries', 'maxEvidenceEntries'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-holds', 'maxHolds'],
  ['--max-readers', 'maxReaders'],
  ['--max-record-references', 'maxRecordReferences'],
  ['--max-records', 'maxRecords'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
])

const VALUE_FLAGS = new Map([
  ['--evidence', 'evidence'],
  ['--holds', 'holds'],
  ['--out', 'out'],
  ['--out-root', 'outRoot'],
  ['--policy', 'policy'],
  ['--records', 'records'],
  ['--root', 'root'],
  ['--today', 'today'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = {
    root: null, today: null, records: null, policy: null, holds: null, evidence: null,
    out: null, outRoot: null, json: false, limits: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--today 2026-01-01 --today 2030-01-01` audits against a date nobody named
   * and `--max-records 5 --max-records 5000` enforces a bound nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.today === null) {
    throw new Error('--today is required: this tool reads no wall clock, so the day the audit is evaluated against is an input')
  }
  /*
   * Accepted and ignored is how a documented option quietly stops being
   * enforced, so a write root named without a write is a usage error.
   */
  if (options.outRoot !== null && options.out === null) {
    throw new Error('--out-root has no meaning without --out')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const call = {
    root: options.root,
    today: options.today,
    limits: options.limits,
    ...(options.records === null ? {} : { records: options.records }),
    ...(options.policy === null ? {} : { policy: options.policy }),
    ...(options.holds === null ? {} : { holds: options.holds }),
    ...(options.evidence === null ? {} : { evidence: options.evidence }),
  }

  /*
   * The destination is checked before anything is read and long before anything
   * is written. `--out` is not a safe place to put an unchecked path: a symlink
   * there, a symlinked directory on the way there, or a hard link to one of the
   * four inputs all destroy a file this tool was never asked to touch, and in
   * this catalog every one of them has done exactly that while the run exited 0
   * reporting success. The input set is every file the run may open, not just
   * the primary one.
   *
   * A refused destination is a configuration error, so stdout stays empty.
   */
  let destination = null
  if (options.out !== null) {
    try {
      destination = await assertWritableDestination(options.out, {
        inputs: plannedInputs(call),
        root: options.outRoot ?? process.cwd(),
        label: '--out',
      })
    } catch (error) {
      if (!(error instanceof DestinationError) && !(error instanceof TypeError)) throw error
      process.stderr.write(`${excerpt(error.message, 400)}\n`)
      return 2
    }
  }

  let report
  try {
    report = await auditMemoryRetention(call)
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and a
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  if (destination !== null) {
    try {
      await writeFile(destination, `${serializePlan(report)}\n`)
    } catch (error) {
      // Written before the report reaches stdout, so a failed write cannot be
      // read as a success that produced a plan nobody has.
      process.stderr.write(`--out could not be written: ${error.code ?? 'unknown error'}\n`)
      return 2
    }
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.records} record(s) were audited and`
      + ` ${report.summary.undecided} could not be decided; this run is not a pass and the plan is not ready to act on.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))

# memory-retention-auditor

Audit a local memory and session inventory against its retention and access
policy, produce a deletion plan, and verify the deletion evidence supplied for
records the inventory says are already gone.

**This tool deletes nothing.** It reads four JSON documents and writes a report;
with `--out` it also writes one plan document at a path you name and it checks
first. It opens no store, no socket and no account. The plan is a proposal for
somebody to approve, and nothing here can act on it.

**It reads private content and prints none of it.** A record's `subject`,
`preview` and `note`, and every `description`, are checked for shape and length
and never read aloud: a report says that a record declares a preview, never what
the preview said.

**An active hold outranks every retention rule.** A held record is never planned
for deletion however old it is, and `expired` and `held` stay separate facts on
every row so a reviewer can see which one decided the outcome.

- **Repository:** [edilec/memory-retention-auditor](https://github.com/edilec/memory-retention-auditor)
- **Area:** Prompt & Agent Workflows
- **License:** MIT
- Node ESM, `node >= 22`, no runtime and no development dependencies.

## Install and run

```sh
npx memory-retention-auditor --root ./inventory --today 2026-09-14
```

```sh
memory-retention-auditor --root examples/clean --today 2026-09-14
memory-retention-auditor --root examples/held --today 2026-09-14 --json | jq '.plan.rows[] | {id, expired, held, disposition}'
memory-retention-auditor --root examples/clean --today 2026-09-14 --out ./plan.json --out-root .
```

stdout carries the JSON report and nothing else, so it can be piped straight
into a parser. The human summary and every diagnostic go to stderr, which means
a non-empty stderr on a successful run is correct rather than a symptom.

| Exit | Meaning |
| ---: | --- |
| `0` | The inventory was audited and nothing contradicted the policy. |
| `1` | It was audited and at least one error-severity rule fired — including a declared deletion with no evidence for it. |
| `2` | Invalid configuration or a refused `--out` (nothing on stdout), or evidence that could not be obtained (an `incomplete` report on stdout, never a `pass`). |

## Why `--today` is required

This package reads no clock. `Date.now()` appears nowhere in it and no date is
ever constructed from the current time: the day an audit is judged against is an
input, it is parsed like every other date, and it is stamped on the plan as
`evaluatedOn`. An auditor that read the host clock would answer a different
question tomorrow with nothing in its output saying which question it had
answered — and two runs over the same inventory would not produce the same
bytes.

Exactly one date object is constructed anywhere here — `new Date(stamp)` in
`src/dates.mjs`, where `stamp` is `Date.UTC(...)` over the three numbers the
caller wrote — and it exists to check the calendar round trip that refuses
`2026-02-30`. It asks nothing about what time it is, and it is named here
because an earlier wording of this paragraph claimed a package with no date
construction in it at all — a stronger claim than the code kept.

## Input

Four documents in one directory, each declaring `"schemaVersion": "1"`.

```
inventory/
  records.json    the memory and session inventory
  policy.json     the policy version, and one retention and access rule per class
  holds.json      what may not be destroyed, by record and by class
  evidence.json   what somebody says was destroyed, and how
```

```json
// records.json
{ "schemaVersion": "1", "records": [
  { "id": "session-2031", "class": "chat-transcript",
    "created": "2026-07-01", "lastAccessed": "2026-09-10",
    "state": "retained", "readers": ["support-agent"],
    "subject": "subject-a1", "preview": "…never printed…" }
] }
```

```json
// policy.json
{ "schemaVersion": "1", "version": "2026-09-1", "classes": [
  { "id": "chat-transcript", "basis": "lastAccessed", "retainDays": 30,
    "requiresEvidence": true, "allowedReaders": ["support-agent"] }
] }
```

```json
// holds.json                                  // evidence.json
{ "schemaVersion": "1", "holds": [             { "schemaVersion": "1", "evidence": [
  { "id": "matter-4411", "status": "active",     { "record": "session-1998", "method": "purge",
    "records": ["session-1900"],                   "verifiedBy": "ops-platform",
    "classes": [] } ] }                            "recordedOn": "2026-03-05" } ] }
```

`docs/retention-rules.md` is the full dialect, the rule catalog and the limits.

## Output

Every record gets a plan row, and the rows with disposition `delete` — and only
those — become the deletion plan.

| Disposition | Meaning |
| --- | --- |
| `retain` | Inside its retention period, no hold. |
| `delete` | Past its retention period, no hold, still present. |
| `hold` | Covered by an active hold. Expired or not, it is not for deletion. |
| `verified` | Already deleted, and the supplied evidence accounts for it. |
| `unevidenced` | Already deleted, and no evidence accounts for it. An error, never a pass. |
| `undecided` | Evidence was missing. Never a pass, always `incomplete`. |

```json
{
  "schemaVersion": "1",
  "tool": "memory-retention-auditor",
  "status": "pass",
  "summary": {
    "checked": 3, "errors": 0, "warnings": 0,
    "records": 3, "classes": 2, "holds": 1, "activeHolds": 1, "evidenceEntries": 1,
    "expired": 3, "expiredAndHeld": 1,
    "deletePlanned": 1, "retained": 0, "held": 1,
    "verified": 1, "unevidenced": 0, "undecided": 0
  },
  "plan": {
    "schemaVersion": "1",
    "status": "pass",
    "version": "2026-09-1",
    "evaluatedOn": "2026-09-14",
    "deletions": ["session-1901"],
    "rows": [
      { "id": "session-1900", "class": "chat-transcript", "state": "retained",
        "basis": "lastAccessed", "retainDays": 30, "ageDays": 256,
        "expired": true, "held": true, "holds": ["matter-4411"],
        "readers": ["support-agent"], "privateFields": ["subject"],
        "evidence": null, "disposition": "hold", "reasons": [] }
    ],
    "digest": "963810b6…"
  },
  "findings": []
}
```

### Missing evidence and unreadable evidence are different facts

```
ERROR  records.json/records/0 deletion-evidence-missing Record "session-1998" is
       recorded as deleted and class "chat-transcript" requires evidence, and
       evidence.json accounts for no such deletion.                   → exit 1

ERROR  records.json/records/0 deletion-evidence-unknown Record "session-1998" is
       recorded as deleted, and evidence.json could not be read in full, so
       whether any evidence accounts for that deletion is unknown. This is not
       the same as no evidence having been supplied, and it is not reported as
       such.                                                          → exit 2
```

Neither can pass. Reporting the first when the second happened would send a
reviewer looking for a file that is sitting right there — so the two have
separate rule ids, separate exit codes, and a test that asserts each is absent
from the other's run.

### Hold coverage is load-bearing

If any part of `holds.json` went unread — the file, an entry, or a reference
inside one — the set of held records is unknown and **nothing in the run is
planned for deletion**. The hold nobody could read is exactly the hold that
would have stopped a deletion.

A hold that named references none of which could be read raises
`hold-coverage-unreadable`, never `hold-covers-nothing`. "It protects nothing"
is an absence, and asserting it about a reference that is sitting in the file,
refused, is the same mistake as reporting unreadable evidence as missing
evidence.

### The plan is versioned, and it says whether the audit finished

`plan.version` is the `version` the policy declares, `plan.evaluatedOn` is the
date you passed, and `plan.digest` is a SHA-256 over the plan body, computed
with no clock, host or run id. Two runs over the same inventory and the same
date produce the same digest; any change to a disposition, a hold or an evidence
entry produces a different one. That is what makes it usable as the thing a
reviewer approves before anybody destroys anything.

`plan.status` is the status of the run that produced it — `pass`, `fail` or
`incomplete` — and it is inside the digest, so approving the bytes approves the
completeness claim too. The document is written on its own and read on its own,
so it has to say that on its own: without it, `--out` handed a reviewer a
signed list of records to destroy from a run that had exited 2, and the only
warning was a stderr line that `--json` suppresses.

An `incomplete` plan can still carry deletions, and that is deliberate. A record
whose class, age and hold status were all read is a record this run did decide
about; emptying the list because a *different* record could not be decided would
answer one unknown by discarding an answer. The two cases where the list really
would be untrustworthy empty it at the source instead: an unread hold document
leaves every record undecided, and a spent time budget withdraws every
disposition.

### Writing it out

`--out FILE` writes the versioned plan; the report still goes to stdout. The
destination is checked before anything is read: a symbolic link at the
destination is refused on sight, a parent that resolves outside `--out-root`
(default: the current working directory) is refused, and a destination that is
the same file as one of the four inputs — including through a hard link, which
shares no path with it — is refused. A plan written over the inventory or the
evidence would destroy exactly what the plan is about. A refused destination is
a configuration error: stdout stays empty and the exit code is 2.

## Examples

```sh
npm run example                                                            # exit 0
node bin/memory-retention-auditor.mjs --root examples/held --today 2026-09-14         # exit 0
node bin/memory-retention-auditor.mjs --root examples/unevidenced --today 2026-09-14  # exit 1
node bin/memory-retention-auditor.mjs --root examples/incomplete --today 2026-09-14   # exit 2
```

- `examples/clean` — nothing expired without cause, one verified deletion.
- `examples/held` — two records long past their retention period; one is under
  an active hold and is not in the deletion plan, the other is.
- `examples/unevidenced` — a declared deletion nothing accounts for, and a
  record read by somebody the class does not allow.
- `examples/incomplete` — a record in a class the policy does not declare, so
  how long it may be kept is unknown and the run cannot pass.

## Limits and non-goals

Every limit is enforced and named when it is reached, and exceeding one makes
the run `incomplete` rather than truncating silently — the plan that came out of
a partial walk would be a list of things to destroy chosen by where the walk
stopped. The defaults and their caps are in `docs/retention-rules.md`.

This tool **cannot** tell you:

- **Whether a record the inventory calls deleted is actually gone.** No store is
  inspected. A `verified` row means somebody signed evidence saying so.
- **Whether the inventory is complete.** A memory the export did not list is one
  this tool never saw.
- **Whether a reader should have had access.** The policy's `allowedReaders` is
  the only standard applied, and the tool has no idea whether that list is right.
- **Whether a deletion plan may be executed.** It is a proposal. Nothing here
  checks a backup, a replica, an index or a downstream copy.
- **Anything about what the records contain.** Private content is read for shape
  and length and never for meaning.

It also does not delete, schedule, queue or request a deletion. Static analysis
of declared configuration is the whole of it.

## Development

```sh
npm run check     # lint, test, run the example, and npm pack --dry-run
npm test
npm run lint
```

No runtime and no development dependencies. The test suite pins the guarantees
this README makes rather than the declarations behind them: severity by process
exit code, ordering by emitted sequence, the write guard by one case per hole
plus the allowed cases, redaction by a canary swept out of stdout, stderr **and**
the plan document, and "deletes nothing" by a byte-for-byte snapshot of the
input tree around every run.

## License

MIT. See [LICENSE](./LICENSE).

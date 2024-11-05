# Rule catalog, limits and the supported dialect

What `memory-retention-auditor` reads, what each rule means, what it refuses,
and what it cannot tell you. The README is the short version; this file is the
one to read before changing a rule id or a severity, because both are part of
the public surface.

**This tool deletes nothing.** It reads four JSON documents and writes a report,
and with `--out` one plan document at a path you name and it checks first. The
plan is a proposal for somebody to approve; nothing in this package can act on
it, and nothing in it opens a store.

**It reads private content and prints none of it.** A record's `subject`,
`preview` and `note`, and every `description`, are checked for shape and length
and never read aloud.

## Input dialect

Four documents in one directory. Every one declares `"schemaVersion": "1"`, and
an unknown key anywhere is refused rather than ignored, so a typo cannot disable
a check.

```
inventory/
  records.json    the memory and session inventory
  policy.json     the policy version, and one retention and access rule per class
  holds.json      what may not be destroyed, by record and by class
  evidence.json   what somebody says was destroyed, and how
```

### `records.json` — the inventory

```json
{ "schemaVersion": "1", "records": [
  { "id": "session-2031",
    "class": "chat-transcript",
    "created": "2026-07-01",
    "lastAccessed": "2026-09-10",
    "state": "retained",
    "readers": ["support-agent"],
    "subject": "subject-a1",
    "preview": "…" }
] }
```

Keys: `class`, `created`, `id`, `lastAccessed`, `note`, `preview`, `readers`,
`state`, `subject`. Both dates are required whichever basis the class uses, so
that changing the basis never turns a record into one nobody can date. `state`
is `retained` or `deleted`.

`note`, `preview` and `subject` are **private content**: they may hold anything
at all, including characters an id may not, and they never reach any output.
What a report says about them is which of them a record declares.

### `policy.json` — retention and access, per class

```json
{ "schemaVersion": "1",
  "version": "2026-09-1",
  "classes": [
    { "id": "chat-transcript",
      "basis": "lastAccessed",
      "retainDays": 30,
      "requiresEvidence": true,
      "allowedReaders": ["support-agent"] }
  ] }
```

Keys: `classes`, `schemaVersion`, `version`; a class carries `allowedReaders`,
`basis`, `description`, `id`, `requiresEvidence`, `retainDays`.

`requiresEvidence` is never defaulted — defaulting it to `false` would let a
class quietly stop needing evidence for its deletions. `version` is required:
the plan is stamped with it, and a list of records somebody is about to destroy
with nothing saying which policy revision produced it is a list nobody can
review.

### `holds.json` — what may not be destroyed

```json
{ "schemaVersion": "1", "holds": [
  { "id": "matter-4411", "status": "active",
    "records": ["session-1900"], "classes": [] }
] }
```

Keys: `classes`, `description`, `id`, `records`, `status`. A hold covers records
by id, by class, or both.

### `evidence.json` — what was destroyed, and how

```json
{ "schemaVersion": "1", "evidence": [
  { "record": "session-1998", "method": "purge",
    "verifiedBy": "ops-platform", "recordedOn": "2026-03-05" }
] }
```

Keys: `description`, `method`, `record`, `recordedOn`, `verifiedBy`. Exactly one
entry per deleted record: two accounts of one deletion are ambiguous rather than
cumulative, so neither is used and that record is left undecided.

### Names and dates

An id is 1–120 characters from `[A-Za-z0-9._:/+-]`, starting with a letter or a
digit. A value that would merely print as an id — one carrying a control, a line
separator or a bidi override — is refused at the door, because an id whose
printed form differs from the id the auditor compared is an id nobody can
approve a deletion against.

A date is `YYYY-MM-DD`, read as a UTC calendar day, and the round trip is
checked: `2026-02-30` is refused rather than rolled into March. `new Date(string)`
is never used on input, because it guesses.

## The vocabularies

| Vocabulary | Values |
| --- | --- |
| `basis` | `created`, `lastAccessed` |
| `state` | `retained`, `deleted` |
| hold `status` | `active`, `released` |
| evidence `method` | `purge`, `crypto-erase` |

Each is closed. A word outside one is refused; it is never mapped onto the
nearest word that looks similar. Reading an unrecognised hold status as
`released` is the single most dangerous default this tool could have, so it does
not have it.

## The evaluation date is an input

`--today` is required. `Date.now()` appears nowhere in this package and no date
is ever constructed from the current time: an auditor that read the host clock
would answer a different question tomorrow with nothing in its output saying
which question it had answered, and two runs over the same inventory would not
produce the same bytes. The date is parsed like every other date and stamped on
the plan as `evaluatedOn`. One date object is constructed anywhere in the
package — `new Date(stamp)` in `src/dates.mjs`, over a `Date.UTC` stamp built
from the caller's own numbers — and it is the calendar round trip that refuses
`2026-02-30`.

Expiry is `age >= retainDays`, where age is whole days from the basis date to
the evaluation date. A class kept for 30 days expires on the thirtieth day after
its basis date, not the thirty-first.

## Dispositions

| Disposition | Meaning |
| --- | --- |
| `retain` | Inside its retention period, no hold. |
| `delete` | Past its retention period, no hold, still present. **These, and only these, are the records the plan proposes destroying.** |
| `hold` | Covered by an active hold. Expired or not, it is not for deletion. |
| `verified` | The inventory says it is already deleted and the supplied evidence accounts for it. |
| `unevidenced` | The inventory says it is already deleted and no evidence accounts for it. An error, never a pass. |
| `undecided` | Evidence was missing. Never a pass, always `incomplete`. |

`expired` and `held` stay separate fields on every row, and the summary counts
`expired` and `expiredAndHeld` separately, because the two are different facts
and a reviewer needs to see which one decided the outcome.

A policy violation does not make a row `undecided`. A record read by somebody
the class does not allow still has a known age and a known hold status; the
finding carries the violation, the run fails on its severity, and the row keeps
saying what should happen to the record.

## Hold coverage and evidence readability are load-bearing

- If **any** part of `holds.json` went unread — the file, an entry, or a
  reference inside one — the set of held records is unknown, and **nothing in
  the run is planned for deletion**. The hold nobody could read is exactly the
  hold that would have stopped a deletion.
- If **any** part of `evidence.json` went unread, every record the inventory
  calls deleted is `undecided` under `deletion-evidence-unknown`. It is **never**
  reported as `deletion-evidence-missing`: evidence that was supplied and could
  not be read is a different fact from evidence that was not supplied, and a
  reviewer told the second when the first happened stops looking for a file that
  is sitting right there.
- A duplicate evidence entry is narrower: it leaves ambiguous exactly the
  records it names, and does not make the rest of the document unread.

## Rule catalog

Severity comes from one frozen table in `src/rules.mjs`, and an unknown rule id
throws rather than being emitted. The severities below are the same table, and
`test/severity-table.test.mjs` asserts the two against each other in both
directions. That is not the test that defends them: `test/severity-exit.test.mjs`
drives a real input through the real binary for every rule here and pins the
process exit code, because three declarations can be edited together and an exit
code cannot be edited at all.

### Input and document

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable` | error | A document could not be reached or read. |
| `input-not-utf8` | error | A document is not valid UTF-8. The decoder decides; the decoded text never gets a vote. |
| `input-not-json` | error | A document is not valid JSON. The finding carries the position, line and column of the failure and never the text at it: V8 quotes the input back in its own parse message, and here the input may be somebody's private content. |
| `input-too-large` | error | A document is past `maxFileBytes` and was not read. |
| `path-escapes-root` | error | A document resolves outside `--root` and was refused unread. |
| `document-invalid` | error | A document is not an object, declares an unknown key, or its list is not an array. |
| `schema-version-unsupported` | error | A document declares a `schemaVersion` this build does not implement. |
| `policy-version-invalid` | error | `policy.json` declares no usable `version`, so the plan is unversioned. |

### Entries

| Rule | Severity | Meaning |
| --- | --- | --- |
| `identifier-invalid` | error | An entry has no usable id. |
| `record-invalid` | error | A record is not an object, declares an unknown key, a reader list that is not an array, or a private field that is not a bounded string. |
| `record-duplicate` | error | Two records declare the same id; neither is authoritative, so the second was refused. |
| `class-invalid` | error | A class is not an object, declares an unknown key, or omits `requiresEvidence`. |
| `class-duplicate` | error | Two classes declare the same id. |
| `hold-invalid` | error | A hold is not an object, declares an unknown key, or a coverage list that is not an array. |
| `hold-duplicate` | error | Two holds declare the same id. |
| `evidence-invalid` | error | An evidence entry is not an object, declares an unknown key, or names no verifier. |
| `date-invalid` | error | A date is not a `YYYY-MM-DD` calendar day that exists. |
| `basis-unsupported` | error | A class `basis` is outside the closed vocabulary. |
| `state-unsupported` | error | A record `state` is outside the closed vocabulary. |
| `hold-status-unsupported` | error | A hold `status` is outside the closed vocabulary. |
| `method-unsupported` | error | An evidence `method` is outside the closed vocabulary. |
| `retention-invalid` | error | `retainDays` is not an integer between 0 and 36500. It is refused rather than clamped. |
| `record-reference-invalid` | error | A member of a hold's `records`, or an evidence `record`, is not a usable id. |
| `record-reference-duplicate` | warning | A record is named twice in one list; the repeat was dropped. |
| `class-reference-invalid` | error | A record's `class`, or a member of a hold's `classes`, is not a usable id. |
| `class-reference-duplicate` | warning | A class is named twice in one list; the repeat was dropped. |
| `reader-invalid` | error | A member of a `readers` or `allowedReaders` list is not a usable id. |
| `reader-duplicate` | warning | A reader is named twice in one list; the repeat was dropped. |

### The audit

| Rule | Severity | Meaning |
| --- | --- | --- |
| `class-unknown` | error | A record names a class the policy does not declare, so how long it may be kept, who may read it and whether its deletion needs evidence are all unknown. |
| `access-not-permitted` | error | A record was read by somebody its class does not allow. |
| `deletion-evidence-missing` | error | The inventory says a record was deleted, its class requires evidence, and the evidence document accounts for no such deletion. |
| `deletion-evidence-unknown` | error | The inventory says a record was deleted and the evidence document could not be read in full, so whether it is accounted for is unknown. Not the same as missing, and never reported as missing. |
| `deletion-evidence-duplicate` | error | Two evidence entries claim one record. Ambiguous rather than cumulative; neither is used. |
| `deletion-evidence-unknown-record` | error | Evidence claims a record the inventory does not list. |
| `deletion-evidence-unreadable-record` | error | Evidence claims a record and the inventory was read only in part, so whether it lists that record is unknown. Not the same fact as the inventory not listing it, and never reported as that one. |
| `deletion-evidence-contradicts-state` | error | Evidence says a record was deleted and the inventory says it is retained. One document is wrong and this tool cannot tell which. |
| `deletion-under-hold` | error | The inventory says a record was deleted while a hold over it was active. |
| `hold-coverage-unknown` | error | Part of the hold document went unread, so nothing in the run was planned for deletion. |
| `hold-record-unknown` | error | A hold covers a record the inventory does not list: either the inventory is missing a record under hold or the hold is stale. |
| `hold-record-unreadable` | error | A hold covers a record and the inventory was read only in part, so whether it lists that record is unknown. Not the same fact as the inventory not listing it, and never reported as that one. |
| `hold-class-unknown` | error | A hold covers a class the policy does not declare. |
| `hold-class-unreadable` | error | A hold covers a class and the policy was read only in part, so whether it declares that class is unknown. Not the same fact as the policy not declaring it, and never reported as that one. |
| `hold-coverage-unreadable` | error | A hold names references and every one of them was refused, so what it protects is unknown. Not the same as naming nothing, and never reported as naming nothing. |
| `hold-covers-nothing` | warning | A hold names no record and no class. |

### Bounds and vacuity

| Rule | Severity | Meaning |
| --- | --- | --- |
| `too-many-records` | error | The inventory declares more records than `maxRecords`; nothing was compiled from it. |
| `too-many-classes` | error | The policy declares more classes than `maxClasses`. |
| `too-many-holds` | error | The hold document declares more holds than `maxHolds`. |
| `too-many-evidence-entries` | error | The evidence document declares more entries than `maxEvidenceEntries`. |
| `too-many-record-references` | error | One hold names more records than `maxRecordReferences`. |
| `too-many-class-references` | error | One hold names more classes than `maxClassReferences`. |
| `too-many-readers` | error | One record or class names more readers than `maxReaders`. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`; the report is partial and says so. |
| `time-budget-exceeded` | error | The audit passed `maxRuntimeMs`. Every disposition is withdrawn and the deletion plan is emptied rather than left partial. |
| `no-records-audited` | error | Four documents compiled and no record was left to audit, so the run has no evidence to be green on. |

## Limits

| Limit | Default | Cap | Flag |
| --- | ---: | ---: | --- |
| `maxFileBytes` | 5242880 | 67108864 | `--max-file-bytes` |
| `maxRecords` | 5000 | 200000 | `--max-records` |
| `maxClasses` | 200 | 5000 | `--max-classes` |
| `maxHolds` | 500 | 5000 | `--max-holds` |
| `maxEvidenceEntries` | 5000 | 200000 | `--max-evidence-entries` |
| `maxRecordReferences` | 500 | 5000 | `--max-record-references` |
| `maxClassReferences` | 200 | 2000 | `--max-class-references` |
| `maxReaders` | 64 | 1024 | `--max-readers` |
| `maxRuntimeMs` | 10000 | 600000 | `--max-runtime-ms` |
| `maxFindings` | 1000 | 20000 | `--max-findings` |

A caller may lower a limit and never raise it past its cap. An unknown limit key
is refused rather than ignored. Exceeding a limit is never a silent truncation:
it produces a finding naming the limit and marks the run `incomplete`, because
the plan that came out of a partial walk would be a list of things to destroy
chosen by where the walk stopped.

There is no recursion limit because the input has no recursive shape: the
deepest structure read is an array of objects holding arrays of strings.

## Status, exit codes and ordering

| Status | Exit | Meaning |
| --- | ---: | --- |
| `pass` | 0 | Every record was audited and no error-severity rule fired. |
| `fail` | 1 | Every record was audited and at least one error-severity rule fired — including a declared deletion with no evidence for it. |
| `incomplete` | 2 | Evidence was missing, refused, truncated or undecided. Never interchangeable with `pass`. |

A configuration error — an unknown option, a missing `--root` or `--today`, a
refused `--out` — exits 2 with an **empty stdout**, because a run that never had
a subject has nothing to report about. An input that could not be read exits 2
with an `incomplete` report on stdout, because the run had a subject and failed
to obtain evidence about it, and a consumer needs to know which document that
was.

Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then
`message`. Plan rows sort by record id; the deletion list and every list inside
a row sort by their own values. Every comparison is by UTF-16 code unit.
`localeCompare` and `Intl.Collator` appear nowhere in this package: both consult
ICU data that differs between Node builds, so two correct machines would
disagree about the same output — and about the order of a list of records to
destroy.

No wall clock reaches the report. The only clock is the injected monotonic one
the time budget uses — `performance.now()` unless a caller supplies its own —
and the only thing it can put in the output is `time-budget-exceeded`, which
withdraws every disposition rather than reporting a reading. That is why two
runs over the same inventory and the same `--today` produce byte-identical
stdout.

## Writing the plan

`--out` writes the versioned deletion plan. It is checked before anything is
read and long before anything is written:

- a destination that **is a symbolic link** is refused on sight, because
  `realpath` would resolve it and resolving is the dangerous act;
- a destination whose **parent resolves outside `--out-root`** (default: the
  current working directory) is refused, because a lexical prefix check passes
  for `root/link/out`;
- a destination that is the **same file as one of the four inputs** — including
  through a hard link, which shares no path with it and resolves to nothing — is
  refused, because only device plus inode can see that, and a plan written over
  the inventory or the evidence destroys exactly what the plan is about.

A refused destination is a configuration error: stdout stays empty and the exit
code is 2. The plan is written before the report reaches stdout, so a write that
fails also leaves stdout empty rather than reporting success for an artefact
nobody has.

## What this tool cannot tell you

- **Whether a record the inventory calls deleted is actually gone.** No store is
  inspected. A `verified` row means somebody signed evidence saying so.
- **Whether the inventory is complete.** A memory the export did not list is a
  memory this tool never saw. A hold naming a record that is not listed is
  reported for exactly that reason.
- **Whether a reader should have had access.** The policy's `allowedReaders` is
  the only standard applied, and the tool has no idea whether that list is right.
- **Whether a deletion plan may be executed.** It is a proposal. Nothing here
  checks a backup, a replica, an index or a downstream copy, and nothing here
  can act on the plan.
- **Anything about what the records contain.** Private content is read for shape
  and length and never for meaning.

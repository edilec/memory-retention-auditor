# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Rule ids are
part of the public surface: renaming one is a breaking change and is recorded
here.

## [Unreleased]

### Added

- First implementation of `memory-retention-auditor`: reads a memory and
  session inventory, the retention and access policy it answers to, the holds
  over it and the deletion evidence supplied for it, and reports what should
  happen next. It deletes nothing; the plan is a proposal nothing in this
  package can act on.
- Expired and held kept as separate facts. Both are fields on every plan row,
  both have their own summary count, and an active hold decides the disposition
  whatever the retention period says -- a held record is never in the deletion
  plan, however old it is, and is never reported as simply "retained" either,
  because the reason it survives is the hold.
- Hold coverage treated as load-bearing. If any part of the hold document went
  unread -- the file, an entry, or a reference inside one -- the set of held
  records is unknown and nothing at all in the run is planned for deletion.
- Evidence that was supplied and could not be read separated from evidence that
  was not supplied. They are different facts with different rule ids and
  different exit codes (`deletion-evidence-unknown`, exit 2, against
  `deletion-evidence-missing`, exit 1), because a reviewer told the second when
  the first happened stops looking for a file that is sitting right there.
- Private content read for shape and length and never for meaning. A record's
  `subject`, `preview` and `note`, and every `description`, never reach stdout,
  stderr or the plan document; a row says which private fields a record declares
  and nothing about what they hold.
- The evaluation date as a required input. There is no `Date.now()` and no
  `new Date()` in the package: `--today` is parsed like every other date and
  stamped on the plan, so two runs over one inventory produce the same bytes and
  a plan always says which day produced it. Dates are read in one spelling only,
  with the calendar round trip checked, so `2026-02-30` is refused rather than
  rolled into March.
- A versioned plan: the policy revision, the evaluation date and a SHA-256
  digest over the plan body, computed with no clock, host or run id.
- A 50-rule catalog with one frozen `ruleId -> severity` table, documented in
  `docs/retention-rules.md` and pinned behaviourally: every error rule is driven
  through the real binary and asserted by process exit code, and every warning
  rule is asserted to exit 0, so neither direction can drift.
- Enforced limits on bytes, records, classes, holds, evidence entries,
  references per hold, readers, findings and runtime, each reported by name when
  reached and each making the run `incomplete`. The time budget is re-checked
  *after* the row loop returns, and when it has been passed every disposition is
  withdrawn and the deletion plan is emptied rather than left partial.
- A CLI with `--help`, `--json`, explicit input paths, `--out`/`--out-root` for
  the plan document, and the three documented exit codes; the JSON report on
  stdout alone.
- Examples for a clean inventory, one where an expired record is under hold, one
  with a deletion nothing accounts for, and one that cannot be decided.

### Security

- Read-only over its inputs, and proved so: a byte-for-byte snapshot of the
  input tree around runs that pass, fail, report incomplete, and propose
  destroying every record in the inventory, plus a source read that names every
  file-system import and asserts the package's only writing verb is the guarded
  destination write.
- The `--out` destination is checked before anything is read and long before
  anything is written, against all three independent holes: a symbolic link at
  the destination (refused on sight with `lstat`, because `realpath` would
  resolve it and resolving is the dangerous act), a parent that resolves outside
  `--out-root`, and a destination that is the same file as any of the four
  inputs through a hard link, which shares no path with them and resolves to
  nothing -- a plan written over the inventory or the evidence would destroy
  exactly what the plan is about. The input set passed to the guard is every
  file the run may open, not only the primary one, and the allowed cases are
  pinned too, because a guard that refuses everything passes every data-loss
  test while making the tool useless.
- No network access of any kind. Proved by a module-resolution guard that
  refuses every network builtin, with a control run proving the guard fires, and
  by a live loopback listener whose address is planted inside a memory preview
  and never contacted -- input content is data, and a memory that contains an
  instruction is still a memory.
- No account, credential or environment surface is read at all: the package
  imports `node:crypto`, `node:fs/promises`, `node:path`, `node:perf_hooks` and
  `node:process`, and nothing else.
- Path confinement resolves the real path of both the root and each input, so a
  symlink planted inside the root is refused while a legitimate file under a
  symlinked root is not.
- Strict UTF-8 decoding on every input, with no inference drawn from decoded
  text.
- Control (C0), DEL, C1, line and paragraph separator and bidi characters are
  stripped from every untrusted string that reaches output -- identifiers,
  readers, pointers and messages alike -- and the human summary is pinned to an
  exact line count so a newline arriving through a record id cannot forge a
  line. A value the tool refuses is described rather than reproduced, and an
  unknown key is counted rather than named, because in a memory inventory a key
  name can be private before any value is.
- A parse failure does not quote the file it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, and here the
  quoted text may be somebody's private content. The helper recognises the
  quoting shape *before* looking for a position -- a document whose own text
  reads `at position 1` is answered by V8 with that text inside the quoted span,
  and a position-first helper slices the document back out -- matches across a
  line break, and discards any detail still carrying a double quote.
- Ordering is by UTF-16 code unit everywhere and pinned by the emitted sequence
  rather than by a source scan. It decides the order of the deletion plan
  itself, so two machines disagreeing about it would be two reviewers approving
  two different documents.

No release has been published.

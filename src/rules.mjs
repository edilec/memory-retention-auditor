/**
 * The one frozen `ruleId -> severity` table.
 *
 * Severity decides whether a run passes or fails, so it is written here once
 * and read from here everywhere: every finding takes its severity from this
 * table, an unknown rule id throws rather than defaulting, and a plan row asks
 * this table whether the rules that fired against it were errors.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog in `docs/retention-rules.md` in both directions. That is worth having
 * and it is *not* the guarantee: a table, a catalog and a test's expected map
 * are three declarations, and one edit that changes all three leaves every
 * assertion comparing them satisfied. `test/severity-exit.test.mjs` drives a
 * real input through the real binary for every rule here and pins the process
 * exit code. An exit code cannot be edited.
 *
 * Four rules sit below `error`. Three are repeated references, which are
 * deduplicated and change nothing; the fourth is a hold that covers no record
 * in this inventory, which is worth a reader's attention and is not a reason to
 * destroy anything.
 */
export const RULE_SEVERITY = Object.freeze({
  'access-not-permitted': 'error',
  'basis-unsupported': 'error',
  'class-duplicate': 'error',
  'class-invalid': 'error',
  'class-reference-duplicate': 'warning',
  'class-reference-invalid': 'error',
  'class-unknown': 'error',
  'date-invalid': 'error',
  'deletion-evidence-contradicts-state': 'error',
  'deletion-evidence-duplicate': 'error',
  'deletion-evidence-missing': 'error',
  'deletion-evidence-unknown': 'error',
  'deletion-evidence-unknown-record': 'error',
  'deletion-under-hold': 'error',
  'document-invalid': 'error',
  'evidence-invalid': 'error',
  'hold-class-unknown': 'error',
  'hold-coverage-unknown': 'error',
  'hold-coverage-unreadable': 'error',
  'hold-covers-nothing': 'warning',
  'hold-duplicate': 'error',
  'hold-invalid': 'error',
  'hold-record-unknown': 'error',
  'hold-status-unsupported': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'method-unsupported': 'error',
  'no-records-audited': 'error',
  'path-escapes-root': 'error',
  'policy-version-invalid': 'error',
  'reader-duplicate': 'warning',
  'reader-invalid': 'error',
  'record-duplicate': 'error',
  'record-invalid': 'error',
  'record-reference-duplicate': 'warning',
  'record-reference-invalid': 'error',
  'retention-invalid': 'error',
  'schema-version-unsupported': 'error',
  'state-unsupported': 'error',
  'time-budget-exceeded': 'error',
  'too-many-class-references': 'error',
  'too-many-classes': 'error',
  'too-many-evidence-entries': 'error',
  'too-many-findings': 'error',
  'too-many-holds': 'error',
  'too-many-readers': 'error',
  'too-many-record-references': 'error',
  'too-many-records': 'error',
})

/** The severity of one rule. An id that is not in the table throws rather than defaulting. */
export function severityOf(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/retention-rules.md.`)
  }
  return severity
}

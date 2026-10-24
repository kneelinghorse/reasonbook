# Owner-copy observations and actionable remedies

Before product or matching test edits, `before.json` captured the census at
`3a922325`. Reproduce its predicates with `python3 tests/sweeps/s101-m03/census.py`.
The universe is every tracked valid UTF-8 file without NUL, across all extensions;
each predicate counts matching physical lines, not occurrences. It inspected 7,748
files. Line hashes preserve locations without copying historical project records.

- O1 explicit SQL: 84 lines (three source, nine tests, 72 historical record lines).
- O1 observation column names: 755 lines (29 source, 44 tests, 682 historical).
- R1 remedy words: 3,022 lines (68 source, 121 tests, 2,792 historical and 41 other
  documentation/reference lines).

The plan's narrower TypeScript string-expression predicate,
`node rbook/research/2026-10-s101-probes/predicates/remedy-all.cjs .`, returned 47
expressions across 438 tracked source TypeScript files. Its full pre-edit output is
`remedies-before.txt` (trailing whitespace removed for Git hygiene). This includes a
dynamic-import string, so it is a candidate
count, not a count of wrong remedies.

Change the observation reads in `record-owner-copies.ts` and `record-set-aside.ts`:
recognize file-join calls while preserving old stores, NULL observations and dashboard
route exclusions. Change the owner-copy share remedy in `record-dashboard-share-state.ts`
and its confirmed-path capability lookup in `record-dashboard-share.ts`. Change the
hosted set-aside refusal and the CLI's preview warning. The reader gate's fresh join
request remedy is also in scope, although its original text does not match R1.

Update the existing observation fixtures to clear call evidence only when isolating
route/exchange or failed write-query evidence. Update two offline wire-refusal
assertions to require conditional compatibility guidance. The reattachment noncut
guard now starts with a valid hosted fixture and removes the cut from its authenticated
hello response, preserving the identity and unchanged-store assertions.

Retain the protocol activation rule, already repaired in m02, and the referee's own
last-call query. Retain `referee/handover.ts` because that implementation requires
4.5.0 or later; `referee/recovery.ts` remains dormant until the hosted recovery route
exists. `member-answer.ts` and `record-protocol-review.ts` were repaired in m02.
`record-membership.ts` names the existing member-management control. Other matched
state descriptions, valid actions, imports, historical records and unrelated tests
are retained. This mission does not deploy the dashboard's missing set-aside control.

The lexical census misses computed SQL, aliases, alternate wording and multiline
phrases. In particular, the existing protocol activation reader uses `SELECT *` and
is found by the broader observation predicate. Neither lexical predicate proves a
message is actionable: real-store joins, old-schema/NULL/table-order fixtures,
loopback referee versions and dispatch tests supply the behavioral evidence. No new
cross-process locking behavior is introduced; observations use existing transactions.

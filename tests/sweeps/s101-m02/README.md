# Protocol activity, admission and delivery census

Run `node tests/sweeps/s101-m02/census.js`. The pre-edit receipt was captured at
`9fe9f6db387af0ebdd07f57864c5c9a427737a83` before matching production edits.

Two predicates have different counting rules:

- Across all 7,717 tracked UTF-8 files without NUL, the listed function names followed
  by `(` occur on 740 lines: 83 in source, 183 in tests and 474 in the record. Each
  matching line counts once, across every extension. Definitions, examples and old
  receipts are candidates too.
- The ratified TypeScript AST call predicate finds 59 call sites in 437 tracked source
  TypeScript files. Unlike the line predicate, it excludes definitions and counts
  `changesSince` only when a recipient argument is present.

## Changes and deliberate retentions

Eight of those 59 call sites change: both review calls (switch and blockers), the
readmit write, the readable filter inside changesSince, and the recipient-aware
changesSince calls in wire, local exchange, referee peer and bundle-out. The activity
rule's definition and member-answer's code classification also change; neither is
a matching call site. The ratified build plan's accounting is authoritative: eight
calls plus two definitions/classifications, leaving 51 calls. The earlier probe's
"change 10 / leave 49" mixed calls with definitions and is not this predicate's
arithmetic.

Retain all six reportedCopy calls and all six rememberCopyReport calls; existing
admission gates in join, successor and handover; protocol switch derivation and
write selection; recovery's latestReplicas; keptOut on apply and bundle-in; outbound
client-to-referee filtering; writes that admit no replica; and ownersOtherCopies,
which belongs to m03. Tests and historical record hits stay unless their contract
assertions must change. New notice helpers and tests may add candidates.

The wider census and immediate-caller review found two additional affected paths.
The epoch catch-up in `record-exchange-steps.ts` calls a Peer method with two
arguments, so the AST predicate's three-argument cutoff misses it. It now reports
withholding just like the ordinary exchange; its regression restores an older
authority epoch to prove that branch executes. Removal in `record-membership.ts`
had deleted factual reader and call reports, so re-admission could lose its blocker
on the following write. Removal now clears only the route, and counted member
history preserves activity for stores whose older removals already erased reports.
Neither change alters the original 59-call classification. The review formatter
also explains an oversized stranded list, as it already did for blockers.

Recovery tests then exposed a required caller adjustment: a removed member that
missed an authority move could sync after upgrading, but `boundHello` discarded its
historical reader report and re-invitation stayed blocked. A narrowly reportable
historical removal now saves factual capacity through local and SSH hello callers.
It grants no data delivery, membership or move-arrival claim, and excludes unseen,
permanently set-aside and recovery-dropped copies. The shared hello binder is outside
the named predicates; direct and SSH boundary tests cover this necessary remedy.

The tracked post-edit receipt has 791 matching lines across 7,730 UTF-8 files:
82 source, 235 tests and 474 record lines. Its AST count is 58 across 438 source
TypeScript files: the original 59, minus three array-only egress calls replaced by
report calls, plus the active-copy and reader-refusal calls in re-admission. These
are candidate counts, not remaining defects; the fixed name list deliberately does
not count the new `changesSinceReport` and `writeBundleReport` helpers. Their callers
are reviewed in the diff and transport tests. The receipt was rerun after tracking
its own file until its counts stabilized.

## False-negative profile

The whole-tree lexical predicate misses aliases, computed names and calls split
between a name and its opening parenthesis. It does not prove equivalent effects
absent. The AST predicate is restricted to tracked source TypeScript and the named
functions; it misses aliases and other languages. Its recipient-argument arity rule
misses two-argument Peer methods and does not prove a recipient is actually passed
at runtime. Observation deletion and review formatting are outside both name lists;
their effects require caller review and behavioral tests. The broader lexical census
exposes definitions, tests, scripts and documentation without pretending their
counts are the same as executable calls. Immediate callers and all four transports
are reviewed separately. Files not yet tracked are outside both predicates; rerun
after tracking new files for the final receipt.

## Full-suite child cleanup repair

The approved-contract full run exposed a five-minute cleanup hang: stopping a
signal-terminated child twice waited for an exit event that had already happened.
Before editing either matching helper, the predicate now saved as
`node tests/sweeps/s101-m02/child-exit-census.js` counted five candidate lines in
7,727 tracked UTF-8 files at `60d964049819ebe87a6f1e5ef213ab111e224292`.
`child-exit-before.json` preserves that original receipt and timestamp.

Change the completion checks in `tests/helpers/referee-http.ts` and
`tests/plugin/installing-server.test.ts` to recognize signal termination too; the
plugin's adjacent kill guard must also avoid signaling an already exited child.
Retain the checks in `migrate-ownership.test.ts` and `spin-out-process.test.ts`,
which already recognize both exit kinds. Retain the plugin response poll: it is
not cleanup and already has a 30-second deadline. The regression exercises repeated
helper cleanup after both normal exit and signal termination.

This is a lexical candidate census, not a proof about every child lifecycle. It
misses aliases, computed properties, equality-to-null checks, reversed operands and
comparisons split across lines. Binary, invalid UTF-8 and untracked files are out of
scope. The adjacent equality check was found by reading the candidate's cleanup
block. Historical receipts and prose count when they match; they are not executable
defects.

# First-hour pre-edit census

Run `node tests/sweeps/s101-m04/census.js`. It derives its universe from `git ls-files -z`
across **all extensions**, decoding UTF-8 and skipping binary/non-UTF-8 files. Each matching
line counts once per class. `before.json` was captured before any matching production or seed
edit, at the recorded HEAD and measuredAt. New failing tests were already present. Shipped candidates are enumerated; historical and test
witnesses are aggregated by top-level directory so this public receipt does not duplicate local
project history. The predicate still scans that history and counts every matching line.

| Exact predicate (JavaScript regular expression in census.js)          | Whole tracked tree | src/ plus rbook-seed/ |
| --------------------------------------------------------------------- | -----------------: | --------------------: |
| `Context \+ Mission\|show by ID\|context search`                      |                295 |                     5 |
| name/name-null/id candidate predicate in census.js                    |                265 |                    13 |
| single-line literal `throw new Error(...)` containing `shared record` |                  7 |                     7 |

## Changed and deliberately retained sites

Rename residue: change all five shipped hits: the four seed files and digest-v2.ts's footer.
Retain 282 historical/planning/local-record witnesses under rbook/ and eight test witnesses,
updating affected assertions as needed. No other tracked subtree contains a hit. The four seed
docs also lose the stale copy-seed and No Python CLI instructions, checked by a dedicated test.

Name candidates: change the review portfolio fallback in rbook-review.ts. Fix the readable
signals/brief names upstream in read-signals.ts, covering cli/signals.ts:55 and
signals/brief-text.ts:28 without rewriting those renderers. Onboarding and the local digest have
nonmatching weak fallbacks; explicitly include rbook-agent-onboard.ts and digest-v2-store.ts.
The protected identity guard hit is changed by this mission's separately required string guard.
Retain unreadable-report candidates (cli/brief.ts:42, read-signals.ts:259 and brief-text.ts:110/113)
for m09, which expands unreadableReport. Retain project-identity.ts:427 (registration slug; m10),
rbook-feedback.ts:362 (resolution receipt outside the four named display surfaces),
record-changes.ts:388 and wire-descriptions.ts:61/289 (author/schema values, not project display).
The other 252 hits are historical text and test fixtures; retain or adjust affected assertions.

Unshared refusal candidates: change record-context.ts:47, the common missing-identity boundary
reached by CLI set-aside, sync and move. Add the answered wrapper in cli/sync.ts. Retain the six
change-log/import/re-identification/sequence/project-id invariant throws in record-changes.ts,
record-import-apply.ts, record-import-plan.ts, replica-check.ts and replica-identity.ts; those
invariants are outside the three named first-hour routes. MCP already exposes guarded sync/move;
it has no set-aside action, so cover the existing actions without expanding tools/list.

## False-negative profile

These are lexical candidate censuses, not semantic proofs. Rename spellings and aliases other
than the three stated strings are not enumerated. The name predicate misses multiline expressions,
indirect helpers and non-nullish fallback forms; the four named surface paths are additionally
read and exercised with real NULL/empty-name stores. Unreadable stores remain m09's explicit
complement. The refusal predicate misses multiline/interpolated/differently worded errors, so
real unshared-store CLI and MCP tests establish the named routes' behavior. Historical documents
and tests count in the whole-tree census but are not treated as shipped user text. Untracked
files and invalid UTF-8 are outside the predicate; new mission files are tracked before closure.

## Post-edit witness

`after.json` was measured after the new source, tests and census files were staged, before
this post-edit receipt and paragraph were added. The same matching-line predicate gives
298/0 rename candidates, 282/13 name candidates, and 13/6 generic unshared errors
(whole tracked tree / src plus rbook-seed). The whole-tree totals include newly tracked
regression witnesses and this census, so they are not a fixed-universe defect count.

All five shipped rename candidates are gone. The thirteen remaining name candidates are
the retained sites classified above, plus read-signals.ts's new context-name reader (a
lexical false positive). The CLI and brief renderer candidates now receive a non-empty
name for readable stores; the identity guard remains a lexical hit while rejecting invalid
values. The removed review fallback and added context reader leave the lexical count
unchanged. The six internal unshared invariants remain deliberately unchanged; the named
CLI and MCP routes now return the guarded refusal. No additional production candidate is
left unclassified by this receipt.

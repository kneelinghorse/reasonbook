# s101-m01 pre-edit upload class evidence

Captured at the SHA in `text-before.json`, before matching production edits. Reproduce U1 and
status410 with `node tests/sweeps/s101-m01/sweep.cjs . upload` (or `status410`). The inherited
AST predicate covers tracked TypeScript source: 31 upload/exit sites and 10 fetch sites. It
misses aliased starters, generated code, non-TypeScript code and dynamic calls. The independent
whole-tracked-tree physical-line predicates in `text-before.json` retain their literal regexes
and every match, including documentation and tests; their source subset is listed separately.
Replay those counts with `node tests/sweeps/s101-m01/text-sweep.cjs . d429a4b4`; omit the
revision for the current tracked tree, or append `--detail` to print every matched line.
U4 is one silent claim return; U5's production reader is the scheduler (two matching lines),
while state implementation and tests are witnesses rather than independent status readers.

Changed: the four detached upload starters, runtime shutdown paths, checkpoint inner upload,
manual backfill, API-key token resets (U2, three of four source sites), upload/registration
401-or-403 handling (U3, two of three), the silent claim return (U4), and scheduler outcome
rendering (U5). Password login keeps its token reset and authentication handling. Pre-start
and CLI exits remain because they have no accepted upload. The two production
resolveAndPersistOwner callers are checkpoint registration and sender identity; both receive
the stored-ID-only reconcile. HTTP 410 classification changes the whole-store upload and
registration paths; other fetch paths, especially message-route 410 responses, keep their
existing meaning. New classifiers and runtime tests verify effects beyond these predicates.

This artifact is pre-edit evidence, not one of the historical ledgers certified by
scripts/class-sweeps.js. Whole-tree text matches include prose and test assertions; they are
not counts of defects. The AST surface and its complement are stated above.

## Full-suite HTTP mapping repair

Before the repair, at `3f9135610711c87b6c1dc901ecc571fd30a052d7`, the runnable predicate
`rg -n 'dashboardHttpError\(' src` returns four physical lines: one declaration and three
calls (generic request, SQLite upload, registration). The generic call incorrectly applies
upload-only authorization/deletion classification to message routes. The repair makes the
classification explicit at all three callers: owner listing, SQLite upload and registration
use upload evidence; other generic routes preserve their earlier HTTP 403 and 410 meanings.
The declaration and all three calls change; none is deliberately left with an implicit mode.
This literal whole-source scan covers every tracked extension under `src/`, but does not
resolve aliases, dynamically generated calls or external consumers. The loopback message
410 test includes a `PROJECT_DELETED` body to check the forbidden effect across route boundaries.

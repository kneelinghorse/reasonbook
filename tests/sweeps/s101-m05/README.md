# Front-door naming and documentation census

Run `node tests/sweeps/s101-m05/census.js`. Before matching edits, at
`ef51a386363c9f5e8e927d3d80127d71807b0474`, it inspected 7,730 tracked UTF-8 files
across every extension. `before.json` preserves the time, regexes, counts by top-level
scope, and line locations in the repair surfaces. Each pattern counts matching
physical lines, not occurrences; overlapping patterns are not added together.

The combined naming predicate returned 2,865 lines: 11 source, 264 test, 8 script,
2 changelog, 1 generated reference and 2,579 historical record lines. Change the nine
source comment lines mentioning Stage1 or OODS, both copies of the sprint tool's
example address, and all 16 test lines matching `parts.?town` case-insensitively.
The latter includes five display-name lines and their slugs, addresses and comments;
the plan's eight-line estimate is superseded by this measured scope. Update the
tool snapshot and generated reference through their normal commands. The snapshot already
uses the neutral wire override, so its measured delta is zero; the two long-form
description literals each shrink by three characters.

Retain the other test fixtures, including the 174 Stage1 lines and 26 OODS lines
(separate predicates; overlap is possible), and the dashboard-address fixtures
outside the tool snapshot. Broader fixture renaming is a next step. Historical
records, changelog history and operational scripts retain their names; this repair
does not rewrite provenance or deployment destinations.

The broad documentation predicate returned 15,539 candidate lines. It intentionally
includes every recovery/deletion mention and upload-switch reference, not just false
claims. Review the candidates in README, getting-started, privacy and trust against
the client and deployed dashboard. Change obsolete deletion, version-gated re-invite,
upload-control and recovery-upload statements; retain correct disclosure. Code,
tests, historical records and unrelated documents are deliberately outside this
prose repair. New first-ten-minutes and launch copy must agree with those disclosures.

## False-negative profile

These lexical patterns miss aliases, alternate spellings, split-line phrases and
equivalent claims without these words. They do not prove privacy policy correctness
or that a deployment matches source. That needs the live deployment receipt and
code inspection, followed by the fresh docs-truth review. The tool-example pattern
does not cover other addresses. Binary, invalid UTF-8 and untracked files are excluded;
new files are tracked before the final census. Historical receipts and this census
count when they match. Only named repair surfaces retain individual line locations;
the counts cover the whole tracked tree.

## Integrated result

`after.json` repeats the same whole-tree predicates after tracking the new guide and
census files. The named source repair surface has zero remaining combined-name
matches; the four changed fixture files have zero remaining `parts.?town` matches.
Whole-tree totals also include this census and historical evidence; they are not a
count of remaining product defects. Next step 793 holds the deliberately retained
fixture work.

The fresh docs-truth critic returned READY after inspecting the client and deployed
dashboard source. The one wording correction distinguishes the bare CLI's terminal
hint from full help. The public README, plugin README, getting-started and new guide
were rendered in a 1280×720 browser preview. Two separate README observations showed
different GIF frames without reloading; the existing asset has 375 frames totalling
75,000 ms. At 480 px wide, the README shows its purpose, preview, Try it and commit
instruction together. The MP4 link remains the existing recorded demo.

The link check counted 123 Markdown link/image tokens across README, CHANGELOG, the
six edited documentation/plugin pages and the two existing launch/listing drafts.
It checked target files and heading fragments, mapping public repository main URLs
to this checkout. Other external URLs and raw HTML attributes are outside that
static check; the three HTML GIF embeds were rendered in the browser. The new
guide's public URLs remain a release prerequisite (next step 794), and its npm and
plugin installation walks belong to the release and rehearsal missions. No new
live installation or 4.5.1 demo recording is claimed here.

## Sealed-source follow-up

The first full-suite attempt at `9378d6fe` found two failures in the private retrieval
evidence suite: neutralizing a comment changed one of the current parser's exact
source hashes. The run was interrupted after about 35 minutes; it produced no
aggregate JSON and is not a complete suite witness. Its first timestamp was
2026-10-23T14:46:48.533Z and its last log write was 15:21:36.424Z; the latter is a log
endpoint, not a measured process-exit time.

Before changing the review references, `retrieval-review-before.json` captured the
whole tracked UTF-8 predicate `/labels-v6-review|currentParserReview/`: 7,735 files,
70 matching physical lines across 40 files. Change the 16 active V6 path lines in
six files; inspect and retain 10 generic bindings and 44 historical references.
Exactly one of the nine edited source-comment files overlaps the ten distinct
sealed parser, evaluator and generator sources: `decision-citations.ts`.

Generate a new current review from the frozen corpus with the unchanged generator,
require identical label bytes, and keep the earlier V5/V6 files intact. Retain V6's
manifest and labels in the sealed evidence inventory. Do not normalize comments,
relax exact current-source checks, change labels, or rewrite historical seals.

This reference predicate misses computed paths, aliases and different spellings;
it locates literal bindings, not every possible runtime dependency. The independent
source-hash inventory and real candidate gate cover the actual loaded dependencies.

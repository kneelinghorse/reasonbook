# Refusals that teach the wrong fix (s106-m02)

Run `node tests/sweeps/s106-m02/census.js`. `before.json` is its output at `56577fb9`, with `src/`
matching that commit, written and committed (`647273f8`) before any matching edit; `after.json` is
the same census at the repair commit. The class, from the sprint-106 design
(`rbook/planning/s106-the-measured-surface-build.md`, mission s106-m02): a refusal whose suggestion,
followed literally, produces a second refusal. Line numbers below are `before.json`'s unless marked.

## Universe

- **P0, the design's predicate.** `git grep -nE 'suggestion[[:space:]]*(:|=)' -- src` returns 554
  physical lines, the count the design took at `f256c4b9`. 547 contain `suggestion:`. The other 7
  are not property assignments: four read or forward another error's suggestion (`index.ts:882`,
  `rbook-auth.ts:1267`, `record-dashboard-recovery.ts:156`, `record-wire.ts:368`), two are locals
  holding a site's own text (`rbook-mission-reopen.ts:133`, `record-dashboard-recovery-moves.ts:165`),
  and `errors.ts:316` assigns `invalidParameter`'s remedy.
- **AST partition**, over `git ls-files -- 'src/*.ts'` without `.d.ts` (458 files). The 547 lines are
  529 `suggestion` property assignments and 18 type declarations; there is no shorthand property.
  Of the 529, 2 forward another error's suggestion and 527 are authored:
  - 487 sit in a literal with a `code` property of its own (refusal-shaped). Of those, 74 carry an
    executable `rbook_*(` prescription and 413 are prose; two prose sites are inside the factories.
    A site whose text sits in a local is classified by its property's initializer:
    `rbook-mission-reopen.ts:141` reads the local at `:133`, which holds prescriptions, and is
    counted as prose.
  - **40 have no `code` property of their own, and this census does not examine them.** They include
    refusals built by spreading another error (`rbook-db-backfill.ts:517`, `:599`,
    `tool-validation.ts:55`, `member-answer.ts:57`, `sprint-summary-read.ts:45`,
    `record-readmit.ts:128`, `record-dashboard-share-state.ts:147`), with a shorthand `code`
    (`errors.ts:382`, `rbook-mission-reopen.ts:50`), or through a helper (`refused()` in
    `record-dashboard-move.ts`, `refusal()` in `record-dashboard-peer.ts` and
    `record-dashboard-share.ts`). Five carry `rbook_*(` prescriptions
    (`record-dashboard-peer.ts:90`, `:185`, `:194`, `:201`; `record-dashboard-share.ts:269`).
- **Factories.** `missingParameter`, `invalidParameter` and `invalidAction` serve 103 call sites
  (62, 29 and 12), the design's count. Their remedies are the two suggestions inside them and
  `errors.ts:316`, so each call site is classified by its own trigger.

## Classification

Counting rule: a site is in the class when following its suggestion exactly as written, from the
trigger that fires it, is refused again for a reason the refusal did not state. A conditional member
is refused again only when the call also lacks something the refusal did not name.

### The 103 factory call sites, by trigger

Each `missingParameter` site belongs to the first row that fits, in this order.

| Trigger                                                                                                                                                                                                                                                                                                    | Sites | In the class                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content` missing while `fromDraft` is set (`rbook-decisions-record.ts:151`)                                                                                                                                                                                                                               | 1     | Yes: any content that does not state the draft is refused again (#870's second link)                                                                                                         |
| `missionId` missing on `rbook_mission add` (`rbook-mission-add.ts:252`)                                                                                                                                                                                                                                    | 1     | No: the remedy is right, but nothing on the wire says add needs it (#871)                                                                                                                    |
| A supplied value the content sanitizer emptied (`rbook-mission-add.ts:256`, `rbook-mission-block.ts:147`, `rbook-mission-reopen.ts:61`)                                                                                                                                                                    | 3     | Yes: the refusal says "missing", and resending the same text repeats it                                                                                                                      |
| An out-of-range or wrong-typed value reported as missing (`rbook-constraints.ts:386`, `rbook-decisions-show.ts:84`, `rbook-decisions-update.ts:57`, `rbook-learnings-reaffirm.ts:67`, `rbook-learnings-show.ts:63`, `rbook-learnings-update.ts:71`, `rbook-mission-reopen.ts:58`)                          | 7     | No over MCP: the published schema refuses 0, -1, 1.5 and a non-string reason first, naming the field (checked against `dist/` at `56577fb9`); CLI and in-process callers still see "missing" |
| The first of two or more checks in one function (`rbook-message.ts:1007`, `:1424`; `rbook-mission-block.ts:129`; `rbook-mission-depends.ts:123`; `rbook-mission-move.ts:99`; `rbook-mission-reopen.ts:57`; `rbook-sprint-add.ts:128`; `rbook-sprint-carry-forward.ts:307`; `rbook-sprint-complete.ts:446`) | 9     | Conditional: a call that also omitted the next parameter meets the next check. Each remedy is right for its own check                                                                        |
| One of two named parameters (`rbook-learnings-update.ts:77`)                                                                                                                                                                                                                                               | 1     | No                                                                                                                                                                                           |
| Absent or blank, and the named value is what this check needs                                                                                                                                                                                                                                              | 40    | No                                                                                                                                                                                           |
| `invalidParameter`: valid values or the expected form are listed                                                                                                                                                                                                                                           | 29    | No                                                                                                                                                                                           |
| `invalidAction`: the available actions are listed                                                                                                                                                                                                                                                          | 12    | No                                                                                                                                                                                           |

The census's mechanical rules agree with the table where they apply: `sequentialMissingChecks` finds
the 11 functions behind the 9 first checks (the other two firsts are `rbook-mission-add.ts:252` and
`rbook-learnings-update.ts:71`, counted in earlier rows). `missingAfterSanitize` lists four sites;
`rbook-mission-add.ts:252` is a false positive of its position rule, because `missionId` is never
sanitized.

### The 413 refusal-shaped prose remedies

- **Removal imperatives** (`prose.removal`, 22 sites). Four are in the class, all in #870's chain:
  - `decision-fields.ts:47` says "Record the approved draft alone"; doing exactly that sends
    `fromDraft` without `content`, which `rbook-decisions-record.ts:151` refuses.
  - `draft-evaluation.ts:132` and `:144` say "or record without fromDraft", without the content such
    a record needs.
  - `draft-evaluation.ts:201` says to restate the draft's decision; a restatement under the coverage
    floor is refused again.

  `unknown-param-guard.ts:80` ("remove it") is a conditional member: when the unknown key held the
  call's only change, removing it leaves, for example, an update with no fields, which is refused.
  The other 17 name a value or state that clears their check.

- **Read beside the chain, not matched by a sub-predicate:** `draft-evaluation.ts:185`, the revised
  draft's "Record P exactly as the operator approved it", is refused again by any restatement that
  misses; and `draft-evaluation.ts:86`, "Record the revision instead, with fromDraft=…", named
  `fromDraft` without the content a record then needed (found by the round-1 critic). Both are in
  the class.
- **Retries with no stated condition** (`prose.retryWithoutCondition`, 22 of 71 retry sites). None is
  in the class: each is a fault or state refusal whose retry follows a repair, or
  `rbook-project-init`'s re-run without `projectId`, which clears its check.
- **The other prose sites are not examined one by one.** A remedy outside both sub-predicates can
  still chain, as `:86` shows. Close measure 11 (s106-m01) and s106-m05's census are where such a
  chain would show.

### The 74 executable prescriptions

The suggestion oracle replays each driven one from the state that emitted it. Its T4 requires a
replay that refuses to say its remedy is conditional, and it held at `56577fb9`, so none is an
undisclosed chain inside the driven matrix. The oracle's own ledger names the residual sites it
does not drive.

## Classified count before the repairs

Ten sites are in the class. Seven form #870's chain: `decision-fields.ts:47`; `draft-evaluation.ts:86`,
`:132`, `:144`, `:185` and `:201`; and `rbook-decisions-record.ts:151` under `fromDraft`. The other
three are the sanitizer-emptied checks. Ten conditional members: the nine first checks of sequential
groups and `unknown-param-guard.ts:80`. #871 is a repair outside the class. (The publication at
`647273f8` counted nine; `:86` was added and `unknown-param-guard.ts:80` reclassified after the
round-1 critic.)

## Changed

1. `decision-fields.ts:47` names the exact resend: drop context, alternatives, consequences, deciders
   and mode, and send `fromDraft` without content; a superseding record carries new reasoning (#870).
2. `rbook-decisions-record.ts:151`: with `fromDraft` and no `content`, the handler takes the draft's
   own text before `sanitizeContentField`, so a `fromDraft`-only record behaves exactly like a
   verbatim restatement (#870, design settled item 1). The check still guards a plain record. This
   also repairs `draft-evaluation.ts:86`, whose wording is unchanged.
3. `draft-evaluation.ts:132`, `:144`: a record without `fromDraft` names the content it needs.
4. `draft-evaluation.ts:185`, `:201`: both name `fromDraft` without content as the resend that
   records the draft in its own words. When the draft's own text holds a tool-call tag the sanitizer
   cuts, so that its cut copy cannot pass the same check, both say so instead and ask for the line to
   be proposed again with the tag in backticks, whatever content the caller sent (the round-2 critic
   found the first fold keyed this on the caller's content). Still open: a `Would record` line
   that begins with a code span is stored without its opening backtick (`draft-grammar.ts:54`), so
   a tag the line quoted can read as unquoted, and this advice repeats for that line. The round-3
   critic found it; next step #875 holds it.
5. `rbook-mission-add.ts:256`, `rbook-mission-block.ts:147`, `rbook-mission-reopen.ts:61` say the
   sanitizer emptied the supplied value and how to resend it, through `emptied-parameter.ts` (kept
   out of `errors.ts`, a sealed retrieval source).
6. `rbook-mission-add.ts:252` gives an example and states that ids are never derived; the
   `rbook_mission` `missionId` wire hint states the requirement (#871, settled item 2).
7. `unknown-param-guard.ts:80` adds "did you mean": the tool's published parameters whose names end
   with the unknown key, case-insensitive, that the call's action uses, all listed when several
   match. It does not end the conditional member: under either reading, the suggested name or
   removing the key, a call that also lacks something the refusal does not name is refused again
   (`rbook_decisions` record with `text` is offered `context`, and still lacks `content`). The suffix
   rule also offers names that merely end with the key, as `text` does `context`; a camelCase-boundary
   rule would not, but it is not the rule the design settled.

The `rbook_decisions` `fromDraft` wire hint, and the long form of `content`, say `content` may be
omitted.

## Left

- The 9 first checks of sequential groups (conditional), the 7 checks the published schema pre-empts
  over MCP, the one-of-two check, the 40 absent-or-blank checks, and all 29 `invalidParameter` and
  12 `invalidAction` sites, for the reasons in the table.
- `unknown-param-guard.ts:80`'s "remove it", under either reading (conditional).
- The 17 other removal-imperative and 22 condition-free retry prose sites, the prose sites outside
  both sub-predicates, and the 40 sites with no `code` of their own (not examined one by one).
- The 74 executable prescriptions, which the oracle governs.

## After the repairs

`after.json`, at the repair commit, under the same predicates: P0 returns 556 lines (two added
remedies: `emptied-parameter.ts` and `rbook-mission-add.ts`'s missing-id refusal); 529 authored
assignments, 488 refusal-shaped and 41 without a `code` of their own (the missing-id refusal spreads
`missingParameter`); 102 factory call sites (61, 29 and 12; the block check no longer calls
`missingParameter`); and `missingAfterSanitize` lists three sites, each now reached only by a blank
value (two) or never by a sanitized one (`rbook-mission-add.ts`'s missionId check).

Classified count after: none of the ten class members remains in the class. Each one's suggestion,
followed as written, now succeeds, which the oracle's s106-m02 chain test replays; where it cannot,
the refusal says why. That is a draft whose own text the sanitizer cuts (proposed again with the tag
in backticks, also replayed), or an approval the operator has not given, which the coverage check
cannot see and the approval check then names. One shape still loops: a draft line that begins with a code
span, whose stored copy loses its opening backtick (next step #875). The conditional members remain: the nine sequential
first checks, and `unknown-param-guard.ts`'s "remove it" under either reading.

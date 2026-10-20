// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Arc F item 1 — a provenance-instrumented behavioural oracle over authored error
// ABOUTME: `suggestion:` strings: reach the trigger state, execute the remedy, assert it works.

/**
 * WHAT THIS GATE CLAIMS, AND — EXACTLY — WHAT IT DOES NOT.
 *
 * SCOPE SENTENCE. For every authored `suggestion:` site this matrix can drive, this gate asserts
 * REACHABILITY and EFFICACY: the driven call does not crash; if the fired suggestion prescribes an
 * executable `rbook_*` call, executing that call from the SAME established state does not crash and
 * does not return the same `error.code` the suggestion was attached to; and a remedy that refuses
 * from that state discloses its condition. It asserts NOTHING about whether the prose names the
 * right CAUSE.
 *
 * T6 SCOPE SENTENCE. For every published non-`action` `type: "string"` field crossed with every
 * valid action (or its action-less tool), the T6 scope arm calls `findWrongTypedStringParam` with a
 * numeric wrong value and asserts that the guard's refusal set is a non-empty proper subset of the
 * whole universe, exactly equals the action-applicability contract, and still covers every pinned
 * historically-crashing triple. The driven T6 arms separately send number, object, array and
 * boolean values through all 15 in-process routers and assert every applicable value is refused.
 * The static one-guard arm excludes only telemetry-call.ts/projectRoot: that post-call observation
 * chooses an anonymous measurement destination and cannot validate or refuse a tool request.
 *
 * D-5's REFUSAL (#1024) STANDS AND IS REINFORCED, NOT OVERTURNED. D-5 refused a general
 * class-(b) semantic gate at any budget, on a figure ("75 of 176") whose predicate was never
 * recorded and is therefore not re-derivable. Under a STATED predicate re-run in this mission — a
 * suggestion carries no checkable identifier when it contains no `rbook_*(` call token, no bare
 * shipped tool name, no npm/npx/cmos-mcp command, no file path and no snake_case identifier — a
 * MAJORITY of the 182 authored suggestions carry NO checkable identifier at all (112 at the time
 * of writing; the census arm re-derives and PRINTS the figure every run rather than pinning it,
 * because the predicate, not the number, is the thing D-5 was missing). That is a larger prose
 * share than D-5 measured, so its conclusion is if anything stronger. This oracle checks
 * REACHABILITY and EFFICACY, never semantics.
 *
 * "EXAMINED" IS DEFINED OPERATIONALLY, VERBATIM (s89-m08 fold 1):
 *
 *     A site is EXAMINED iff `globalThis.__RBOOK_SUGGESTION_SITE__` recorded its
 *     `<relpath>:<line>` at least once during the matrix run.
 *
 * STATED SEPARATELY, so the two are never conflated: T2 and T3 apply ONLY to the CALL-BEARING
 * subset — the driveable sites whose suggestion text carries an executable `rbook_*` prescription.
 * That subset has its own count and its own pass rate, printed as a SECOND number. An
 * execution-based reading of "examined" would cap the count at the call-bearing subset; the
 * provenance definition above is what makes the larger count computable at all.
 *
 * FALSE-NEGATIVE PROFILE — for every noun in the scope sentence, the complement, with numbers
 * re-derived in this mission rather than carried:
 *
 *  1. THE 2 FORWARDING SITES. 184 `suggestion:` PropertyAssignments exist; 2 are exact
 *     property-access forwarding (`suggestion: x.suggestion`) and make no new claim. 182 authored.
 *     Re-derived by this file's own census arm, never hard-coded.
 *  2. THE DECLARED COMPLEMENT IS SPLIT, NOT HIDDEN. The 75 non-first-run FAULT sites still need a
 *     fault-injection instrument (read-only DB file, corrupt context JSON, dropped table); the 3
 *     first-run FAULT sites are the separately driven subset. EXTERNAL 26 now has its OWN portable
 *     ledger below: a real loopback HTTP server plus synthetic credential/config state reaches 24,
 *     while 2 are named construction-masked residuals. UNTYPED 1 remains at
 *     `sprint-summary-read.ts:45`, whose helper has zero production callers and inherits an
 *     arbitrary error code. `errors.ts:386` has a bounded resolver-code family, proven STATE
 *     below, and its explicit-projectRoot remedy is exercised over stdio. The EXTERNAL arm uses mirrored routers,
 *     no operator credential and no MCP stdio wire; it therefore takes no credit for the first-run
 *     wire matrix in `tests/e2e/wire-preflight.e2e.ts`.
 *  3. THE ANSWER-BODY CHANNEL IS DECLARED, NOT CLOSED. 87 `format*ForLLM` declarations in src/,
 *     of which 10 author 13 `rbook_*(` tokens into the BODY of a SUCCESSFUL answer (project-list 2,
 *     project-validate 2, session-start 2, context-history 1, context-search 1, db-backfill purge
 *     1, decisions-review 1, decisions-search 1, session-search 1, status 1). Those are not
 *     `suggestion:` PropertyAssignments, so closing them moves Arc F item 1's ratified count by
 *     ZERO. Sprint-90 candidate.
 *  4. s87-m01 hole 9's 9 envelope-`warnings[]` producers remain ARM-3-only in
 *     `remedy-reachability.test.ts`. Restated, not re-litigated.
 *  5. SITES THAT AUTHOR MORE THAN ONE STRING. A site counted EXAMINED may still have unexamined
 *     branches: `rbook-mission-unblock.ts:205` calls `unblockNotBlockedSuggestion()`, which authors
 *     SIX distinct strings. The ledger additionally prints DISTINCT OBSERVED VALUES so the gap
 *     between "site fired" and "every branch of that site fired" is visible rather than implied.
 *  6. SQL-FORCED TRIGGER STATES (UA-5). Several axes establish their state by SQL on a private
 *     store copy rather than by a supported call sequence. Every such value carries a
 *     reachability note saying how a supported sequence could produce it.
 *  7. IN-PROCESS ROUTERS, NOT `dist/` OVER STDIO. This gate drives the mirrored routers and
 *     one narrow project-folder refusal at the in-process dispatcher. It does not establish
 *     broad dispatcher preflight coverage. The ARTIFACT-level assertion for the same class lives in `scripts/verify-dist.ts`.
 *  8. T6'S SCOPE ARM TESTS THE ROUTER GUARD, NOT THE WIRE PREFLIGHT. It establishes no pre-guard
 *     outcome baseline, so "not refused" does not mean success or byte-identical output. Both its
 *     expected set and the guard's applicable list consume `RBOOK_ACTION_PARAMS`; the independent
 *     table-to-router contract belongs to `action-params.test.ts`. The whole T6 describe is skipped
 *     in a structural public mirror, and `verify-dist.ts`'s three wrong-type probes are all in-scope,
 *     so neither surface detects an over-broad guard. A red scope arm can therefore mean either a
 *     widened guard or an under-declared applicability table. None of this establishes the correct
 *     `src/index.ts` pre-dispatch scope: the wire consumes `projectRoot` independently of routers.
 *     The static arm also excludes exactly one projectRoot type check in telemetry-call.ts; its
 *     post-call observation is not a handler guard. telemetry-call.test.ts drives number, object,
 *     array and boolean roots and proves the operation runs once, its exact response survives, and
 *     one anonymous event is emitted. Other checks in that file remain inside the static census.
 *  9. SHORTHAND PROPERTIES ARE NOT READ. `{ code, message, suggestion }` is a shorthand property,
 *     not a PropertyAssignment, so a remedy written that way is outside this census. s96-m01's
 *     critics found one, in replica-check.ts; it was rewritten as a PropertyAssignment, and the
 *     census arm below fails on any shorthand `suggestion` in src rather than reading it.
 *
 * THE MIRROR IS NOT A BUILD. Provenance comes from an AST source transform into a gitignored
 * CommonJS mirror under `node_modules/.cache/` — ZERO `src/` edits — and it proves itself faithful
 * run. See `tests/helpers/suggestion-mirror.ts` for why a structured `remedy` field was rejected.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RBOOK_TOOL_DEFINITIONS } from '../../../src/tools/rbook';
import { RBOOK_ACTION_PARAMS } from '../../../src/tools/rbook/action-params';
import { findWrongTypedStringParam } from '../../../src/tools/rbook/param-type-guard';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookMissionTransition } from '../../../src/tools/rbook/rbook-mission-transition';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { rbookContext } from '../../../src/tools/rbook/rbook-context';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { rbookDb } from '../../../src/tools/rbook/rbook-db';
import { rbookProject } from '../../../src/tools/rbook/rbook-project';
import { rbookLearnings } from '../../../src/tools/rbook/rbook-learnings';
import { rbookFeedback } from '../../../src/tools/rbook/rbook-feedback';
import { rbookAuth } from '../../../src/tools/rbook/rbook-auth';
import { rbookMessage } from '../../../src/tools/rbook/rbook-message';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookStatus } from '../../../src/tools/rbook/rbook-status';
import { rbookReview } from '../../../src/tools/rbook/rbook-review';
import { RbookErrors } from '../../../src/tools/rbook/errors';
import { processOwnerKey } from '../../../src/tools/rbook/session-owner';
import { PROPOSALS_TABLE_SQL } from '../../../src/tools/rbook/proposals';

import {
  buildSuggestionMirror,
  installSuggestionSink,
  MIRROR_ROOT,
  type SuggestionMirrorResult,
  type SuggestionSink,
} from '../../helpers/suggestion-mirror';
import { readMirrorExclusions, requiresPrivateEvidence } from '../../helpers/public-mirror';
import { seedRbookDb, reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import {
  seedTempCredentials,
  startDashboardDouble,
  type DashboardDouble,
  type DashboardScenario,
} from '../../helpers/suggestion-axes-external';

jest.setTimeout(900_000);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * fold 3 — `scripts/mirror-to-public.sh`'s PRIVATE_PATHS is
 * `( rbook analysis artifacts tmp SESSIONS.jsonl agents.md CLAUDE.md ecosystem.config.js )`.
 * `tests/` is NOT in it: this file IS mirrored to the public repo, where `rbook/` does not exist.
 * The shared helper — never a guard of this file's own — decides between running and skipping.
 */
const PRIVATE = requiresPrivateEvidence({
  reason:
    'The suggestion axis matrix and the wrong-typed-parameter sweep both drive a suite-private copy of the live Reasonbook store; the census, extractor and mirror-integrity arms need only src/ and always run.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE CENSUS — re-derived at build time (fold 4: state the RULE, never pin the number)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `authored === RATIFIED_AUTHORED_BASE + sum(SITES_BY_MISSION) - sum(SITES_REMOVED_BY_MISSION)`.
 *
 * The base is Arc F item 1's ratified denominator (decision #1080, re-derived by this mission).
 * s90-m05 adds exactly the carry-target refusal below. The ratified base remains fixed; each later
 * mission enumerates the authored sites it adds, and since s92-m03 the ones it retires, rather than
 * moving that base.
 */
const RATIFIED_AUTHORED_BASE = 181;
const SITES_BY_MISSION = {
  's90-m05': ['src/tools/rbook/rbook-next-steps.ts:318'],
  's90-m07': [],
  's91-m02': ['src/tools/rbook/unknown-param-guard.ts:80'],
  's91-m03': [
    'src/tools/rbook/rbook-mission-complete.ts:232',
    'src/tools/rbook/rbook-session-complete.ts:333',
  ],
  's91-m04': [
    'src/tools/rbook/rbook-decisions-record.ts:153',
    'src/tools/rbook/rbook-decisions-record.ts:179',
  ],
  // s92-m01: the no-project refusal (one site, three situations), driven below in the first-run
  // instrument through the mirrored resolver and refusal classifier.
  's92-m01': ['src/tools/rbook/errors.ts:513'],
  // s92-m03: completing another live process's implicit session is refused; driven in axis 3.
  's92-m03': ['src/tools/rbook/errors.ts:528'],
  // s92-m08: show names a decision or learning id the project does not hold; driven in axis 2.
  's92-m08': ['src/tools/rbook/errors.ts:539'],
  // s92-m09: an explicit snapshot named like one of Reasonbook's automatic copies is refused
  // (INVALID_PARAMETER; driven in axis 6). prune_snapshots refuses to apply while a reference or
  // sprint-close source is unreadable (DB_QUERY_FAILED) and when the database snapshot fails
  // (SNAPSHOT_CREATION_FAILED); both are FAULT and driven in tests/tools/rbook/snapshot-diet.test.ts.
  's92-m09': [
    'src/tools/rbook/rbook-context-snapshot.ts:148',
    'src/tools/rbook/rbook-db-prune-snapshots.ts:445',
    'src/tools/rbook/rbook-db-prune-snapshots.ts:468',
  ],
  // s93-m11: init without its folder names the call to make, and list asked to prune names the
  // actions that prune (a read never does); both driven in axis 5. An explicit 'stale' a store
  // cannot stamp with its review time is refused, in update and batch update (DB_SCHEMA_MISMATCH,
  // FAULT: the column migration failed); both driven in tests/tools/rbook/first-write-upkeep.test.ts.
  's93-m11': [
    'src/tools/rbook/rbook-project-init.ts:403',
    'src/tools/rbook/rbook-project.ts:385',
    'src/tools/rbook/rbook-decisions-update.ts:137',
    'src/tools/rbook/rbook-decisions-batch-update.ts:101',
    // A since/until no stored time can be compared with is refused (it used to match nothing);
    // driven in axis 5.
    'src/tools/rbook/errors.ts:551',
  ],
  // s93-m12: a re-init naming a project id the project does not have is refused (a re-init keeps
  // the stored identity); driven in axis 2.
  's93-m12': ['src/tools/rbook/rbook-project-init.ts:666'],
  // s95-m06: a Ledger init given an initial sprint or missions is refused before it writes
  // anything, naming the Builder init; driven in axis 6.
  's95-m06': [
    'src/tools/rbook/rbook-project-init.ts:646',
    // The confirming critic: init refuses a store it cannot read rather than guess its level.
    'src/tools/rbook/rbook-project-init.ts:637',
  ],
  // s93-m05: a failed local v2 digest read is explicit, with a health-check remedy; driven in
  // review-v2-presentation.test.ts rather than returning an apparently empty successful digest.
  's93-m05': ['src/tools/rbook/review-presentation.ts:73'],
  // s93-m08: count each authored suggestion PropertyAssignment, not each branch value: five
  // standalone CLI refusals and two fleet refusals. The CLI's write-failure and sanitized-empty
  // branches share one site. Portable cases drive every non-fault site and execute CLI remedies.
  's93-m08': [
    'src/cli/feedback.ts:57',
    'src/cli/feedback.ts:66',
    'src/cli/feedback.ts:83',
    'src/cli/feedback.ts:94',
    'src/cli/feedback.ts:126',
    'src/tools/rbook/rbook-feedback.ts:229',
    'src/tools/rbook/rbook-feedback.ts:238',
  ],
  // s93-m06: recording a draft. Six refusals are driven in axis 2 below (an id that is not a draft
  // id, no such draft, an answered draft, an expired one, content that does not state the draft, a
  // constraint draft with no operator words in this session); four need a harness session or a
  // race and are named residuals, each driven in tests/tools/rbook/draft-approval.test.ts.
  's93-m06': [
    'src/tools/rbook/draft-approval.ts:113',
    'src/tools/rbook/draft-approval.ts:156',
    'src/tools/rbook/draft-approval.ts:168',
    'src/tools/rbook/draft-approval.ts:185',
    'src/tools/rbook/draft-approval.ts:216',
    'src/tools/rbook/draft-approval.ts:227',
    'src/tools/rbook/draft-approval.ts:133',
    'src/tools/rbook/draft-approval.ts:379',
    'src/tools/rbook/draft-approval.ts:450',
    'src/tools/rbook/rbook-decisions-record.ts:366',
  ],
  // s94-m04: shape preflight at six writer boundaries, immutable retry comparison and draft-field conflict.
  's94-m04': [
    'src/tools/rbook/rbook-decisions-record.ts:186',
    'src/tools/rbook/rbook-decisions-record.ts:285',
    'src/tools/rbook/rbook-mission-complete.ts:346',
    'src/tools/rbook/rbook-session-capture.ts:517',
    'src/tools/rbook/rbook-session-complete.ts:453',
    'src/tools/rbook/sync-bootstrap.ts:149',
    'src/tools/rbook/sync-pull.ts:219',
    'src/tools/rbook/decision-fields.ts:48',
  ],
  // s94-m05: eight explicit remedies replace one retired pre-lock parent-inspection fallback.
  's94-m05': [
    'src/tools/rbook/rbook-mission-add.ts:286',
    'src/tools/rbook/rbook-mission-add.ts:302',
    'src/tools/rbook/rbook-mission-start.ts:254',
    'src/tools/rbook/rbook-mission-start.ts:268',
    'src/tools/rbook/rbook-mission-status.ts:261',
    'src/tools/rbook/rbook-mission-update.ts:326',
    'src/tools/rbook/rbook-mission-update.ts:466',
    'src/tools/rbook/rbook-mission-update.ts:478',
  ],
  // s94-m06: six authored fault remedies cover required citation preflight/materialization and
  // rollback. The inline capture-permissions suggestion retires into shared failure handling.
  's94-m06': [
    'src/tools/rbook/rbook-decisions-record.ts:383',
    'src/tools/rbook/record-link-write.ts:26',
    'src/tools/rbook/record-link-write.ts:83',
    'src/tools/rbook/record-links.ts:22',
    'src/tools/rbook/sync-bootstrap.ts:192',
    'src/tools/rbook/sync-pull.ts:230',
  ],
  // s94-m08: four mandatory mission-drop fault remedies and two CLI spin-out refusals.
  's95-m13': [
    'src/index.ts:1289',
    'src/tools/rbook/rbook-message.ts:790',
    'src/tools/rbook/sender-refusal.ts:96',
  ],
  's94-m08': [
    'src/tools/rbook/rbook-mission-drop.ts:69',
    'src/tools/rbook/rbook-mission-drop.ts:92',
    'src/tools/rbook/rbook-mission-drop.ts:219',
    'src/tools/rbook/rbook-mission-drop.ts:258',
    'src/tools/rbook/spin-out-mapping.ts:31',
    'src/tools/rbook/spin-out.ts:352',
  ],
  // s99-m06: offline migration refusals plus guarded init/client opens.
  's99-m06': [
    'src/tools/rbook/client.ts:423',
    'src/tools/rbook/rbook-project-init.ts:626',
    'src/cli/migrate.ts:176',
    'src/cli/migrate-config.ts:156',
    'src/cli/migrate-config.ts:166',
  ],
  // s96-m01: the shared record's refusals (a second live copy, a restored copy, an unjoined copy, an
  // unchecked one and a store that cannot be read), a full number block, and init's refusal to seed
  // a shared copy. Each was a shorthand or new site; all are named residuals or FAULT below, since
  // no supported call makes a store shared before s96-m03.
  's96-m01': [
    'src/tools/rbook/replica-check.ts:37',
    'src/tools/rbook/replica-check.ts:48',
    'src/tools/rbook/replica-check.ts:59',
    'src/tools/rbook/replica-check.ts:67',
    'src/tools/rbook/replica-check.ts:77',
    'src/tools/rbook/replica-identity.ts:289',
    'src/tools/rbook/rbook-project-init.ts:695',
  ],
  // s96-m03: a broken write guard, a delete the change log cannot record, a shared row with no
  // stable id, and a recorded write that ends its own transaction. Named residuals below: each is
  // damage or a write no tool makes, on a shared store or not.
  's96-m03': [
    'src/tools/rbook/replica-check.ts:112',
    'src/tools/rbook/record-capture.ts:57',
    'src/tools/rbook/record-capture.ts:67',
    'src/tools/rbook/record-guards.ts:405',
  ],
  // s96-m12: the merge's refusals and remedies: a delivery of another project's record, a slot that
  // holds a different change, a merge into a store that keeps no change log, a member admitted off
  // the owner's copy, a field in conflict, an identity write on a member's copy, a settle with no
  // value, of a table with no conflicts, of nothing in conflict, of a lineage fork off the owner or
  // of a value no copy wrote, and a write to a session another copy started. s96-m13's shared-store
  // matrix case drives the two settles one store reaches; the rest are named residuals below, each
  // needing a second copy, a delivery or a conflict.
  's96-m12': [
    'src/tools/rbook/record-apply.ts:140',
    'src/tools/rbook/record-apply.ts:151',
    'src/tools/rbook/record-apply.ts:177',
    'src/tools/rbook/record-apply.ts:204',
    'src/tools/rbook/record-decide.ts:38',
    'src/tools/rbook/record-capture.ts:84',
    'src/tools/rbook/record-standing.ts:148',
    'src/tools/rbook/rbook-db-conflicts.ts:70',
    'src/tools/rbook/record-settle.ts:182',
    'src/tools/rbook/record-settle.ts:207',
    'src/tools/rbook/record-settle.ts:214',
    'src/tools/rbook/record-settle.ts:223',
    'src/tools/rbook/session-owner.ts:187',
  ],
  // s96-m13: the sync, sharing and joining refusals and remedies: share, invite, members, remove and
  // sync on rbook_project; the exchange and its steps, the wire, SSH and bundles; the join; owner-copy
  // moves, recovery and re-identification; a member's copy refusing the old backfill, a purge and a
  // restore; and the CLI's bundle for a member (nine of the 72 added at the build-time critics' folds).
  's96-m13': [
    'src/cli/sync.ts:157',
    'src/tools/rbook/rbook-db-backfill.ts:813',
    'src/tools/rbook/rbook-db-backfill.ts:138',
    'src/tools/rbook/rbook-db-restore.ts:226',
    'src/tools/rbook/rbook-project-shared.ts:146',
    'src/tools/rbook/rbook-project-shared.ts:175',
    'src/tools/rbook/rbook-project-shared.ts:289',
    'src/tools/rbook/record-admit-successor.ts:104',
    'src/tools/rbook/record-admit-successor.ts:110',
    'src/tools/rbook/record-admit-successor.ts:125',
    'src/tools/rbook/record-admit-successor.ts:133',
    'src/tools/rbook/record-bundle.ts:116',
    'src/tools/rbook/record-bundle.ts:155',
    'src/tools/rbook/record-bundle.ts:168',
    'src/tools/rbook/record-bundle.ts:176',
    'src/tools/rbook/record-bundle.ts:189',
    'src/tools/rbook/record-bundle.ts:101',
    'src/tools/rbook/record-bundle.ts:108',
    'src/tools/rbook/record-decide.ts:76',
    'src/tools/rbook/record-exchange-steps.ts:237',
    'src/tools/rbook/record-exchange-steps.ts:37',
    'src/tools/rbook/record-exchange.ts:214',
    'src/tools/rbook/record-exchange.ts:220',
    'src/tools/rbook/record-exchange.ts:227',
    'src/tools/rbook/record-exchange.ts:234',
    'src/tools/rbook/record-exchange.ts:242',
    'src/tools/rbook/record-exchange.ts:266',
    'src/tools/rbook/record-exchange.ts:273',
    'src/tools/rbook/record-exchange.ts:280',
    'src/tools/rbook/record-exchange.ts:317',
    'src/tools/rbook/record-join.ts:105',
    'src/tools/rbook/record-join.ts:114',
    'src/tools/rbook/record-join.ts:139',
    'src/tools/rbook/record-join.ts:170',
    'src/tools/rbook/record-join.ts:175',
    'src/tools/rbook/record-join.ts:183',
    'src/tools/rbook/record-join.ts:188',
    'src/tools/rbook/record-join.ts:196',
    'src/tools/rbook/record-join.ts:203',
    'src/tools/rbook/record-join.ts:245',
    'src/tools/rbook/record-join.ts:255',
    'src/tools/rbook/record-join.ts:267',
    'src/tools/rbook/record-membership.ts:144',
    'src/tools/rbook/record-membership.ts:151',
    'src/tools/rbook/record-membership.ts:160',
    'src/tools/rbook/record-membership.ts:174',
    'src/tools/rbook/record-membership.ts:338',
    'src/tools/rbook/record-membership.ts:347',
    'src/tools/rbook/record-move-routes.ts:67',
    'src/tools/rbook/record-moves.ts:145',
    'src/tools/rbook/record-moves.ts:153',
    'src/tools/rbook/record-moves.ts:72',
    'src/tools/rbook/record-moves.ts:79',
    'src/tools/rbook/record-moves.ts:88',
    'src/tools/rbook/record-moves.ts:95',
    'src/tools/rbook/record-recovery.ts:168',
    'src/tools/rbook/record-recovery.ts:180',
    'src/tools/rbook/record-recovery.ts:197',
    'src/tools/rbook/record-recovery.ts:222',
    'src/tools/rbook/record-share-action.ts:108',
    'src/tools/rbook/record-share-action.ts:119',
    'src/tools/rbook/record-share-action.ts:74',
    'src/tools/rbook/record-share-action.ts:81',
    'src/tools/rbook/record-share-action.ts:90',
    'src/tools/rbook/record-successor.ts:133',
    'src/tools/rbook/record-successor.ts:177',
    'src/tools/rbook/record-sync.ts:171',
    'src/tools/rbook/record-sync.ts:197',
    'src/tools/rbook/record-sync.ts:255',
    'src/tools/rbook/record-sync.ts:261',
    'src/tools/rbook/record-sync.ts:337',
    'src/tools/rbook/record-sync.ts:412',
  ],
  // s96-m14: the import's refusals: a --from holding the store it would write to, a project that is
  // not shared, a --from with no store or with both layouts, a copy this account cannot read or that is
  // damaged, a copy of another project or of a shared record, one older than the project id under
  // another folder name, a store that cannot reach the sharing schema, a zip archive named as the
  // copy, the shared copy named as its own copy, an --include naming a row the dry run does not
  // leave out, and a write that would give a numbered row another id than its plan.
  's96-m14': [
    'src/tools/rbook/record-import.ts:140',
    'src/tools/rbook/record-import.ts:146',
    'src/tools/rbook/record-import.ts:168',
    'src/tools/rbook/record-import.ts:174',
    'src/tools/rbook/record-import.ts:182',
    'src/tools/rbook/record-import.ts:188',
    'src/tools/rbook/record-import.ts:194',
    'src/tools/rbook/record-import.ts:201',
    'src/tools/rbook/record-import.ts:216',
    'src/tools/rbook/record-import.ts:223',
    'src/tools/rbook/record-import.ts:230',
    'src/tools/rbook/record-import.ts:252',
    'src/tools/rbook/record-import.ts:272',
    'src/tools/rbook/record-import-apply.ts:86',
  ],
  // s99-m10: scoped and global reconciliation refuse an unrecognized table-count payload.
  // Both inherit DASHBOARD_ERROR, are driven by the portable HTTP arm, and prescribe no tool call.
  's99-m10': [
    'src/tools/rbook/rbook-db-backfill.ts:470',
    'src/tools/rbook/rbook-db-backfill.ts:552',
  ],
  // s96-m08: one common retirement remedy, a local hook-read fault, and owner-key gates.
  // The message-get remedy changes text at its existing site; it is not an added site.
  's96-m08': [
    'src/tools/rbook/legacy-sync-refusal.ts:11',
    'src/tools/rbook/sync-locks.ts:127',
    'src/auth/dashboard-owner.ts:19',
    'src/auth/dashboard-owner.ts:28',
  ],
  // s97-m09: the referee library's refusals, answered to the dashboard's routes and never through an
  // MCP router (calls before the join, arguments, membership, intake, the stream head and copies),
  // and a fresh copy's schema that cannot be made current.
  's97-m09': [
    'src/referee/copies.ts:28',
    'src/referee/copies.ts:34',
    'src/referee/copies.ts:81',
    'src/referee/handover.ts:116',
    'src/referee/handover.ts:130',
    'src/referee/handover.ts:190',
    'src/referee/handover.ts:196',
    'src/referee/handover.ts:221',
    'src/referee/handover.ts:229',
    'src/referee/handover.ts:289',
    'src/referee/intake.ts:129',
    'src/referee/intake.ts:163',
    'src/referee/intake.ts:179',
    'src/referee/intake.ts:187',
    'src/referee/intake.ts:199',
    'src/referee/intake.ts:212',
    'src/referee/intake.ts:219',
    'src/referee/intake.ts:240',
    'src/referee/intake.ts:253',
    'src/referee/intake.ts:271',
    'src/referee/intake.ts:285',
    'src/referee/intake.ts:297',
    'src/referee/membership.ts:51',
    'src/referee/membership.ts:71',
    'src/referee/membership.ts:78',
    'src/referee/membership.ts:111',
    'src/referee/membership.ts:152',
    'src/referee/open.ts:106',
    'src/referee/open.ts:157',
    'src/referee/open.ts:189',
    'src/referee/open.ts:226',
    'src/referee/open.ts:278',
    'src/referee/open.ts:287',
    'src/referee/peer.ts:69',
    'src/referee/peer.ts:135',
    'src/referee/peer.ts:142',
    'src/referee/peer.ts:214',
    'src/referee/peer.ts:237',
    'src/referee/peer.ts:251',
    'src/referee/peer.ts:372',
    'src/referee/views.ts:69',
    'src/referee/views.ts:97',
    'src/tools/rbook/record-fresh-copy.ts:402',
  ],
  // s97-m10: the dashboard transport's refusals (a sign-in, a project, a limit, a status, a route to
  // another dashboard, no sign-in, a password, no answer, too much, an empty page, a transaction too
  // large), a dashboard route synced with no project folder, a bundle or an SSH channel of a refereed
  // project, and a dashboard route another would replace.
  's97-m10': [
    'src/tools/rbook/record-dashboard-peer.ts:83',
    'src/tools/rbook/record-dashboard-peer.ts:89',
    'src/tools/rbook/record-dashboard-peer.ts:95',
    'src/tools/rbook/record-dashboard-peer.ts:101',
    'src/tools/rbook/record-dashboard-peer.ts:106',
    'src/tools/rbook/record-dashboard-peer.ts:111',
    'src/tools/rbook/record-dashboard-peer.ts:178',
    'src/tools/rbook/record-dashboard-peer.ts:187',
    'src/tools/rbook/record-dashboard-peer.ts:194',
    'src/tools/rbook/record-dashboard-peer.ts:236',
    'src/tools/rbook/record-dashboard-peer.ts:317',
    'src/tools/rbook/record-dashboard-peer.ts:344',
    'src/tools/rbook/record-peers.ts:99',
    'src/tools/rbook/record-sync.ts:122',
    'src/tools/rbook/record-sync.ts:152',
    'src/tools/rbook/record-wire.ts:75',
  ],
  // s97-m11: sharing, joining and moving back through the dashboard: the flows' refusals, setRole, the
  // referee's move back and archive, and a route the dashboard ended.
  's97-m11': [
    'src/referee/handover.ts:259',
    'src/referee/membership.ts:183',
    'src/referee/peer.ts:291',
    'src/tools/rbook/rbook-project-shared.ts:274',
    'src/tools/rbook/rbook-project-shared.ts:319',
    'src/tools/rbook/record-dashboard-join.ts:67',
    'src/tools/rbook/record-dashboard-join.ts:78',
    'src/tools/rbook/record-dashboard-join.ts:105',
    'src/tools/rbook/record-dashboard-join.ts:60',
    'src/tools/rbook/record-dashboard-move.ts:90',
    'src/tools/rbook/record-dashboard-move.ts:99',
    'src/tools/rbook/record-dashboard-move.ts:159',
    'src/tools/rbook/record-dashboard-move.ts:151',
    'src/tools/rbook/record-dashboard-move.ts:180',
    'src/tools/rbook/record-dashboard-move.ts:216',
    'src/tools/rbook/record-dashboard-move.ts:134',
    'src/tools/rbook/record-successor.ts:312',
    'src/tools/rbook/record-dashboard-move.ts:166',
    'src/tools/rbook/record-dashboard-peer.ts:211',
    'src/tools/rbook/record-dashboard-peer.ts:248',
    'src/tools/rbook/record-dashboard-share.ts:103',
    'src/tools/rbook/record-dashboard-share.ts:151',
    'src/tools/rbook/record-dashboard-share.ts:163',
    'src/tools/rbook/record-dashboard-share.ts:180',
    'src/tools/rbook/record-dashboard-share.ts:214',
    'src/tools/rbook/record-dashboard-share.ts:238',
    'src/tools/rbook/record-dashboard-share.ts:294',
    'src/tools/rbook/record-dashboard-share.ts:317',
    'src/tools/rbook/record-membership.ts:279',
    'src/tools/rbook/record-membership.ts:285',
    'src/tools/rbook/record-membership.ts:300',
    'src/tools/rbook/record-membership.ts:306',
    'src/tools/rbook/record-membership.ts:292',
  ],
  's97-m12': ['src/tools/rbook/draft-approval.ts:201'],
  // s100-m01: the sharing fixes' refusals: the owner's other copies at a share, a removed member's
  // route the dashboard ended, a re-judge off the owner's copy, a join and a recovery of a newer
  // protocol, a handover to a copy behind a move or from one, a removed copy's sync, and a member's
  // reconcile.
  's100-m01': [
    'src/tools/rbook/record-dashboard-share.ts:174',
    'src/tools/rbook/record-dashboard-peer.ts:259',
    'src/tools/rbook/record-decide.ts:127',
    'src/tools/rbook/record-join.ts:127',
    'src/tools/rbook/record-recovery.ts:346',
    'src/tools/rbook/record-move-routes.ts:59',
    'src/tools/rbook/record-move-routes.ts:53',
    'src/tools/rbook/record-sync.ts:287',
    'src/tools/rbook/rbook-db-backfill.ts:431',
  ],
  // s100-m02: a share of a project the dashboard does not hold yet, refused signed out or with
  // uploads off, where a session close would upload nothing (the s97 review's finding 7).
  's100-m02': [
    'src/tools/rbook/record-dashboard-share.ts:203',
    'src/tools/rbook/record-dashboard-share.ts:209',
  ],
  // s100-m03: a next-step capture whose table or genesis columns cannot be prepared before the
  // write lock, now that the capture writes its row (#712).
  's100-m03': ['src/tools/rbook/rbook-session-capture.ts:498'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
const RATIFIED_SITE_ADDS = Object.values(SITES_BY_MISSION).flat();

/**
 * Authored sites a mission retired, named as they stood at the commit before it (file:line there).
 * s92-m03: a capture with no session open no longer refuses with SESSION_NOT_ACTIVE; it lands in
 * the caller's implicit session.
 */
const SITES_REMOVED_BY_MISSION = {
  // s96-m08 removes the old clone/pull/mutable-push implementations. These are their twelve
  // authored sites at pre-edit commit 25b9aae, not exemptions for active refusal surfaces.
  // Missing-input, schema/registration and pre-pull refusals all retire into the common remedy.
  's96-m08': [
    'src/tools/rbook/sync-bootstrap.ts:133',
    'src/tools/rbook/sync-bootstrap.ts:151',
    'src/tools/rbook/sync-bootstrap.ts:164',
    'src/tools/rbook/sync-bootstrap.ts:182',
    'src/tools/rbook/sync-bootstrap.ts:192',
    'src/tools/rbook/sync-mutable-push.ts:111',
    'src/tools/rbook/sync-mutable-push.ts:140',
    'src/tools/rbook/sync-mutable-push.ts:155',
    'src/tools/rbook/sync-mutable-push.ts:166',
    'src/tools/rbook/sync-pull.ts:192',
    'src/tools/rbook/sync-pull.ts:221',
    'src/tools/rbook/sync-pull.ts:230',
  ],
  's94-m06': ['src/tools/rbook/rbook-session-capture.ts:591'],
  's94-m05': ['src/tools/rbook/rbook-mission-start.ts:198'],
  's92-m03': ['src/tools/rbook/rbook-session-capture.ts:426'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
const RATIFIED_SITE_REMOVALS = Object.values(SITES_REMOVED_BY_MISSION).flat();

const VALIDATION_CODES = new Set([
  'INVALID_PARAMETER',
  'MISSING_PARAMETER',
  'INVALID_ACTION',
  'CONFIRMATION_REQUIRED',
]);
const FAULT_CODES = new Set([
  'DB_QUERY_FAILED',
  'DB_CONNECTION_FAILED',
  'DB_SCHEMA_MISMATCH',
  'DB_NOT_FOUND',
  'CONTEXT_PARSE_ERROR',
  'CONTEXT_CONDENSATION_FAILED',
  'TOOL_EXECUTION_ERROR',
  'RBOOK_NOT_DETECTED',
  'PULL_BEFORE_PUSH_FAILED',
  // These name local read faults even though one code carries the dashboard prefix.
  'LEGACY_SYNC_STATUS_UNAVAILABLE',
  'DASHBOARD_OWNER_UNREADABLE',
]);
const EXTERNAL_CODES = new Set([
  'SENDER_ATTRIBUTION_MISMATCH',
  'EXPECTED_SLUG_MISMATCH',
  'NOT_COLLAB_STORE',
  'PROJECT_ID_MISMATCH',
  'PROJECT_NOT_REGISTERED',
]);
const EXTERNAL_PREFIXES = ['DASHBOARD_', 'DEVICE_CODE_', 'CREDENTIAL_'];

/**
 * Sites whose object literal carries no sibling `code:` because the literal is a HELPER RETURN
 * VALUE rather than the error itself. The bucket is resolved from the proven consumer code
 * or code family that reaches callers; nonliteral families retain the `<expr>` label.
 *
 * `rbook-context-update.ts:780/790/799/818` are the four returns of `applyNestedFieldUpdate`, whose
 * ONLY consumer (`rbook-context-update.ts:543-549`) stamps `RBOOK_ERROR_CODES.INVALID_PARAMETER` and
 * forwards `updateResult.suggestion` verbatim. The census arm PROVES that single-consumer premise
 * rather than trusting this comment.
 *
 * `errors.ts:386` is produced by `senderUnresolvable`. Its production code now varies between
 * the resolver's default and its explicit Codex/address refusals. The proof below enumerates
 * every constructor code and proves all belong to STATE; `<expr>` names this nonliteral code.
 * `sprint-summary-read.ts:45` remains
 * absent: `withViewContext` spreads `...error`, so its code is arbitrary, and it has ZERO callers.
 */
const CONSUMER_RESOLVED_CODES: Readonly<Record<string, string>> = {
  'src/tools/rbook/rbook-context-update.ts:780': 'INVALID_PARAMETER',
  'src/tools/rbook/rbook-context-update.ts:790': 'INVALID_PARAMETER',
  'src/tools/rbook/rbook-context-update.ts:799': 'INVALID_PARAMETER',
  'src/tools/rbook/rbook-context-update.ts:818': 'INVALID_PARAMETER',
  'src/tools/rbook/errors.ts:386': '<expr>',
  // These objects spread dashboardError before overriding its suggestion; proven below.
  'src/tools/rbook/rbook-db-backfill.ts:470': 'DASHBOARD_ERROR',
  'src/tools/rbook/rbook-db-backfill.ts:552': 'DASHBOARD_ERROR',
};

type TriggerClass = 'VALIDATION' | 'STATE' | 'FAULT' | 'EXTERNAL' | 'UNTYPED';

/**
 * bucket = f(sibling `code:`). STATE is the residual arm — `*_NOT_FOUND`, `*_INVALID_STATE`,
 * `*_INVALID_TRANSITION`, `*_ALREADY_*`, `*_NOT_ACTIVE`, `*_NOT_READY`, `*_ID_EXISTS` and
 * non-literal `code` expressions all land there. FAULT's list is explicit and wins over the STATE
 * suffix rules, which is why `DB_NOT_FOUND` is FAULT while `SNAPSHOT_NOT_FOUND` is STATE: FAULT
 * carries `SNAPSHOT_*_FAILED`, not `SNAPSHOT_*`.
 */
function triggerClassOf(code: string | null): TriggerClass {
  if (code === null) return 'UNTYPED';
  if (VALIDATION_CODES.has(code)) return 'VALIDATION';
  if (FAULT_CODES.has(code) || /^SNAPSHOT_.*_FAILED$/.test(code)) return 'FAULT';
  if (EXTERNAL_CODES.has(code) || EXTERNAL_PREFIXES.some((p) => code.startsWith(p))) {
    return 'EXTERNAL';
  }
  return 'STATE';
}

interface CensusSite {
  site: string;
  file: string;
  line: number;
  code: string | null;
  triggerClass: TriggerClass;
  callBearing: boolean;
  text: string;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE EXTRACTOR — s85-m01's regexes, WIDENED to the three observed authoring syntaxes (CLASS 2)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `CALL_RE` and `ACTION_RE` are byte-identical to `remedy-reachability.test.ts` so the two gates
 * cannot drift on how a remedy string is read (that file's ARM 1/2/3 are NOT rewritten onto the
 * mirror — moving them would silently subtract from the `collectCoverageFrom: ['src/**\/*.ts']`
 * floors). `WITH_ACTION_RE` and `BARE_ACTION_RE` are the widening this mission adds.
 */
const CALL_RE = /\brbook_[a-z_]+\s*\(/g;
const ACTION_RE = /^\s*action\s*[:=]\s*["'`]([a-z_]+)["'`]/;
/** `rbook_sprint with action="show"` — a shipped tool named without a parenthesis. */
const WITH_ACTION_RE = /\b(rbook_[a-z_]+)\s+with\s+action\s*[:=]\s*\\?["'`]([a-z_]+)\\?["'`]/g;
/** `rbook_decisions list` — a shipped tool followed by a bare action token. */
const BARE_ACTION_RE = /\b(rbook_[a-z_]+)\s+(?:action\s*[:=]\s*\\?["'`]?)?([a-z_]+)\b/g;
/** `rbook_status`, `rbook_review` — action-less shipped tools named on their own. */
const TOOL_TOKEN_RE = /\b(rbook_[a-z_]+)\b/g;

const TOOL_NAMES: ReadonlySet<string> = new Set<string>(RBOOK_TOOL_DEFINITIONS.map((t) => t.name));
const TOOL_ACTIONS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map(
  RBOOK_TOOL_DEFINITIONS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, { enum?: unknown }> };
    const actionProp = schema?.properties?.action;
    const values = actionProp && Array.isArray(actionProp.enum) ? actionProp.enum : null;
    return [tool.name, values ? new Set(values.map(String)) : null] as const;
  })
);

interface PrescribedCall {
  tool: string;
  action: string | undefined;
  syntax: 'paren' | 'with-action' | 'bare-action' | 'action-less';
}

/** Every executable `rbook_*` prescription a suggestion string carries, in all three syntaxes. */
function extractPrescribedCalls(text: string): PrescribedCall[] {
  const out: PrescribedCall[] = [];
  const seen = new Set<string>();
  const push = (call: PrescribedCall): void => {
    if (!TOOL_NAMES.has(call.tool)) return;
    const key = `${call.tool}|${call.action ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(call);
  };

  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text)) !== null) {
    const tool = m[0].slice(0, m[0].indexOf('(')).trim();
    const actionMatch = text.slice(m.index + m[0].length).match(ACTION_RE);
    push({ tool, action: actionMatch ? actionMatch[1] : undefined, syntax: 'paren' });
  }

  WITH_ACTION_RE.lastIndex = 0;
  while ((m = WITH_ACTION_RE.exec(text)) !== null) {
    push({ tool: m[1], action: m[2], syntax: 'with-action' });
  }

  BARE_ACTION_RE.lastIndex = 0;
  while ((m = BARE_ACTION_RE.exec(text)) !== null) {
    const actions = TOOL_ACTIONS.get(m[1]);
    if (actions && actions.has(m[2])) push({ tool: m[1], action: m[2], syntax: 'bare-action' });
  }

  TOOL_TOKEN_RE.lastIndex = 0;
  while ((m = TOOL_TOKEN_RE.exec(text)) !== null) {
    if (TOOL_ACTIONS.get(m[1]) === null)
      push({ tool: m[1], action: undefined, syntax: 'action-less' });
  }

  return out;
}

/** Shipped tool names a suggestion mentions at all — the T5 numerator. */
function namedShippedTools(text: string): string[] {
  const out = new Set<string>();
  TOOL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_TOKEN_RE.exec(text)) !== null) {
    if (TOOL_NAMES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * Tokens that DISCLOSE a remedy as conditional (T4). Byte-identical to `remedy-reachability`'s
 * `HEDGE_TOKENS`/`disclosesCondition` per the plan — shape, not semantics.
 */
const HEDGE_TOKENS = [' if ', 'only ', 'unless ', 'when ', 'once ', 'first', 'then ', 'cannot'];
function disclosesCondition(suggestion: string): boolean {
  const lower = ` ${suggestion.toLowerCase()} `;
  return HEDGE_TOKENS.some((t) => lower.includes(t));
}

/**
 * A suggestion carries NO CHECKABLE IDENTIFIER when it names no `rbook_*(` call, no bare shipped
 * tool name, no npm/npx/cmos-mcp/reasonbook command, no file path and no snake_case identifier. This is the
 * stated predicate that re-adjudicates D-5 — the figure it produces is printed, never asserted
 * against a remembered one.
 */
function carriesCheckableIdentifier(text: string): boolean {
  if (/\brbook_[a-z_]+/.test(text)) return true;
  if (/\b(npm|npx|cmos-mcp|reasonbook)\b/.test(text)) return true;
  if (/[\w-]+\/[\w./-]+/.test(text)) return true;
  if (/\b[a-z]+_[a-z_]+\b/.test(text)) return true;
  return false;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE HARNESS
// ───────────────────────────────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copyStoreBundle(sourceDb: string, destinationDb: string): void {
  fs.mkdirSync(path.dirname(destinationDb), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDb}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${destinationDb}${suffix}`);
  }
}

let frozenSourceDb = '';
/** Freeze the live store ONCE. No handler ever receives the live path. */
function initializeFrozenSource(): void {
  if (frozenSourceDb) return;
  const root = mkTmp('rbook-s89m08-frozen-');
  frozenSourceDb = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  copyStoreBundle(PRIVATE.paths.liveDb, frozenSourceDb);
}

let storeSeq = 0;
/** One writable copy of the frozen source per trigger case — "establish, never inherit" (#547). */
function freshStore(): { projectRoot: string; dbPath: string } {
  initializeFrozenSource();
  const projectRoot = mkTmp(`rbook-s89m08-case-${storeSeq++}-`);
  const dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
  copyStoreBundle(frozenSourceDb, dbPath);
  reidentifyRbookTestStore(projectRoot);
  return { projectRoot, dbPath };
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type Outcome = 'SUCCEEDS' | 'REFUSES' | 'CRASHES' | 'TIMEOUT';

interface DrivenCall {
  /** The case that established the state, for the failure message. */
  caseName: string;
  axis: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  suggestion?: string;
  thrown?: string;
  /** Sites whose recorded values contain this call's suggestion string. */
  sites: string[];
}

/**
 * Bound EVERY router call. A plan-time probe with no timeout hung indefinitely inside a
 * `rbook_project` action after 430 of 642 calls and produced no output at all.
 */
const CALL_TIMEOUT_MS = 20_000;

type MirrorRouters = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

let mirror!: SuggestionMirrorResult;
let sink!: SuggestionSink;
let mirrorRouters!: MirrorRouters;

function loadMirrorRouters(): MirrorRouters {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const load = (
    file: string,
    exportName: string
  ): ((p: Record<string, unknown>) => Promise<unknown>) =>
    require(`${mirror.root}/tools/rbook/${file}.js`)[exportName];
  return {
    // The shipped CLI owns the refusal; this adapter only decodes its JSON receipt for the
    // same driver used by MCP routers. It neither constructs nor intercepts suggestions.
    cli_feedback: async (params) => {
      const { runFeedback } = require(`${mirror.root}/cli/feedback.js`) as {
        runFeedback(
          argv: readonly string[],
          io: import('../../../src/cli/core').CliIo
        ): Promise<number>;
      };
      let stdout = '';
      const stderr: string[] = [];
      const code = await runFeedback([...(params.argv as string[]), '--format=json'], {
        cwd: String(params.projectRoot),
        env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...(params.env as NodeJS.ProcessEnv) },
        readStdin: async () => '',
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr.push(text);
        },
      });
      const result = JSON.parse(stdout) as { success: boolean };
      if (code !== (result.success ? 0 : 1) || stderr.length > 0)
        throw new Error(`Feedback CLI receipt disagrees with exit ${code}: ${stderr.join(' ')}`);
      return result;
    },
    // Narrow dispatcher witness for the folder-only address refusal. The general matrix
    // still drives routers; this does not claim wire/stdio or broad preflight coverage.
    dispatch_project: async (params) => {
      const dispatcher = require(`${mirror.root}/index.js`) as typeof import('../../../src/index');
      const context = await dispatcher.buildMissionProtocolContext();
      const result = await dispatcher.executeMissionProtocolTool('rbook_project', params, context);
      return result.structuredContent;
    },
    rbook_mission: load('rbook-mission', 'rbookMission'),
    rbook_mission_transition: load('rbook-mission-transition', 'rbookMissionTransition'),
    rbook_sprint: load('rbook-sprint', 'rbookSprint'),
    rbook_context: load('rbook-context', 'rbookContext'),
    rbook_session: load('rbook-session', 'rbookSession'),
    rbook_decisions: load('rbook-decisions', 'rbookDecisions'),
    rbook_db: load('rbook-db', 'rbookDb'),
    rbook_project: load('rbook-project', 'rbookProject'),
    rbook_learnings: load('rbook-learnings', 'rbookLearnings'),
    rbook_feedback: load('rbook-feedback', 'rbookFeedback'),
    rbook_auth: load('rbook-auth', 'rbookAuth'),
    rbook_message: load('rbook-message', 'rbookMessage'),
    rbook_agent_onboard: load('rbook-agent-onboard', 'rbookAgentOnboard'),
    rbook_status: load('rbook-status', 'rbookStatus'),
    rbook_review: load('rbook-review', 'rbookReview'),
  };
}

/** Attribute an observed suggestion string back to the site(s) that authored it. */
function attribute(suggestion: string | undefined): string[] {
  if (!suggestion) return [];
  const out: string[] = [];
  for (const [site, values] of sink.values) if (values.has(suggestion)) out.push(site);
  return out;
}

async function driveMirrored(
  caseName: string,
  axis: string,
  tool: string,
  params: Record<string, unknown>
): Promise<DrivenCall> {
  const action = typeof params.action === 'string' ? params.action : undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = (await Promise.race([
      mirrorRouters[tool](params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('__S89M08_TIMEOUT__')), CALL_TIMEOUT_MS);
      }),
    ])) as { success?: boolean; error?: { code?: string; suggestion?: string } };
    if (result?.success === true) {
      return { caseName, axis, tool, action, outcome: 'SUCCEEDS', sites: [] };
    }
    const suggestion = result?.error?.suggestion;
    return {
      caseName,
      axis,
      tool,
      action,
      outcome: 'REFUSES',
      code: result?.error?.code,
      suggestion,
      sites: attribute(suggestion),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '__S89M08_TIMEOUT__') {
      return { caseName, axis, tool, action, outcome: 'TIMEOUT', sites: [] };
    }
    return { caseName, axis, tool, action, outcome: 'CRASHES', thrown: message, sites: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE AXIS MATRIX — 8 state axes with small enumerations, not N bespoke fixtures
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface CaseContext {
  projectRoot: string;
  dbPath: string;
  /** A mission id that exists in the frozen source, discovered rather than hard-coded. */
  missionId: string;
  sprintId: string;
  /** A sprint the matrix keeps CLOSED, so the closed-target move refusal stays reachable. */
  closedSprintId: string;
}

interface MatrixCase {
  axis: string;
  name: string;
  /** UA-5: how a SUPPORTED call sequence could produce this state. Required for SQL-forced states. */
  reachable: string;
  setup?: (ctx: CaseContext) => void;
  calls: (ctx: CaseContext) => Array<{ tool: string; params: Record<string, unknown> }>;
}

/** The seven driven mission actions: the six transitions plus the update-status path. */
const DRIVEN_TRANSITIONS = ['start', 'complete', 'block', 'unblock', 'drop', 'defer'] as const;

/**
 * AXIS 1 — mission status. Seven published values plus `Archived` (WITNESSED LIVE in this repo's
 * own store) and `Failed` (REACHABLE BUT UNWITNESSED, UA-5: the same unvalidated import/peer-merge
 * paths that produce Archived, and until s87-m01 a member of MISSION_TERMINAL_STATUSES).
 */
const MISSION_STATUSES: ReadonlyArray<{ status: string; reachable: string }> = [
  { status: 'Queued', reachable: 'published enum; rbook_mission(add) default' },
  { status: 'Current', reachable: 'published enum; rbook_mission(update)' },
  { status: 'In Progress', reachable: 'published enum; rbook_mission_transition(start)' },
  { status: 'Blocked', reachable: 'published enum; rbook_mission_transition(block)' },
  { status: 'Completed', reachable: 'published enum; rbook_mission_transition(complete)' },
  { status: 'Dropped', reachable: 'published enum; rbook_mission_transition(drop)' },
  { status: 'Deferred', reachable: 'published enum; rbook_mission_transition(defer)' },
  {
    status: 'Archived',
    reachable:
      'WITNESSED LIVE — not a key of VALID_STATE_TRANSITIONS and not a member of ' +
      'VALID_MISSION_STATUSES; it arrives through import and peer-merge paths, which do not validate status.',
  },
  {
    status: 'Failed',
    reachable:
      'REACHABLE BUT UNWITNESSED (UA-5) — same unvalidated import/merge paths as Archived; it was ' +
      'until s87-m01 a member of MISSION_TERMINAL_STATUSES while VALID_STATE_TRANSITIONS had no key for it.',
  },
];

function setMissionStatus(dbPath: string, missionId: string, status: string): void {
  withDb(dbPath, (db) => {
    const info = db.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, missionId);
    if (info.changes !== 1) {
      throw new Error(
        `precondition not established: UPDATE missions SET status='${status}' WHERE id='${missionId}' changed ${info.changes} rows`
      );
    }
  });
}

/** Every (tool, action) probe point the published surface exposes. */
function publishedProbePoints(): Array<{ tool: string; action: string | undefined }> {
  const out: Array<{ tool: string; action: string | undefined }> = [];
  for (const tool of RBOOK_TOOL_DEFINITIONS) {
    const actions = TOOL_ACTIONS.get(tool.name);
    if (actions === null || actions === undefined) out.push({ tool: tool.name, action: undefined });
    else for (const action of actions) out.push({ tool: tool.name, action });
  }
  return out;
}

/** s93-m06 draft probes: the texts of the drafts each setup seeds, found again by text. */
const S93_M06_DECLINED = 's93-m06 probe: keep one JSON file per decision, a declined draft.';
const S93_M06_EXPIRED = 's93-m06 probe: keep one JSON file per decision, a draft past its lease.';
const S93_M06_PENDING = 's93-m06 probe: keep one JSON file per decision, a pending draft.';
const S93_M06_CONSTRAINT = 's93-m06 probe: never push to main without a green CI run first.';

function seedDraft(
  dbPath: string,
  text: string,
  kind: string,
  ageDays: number,
  outcome: string
): void {
  withDb(dbPath, (db) => {
    db.exec(PROPOSALS_TABLE_SQL);
    if (db.prepare('SELECT 1 FROM proposals WHERE text = ?').get(text)) return;
    db.prepare('INSERT INTO proposals (text, kind, created_at, outcome) VALUES (?, ?, ?, ?)').run(
      text,
      kind,
      new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      outcome
    );
  });
}

function draftIdOf(dbPath: string, text: string): number {
  return withDb(dbPath, (db) => {
    const row = db.prepare('SELECT id FROM proposals WHERE text = ?').get(text) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`precondition not established: no draft "${text}"`);
    return row.id;
  });
}

/** s91-m04 self-supersede probe: the seeded row's text and its id, re-read by every setup. */
const S91_M04_SELF_TEXT = 's91-m04 axis-2 probe: a decision that names itself in supersedes';
let s91M04SelfId = 0;

const MATRIX: MatrixCase[] = [
  // ── AXIS 1 — mission status × the seven driven actions ────────────────────────────────────────
  ...MISSION_STATUSES.map(
    ({ status, reachable }): MatrixCase => ({
      axis: '1 mission-status',
      name: `mission status = ${status}`,
      reachable,
      setup: (ctx) => {
        setMissionStatus(ctx.dbPath, ctx.missionId, status);
        // The move target must be an OPEN sprint. Left closed, `rbook-mission-move.ts:178` (the
        // sprint-status refusal) fires first and MASKS :205 (unrecognized mission status) and
        // :215 (terminal mission) — measured, not assumed.
        withDb(ctx.dbPath, (db) =>
          db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId)
        );
      },
      calls: (ctx) => [
        ...DRIVEN_TRANSITIONS.map((action) => ({
          tool: 'rbook_mission_transition',
          params: {
            action,
            missionId: ctx.missionId,
            projectRoot: ctx.projectRoot,
            reason: 's89-m08 axis-1 probe',
            blockers: ['axis-1 probe'],
            resolution: 's89-m08 axis-1 probe',
            deferUntil: 'after the probe',
          },
        })),
        {
          tool: 'rbook_mission',
          params: {
            action: 'update',
            missionId: ctx.missionId,
            fields: { notes: 's89-m08 axis-1 probe (non-status field)' },
            projectRoot: ctx.projectRoot,
          },
        },
        // mission-move: a terminal mission, and a mission whose status is unrecognized.
        {
          tool: 'rbook_mission',
          params: {
            action: 'move',
            missionId: ctx.missionId,
            toSprintId: ctx.sprintId,
            projectRoot: ctx.projectRoot,
            reason: 's89-m08 axis-1 probe',
          },
        },
      ],
    })
  ),

  // ── AXIS 2 — row presence / absence ───────────────────────────────────────────────────────────
  {
    axis: '2 row-absence',
    name: 'every id names a row that does not exist',
    reachable: 'ordinary: an agent pastes a stale or mistyped id from an older answer',
    calls: (ctx) => [
      {
        tool: 'rbook_mission',
        params: { action: 'show', missionId: 'S89M08-ABSENT', projectRoot: ctx.projectRoot },
      },
      // s92-m08: expanding a preview by an id this project does not hold.
      {
        tool: 'rbook_decisions',
        params: { action: 'show', decisionId: 999_999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_learnings',
        params: { action: 'show', learningId: 999_999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_mission',
        params: {
          action: 'move',
          missionId: 'S89M08-ABSENT',
          toSprintId: ctx.sprintId,
          projectRoot: ctx.projectRoot,
        },
      },
      // Axis 1 deliberately OPENS the target sprint so :205/:215 stop being masked; this call
      // keeps the closed-target refusal (rbook-mission-move.ts:178) in the corpus.
      {
        tool: 'rbook_mission',
        params: {
          action: 'move',
          missionId: ctx.missionId,
          toSprintId: ctx.closedSprintId,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_mission_transition',
        params: { action: 'start', missionId: 'S89M08-ABSENT', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_sprint',
        params: { action: 'show', sprintId: 'sprint-89089', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_sprint',
        params: { action: 'retro', sprintId: 'sprint-89089', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_sprint',
        params: {
          action: 'carry_forward',
          sprintId: 'sprint-89089',
          targetAddress: 'rbook://derek/nowhere',
          send: false,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'next_steps',
          nextStepAction: 'carry',
          nextStepIds: [999999],
          carryToSprint: 'sprint-89089',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_sprint',
        params: {
          action: 'update',
          sprintId: 'sprint-89089',
          fields: { focus: 'x' },
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_session',
        params: {
          action: 'capture',
          sessionId: 'PS-ABSENT-000',
          category: 'decision',
          content: 'probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_session',
        params: {
          action: 'complete',
          sessionId: 'PS-ABSENT-000',
          summary: 'probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_decisions',
        params: {
          action: 'update',
          decisionId: 999_999,
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_decisions',
        params: {
          action: 'update',
          decisionId: 1,
          supersededBy: 999_999,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_learnings',
        params: {
          action: 'update',
          learningId: 999_999,
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_learnings',
        params: { action: 'reaffirm', learningId: 999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_feedback',
        params: { action: 'resolve', feedbackId: 999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_db',
        params: {
          action: 'restore',
          snapshotId: 'snapshot-absent',
          confirm: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_project',
        params: {
          action: 'unregister',
          projectRoot: path.join(os.tmpdir(), 's89m08-never-registered'),
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'constraints',
          constraintAction: 'archive',
          missionId: 'S89M08-ABSENT',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_message',
        params: { action: 'get', messageId: 'msg-absent-000', projectRoot: ctx.projectRoot },
      },
      // s91-m04: a supersedes target that does not exist.
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: 's91-m04 axis-2 probe: supersedes an absent decision',
          supersedes: [999_999_999],
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 'record names its own already-recorded text in supersedes',
    reachable:
      'ordinary: rbook_decisions(record) retried with supersedes naming the id the first call ' +
      "returned; SQL-forced here because a matrix call cannot read a previous call's id",
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        // Establish, never inherit (#547). The record call authors under its caller's own explicit
        // session, else the newest active KEYLESS explicit session, else its own implicit one
        // (session-owner.ts), so the seeded row must carry that author. The matrix's server owns no
        // session, and an explicit session started inside a harness carries that harness's key, as
        // a sprint close's own session does: borrowing it left the seeded row's author unmatched.
        const sessionColumns = new Set(
          (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
            (column) => column.name
          )
        );
        const explicitOnly = sessionColumns.has('implicit') ? 'AND implicit = 0' : '';
        const keylessOnly = sessionColumns.has('owner_key') ? 'AND owner_key IS NULL' : '';
        let session = db
          .prepare(
            `SELECT id FROM sessions WHERE status = 'active' ${explicitOnly} ${keylessOnly}
              ORDER BY started_at DESC LIMIT 1`
          )
          .get() as { id: string } | undefined;
        if (!session) {
          session = { id: 'PS-S91M04-SELF-SUPERSEDE' };
          const sessionSeq = (
            db.prepare('SELECT COALESCE(MAX(origin_seq), 0) + 1 AS n FROM sessions').get() as {
              n: number;
            }
          ).n;
          db.prepare(
            `INSERT INTO sessions (id, type, title, status, started_at, project_id,
               stable_event_id, occurred_at, origin_seq, event_type, schema_version)
             VALUES (?, 'custom', 's91-m04 self-supersede probe', 'active', ?, 'cmos-mcp-pro',
               '01S91M04SELFSUPERSESSION00', ?, ?, 'session_started', 1)`
          ).run(session.id, new Date().toISOString(), Date.now(), sessionSeq);
        }
        const author = session.id;
        const existing = db
          .prepare(
            'SELECT id FROM strategic_decisions WHERE decision_text = ? AND author_session_id IS ?'
          )
          .get(S91_M04_SELF_TEXT, author) as { id: number } | undefined;
        if (existing) {
          s91M04SelfId = existing.id;
          return;
        }
        const seq = (
          db
            .prepare('SELECT COALESCE(MAX(origin_seq), 0) + 1 AS n FROM strategic_decisions')
            .get() as {
            n: number;
          }
        ).n;
        const info = db
          .prepare(
            `INSERT INTO strategic_decisions (decision_text, created_at, status, author_session_id,
               project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
             VALUES (?, ?, 'active', ?, 'cmos-mcp-pro', '01S91M04SELFSUPERSEDE00000', ?, ?,
               'decision_captured', 1)`
          )
          .run(S91_M04_SELF_TEXT, new Date().toISOString(), author, Date.now(), seq);
        s91M04SelfId = Number(info.lastInsertRowid);
      });
    },
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: S91_M04_SELF_TEXT,
          supersedes: [s91M04SelfId],
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's94-m04: a draft cannot approve extra caller fields',
    reachable: 'ordinary: a record combines fromDraft with new context',
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: 'Preserve the approved scope.',
          fromDraft: 'P999',
          context: 'Unapproved addition.',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: fromDraft is not a draft id',
    reachable: 'ordinary: an agent passes an id of another kind (a decision number with a prefix)',
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: 'Use one JSON file per decision because diffs stay readable.',
          fromDraft: 'D1',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: fromDraft names no draft in this store',
    reachable: 'ordinary: an agent names a draft id from another project, or a stale id',
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: 'Use one JSON file per decision because diffs stay readable.',
          fromDraft: 'P987654',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: the draft was already answered (declined)',
    reachable: 'ordinary: the operator declined the draft, then an agent records it anyway',
    setup: (ctx) => seedDraft(ctx.dbPath, S93_M06_DECLINED, 'decision', 0, 'declined'),
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: S93_M06_DECLINED,
          fromDraft: `P${draftIdOf(ctx.dbPath, S93_M06_DECLINED)}`,
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: the draft expired unanswered',
    reachable: 'ordinary: nobody answered a draft for over a week, then an agent records it',
    setup: (ctx) => seedDraft(ctx.dbPath, S93_M06_EXPIRED, 'decision', 8, 'pending'),
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: S93_M06_EXPIRED,
          fromDraft: `P${draftIdOf(ctx.dbPath, S93_M06_EXPIRED)}`,
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: the content does not state the draft',
    reachable: 'ordinary: an agent records a different decision under an approved draft id',
    setup: (ctx) => seedDraft(ctx.dbPath, S93_M06_PENDING, 'decision', 0, 'pending'),
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: 'Adopt Postgres for the analytics warehouse, the team already runs it.',
          fromDraft: `P${draftIdOf(ctx.dbPath, S93_M06_PENDING)}`,
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m06: a constraint draft with no operator words in this session',
    reachable:
      'ordinary: a harness without Reasonbook hooks (or another session) records a constraint draft',
    setup: (ctx) => seedDraft(ctx.dbPath, S93_M06_CONSTRAINT, 'constraint', 0, 'pending'),
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: {
          action: 'record',
          content: S93_M06_CONSTRAINT,
          fromDraft: `P${draftIdOf(ctx.dbPath, S93_M06_CONSTRAINT)}`,
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 's93-m12: a re-init names a project id the project does not have',
    reachable:
      'ordinary: an agent re-runs init on an existing project and passes a project id of its own',
    calls: (ctx) => [
      {
        tool: 'rbook_project',
        params: { action: 'init', projectRoot: ctx.projectRoot, projectId: 'not-this-project' },
      },
    ],
  },
  {
    axis: '6 parameter-value',
    name: 's95-m06: a Ledger init is given an initial sprint',
    reachable:
      'ordinary: an agent follows an older quick start that passes an initial sprint at the Ledger level',
    calls: (ctx) => [
      {
        tool: 'rbook_project',
        params: {
          action: 'init',
          projectRoot: ctx.projectRoot,
          projectType: 'general',
          initialSprint: { id: 's95-m06-oracle', title: 'Oracle sprint' },
        },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 'the id names a row that ALREADY exists',
    reachable: 'ordinary: an agent re-runs an add it already ran',
    calls: (ctx) => [
      {
        tool: 'rbook_mission',
        params: {
          action: 'add',
          missionId: ctx.missionId,
          name: 'dup',
          sprintId: ctx.sprintId,
          objective: 'dup',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_sprint',
        params: {
          action: 'add',
          sprintId: ctx.sprintId,
          title: 'dup',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 3 — session lifecycle ────────────────────────────────────────────────────────────────
  {
    axis: '3 session-lifecycle',
    name: 'no session is active',
    reachable: 'ordinary: the previous session was completed, or none was ever started',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) =>
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`).run()
      );
    },
    calls: (ctx) => [
      {
        tool: 'rbook_session',
        params: {
          action: 'capture',
          category: 'decision',
          content: 's89-m08 axis-3 probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_session',
        params: {
          action: 'complete',
          summary: 's89-m08 axis-3 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '3 session-lifecycle',
    name: 'a session is already active',
    reachable: 'ordinary: rbook_session(action="start") was called and not completed',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row to activate');
        // s92-m03: started NOW. A start closes an explicit blocker idle past 12 h, so only a live
        // blocker still reaches the SESSION_ALREADY_ACTIVE refusal. Do not inherit the most
        // recent real session's ownership: this case is an explicit, keyless session.
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`).run();
        db.prepare(
          `UPDATE sessions SET status = 'active', implicit = 0, owner_key = NULL,
          started_at = ?, completed_at = NULL WHERE id = ?`
        ).run(new Date().toISOString(), row.id);
      });
    },
    calls: (ctx) => [
      {
        tool: 'rbook_session',
        params: {
          action: 'start',
          title: 's89-m08 axis-3 probe',
          type: 'custom',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '3 session-lifecycle',
    name: 'a completion whose free text absorbed a sibling that did not arrive',
    reachable:
      'WITNESSED LIVE (Stage1, five completions): a host drops a closing tag and a sibling array is ' +
      'absorbed into notes/summary as a literal <parameter name="..."> token',
    setup: (ctx) => {
      setMissionStatus(ctx.dbPath, ctx.missionId, 'In Progress');
      withDb(ctx.dbPath, (db) => {
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row to activate');
        // The retry without sessionId must find this explicit session, not inherit another
        // process's implicit owner from whichever live row happened to be newest at freeze time.
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`).run();
        db.prepare(
          `UPDATE sessions SET status = 'active', implicit = 0, owner_key = NULL,
          started_at = ?, completed_at = NULL WHERE id = ?`
        ).run(new Date().toISOString(), row.id);
      });
    },
    calls: (ctx) => [
      {
        tool: 'rbook_mission_transition',
        params: {
          action: 'complete',
          missionId: ctx.missionId,
          notes: 's91-m03 probe <parameter name="decisions">["lost"]',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_session',
        params: {
          action: 'complete',
          summary: 's91-m03 probe <parameter name="nextSteps">["lost"]',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '3 session-lifecycle',
    name: "the named session is another live process's implicit session",
    reachable:
      'ordinary since 3.2.0: two server processes share a store, and one passes the id of the ' +
      "other's implicit session to rbook_session(complete)",
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        const columns = (
          db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        if (!columns.includes('implicit')) {
          db.exec(`ALTER TABLE sessions ADD COLUMN implicit INTEGER NOT NULL DEFAULT 0`);
        }
        if (!columns.includes('owner_key')) {
          db.exec(`ALTER TABLE sessions ADD COLUMN owner_key TEXT`);
        }
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row to hand to another process');
        // A live owner (this pid) with a different start time is another process, and current.
        db.prepare(
          `UPDATE sessions SET status = 'active', implicit = 1, owner_key = ?, started_at = ?
            WHERE id = ?`
        ).run(processOwnerKey(process.pid, 1), new Date().toISOString(), row.id);
      });
    },
    calls: (ctx) => {
      const id = withDb(
        ctx.dbPath,
        (db) =>
          (
            db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as {
              id: string;
            }
          ).id
      );
      return [
        {
          tool: 'rbook_session',
          params: {
            action: 'complete',
            sessionId: id,
            summary: 's92-m03 axis-3 probe',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_session',
          params: {
            action: 'capture',
            sessionId: id,
            category: 'decision',
            content: 's92-m03 axis-3 probe: a write into another process’s implicit session',
            projectRoot: ctx.projectRoot,
          },
        },
      ];
    },
  },
  {
    axis: '3 session-lifecycle',
    name: 'the named session exists but is already completed',
    reachable: 'ordinary: an agent passes the id of a session it already closed',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row');
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE id = ?`).run(row.id);
      });
    },
    calls: (ctx) => {
      const id = withDb(
        ctx.dbPath,
        (db) =>
          (
            db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as {
              id: string;
            }
          ).id
      );
      return [
        {
          tool: 'rbook_session',
          params: {
            action: 'complete',
            sessionId: id,
            summary: 'probe',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_session',
          params: {
            action: 'capture',
            sessionId: id,
            category: 'decision',
            content: 'probe',
            projectRoot: ctx.projectRoot,
          },
        },
      ];
    },
  },

  // ── AXIS 4 — sprint lifecycle ─────────────────────────────────────────────────────────────────
  {
    axis: '4 sprint-lifecycle',
    name: 'the sprint is already Completed',
    reachable: 'ordinary: rbook_sprint(action="complete") already ran for that sprint',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) =>
        db.prepare(`UPDATE sprints SET status = 'Completed' WHERE id = ?`).run(ctx.sprintId)
      );
    },
    calls: (ctx) => [
      {
        tool: 'rbook_sprint',
        params: {
          action: 'complete',
          sprintId: ctx.sprintId,
          summary: 's89-m08 axis-4 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '4 sprint-lifecycle',
    name: 'the sprint is Active and still holds open missions',
    reachable: 'ordinary: closeout attempted before the queue is drained',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId);
        const info = db
          .prepare(`UPDATE missions SET status = 'In Progress', completed_at = NULL WHERE id = ?`)
          .run(ctx.missionId);
        if (info.changes !== 1) throw new Error('axis-4 driver mission was not found');
        db.prepare(`UPDATE missions SET sprint_id = ? WHERE id = ?`).run(
          ctx.sprintId,
          ctx.missionId
        );
      });
    },
    calls: (ctx) => [
      {
        tool: 'rbook_sprint',
        params: {
          action: 'complete',
          sprintId: ctx.sprintId,
          summary: 's89-m08 axis-4 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 5 — required-parameter omission, one (tool, action) at a time ────────────────────────
  {
    axis: '5 parameter-omission',
    name: 'every published (tool, action) called with nothing but its action',
    reachable: 'ordinary: an agent calls a tool before reading which parameters the action needs',
    calls: (ctx) =>
      publishedProbePoints().map(({ tool, action }) => ({
        tool,
        params:
          action === undefined
            ? { projectRoot: ctx.projectRoot }
            : { action, projectRoot: ctx.projectRoot },
      })),
  },
  {
    axis: '5 parameter-omission',
    name: 's93-m11: init without its folder, and list asked to prune',
    reachable:
      'ordinary: an agent calls init before choosing a folder, or asks list to tidy the registry',
    calls: () => [
      { tool: 'rbook_project', params: { action: 'init' } },
      { tool: 'rbook_project', params: { action: 'list', validate: true, prune: true } },
    ],
  },
  {
    axis: '5 parameter-omission',
    name: 's93-m11: a since an agent wrote in words',
    reachable: 'ordinary: an agent asks for decisions "since last week"',
    calls: (ctx) => [
      {
        tool: 'rbook_decisions',
        params: { action: 'list', since: 'last week', projectRoot: ctx.projectRoot },
      },
    ],
  },
  {
    axis: '5 parameter-omission',
    name: 'an action token that is not in the published enum',
    reachable: 'ordinary: an agent invents an action name, or uses one from an older version',
    calls: (ctx) => [
      { tool: 'rbook_mission', params: { action: 'frobnicate', projectRoot: ctx.projectRoot } },
      {
        tool: 'rbook_context',
        params: {
          action: 'next_steps',
          nextStepAction: 'frobnicate',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'constraints',
          constraintAction: 'frobnicate',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 6 — parameter VALUE violations ───────────────────────────────────────────────────────
  {
    axis: '6 parameter-value',
    name: 'bad enum, empty string, out-of-range and malformed dot-notation paths',
    reachable: 'ordinary: an agent guesses a value shape instead of reading the schema',
    calls: (ctx) => [
      // The four `applyNestedFieldUpdate` returns. `contextType` MUST be master_context or
      // project_context: `runManualUpdate` types it as that union, and `project_identity` is
      // handled by a DIFFERENT module (rbook-context-project-identity.ts), so a project_identity
      // update never reaches these four sites at all. Measured, not assumed.
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: '   ', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: 'a..b', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: '__proto__.polluted', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // A path whose PARENT segment resolves to a non-object. Both updates are applied in order
      // against the same content, so the first establishes the string the second walks into.
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [
            { path: 's89m08_probe', value: 'a string, not an object' },
            { path: 's89m08_probe.child', value: 'x' },
          ],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: { action: 'update', contextType: 'master_context', projectRoot: ctx.projectRoot },
      },
      // s92-m09: a snapshot source Reasonbook reserves for its own automatic copies; a prune would read
      // the snapshot as one of them, so it is refused.
      {
        tool: 'rbook_context',
        params: {
          action: 'snapshot',
          contextType: 'master_context',
          source: 'Context update: a name the server reserves',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'view',
          contextType: 'master_context',
          sizeOnly: true,
          compact: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      // `project_identity` is NOT an action of rbook_context (the enum is view/update/condense/
      // snapshot/history/next_steps/constraints); it is a contextType on `update`.
      {
        tool: 'rbook_context',
        params: { action: 'update', contextType: 'project_identity', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'not_a_known_field', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // A DOTTED path that is not `type_fields.*` — the shape rbook-context-project-identity.ts:105
      // exists to refuse. An unknown TOP-LEVEL name is accepted, so it does not reach that site.
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'not_type_fields.child', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // An EMPTY segment is what applyProjectIdentityFieldUpdate actually refuses (project-identity.ts:403);
      // an unknown top-level name and an unknown dotted prefix are both accepted, measured.
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'a..b', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: '', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_context',
        params: {
          action: 'constraints',
          constraintAction: 'archive',
          constraintIds: [999_999],
          projectRoot: ctx.projectRoot,
        },
      },
      // `rbook-constraints.ts:387` is inside reaffirmConstraint (line 370), NOT archiveConstraints.
      {
        tool: 'rbook_context',
        params: {
          action: 'constraints',
          constraintAction: 'reaffirm',
          constraintId: 999_999,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_decisions',
        params: {
          action: 'batch_update',
          decisionIds: Array.from({ length: 200 }, (_, i) => i + 1),
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_decisions',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_learnings',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_learnings',
        params: { action: 'list', acrossProjects: true, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_session',
        params: {
          action: 'capture',
          category: 'decision',
          content: 'probe',
          evergreen: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_db',
        params: { action: 'restore', snapshotId: 'snapshot-absent', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_db',
        params: {
          action: 'restore',
          snapshotId: '../etc/passwd',
          confirm: true,
          projectRoot: ctx.projectRoot,
        },
      },
      { tool: 'rbook_db', params: { action: 'purge', projectRoot: ctx.projectRoot } },
      {
        tool: 'rbook_project',
        params: { action: 'init', projectRoot: path.join(os.tmpdir(), 's89m08-does-not-exist') },
      },
      {
        tool: 'rbook_project',
        params: { action: 'init', projectRoot: path.join(REPO_ROOT, 'package.json') },
      },
      {
        tool: 'rbook_mission',
        params: {
          action: 'update',
          missionId: ctx.missionId,
          fields: {},
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_sprint',
        params: {
          action: 'update',
          sprintId: ctx.sprintId,
          fields: {},
          projectRoot: ctx.projectRoot,
        },
      },
      { tool: 'rbook_auth', params: { action: 'revoke', projectRoot: undefined } },
      { tool: 'rbook_auth', params: { action: 'reissue' } },
    ],
  },

  // ── AXIS 7 — dependency-edge presence ─────────────────────────────────────────────────────────
  {
    axis: '7 dependency-edge',
    name: 'self-edge, absent edge, and an edge that already exists',
    reachable: 'ordinary: an agent wires the same dependency twice, or points a mission at itself',
    calls: (ctx) => {
      const other = withDb(ctx.dbPath, (db) => {
        const row = db
          .prepare(`SELECT id FROM missions WHERE id != ? LIMIT 1`)
          .get(ctx.missionId) as { id: string } | undefined;
        if (!row) throw new Error('frozen source has fewer than two missions');
        return row.id;
      });
      return [
        {
          tool: 'rbook_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: ctx.missionId,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_mission',
          params: {
            action: 'undepends',
            fromId: ctx.missionId,
            toId: other,
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: other,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: other,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
      ];
    },
  },

  // ── AXIS 8 — contexts-row absence ─────────────────────────────────────────────────────────────
  ...(['master_context', 'project_context', 'project_identity'] as const).map(
    (contextId): MatrixCase => ({
      axis: '8 contexts-row-absence',
      name: `contexts row '${contextId}' is absent`,
      reachable:
        'UA-5 — forced by SQL. A supported sequence reaches it through a store created before that ' +
        'row existed, or a restore from a snapshot taken before it was added; rbook_project(init) ' +
        'writes all three today, so a fresh store cannot reach this state.',
      setup: (ctx) => {
        withDb(ctx.dbPath, (db) => {
          db.prepare(`DELETE FROM contexts WHERE id = ?`).run(contextId);
          const still = db.prepare(`SELECT 1 FROM contexts WHERE id = ?`).get(contextId);
          if (still) throw new Error(`contexts row '${contextId}' survived deletion`);
          // The sprint must be CLOSABLE, or rbook-sprint-complete's SPRINT_NOT_READY guard fires
          // first and masks :568/:579, the two contexts-row refusals this axis exists to reach.
          db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId);
          db.prepare(
            `UPDATE missions SET status = 'Completed', completed_at = COALESCE(completed_at, datetime('now')) WHERE sprint_id = ?`
          ).run(ctx.sprintId);
        });
      },
      calls: (ctx) => [
        {
          tool: 'rbook_context',
          params: { action: 'view', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'rbook_context',
          params: { action: 'condense', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'rbook_context',
          params: { action: 'update', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'rbook_context',
          params: {
            action: 'update',
            contextType: contextId,
            fieldUpdates: [{ path: 'description', value: 'probe' }],
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'rbook_sprint',
          params: {
            action: 'complete',
            sprintId: ctx.sprintId,
            summary: 's89-m08 axis-8 probe',
            projectRoot: ctx.projectRoot,
          },
        },
      ],
    })
  ),

  // ── AXIS 9 — the shared record (s96-m13) ──────────────────────────────────────────────────────
  // One store reaches the refusals the owner's own copy can meet. A member's copy, a second copy,
  // a delivery, a move or a recovery needs two copies the matrix does not build; those sites are
  // named residuals below, each with the test that drives it.
  {
    axis: '9 shared-record',
    name: 's96-m13: the shared record actions on an unshared store',
    reachable:
      'ordinary: an agent invites, removes or syncs before the project is shared, joins without naming the copy, shares under a name with a control character, or names a folder with no store',
    // The share a remedy prescribes needs an author name, as a person who shares sets one.
    setup: () => writeUserAuthor('Oracle Owner'),
    calls: (ctx) => [
      {
        tool: 'rbook_project',
        params: { action: 'invite', name: 'Darryl', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_project',
        params: { action: 'remove', name: 'Darryl', projectRoot: ctx.projectRoot },
      },
      { tool: 'rbook_project', params: { action: 'sync', projectRoot: ctx.projectRoot } },
      { tool: 'rbook_project', params: { action: 'join', projectRoot: ctx.projectRoot } },
      {
        tool: 'rbook_project',
        params: {
          action: 'share',
          authorName: `Bell${String.fromCodePoint(7)}`,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_project',
        params: { action: 'members', projectRoot: path.join(ctx.projectRoot, 'no-store-here') },
      },
    ],
  },
  {
    axis: '9 shared-record',
    name: 's96-m13: the shared record actions on a store its first call shares',
    reachable:
      'ordinary: the owner shares, shares again, invites a read-only member or a name with a control character, removes the owner, syncs before any copy joined, confirms a move it does not hold, settles what no copy contested, seeds a sprint by init, and restores a snapshot',
    setup: () => writeUserAuthor('Oracle Owner'),
    calls: (ctx) => [
      { tool: 'rbook_project', params: { action: 'share', projectRoot: ctx.projectRoot } },
      { tool: 'rbook_project', params: { action: 'share', projectRoot: ctx.projectRoot } },
      {
        tool: 'rbook_project',
        params: { action: 'invite', name: 'Rae', role: 'reader', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_project',
        params: {
          action: 'invite',
          name: `Bell${String.fromCodePoint(7)}`,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_project',
        params: { action: 'invite', name: 'oracle owner', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_project',
        params: { action: 'remove', name: 'Oracle Owner', projectRoot: ctx.projectRoot },
      },
      { tool: 'rbook_project', params: { action: 'sync', projectRoot: ctx.projectRoot } },
      {
        tool: 'rbook_project',
        params: { action: 'sync', confirmOwner: true, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'rbook_db',
        params: {
          action: 'settle',
          table: 'mission_dependencies',
          field: 'from_id',
          value: 'x',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_db',
        params: {
          action: 'settle',
          table: 'missions',
          recordId: ctx.missionId,
          field: 'status',
          value: 'Queued',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'rbook_project',
        params: {
          action: 'init',
          projectRoot: ctx.projectRoot,
          initialSprint: { id: 's96-m13-oracle', title: 'Oracle sprint' },
        },
      },
      {
        tool: 'rbook_db',
        params: {
          action: 'restore',
          snapshotId: 'any',
          confirm: true,
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '9 shared-record',
    name: 's96-m13: sharing a project whose git repository tracks its store',
    reachable: 'ordinary: a project commits its store, as cmos-mcp does (probe fact 29)',
    setup: (ctx) => {
      writeUserAuthor('Oracle Owner');
      execFileSync('git', ['init', '-q', ctx.projectRoot]);
      execFileSync('git', [
        '-C',
        ctx.projectRoot,
        'add',
        '-f',
        path.join('rbook', 'db', 'rbook.sqlite'),
      ]);
    },
    calls: (ctx) => [
      { tool: 'rbook_project', params: { action: 'share', projectRoot: ctx.projectRoot } },
    ],
  },
  {
    axis: '9 shared-record',
    name: 's96-m13: sharing a store whose stable-id index is not unique',
    reachable:
      'SQL-FORCED (UA-5): a hand-made index, or one an older tool made, holds the name of the unique stable-id index the share would make; prepareForSharing refuses rather than share rows two copies could not tell apart',
    setup: (ctx) => {
      writeUserAuthor('Oracle Owner');
      withDb(ctx.dbPath, (db) =>
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_learnings_stable_event_id_unique ON learnings (stable_event_id)'
        )
      );
    },
    calls: (ctx) => [
      { tool: 'rbook_project', params: { action: 'share', projectRoot: ctx.projectRoot } },
    ],
  },
];

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE CENSUS ARM — portable; runs in the public mirror too
// ───────────────────────────────────────────────────────────────────────────────────────────────

function runCensus(): CensusSite[] {
  const rows: CensusSite[] = [];
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('suggestion')) continue;
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'suggestion'
      ) {
        const init = node.initializer;
        const forwarding = ts.isPropertyAccessExpression(init) && init.name.text === 'suggestion';
        if (!forwarding) {
          const line = source.getLineAndCharacterOfPosition(init.getStart(source)).line + 1;
          const site = `${relative}:${line}`;
          let code: string | null = null;
          if (ts.isObjectLiteralExpression(node.parent)) {
            for (const prop of node.parent.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
                prop.name.text === 'code'
              ) {
                const value = prop.initializer;
                if (ts.isStringLiteralLike(value)) code = value.text;
                else {
                  const m = value.getText(source).match(/RBOOK_ERROR_CODES\.([A-Z_]+)/);
                  code = m ? m[1] : '<expr>';
                }
              }
            }
          }
          if (code === null) code = CONSUMER_RESOLVED_CODES[site] ?? null;
          const text = init.getText(source);
          rows.push({
            site,
            file: relative,
            line,
            code,
            triggerClass: triggerClassOf(code),
            callBearing: extractPrescribedCalls(text).length > 0,
            text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return rows;
}

/** Every `suggestion:` PropertyAssignment, including the forwarding ones — the 184 denominator. */
function countAllSuggestionSites(): { sites: number; forwarding: number; files: number } {
  let sites = 0;
  let forwarding = 0;
  const files = new Set<string>();
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('suggestion')) continue;
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'suggestion'
      ) {
        sites += 1;
        files.add(absolute);
        if (
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === 'suggestion'
        ) {
          forwarding += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { sites, forwarding, files: files.size };
}

const CENSUS = runCensus();
const DRIVEABLE = CENSUS.filter(
  (r) => r.triggerClass === 'VALIDATION' || r.triggerClass === 'STATE'
);
const DRIVEABLE_SITES = new Set(DRIVEABLE.map((r) => r.site));
const CALL_BEARING_DRIVEABLE = DRIVEABLE.filter((r) => r.callBearing);
const EXTERNAL = CENSUS.filter((row) => row.triggerClass === 'EXTERNAL');
const EXTERNAL_SITES = new Set(EXTERNAL.map((row) => row.site));
const FIRST_RUN_CODES = new Set(['RBOOK_NOT_DETECTED', 'DB_NOT_FOUND']);
const FIRST_RUN = CENSUS.filter((row) => row.code !== null && FIRST_RUN_CODES.has(row.code));
const FIRST_RUN_SITES = new Set(FIRST_RUN.map((row) => row.site));

/**
 * The two members the sanctioned dashboard/credential instrument still cannot construct.
 * Both ledger directions are checked below: an absent reason is unaccounted work; a reason for a
 * fired/non-universe site is stale bookkeeping.
 */
const EXTERNAL_RESIDUAL_REASONS: Readonly<Record<string, string>> = {
  // s96-m01 (fold): client.ts's write-lock tracking moves these down 55 lines; s96-m03 (fold): its
  // refusal of a transaction verb inside the change helper, 4 more; s96-m12: 8 more (a shared copy
  // opened during a call is noted, and the recording state moved to record-recording.ts); s97-m09: 7
  // more (the client option that skips sqlite-vec for the referee library).
  'src/tools/rbook/client.ts:937':
    '`validateProjectId()` has zero production callers; only direct unit tests invoke the method.',
  'src/tools/rbook/client.ts:945':
    'The second PROJECT_ID_MISMATCH arm is in the same production-unreachable `validateProjectId()` method.',
};

const HTTP_EXTERNAL_SITES = new Set([
  'src/tools/rbook/rbook-db-backfill.ts:470',
  'src/tools/rbook/rbook-db-backfill.ts:552',
  'src/tools/rbook/rbook-auth.ts:633',
  'src/tools/rbook/rbook-auth.ts:1222',
  'src/tools/rbook/rbook-auth.ts:1231',
  'src/tools/rbook/rbook-auth.ts:1239',
  'src/tools/rbook/rbook-message.ts:1092',
  'src/tools/rbook/errors.ts:430',
  'src/tools/rbook/errors.ts:446',
  'src/tools/rbook/errors.ts:465',
  'src/tools/rbook/errors.ts:477',
  'src/tools/rbook/errors.ts:485',
  'src/tools/rbook/errors.ts:505',
]);
const SYNTHETIC_EXTERNAL_SITES = new Set([
  'src/auth/dashboard-owner.ts:19',
  'src/tools/rbook/rbook-auth.ts:595',
  'src/tools/rbook/rbook-auth.ts:604',
  'src/tools/rbook/rbook-auth.ts:690',
  'src/tools/rbook/rbook-auth.ts:835',
  'src/tools/rbook/rbook-auth.ts:970',
  'src/tools/rbook/rbook-auth.ts:977',
  'src/tools/rbook/rbook-auth.ts:1159',
  'src/tools/rbook/rbook-auth.ts:1168',
  'src/tools/rbook/dashboard-client.ts:282',
  'src/tools/rbook/errors.ts:495',
]);

/** Shared with the private T7 ledger; the replay fence remains private and unchanged. */
const externalFiredSites = new Set<string>();
const externalScratchRoots = new Set<string>();
const externalCredentialPaths = new Set<string>();
const externalCredentialResolutions = new Map<string, string>();

describe('s89-m08 CENSUS — the universe re-derives at build time, never from a remembered number', () => {
  it('re-derives the sites / forwarding split and the ratified authored-base delta', () => {
    const { sites, forwarding, files } = countAllSuggestionSites();
    const authored = sites - forwarding;
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 census] sites=${sites} forwarding=${forwarding} authored=${authored} files=${files} ` +
        `callBearing=${CENSUS.filter((r) => r.callBearing).length}`
    );
    expect(CENSUS).toHaveLength(authored);
    // fold 4 — the RULE, not the number. A mission that adds an authored site enumerates it.
    expect(authored).toBe(
      RATIFIED_AUTHORED_BASE + RATIFIED_SITE_ADDS.length - RATIFIED_SITE_REMOVALS.length
    );
    expect(SITES_BY_MISSION['s90-m07']).toEqual([]);
  });

  it('finds no shorthand suggestion property, which this census cannot read (profile 9)', () => {
    const shorthand = (file: string, content: string): string[] => {
      const found: string[] = [];
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.ES2020, true);
      const visit = (node: ts.Node): void => {
        if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'suggestion')
          found.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
          );
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    const sites = walkTsFiles(SRC_ROOT).flatMap((absolute) => {
      const content = fs.readFileSync(absolute, 'utf8');
      return content.includes('suggestion')
        ? shorthand(path.relative(REPO_ROOT, absolute).split(path.sep).join('/'), content)
        : [];
    });
    expect(sites).toEqual([]);
    // The control: a remedy written in shorthand is found.
    expect(
      shorthand(
        'mutant.ts',
        'const refusal = (code: string, message: string, suggestion: string) => ({ code, message, suggestion });'
      )
    ).toEqual(['mutant.ts:1']);
  });

  it('publishes the trigger-class partition, total and disjoint', () => {
    const counts: Record<TriggerClass, number> = {
      VALIDATION: 0,
      STATE: 0,
      FAULT: 0,
      EXTERNAL: 0,
      UNTYPED: 0,
    };
    for (const row of CENSUS) counts[row.triggerClass] += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 partition] VALIDATION=${counts.VALIDATION} STATE=${counts.STATE} FAULT=${counts.FAULT} ` +
        `EXTERNAL=${counts.EXTERNAL} UNTYPED=${counts.UNTYPED} | driveable=${DRIVEABLE.length} ` +
        `complement=${CENSUS.length - DRIVEABLE.length} callBearingDriveable=${CALL_BEARING_DRIVEABLE.length}`
    );
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(CENSUS.length);
    expect(counts.VALIDATION + counts.STATE).toBe(DRIVEABLE.length);
  });

  it('PROVES every consumer-resolved premise instead of trusting its override', () => {
    // The four `rbook-context-update.ts` sites are bucketed by the code their ONE consumer stamps.
    // If a second consumer ever appears, that premise silently becomes false — so assert it.
    const content = fs.readFileSync(
      path.join(SRC_ROOT, 'tools', 'rbook', 'rbook-context-update.ts'),
      'utf8'
    );
    const callSites = content
      .split('\n')
      .filter((l) => /\bapplyNestedFieldUpdate\s*\(/.test(l) && !/^\s*function\b/.test(l));
    expect(callSites).toHaveLength(1);
    // ...and that single consumer is the one that stamps INVALID_PARAMETER.
    const consumerIndex = content.split('\n').findIndex((l) => l === callSites[0]);
    const window = content
      .split('\n')
      .slice(consumerIndex, consumerIndex + 10)
      .join('\n');
    expect(window).toContain('RBOOK_ERROR_CODES.INVALID_PARAMETER');
    expect(window).toContain('updateResult.suggestion');
    for (const site of Object.keys(CONSUMER_RESOLVED_CODES)) {
      expect(CENSUS.some((r) => r.site === site)).toBe(true);
    }

    const senderSourcePath = path.join(SRC_ROOT, 'intelligence', 'sender-context.ts');
    const senderSource = ts.createSourceFile(
      senderSourcePath,
      fs.readFileSync(senderSourcePath, 'utf8'),
      ts.ScriptTarget.ES2020,
      true
    );
    const constructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'SenderResolutionError'
      ) {
        constructions.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(senderSource);
    // s95: explicit Codex/address errors invalidate the old all-default premise. Enumerate
    // every construction, rejecting unknown expressions/codes instead of widening the bucket.
    const codes = constructions.map((construction) => {
      const argument = construction.arguments?.[2];
      if (!argument || (ts.isIdentifier(argument) && argument.text === 'undefined'))
        return 'SENDER_UNRESOLVABLE';
      expect(ts.isStringLiteralLike(argument)).toBe(true);
      return ts.isStringLiteralLike(argument) ? argument.text : '<unresolved>';
    });
    expect([...new Set(codes)].sort()).toEqual([
      'CODEX_CONTEXT_REQUIRED',
      'PROJECT_ADDRESS_UNRESOLVABLE',
      'SENDER_UNRESOLVABLE',
    ]);
    expect(codes.every((code) => triggerClassOf(code) === 'STATE')).toBe(true);
    expect(senderSource.text).toContain("code = 'SENDER_UNRESOLVABLE'");
    expect(fs.readFileSync(path.join(SRC_ROOT, 'tools', 'rbook', 'errors.ts'), 'utf8')).toContain(
      'code: string = RBOOK_ERROR_CODES.SENDER_UNRESOLVABLE'
    );
  });

  it('proves the s99-m10 additions inherit DASHBOARD_ERROR rather than parking them as untyped', () => {
    const file = 'src/tools/rbook/rbook-db-backfill.ts';
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      ts.ScriptTarget.ES2020,
      true
    );
    const sites: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === 'suggestion' &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const spread = node.parent.properties[0];
        if (
          spread &&
          ts.isSpreadAssignment(spread) &&
          ts.isCallExpression(spread.expression) &&
          spread.expression.expression.getText(source) === 'RbookErrors.dashboardError'
        ) {
          // No later property may replace the inherited error code.
          expect(node.parent.properties).toHaveLength(2);
          expect(node.parent.properties[1]).toBe(node);
          sites.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.initializer.getStart(source)).line + 1}`
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(sites).toEqual(SITES_BY_MISSION['s99-m10']);
    expect(RbookErrors.dashboardError('oracle classification proof').code).toBe('DASHBOARD_ERROR');
    for (const site of sites) {
      expect(CENSUS.find((row) => row.site === site)).toMatchObject({
        code: 'DASHBOARD_ERROR',
        triggerClass: 'EXTERNAL',
        callBearing: false,
      });
    }
  });

  it('re-adjudicates D-5 by measuring the prose share under a STATED predicate', () => {
    const noIdentifier = CENSUS.filter((r) => !carriesCheckableIdentifier(r.text));
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 D-5] authored=${CENSUS.length} carrying NO checkable identifier=${noIdentifier.length} ` +
        `(D-5 #1024 measured 75 of 176 under a predicate that was never recorded)`
    );
    // The claim is that a general SEMANTIC gate stays refused, so this must remain a large share.
    // Asserted as a floor on the REFUSAL's justification, not as a target to shrink.
    expect(noIdentifier.length).toBeGreaterThan(CENSUS.length / 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// T5 — EXTRACTOR COMPLETENESS (portable)
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('s89-m08 T5 — every authored suggestion naming a shipped tool yields an extractable prescription', () => {
  it('reports ZERO by RULE, so a ninth authoring syntax cannot appear silently', () => {
    const offenders = CENSUS.filter(
      (row) =>
        namedShippedTools(row.text).length > 0 && extractPrescribedCalls(row.text).length === 0
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 T5] authored naming a shipped tool=${CENSUS.filter((r) => namedShippedTools(r.text).length > 0).length} ` +
        `unextractable=${offenders.length} (RED entering the mission: 8)`
    );
    for (const offender of offenders) {
      // eslint-disable-next-line no-console
      console.log(
        `  UNEXTRACTABLE ${offender.site} :: ${offender.text.replace(/\s+/g, ' ').slice(0, 160)}`
      );
    }
    // The RULE — tool-name membership minus extractable prescriptions === 0. An allowlist of the
    // eight known sites would satisfy a count but not this, which is the point.
    expect(offenders.map((o) => o.site)).toEqual([]);
  });

  it('ANTI-VACUITY — the WIDENING still detects every surviving narrow-extractor witness', () => {
    // s85-m01's shipped `CALL_RE` requires a parenthesis. Under it alone, the eight CLASS-2 sites
    // name a shipped tool in a form no gate has ever executed. Reproducing that RED here is what
    // proves the green above is the widening's doing and not a weakened predicate.
    const narrowOffenders = CENSUS.filter((row) => {
      if (namedShippedTools(row.text).length === 0) return false;
      CALL_RE.lastIndex = 0;
      return !CALL_RE.test(row.text);
    }).map((row) => row.site);
    // eslint-disable-next-line no-console
    console.log(`[s89-m08 T5 anti-vacuity] narrow-extractor RED = ${narrowOffenders.length}`);
    for (const site of narrowOffenders) {
      // eslint-disable-next-line no-console
      console.log(`  narrow-RED ${site}`);
    }
    // s96-m08 removed the eighth witness with the old mutable-push implementation (:166).
    // Pin the seven surviving witnesses themselves, so a missing surface cannot hide in a count.
    expect(narrowOffenders).toEqual([
      'src/tools/rbook/errors.ts:402',
      'src/tools/rbook/errors.ts:411',
      'src/tools/rbook/rbook-decisions-update.ts:81',
      'src/tools/rbook/rbook-feedback.ts:324',
      'src/tools/rbook/rbook-learnings-reaffirm.ts:91',
      'src/tools/rbook/rbook-learnings-update.ts:104',
      'src/tools/rbook/rbook-sprint-complete.ts:577',
    ]);
  });

  it('every widened syntax is actually EXERCISED, so no branch is dead weight', () => {
    const bySyntax = new Map<string, string[]>();
    for (const row of CENSUS) {
      for (const call of extractPrescribedCalls(row.text)) {
        bySyntax.set(call.syntax, [...(bySyntax.get(call.syntax) ?? []), row.site]);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 T5 syntaxes] ${[...bySyntax].map(([k, v]) => `${k}=${v.length}`).join(' ')}`
    );
    for (const syntax of ['paren', 'with-action', 'bare-action'] as const) {
      expect(bySyntax.get(syntax)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// s90-m07 — THE PORTABLE EXTERNAL + FIRST-RUN INSTRUMENT
// ──────────────────────────────────────────────────────────────────────────────────────────────

const EXTERNAL_ENV_KEYS = [
  'RBOOK_CONFIG_DIR',
  'RBOOK_DASHBOARD_URL',
  'RBOOK_DASHBOARD_API_KEY',
  'RBOOK_DASHBOARD_USER',
  'RBOOK_DASHBOARD_PASSWORD',
] as const;

type ExternalEnvKey = (typeof EXTERNAL_ENV_KEYS)[number];
type CredentialShape = 'none' | 'user' | 'project' | 'two-user';

interface ExternalSeedOptions {
  seedProject?: boolean;
  registered?: boolean;
  credentials?: CredentialShape;
  legacyApiKey?: boolean;
  removeSlug?: boolean;
  projectName?: string;
  projectId?: string;
  slug?: string;
  rbookAddress?: string;
  dashboardUrl?: 'loopback' | 'unset';
}

interface ExternalCaseState {
  caseRoot: string;
  configDir: string;
  projectRoot: string;
  credentialsPath: string;
  dbPath?: string;
}

interface PortableEvidence extends DrivenCall {
  family: 'external-http' | 'external-synthetic' | 'driveable' | 'first-run';
  expectedCode: string;
  expectsHttp: boolean;
  fired: string[];
  requests: Array<{
    method: string;
    url: string;
    authorization: string;
    matchedScenario: boolean;
  }>;
}

interface PortableReplay {
  site: string;
  caseName: string;
  triggerCode: string | undefined;
  suggestion: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  thrown?: string;
  durationMs: number;
  resolverOutputs: string[];
  requests: PortableEvidence['requests'];
}

const portableEvidence: PortableEvidence[] = [];
const portableReplays: PortableReplay[] = [];
const blockedOutboundUrls: string[] = [];
const blockedTriggerOutboundUrls: string[] = [];
let externalFencePositiveControls = 0;
let externalTriggerFencePositiveControl = false;
const externalCredentialModes = new Map<string, number>();
let externalDouble!: DashboardDouble;
let savedExternalFetch: typeof fetch | undefined;
let externalCaseSeq = 0;
let externalReplaySnapshotSeq = 0;
let savedExternalEnv!: Record<ExternalEnvKey, string | undefined>;
let unknownRouteProbe!: { status: number; body: string };

interface IsolatedDashboardBoundary {
  double: DashboardDouble;
  configDir: string;
  blockedUrls: string[];
  positiveControlBlocked: boolean;
  sourceCredentialPath: string;
  mirrorCredentialPath?: string;
  close(): Promise<void>;
}

async function installIsolatedDashboardBoundary(label: string): Promise<IsolatedDashboardBoundary> {
  const savedEnv = Object.fromEntries(
    EXTERNAL_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<ExternalEnvKey, string | undefined>;
  const savedFetch = globalThis.fetch;
  const blockedUrls: string[] = [];
  const configDir = mkTmp(`rbook-${label}-config-`);
  const double = await startDashboardDouble({
    kind: 'device-code-error',
    expectedAuthorization: '',
    status: 503,
    body: { type: 'text', value: `${label} loopback boundary` },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    globalThis.fetch = savedFetch;
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    if (mirror?.root) resetMirroredExternalState();
    for (const key of EXTERNAL_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await double.close();
  };

  try {
    externalScratchRoots.add(fs.realpathSync(configDir));
    externalScratchRoots.add(double.scratchRoot);
    for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];
    process.env.RBOOK_CONFIG_DIR = configDir;
    process.env.RBOOK_DASHBOARD_URL = double.origin;
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    if (mirror?.root) resetMirroredExternalState();
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== double.origin) {
        blockedUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by ${label}: ${raw}`);
      }
      return savedFetch(...args);
    }) as typeof fetch;

    const probeUrl = 'http://127.0.0.1:1/s90-m08-positive-control';
    let positiveControlBlocked = false;
    try {
      await globalThis.fetch(probeUrl);
    } catch (error) {
      positiveControlBlocked =
        error instanceof Error && error.message.includes(`non-loopback fetch blocked by ${label}`);
    }
    if (!positiveControlBlocked || blockedUrls.pop() !== probeUrl) {
      throw new Error(`${label} boundary did not block and record its positive-control URL`);
    }
    const sourceCredentialPath = CredentialStore.getInstance().path;
    const mirrorCredentialPath = mirror?.root ? mirroredCredentialStorePath() : undefined;
    return {
      double,
      configDir,
      blockedUrls,
      positiveControlBlocked,
      sourceCredentialPath,
      mirrorCredentialPath,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function resetMirroredExternalState(): void {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { CredentialStore } = require(`${mirror.root}/intelligence/credential-store.js`) as {
    CredentialStore: { resetInstance(): void };
  };
  const { ProjectGraphRegistry } = require(
    `${mirror.root}/intelligence/project-graph-registry.js`
  ) as { ProjectGraphRegistry: { resetInstance(): void } };
  const { RbookDetector } = require(`${mirror.root}/intelligence/rbook-detector.js`) as {
    RbookDetector: { resetInstance(): void };
  };
  const { resetDeliveryAckCache } = require(`${mirror.root}/auth/delivery-ack-cache.js`) as {
    resetDeliveryAckCache(): void;
  };
  const { __resetDirectoryCacheForTesting } = require(
    `${mirror.root}/tools/rbook/rbook-message.js`
  ) as { __resetDirectoryCacheForTesting(): void };
  /* eslint-enable @typescript-eslint/no-var-requires */
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  resetDeliveryAckCache();
  __resetDirectoryCacheForTesting();
}

function mirroredCredentialStorePath(): string {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { CredentialStore } = require(`${mirror.root}/intelligence/credential-store.js`) as {
    CredentialStore: { getInstance(): { readonly path: string } };
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
  return CredentialStore.getInstance().path;
}

function restoreExternalEnvironment(): void {
  if (!savedExternalEnv) return;
  for (const key of EXTERNAL_ENV_KEYS) {
    const value = savedExternalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function markRegistered(dbPath: string): void {
  withDb(dbPath, (db) => {
    db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`).run(
      'dashboard_registered',
      'true'
    );
  });
}

function seedPortableState(label: string, options: ExternalSeedOptions = {}): ExternalCaseState {
  const safeLabel = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const caseRoot = path.join(
    externalDouble.scratchRoot,
    `${String(externalCaseSeq++).padStart(2, '0')}-${safeLabel}`
  );
  const configDir = path.join(caseRoot, 'config');
  const projectRoot = path.join(caseRoot, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  externalScratchRoots.add(caseRoot);
  externalScratchRoots.add(configDir);
  externalScratchRoots.add(projectRoot);

  for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];
  process.env.RBOOK_CONFIG_DIR = configDir;
  if (options.dashboardUrl !== 'unset') process.env.RBOOK_DASHBOARD_URL = externalDouble.origin;
  if (options.legacyApiKey) process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_legacy_fixture';

  let dbPath: string | undefined;
  if (options.seedProject !== false) {
    dbPath = seedRbookDb(projectRoot, {
      projectName: options.projectName ?? 'External Fixture',
      projectId: options.projectId ?? 'external-fixture',
      slug: options.slug ?? 'external-fixture',
      dashboardProjectId: options.registered ? '11111111-1111-4111-8111-111111111111' : undefined,
      rbookAddress: options.rbookAddress ?? 'rbook://local/external-fixture',
    });
    if (options.registered) markRegistered(dbPath);
    if (options.removeSlug) {
      withDb(dbPath, (db) => {
        db.prepare(`DELETE FROM metadata WHERE key = 'dashboard_slug'`).run();
      });
    }
  }

  const shape = options.credentials ?? 'none';
  const userKeys =
    shape === 'two-user'
      ? [
          { keyId: 'user-key-1', key: 'cmk_user_fixture_1' },
          { keyId: 'user-key-2', key: 'cmk_user_fixture_2' },
        ]
      : shape === 'user' || shape === 'project'
        ? [{ keyId: 'user-key-1', key: 'cmk_user_fixture_1' }]
        : [];
  const credentialsPath = seedTempCredentials({
    configDir,
    projectRoot,
    userKeys,
    ...(shape === 'project'
      ? {
          projectKey: {
            key: 'cmk_project_fixture',
            keyId: 'project-key-1',
            parentKeyId: 'user-key-1',
          },
        }
      : {}),
  });
  externalCredentialPaths.add(credentialsPath);
  externalCredentialModes.set(credentialsPath, fs.statSync(credentialsPath).mode & 0o777);
  resetMirroredExternalState();
  return {
    caseRoot,
    configDir,
    projectRoot,
    credentialsPath,
    ...(dbPath ? { dbPath } : {}),
  };
}

function externalReplayParams(
  prescription: PrescribedCall,
  state: ExternalCaseState
): Record<string, unknown> {
  const params: Record<string, unknown> = { projectRoot: state.projectRoot };
  if (prescription.action !== undefined) params.action = prescription.action;
  if (prescription.action === 'login_complete') {
    params.deviceCode = 'replay-device';
    params.pollIntervalSeconds = 0;
    params.maxWaitSeconds = 1;
  }
  if (prescription.action === 'revoke') params.keyId = 'project-key-1';
  return params;
}

function externalReplayScenario(prescription: PrescribedCall): DashboardScenario {
  if (['login', 'login_init', 'login_complete'].includes(prescription.action ?? '')) {
    return { kind: 'device-terminal', expectedAuthorization: '', outcome: 'approved' };
  }
  if (prescription.action === 'list') {
    return {
      kind: 'http',
      expected: { method: 'GET', path: '/api/keys', authorization: 'Bearer cmk_project_fixture' },
      status: 200,
      body: { type: 'json', value: { keys: [] } },
    };
  }
  if (prescription.action === 'reissue') {
    return {
      kind: 'http',
      expected: {
        method: 'POST',
        path: '/api/projects/11111111-1111-4111-8111-111111111111/keys/reissue',
        authorization: 'Bearer cmk_user_fixture_1',
      },
      status: 200,
      body: {
        type: 'json',
        value: {
          key: 'cmk_reissued_fixture',
          keyId: 'reissued-project-key',
          label: 'suggestion replay',
          revokedKeyIds: [],
        },
      },
    };
  }
  if (prescription.action === 'revoke') {
    return {
      kind: 'http',
      expected: {
        method: 'POST',
        path: '/api/keys/project-key-1/revoke',
        // s100-m02 (#717 item 3): a revoke goes with the machine's user key, never a project's.
        authorization: 'Bearer cmk_user_fixture_1',
      },
      status: 200,
      body: {
        type: 'json',
        value: { keyId: 'project-key-1', revokedAt: '2026-09-01T00:00:00.000Z' },
      },
    };
  }
  return {
    kind: 'http',
    expected: { method: 'GET', path: '/__unexpected-remedy__', authorization: '' },
    status: 599,
    body: { type: 'text', value: 'unexpected external remedy route' },
  };
}

async function replayPortableExternalRemedies(
  state: ExternalCaseState,
  trigger: DrivenCall
): Promise<void> {
  if (trigger.outcome !== 'REFUSES' || !trigger.suggestion) return;
  const externalCallBearingSites = trigger.sites.filter((site) =>
    EXTERNAL.some((row) => row.site === site && row.callBearing)
  );
  if (externalCallBearingSites.length === 0) return;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const dashboardModule = require(`${mirror.root}/tools/rbook/dashboard-client.js`) as {
    DEFAULT_DASHBOARD_URL: string;
    resolveDashboardBaseUrl(override?: string): string;
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
  const savedDefault = dashboardModule.DEFAULT_DASHBOARD_URL;
  const savedResolver = dashboardModule.resolveDashboardBaseUrl;
  const savedDashboardUrl = process.env.RBOOK_DASHBOARD_URL;
  const savedFetch = globalThis.fetch;
  const resolverOutputs: string[] = [];
  const snapshotRoot = path.join(
    externalDouble.scratchRoot,
    `replay-baseline-${String(externalReplaySnapshotSeq++).padStart(2, '0')}`
  );

  try {
    resetMirroredExternalState();
    fs.cpSync(state.caseRoot, snapshotRoot, { recursive: true });

    delete process.env.RBOOK_DASHBOARD_URL;
    dashboardModule.DEFAULT_DASHBOARD_URL = externalDouble.origin;
    if (savedResolver() !== externalDouble.origin) {
      throw new Error(
        'mirrored canonical dashboard default did not resolve to the loopback double'
      );
    }
    dashboardModule.resolveDashboardBaseUrl = (override?: string): string => {
      const resolved = savedResolver(override);
      resolverOutputs.push(resolved);
      return resolved;
    };
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== externalDouble.origin) {
        blockedOutboundUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by suggestion replay: ${raw}`);
      }
      return savedFetch(...args);
    }) as typeof fetch;

    const probeUrl = 'http://127.0.0.1:1/s90-m08-replay-positive-control';
    let positiveControlBlocked = false;
    try {
      await globalThis.fetch(probeUrl);
    } catch (error) {
      positiveControlBlocked =
        error instanceof Error &&
        error.message.includes('non-loopback fetch blocked by suggestion replay');
    }
    if (!positiveControlBlocked || blockedOutboundUrls.pop() !== probeUrl) {
      throw new Error('external replay fence did not block and record its positive-control URL');
    }
    externalFencePositiveControls += 1;

    const seen = new Set<string>();
    for (const site of externalCallBearingSites) {
      for (const prescription of extractPrescribedCalls(trigger.suggestion)) {
        const key = `${site}|${prescription.tool}|${prescription.action ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resetMirroredExternalState();
        fs.rmSync(state.caseRoot, { recursive: true, force: true });
        fs.cpSync(snapshotRoot, state.caseRoot, { recursive: true });
        resetMirroredExternalState();
        if (mirroredCredentialStorePath() !== state.credentialsPath) {
          throw new Error('external replay escaped its isolated credential store');
        }
        externalDouble.setScenario(externalReplayScenario(prescription));
        externalDouble.clearRequests();
        sink.reset();
        const resolverStart = resolverOutputs.length;
        const started = Date.now();
        const executed = await driveMirrored(
          `${trigger.caseName} remedy`,
          'external-replay',
          prescription.tool,
          externalReplayParams(prescription, state)
        );
        portableReplays.push({
          site,
          caseName: trigger.caseName,
          triggerCode: trigger.code,
          suggestion: trigger.suggestion,
          tool: prescription.tool,
          action: prescription.action,
          outcome: executed.outcome,
          code: executed.code,
          thrown: executed.thrown,
          durationMs: Date.now() - started,
          resolverOutputs: resolverOutputs.slice(resolverStart),
          requests: [...externalDouble.requests],
        });
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
    dashboardModule.resolveDashboardBaseUrl = savedResolver;
    dashboardModule.DEFAULT_DASHBOARD_URL = savedDefault;
    if (savedDashboardUrl === undefined) delete process.env.RBOOK_DASHBOARD_URL;
    else process.env.RBOOK_DASHBOARD_URL = savedDashboardUrl;
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

async function runPortableCase(options: {
  name: string;
  family: PortableEvidence['family'];
  expectedCode: string;
  expectsHttp: boolean;
  scenario: DashboardScenario;
  seed?: ExternalSeedOptions;
  tool: string;
  params: (state: ExternalCaseState) => Record<string, unknown>;
  setup?: (state: ExternalCaseState) => void;
  /** Efficacy probe: execute the named remedy from the same established state. */
  remedyTool?: string;
  remedyParams?: (state: ExternalCaseState) => Record<string, unknown>;
}): Promise<void> {
  const state = seedPortableState(options.name, options.seed);
  options.setup?.(state);
  // A setup may create another mirrored-detector-visible project.
  resetMirroredExternalState();
  const resolvedCredentialsPath = mirroredCredentialStorePath();
  externalCredentialResolutions.set(state.credentialsPath, resolvedCredentialsPath);
  if (resolvedCredentialsPath !== state.credentialsPath) {
    throw new Error(
      `mirrored CredentialStore resolved ${resolvedCredentialsPath}; expected isolated ${state.credentialsPath}`
    );
  }
  externalDouble.setScenario(options.scenario);
  externalDouble.clearRequests();
  sink.reset();
  const call = await driveMirrored(
    options.name,
    options.family,
    options.tool,
    options.params(state)
  );
  const fired = [...sink.fired].sort();
  for (const site of fired) externalFiredSites.add(site);
  portableEvidence.push({
    ...call,
    family: options.family,
    expectedCode: options.expectedCode,
    expectsHttp: options.expectsHttp,
    fired,
    requests: [...externalDouble.requests],
  });
  await replayPortableExternalRemedies(state, call);
  if (options.remedyParams) {
    const remedy = await driveMirrored(
      `${options.name} remedy`,
      options.family,
      options.remedyTool ?? options.tool,
      options.remedyParams(state)
    );
    expect({ caseName: options.name, outcome: remedy.outcome }).toEqual({
      caseName: options.name,
      outcome: 'SUCCEEDS',
    });
  }
}

/**
 * s92-m01 — the no-project refusal (`RbookErrors.noProjectForCall`) is produced at the DISPATCH
 * boundary, which the router matrix does not drive: dispatch resolves the project, and on refusal
 * classifies the resolver's evidence. Reach it the same way — the mirrored `resolveSenderContext`
 * followed by the mirrored `classifySenderResolutionError` — so the site is fired by shipped code
 * on a real filesystem state, not by calling the constructor directly.
 */
async function runMirroredResolutionCase(options: {
  name: string;
  expectedCode: string;
  mode: 'read' | 'write';
  checkRemedy?: boolean;
  metadata?: Record<string, unknown>;
  resolveOptions: (state: ExternalCaseState) => Record<string, unknown>;
}): Promise<void> {
  const state = seedPortableState(options.name, { seedProject: false });
  resetMirroredExternalState();
  // Same isolation proof as runPortableCase: the mirrored store must resolve to this case's file.
  const resolvedCredentialsPath = mirroredCredentialStorePath();
  externalCredentialResolutions.set(state.credentialsPath, resolvedCredentialsPath);
  if (resolvedCredentialsPath !== state.credentialsPath) {
    throw new Error(
      `mirrored CredentialStore resolved ${resolvedCredentialsPath}; expected isolated ${state.credentialsPath}`
    );
  }
  sink.reset();
  /* eslint-disable @typescript-eslint/no-var-requires */
  const senderModule = require(`${mirror.root}/intelligence/sender-context.js`) as {
    resolveSenderContext(opts: Record<string, unknown>): Promise<unknown>;
    SenderResolutionError: new (...args: never[]) => Error;
  };
  const refusalModule = require(`${mirror.root}/tools/rbook/sender-refusal.js`) as {
    classifySenderResolutionError(
      error: Error,
      mode: 'read' | 'write'
    ): Promise<{ code?: string; suggestion?: string }>;
  };
  const requestContext = require(
    `${mirror.root}/codex-request-context.js`
  ) as typeof import('../../../src/codex-request-context');
  /* eslint-enable @typescript-eslint/no-var-requires */
  let call: DrivenCall;
  try {
    await requestContext.withCodexRequest(options.metadata, () =>
      senderModule.resolveSenderContext(options.resolveOptions(state))
    );
    call = {
      caseName: options.name,
      axis: 'first-run',
      tool: 'dispatch-resolution',
      action: undefined,
      outcome: 'SUCCEEDS',
      sites: [],
    };
  } catch (error) {
    if (!(error instanceof senderModule.SenderResolutionError)) throw error;
    const refusal = await refusalModule.classifySenderResolutionError(error, options.mode);
    call = {
      caseName: options.name,
      axis: 'first-run',
      tool: 'dispatch-resolution',
      action: undefined,
      outcome: 'REFUSES',
      code: refusal.code,
      suggestion: refusal.suggestion,
      sites: attribute(refusal.suggestion),
    };
  }
  const fired = [...sink.fired].sort();
  for (const site of fired) externalFiredSites.add(site);
  portableEvidence.push({
    ...call,
    family: 'first-run',
    expectedCode: options.expectedCode,
    expectsHttp: false,
    fired,
    requests: [],
  });
  if (options.checkRemedy) {
    const prescriptions = extractPrescribedCalls(call.suggestion ?? '');
    expect(prescriptions).toHaveLength(1);
    for (const prescription of prescriptions) {
      const remedy = await driveMirrored(
        `${options.name} remedy`,
        'resolution-remedy',
        prescription.tool,
        { action: prescription.action, projectRoot: state.projectRoot }
      );
      expect(remedy.outcome).toBe('SUCCEEDS');
    }
  }
}

interface DirectDashboardUrlRead {
  site: string;
  canonical: boolean;
  syntax: 'dot' | 'element' | 'destructure' | 'setting';
}

function directDashboardUrlReadsInSource(
  relative: string,
  source: ts.SourceFile
): DirectDashboardUrlRead[] {
  const reads: DirectDashboardUrlRead[] = [];
  const isProcessEnv = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env';
  const recordsUrlName = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isComputedPropertyName(node)) return recordsUrlName(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text === 'RBOOK_DASHBOARD_URL';
    return (
      ts.isIdentifier(node) &&
      (node.text === 'RBOOK_DASHBOARD_URL' || node.text === 'RBOOK_DASHBOARD_URL_ENV')
    );
  };

  const add = (node: ts.Node, syntax: DirectDashboardUrlRead['syntax']): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    let owner: ts.Node | undefined = node.parent;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    reads.push({
      site: `${relative}:${line}`,
      canonical:
        relative === 'src/tools/rbook/dashboard-client.ts' &&
        !!owner &&
        ts.isFunctionDeclaration(owner) &&
        owner.name?.text === 'resolveDashboardBaseUrl',
      syntax,
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'getSetting' &&
      recordsUrlName(node.arguments[0])
    ) {
      add(node, 'setting');
    } else if (
      ts.isPropertyAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      node.name.text === 'RBOOK_DASHBOARD_URL'
    ) {
      add(node, 'dot');
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      recordsUrlName(node.argumentExpression)
    ) {
      add(node, 'element');
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isProcessEnv(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (recordsUrlName(element.propertyName ?? element.name)) add(element, 'destructure');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Spelling-independent over dot, element/constant-element and object-destructuring env reads. */
function directDashboardUrlReads(): DirectDashboardUrlRead[] {
  const reads: DirectDashboardUrlRead[] = [];
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('RBOOK_DASHBOARD_URL')) continue;
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    reads.push(...directDashboardUrlReadsInSource(relative, source));
  }
  return reads.sort((a, b) => a.site.localeCompare(b.site));
}

describe('s90-m07 PORTABLE EXTERNAL + FIRST-RUN LEDGER — loopback, never live credentials', () => {
  const NO_AUTH = '';
  const PROJECT_AUTH = 'Bearer cmk_project_fixture';
  const USER_AUTH = 'Bearer cmk_user_fixture_1';
  const noHttpScenario: DashboardScenario = {
    kind: 'http',
    expected: { method: 'GET', path: '/__unexpected-no-http__', authorization: NO_AUTH },
    status: 599,
    body: { type: 'text', value: 'an alleged no-HTTP case reached the dashboard double' },
  };

  beforeAll(async () => {
    savedExternalEnv = Object.fromEntries(
      EXTERNAL_ENV_KEYS.map((key) => [key, process.env[key]])
    ) as Record<ExternalEnvKey, string | undefined>;
    mirror = buildSuggestionMirror();
    sink = installSuggestionSink();
    sink.reset();
    mirrorRouters = loadMirrorRouters();
    externalDouble = await startDashboardDouble();
    externalScratchRoots.add(externalDouble.scratchRoot);
    savedExternalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== externalDouble.origin) {
        blockedTriggerOutboundUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by portable trigger: ${raw}`);
      }
      return savedExternalFetch!(...args);
    }) as typeof fetch;
    const triggerProbeUrl = 'http://127.0.0.1:1/s90-m08-trigger-positive-control';
    try {
      await globalThis.fetch(triggerProbeUrl);
    } catch (error) {
      externalTriggerFencePositiveControl =
        error instanceof Error &&
        error.message.includes('non-loopback fetch blocked by portable trigger');
    }
    if (
      !externalTriggerFencePositiveControl ||
      blockedTriggerOutboundUrls.pop() !== triggerProbeUrl
    ) {
      throw new Error('portable trigger fence did not block and record its positive-control URL');
    }
    externalDouble.setScenario({
      kind: 'http',
      expected: { method: 'GET', path: '/configured-only', authorization: NO_AUTH },
      status: 418,
      body: { type: 'text', value: 'configured route only' },
    });
    const unknownResponse = await fetch(`${externalDouble.origin}/never-stubbed`);
    unknownRouteProbe = { status: unknownResponse.status, body: await unknownResponse.text() };
    externalDouble.clearRequests();

    // The double matches paths without queries. Select its response before each real HTTP
    // request so the fallback receives a scoped failure followed by an empty global payload.
    for (const globalFallback of [false, true]) {
      const scenario: DashboardScenario = {
        kind: 'http',
        expected: { method: 'GET', path: '/api/sync/status', authorization: USER_AUTH },
        status: 200,
        body: {
          type: 'json',
          value: {
            success: true,
            data: {
              tables: [],
              totalMirrorRows: 0,
              totalSyncLogEntries: 0,
              unprocessedSyncLogEntries: 0,
              failedSyncLogEntries: 0,
              lastSyncAt: null,
              oldestUnprocessedAt: null,
              projectCount: 1,
            },
          },
        },
      };
      const fencedFetch = globalThis.fetch;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        const input = args[0];
        const raw =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw);
        if (url.origin === externalDouble.origin && url.pathname === '/api/sync/status') {
          externalDouble.setScenario({
            ...scenario,
            status: globalFallback && url.searchParams.has('projectSlug') ? 503 : 200,
          });
        }
        return fencedFetch(...args);
      }) as typeof fetch;
      try {
        await runPortableCase({
          name: `reconciliation refuses no comparisons (${globalFallback ? 'global fallback' : 'scoped'})`,
          family: 'external-http',
          expectedCode: 'DASHBOARD_ERROR',
          expectsHttp: true,
          scenario,
          seed: { credentials: 'user' },
          tool: 'rbook_db',
          params: ({ projectRoot }) => ({ action: 'reconcile', projectRoot }),
        });
        const evidence = portableEvidence[portableEvidence.length - 1];
        expect(evidence.fired).toContain(SITES_BY_MISSION['s99-m10'][globalFallback ? 1 : 0]);
        expect(evidence.suggestion).toMatch(/sync.status.*retry/i);
        expect(evidence.requests.map((request) => request.url)).toEqual(
          globalFallback
            ? ['/api/sync/status?projectSlug=external-fixture', '/api/sync/status']
            : ['/api/sync/status?projectSlug=external-fixture']
        );
      } finally {
        globalThis.fetch = fencedFetch;
      }
    }

    await runPortableCase({
      name: 'rotate refuses a recorded copy whose authority cannot be read',
      family: 'external-synthetic',
      expectedCode: 'DASHBOARD_OWNER_REQUIRED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true, credentials: 'project' },
      // SQL-FORCED (UA-5): a damaged shared copy fails closed as a member before credentials.
      // member-key-gates.test.ts separately drives this same site on actual joined member copies.
      setup: ({ dbPath }) =>
        withDb(dbPath!, (db) => {
          db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(
            'replica_id',
            'oracle-unreadable-authority'
          );
          db.exec('CREATE TABLE record_changes(change_id TEXT)');
        }),
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });

    await runPortableCase({
      name: 'rotate has no local project key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true, credentials: 'user' },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'rotate project is not dashboard registered',
      family: 'external-synthetic',
      expectedCode: 'PROJECT_NOT_REGISTERED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project' },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'rotate receives dashboard 401',
      family: 'external-http',
      expectedCode: 'DASHBOARD_AUTH_FAILED',
      expectsHttp: true,
      scenario: {
        kind: 'http',
        expected: {
          method: 'POST',
          path: '/api/projects/11111111-1111-4111-8111-111111111111/keys/rotate',
          authorization: PROJECT_AUTH,
        },
        status: 401,
        body: { type: 'json', value: { error: 'revoked fixture key' } },
      },
      seed: { credentials: 'project', registered: true },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'revoke cannot derive an absent project key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'revoke', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue project is not dashboard registered',
      family: 'external-synthetic',
      expectedCode: 'PROJECT_NOT_REGISTERED',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue has no device-code user credential',
      family: 'external-synthetic',
      expectedCode: 'DEVICE_CODE_REQUIRED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue selected a legacy unattributable credential',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_ATTRIBUTABLE',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true, legacyApiKey: true },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'logout explicit key is not a local user key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project' },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({
        action: 'logout',
        keyId: 'missing-user-key',
        projectRoot,
      }),
    });
    await runPortableCase({
      name: 'logout has no local user key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'logout', projectRoot }),
    });
    await runPortableCase({
      name: 'login device code expires',
      family: 'external-http',
      expectedCode: 'DEVICE_CODE_EXPIRED',
      expectsHttp: true,
      scenario: {
        kind: 'device-terminal',
        expectedAuthorization: NO_AUTH,
        outcome: 'expired_token',
        errorDescription: 'fixture terminal',
        deviceCode: 'dc-expired',
        expiresIn: 30,
      },
      seed: { seedProject: false },
      tool: 'rbook_auth',
      params: () => ({ action: 'login' }),
    });
    await runPortableCase({
      name: 'login device code is denied',
      family: 'external-http',
      expectedCode: 'DEVICE_CODE_ACCESS_DENIED',
      expectsHttp: true,
      scenario: {
        kind: 'device-terminal',
        expectedAuthorization: NO_AUTH,
        outcome: 'access_denied',
        errorDescription: 'fixture denied',
        deviceCode: 'dc-denied',
        expiresIn: 30,
      },
      seed: { seedProject: false },
      tool: 'rbook_auth',
      params: () => ({ action: 'login' }),
    });
    await runPortableCase({
      name: 'login init device endpoint fails',
      family: 'external-http',
      expectedCode: 'DASHBOARD_ERROR',
      expectsHttp: true,
      scenario: {
        kind: 'device-code-error',
        expectedAuthorization: NO_AUTH,
        status: 503,
        body: { type: 'text', value: 'dashboard down' },
      },
      seed: { seedProject: false },
      tool: 'rbook_auth',
      params: () => ({ action: 'login_init' }),
    });

    for (const statusCase of [
      {
        name: 'directory socket disconnect',
        expectedCode: 'DASHBOARD_UNREACHABLE',
        scenario: {
          kind: 'socket-disconnect',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 401',
        expectedCode: 'DASHBOARD_AUTH_FAILED',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 401,
          body: { type: 'json', value: { error: 'revoked fixture key' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 403',
        expectedCode: 'DASHBOARD_FORBIDDEN',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 403,
          body: { type: 'json', value: { error: 'forbidden', hint: 'fixture hint' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 404',
        expectedCode: 'DASHBOARD_NOT_FOUND',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 404,
          body: { type: 'json', value: { error: 'missing', hint: 'fixture hint' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 500',
        expectedCode: 'DASHBOARD_ERROR',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 500,
          body: { type: 'text', value: 'upstream exploded' },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 402',
        expectedCode: 'DASHBOARD_UPGRADE_REQUIRED',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 402,
          body: { type: 'text', value: 'upgrade required' },
        } as DashboardScenario,
      },
    ]) {
      await runPortableCase({
        ...statusCase,
        family: 'external-http',
        expectsHttp: true,
        seed: {
          credentials: 'project',
          registered: statusCase.expectedCode === 'DASHBOARD_AUTH_FAILED',
        },
        tool: 'rbook_message',
        params: ({ projectRoot }) => ({ action: 'directory', projectRoot }),
      });
    }

    await runPortableCase({
      name: 'directory has canonical default but no credential',
      family: 'external-synthetic',
      expectedCode: 'DASHBOARD_NOT_CONFIGURED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { dashboardUrl: 'unset' },
      tool: 'rbook_message',
      params: ({ projectRoot }) => ({ action: 'directory', projectRoot }),
    });

    let mismatchedAdvertisedRoot = '';
    await runPortableCase({
      name: 'send advertised roots mismatch the authoritative sender',
      family: 'external-http',
      expectedCode: 'SENDER_ATTRIBUTION_MISMATCH',
      expectsHttp: true,
      scenario: {
        kind: 'message-resolve-success',
        expectedAuthorization: USER_AUTH,
        resolved: {
          projectId: '33333333-3333-4333-8333-333333333333',
          projectName: 'Receiver',
          projectSlug: 'receiver',
        },
      },
      seed: {
        registered: true,
        credentials: 'user',
        projectName: 'Primary',
        projectId: 'primary',
        slug: 'primary',
        rbookAddress: 'rbook://local/primary',
      },
      setup: (state) => {
        mismatchedAdvertisedRoot = path.join(state.caseRoot, 'advertised-other');
        fs.mkdirSync(mismatchedAdvertisedRoot, { recursive: true });
        externalScratchRoots.add(mismatchedAdvertisedRoot);
        seedRbookDb(mismatchedAdvertisedRoot, {
          projectName: 'Other',
          projectId: 'other',
          slug: 'other',
          dashboardProjectId: '22222222-2222-4222-8222-222222222222',
          rbookAddress: 'rbook://local/other',
        });
      },
      tool: 'rbook_message',
      params: ({ projectRoot }) => ({
        action: 'send',
        targetAddress: 'rbook://target/receiver',
        type: 'question',
        summary: 's90-m07 portable sender mismatch',
        projectRoot,
        advertisedRoots: [mismatchedAdvertisedRoot],
      }),
    });

    await runPortableCase({
      name: 'purge expected slug differs from local identity',
      family: 'external-synthetic',
      expectedCode: 'EXPECTED_SLUG_MISMATCH',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project', projectName: 'Actual Project', slug: 'actual-project' },
      tool: 'rbook_db',
      params: ({ projectRoot }) => ({
        action: 'purge',
        confirm: true,
        expectedSlug: 'different-slug',
        projectRoot,
      }),
    });

    await runPortableCase({
      name: 'logout with two local user keys needs an explicit keyId',
      family: 'driveable',
      expectedCode: 'MISSING_PARAMETER',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'two-user' },
      tool: 'rbook_auth',
      params: ({ projectRoot }) => ({ action: 'logout', projectRoot }),
    });
    await runPortableCase({
      name: 'whoami cannot resolve a project without sender identity',
      family: 'driveable',
      expectedCode: 'SENDER_UNRESOLVABLE',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_message',
      params: ({ projectRoot }) => ({ action: 'whoami', projectRoot }),
    });
    await runPortableCase({
      name: 'message is absent from exact and bounded fallback reads',
      family: 'driveable',
      expectedCode: 'MESSAGE_NOT_FOUND',
      expectsHttp: true,
      scenario: { kind: 'message-not-found', expectedAuthorization: PROJECT_AUTH },
      seed: { credentials: 'project' },
      tool: 'rbook_message',
      params: ({ projectRoot }) => ({
        action: 'get',
        messageId: '44444444-4444-4444-8444-444444444444',
        projectRoot,
      }),
    });
    for (const action of ['clone', 'pull'] as const) {
      await runPortableCase({
        name: `${action} is retired before checking its dashboard slug`,
        family: 'driveable',
        expectedCode: 'LEGACY_SYNC_RETIRED',
        expectsHttp: false,
        scenario: noHttpScenario,
        seed: { credentials: 'project', removeSlug: true },
        tool: 'rbook_db',
        params: ({ projectRoot }) => ({ action, projectRoot }),
      });
    }

    for (const testCase of [
      { name: 'feedback needs content', argv: [], code: 'INVALID_PARAMETER' },
      {
        name: 'feedback refuses the review role',
        argv: ['--content', 'Report friction.'],
        code: 'READ_ONLY_AGENT',
        env: { RBOOK_AGENT_ROLE: 'review' },
      },
      {
        name: 'feedback preview has no usable text',
        argv: ['--content', '<parameter name="notes">artifact', '--dry-run'],
        code: 'INVALID_PARAMETER',
      },
      {
        name: 'feedback write has no usable text',
        argv: ['--content', '<parameter name="notes">artifact'],
        code: 'INVALID_PARAMETER',
      },
    ]) {
      await runPortableCase({
        name: testCase.name,
        family: 'driveable',
        expectedCode: testCase.code,
        expectsHttp: false,
        scenario: noHttpScenario,
        tool: 'cli_feedback',
        params: ({ projectRoot }) => ({ projectRoot, argv: testCase.argv, env: testCase.env }),
        remedyParams: ({ projectRoot }) => ({
          projectRoot,
          argv: ['--content', 'Report friction.'],
          env: { RBOOK_AGENT_ROLE: '' },
        }),
      });
    }
    await runPortableCase({
      name: 'feedback points at a missing project',
      family: 'first-run',
      expectedCode: 'RBOOK_NOT_DETECTED',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'cli_feedback',
      params: ({ projectRoot, caseRoot }) => ({
        projectRoot,
        argv: ['--content', 'Report friction.', '--project-root', path.join(caseRoot, 'missing')],
      }),
      remedyParams: ({ projectRoot }) => ({
        projectRoot,
        argv: ['--content', 'Report friction.', '--project-root', projectRoot],
      }),
    });
    await runPortableCase({
      name: 'fleet feedback cannot mutate a sibling',
      family: 'driveable',
      expectedCode: 'INVALID_PARAMETER',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_feedback',
      params: ({ projectRoot }) => ({
        action: 'triage',
        feedbackId: 1,
        acrossProjects: true,
        projectRoot,
      }),
    });

    await runPortableCase({
      name: 'register on an empty first-run root',
      family: 'first-run',
      expectedCode: 'RBOOK_NOT_DETECTED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      tool: 'rbook_project',
      params: ({ projectRoot }) => ({ action: 'register', projectRoot }),
    });
    await runPortableCase({
      name: 'health on an empty first-run root',
      family: 'first-run',
      expectedCode: 'RBOOK_NOT_DETECTED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      tool: 'rbook_db',
      params: ({ projectRoot }) => ({ action: 'health', projectRoot }),
    });
    await runPortableCase({
      name: 'health with rbook directory but no SQLite file',
      family: 'first-run',
      expectedCode: 'DB_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      setup: ({ projectRoot }) =>
        fs.mkdirSync(path.join(projectRoot, 'rbook', 'db'), { recursive: true }),
      tool: 'rbook_db',
      params: ({ projectRoot }) => ({ action: 'health', projectRoot }),
    });

    // s95-m13: these are constructible local refusals. Exercise their published list remedy
    // in the same isolated registry, rather than declaring new residuals just for the census.
    await runPortableCase({
      name: 'whoami refuses an unregistered address',
      family: 'driveable',
      expectedCode: 'PROJECT_ADDRESS_UNRESOLVABLE',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'rbook_message',
      params: () => ({ action: 'whoami', projectRoot: 'rbook://oracle/missing' }),
      remedyTool: 'rbook_project',
      remedyParams: () => ({ action: 'list' }),
    });
    await runPortableCase({
      name: 'project register requires a folder even when an address is well formed',
      family: 'driveable',
      expectedCode: 'PROJECT_FOLDER_REQUIRED',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'dispatch_project',
      params: () => ({ action: 'register', projectRoot: 'rbook://oracle/missing' }),
      remedyParams: () => ({ action: 'list' }),
    });
    await runMirroredResolutionCase({
      name: 'dispatch resolves an unregistered address to its list remedy',
      expectedCode: 'PROJECT_ADDRESS_UNRESOLVABLE',
      mode: 'read',
      checkRemedy: true,
      resolveOptions: () => ({
        explicitProjectRoot: 'rbook://oracle/missing',
        requireSenderIdentity: false,
      }),
    });
    await runMirroredResolutionCase({
      name: 'malformed Codex metadata preserves its distinct state refusal',
      expectedCode: 'CODEX_CONTEXT_REQUIRED',
      mode: 'read',
      metadata: { 'x-codex-turn-metadata': {}, sessionId: 'oracle-codex' },
      resolveOptions: () => ({ mcpRoots: [], requireSenderIdentity: false }),
    });

    // s92-m01 — the no-project refusal, in each situation the dispatcher can reach it from.
    for (const mode of ['read', 'write'] as const) {
      await runMirroredResolutionCase({
        name: `${mode} from a working folder that is not a Reasonbook project`,
        expectedCode: 'RBOOK_NOT_DETECTED',
        mode,
        resolveOptions: ({ projectRoot }) => ({
          cwdOverride: projectRoot,
          mcpRoots: [],
          requireSenderIdentity: false,
          serverProjectRootOverride: null,
        }),
      });
    }
    await runMirroredResolutionCase({
      name: 'contextless call with no default configured',
      expectedCode: 'RBOOK_NOT_DETECTED',
      mode: 'read',
      resolveOptions: ({ projectRoot }) => ({
        cwdOverride: projectRoot,
        homeDirOverride: projectRoot,
        mcpRoots: [],
        requireSenderIdentity: false,
        serverProjectRootOverride: null,
      }),
    });
  });

  afterAll(async () => {
    if (mirror?.root) resetMirroredExternalState();
    restoreExternalEnvironment();
    if (savedExternalFetch) globalThis.fetch = savedExternalFetch;
    if (externalDouble) await externalDouble.close();
  });

  it('drives every case to its named refusal with no crash or timeout', () => {
    const wrong = portableEvidence.filter(
      (entry) => entry.outcome !== 'REFUSES' || entry.code !== entry.expectedCode
    );
    for (const entry of wrong) {
      // eslint-disable-next-line no-console
      console.log(
        `  WRONG ${entry.caseName}: expected REFUSES/${entry.expectedCode}, got ${entry.outcome}/${entry.code ?? entry.thrown ?? '—'}`
      );
    }
    expect(wrong.map((entry) => entry.caseName)).toEqual([]);
  });

  it('uses loopback HTTP exactly for declared HTTP cases and never proxies an unknown route', () => {
    const transportMismatch = portableEvidence.filter(
      (entry) => entry.requests.length > 0 !== entry.expectsHttp
    );
    expect(transportMismatch.map((entry) => entry.caseName)).toEqual([]);
    const unmatchedRequests = portableEvidence.flatMap((entry) =>
      entry.requests
        .filter((request) => !request.matchedScenario)
        .map(
          (request) =>
            `${entry.caseName}: ${request.method} ${request.url} auth=${request.authorization || '<none>'}`
        )
    );
    expect(unmatchedRequests).toEqual([]);
    expect(externalTriggerFencePositiveControl).toBe(true);
    expect(blockedTriggerOutboundUrls).toEqual([]);
    expect(externalDouble.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(unknownRouteProbe.status).toBe(404);
    expect(unknownRouteProbe.body).toContain('Unstubbed dashboard route GET /never-stubbed');
    const mismatch = portableEvidence.find((entry) =>
      entry.caseName.startsWith('send advertised roots')
    );
    expect(mismatch?.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('EXTERNAL REPLAY — T2/T3/T4 apply to every reached call-bearing EXTERNAL site', () => {
    const universe = EXTERNAL.filter((row) => row.callBearing);
    const replayable = universe.filter((row) => externalFiredSites.has(row.site));
    const residual = universe.filter((row) => !externalFiredSites.has(row.site));
    const replayedSites = new Set(portableReplays.map((replay) => replay.site));
    const unstable = portableReplays.filter(
      (replay) => replay.outcome === 'CRASHES' || replay.outcome === 'TIMEOUT'
    );
    const reproduced = portableReplays.filter(
      (replay) =>
        replay.outcome === 'REFUSES' &&
        replay.code !== undefined &&
        replay.code === replay.triggerCode
    );
    const undisclosed = portableReplays.filter(
      (replay) => replay.outcome === 'REFUSES' && !disclosesCondition(replay.suggestion)
    );
    const refused = portableReplays.filter((replay) => replay.outcome === 'REFUSES');
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m08 external replay] universe=${universe.length} replayable=${replayable.length} ` +
        `residual=${residual.length} replayed-sites=${replayedSites.size} ` +
        `executions=${portableReplays.length} refused=${refused.length} ` +
        `T2-unstable=${unstable.length} ` +
        `T3-reproduced=${reproduced.length} T4-undisclosed=${undisclosed.length}`
    );
    for (const replay of reproduced) {
      // eslint-disable-next-line no-console
      console.log(
        `  EXTERNAL REMEDY REPRODUCES ${replay.code} :: ${replay.site} -> ` +
          `${replay.tool}(${replay.action ?? '—'})`
      );
    }
    expect([...replayedSites].sort()).toEqual(replayable.map((row) => row.site).sort());
    expect(residual.every((row) => EXTERNAL_RESIDUAL_REASONS[row.site])).toBe(true);
    expect(unstable).toEqual([]);
    expect(reproduced).toEqual([]);
    expect(undisclosed).toEqual([]);
  });

  it('EXTERNAL REPLAY — canonical default resolution is loopback-only and bounded', () => {
    const loginFamily = portableReplays.filter((replay) =>
      ['login', 'login_init', 'login_complete'].includes(replay.action ?? '')
    );
    const unmatched = portableReplays.flatMap((replay) =>
      replay.requests.filter((request) => !request.matchedScenario)
    );
    expect(loginFamily.length).toBeGreaterThan(0);
    expect(externalFencePositiveControls).toBeGreaterThan(0);
    expect(loginFamily.every((replay) => replay.resolverOutputs.length > 0)).toBe(true);
    expect(
      loginFamily.every((replay) =>
        replay.resolverOutputs.every((output) => output === externalDouble.origin)
      )
    ).toBe(true);
    expect(portableReplays.every((replay) => replay.durationMs < 5_000)).toBe(true);
    expect(unmatched).toEqual([]);
    expect(blockedOutboundUrls).toEqual([]);
  });

  it('EXTERNAL LEDGER — bidirectional E + R equals the re-derived universe', () => {
    const examined = [...EXTERNAL_SITES].filter((site) => externalFiredSites.has(site)).sort();
    const residual = [...EXTERNAL_SITES].filter((site) => !externalFiredSites.has(site)).sort();
    const callBearing = EXTERNAL.filter((row) => row.callBearing);
    const httpFired = new Set(
      portableEvidence
        .filter((entry) => entry.family === 'external-http')
        .flatMap((entry) => entry.fired)
        .filter((site) => EXTERNAL_SITES.has(site))
    );
    const syntheticFired = new Set(
      portableEvidence
        .filter((entry) => entry.family === 'external-synthetic')
        .flatMap((entry) => entry.fired)
        .filter((site) => EXTERNAL_SITES.has(site))
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 external] universe=${EXTERNAL.length} examined=${examined.length} ` +
        `http=${httpFired.size} synthetic=${syntheticFired.size} residual=${residual.length} ` +
        `real-credentials=0`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m08 external replay universe] rule=EXTERNAL&&callBearing count=${callBearing.length} ` +
        `sites=${callBearing
          .map(
            (row) =>
              `${row.site}->${extractPrescribedCalls(row.text)
                .map((call) => `${call.tool}(${call.action ?? '—'})`)
                .join('+')}`
          )
          .join(',')}`
    );
    for (const site of residual) {
      // eslint-disable-next-line no-console
      console.log(
        `  EXTERNAL RESIDUAL ${site} :: ${EXTERNAL_RESIDUAL_REASONS[site] ?? '*** MISSING ***'}`
      );
    }
    expect(examined.length + residual.length).toBe(EXTERNAL.length);
    expect(residual.filter((site) => !EXTERNAL_RESIDUAL_REASONS[site])).toEqual([]);
    expect(
      Object.keys(EXTERNAL_RESIDUAL_REASONS).filter((site) => !residual.includes(site))
    ).toEqual([]);
    expect([...httpFired].sort()).toEqual([...HTTP_EXTERNAL_SITES].sort());
    expect([...syntheticFired].sort()).toEqual([...SYNTHETIC_EXTERNAL_SITES].sort());
    expect([...httpFired].filter((site) => syntheticFired.has(site))).toEqual([]);
    expect(HTTP_EXTERNAL_SITES.size + SYNTHETIC_EXTERNAL_SITES.size + residual.length).toBe(
      EXTERNAL.length
    );
    expect(callBearing.length).toBeGreaterThan(0);
  });

  it('FIRST-RUN LEDGER — E + R equals its re-derived in-process universe with zero wire credit', () => {
    const examined = [...FIRST_RUN_SITES].filter((site) => externalFiredSites.has(site)).sort();
    const residual = [...FIRST_RUN_SITES].filter((site) => !externalFiredSites.has(site)).sort();
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 first-run] universe=${FIRST_RUN.length} examined=${examined.length} residual=${residual.length} ` +
        `scope=in-process-mirror wire-credit=0 (wire owner: s90-m04)`
    );
    expect(examined.length + residual.length).toBe(FIRST_RUN.length);
    expect(residual).toEqual([]);
  });

  it('allows one explicit-intent read; every effective dashboard URL uses the canonical resolver', () => {
    const syntheticSource = ts.createSourceFile(
      'synthetic-dashboard-url-reads.ts',
      `
        process.env.RBOOK_DASHBOARD_URL;
        process.env['RBOOK_DASHBOARD_URL'];
        process.env[RBOOK_DASHBOARD_URL_ENV];
        { const { RBOOK_DASHBOARD_URL } = process.env; void RBOOK_DASHBOARD_URL; }
        { const { RBOOK_DASHBOARD_URL: aliased } = process.env; void aliased; }
        { const { [RBOOK_DASHBOARD_URL_ENV]: computed } = process.env; void computed; }
        { const { ['RBOOK_DASHBOARD_URL']: literalComputed } = process.env; void literalComputed; }
        getSetting('RBOOK_DASHBOARD_URL');
        getSetting(RBOOK_DASHBOARD_URL_ENV);
      `,
      ts.ScriptTarget.ES2020,
      true
    );
    const syntheticReads = directDashboardUrlReadsInSource(
      'src/synthetic-dashboard-url-reads.ts',
      syntheticSource
    );
    expect(syntheticReads).toHaveLength(9);
    expect(syntheticReads.filter((read) => read.syntax === 'dot')).toHaveLength(1);
    expect(syntheticReads.filter((read) => read.syntax === 'element')).toHaveLength(2);
    expect(syntheticReads.filter((read) => read.syntax === 'destructure')).toHaveLength(4);
    expect(syntheticReads.filter((read) => read.syntax === 'setting')).toHaveLength(2);
    expect(syntheticReads.filter((read) => read.canonical)).toEqual([]);

    const reads = directDashboardUrlReads();
    const canonical = reads.filter((read) => read.canonical);
    const bypasses = reads.filter((read) => !read.canonical);
    // This startup check asks whether the operator EXPLICITLY opted into dashboard warnings; it
    // deliberately does not ask for the effective URL, whose baked default would make every local-
    // only install warn. All network/display consumers must go through the canonical resolver.
    const explicitIntentReads = new Set(['src/auth/project-key-capture.ts']);
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 dashboard-url reads] total=${reads.length} canonical=${canonical.length} ` +
        `bypasses=${bypasses.length} :: ${reads.map((read) => `${read.site}[${read.syntax}]`).join(' ')}`
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.site.startsWith('src/tools/rbook/dashboard-client.ts:')).toBe(true);
    expect(bypasses.map((read) => read.site.replace(/:\d+$/, '')).sort()).toEqual(
      [...explicitIntentReads].sort()
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// T6 — THE WRONG-TYPED PUBLISHED STRING PARAMETER CLASS SWEEP (portable)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The class: "a published tool parameter declared `type: string` in its shipped inputSchema, sent
 * as a non-string JSON value an MCP client can legally put on the wire, reaches an unguarded string
 * method and throws." Swept DYNAMICALLY over the whole published surface — the static form is not
 * decidable (186 `.trim()` call sites in src/ with no reliable receiver-to-schema mapping).
 *
 * RED entering the mission: 714 triples / 42 CRASH (decision #1117). The ratified figure was 25;
 * the 17 the ratified predicate missed are all the `projectRoot` field, which throws from
 * `path.resolve` rather than `.trim`.
 */
const SRC_ROUTERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  rbook_mission: rbookMission as never,
  rbook_mission_transition: rbookMissionTransition as never,
  rbook_sprint: rbookSprint as never,
  rbook_context: rbookContext as never,
  rbook_session: rbookSession as never,
  rbook_decisions: rbookDecisions as never,
  rbook_db: rbookDb as never,
  rbook_project: rbookProject as never,
  rbook_learnings: rbookLearnings as never,
  rbook_feedback: rbookFeedback as never,
  rbook_auth: rbookAuth as never,
  rbook_message: rbookMessage as never,
  rbook_agent_onboard: rbookAgentOnboard as never,
  rbook_status: rbookStatus as never,
  rbook_review: rbookReview as never,
};

const WRONG_VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: 'number', value: 12_345 },
  { label: 'object', value: { nope: true } },
  { label: 'array', value: ['nope'] },
  { label: 'boolean', value: true },
];

interface Triple {
  tool: string;
  action: string | undefined;
  field: string;
}

function enumerateStringTriples(): Triple[] {
  const triples: Triple[] = [];
  for (const tool of RBOOK_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: unknown; enum?: unknown }>;
    };
    const properties = schema.properties ?? {};
    const actionProp = properties.action;
    const actions: (string | undefined)[] =
      actionProp && Array.isArray(actionProp.enum) ? actionProp.enum.map(String) : [undefined];
    const fields = Object.entries(properties)
      .filter(
        ([name, p]) =>
          name !== 'action' &&
          p &&
          (p.type === 'string' ||
            (Array.isArray(p.type) && p.type.includes('string') && p.type.includes('null')))
      )
      .map(([name]) => name);
    for (const action of actions)
      for (const field of fields) triples.push({ tool: tool.name, action, field });
  }
  return triples;
}

/**
 * The per-action applicability contract (s86-m04). Published as the per-action tables in
 * TOOL_REFERENCE.md, consumed by the reference renderer, and checked in BOTH directions by
 * `tests/tools/rbook/action-params.test.ts` — every entry must be something the router demonstrably
 * does with that key, and every published key must be claimed by some action. That bidirectional
 * gate is why scoping the boundary guard to it does not reintroduce the drift a hand-written
 * (tool, action) -> parameter list would.
 */
const ACTION_PARAMS = RBOOK_ACTION_PARAMS as unknown as Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/** The parameters THIS action applies to, or undefined for an action-less tool (guard them all). */
function applicableParamsFor(triple: Triple): readonly string[] | undefined {
  const perAction = ACTION_PARAMS[triple.tool];
  if (!perAction || triple.action === undefined) return undefined;
  return perAction[triple.action];
}

function appliesToAction(triple: Triple): boolean {
  const applicable = applicableParamsFor(triple);
  return applicable === undefined || applicable.includes(triple.field);
}

/**
 * The 42 triples the PRE-GUARD sweep recorded as CRASHING (decision #1117, measured at HEAD
 * f5507a8 over 714 triples x 5 wrong JSON types). Pinned as recorded evidence so the guard's
 * action scope can never narrow past the RED it was built to close — if a future edit drops one of
 * these out of scope, the scope arm goes red rather than the crash silently returning.
 */
const HISTORICALLY_CRASHING: readonly string[] = [
  'rbook_agent_onboard||agentFeedback',
  'rbook_auth|list|projectRoot',
  'rbook_auth|revoke|projectRoot',
  'rbook_auth|rotate|projectRoot',
  'rbook_context|search|query',
  'rbook_context|snapshot|source',
  'rbook_db|backfill|projectRoot',
  'rbook_db|clone|projectRoot',
  'rbook_db|identify_orphans|projectRoot',
  'rbook_db|pull|projectRoot',
  'rbook_db|reconcile|projectRoot',
  'rbook_decisions|search|query',
  'rbook_learnings|search|query',
  'rbook_message|ack|projectRoot',
  'rbook_message|directory|projectRoot',
  'rbook_message|get|projectRoot',
  'rbook_message|list|projectRoot',
  'rbook_message|respond|projectRoot',
  'rbook_message|send|projectRoot',
  'rbook_message|whoami|projectRoot',
  'rbook_mission_transition|block|missionId',
  'rbook_mission_transition|complete|missionId',
  'rbook_mission_transition|defer|missionId',
  'rbook_mission_transition|drop|missionId',
  'rbook_mission_transition|start|missionId',
  'rbook_mission_transition|unblock|missionId',
  'rbook_mission|add|missionId',
  'rbook_mission|depends|fromId',
  'rbook_mission|move|missionId',
  'rbook_mission|show|missionId',
  'rbook_mission|undepends|fromId',
  'rbook_mission|update|missionId',
  'rbook_project|register|projectRoot',
  'rbook_project|unregister|projectRoot',
  'rbook_session|capture|content',
  'rbook_session|complete|summary',
  'rbook_session|search|query',
  'rbook_session|start|title',
  'rbook_sprint|add|sprintId',
  'rbook_sprint|complete|sprintId',
  'rbook_sprint|show|sprintId',
  'rbook_sprint|update|sprintId',
];

PRIVATE.describe(
  's89-m08 T6 — the wrong-typed published string parameter class, swept whole-surface',
  () => {
    const triples = enumerateStringTriples();
    const crashes: string[] = [];
    /** An APPLICABLE wrong-typed parameter that the guard failed to refuse by name. */
    const unguardedApplicable: string[] = [];
    /** Calls left deliberately untouched because the action does not use that parameter. */
    let untouched = 0;
    let calls = 0;
    let boundary!: IsolatedDashboardBoundary;

    beforeAll(async () => {
      boundary = await installIsolatedDashboardBoundary('s89m08-t6');
      const { projectRoot } = freshStore();
      for (const triple of triples) {
        for (const { label, value } of WRONG_VALUES) {
          const params: Record<string, unknown> = {};
          if (triple.action !== undefined) params.action = triple.action;
          if (triple.field !== 'projectRoot') params.projectRoot = projectRoot;
          params[triple.field] = value;
          calls += 1;
          let timer: NodeJS.Timeout | undefined;
          try {
            const result = (await Promise.race([
              SRC_ROUTERS[triple.tool](params),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('__TIMEOUT__')), CALL_TIMEOUT_MS);
              }),
            ])) as { success?: boolean; error?: { code?: string; field?: string } };
            if (appliesToAction(triple)) {
              // The action READS this parameter. A malformed value must be named, not absorbed:
              // a silently-ignored filter returns an UNFILTERED answer the caller reads as filtered.
              if (
                result?.error?.code !== 'INVALID_PARAMETER' ||
                result.error.field !== triple.field
              ) {
                unguardedApplicable.push(
                  `${triple.tool}(${triple.action ?? '—'}).${triple.field}=${label} -> ${
                    result?.success === true ? 'SUCCESS' : (result?.error?.code ?? 'no code')
                  }`
                );
              }
            } else {
              untouched += 1;
            }
          } catch (error) {
            crashes.push(
              `${triple.tool}(${triple.action ?? '—'}).${triple.field}=${label} threw: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
    });

    afterAll(async () => boundary?.close());

    it('prints its triple count and asserts a non-vacuity floor', () => {
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6] triples=${triples.length} calls=${calls} crashes=${crashes.length} ` +
          `applicable-triples=${triples.filter(appliesToAction).length} ` +
          `calls-left-untouched=${untouched} (parameters the action does not use)`
      );
      expect(triples.length).toBeGreaterThanOrEqual(700);
      expect(calls).toBe(triples.length * WRONG_VALUES.length);
    });

    it('T1/T6 (HARD) — no wrong-typed published string parameter crashes any router', () => {
      expect(crashes).toEqual([]);
    });

    it('T1/T6 (HARD) — untouched actions cannot escape isolated credentials or loopback', () => {
      expect(boundary.blockedUrls).toEqual([]);
      expect(boundary.positiveControlBlocked).toBe(true);
      expect(boundary.double.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(path.dirname(boundary.sourceCredentialPath)).toBe(boundary.configDir);
      expect(fs.realpathSync(boundary.configDir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(
        true
      );
    });

    it('every APPLICABLE wrong-typed value is refused as INVALID_PARAMETER naming the field', () => {
      expect(unguardedApplicable).toEqual([]);
    });

    it('the guard is SCOPED to the action, and that scope still covers every crashing triple', () => {
      // s90-m02. The old arm claimed to test the guard in both directions but only filtered the
      // static applicability table. This arm drives the guard itself. Deleting the guard's
      // applicable-set `continue` must make `overBroad` non-empty; removing or narrowing the guard
      // must make `missed` or `uncoveredHistorical` non-empty.
      const refusedKeys = new Set<string>();
      const malformedRefusals: string[] = [];
      for (const triple of triples) {
        const schema = RBOOK_TOOL_DEFINITIONS.find(
          (tool) => tool.name === triple.tool
        )!.inputSchema;
        const params: Record<string, unknown> = { [triple.field]: 12_345 };
        if (triple.action !== undefined) params.action = triple.action;
        const refusal = findWrongTypedStringParam(schema, applicableParamsFor(triple), params);
        if (refusal === null) continue;
        const key = `${triple.tool}|${triple.action ?? ''}|${triple.field}`;
        refusedKeys.add(key);
        if (refusal.code !== 'INVALID_PARAMETER' || refusal.field !== triple.field) {
          malformedRefusals.push(`${key} -> ${refusal.code} field=${String(refusal.field)}`);
        }
      }

      const applicableKeys = new Set(
        triples
          .filter(appliesToAction)
          .map((triple) => `${triple.tool}|${triple.action ?? ''}|${triple.field}`)
      );
      const overBroad = [...refusedKeys].filter((key) => !applicableKeys.has(key));
      const missed = [...applicableKeys].filter((key) => !refusedKeys.has(key));
      const uncoveredHistorical = HISTORICALLY_CRASHING.filter((key) => !refusedKeys.has(key));
      // eslint-disable-next-line no-console
      console.log(
        `[s90-m02 T6 scope] triples=${triples.length} refused-by-guard=${refusedKeys.size} ` +
          `declared-applicable=${applicableKeys.size} over-broad=${overBroad.length} ` +
          `missed=${missed.length} historically-crashing=${HISTORICALLY_CRASHING.length} ` +
          `uncovered-historical=${uncoveredHistorical.length}`
      );
      expect(refusedKeys.size).toBeGreaterThan(0);
      expect(refusedKeys.size).toBeLessThan(triples.length);
      expect(malformedRefusals).toEqual([]);
      expect(overBroad).toEqual([]);
      expect(missed).toEqual([]);
      expect(uncoveredHistorical).toEqual([]);
    });

    it('PINS null pass-through — handlers retain their own omitted-versus-null semantics', () => {
      // The fold-5 measurement (decision #1117): `null` CRASHES at 0 of the 714 triples while it
      // SUCCEEDS at 238 and REFUSES at 476. It is not a member of the defect class, and refusing it
      // would convert 238 working calls into errors while breaking every client whose serializer
      // emits null for an absent optional. This pins the choice so a later "tighten the guard" edit
      // has to argue with a measurement.
      //
      // Asserted against the GUARD ITSELF rather than against a driven answer, deliberately: 24 of
      // the 714 triples already returned INVALID_PARAMETER for null BEFORE this guard existed (a
      // handler-level refusal, identical set before and after), so a behavioural probe cannot tell
      // the guard's refusal from theirs and would report 24 false positives.
      const refused: string[] = [];
      for (const triple of triples) {
        const schema = RBOOK_TOOL_DEFINITIONS.find((t) => t.name === triple.tool)!.inputSchema;
        const params: Record<string, unknown> = { [triple.field]: null };
        if (triple.action !== undefined) params.action = triple.action;
        if (findWrongTypedStringParam(schema, applicableParamsFor(triple), params) !== null) {
          refused.push(`${triple.tool}(${triple.action ?? '—'}).${triple.field}`);
        }
      }
      // ...and the same field with a non-null wrong type IS refused, so the arm is not vacuous.
      const missed = triples.filter((triple) => {
        const schema = RBOOK_TOOL_DEFINITIONS.find((t) => t.name === triple.tool)!.inputSchema;
        if (!appliesToAction(triple)) return false; // out of scope by design, not a miss
        return (
          findWrongTypedStringParam(schema, applicableParamsFor(triple), {
            [triple.field]: 12_345,
          }) === null
        );
      });
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6 null] triples=${triples.length} refused-when-null=${refused.length} ` +
          `not-refused-when-number=${missed.length}`
      );
      expect(refused).toEqual([]);
      expect(missed).toEqual([]);
    });

    it('the guard is ONE shared module, not per-handler typeof checks', () => {
      // learning #364 — fixing a class as N instances is how the instance list regrows.
      const wirings = walkTsFiles(path.join(SRC_ROOT, 'tools', 'rbook')).filter((f) =>
        fs.readFileSync(f, 'utf8').includes('findWrongTypedStringParam(')
      );
      // 15 routers + the module that defines it.
      expect(wirings).toHaveLength(16);
      // The guard module must author NO new `suggestion:` literal (fold 4).
      const guardSource = fs.readFileSync(
        path.join(SRC_ROOT, 'tools', 'rbook', 'param-type-guard.ts'),
        'utf8'
      );
      const guardCensus = ts.createSourceFile('g.ts', guardSource, ts.ScriptTarget.ES2020, true);
      let guardSuggestionSites = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'suggestion'
        ) {
          guardSuggestionSites += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(guardCensus);
      expect(guardSuggestionSites).toBe(0);
    });

    it('no per-handler `typeof params.X === "string"` guard exists — the class is fixed ONCE', () => {
      // Criterion 2's grep, stated as a RULE rather than as a count: handler parameter validation
      // remains centralized; action normalization and one post-call telemetry destination check
      // are not handler guards. The latter cannot refuse or alter the operation's result (the
      // four wrong-type regression cases in telemetry-call.test.ts prove that behavior). Exempt
      // only that file/field occurrence, never the file wholesale. Fixing this class as N handler
      // checks is sprint-88's central failure (learning #364).
      const PARAM_TYPEOF =
        /typeof\s+(?:\(\s*params[^)]*\)|params)\s*\.([A-Za-z_]+)\s*===\s*'string'/g;
      const offenders: string[] = [];
      const destinationObservations: string[] = [];
      const observer = path.join(SRC_ROOT, 'tools', 'rbook', 'telemetry-call.ts');
      let actionGuards = 0;
      for (const file of walkTsFiles(path.join(SRC_ROOT, 'tools', 'rbook'))) {
        const content = fs.readFileSync(file, 'utf8');
        PARAM_TYPEOF.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = PARAM_TYPEOF.exec(content)) !== null) {
          if (match[1] === 'action') actionGuards += 1;
          else if (file === observer && match[1] === 'projectRoot')
            destinationObservations.push(`${path.relative(REPO_ROOT, file)}: ${match[1]}`);
          else offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[1]}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6 one-guard] action-normalisation guards=${actionGuards} ` +
          `post-call destination observations=${destinationObservations.length} other-param typeof guards=${offenders.length}`
      );
      // Non-vacuity: the regex must actually be finding the action idiom it is written for.
      expect(actionGuards).toBeGreaterThanOrEqual(11);
      expect(destinationObservations).toEqual(['src/tools/rbook/telemetry-call.ts: projectRoot']);
      expect(offenders).toEqual([]);
    });
  }
);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE MATRIX ARMS — T1 / T2 / T3 / T4 / T7
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Params for a PRESCRIBED call, synthesized from the same axis vocabulary the matrix drives with.
 * A prescription names a tool and an action; it does not name arguments, so the harness supplies
 * the minimum a caller in that state would.
 */
function synthesizePrescriptionParams(
  tool: string,
  action: string | undefined,
  ctx: CaseContext
): Record<string, unknown> {
  const params: Record<string, unknown> = { projectRoot: ctx.projectRoot };
  if (action !== undefined) params.action = action;
  switch (tool) {
    case 'rbook_mission':
      if (action === 'show' || action === 'update') params.missionId = ctx.missionId;
      if (action === 'update') params.fields = { notes: 's89-m08 remedy replay' };
      if (action === 'add') {
        params.missionId = 'S89M08-REPLAY';
        params.name = 's89-m08 remedy replay';
        params.sprintId = ctx.sprintId;
        params.objective = 's89-m08 remedy replay';
      }
      if (action === 'move') {
        params.missionId = ctx.missionId;
        params.toSprintId = ctx.sprintId;
      }
      if (action === 'depends' || action === 'undepends') {
        params.fromId = ctx.missionId;
        params.toId = ctx.missionId;
        params.type = 'Requires';
      }
      break;
    case 'rbook_mission_transition':
      params.missionId = ctx.missionId;
      params.reason = 's89-m08 remedy replay';
      params.blockers = ['s89-m08 remedy replay'];
      params.resolution = 's89-m08 remedy replay';
      params.deferUntil = 'after the replay';
      break;
    case 'rbook_sprint':
      if (action !== 'list' && action !== 'analytics') params.sprintId = ctx.sprintId;
      if (action === 'update') params.fields = { focus: 's89-m08 remedy replay' };
      if (action === 'complete') params.summary = 's89-m08 remedy replay';
      if (action === 'add') {
        params.sprintId = 'sprint-89089';
        params.title = 's89-m08 remedy replay';
      }
      if (action === 'carry_forward') {
        params.targetAddress = 'rbook://derek/nowhere';
        params.send = false;
      }
      break;
    case 'rbook_context':
      if (action === 'view' || action === 'condense' || action === 'history') {
        params.contextType = 'master_context';
      }
      if (action === 'search') params.query = 's89-m08';
      if (action === 'constraints') params.constraintAction = 'list';
      if (action === 'next_steps') params.nextStepAction = 'list';
      break;
    case 'rbook_session':
      if (action === 'start') {
        params.title = 's89-m08 remedy replay';
        params.type = 'custom';
      }
      if (action === 'capture') {
        params.category = 'decision';
        params.content = 's89-m08 remedy replay';
      }
      if (action === 'complete') params.summary = 's89-m08 remedy replay';
      if (action === 'search') params.query = 's89-m08';
      break;
    case 'rbook_decisions':
      if (action === 'search') params.query = 's89-m08';
      if (action === 'update') {
        params.decisionId = 1;
        params.status = 'archived';
      }
      if (action === 'batch_update') {
        params.decisionIds = [1];
        params.status = 'archived';
      }
      break;
    case 'rbook_learnings':
      if (action === 'search') params.query = 's89-m08';
      if (action === 'list') params.category = 'technical';
      if (action === 'update') {
        params.learningId = 1;
        params.status = 'archived';
      }
      if (action === 'reaffirm') params.learningId = 1;
      break;
    case 'rbook_db':
      if (action === 'snapshot') params.listOnly = true;
      if (action === 'purge') params.confirm = true;
      break;
    case 'rbook_feedback':
      if (action === 'resolve') params.feedbackId = 1;
      break;
    default:
      break;
  }
  return params;
}

interface Replay {
  site: string;
  caseName: string;
  axis: string;
  triggerCode: string | undefined;
  suggestion: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  thrown?: string;
}

/**
 * RESIDUALS — every driveable site this matrix does NOT reach, each with a STATED reason.
 *
 * This map is the anti-vacuity device. `E + R === driveable` is trivially true if R is defined as
 * `driveable - E`; it is a real gate only because every member of R must ALSO appear here with a
 * reason, and a site that stops firing therefore fails the run until someone writes down why.
 * The shape is `migration-warning-reachability.test.ts`'s.
 */
const RESIDUAL_REASONS: Readonly<Record<string, string>> = {
  // ── s100-m02: a share refused before any upload could put the project there ──
  'src/tools/rbook/record-dashboard-share.ts:203':
    'A share through the dashboard of a project the dashboard does not hold yet, from a machine with no dashboard credential. rbook_project reaches it; dashboard-sharing.test.ts shares from a machine that never signed in.',
  'src/tools/rbook/record-dashboard-share.ts:209':
    'The same share on a signed-in machine with RBOOK_CHECKPOINT_SYNC=off. rbook_project reaches it; dashboard-sharing.test.ts shares with uploads off.',
  // ── s100-m01: the sharing fixes ──
  'src/tools/rbook/record-dashboard-share.ts:174':
    "A share through the dashboard while the owner's other copies wrote or are routed to. rbook_project reaches it; stranded.test.ts shares with a second copy that wrote, one routed, and a former owner copy.",
  'src/tools/rbook/record-dashboard-peer.ts:259':
    "A removed member's dashboard sync answered 404 with no project listed for its account. The dashboard peer only; dashboard-sharing.test.ts answers it through a double of the deployed dashboard.",
  'src/tools/rbook/record-decide.ts:127':
    "A re-judge on a copy that is not the owner's. readmit runs it only after inviteMember's own owner-copy check, so no route reaches it; readd.test.ts re-adds on the referee.",
  'src/tools/rbook/record-join.ts:127':
    'A join request from a copy whose change log is written in a newer record protocol. A join over SSH or by file reaches it; record-protocol-paths.test.ts carries a newer copy and asks.',
  'src/tools/rbook/record-recovery.ts:346':
    "A recovery that meets a member's copy holding a newer record protocol's changes. reasonbook recover only, never routed; record-protocol-paths.test.ts recovers from one.",
  'src/tools/rbook/record-move-routes.ts:59':
    'A handover over SSH to a copy behind the latest move. reasonbook handover only, never routed; record-routes.test.ts hands over to a copy behind a move.',
  'src/tools/rbook/record-move-routes.ts:53':
    "A handover over SSH from a copy behind the far copy's move, which a fork of the owner copy's moves makes. reasonbook handover only, never routed; no test constructs the fork, and the far copy's own check refuses it first in every one that does.",
  'src/tools/rbook/record-sync.ts:287':
    "A sync from a copy told its member was removed whose route ended. rbook_project reaches it; dashboard-sharing.test.ts syncs such a copy after the dashboard's 404.",
  'src/tools/rbook/rbook-db-backfill.ts:431':
    "A reconcile on a member's copy of a shared record, which has no dashboard mirror of its own. rbook_db reaches it with a dashboard credential; dashboard-sharing.test.ts reconciles a member's copy.",
  // ── s97-m11: sharing, joining and moving back through the dashboard ──
  'src/referee/handover.ts:259':
    "An archive asked of a referee whose project has not moved back. A dashboard call at the end of a move back, never routed; dashboard-sharing.test.ts archives only after the owner's copy synced.",
  'src/referee/membership.ts:183':
    'A role change for an account that is no member. A dashboard sharing call, never routed; roles.test.ts names an unknown account.',
  'src/referee/peer.ts:291':
    "A move back asked while the referee does not hold the record, or a move is pending. The dashboard's peer route only; no test constructs one.",
  'src/tools/rbook/rbook-project-shared.ts:274':
    'A join through the dashboard with no folder or no address. rbook_project reaches it; no test sends one without.',
  'src/tools/rbook/record-dashboard-join.ts:60':
    'A join through the dashboard into a folder that is no project folder, such as home. rbook_project reaches it; dashboard-sharing.test.ts joins into a stand-in home.',
  'src/tools/rbook/record-successor.ts:312':
    "A move back's take of its successor while the copy wrote past the dashboard's mark of it. The move back only, which syncs and asks again; dashboard-sharing.test.ts writes in that window.",
  'src/tools/rbook/record-dashboard-join.ts:67':
    'A join through the dashboard into a folder that holds a store. rbook_project reaches it; no test joins into a used folder.',
  'src/tools/rbook/record-dashboard-join.ts:78':
    'An address the dashboard does not resolve for this account. rbook_project reaches it; no test sends an unknown address.',
  'src/tools/rbook/record-dashboard-join.ts:105':
    'A first copy the dashboard sent that this version builds no store from, such as a damaged file. rbook_project reaches it; no test sends a damaged first copy.',
  'src/tools/rbook/record-dashboard-peer.ts:248':
    'A dashboard that lists the project but no longer shares it, after its owner moved it back. A sync through the dashboard only; dashboard-sharing.test.ts syncs a member after the move back.',
  'src/tools/rbook/record-dashboard-share.ts:103':
    "A share or a join through the dashboard on a machine whose switch is not on. rbook_project reaches it; dashboard-sharing.test.ts shares and joins with the switch off, and the healthy-store matrix runs without the dashboard's routes.",
  'src/tools/rbook/record-dashboard-share.ts:151':
    'A share through the dashboard of a project it already referees, with no answer kept from a share that stopped. rbook_project reaches it; dashboard-sharing.test.ts shares a second time only to finish one that stopped.',
  'src/tools/rbook/record-dashboard-share.ts:163':
    'A share through the dashboard of a project shared directly with members. rbook_project reaches it; dashboard-sharing.test.ts shares one with a member.',
  'src/tools/rbook/record-dashboard-share.ts:180':
    "A share through the dashboard from a member's copy. rbook_project reaches it; no test shares from one.",
  'src/tools/rbook/record-dashboard-share.ts:214':
    'A share through the dashboard of a project the dashboard does not know yet. rbook_project reaches it; dashboard-sharing.test.ts shares one before its first upload.',
  'src/tools/rbook/record-membership.ts:279':
    "A role change from a copy that is no authority. The referee library's setRole only, on the authority; no test constructs one.",
  'src/tools/rbook/record-membership.ts:285':
    "A role no member can hold, such as viewer. The referee library's setRole only; roles.test.ts names a viewer.",
  'src/tools/rbook/record-membership.ts:300':
    "A role change of the owner. The referee library's setRole only; roles.test.ts asks for one.",
  'src/tools/rbook/record-membership.ts:306':
    "A role change of a removed member. The referee library's setRole only; roles.test.ts asks for one after the removal.",
  'src/tools/rbook/record-membership.ts:292':
    "A role change naming no member. The referee library's setRole only, which finds the member first; no test constructs one.",
  // ── s97-m10: the dashboard transport, reached through a sync of a copy whose route is a dashboard's ──
  'src/tools/rbook/record-dashboard-peer.ts:344':
    "One transaction larger than a page the dashboard takes, held back while the copy still takes in the stream. A sync through a dashboard only; dashboard-transport.test.ts writes a decision larger than the reference server's limit.",
  // s97-m14: down nine lines (a removal kept per peer), and record-sync's below its exchange down one.
  'src/tools/rbook/record-peers.ts:108':
    'An SSH route replacing the dashboard route a copy keeps to its referee. No router or CLI path reaches it once outbound SSH is refused for a refereed copy; dashboard-transport.test.ts calls rememberPeer with one.',
  'src/tools/rbook/record-sync.ts:122':
    'A sync of a dashboard route given no project folder to sign with, which every router and CLI path passes. dashboard-transport.test.ts calls syncPeers without one.',
  'src/tools/rbook/record-sync.ts:152':
    'An SSH channel asked of a copy whose project the dashboard referees: sync, join, handover or recovery over SSH. The CLI and rbook_project reach it; dashboard-transport.test.ts runs reasonbook sync --ssh on such a copy.',
  'src/tools/rbook/record-wire.ts:75':
    "A bundle written or taken in by a copy whose project the dashboard referees. The CLI's --bundle-out and --bundle-in only, never routed; dashboard-transport.test.ts runs both.",
  // ── s97-m09: the referee library's refusals, answered on the dashboard's routes, never a router ──
  'src/referee/copies.ts:28':
    "A first copy or snapshot asked of a referee that is not the record's authority yet, or is mid-move. The referee library answers the dashboard's routes, never an MCP router; remedies.test.ts asks before the join, after it, and between the pages of a catch-up.",
  'src/referee/copies.ts:34':
    'A first copy asked for with no file to write. A dashboard call, never routed; remedies.test.ts asks with an empty path.',
  'src/referee/copies.ts:81':
    'A referee store the sharing preparation cannot bring to this version, which only damage to its stable ids leaves. A dashboard call at deploy, never routed; no test constructs such a store.',
  'src/referee/handover.ts:116':
    'createReferee with no owner account. A dashboard call, never routed; remedies.test.ts passes an empty one.',
  'src/referee/handover.ts:130':
    'A second createReferee for an owner who did not make the store there. A dashboard call, never routed; handover-in.test.ts retries it as another account.',
  'src/referee/handover.ts:190':
    "An upload that is no owner's copy of a shared record, or whose clock runs more than a week ahead. It arrives on the dashboard's upload route, never an MCP router; remedies.test.ts uploads an unshared store, fresh-copy.test.ts covers views, computed columns and old schemas, and intake-forgeries.test.ts's clock cases bound the rest.",
  'src/referee/handover.ts:196':
    'A failure while building the referee store that no upload check names, such as a full volume. A dashboard call; no test constructs one.',
  'src/referee/handover.ts:221':
    'A join answer applied to a referee that has joined already. A dashboard call, never routed; remedies.test.ts applies one twice.',
  'src/referee/handover.ts:229':
    "A join answer that admits the referee as another member than the owner. A dashboard call, never routed; remedies.test.ts applies an editor's.",
  'src/referee/handover.ts:289':
    'A discard of a referee that has joined, which holds the record. A dashboard call, never routed; remedies.test.ts discards a joined referee.',
  'src/referee/intake.ts:129':
    "A delivery holding a malformed change. It reaches the referee only through the dashboard's peer route; intake.test.ts sends eight kinds of malformed change.",
  'src/referee/intake.ts:163':
    "A delivery in a newer record protocol, kept on its copy. The dashboard's peer route only; intake.test.ts sends a newer change and a newer one of an unknown kind.",
  'src/referee/intake.ts:179':
    "A change whose clock runs more than a week past the referee's, which waits on its copy. The dashboard's peer route only; intake-forgeries.test.ts sends one eight days ahead, then one just short of 2200.",
  'src/referee/intake.ts:187':
    "A change stamped with the referee's own replica. The dashboard's peer route only; who-may-call.test.ts sends one from the owner's account and in the relay.",
  'src/referee/intake.ts:199':
    "A change joining another copy's transaction, or one the referee holds. The dashboard's peer route only; intake-forgeries.test.ts joins the referee's, the owner's and the member's own.",
  'src/referee/intake.ts:212':
    "Changes stamped with a replica that is not the caller's. The dashboard's peer route only; who-may-call.test.ts sends each copy's changes as the other.",
  'src/referee/intake.ts:219':
    "A member's change of a kind only the referee writes. The dashboard's peer route only; who-may-call.test.ts sends each of the five kinds.",
  'src/referee/intake.ts:240':
    "A change setting a row's id, which no copy records. The dashboard's peer route only; intake-forgeries.test.ts sets one on the owner's decision.",
  'src/referee/intake.ts:253':
    "A change whose clock says it was made before its copy was admitted. The dashboard's peer route only; intake-forgeries.test.ts backdates one to 1970.",
  'src/referee/intake.ts:271':
    "A renumber naming a block the referee did not admit, or rows outside it. The dashboard's peer route only; intake.test.ts forges one during a real re-identification.",
  'src/referee/intake.ts:285':
    "A numbered create outside every block admitted for its replica. The dashboard's peer route only; intake-forgeries.test.ts takes ids from the owner's block.",
  'src/referee/intake.ts:297':
    "An editor's change naming another author. The dashboard's peer route only; intake-forgeries.test.ts names the owner.",
  'src/referee/membership.ts:51':
    'A membership call on a referee that has not joined. A dashboard call, never routed; remedies.test.ts lists members before the join and again after.',
  'src/referee/membership.ts:71':
    'An invite with no account. A dashboard sharing call, never routed; remedies.test.ts sends one.',
  'src/referee/membership.ts:78':
    'An invite of a role no copy holds, such as a viewer. A dashboard sharing call, never routed; remedies.test.ts invites a viewer.',
  'src/referee/membership.ts:111':
    "An invite under a name another member goes by, or one that reads the same, the owner's included. A dashboard sharing call, never routed; remedies.test.ts invites as the owner's name and as one that reads the same, then under one that tells them apart.",
  'src/referee/membership.ts:152':
    'A removal of an account that is no member. A dashboard sharing call, never routed; remedies.test.ts removes an unknown account.',
  'src/referee/open.ts:106':
    'A store that cannot be read just now, such as one held or unreadable for a moment. Every library call; head.test.ts makes the file unreadable, then readable again.',
  'src/referee/open.ts:157':
    'A referee store that is missing, made by no referee, restored, replaced or behind its recorded head. Every library call; head.test.ts covers each.',
  'src/referee/open.ts:189':
    'A referee store whose guards another version wrote. Every library call; remedies.test.ts drops a trigger, is refused, runs migrate and is served.',
  'src/referee/open.ts:226':
    'A call without the head the last call returned. Every library call; head.test.ts sends none.',
  'src/referee/open.ts:278':
    'A step that failed for a reason no refusal names, such as a first copy written over a file already there. Every library call; remedies.test.ts asks for one.',
  'src/referee/open.ts:287':
    'A call that could not start, such as a bindings folder that cannot be made. Every library call; remedies.test.ts names a file as the folder.',
  'src/referee/peer.ts:69':
    "A request that is not well formed. The dashboard's peer route only; who-may-call.test.ts sends a join request for another replica.",
  'src/referee/peer.ts:135':
    "A caller whose replica is not its account's. The dashboard's peer route only; who-may-call.test.ts presents four strangers.",
  'src/referee/peer.ts:142':
    "A method no caller may run through the peer route. The dashboard's peer route only; who-may-call.test.ts names twelve.",
  'src/referee/peer.ts:214':
    "A join from an account with no active share. The dashboard's peer route only; who-may-call.test.ts joins as an unknown and a removed account.",
  'src/referee/peer.ts:237':
    "A copy whose record protocol is newer than the referee's, at its hello. The dashboard's peer route only; intake.test.ts says hello as one.",
  'src/referee/peer.ts:251':
    "A removed member asking for what members receive. The dashboard's peer route only; who-may-call.test.ts and reference-server.test.ts ask as one.",
  'src/referee/peer.ts:372':
    "A peer call on a referee that has not joined. The dashboard's peer route only; remedies.test.ts says hello before the join and after.",
  'src/referee/views.ts:69':
    'A view of a referee that has not joined. A dashboard page call, never routed; remedies.test.ts asks before the join and after.',
  'src/referee/views.ts:97':
    'The activity feed asked from a change the referee does not hold. A dashboard page call, never routed; remedies.test.ts asks from one, then from the start.',
  'src/tools/rbook/record-fresh-copy.ts:402':
    "A fresh copy's own schema that the sharing preparation cannot make current, which only a broken install leaves. The referee library and the share's upload build it, never a router; no test constructs one.",
  // The CLI's offline migration is outside the router matrix; its refusal/retry cases run
  // against real SQLite stores and child processes in tests/cli/migrate*.test.ts.
  'src/cli/migrate.ts:176':
    'CLI-only migration refusal and deferred-follow-up retry, outside MCP routers; covered by migrate and recovery suites.',
  'src/cli/migrate-config.ts:156':
    'CLI-only failed-rollback recovery requires conflicting filesystem state; migrate-config.test.ts retains the guard and proves retry.',
  'src/cli/migrate-config.ts:166':
    'CLI-only offline config refusal, outside MCP routers; migrate-config and migration ownership suites drive its blockers.',
  // These spread the underlying database error; their nonliteral code is classified STATE by
  // the syntax census, but the trigger is a database fault, exercised in lifecycle-decoupling.
  // s96-m01 (fold): down one line (the sharedStoreWrite import).
  'src/tools/rbook/rbook-mission-add.ts:287':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-add.ts:303':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  // s97-m13: start's promotion moved its two branches down 19 lines, and status's queue order 6.
  'src/tools/rbook/rbook-mission-start.ts:285':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-start.ts:299':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-status.ts:267':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-update.ts:327':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-update.ts:467':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',
  'src/tools/rbook/rbook-mission-update.ts:479':
    'Database read/write/transaction failure branch; the healthy-store axis cannot cause it. Fault cases live in lifecycle-decoupling.test.ts and the integration failure suites.',

  // s94-m08: mandatory drop schema/audit/postcondition failures require fault injection.
  'src/tools/rbook/rbook-mission-drop.ts:70':
    'Required mission timestamp preparation failed; healthy-store router calls cannot establish this fault. The drop schema preflight refuses before mutation.',
  'src/tools/rbook/rbook-mission-drop.ts:93':
    'The drop transaction threw or rollback failed; a healthy-store state sequence cannot cause this. Transaction/audit fault fixtures live in spin-out-durability.test.ts.',
  'src/tools/rbook/rbook-mission-drop.ts:221':
    'Mandatory drop audit insertion failed or changed no row. Trigger faults are exercised in spin-out.test.ts and spin-out-durability.test.ts.',
  'src/tools/rbook/rbook-mission-drop.ts:260':
    'A trigger or database fault violated the verified drop/audit postcondition. rbook-mission-drop.test.ts deletes the audit event after insertion and proves rollback.',
  'src/tools/rbook/spin-out-mapping.ts:31':
    'CLI-only mapping helper, outside every MCP router in this matrix. spin-out-mapping.test.ts drives unknown-column, malformed-ID and missing-mapping refusals; no rbook_* prescription.',
  // s96-m01 (fold): down seven lines (spin-out refuses a shared store).
  'src/tools/rbook/spin-out.ts:378':
    'CLI-only spin-out core, dispatched directly by src/cli.ts before ambient routing. Explicit-root, conflict, trigger and retry refusals are driven in the spin-out API/process/durability suites; no rbook_* prescription.',

  // ── s93-m06: draft refusals that need a harness session or a race ────────────────────────────
  // The matrix drives routers in process with no harness link, so the server writes as a process
  // and no operator words can be bound to it; these are driven by name in draft-approval.test.ts.
  'src/tools/rbook/draft-approval.ts:201':
    "A fromDraft record, in other words than the draft's, of a draft revised after the operator approved it. The record path only; draft-approval.test.ts records a declined revision's text under the earlier approval.",
  'src/tools/rbook/draft-approval.ts:227':
    'The operator plainly declined but the prompt hook could not write the decline, so only the ' +
    'runtime words say so. Needs a harness-linked server and hook runtime words; driven in ' +
    'draft-approval.test.ts ("refuses a decline the hook could not write to the store").',
  'src/tools/rbook/draft-approval.ts:379':
    'Two records of one constraint, rule or profile draft at once: the guarded claim lets one ' +
    'through. A race needs the operator words bound in a harness session; driven in ' +
    'draft-approval.test.ts ("claims a constraint draft once when two records race").',
  'src/tools/rbook/draft-approval.ts:450':
    'An approved profile draft whose line cannot be written (past the profile cap) releases its ' +
    'claim. Needs the operator words bound in a harness session; driven in draft-approval.test.ts ' +
    '("releases the claim when an approved profile line cannot be written").',
  // s96-m01 (fold): down one line (the replica refusal import).
  'src/tools/rbook/rbook-decisions-record.ts:386':
    'Two records of one decision draft at once: the in-transaction guard approves it once and ' +
    'rolls the other back. Driven in draft-approval.test.ts ("records a draft once").',
  // ── s96-m01: the shared record's refusals of a copy, which need a second copy or a restore ─────
  'src/tools/rbook/replica-check.ts:45':
    'A second live copy of a shared project on one machine. The healthy-store matrix drives routed calls on one store, and makes no second copy; replica-check.test.ts and replica-identity.test.ts drive it, and record-join.test.ts refuses a second copy its join.',
  'src/tools/rbook/replica-check.ts:57':
    "A restored backup or a replaced folder, its sequence behind this machine's mark. The healthy-store matrix drives routed calls on one store, and restores none; replica-check.test.ts drives the refusal, and record-reidentify.test.ts syncs such a copy, which then re-identifies and reports what it lost.",
  'src/tools/rbook/replica-check.ts:67':
    'A copy of a shared project this machine has not joined, such as a zip carried here. The healthy-store matrix drives routed calls on one store, and carries none; replica-check.test.ts drives it, and record-join.test.ts joins such a copy.',
  'src/tools/rbook/replica-check.ts:76':
    'A copy whose check could not run, such as a binding of another project. The healthy-store matrix drives routed calls on one store, and builds no such binding; replica-check.test.ts drives it.',
  // s96-m03 (fold): down four lines; s96-m12: eight more (two refusal codes, and the open sessions a
  // joining copy brings, marked as their creator's at its first identity only). s96-m13: nine more
  // (three refusal codes, and the key writer's comment naming its other caller).
  'src/tools/rbook/replica-identity.ts:309':
    'A copy whose number block is full: a million rows of one table in its block. The healthy-store matrix drives routed calls on one store, far below that; replica-check.test.ts and replica-identity.test.ts fill a block and drive it.',
  // ── s96-m03: the change log's refusals, which need damage or a write no tool makes ─────────────
  'src/tools/rbook/replica-check.ts:112':
    'A copy whose write guard is broken (a dropped or changed trigger, a lost guard table, a leftover token or stage, a lost table or recorded column, a column this version does not know) refuses writes and names its remedy: the repair, a restore or an upgrade. It is damage no routed call makes; record-guards.test.ts breaks the guard each way on a shared store, drives the routed tools to the refusal, and runs reasonbook repair --guard.',
  'src/tools/rbook/record-capture.ts:59':
    'A delete of a shared row, which no tool path makes: the guard aborts any delete outside the ' +
    'helper, and inside it this refusal is the backstop. Reached only by a write a future change ' +
    'adds, so the healthy-store matrix cannot drive it.',
  'src/tools/rbook/record-capture.ts:93':
    'A shared row with no stable id, which prepareForSharing and every create rule out: it is ' +
    'damage to the copy, so the healthy-store matrix cannot drive it.',
  'src/tools/rbook/record-recording.ts:88':
    'A recorded write that begins, commits or rolls back its own transaction, or runs a script, which no tool path makes, on a shared store or not: every converted site leaves its transaction to the change helper. record-guards.test.ts drives it with each verb and script.',
  // ── s96-m12: the merge's refusals, which need a second copy, a delivery or a conflict ─────────
  'src/tools/rbook/record-apply.ts:140':
    "A delivery that holds another project's changes. The healthy-store matrix drives routed calls on one store, and delivers nothing; record-merge-fixtures.test.ts refuses one whole on a shared copy and stores nothing of it.",
  'src/tools/rbook/record-apply.ts:151':
    "A delivery holding an author name no copy of Reasonbook records. The healthy-store matrix drives routed calls on one store, and delivers nothing; record-merge-fixtures.test.ts sends a member's change with a right-to-left override, an untrimmed name or a bell, on the change or in its row, and nothing of it is stored.",
  'src/tools/rbook/record-apply.ts:177':
    "A replica's slot that holds a different change on the two copies, delivered outside an exchange, which renumbers such a copy first. The healthy-store matrix drives routed calls on one store, and delivers nothing; record-merge-fixtures.test.ts delivers such a change and the merge stops.",
  'src/tools/rbook/record-apply.ts:204':
    "A merge into a store that keeps no change log. A merge arrives only through a sync, a join or a bundle, between two copies; record-merge-fixtures.test.ts applies a copy's changes to a solo store, which refuses with this remedy.",
  'src/tools/rbook/record-decide.ts:38':
    "An admission made off the owner's copy. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-merge-fixtures.test.ts admits from a member's copy, which refuses.",
  'src/tools/rbook/record-capture.ts:84':
    "A plain write to a field whose concurrent values are not settled. A conflict needs two copies' writes; the healthy-store matrix drives routed calls on one store, and builds none; record-merge.test.ts writes each field kind after five copies changed it, and settles it with this remedy.",
  'src/tools/rbook/record-settle.ts:214':
    "A member's settle of a decision lineage fork or the project identity, which only the owner settles. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-merge-fixtures.test.ts tries it on a member's copy, then settles on the owner's.",
  'src/tools/rbook/record-settle.ts:223':
    "A settle of a value no copy wrote, which would spread to every copy. It needs a field in conflict, which needs two copies' writes; record-merge-fixtures.test.ts settles a decision status to values no copy wrote and to a candidate.",
  'src/tools/rbook/record-standing.ts:148':
    "A project identity write on a member's copy, refused before it is recorded. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-merge.test.ts drives rbook_context and rbook_project updates on a member's copy.",
  'src/tools/rbook/session-owner.ts:187':
    "A write to, or a close of, a session another copy started. A peer's session arrives only by a merge from another copy; record-derived.test.ts completes and captures into a peer's session on the owner's copy.",
  // ── s96-m13: the sync, sharing and joining refusals a single store cannot reach ──────────────
  'src/tools/rbook/rbook-db-backfill.ts:138':
    "The old backfill on a member's copy of a shared record, which never uploads. The healthy-store matrix drives routed calls on one store, and builds no member's copy; record-gates.test.ts joins one and drives the backfill to this refusal.",
  'src/tools/rbook/record-bundle.ts:101':
    'A bundle file that is not JSON. Bundles travel through reasonbook sync --bundle-in, no routed tool; record-refusals.test.ts reads one.',
  'src/tools/rbook/record-bundle.ts:108':
    'JSON that is not a Reasonbook bundle. Bundles travel through the CLI, no routed tool; record-refusals.test.ts reads one.',
  'src/tools/rbook/record-bundle.ts:116':
    'A bundle edited or damaged after it was written. Bundles travel through the CLI, no routed tool; record-bundle.test.ts edits one and imports it.',
  'src/tools/rbook/record-bundle.ts:155':
    "A bundle from a copy that has not taken the owner copy's latest move. It needs two copies and a move; record-moves.test.ts carries one.",
  'src/tools/rbook/record-bundle.ts:189':
    "A member's bundle whose copy must take a new identity first, which only a direct sync gives. It needs a restored member's copy; record-refusals.test.ts imports one on the owner's copy.",
  'src/tools/rbook/record-decide.ts:76':
    "A decision of transactions off the owner's copy. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-refusals.test.ts tries it on one.",
  'src/tools/rbook/record-exchange-steps.ts:37':
    'A copy behind a move meeting a copy ahead that is no owner copy in either view. An exchange needs two copies; record-refusals.test.ts presents one.',
  // s97-m14 (critics, round 2): down two lines (the catch-up names the removed copy).
  'src/tools/rbook/record-exchange-steps.ts:252':
    'Blocks that still clash after four renumbers: a bound that stops a fault rather than loop. No supported sequence leaves two copies clashing after renumbering; record-refusals.test.ts drives it with copies that never move.',
  // s97-m14 (critics, round 1): down five lines (removedCopy), and past removalNote down 27.
  'src/tools/rbook/record-exchange.ts:220':
    'Two copies that speak different sync protocols. An exchange needs two copies; record-exchange.test.ts presents a newer one.',
  'src/tools/rbook/record-exchange.ts:226':
    'Two copies of different projects. An exchange needs two copies; record-exchange.test.ts pairs them.',
  'src/tools/rbook/record-exchange.ts:233':
    'Both sides one replica, one copied from the other. An exchange needs two copies; record-refusals.test.ts presents one.',
  'src/tools/rbook/record-exchange.ts:240':
    'Two copies naming different owner copies for one move. An exchange needs two copies; record-refusals.test.ts presents one.',
  'src/tools/rbook/record-exchange.ts:248':
    "Two members, neither the owner's copy, which the star refuses. An exchange needs two copies; record-exchange.test.ts and record-moves.test.ts pair two members.",
  'src/tools/rbook/record-exchange.ts:272':
    "The owner's own stream differing at a change both copies hold, as a restored owner machine that wrote again leaves it. record-reidentify.test.ts restores one and syncs.",
  'src/tools/rbook/record-exchange.ts:279':
    "A slot clash on a copy neither side owns, which no honest star produces: a member holds others' streams only as the owner's copy sent them. record-refusals.test.ts states the case directly.",
  'src/tools/rbook/record-exchange.ts:286':
    'A block two replicas hold where the one admitted later is not a side of this exchange, so it cannot renumber here. record-reidentify.test.ts admits two copies in one block and syncs the earlier one.',
  'src/tools/rbook/record-exchange.ts:352':
    "An owner copy holding less of its own stream than a member, as a restore of the owner's machine leaves it. record-recovery.test.ts restores one and syncs.",
  'src/tools/rbook/record-join.ts:105':
    "A copy whose file fails SQLite's integrity check. reasonbook copy writes a consistent file, and a file damaged enough to fail the check mostly fails to open first; no test constructs one.",
  'src/tools/rbook/record-join.ts:114':
    'A copy made before sharing, with no baseline, sent to the import. A join runs between two copies; record-join.test.ts presents one.',
  'src/tools/rbook/record-join.ts:170':
    'A join request that is not one. Join steps travel by file or SSH, no routed tool; record-refusals.test.ts presents one.',
  'src/tools/rbook/record-join.ts:175':
    'A join request in another sync protocol. Join steps travel by file or SSH; record-refusals.test.ts presents one.',
  'src/tools/rbook/record-join.ts:183':
    "A join answered off the owner's copy. It needs a member's copy; record-refusals.test.ts tries it on one.",
  'src/tools/rbook/record-join.ts:188':
    "A join request from another project's copy. Join steps travel by file or SSH; record-refusals.test.ts presents one.",
  'src/tools/rbook/record-join.ts:196':
    'A join for someone the record has not invited. A join runs between two copies; record-join.test.ts drives it.',
  'src/tools/rbook/record-join.ts:203':
    'A second answer to a request already answered, so an answer is never reused. record-join.test.ts answers twice.',
  'src/tools/rbook/record-join.ts:245':
    'A join answer that is not one. Join steps travel by file or SSH; record-refusals.test.ts presents one.',
  'src/tools/rbook/record-join.ts:267':
    'A join answer for another request, or one used already. record-join.test.ts applies one twice and on another copy.',
  'src/tools/rbook/record-membership.ts:144':
    "An invite off the owner's copy. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-join.test.ts invites from one.",
  'src/tools/rbook/record-membership.ts:338':
    "A removal off the owner's copy. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-members.test.ts removes from one.",
  'src/tools/rbook/record-move-routes.ts:67':
    'An SSH handover to a copy its own check refuses. The matrix opens no SSH channel; record-routes.test.ts hands over to a restored copy, then again once it re-identifies.',
  'src/tools/rbook/record-moves.ts:72':
    "A handover from a member's copy. Handovers run through reasonbook handover, no routed tool; record-moves.test.ts tries one.",
  'src/tools/rbook/record-moves.ts:79':
    'A handover from a copy that holds a move it has not confirmed. Handovers run through the CLI; record-recovery.test.ts tries one on a superseded owner copy.',
  'src/tools/rbook/record-moves.ts:88':
    "A handover to a copy that is not another of the owner's. Handovers run through the CLI; record-moves.test.ts tries one.",
  'src/tools/rbook/record-moves.ts:95':
    'A handover to a copy that held a term already. Handovers run through the CLI; record-moves.test.ts tries one.',
  'src/tools/rbook/record-moves.ts:153':
    'A confirmation naming a move this copy does not hold. Only a handover over SSH names the move; record-moves.test.ts names another.',
  'src/tools/rbook/record-recovery.ts:168':
    'A recovery on a copy that holds a move it has not confirmed. Recoveries run through reasonbook recover, no routed tool; record-recovery.test.ts tries one.',
  'src/tools/rbook/record-recovery.ts:180':
    "A recovery whose confirmed member list is not the record's. Recoveries run through the CLI; record-recovery.test.ts drives it.",
  'src/tools/rbook/record-recovery.ts:197':
    "A recovery while the old owner copy is live. Recoveries run through the CLI; record-recovery.test.ts drives it on the owner's machine.",
  'src/tools/rbook/record-recovery.ts:222':
    "A recovery that cannot reach every member's copy. Recoveries run through the CLI; record-recovery.test.ts and record-move-routes.test.ts drive it.",
  'src/tools/rbook/record-admit-successor.ts:104':
    "A successor admitted off the owner's copy. Successors are admitted inside a direct exchange; record-refusals.test.ts tries it on a member's copy.",
  'src/tools/rbook/record-admit-successor.ts:110':
    "A successor for a removed member's copy. Successors are admitted inside a direct exchange; record-refusals.test.ts tries one.",
  'src/tools/rbook/record-admit-successor.ts:133':
    'A successor for a copy no member of the record owns. Successors are admitted inside a direct exchange; record-refusals.test.ts tries one.',
  'src/tools/rbook/record-successor.ts:133':
    "A block move off the owner's copy. Block moves run inside a direct exchange; record-refusals.test.ts tries one.",
  'src/tools/rbook/record-successor.ts:177':
    'A successor taken by a store that is no copy of a shared record. Successors are taken inside a direct exchange; record-refusals.test.ts tries one.',
  'src/cli/sync.ts:157':
    'A bundle --for a removed member, a member with no copy, or a name that is none. Bundles travel through reasonbook sync --bundle-out, no routed tool; record-bundle.test.ts asks for each.',
  'src/tools/rbook/rbook-db-backfill.ts:813':
    "A purge of the dashboard mirror from a member's copy. The healthy-store matrix drives routed calls on one store, and only a member's copy reaches this; record-gates.test.ts purges from one.",
  'src/tools/rbook/record-admit-successor.ts:125':
    'A join a recovery never saw, for an invite it never saw either. The healthy-store matrix builds no recovery; record-recovery.test.ts drives it, invites the member again, and the copy then re-identifies.',
  'src/tools/rbook/record-bundle.ts:168':
    "A bundle one move ahead from a copy that is no owner's copy in either view. Bundles travel through the CLI, no routed tool; record-bundle.test.ts imports one.",
  'src/tools/rbook/record-bundle.ts:176':
    "A bundle from a copy that shows this copy's member as removed. Bundles travel through the CLI; record-bundle.test.ts imports one on a removed member's copy.",
  'src/tools/rbook/record-join.ts:255':
    'A join answer changed after it was written. Join steps travel by file or SSH, no routed tool; record-join.test.ts edits one and applies it.',
  'src/tools/rbook/record-sync.ts:385':
    'A sync in which no copy could be reached. The healthy-store matrix drives routed calls on one store, which has no route to any copy; record-routes.test.ts syncs with a copy whose machine is gone.',
  'src/tools/rbook/record-import.ts:140':
    'An import of a copy this account cannot read. reasonbook import is a CLI verb, no routed tool; record-import-cli.test.ts takes read access from a copy and imports it.',
  'src/tools/rbook/record-import.ts:146':
    'An import of a copy that cannot be read. A CLI verb, no routed tool; record-import-cli.test.ts imports a store file that is not a database, through the CLI too.',
  'src/tools/rbook/record-import.ts:168':
    "An import --from the shared copy it runs in. A CLI verb, no routed tool; record-import-cli.test.ts names the owner's own shared copy, run there.",
  'src/tools/rbook/record-import.ts:174':
    "An import --from the folder that holds the store it would write to. A CLI verb, no routed tool; record-import-cli.test.ts names the copy's own folder, unshared and shared.",
  'src/tools/rbook/record-import.ts:182':
    'An import into a project that is not shared. A CLI verb, no routed tool; record-import-cli.test.ts imports into an unshared project.',
  'src/tools/rbook/record-import.ts:188':
    'An import --from a folder that holds no store. A CLI verb, no routed tool; record-import-cli.test.ts names an empty folder.',
  'src/tools/rbook/record-import.ts:194':
    'An import --from a folder holding a store in both layouts. A CLI verb, no routed tool; record-import-cli.test.ts names one.',
  'src/tools/rbook/record-import.ts:201':
    'An import --from a zip archive rather than the folder it holds. A CLI verb, no routed tool; record-import-cli.test.ts names one.',
  'src/tools/rbook/record-import.ts:216':
    "An import of another project's copy, shared or not. A CLI verb, no routed tool; record-import-cli.test.ts imports another project's shared copy, and a copy whose project id it changed.",
  'src/tools/rbook/record-import.ts:223':
    "An import --from a copy of a shared record. A CLI verb, no routed tool; record-import-cli.test.ts names a member's joined copy.",
  'src/tools/rbook/record-import.ts:230':
    "An import of a copy older than the project id under another folder name. A CLI verb, no routed tool; record-import-cli.test.ts imports one by its folder and by a store file outside both layouts, then the same copy in a folder of the project's name.",
  'src/tools/rbook/record-import.ts:252':
    "An import of a store that cannot reach the sharing schema, such as one without a Reasonbook store's tables. A CLI verb, no routed tool; record-import-cli.test.ts imports a store holding a missions table alone.",
  'src/tools/rbook/record-import.ts:272':
    'An import --include naming a row the dry run labels neither deleted on the owner nor perhaps in the record already. A CLI verb, no routed tool; record-import.test.ts names a mission the record holds, and record-import-again.test.ts a decision the copy does not hold.',
  'src/tools/rbook/record-import-apply.ts:86':
    'An import whose write would give a numbered row another id than its plan gave it, refused before anything is written. A CLI verb, no routed tool; record-import-classify.test.ts applies a plan one number off, which refuses with this remedy.',
  'src/tools/rbook/record-join.ts:139':
    "A join asked on a live copy of the shared record, the owner's or a joined member's. The healthy-store matrix's join names no copy to join; record-refusals.test.ts asks one on the owner's copy.",
  'src/tools/rbook/record-sync.ts:171':
    'A copy SSH cannot reach. The matrix opens no SSH channel; record-move-routes.test.ts and record-routes.test.ts drive it through the stand-in ssh.',
  'src/tools/rbook/record-sync.ts:229':
    'A sync whose far end stops after its handshake. The matrix opens no SSH channel; record-refusals.test.ts drives a far end that exits.',
  'src/tools/rbook/record-sync.ts:302':
    "A sync from a member's copy with no route to the owner's. The healthy-store matrix drives routed calls on one store, and builds no member's copy; record-join.test.ts drives it on a joined copy.",
  'src/tools/rbook/record-sync.ts:460':
    'A join over SSH whose far end stops after its handshake. The matrix opens no SSH channel; record-refusals.test.ts drives a far end that exits.',

  // ── FAULT-SHAPED PRECONDITIONS inside a VALIDATION/STATE-coded site ──────────────────────────
  // These carry a driveable CODE but their trigger is a database fault, so the successor
  // fault-injection instrument (read-only DB file, dropped table, corrupt content) reaches them —
  // not an axis matrix that drives supported calls against a healthy store.
  'src/tools/rbook/record-links.ts:22':
    'Internal materializer/batch failure after schema preparation and persisted-record selection. ' +
    'The healthy router matrix cannot create its schema/query/write fault or absent required row. ' +
    'Driven in record-links.test.ts and record-links-writers.test.ts through missing-source, ' +
    'foreign-schema and required-link rollback fixtures.',
  // s96-m01 (fold): down 55 lines, and s96-m03 (fold) 4 more, as above; s97-m09: 7 more.
  'src/tools/rbook/client.ts:860':
    'UNIQUE-constraint mapping inside RbookDatabaseClient. Reaching it needs a write that violates a ' +
    'UNIQUE index THROUGH a supported call; every duplicate this matrix can create is refused earlier ' +
    'by a handler check (MISSION_ID_EXISTS, SPRINT_ID_EXISTS). Needs the fault-injection instrument.',
  'src/tools/rbook/client.ts:871':
    'FOREIGN-KEY-constraint mapping inside RbookDatabaseClient. Same shape as :679 — no supported call ' +
    'sequence against a healthy store reaches an FK violation. Needs the fault-injection instrument.',
  'src/tools/rbook/rbook-context-project-identity.ts:72':
    'MEASURED: unreachable by deleting the row. On a write `ensureProjectIdentityRow(client)` runs ' +
    'first and RECREATES it, and on a read (s93-m11) the identity is derived in memory, so the ' +
    'null-identity branch needs the row to be both uncreatable and unreadable — a database fault, ' +
    'not a state this matrix can establish.',
  'src/tools/rbook/rbook-context-project-identity.ts:141':
    'Same fault-shaped precondition as :64, one frame later: `getProjectIdentity` returning null ' +
    'AFTER a write that already succeeded.',

  // ── DISPATCHER-PREFLIGHT SITES (false-negative item 7: this matrix drives routers, not stdio) ──
  'src/tools/rbook/unknown-param-guard.ts:80':
    's91-m02 unknown top-level parameter refusal. It runs in src/index.ts preflight BEFORE any ' +
    'router, so the in-process router matrix cannot reach it. Driven instead over real stdio on ' +
    'every tools/list pair by tests/e2e/wire-preflight.e2e.ts, and in process by ' +
    'tests/index.preflight.test.ts. The suggestion carries no rbook_* prescription.',

  // ── CONSTRUCTION-MASKED PRECONDITIONS inside a VALIDATION/STATE-coded site ───────────────────
  // Driveable by CODE, but dispatcher and collab gates mask the triggers from every supported
  // construction the portable m07 instrument can establish. Four former entries moved to E.
  'src/tools/rbook/rbook-message.ts:1069':
    'A defensive branch whose own message says the dispatcher should have caught the condition via ' +
    'resolveSenderContext. Reaching it means reaching a state the dispatcher forbids.',
  // ── MASKED BY AN EARLIER REFUSAL ON EVERY PATH THIS MATRIX CAN DRIVE ─────────────────────────
  // s92-m02, s92-m05 and s92-m03 moved these two down (planned-end-date receipt fields; the
  // archive param; a comment on implicit sessions); same branches.
  'src/tools/rbook/rbook-sprint-complete.ts:673':
    'MEASURED: masked. With master_context deleted and the sprint made closable, closeout refuses at ' +
    'the shared errors.ts contextNotFound BEFORE reaching this sprint-local branch, so :666 is ' +
    'unreachable while that earlier guard stands.',
  'src/tools/rbook/rbook-sprint-complete.ts:684': 'Same masking as :666, for project_context.',
};

const FAULT_SHAPED_DRIVEABLE_RESIDUALS = new Set([
  'src/tools/rbook/rbook-mission-drop.ts:70',
  'src/tools/rbook/rbook-mission-drop.ts:93',
  'src/tools/rbook/rbook-mission-drop.ts:221',
  'src/tools/rbook/rbook-mission-drop.ts:260',
  'src/tools/rbook/rbook-mission-add.ts:287',
  'src/tools/rbook/rbook-mission-add.ts:303',
  'src/tools/rbook/rbook-mission-start.ts:285',
  'src/tools/rbook/rbook-mission-start.ts:299',
  'src/tools/rbook/rbook-mission-status.ts:267',
  'src/tools/rbook/rbook-mission-update.ts:327',
  'src/tools/rbook/rbook-mission-update.ts:467',
  'src/tools/rbook/rbook-mission-update.ts:479',

  'src/tools/rbook/client.ts:860',
  'src/tools/rbook/client.ts:871',
  'src/tools/rbook/rbook-context-project-identity.ts:72',
  'src/tools/rbook/rbook-context-project-identity.ts:141',
]);
const INTERNAL_FAULT_RESUME_TRIGGER =
  'any one of these codes reported from the field by an external adopter, or any in-repo incident that reaches one on a healthy store.';
const MASKED_RESUME_TRIGGER =
  'any production caller or control-flow change that makes one of these sites constructible, or any field report or in-repo incident that reaches one on a healthy store.';

PRIVATE.describe(
  's89-m08 THE AXIS MATRIX — reach the trigger state, then execute the remedy',
  () => {
    const driven: DrivenCall[] = [];
    const replays: Replay[] = [];
    let examinedDriveable: string[] = [];
    let residualDriveable: string[] = [];
    let driverMissionId = '';
    let driverSprintId = '';
    let closedSprintId = '';
    let boundary!: IsolatedDashboardBoundary;

    beforeAll(async () => {
      mirror = buildSuggestionMirror();
      sink = installSuggestionSink();
      sink.reset();
      mirrorRouters = loadMirrorRouters();
      boundary = await installIsolatedDashboardBoundary('s89m08-private');

      initializeFrozenSource();
      // Discover the driver rows rather than hard-coding ids that a store edit could invalidate.
      ({ driverMissionId, driverSprintId, closedSprintId } = withDb(frozenSourceDb, (db) => {
        const mission = db.prepare(`SELECT id FROM missions ORDER BY id LIMIT 1`).get() as
          | { id: string }
          | undefined;
        const sprints = db.prepare(`SELECT id FROM sprints ORDER BY id LIMIT 2`).all() as Array<{
          id: string;
        }>;
        if (!mission || sprints.length < 2) {
          throw new Error('frozen source lacks a mission or two sprints to drive');
        }
        return {
          driverMissionId: mission.id,
          driverSprintId: sprints[0].id,
          closedSprintId: sprints[1].id,
        };
      }));

      for (const matrixCase of MATRIX) {
        const { projectRoot, dbPath } = freshStore();
        const ctx: CaseContext = {
          projectRoot,
          dbPath,
          missionId: driverMissionId,
          sprintId: driverSprintId,
          closedSprintId,
        };
        matrixCase.setup?.(ctx);
        // "Establish, never inherit" applies PER CALL, not per case. A driven call that SUCCEEDS
        // mutates the very state the next call is supposed to meet — measured: driving
        // start/complete/block/unblock/drop/defer in sequence from `Deferred` left `defer` looking at
        // whatever the earlier transitions had produced, so `rbook-mission-defer.ts:121` never fired.
        const calls = matrixCase.calls(ctx);
        for (const call of calls) {
          matrixCase.setup?.(ctx);
          driven.push(
            await driveMirrored(matrixCase.name, matrixCase.axis, call.tool, call.params)
          );
        }
      }

      // ── THE REPLAY PASS (T2/T3/T4) ──────────────────────────────────────────────────────────────
      // Each replay re-establishes the case on its OWN fresh store, so the remedy is executed from
      // the state that emitted the refusal rather than from whatever later calls left behind.
      const wanted = new Map<
        string,
        { call: DrivenCall; site: string; prescription: PrescribedCall }
      >();
      for (const call of driven) {
        if (call.outcome !== 'REFUSES' || !call.suggestion) continue;
        for (const site of call.sites) {
          if (!DRIVEABLE_SITES.has(site)) continue;
          for (const prescription of extractPrescribedCalls(call.suggestion)) {
            const key = `${call.caseName}|${site}|${prescription.tool}|${prescription.action ?? ''}`;
            if (!wanted.has(key)) wanted.set(key, { call, site, prescription });
          }
        }
      }

      for (const { call, site, prescription } of wanted.values()) {
        const matrixCase = MATRIX.find((c) => c.name === call.caseName);
        if (!matrixCase) continue;
        const { projectRoot, dbPath } = freshStore();
        const ctx: CaseContext = {
          projectRoot,
          dbPath,
          missionId: driverMissionId,
          sprintId: driverSprintId,
          closedSprintId,
        };
        matrixCase.setup?.(ctx);
        const executed = await driveMirrored(
          call.caseName,
          call.axis,
          prescription.tool,
          synthesizePrescriptionParams(prescription.tool, prescription.action, ctx)
        );
        replays.push({
          site,
          caseName: call.caseName,
          axis: call.axis,
          triggerCode: call.code,
          suggestion: call.suggestion ?? '',
          tool: prescription.tool,
          action: prescription.action,
          outcome: executed.outcome,
          code: executed.code,
          thrown: executed.thrown,
        });
      }

      // EXAMINED, per the operational definition in this file's docblock.
      // m07's portable double is evidence for reachability only. It does NOT widen T2/T3/T4:
      // remedy replay remains exactly the private matrix pass above.
      const fired = new Set([...sink.fired, ...externalFiredSites]);
      examinedDriveable = [...DRIVEABLE_SITES].filter((site) => fired.has(site)).sort();
      residualDriveable = [...DRIVEABLE_SITES].filter((site) => !fired.has(site)).sort();
    });

    afterAll(async () => boundary?.close());

    it('T1 (HARD) — no driven call CRASHES, from any established trigger state', () => {
      const crashes = driven.filter((c) => c.outcome === 'CRASHES');
      for (const crash of crashes) {
        // eslint-disable-next-line no-console
        console.log(
          `  CRASH ${crash.axis} :: ${crash.caseName} :: ${crash.tool}(${crash.action ?? '—'}) :: ${crash.thrown}`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 matrix] cases=${MATRIX.length} calls=${driven.length} ` +
          `SUCCEEDS=${driven.filter((c) => c.outcome === 'SUCCEEDS').length} ` +
          `REFUSES=${driven.filter((c) => c.outcome === 'REFUSES').length} ` +
          `CRASHES=${crashes.length} TIMEOUTS=${driven.filter((c) => c.outcome === 'TIMEOUT').length}`
      );
      expect(crashes.map((c) => `${c.caseName}:${c.tool}(${c.action ?? '—'})`)).toEqual([]);
    });

    it('T1 (HARD) — no driven call TIMES OUT', () => {
      expect(driven.filter((c) => c.outcome === 'TIMEOUT').map((c) => c.caseName)).toEqual([]);
    });

    it('T1 (HARD) — private replay transport and credentials stay inside isolated loopback state', () => {
      expect(boundary.blockedUrls).toEqual([]);
      expect(boundary.positiveControlBlocked).toBe(true);
      expect(boundary.double.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(path.dirname(boundary.sourceCredentialPath)).toBe(boundary.configDir);
      expect(path.dirname(boundary.mirrorCredentialPath!)).toBe(boundary.configDir);
      expect(fs.realpathSync(boundary.configDir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(
        true
      );
    });

    it('T2 (HARD) — an executable prescription does not CRASH when run from the state that emitted it', () => {
      const crashed = replays.filter((r) => r.outcome === 'CRASHES' || r.outcome === 'TIMEOUT');
      for (const replay of crashed) {
        // eslint-disable-next-line no-console
        console.log(
          `  REMEDY ${replay.outcome} ${replay.site} -> ${replay.tool}(${replay.action ?? '—'}) :: ${replay.thrown}`
        );
      }
      expect(crashed.map((r) => `${r.site} -> ${r.tool}(${r.action ?? '—'})`)).toEqual([]);
    });

    it('T3 (HARD) — an executed remedy does not return the SAME error code it was attached to', () => {
      // A remedy that reproduces the refusal it was offered for is not a remedy. This is the
      // mechanical form of "it changes the state the error complained about", with no semantics.
      const reproduced = replays.filter(
        (r) => r.outcome === 'REFUSES' && r.code !== undefined && r.code === r.triggerCode
      );
      for (const replay of reproduced) {
        // eslint-disable-next-line no-console
        console.log(
          `  REMEDY REPRODUCES ${replay.code} :: ${replay.site} :: "${replay.suggestion.slice(0, 90)}" ` +
            `-> ${replay.tool}(${replay.action ?? '—'})`
        );
      }
      expect(
        reproduced.map((r) => `${r.site} -> ${r.tool}(${r.action ?? '—'}) [${r.code}]`)
      ).toEqual([]);
    });

    it('T4 (DISCLOSED) — a remedy that REFUSES from that state says it is conditional', () => {
      const undisclosed = replays.filter(
        (r) => r.outcome === 'REFUSES' && !disclosesCondition(r.suggestion)
      );
      for (const replay of undisclosed) {
        // eslint-disable-next-line no-console
        console.log(
          `  UNDISCLOSED ${replay.site} :: "${replay.suggestion.slice(0, 110)}" -> ` +
            `${replay.tool}(${replay.action ?? '—'}) refused ${replay.code}`
        );
      }
      expect(undisclosed.map((r) => r.site)).toEqual([]);
    });

    it('publishes the CALL-BEARING subset as its OWN, SECOND number — never conflated with EXAMINED', () => {
      const callBearingExamined = examinedDriveable.filter((site) =>
        CALL_BEARING_DRIVEABLE.some((row) => row.site === site)
      );
      const replayedSites = new Set(replays.map((r) => r.site));
      const passed = replays.filter(
        (r) =>
          r.outcome !== 'CRASHES' &&
          r.outcome !== 'TIMEOUT' &&
          !(r.outcome === 'REFUSES' && r.code === r.triggerCode)
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 call-bearing] driveable-call-bearing=${CALL_BEARING_DRIVEABLE.length} ` +
          `examined=${callBearingExamined.length} replayed-sites=${replayedSites.size} ` +
          `remedy-executions=${replays.length} passing=${passed.length} ` +
          `passRate=${replays.length === 0 ? 'n/a' : `${((passed.length / replays.length) * 100).toFixed(1)}%`}`
      );
      // T2/T3 apply ONLY here. The arm must actually have executed something.
      expect(replays.length).toBeGreaterThan(0);
      expect(passed.length).toBe(replays.length);
    });

    it('T7 (LEDGER) — E + R === driveable, and every residual is NAMED with a stated reason', () => {
      const distinctValues = [...sink.values].filter(([site]) => DRIVEABLE_SITES.has(site));
      const multiValueSites = distinctValues.filter(([, values]) => values.size > 1);
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 ledger] sites=${CENSUS.length + 2} authored=${CENSUS.length} driveable=${DRIVEABLE.length} ` +
          `examined=${examinedDriveable.length} residual=${residualDriveable.length} ` +
          `outside-driveable-examined=${CENSUS.length - examinedDriveable.length} (not Arc debt)`
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 ledger] distinct observed VALUES at examined driveable sites=${distinctValues.reduce(
          (n, [, v]) => n + v.size,
          0
        )}; sites authoring more than one string=${multiValueSites.length} ` +
          `(a site counted EXAMINED may still have unexamined branches)`
      );
      for (const site of residualDriveable) {
        const reason = RESIDUAL_REASONS[site];
        // eslint-disable-next-line no-console
        console.log(`  RESIDUAL ${site} :: ${reason ?? '*** NO STATED REASON ***'}`);
      }
      // The equality, and — the part that makes it non-vacuous — a stated reason for every residual.
      expect(examinedDriveable.length + residualDriveable.length).toBe(DRIVEABLE.length);
      expect(residualDriveable.filter((site) => !RESIDUAL_REASONS[site])).toEqual([]);
      // Guard the other direction: a reason for a site that is NOT residual is stale bookkeeping.
      expect(
        Object.keys(RESIDUAL_REASONS).filter((site) => !residualDriveable.includes(site))
      ).toEqual([]);
    });

    it('ARC F ITEM 1 ROUTER ADJUDICATION — partitions every authored site with zero wire credit', () => {
      const sorted = (sites: Iterable<string>): string[] => [...sites].sort();
      const intersection = (left: Set<string>, right: Set<string>): Set<string> =>
        new Set([...left].filter((site) => right.has(site)));
      const difference = (left: Set<string>, right: Set<string>): Set<string> =>
        new Set([...left].filter((site) => !right.has(site)));
      const examinedExternal = [...EXTERNAL_SITES].filter((site) => externalFiredSites.has(site));
      const residualExternal = [...EXTERNAL_SITES].filter((site) => !externalFiredSites.has(site));
      const examinedFirstRun = [...FIRST_RUN_SITES].filter((site) => externalFiredSites.has(site));
      const residualFirstRun = [...FIRST_RUN_SITES].filter((site) => !externalFiredSites.has(site));
      const preAdjudicationCandidates = new Set([
        ...DRIVEABLE_SITES,
        ...EXTERNAL_SITES,
        ...FIRST_RUN_SITES,
      ]);
      const routerExamined = new Set([
        ...examinedDriveable,
        ...examinedExternal,
        ...examinedFirstRun,
      ]);
      const adjudicatedUnreachable = new Set([
        ...residualDriveable,
        ...residualExternal,
        ...residualFirstRun,
      ]);
      const nonFirstRunFaults = CENSUS.filter(
        (row) => row.triggerClass === 'FAULT' && !FIRST_RUN_SITES.has(row.site)
      ).map((row) => row.site);
      const faultShapedDriveable = residualDriveable.filter((site) =>
        FAULT_SHAPED_DRIVEABLE_RESIDUALS.has(site)
      );
      const constructionMasked = [
        ...residualDriveable.filter((site) => !FAULT_SHAPED_DRIVEABLE_RESIDUALS.has(site)),
        ...residualExternal,
        ...CENSUS.filter((row) => row.triggerClass === 'UNTYPED').map((row) => row.site),
      ];
      const internalFaultPark = new Set([...nonFirstRunFaults, ...faultShapedDriveable]);
      const maskedPark = new Set(constructionMasked);
      const parkedComplement = new Set([...internalFaultPark, ...maskedPark]);
      const authoredSites = new Set(CENSUS.map((row) => row.site));

      expect(preAdjudicationCandidates.size).toBe(
        DRIVEABLE_SITES.size + EXTERNAL_SITES.size + FIRST_RUN_SITES.size
      );
      expect(sorted(intersection(routerExamined, adjudicatedUnreachable))).toEqual([]);
      expect(sorted(new Set([...routerExamined, ...adjudicatedUnreachable]))).toEqual(
        sorted(preAdjudicationCandidates)
      );
      expect(routerExamined.size + adjudicatedUnreachable.size).toBe(
        preAdjudicationCandidates.size
      );
      expect(residualFirstRun).toEqual([]);
      expect(sorted(faultShapedDriveable)).toEqual(sorted(FAULT_SHAPED_DRIVEABLE_RESIDUALS));
      expect(sorted(intersection(internalFaultPark, maskedPark))).toEqual([]);
      expect(sorted(intersection(routerExamined, parkedComplement))).toEqual([]);
      expect(sorted(new Set([...routerExamined, ...parkedComplement]))).toEqual(
        sorted(authoredSites)
      );
      expect(routerExamined.size + parkedComplement.size).toBe(authoredSites.size);
      expect(sorted(intersection(preAdjudicationCandidates, parkedComplement))).toEqual(
        sorted(adjudicatedUnreachable)
      );
      expect(sorted(difference(parkedComplement, adjudicatedUnreachable))).toEqual(
        sorted(difference(authoredSites, preAdjudicationCandidates))
      );

      // eslint-disable-next-line no-console
      console.log(
        `[s90-m08 Arc F router adjudication] pre-adjudication-candidates=${preAdjudicationCandidates.size} ` +
          `router-examined=${routerExamined.size} adjudicated-unreachable=${adjudicatedUnreachable.size} ` +
          `partition=${routerExamined.size}+${adjudicatedUnreachable.size}; ` +
          `first-run-router-examined=${examinedFirstRun.length} wire-credit=0`
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s90-m08 Arc F authored partition] authored=${authoredSites.size} ` +
          `router-examined=${routerExamined.size} parked-complement=${parkedComplement.size} ` +
          `partition=${routerExamined.size}+${parkedComplement.size}; ` +
          `internal-fault=${internalFaultPark.size} construction-masked=${maskedPark.size}`
      );
      // eslint-disable-next-line no-console
      console.log(`[s90-m08 #1127 internal-fault resume trigger] ${INTERNAL_FAULT_RESUME_TRIGGER}`);
      // eslint-disable-next-line no-console
      console.log(`[s90-m08 masked resume trigger] ${MASKED_RESUME_TRIGGER}`);
      // eslint-disable-next-line no-console
      console.log(
        '[s90-m08 closure commands] RBOOK_DASHBOARD_URL=http://127.0.0.1:9 npx jest ' +
          'tests/tools/rbook/suggestion-oracle.test.ts --runInBand --coverage=false; ' +
          'npx jest --config jest.e2e.config.js --runInBand tests/e2e/wire-preflight.e2e.ts'
      );
    });
  }
);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// MIRROR INTEGRITY — a harness that is not testing the shipped code must fail loudly
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('s89-m08 MIRROR INTEGRITY — the instrument proves it is byte-faithful, every run', () => {
  it('regenerates from src/ in this run and restores every file byte-for-byte', () => {
    // buildSuggestionMirror throws on any SHA-256 mismatch; calling it here re-proves it for the
    // portable path too (the matrix arm above builds its own).
    const result = buildSuggestionMirror();
    const { sites, forwarding, files } = countAllSuggestionSites();
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 mirror] wraps=${result.wraps} changedFiles=${result.changedFiles.length} ` +
        `transpiled=${result.transpiledFiles} integrityChecked=${result.integrityChecked}`
    );
    expect(result.wraps).toBe(sites);
    expect(result.changedFiles).toHaveLength(files);
    expect(result.integrityChecked).toBe(files);
    expect(result.sites.filter((s) => s.forwarding)).toHaveLength(forwarding);
  });

  it('writes back to NO file in src/, proven by content hash rather than by git status', () => {
    // Deliberately NOT `git status --porcelain` on src/: that cannot tell a mirror write-back from
    // an ordinary uncommitted edit, so it would be green on a clean tree and red on every working
    // branch — a gate that only fires when nobody is working. Hashing src/ around the build proves
    // the actual claim: the transform reads src/ and writes only into its own cache root.
    const before = new Map<string, string>();
    for (const file of walkTsFiles(SRC_ROOT)) {
      before.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
    buildSuggestionMirror();
    const changed: string[] = [];
    for (const [file, digest] of before) {
      const now = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (now !== digest) changed.push(path.relative(REPO_ROOT, file));
    }
    expect(changed).toEqual([]);
    // Scratch placement is deliberately stricter than identity detection: avoid every mirror
    // exclusion, including untracked leak guards, so a future tracking change stays harmless.
    expect(MIRROR_ROOT.startsWith(path.join(REPO_ROOT, 'tmp'))).toBe(false);
    const exclusions = readMirrorExclusions().all;
    for (const marker of exclusions) {
      expect(path.relative(REPO_ROOT, MIRROR_ROOT).split(path.sep)[0]).not.toBe(marker);
    }
    const realTemp = fs.realpathSync(os.tmpdir());
    const isDescendant = (parent: string, candidate: string): boolean => {
      const relative = path.relative(parent, candidate);
      return (
        relative.length > 0 &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    expect(externalScratchRoots.size).toBeGreaterThan(0);
    for (const scratchRoot of externalScratchRoots) {
      expect(isDescendant(realTemp, scratchRoot)).toBe(true);
      expect(isDescendant(REPO_ROOT, scratchRoot)).toBe(false);
      for (const marker of exclusions) {
        expect(path.relative(REPO_ROOT, scratchRoot).split(path.sep)[0]).not.toBe(marker);
      }
    }
    expect(externalCredentialPaths.size).toBeGreaterThan(0);
    for (const credentialPath of externalCredentialPaths) {
      expect(isDescendant(realTemp, credentialPath)).toBe(true);
      expect(isDescendant(path.join(os.homedir(), '.config'), credentialPath)).toBe(false);
      expect(externalCredentialModes.get(credentialPath)).toBe(0o600);
      expect(externalCredentialResolutions.get(credentialPath)).toBe(credentialPath);
    }
  });
});

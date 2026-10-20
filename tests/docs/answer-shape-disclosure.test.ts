// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sprint 89 m04 answer-shape snapshot, mixed-kind disclosure, and currentState emit gate.
// ABOUTME: Pins exported Reasonbook Error/Result closures by symbol, declared syntax, and runtime JSON kind.

/**
 * Sprint 89 m04 — ANSWER-SHAPE DISCLOSURE GATE.
 *
 * Scope: every interface/type exported from a `src/tools/rbook` module under a name ending `Error`
 * or `Result`, plus every named interface/type transitively reached anywhere in the corresponding
 * `src/` program through references, import types, or heritage, is recorded here. Roots come from
 * TypeScript module export tables, so `export { XResult }` and an external declaration re-exported
 * as `*Result` count. Every closure declaration gets a module-qualified composition fingerprint
 * covering alias RHS, resolved semantic literals, type parameters, heritage, and every interface
 * member kind. Direct properties also record declared syntax and checker-resolved runtime kind.
 *
 * ARM 1 snapshots that surface. Regenerating the snapshot with `-u` carries a release-note
 * obligation: this gate exists because 2.8.0 changed `RbookToolError.currentState` on the wire and
 * nothing in the repository stopped that change from shipping without disclosure.
 *
 * ARM 2 ledgers mixed JSON kinds. `RbookToolError.currentState` requires a literal CHANGELOG token;
 * `RankedResult.id` is an in-process ranking row, not a tool answer, and predates 2.7.0.
 * `RBOOK_ANSWER_SHAPE_CHANGELOG` may point at a scratch CHANGELOG for the pre-disclosure RED, and
 * `RBOOK_ANSWER_SHAPE_SOURCE_ROOT` may point at a scratch rbook tree for a composition fire.
 *
 * ARM 3 counts direct `currentState:` assignments, direct object initializers, and the eight
 * unguarded `${error.currentState}` formatter interpolations. `RBOOK_ANSWER_SHAPE_EMIT_ROOT` may
 * point at a scratch rbook source copy. Anti-vacuity tests mutate strings in memory, never files.
 *
 * FALSE-NEGATIVE PROFILE — the declared complement of the scope above:
 *
 * - Declared/runtime kind: explicit `any` / `unknown` carries no inspectable JSON kind. Exactly
 *   three reachable sites are opaque: `RbookToolError.providedValue`,
 *   `DashboardMessage.evidence` (`array<ANY>`), and `PulledSyncEvent.payload`.
 * - Generic kind is separate from explicit opacity. Exactly three rows are open type-parameter
 *   holes: `RbookToolResult.data`, `SingleCurrentSprintResult.data`, and
 *   `CrossStoreQueryResult.results` (`array<GENERIC>`). Call-site substitution can change their
 *   JSON kind without changing the declaration snapshot.
 * - Answer types: input shapes are outside this gate. The tool-definition snapshot owns the input
 *   half; `TOOL_REFERENCE.md`'s freshness test owns its generated prose.
 * - Exported roots: a module-private `*Result` is excluded unless an exported root references it.
 *   A non-exported named type that is referenced from a root IS followed into the closure. Runtime
 *   export conditions outside TypeScript's module table are not modeled.
 * - Reference rows: the checker follows named declarations across `src/`, including qualified
 *   `import()` types. A type hidden behind `Record<string, unknown>`, opacity, or a generic remains
 *   undiscoverable. Resolved semantic literal sets cover `typeof CONST[number]`/enum-like value
 *   dependencies; they do not prove runtime validation uses the same constant.
 * - Direct ownership: only PropertySignature members get kind rows. Other/anonymous composition is
 *   still syntax-fingerprinted, but has no independently TypeChecker-resolved property-kind row.
 * - Emit syntax: casts, aliases, calls, conditionals, shorthand properties, and spreads can hide an
 *   object emit from the direct-object census. Parentheses are unwrapped. This is not data flow.
 * - Runtime semantics: neither arm proves which error code reaches a site, whether serialization
 *   occurs, or what a consumer does with the value.
 * - CHANGELOG naming: ARM 2 proves only token presence, not sentence truth. CHANGELOG is excluded
 *   by shipped-prose-truth because release history must retain names that later disappear.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeAnswerShapes,
  RBOOK_SOURCE_ROOT,
  compositionFingerprintsForSource,
  containsNestedKind,
  exportedShapeNamesForSource,
  jsonKind,
  sortedKinds,
} from '../helpers/answer-shape-analysis';
import {
  censusCurrentState,
  emitCensusFindings,
  EXPECTED_INTERPOLATION_FILES,
  loadSourceTexts,
  replaceExactlyOnce,
} from '../helpers/current-state-census';

const REPO_ROOT = path.resolve(__dirname, '../..');
const EMIT_SOURCE_ROOT = process.env.RBOOK_ANSWER_SHAPE_EMIT_ROOT
  ? path.resolve(process.env.RBOOK_ANSWER_SHAPE_EMIT_ROOT)
  : RBOOK_SOURCE_ROOT;
const CHANGELOG_PATH = process.env.RBOOK_ANSWER_SHAPE_CHANGELOG
  ? path.resolve(process.env.RBOOK_ANSWER_SHAPE_CHANGELOG)
  : path.join(REPO_ROOT, 'CHANGELOG.md');
const SHAPE_SOURCE_ROOT = process.env.RBOOK_ANSWER_SHAPE_SOURCE_ROOT
  ? path.resolve(process.env.RBOOK_ANSWER_SHAPE_SOURCE_ROOT)
  : RBOOK_SOURCE_ROOT;

const EXPECTED_TOTALS = {
  // s90-m05: the published sprint-close receipt replaces three scalar/list fields with the named
  // `SprintPendingNextStep`, `SprintPendingNextStepGroups`, and `SprintPendingNextStepsSurvey`
  // closure. That adds three declarations/compositions and nine property rows; the CHANGELOG's
  // Changed section discloses the corresponding answer-shape break.
  // s91-m02: src/tools/rbook/unknown-param-guard.ts joins the analyzed tool root. It declares no
  // answer type, so only the file count moves; roots, declarations and rows are unchanged.
  // s91-m04: rbook-decisions-record.ts adds the root `RbookDecisionsRecordResult` and
  // `SupersededEcho` (additive; the RbookDecisionsResult union widens), and decision-write.ts joins
  // the analyzed root. RbookSessionCaptureResult is unchanged by the extraction.
  // s91-m05: SupersessionCandidate (inside RbookSessionCaptureResult and the record receipt) gains
  // `preview` and `score`; `decisionText` is kept and now holds the preview. Two rows, additive.
  // s91-m06: next-step-lease.ts joins the root; NextStepRecord gains optional closesSurvived and
  // lease; SprintPendingNextStep gains status and closesSurvived; the survey gains totalOpen and
  // the new SprintNextStepLease; the close receipt gains lapsedDroppedIds. All additive.
  // s91-m07: sprint-tracking.ts joins the root; RbookReviewResult.sprint gains `resolvedBy`
  // (additive, same row count — the sprint row's declared shape widens).
  // s92-m01: sender-refusal.ts joins the analyzed tool root (it declares no answer type), and the
  // new `ResolvedBy` type adds one declaration/composition. Nine rows, all additive optional or new
  // fields: RbookReviewResult projectRoot/resolvedBy/registryDefault, MessageWhoamiResult
  // registryDefault/serverProjectRoot, ProjectListItem.defaultApplied, ProjectRegisterResult
  // defaultApplied/ephemeral, ValidationSummary.ephemeral. ProjectValidationItem.status widens with
  // 'ephemeral' and SenderResolutionSource replaces 'registry-singleton' with 'server-project-root'
  // and 'registry-default' — both disclosed in the CHANGELOG.
  // s92-m02: sprint-end-date-repair.ts joins the analyzed root with three declarations
  // (SprintEndDateRepair, RepairedSprintEndDate, UnanchoredSprint). Eighteen rows, all additive:
  // RbookSprintCompleteResult plannedEndDate/endDateRepair, SprintNextStepLease minAgeDays/
  // heldByMinAge/idleWarnDays/idle, SprintPendingNextStep.ageDays, SprintUpdateResult
  // endDateStamped/plannedEndDate, and the repair types' own rows. LeaseState widens with 'idle'.
  // s92-m05: one additive row, SprintLifecycleTriggers.archived (the close archives only when
  // called with archive: true).
  // s92-m03: session-owner.ts and implicit-session-lifecycle.ts join the closure with two
  // declarations (CloseReason, ClosedSessionReceipt). Thirteen rows, all additive: the receipt's
  // eight, plus implicitSession/closedSessions on capture and record, and closedSessions on start.
  // s92-m08: two show actions (rbook-decisions-show.ts, rbook-learnings-show.ts) join as roots, and
  // previews add ContextSearchHit plus truncated/fullLength on search hits, learnings hits and
  // relevant decisions, and status on RankedResult. All additive.
  // s92-m04: six rows, all additive: RecentDecisionSummary id/truncated/fullLength,
  // SuggestedAction.scope, MissionCompleteResult.missionDecisionCount and
  // RbookReviewResult.recentLearnings (its recentDecisions element gains `id` inside the same row).
  // The supersession and implicit-reaffirm fields stay declared, deprecated and never populated.
  // s92-m07: ContextSearchResult.options widens with `excludedStatuses` (the statuses a search left
  // out when the caller named none: ['superseded']), in the same row. RbookDbHealthResult gains
  // `semanticSearch`, typed by the new SemanticSearchStatus (enabled/state/detail): one declaration
  // and composition, four rows, all additive.
  // s92-m09: rbook_db gains prune_snapshots. rbook-db-prune-snapshots.ts (a root) and
  // context-snapshot-prune.ts join the closure; RbookDbPruneSnapshotsResult,
  // PruneSnapshotsContextReport and PreserveReasons add three declarations; RbookDbResult's union
  // widens with the new result. Thirty-two rows, all new: the result also reports bytesReclaimed
  // (counted row by row) and sprintCloses, and PreserveReasons counts sprintCloseState.
  // s93-m11: StalenessResult leaves with the flagger (one declaration and composition, one root,
  // seven rows); first-write-maintenance.ts joins the closure (one file). Previews add
  // truncated/fullLength to DecisionSearchResult, StrategicDecision and MatchedCapture, and
  // summaryTruncated/summaryFullLength to SessionSearchResult; MissionAddResult swaps `mission` for
  // `fields`; MissionUpdateResult gains name and status; onboard's staleness gains the two
  // due-for-review counts; review gains staleReflagged; sprint list gains omittedPlanned; session
  // list's filters gain sessionId; BlobMigrationResult gains rewritten. Net +5 rows.
  // s93-m11 also: CrossStoreProbeValue (one declaration and composition) types the drift probe, and
  // MissionAddResult keeps `mission` (identity only) beside `fields` (one row back).
  // s93-m11 critic folds: stored-time.ts joins the folder (one file). ReviewLearningDetail and
  // SessionListCapture add two declarations and compositions. Nineteen rows, all additive: the
  // review's learnings and their seven fields, Learning.truncated/fullLength, MigrationResult.deferred,
  // ProjectIdentityViewResult.stored, SessionListCapture's four fields, and SessionListItem's
  // captures/summaryTruncated/summaryFullLength. The confirming critic: a capture comes back whole,
  // so SessionListCapture also carries context, expiresAt and sprintId (three rows).
  // s93-m01: harness-session.ts and sqlite-busy.ts join the folder (two files); CloseReason gains
  // 'harness-ended' inside its existing declaration (no row).
  // s93-m12: rules-files.ts and operator-profile.ts join the folder (two files). Init's answer
  // gains `level` and `levelSource` (two rows, additive), typed by ProjectLevel and the new
  // InitLevelSource (two declarations and compositions); the CHANGELOG names both fields.
  // s93-m04: nine local telemetry/pattern/statistics modules join the folder. None adds an
  // exported *Error/*Result root or changes an MCP answer shape; only the file census changes.
  // s93-m05: six local presentation/recall modules plus two light canonical read helpers;
  // the in-process RecallResult root adds
  // RecallItem/RecallVia and fourteen property rows. MCP review's structured shape is unchanged.
  // s93-m08: fleet feedback and presentation add two files; FeedbackFleetCoverage and
  // FeedbackStoreCount add two declarations and six fields, with three additive entry/list fields.
  // s93-m06: five draft modules join the folder (draft-grammar, proposals, draft-runtime,
  // draft-approval, decision-shape). The record answer gains optional `approval`,
  // `answeredDrafts` and `stillPendingDrafts`; RbookDraftRecordResult (a new root, the answer for
  // constraint, rule and profile drafts) joins the RbookDecisionsResult union; ApprovalEcho,
  // DraftKind and ApprovalMode add three more declarations. Ten rows, all additive; the
  // CHANGELOG names the fields.
  // s94-m10: checkpoint-registration, dashboard-upload and dashboard-upload-scheduler add three
  // modules. CheckResult remains private as before extraction; no answer declaration changes.
  // s94-m04: decision-fields and decision-shape-migration add two modules. Decision show gains
  // seven optional fields; alternatives/deciders preserve malformed historical strings and warn.
  // s94-m05: condense gains remainingSectionBytes and mission start gains activatedSprintId.
  // MissionAddResult.sprintId (including its mission copy) becomes nullable; repair receipts can
  // retain any historical previousStatus. These changes are disclosed in Unreleased.
  // s94-m06: citation-neighbors, seven record-link helpers and record-links add nine modules.
  // Their inline helper results add no named Error/Result root or MCP answer declaration.
  // s94-m08: thirteen modules, one CLI result root, and eleven reachable helper/pointer
  // declarations. Forty-four property rows add copy provenance, historical pointers and sprint reports.
  // s95-m12/m13: tool-effects.ts joins the root without a named answer type. ProjectListItem
  // gains id/address/identityError (three rows); whoami's resolved object gains requestedAddress,
  // and SenderResolutionSource/ResolvedBy gain client-cwd inside existing rows. All additive,
  // with the public fields and source label disclosed in the 3.5.0 CHANGELOG.
  // s95-m06: level-files.ts and project-level.ts join the root without a named answer type.
  // ProjectUpdateResult gains filesWritten, and RbookSessionStartResult and RbookDecisionsRecordResult
  // gain projectLevel (three rows, all additive and optional), to be disclosed in the 3.6.0 CHANGELOG.
  // s96-m01: replica-identity.ts, replica-check.ts and intelligence/replica-bindings.ts join the
  // closure through client.ts. They declare no named answer type, so only the file count moves.
  // s96-m02: author-name.ts joins the closure without a named answer type. Six rows, all additive:
  // `author` on RecentDecisionSummary, StrategicDecision (optional), RbookDecisionsShowResult,
  // MissionShowResult and SessionListItem, and GetMyProjectsResult's optional `user` (H3). The
  // review's recent decisions carry an optional `author`, only for a recorded name, inside
  // RbookReviewResult's existing row.
  // s96-m03: the change log's six modules (record-capture, -changes, -columns, -guards, -replay and
  // -share) join the closure through the copy check, without a named answer type.
  // s96-m12: the merge's modules join the closure (nineteen files, peer-sessions.ts among them). rbook_db's conflicts and settle
  // add the roots RbookDbConflictsResult and RbookDbSettleResult (the RbookDbResult union widens),
  // with OpenConflict, ConflictCandidate and CheckFinding: five declarations and 23 rows. The
  // in-process RecallItem gains an optional `conflicts` (one row). All additive, to be disclosed in
  // the 4.1.0 CHANGELOG with the shared record (s96-m09).
  // s96-m13: the sync's modules join the closure (29 files: the exchange and its steps, the wire,
  // SSH, join, membership, moves, recovery, renumbering, the authority chain, the copy keys, the
  // successor's admission and what a copy holds since a peer's marks among them). rbook_project's share, invite, join, members, remove and sync add
  // SharedProjectResult, with the exchange, join, membership and move receipts it carries, and
  // rbook_status gains an optional `shared_sync`. A share's and a sync's warnings ride the answer's
  // own warnings. All additive, to be disclosed in the 4.1.0 CHANGELOG (s96-m09).
  // s96-m14: the import's nine modules (the copy, its ids, matching, the ids it assigns, fields,
  // links, the plan, applying, and its entry); no answer shape: reasonbook import is a CLI verb.
  // s96-m08: legacy-sync-refusal joins the tool root; compatibility result types remain unchanged.
  // s97-m09: record-fresh-copy and record-intake, the referee library's builder and intake check,
  // join the tool root; neither declares an answer type, so only the file count moves.
  // s97-m10: the dashboard transport's four modules (its peer, its route, the pages and the baseline
  // query) join the closure, and rbook_project's sync names, for a peer an automatic sync waited
  // out, an optional `nextTryAt` on PeerOutcome (one row); an exchange's `caughtUp` gains an
  // optional `confirmed`, inside its existing row. Additive, for the 4.2.0 CHANGELOG.
  // s97-m11: sharing, joining and moving back through the dashboard add three modules and five
  // declarations to rbook_project's answers (DashboardSharePlan, DashboardShared, DashboardJoined,
  // MovedBack, and the Handover it carries: 22 rows), and SuccessorReason gains 'move-back'. The
  // critics' first round adds the plan to a confirmed share (23 rows), and lets a move back that
  // finds its referee archived already answer with no sync. Additive, for the 4.2.0 CHANGELOG.
  // s97-m13 (#662): the work queue's order joins the closure (work-queue-order.ts), and a queued
  // mission in rbook_mission's status and the opener's pending list names what it waits on, an
  // optional `waitsOn` (two rows). Not additive, for the 4.2.0 CHANGELOG: MissionStartResult's
  // `startedAt` is absent when start promotes a mission to Current without starting it.
  // s97-m14: an exchange names which side's member was removed (ExchangeReport's optional
  // `removedCopy`, one row), and rbook_status's shared_sync rows gain an optional `removed_at`,
  // inside their existing row. Additive, for the 4.2.0 CHANGELOG.
  // s100-m01: the sharing fixes add three modules to the closure (record-protocol.ts,
  // record-protocol-hold.ts, record-owner-copies.ts), and three rows: ApplyReport's and
  // BundleImport's `newerProtocol`, the changes a newer record protocol kept out, and the identity
  // view's optional `joinedAddress` on a member's copy. Additive, for the 4.2.1 CHANGELOG.
  // s100-m03: a next-step capture returns its row's id (RbookSessionCaptureResult's optional
  // `nextStepId`, one row). Additive, for the 4.2.1 CHANGELOG.
  files: 277,
  roots: 147,
  declarations: 335,
  compositions: 335,
  rows: 1898,
} as const;
const EXPLICIT_OPAQUE_LEDGER = [
  'RbookToolError.providedValue = ANY',
  'DashboardMessage.evidence = array<ANY>',
  'PulledSyncEvent.payload = ANY',
  // s96-m12: a conflicted field's value is whatever the field holds: text, a number, a list or null.
  'ConflictCandidate.value = ANY',
  'OpenConflict.provisional = ANY',
  'RbookDbSettleResult.value = ANY',
] as const;
const GENERIC_HOLE_LEDGER = [
  'RbookToolResult.data = GENERIC',
  'CrossStoreQueryResult.results = array<GENERIC>',
  'SingleCurrentSprintResult.data = GENERIC',
] as const;
const MIXED_KIND_LEDGER = [
  {
    row: 'SpinOutPointer.sourceId',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: 'SpinOutPointer.sourceId',
    reason:
      'Historical pointers preserve string mission IDs and numeric decision, learning or next-step IDs.',
  },
  {
    row: 'SpinOutPointer.targetId',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: 'SpinOutPointer.targetId',
    reason:
      'Copied-row pointers retain the target identifier type rather than coercing numeric records to strings.',
  },
  {
    row: 'SpinOutProvenance.originalProjectId',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: 'SpinOutProvenance.originalProjectId',
    reason:
      'The CLI copy plan preserves historical scalar project identity values in provenance; null is also retained.',
  },
  {
    row: 'RbookDecisionsShowResult.alternatives',
    runtimeKinds: ['array', 'string'],
    requiredChangelogToken: 'RbookDecisionsShowResult.alternatives',
    reason:
      'Valid JSON string arrays return arrays; malformed historical text remains visible as a string with a warning.',
  },
  {
    row: 'RbookDecisionsShowResult.deciders',
    runtimeKinds: ['array', 'string'],
    requiredChangelogToken: 'RbookDecisionsShowResult.deciders',
    reason:
      'Valid JSON string arrays return arrays; malformed historical text remains visible as a string with a warning.',
  },
  {
    row: 'RbookToolError.currentState',
    runtimeKinds: ['object', 'string'],
    requiredChangelogToken: 'currentState',
    reason:
      'A tool error changed from a session-id string to an object for SESSION_ALREADY_ACTIVE in 2.8.0.',
  },
  {
    row: 'RankedResult.id',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: null,
    reason:
      'Not a tool answer: fts5-retriever.ts uses this exported *Result in process; it predates 2.7.0.',
  },
  {
    row: 'CrossStoreProbe.value',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: null,
    reason:
      "Not a tool answer: rbook-review.ts reads it in process to classify drift; 'no-history' (s93-m11) marks a store with no rows yet.",
  },
] as const;

const ANSWER_SHAPES = analyzeAnswerShapes(SHAPE_SOURCE_ROOT);
const CANONICAL_EMIT_SOURCES = loadSourceTexts(RBOOK_SOURCE_ROOT);
const CHECKED_EMIT_SOURCES =
  EMIT_SOURCE_ROOT === RBOOK_SOURCE_ROOT
    ? CANONICAL_EMIT_SOURCES
    : loadSourceTexts(EMIT_SOURCE_ROOT);

function analyzeExternalFixture(toolSource: string, authSource: string) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-answer-shape-'));
  const toolRoot = path.join(fixture, 'src', 'tools', 'rbook');
  const authRoot = path.join(fixture, 'src', 'auth');
  fs.mkdirSync(toolRoot, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true });
  fs.writeFileSync(path.join(toolRoot, 'fixture.ts'), toolSource);
  fs.writeFileSync(path.join(authRoot, 'auth-state.ts'), authSource);
  try {
    return analyzeAnswerShapes(toolRoot);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe('answer-shape disclosure gate (Sprint 89 m04)', () => {
  it('derives the exact symbol-safe answer closure and keeps opacity ledgers explicit', () => {
    expect({
      files: ANSWER_SHAPES.fileCount,
      roots: ANSWER_SHAPES.roots.length,
      declarations: ANSWER_SHAPES.declarations.length,
      compositions: ANSWER_SHAPES.compositionRows.length,
      rows: ANSWER_SHAPES.rows.length,
    }).toEqual(EXPECTED_TOTALS);
    expect(
      new Set(ANSWER_SHAPES.declarations.map((declaration) => declaration.identity)).size
    ).toBe(ANSWER_SHAPES.declarations.length);

    for (const [, modules] of ANSWER_SHAPES.duplicateOwnerNames) {
      expect(modules.length).toBeGreaterThan(1);
      for (const moduleId of modules) expect(moduleId).toMatch(/^src\//);
    }
    for (const name of ANSWER_SHAPES.duplicateOwnerNames.keys()) {
      expect(ANSWER_SHAPES.rows.some((row) => row.key.startsWith(`${name}.`))).toBe(false);
      expect(ANSWER_SHAPES.rows.some((row) => row.key.startsWith(`${name}@`))).toBe(true);
    }
    const projectTypeFields = ANSWER_SHAPES.compositionRows.filter((row) =>
      row.startsWith('src/tools/rbook/project-identity.ts#ProjectTypeFields:')
    );
    expect(projectTypeFields).toHaveLength(1);
    expect(projectTypeFields[0]).toContain('[ key : string ] : unknown ;');
    const authState = ANSWER_SHAPES.compositionRows.filter((row) =>
      row.startsWith('src/auth/auth-state.ts#AuthState:')
    );
    expect(authState).toHaveLength(1);
    expect(authState[0]).toContain('identitySource');
    expect(
      ANSWER_SHAPES.compositionRows.some((row) =>
        row.startsWith('src/intelligence/cross-store-query.ts#CrossStoreRow:')
      )
    ).toBe(true);

    const unresolved = ANSWER_SHAPES.rows
      .filter((row) => row.runtimeKinds.some((kind) => kind.startsWith('UNRESOLVED')))
      .map((row) => row.snapshot);
    const opaque = ANSWER_SHAPES.rows
      .filter((row) => containsNestedKind(row.runtimeKinds, 'ANY'))
      .map((row) => `${row.key} = ${row.runtimeKinds.join(' | ')}`)
      .sort();
    const generics = ANSWER_SHAPES.rows
      .filter((row) => containsNestedKind(row.runtimeKinds, 'GENERIC'))
      .map((row) => `${row.key} = ${row.runtimeKinds.join(' | ')}`)
      .sort();
    expect(unresolved).toEqual([]);
    expect(opaque).toEqual([...EXPLICIT_OPAQUE_LEDGER].sort());
    expect(generics).toEqual([...GENERIC_HOLE_LEDGER].sort());
  });

  it('snapshots declaration composition and checker-resolved property JSON kinds', () => {
    expect({
      declarationComposition: ANSWER_SHAPES.compositionRows,
      propertyRows: ANSWER_SHAPES.rows.map((row) => row.snapshot),
    }).toMatchSnapshot();
  });

  it('changes a declaration fingerprint when a union member is removed', () => {
    const prefix = `
      export interface LoginActionResult { action: 'login' }
      export interface LogoutActionResult { action: 'logout' }
    `;
    const before = compositionFingerprintsForSource(
      `${prefix}\nexport type RbookAuthResult = LoginActionResult | LogoutActionResult;`
    ).find((row) => row.includes('#RbookAuthResult:'));
    const after = compositionFingerprintsForSource(
      `${prefix}\nexport type RbookAuthResult = LoginActionResult;`
    ).find((row) => row.includes('#RbookAuthResult:'));
    expect(before).toContain('LogoutActionResult');
    expect(after).not.toContain('LogoutActionResult');
    expect(after).not.toBe(before);
  });

  it('discovers an exported Result declared through an export list', () => {
    expect(
      exportedShapeNamesForSource(`
        interface ListedResult { value: string }
        interface HiddenResult { value: string }
        export { ListedResult };
      `)
    ).toEqual(['ListedResult']);
  });

  it('follows an external import type and ignores comments while catching shape/value drift', () => {
    const tool = `
      export interface WhoamiResult {
        authState: import('../../auth/auth-state').AuthState;
      }
    `;
    const auth = (values: string, extra = '', comment = '') => `
      export const VALID_AUTH_TIERS = [${values}] as const;
      export type AuthTier = (typeof VALID_AUTH_TIERS)[number];
      export interface AuthState {
        identitySource: string ${comment};
        authTier: AuthTier;
        ${extra}
      }
    `;
    const baseline = analyzeExternalFixture(tool, auth("'api-key', 'none'"));
    const commented = analyzeExternalFixture(tool, auth("'api-key', 'none'", '', '/* trivia */'));
    const newField = analyzeExternalFixture(
      tool,
      auth("'api-key', 'none'", 's89WireField: string;')
    );
    const newLiteral = analyzeExternalFixture(tool, auth("'api-key', 'none', 'refreshing'"));
    const enumAuth = (extra = '') => `
      export enum AuthMode { ApiKey = 'api-key', None = 'none' ${extra} }
      export interface AuthState { mode: AuthMode; }
    `;
    const enumBaseline = analyzeExternalFixture(tool, enumAuth());
    const enumChanged = analyzeExternalFixture(tool, enumAuth(", Refreshing = 'refreshing'"));
    const row = (analysis: typeof baseline, identity: string) =>
      analysis.compositionRows.find((entry) => entry.startsWith(identity));
    const authIdentity = 'src/auth/auth-state.ts#AuthState:';
    const tierIdentity = 'src/auth/auth-state.ts#AuthTier:';

    expect(row(baseline, authIdentity)).toBeDefined();
    expect(commented.compositionRows).toEqual(baseline.compositionRows);
    expect(row(newField, authIdentity)).toContain('s89WireField');
    expect(row(newField, authIdentity)).not.toBe(row(baseline, authIdentity));
    expect(row(newLiteral, tierIdentity)).toContain('refreshing');
    expect(row(newLiteral, tierIdentity)).not.toBe(row(baseline, tierIdentity));
    expect(row(enumChanged, authIdentity)).toContain('refreshing');
    expect(row(enumChanged, authIdentity)).not.toBe(row(enumBaseline, authIdentity));
  });

  it('treats an external declaration re-exported as *Result as a rbook answer root', () => {
    const analysis = analyzeExternalFixture(
      `export { AuthState as ExternalAuthResult } from '../../auth/auth-state';`,
      `export interface AuthState { identitySource: string; }`
    );
    expect(analysis.roots.map((root) => root.identity)).toEqual([
      'src/auth/auth-state.ts#AuthState',
    ]);
  });

  it('follows named constraints and defaults on generic answer declarations', () => {
    const analysis = analyzeExternalFixture(
      `
        interface BoundRow { id: string }
        export interface GenericResult<T extends BoundRow = BoundRow> { data: T }
      `,
      ''
    );
    expect(analysis.compositionRows.some((row) => row.includes('#BoundRow:'))).toBe(true);
  });

  it('ledgers every mixed JSON-kind row and requires disclosure for currentState', () => {
    const mixedRows = ANSWER_SHAPES.rows
      .filter((row) => {
        const kinds = new Set(
          row.runtimeKinds.map(jsonKind).filter((kind): kind is string => !!kind)
        );
        return kinds.size > 1;
      })
      .map((row) => ({
        row: row.key,
        runtimeKinds: sortedKinds(
          row.runtimeKinds.map(jsonKind).filter((kind): kind is string => !!kind)
        ),
      }))
      .sort((a, b) => a.row.localeCompare(b.row));
    expect(mixedRows).toEqual(
      MIXED_KIND_LEDGER.map((entry) => ({
        row: entry.row,
        runtimeKinds: [...entry.runtimeKinds],
      })).sort((a, b) => a.row.localeCompare(b.row))
    );

    const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    for (const entry of MIXED_KIND_LEDGER) {
      console.log(`[answer-shape mixed-kind] ${entry.row}: ${entry.reason}`);
      if (entry.requiredChangelogToken && !changelog.includes(entry.requiredChangelogToken)) {
        throw new Error(
          `${entry.row} requires CHANGELOG token ${JSON.stringify(entry.requiredChangelogToken)}; ` +
            `token is absent from ${CHANGELOG_PATH}`
        );
      }
    }
  });

  it('censuses currentState emit sites and all eight unguarded string interpolations', () => {
    expect(emitCensusFindings(censusCurrentState(CHECKED_EMIT_SOURCES))).toEqual([]);
  });

  it('fails independently for a sixteenth direct currentState assignment', () => {
    const mutated = CANONICAL_EMIT_SOURCES.map((source, index) =>
      index === 0
        ? {
            ...source,
            text: `${source.text}\nconst s89AssignmentFire = { currentState: 'fixture' };\n`,
          }
        : source
    );
    const census = censusCurrentState(mutated);
    const findings = emitCensusFindings(census);
    expect(census.assignments).toBe(16);
    expect(census.directObjectLiterals).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('Expected 15 direct currentState property assignments; found 16');
    for (const file of EXPECTED_INTERPOLATION_FILES) expect(findings[0]).toContain(file);
  });

  it('fails independently for a second parenthesized currentState object literal', () => {
    const mutated = CANONICAL_EMIT_SOURCES.map((source) =>
      source.relativePath === 'rbook-mission-block.ts'
        ? replaceExactlyOnce(
            source,
            'currentState: currentStatus,',
            "currentState: ({ id: 's89-object-fire' }),"
          )
        : source
    );
    const census = censusCurrentState(mutated);
    const findings = emitCensusFindings(census);
    expect(census.assignments).toBe(15);
    expect(census.directObjectLiterals).toBe(2);
    expect(findings.some((finding) => finding.includes('found 2'))).toBe(true);
    expect(findings.every((finding) => finding.includes('[object Object]'))).toBe(true);
    for (const file of EXPECTED_INTERPOLATION_FILES) {
      expect(findings.every((finding) => finding.includes(file))).toBe(true);
    }
  });
});

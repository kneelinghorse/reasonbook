// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m03 router forwarding gate — no consolidated router may declare or accept a
// ABOUTME: parameter it silently drops, and no handler-accepted key may go unpublished. No allowlist.

/**
 * Sprint 86 m03 — "say only what you know", enforced on the PARAMETER surface.
 *
 * THE DEFECT CLASS. A consolidated router reconstructs an object literal per action branch. Every
 * key it forgets is a capability an agent can name and the server will silently ignore: the call
 * returns `success: true`, the database is untouched, and no layer says a word. Three such gaps
 * were live in the shipped surface when this gate was written, one of them for years.
 *
 * ── MEASURED PRE-FIX RED BASELINE ────────────────────────────────────────────────────────────
 * Measured 2026-08-11 by running THIS walker against a clean `git worktree` of 766d346. Re-measured
 * after every change to the walker's rules, because a baseline recorded against an earlier version
 * of the instrument is not a baseline — the first version of these numbers went stale under my own
 * fixes and a build-time critic caught it.
 *
 * ASSERTION A — 6 sites / 7 keys:
 *
 *   src/tools/rbook/rbook-mission.ts:321    registry
 *   src/tools/rbook/rbook-context.ts:456    statusFilter
 *   src/tools/rbook/rbook-session.ts:292    expiresAt
 *   src/tools/rbook/rbook-session.ts:304    agentFeedback
 *   src/tools/rbook/rbook-db.ts:223         perRequestTimeoutMs, overallTimeoutMs
 *   src/tools/rbook/rbook-learnings.ts:203  registry
 *
 * The plan's headline said "4 sites / 7 keys", but its own enumeration (mission criterion 9) names
 * FIVE: rbook-context.ts:456, rbook-session.ts:292, rbook-session.ts:304, rbook-db.ts:223 and
 * rbook-learnings.ts:203. So exactly ONE site is genuinely new — rbook-mission.ts:321, a second
 * `registry` seam of the same shape as the one the sweep did name. The key counts agree at 7 but
 * differ in composition: the plan's 7 includes `_getNow`, which never enters the measured red set
 * because the leading-underscore rule excludes it before scoring; the measured 7 has
 * rbook-mission.ts:321's `registry` in its place.
 *
 * ASSERTION B — 7 tools / 10 keys, recorded BEFORE any exclusion was written (the plan required
 * that ordering so an unexpectedly large red set could not be met with an invented rule):
 *
 *   rbook_mission         registry
 *   rbook_context         statusFilter
 *   rbook_session         expiresAt, agentFeedback
 *   rbook_db              perRequestTimeoutMs, overallTimeoutMs
 *   rbook_learnings       registry
 *   rbook_message         advertisedRoots
 *   rbook_agent_onboard   advertisedRoots, callerProvidedProjectRoot
 *
 * `rbook_message advertisedRoots` was invisible until a build-time critic showed that PASS-THROUGH
 * calls bypassed B entirely — 2 of 15 tools with no effective coverage, which is how an unpublished,
 * untagged MCP-boundary seam sat green beside its twin on rbook_agent_onboard, where the identical
 * key was required to carry a stated reason. Every entry is a top-level key on one of the 15
 * registered tools, so NOTHING was handed to m04: three were published and forwarded (statusFilter,
 * expiresAt, agentFeedback), two `registry` seams moved out of parameter 0, and five were tagged
 * `@internal` with a stated reason (perRequestTimeoutMs, overallTimeoutMs, both `advertisedRoots`,
 * callerProvidedProjectRoot). 3 + 2 + 5 = 10.
 *
 * ASSERTION C — empty before and after. The walk classified all 15 tools on the pre-fix tree.
 * Pre-fix rule exclusions were `_getNow` (underscore) and `client` (infrastructure-type).
 *
 * ── DISCRIMINATION IS BY RULE, NOT BY ALLOWLIST (Process Hardening #2, agents.md) ─────────────
 * There is no allowlist file and no per-site exemption anywhere in this suite. A key leaves the
 * scored set only by one of FOUR derived rules, and every one of them RECORDS what it excluded so
 * the complete set is printed on each run and growth appears in a diff:
 *
 *   underscore            a leading `_` — the in-tree convention for a test hook
 *   internal-jsdoc        an `@internal` tag WITH a stated reason; a bare tag excludes nothing
 *   outside-parameter-0   declared on a later parameter, off the caller-facing surface
 *   infrastructure-type   a positional parameter typed `RbookDatabaseClient` — a wiring seam
 *
 * Rules 3 and 4 became recorded rules only after a build-time critic pointed out that both were
 * silent: `outside-parameter-0` produced no entry at all, making "move the key to parameter 1" the
 * cheapest way to silence this gate with nothing in the printed artifact to show for it — a move
 * THIS MISSION made twice. `infrastructure-type` was a hardcoded set of four type names, three of
 * which matched nothing in the tree; it now holds only the one that is exercised, so a genuinely
 * new infra type turns the gate red and must be added in a visible diff.
 *
 * `@internal` is an allowlist with better manners unless it is constrained, so the gate also
 * asserts that every excluded key is absent from the published inputSchema of EVERY registered tool
 * — a key cannot be both internal and published.
 *
 * ── FALSE-NEGATIVE PROFILE ────────────────────────────────────────────────────────────────────
 * A gate whose limits are undocumented is a false assurance — the same class this sprint exists
 * to close. Every hole below is KNOWN, named here rather than discovered later:
 *
 *  1. NAME FLOW, NOT VALUE FLOW. `evergreen: undefined` and `learningId: params.learningId ?? 0`
 *     both pass. The gate proves a key was written, never that a usable value arrives.
 *  2. IT STOPS AT THE HANDLER SIGNATURE. A param the handler ACCEPTS and its body ignores is
 *     invisible — which is exactly layer (c) of the `expiresAt` bug (the router forwarded nothing,
 *     but even had it, `rbook-session-capture.ts`'s newCapture literal never persisted it) and the
 *     s85-m04 SQL-omission shape. Only the real-store read-back fires cover that layer.
 *  3. THE APPLICABILITY ORACLE IS THE HANDLER'S PARAMETER TYPE. An over-declaring handler yields a
 *     false positive; an UNDER-declaring one hides a true gap. That under-declaration is why this
 *     gate is permanently blind to the motivating `evergreen` defect: at 766d346
 *     `RbookLearningsReaffirmParams` declared only `learningId` and `projectRoot`, so a
 *     declared-vs-forwarded rule has nothing to name. The build plan (§2 s86-m03 item 5) records
 *     that both directions of that rule were built and run green against the pre-fix tree; NO
 *     artifact of that run survives in this tree and this mission did not repeat it — the reason
 *     above is structural and checkable, the run is not. Making it mechanically detectable needs
 *     per-action applicability data that does not exist in the tree — s86-m04's ACTION_PARAMS,
 *     generated from this same walker via `npm run probe:router-params`.
 *  4. ASSERTION A IS EFFECTIVELY VACUOUS FOR MONOLITHIC TOOLS. They are not skipped: the walk
 *     synthesises a single `(monolithic)` branch and scores the calls in it. But those callees'
 *     parameter-0 types expose no wire keys, so A finds nothing by construction — which is why B
 *     must cover them, and why the computed shape is PRINTED with its reason.
 *  5. IT ASSUMES THE FOUR COMPUTED CALL SHAPES. Anything else is why C must FAIL rather than skip.
 *  6. A HANDLER CALLED WITH A WHOLLY LITERAL ARGUMENT is NOT-A-FORWARDING-SITE and is not scored.
 *     FOUR such calls exist today — rbook-project.ts:251 `rbookProjectList({})`, rbook-project.ts:261
 *     `rbookProjectValidate({prune: true})`, and rbook-review.ts:300/:301, whose literals sit in
 *     ternary arms. None drops anything today because their accepted sets are empty or fully
 *     supplied by the literal; if a key is added to any of those handler types, A will not see it.
 *  7. B EXCUSES A RENAME. `limit: params.searchLimit` satisfies B via the source key. If a router
 *     renamed a key to something the schema declares for an unrelated purpose, B would pass.
 *  8. NESTED SUB-OBJECT PARITY IS OUT OF SCOPE BY RULE. B compares TOP-LEVEL inputSchema properties
 *     only; `arrayUpdates.*` (rbook-context.ts:112-120 vs the property-less JSON block at :283-286),
 *     `evidence.*` and `fieldUpdates.*` belong to m04, which owns ACTION_PARAMS and the renderer.
 *  9. C HAS TEN ARMS AND ONLY FOUR ARE DEMONSTRATED. The fixtures below cover: no dispatch case for
 *     a registered tool, an ambiguous entry function, an unnameable forwarded key, and a
 *     third-level sub-router. SIX are defensive and untested — unresolvable signature, no parameter
 *     at the object-literal's position, unresolvable callee, a primitive accepting parameter,
 *     a missing dispatch source file, and a renamed `executeMissionProtocolTool`. I could not
 *     construct a TypeScript program that triggers the unresolvable-signature arm at all. They are
 *     stated as untested rather than implied to be covered.
 * 10. A UNION OR BARE-GENERIC PARAMETER-0 SCORES A VACUOUS ZERO. `createSuccess<T>(data: T)`
 *     (errors.ts:147) yields no properties, so any call whose accepting parameter is generic or a
 *     union reports `accepted: []` and can never be red. A PRIMITIVE parameter is reported to C
 *     instead, because its members are prototype methods and scoring them produced a red set of
 *     `toString, charAt, …`.
 * 11. A FORWARDING SITE INSIDE A TERNARY IS SCORED ON THE UNION OF BOTH ARMS. `projectRoot ?
 *     { projectRoot } : {}` (rbook-review.ts:300) counts `projectRoot` as forwarded. A key forwarded
 *     on only ONE arm therefore reads as forwarded — an intersection would instead report a drop on
 *     a path the caller deliberately guards, and this gate checks name flow, not value flow.
 * 12. THE GATE DOES NOT ASSERT ON `nonDelegatingCalls` (56 today). It prints them, so a handler
 *     that falls out of scoring is visible in CI output, but nothing fails if the set grows.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RBOOK_TOOL_DEFINITIONS } from '../../../src/tools/rbook/index';
import {
  walkRouterParams,
  undeclaredSurfaceKeys,
  type WalkResult,
  type ToolModel,
} from '../../../scripts/lib/router-param-walker';

/** Building a real ts.Program is ~1s; every test shares ONE walk of the real tree. */
const TIMEOUT_MS = 120_000;

type ToolDefs = ReadonlyArray<{
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}>;

const REAL_DEFS = RBOOK_TOOL_DEFINITIONS as unknown as ToolDefs;

let real: WalkResult;

beforeAll(() => {
  real = walkRouterParams({ toolDefinitions: REAL_DEFS });
}, TIMEOUT_MS);

/** Every scored call across a tool's branches (NOT-A-FORWARDING-SITE calls score nothing). */
function scoredCalls(model: ToolModel) {
  return model.branches.flatMap((b) =>
    b.calls.filter((c) => c.shape !== 'NOT-A-FORWARDING-SITE').map((c) => ({ action: b.action, c }))
  );
}

function preDispatchKeys(
  result: WalkResult,
  classification?: 'requires-preflight' | 'safe-enum-discriminant' | 'non-string-schema'
): string[] {
  return [
    ...new Set(
      result.tools.flatMap((tool) =>
        tool.preDispatchReads
          .filter((read) => classification === undefined || read.classification === classification)
          .map((read) => read.key)
      )
    ),
  ].sort();
}

describe('router param forwarding gate (s86-m03)', () => {
  // ── Assertion A ────────────────────────────────────────────────────────────
  it(
    'A — every key a delegated handler accepts is forwarded or excluded BY RULE',
    () => {
      const violations: string[] = [];
      for (const tool of real.tools) {
        for (const { action, c } of scoredCalls(tool)) {
          if (c.dropped.length === 0) continue;
          violations.push(
            `${tool.tool}(${action}) → ${c.callee} at ${c.file}:${c.line} drops: ${c.dropped.join(', ')}`
          );
        }
      }
      expect(violations).toEqual([]);
    },
    TIMEOUT_MS
  );

  // ── Assertion B ────────────────────────────────────────────────────────────
  it(
    'B — every handler-accepted key is declared on the tool JSON inputSchema (or its source key is)',
    () => {
      const violations: string[] = [];
      for (const tool of real.tools) {
        const missing = undeclaredSurfaceKeys(tool);
        if (missing.length === 0) continue;
        violations.push(
          `${tool.tool} accepts but never publishes: ${missing
            .map((s) => (s.from ? `${s.key}(←${s.from})` : s.key))
            .join(', ')}`
        );
      }
      expect(violations).toEqual([]);
    },
    TIMEOUT_MS
  );

  // ── Assertion C ────────────────────────────────────────────────────────────
  it(
    'C — the walk classified every registered tool; nothing was skipped',
    () => {
      expect(real.unclassifiable.map((u) => `${u.file}:${u.line} ${u.what} — ${u.detail}`)).toEqual(
        []
      );
      // Every registered tool produced a model. A tool that fell out of the walk would otherwise
      // vanish from A and B silently — a green gate covering 14 of 15 tools.
      expect(real.tools.map((t) => t.tool).sort()).toEqual(REAL_DEFS.map((d) => d.name).sort());
      expect(real.tools).toHaveLength(15);
    },
    TIMEOUT_MS
  );

  // ── Criterion 10: the computed shape is printed for all 15, never skipped ──
  it(
    'prints a computed dispatch shape for all 15 tools and classifies the monolithic ones with a reason',
    () => {
      const shapes = new Map(real.tools.map((t) => [t.tool, t]));
      expect(shapes.size).toBe(15);

      // Printed, so a shape change shows up in CI output rather than only in a red assertion.
      // eslint-disable-next-line no-console
      console.log(
        '\n[s86-m03] dispatch shapes:\n' +
          real.tools.map((t) => `  ${t.tool.padEnd(24)} ${t.shape}  ${t.shapeReason}`).join('\n')
      );

      // MEASURED: four monolithic tools, not the three the plan named. rbook_agent_onboard has no
      // `action` parameter at all, so it was never in the plan's list; the measured set governs.
      const monolithic = real.tools.filter((t) => t.shape === 'MONOLITHIC').map((t) => t.tool);
      expect(monolithic.sort()).toEqual(
        ['rbook_agent_onboard', 'rbook_feedback', 'rbook_review', 'rbook_status'].sort()
      );
      for (const name of monolithic) {
        // A reason, not a skip — and assertion B still covered them above.
        expect(shapes.get(name)!.shapeReason).toMatch(/no action switch in the entry function at/);
      }

      // rbook_message is a SWITCH-ROUTER. Recorded because resolving its entry is the one place the
      // naive "first `result` binding" rule walks the wrong function: its dispatch case has an
      // early-return `whoami` branch binding `getWhoamiDiagnostics` first.
      expect(shapes.get('rbook_message')!.shape).toBe('SWITCH-ROUTER');
      expect(shapes.get('rbook_message')!.entry.file).toBe('src/tools/rbook/rbook-message.ts');

      // handleLogin(store, deviceCodeFlow, dashboardBaseUrl) — parameter 0 is a CredentialStore and
      // no params reach it, so it is neither a drop nor a skip.
      const authLogin = shapes
        .get('rbook_auth')!
        .branches.find((b) => b.action === 'login')!
        .calls.find((c) => c.callee === 'handleLogin');
      expect(authLogin?.shape).toBe('NOT-A-FORWARDING-SITE');
    },
    TIMEOUT_MS
  );

  // ── Criterion 12: the @internal anti-abuse rules ───────────────────────────
  it(
    'prints the complete rule-excluded key set, and no excluded key is also published',
    () => {
      const uniq = new Map(real.exclusions.map((e) => [`${e.file}:${e.line}:${e.key}`, e]));
      // eslint-disable-next-line no-console
      console.log(
        '\n[s86-m03] rule-excluded keys (complete set — growth appears in a diff):\n' +
          [...uniq.values()]
            .map((e) => `  ${e.key} [${e.rule}] ${e.file}:${e.line}\n      ${e.reason}`)
            .join('\n')
      );

      // Every @internal tag must carry a stated reason. A bare tag is a claim with no grounds.
      // Every exclusion carries a stated reason, whichever rule made it. A bare `@internal` does
      // not even reach here — `internalTagReason` returns undefined for an empty tag, so the key
      // stays scored and A/B go red until someone writes down why.
      for (const e of uniq.values()) {
        expect(e.reason.trim().length).toBeGreaterThan(0);
      }

      // A key cannot be both internal and published. This is what stops `@internal` from becoming
      // a way to silence the gate on a key that is genuinely part of the wire surface.
      const publishedAnywhere = new Set(real.tools.flatMap((t) => t.inputSchemaKeys));
      const both = [...uniq.values()].filter((e) => publishedAnywhere.has(e.key));
      expect(both.map((e) => `${e.key} at ${e.file}:${e.line}`)).toEqual([]);

      // The measured exclusion set, pinned so a silent addition fails here rather than passing.
      expect([...new Set([...uniq.values()].map((e) => e.key))].sort()).toEqual([
        '_getNow',
        'advertisedRoots',
        'callerProvidedProjectRoot',
        // s94-m11: the CLI supplies resolution provenance for printed remedies, never a wire key.
        'cliSource',
        'client',
        // s93-m12: init's internal `hooks` (`reasonbook init --no-hooks` adds the hook-less block).
        'hooks',
        // s93-m01: onboard's @internal `offline` (the hook CLI's session start skips the dashboard).
        'offline',
        'overallTimeoutMs',
        'perRequestTimeoutMs',
        'preserveNextStepProse',
        // s93-m01: rbookSessionComplete's internal `registerProject` (an automatic close registers
        // nothing, so a second checkout closes without a registry collision).
        'registerProject',
        'registry',
      ]);
      // All FOUR rules are exercised. If any stops firing, the rule set is no longer what the
      // header says it is, and the "complete excluded set" claim silently narrows.
      expect([...new Set([...uniq.values()].map((e) => e.rule))].sort()).toEqual([
        'infrastructure-type',
        'internal-jsdoc',
        'outside-parameter-0',
        'underscore',
      ]);
    },
    TIMEOUT_MS
  );

  it(
    'prints every non-delegating in-src call, so a handler that falls out of scoring is visible',
    () => {
      // THE LARGEST SILENT CHANNEL IN THE WALK. A call lands here when it returns no
      // RbookToolResult, or is a higher-order combinator. A handler whose return type drifts (say,
      // to `RbookToolResult<T> | null`) silently stops being scored, and this is the only place that
      // shows it. PRINTED, NOT ASSERTED — pinning 50+ callee names would fail on unrelated edits —
      // so it is named as false-negative 12 rather than presented as enforcement.
      const byCallee = new Map<string, string[]>();
      for (const c of real.nonDelegatingCalls) {
        const at = `${c.file}:${c.line}`;
        byCallee.set(c.callee, [...(byCallee.get(c.callee) ?? []), at]);
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n[s86-m03] non-delegating in-src calls inside branches (${real.nonDelegatingCalls.length}), ` +
          `printed for review, not asserted:\n` +
          [...byCallee.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([callee, ats]) => `  ${callee} — ${ats.join(', ')}`)
            .join('\n')
      );
      expect(real.nonDelegatingCalls.every((c) => c.file.startsWith('src/'))).toBe(true);
    },
    TIMEOUT_MS
  );

  // ── Criterion 11 (first half): the six AST shapes are resolved on the REAL tree ──
  it(
    'resolves all six AST shapes against the real routers',
    () => {
      const byTool = new Map(real.tools.map((t) => [t.tool, t]));
      const find = (tool: string, action: string, callee: string) =>
        byTool
          .get(tool)!
          .branches.find((b) => b.action === action)!
          .calls.find((c) => c.callee === callee);

      // (1) z.infer<typeof schema> handler types — only the CHECKER can expand these; a bare
      // createSourceFile walk sees an opaque type reference and yields no keys at all.
      const learnings = byTool.get('rbook_learnings')!;
      expect(learnings.entryParamKeys).toEqual(expect.arrayContaining(['action', 'evergreen']));

      // (2) satisfies-wrapped literal (rbook-learnings). Without unwrap() this reads POSITIONAL.
      const reaffirm = find('rbook_learnings', 'reaffirm', 'rbookLearningsReaffirm');
      expect(reaffirm?.shape).toBe('OBJECT-LITERAL');
      expect(reaffirm?.forwarded).toEqual(expect.arrayContaining(['evergreen']));

      // (3) as-wrapped literal (rbook-session capture).
      const capture = find('rbook_session', 'capture', 'rbookSessionCapture');
      expect(capture?.shape).toBe('OBJECT-LITERAL');
      expect(capture?.forwarded).toEqual(expect.arrayContaining(['expiresAt']));

      // (4) a BLOCK-bodied case whose call is an awaited ASSIGNMENT, not a bare return.
      const complete = find('rbook_session', 'complete', 'rbookSessionComplete');
      expect(complete?.shape).toBe('OBJECT-LITERAL');
      expect(complete?.forwarded).toEqual(expect.arrayContaining(['agentFeedback']));

      // (5) whole-object PASS-THROUGH — structurally immune, satisfied by identity.
      const rotate = find('rbook_auth', 'rotate', 'handleRotate');
      expect(rotate?.shape).toBe('PASS-THROUGH');
      expect(rotate?.dropped).toEqual([]);

      // (6) POSITIONAL forwarding into a sub-router, reached one level down from rbook_context.
      const reaffirmConstraint = find('rbook_context', 'constraints', 'reaffirmConstraint');
      expect(reaffirmConstraint?.shape).toBe('POSITIONAL');
      expect(reaffirmConstraint?.depth).toBe(2);
      // `client` is a RbookDatabaseClient — infrastructure, so not a caller-supplied key.
      expect(reaffirmConstraint?.positionalAccepted).not.toContain('client');
    },
    TIMEOUT_MS
  );
});

describe('pre-dispatch published-string guard scope (s90-m04)', () => {
  it(
    'derives every raw pre-entry read and requires PREFLIGHT_PARAMS for exactly the unsafe strings',
    () => {
      const rows = real.tools.flatMap((tool) =>
        tool.preDispatchReads.map((read) => ({ tool: tool.tool, ...read }))
      );

      // Printed as the review artifact: raw reads, their rule classification, and the constant
      // checked against them. A safe discriminator remains visible instead of silently vanishing.
      // eslint-disable-next-line no-console
      console.log(
        '\n[s90-m04] PRE-DISPATCH READS (raw, before rule classification):\n' +
          rows
            .map(
              (read) =>
                `  ${read.tool}.${read.key} [${read.classification}] ${read.file}:${read.line} — ${read.reason}`
            )
            .join('\n') +
          `\n  PREFLIGHT_PARAMS = ${JSON.stringify(real.preflightParams)}`
      );

      // s97-m11: rbook_project's `via` joins them, read to take a join through the dashboard's folder
      // literally; a published enum under a strict comparison, so it needs no preflight.
      expect(preDispatchKeys(real)).toEqual(['acrossProjects', 'action', 'projectRoot', 'via']);
      expect(preDispatchKeys(real, 'safe-enum-discriminant')).toEqual(['action', 'via']);
      expect(preDispatchKeys(real, 'non-string-schema')).toEqual(['acrossProjects']);
      expect(preDispatchKeys(real, 'requires-preflight')).toEqual(['projectRoot']);
      expect(real.preflightParams).toEqual(['projectRoot']);
      expect(preDispatchKeys(real, 'requires-preflight')).toEqual([...real.preflightParams].sort());
      expect(real.unclassifiable.filter((item) => item.what.includes('pre-dispatch'))).toEqual([]);
    },
    TIMEOUT_MS
  );
});

// ─── Synthetic fixtures: assertion C must FAIL, not skip ──────────────────────

/**
 * Build a throwaway TypeScript project the walker can walk. Each fixture reproduces ONE shape the
 * walk cannot classify, so the no-silent-skip guarantee is DEMONSTRATED rather than asserted.
 */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's86m03-fixture-'));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        strict: true,
        skipLibCheck: true,
        moduleResolution: 'node',
      },
      include: ['src/**/*'],
    })
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const TYPES_TS = `
export interface RbookToolResult<T> { success: boolean; data?: T }
`;

/** A dispatch file whose switch binds \`result\` to \`entryFn(params)\` for one tool. */
function indexTs(
  body: string,
  preflightDeclaration = "export const PREFLIGHT_PARAMS = ['projectRoot'] as const;"
): string {
  return `
import { entry } from './router';
${preflightDeclaration}
export async function executeMissionProtocolTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
${body}
  }
  return null;
}
void entry;
`;
}

describe('pre-dispatch read arm fails in both directions (s90-m04)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  const defs: ToolDefs = [
    {
      name: 'rbook_fix',
      inputSchema: {
        properties: {
          action: { type: 'string', enum: ['go', 'stop'] },
          projectRoot: { type: 'string' },
          slug: { type: 'string' },
        },
      },
    },
  ];

  function walkIndex(
    beforeEntry: string,
    afterEntry = '',
    preflightDeclaration?: string,
    entryArgument = 'params'
  ): WalkResult {
    const root = fixture({
      'src/types.ts': TYPES_TS,
      'src/router.ts': `
import type { RbookToolResult } from './types';
export interface FixParams { action: 'go' | 'stop'; projectRoot?: string; slug?: string }
export async function entry(params: FixParams): Promise<RbookToolResult<string>> {
  return { success: !!params };
}
`,
      'src/index.ts': indexTs(
        `    case 'rbook_fix': {
      const params = args as import('./router').FixParams;
      ${beforeEntry}
      const result = await entry(${entryArgument});
      ${afterEntry}
      return result;
    }`,
        preflightDeclaration
      ),
    });
    roots.push(root);
    return walkRouterParams({ toolDefinitions: defs, projectRoot: root });
  }

  it(
    'an added published string read before entry becomes unsafe, while the same read after entry does not',
    () => {
      const before = walkIndex('const observed = params.slug; void observed;');
      expect(preDispatchKeys(before, 'requires-preflight')).toContain('slug');
      expect(preDispatchKeys(before, 'requires-preflight')).not.toEqual(before.preflightParams);

      const after = walkIndex('', 'const observed = params.slug; void observed;');
      expect(preDispatchKeys(after, 'requires-preflight')).not.toContain('slug');
      expect(preDispatchKeys(after, 'requires-preflight')).toEqual([]);
    },
    TIMEOUT_MS
  );

  it(
    'an enum action is safe under positive equality, switch cases, and typeof-string guards',
    () => {
      for (const body of [
        "if (params.action === 'go') { params.action.trim(); }",
        "switch (params.action) { case 'go': params.action.trim(); break; case 'stop': break; }",
        "if (typeof params.action === 'string') { params.action.trim(); }",
      ]) {
        const safe = walkIndex(body);
        expect(preDispatchKeys(safe, 'safe-enum-discriminant')).toEqual(['action']);
        expect(preDispatchKeys(safe, 'requires-preflight')).not.toContain('action');
      }
    },
    TIMEOUT_MS
  );

  it(
    'does not trust checker-only enum narrowing reached through a negative comparison',
    () => {
      const unsafe = walkIndex("if (params.action !== 'go') { params.action.trim(); }");
      expect(preDispatchKeys(unsafe, 'safe-enum-discriminant')).toContain('action');
      expect(preDispatchKeys(unsafe, 'requires-preflight')).toContain('action');
      expect(preDispatchKeys(unsafe, 'requires-preflight')).not.toEqual(unsafe.preflightParams);
    },
    TIMEOUT_MS
  );

  it(
    'still treats an unguarded enum string operation as requiring preflight',
    () => {
      const unsafe = walkIndex('params.action.trim();');

      expect(preDispatchKeys(unsafe, 'requires-preflight')).toContain('action');
      expect(preDispatchKeys(unsafe, 'requires-preflight')).not.toEqual(unsafe.preflightParams);
    },
    TIMEOUT_MS
  );

  it.each([
    ['missing', ''],
    ['not exported', "const PREFLIGHT_PARAMS = ['projectRoot'] as const;"],
    [
      'non-literal',
      "export const PREFLIGHT_PARAMS = makeParams(); function makeParams() { return ['projectRoot'] as const; }",
    ],
    ['empty', 'export const PREFLIGHT_PARAMS = [] as const;'],
  ])(
    'reports a %s PREFLIGHT_PARAMS declaration as unclassifiable',
    (_label, declaration) => {
      const result = walkIndex('', '', declaration);
      expect(
        result.unclassifiable.some((item) => item.what.includes('pre-dispatch PREFLIGHT_PARAMS'))
      ).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'reports a dynamic params element access before entry rather than silently omitting it',
    () => {
      const result = walkIndex(
        "const key: keyof import('./router').FixParams = 'slug'; void params[key];"
      );
      expect(
        result.unclassifiable.some((item) =>
          item.what.includes('dynamic pre-dispatch params access')
        )
      ).toBe(true);
    },
    TIMEOUT_MS
  );

  it.each([
    ['alias', 'const alias = params; void alias.slug;'],
    ['destructure', 'const { slug } = params; void slug;'],
    ['spread', 'const copy = { ...params }; void copy.slug;'],
  ])(
    'reports a pre-dispatch params %s escape instead of silently losing value flow',
    (_label, beforeEntry) => {
      const result = walkIndex(beforeEntry);
      expect(
        result.unclassifiable.some((item) =>
          item.what.includes('unsupported pre-dispatch params value flow')
        )
      ).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'permits only direct entry forwarding and reports a nested whole-params computation',
    () => {
      const direct = walkIndex('');
      const spread = walkIndex('', '', undefined, '{ ...params }');
      for (const result of [direct, spread]) {
        expect(
          result.unclassifiable.filter((item) =>
            item.what.includes('unsupported pre-dispatch params value flow')
          )
        ).toEqual([]);
      }

      const nested = walkIndex(
        "const normalize = (value: import('./router').FixParams) => value;",
        '',
        undefined,
        'normalize(params)'
      );
      expect(
        nested.unclassifiable.filter((item) =>
          item.what.includes('unsupported pre-dispatch params value flow')
        )
      ).toHaveLength(1);
    },
    TIMEOUT_MS
  );

  it.each([
    [
      'assignment',
      "if (params.action === 'go') { params.action = 42 as never; params.action.trim(); }",
    ],
    ['update', "if (params.action === 'go') { params.action++; params.action.trim(); }"],
    ['delete', "if (params.action === 'go') { delete params.action; params.action.trim(); }"],
  ])(
    'reports a guarded params field %s rather than trusting the stale proof',
    (_label, beforeEntry) => {
      const result = walkIndex(beforeEntry);
      expect(
        result.unclassifiable.some((item) =>
          item.what.includes('pre-dispatch params field mutation')
        )
      ).toBe(true);
    },
    TIMEOUT_MS
  );
});

describe('assertion C fails loudly rather than skipping (s86-m03)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function walkFixture(files: Record<string, string>, defs: ToolDefs): WalkResult {
    const root = fixture(files);
    roots.push(root);
    return walkRouterParams({ toolDefinitions: defs, projectRoot: root });
  }

  it(
    'C1 — a REGISTERED tool with no dispatch case is reported, not omitted',
    () => {
      const result = walkRouterParams({
        toolDefinitions: [...REAL_DEFS, { name: 'rbook_not_dispatched', inputSchema: {} }],
      });
      const hit = result.unclassifiable.find((u) => u.what.includes('rbook_not_dispatched'));
      expect(hit).toBeDefined();
      expect(hit!.what).toMatch(/no dispatch case for registered tool/);
      // …and the tool does NOT quietly appear in the model as if it had been checked.
      expect(result.tools.map((t) => t.tool)).not.toContain('rbook_not_dispatched');
      // The rest of the walk must be INTACT, or this fixture would also pass in a world where
      // every tool became unclassifiable — which is not what it claims to prove.
      expect(result.unclassifiable).toHaveLength(1);
      expect(result.tools).toHaveLength(15);
    },
    TIMEOUT_MS
  );

  it(
    'C2 — an AMBIGUOUS entry function (two candidate calls) is reported, not guessed at',
    () => {
      const result = walkFixture(
        {
          'src/types.ts': TYPES_TS,
          'src/router.ts': `
import type { RbookToolResult } from './types';
export interface FixParams { action?: string; a?: string }
export async function entry(p: FixParams): Promise<RbookToolResult<string>> { return { success: !!p }; }
export async function other(p: FixParams): Promise<RbookToolResult<string>> { return { success: !!p }; }
`,
          'src/index.ts': indexTs(`    case 'rbook_fix': {
      const params = args as import('./router').FixParams;
      if (params.a) {
        const result = await (await import('./router')).other(params);
        return result;
      }
      const result = await (await import('./router')).entry(params);
      return result;
    }`),
        },
        [{ name: 'rbook_fix', inputSchema: { properties: { action: {}, a: {} } } }]
      );
      const hit = result.unclassifiable.find((u) => u.what.includes('ambiguous entry function'));
      expect(hit).toBeDefined();
      expect(hit!.detail).toMatch(/cannot name the entry/);
      expect(result.tools).toHaveLength(0);
    },
    TIMEOUT_MS
  );

  it(
    'C3 — a BARE `...params` spread is reported; the fixture carries no other property, so only the spread can make it pass',
    () => {
      const result = walkFixture(
        {
          'src/types.ts': TYPES_TS,
          'src/handlers.ts': `
import type { RbookToolResult } from './types';
export interface DoParams { a?: string; b?: string }
export async function doIt(p: DoParams): Promise<RbookToolResult<string>> { return { success: !!p }; }
`,
          'src/router.ts': `
import type { RbookToolResult } from './types';
import { doIt } from './handlers';
export interface FixParams { action?: string; a?: string; b?: string }
export async function entry(params: FixParams): Promise<RbookToolResult<string>> {
  switch (params.action) {
    case 'go':
      return doIt({ ...params });
  }
  return { success: false };
}
`,
          'src/index.ts': indexTs(`    case 'rbook_fix': {
      const params = args as import('./router').FixParams;
      const result = await entry(params);
      return result;
    }`),
        },
        [{ name: 'rbook_fix', inputSchema: { properties: { action: {}, a: {}, b: {} } } }]
      );
      const hit = result.unclassifiable.find((u) => u.what.includes('unnameable forwarded key'));
      expect(hit).toBeDefined();
      expect(hit!.detail).toMatch(/spread or computed key/);
    },
    TIMEOUT_MS
  );

  it(
    'C4 — a THIRD-level sub-router is reported rather than silently truncated',
    () => {
      const result = walkFixture(
        {
          'src/types.ts': TYPES_TS,
          'src/router.ts': `
import type { RbookToolResult } from './types';
export interface L3Params { action?: string; a?: string }
export async function level3(p: L3Params): Promise<RbookToolResult<string>> {
  switch (p.action) {
    case 'deep':
      return { success: !!p.a };
  }
  return { success: false };
}
export async function level2(p: L3Params): Promise<RbookToolResult<string>> {
  switch (p.action) {
    case 'mid':
      return level3({ action: p.action, a: p.a });
  }
  return { success: false };
}
export interface FixParams { action?: string; a?: string }
export async function entry(params: FixParams): Promise<RbookToolResult<string>> {
  switch (params.action) {
    case 'top':
      return level2({ action: params.action, a: params.a });
  }
  return { success: false };
}
`,
          'src/index.ts': indexTs(`    case 'rbook_fix': {
      const params = args as import('./router').FixParams;
      const result = await entry(params);
      return result;
    }`),
        },
        [{ name: 'rbook_fix', inputSchema: { properties: { action: {}, a: {} } } }]
      );
      const hit = result.unclassifiable.find((u) => u.what.includes('third-level sub-router'));
      expect(hit).toBeDefined();
      expect(hit!.detail).toMatch(/recurses ONE level/);
    },
    TIMEOUT_MS
  );
});

// ─── Criterion 9: the rule is red in BOTH directions, demonstrated ───────────

/**
 * These prove the RULE, on a fixture, rather than asserting it about src/. Mutating a real handler
 * from inside a test is not available, and a rule demonstrated only in the direction that happens
 * to be green today is not evidence.
 */
describe('the exclusion rule is red in both directions (s86-m03)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  /** A router that accepts `knob` on its handler and never forwards it, under three tag states. */
  function tree(tag: 'none' | 'bare' | 'with-reason'): Record<string, string> {
    const knobDoc =
      tag === 'with-reason'
        ? `  /**\n   * @internal Process-lifetime tuning knob with no operator use case; deliberately unpublished.\n   */\n`
        : tag === 'bare'
          ? `  /**\n   * @internal\n   */\n`
          : '  /** A tuning knob. */\n';
    return {
      'src/types.ts': TYPES_TS,
      'src/handlers.ts': `
import type { RbookToolResult } from './types';
export interface DoParams {
  a?: string;
${knobDoc}  knob?: number;
}
export async function doIt(p: DoParams): Promise<RbookToolResult<string>> { return { success: !!p }; }
`,
      'src/router.ts': `
import type { RbookToolResult } from './types';
import { doIt } from './handlers';
export interface FixParams { action?: string; a?: string }
export async function entry(params: FixParams): Promise<RbookToolResult<string>> {
  switch (params.action) {
    case 'go':
      return doIt({ a: params.a });
  }
  return { success: false };
}
`,
      'src/index.ts': indexTs(`    case 'rbook_fix': {
      const params = args as import('./router').FixParams;
      const result = await entry(params);
      return result;
    }`),
    };
  }

  function walkTree(tag: 'none' | 'bare' | 'with-reason'): WalkResult {
    const root = fixture(tree(tag));
    roots.push(root);
    return walkRouterParams({
      toolDefinitions: [{ name: 'rbook_fix', inputSchema: { properties: { action: {}, a: {} } } }],
      projectRoot: root,
    });
  }

  it(
    'an UNTAGGED handler param that no router forwards turns A and B red',
    () => {
      const r = walkTree('none');
      const dropped = r.tools.flatMap((t) =>
        t.branches.flatMap((b) => b.calls.flatMap((c) => c.dropped))
      );
      expect(dropped).toContain('knob');
      expect(undeclaredSurfaceKeys(r.tools[0]).map((s) => s.key)).toContain('knob');
    },
    TIMEOUT_MS
  );

  it(
    'adding the @internal tag with a reason turns both green, and the exclusion is PRINTED',
    () => {
      const r = walkTree('with-reason');
      const dropped = r.tools.flatMap((t) =>
        t.branches.flatMap((b) => b.calls.flatMap((c) => c.dropped))
      );
      expect(dropped).not.toContain('knob');
      expect(undeclaredSurfaceKeys(r.tools[0])).toEqual([]);
      // The tag does not silence the key — it relocates it to a set that is printed on every run.
      const printed = r.exclusions.find((e) => e.key === 'knob');
      expect(printed).toBeDefined();
      expect(printed!.rule).toBe('internal-jsdoc');
      expect(printed!.reason).toMatch(/no operator use case/);
    },
    TIMEOUT_MS
  );

  it(
    'a BARE @internal tag with no reason excludes NOTHING — the key stays red',
    () => {
      // The tag is a CLAIM: "no caller has business setting this". A claim with no stated grounds
      // is what this sprint refuses to accept, so it must not be able to silence the gate. Without
      // this arm the both-directions block proves untagged -> red and tagged-with-reason -> green
      // while leaving the cheapest evasion undemonstrated.
      const r = walkTree('bare');
      const dropped = r.tools.flatMap((t) =>
        t.branches.flatMap((b) => b.calls.flatMap((c) => c.dropped))
      );
      expect(dropped).toContain('knob');
      expect(undeclaredSurfaceKeys(r.tools[0]).map((s) => s.key)).toContain('knob');
      expect(r.exclusions.find((e) => e.key === 'knob')).toBeUndefined();
    },
    TIMEOUT_MS
  );
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 ACTION_PARAMS gate — the per-action applicability contract must exist for
// ABOUTME: exactly the action-bearing tools, claim every published key, and claim nothing dead.

/**
 * Sprint 86 m04 — the gate that makes s86-m03's `evergreen` defect permanently detectable.
 *
 * ── WHAT IT CHECKS, IN BOTH DIRECTIONS ─────────────────────────────────────────────────────────
 *  1. PARTITION BY RULE — a tool has an ACTION_PARAMS map IFF its published inputSchema declares
 *     `properties.action.enum`. Not a list of twelve names: the biconditional is asserted, and the
 *     third case below proves it fails if an action-less tool ever gains an action.
 *  2. COVERAGE — every published key of an action-bearing tool is claimed by at least one action,
 *     and every action of the tool's enum has a list. A key no action claims is a dead declaration
 *     (the `arrayUpdates.decisions_made` shape, one layer up).
 *  3. APPLICABILITY — every entry is something the router demonstrably DOES with that key on that
 *     action, derived from the shared walk in scripts/lib/router-param-walker.
 *
 * ── THE THREE ARMS OF "APPLIES", AND WHY THREE ─────────────────────────────────────────────────
 * A key counts for an action when the branch FORWARDS it to a handler that declares the receiving
 * parameter (the strong arm); or READS it without forwarding it, as a routing predicate
 * (`rbook_learnings(list)` on `acrossProjects`, `rbook_project(list)` on `validate`); or is consumed
 * by the router OUTSIDE its switch, in which case it applies to every action (`action` itself in
 * all twelve; `projectRoot` in rbook_message, resolved once for all six delegated actions).
 * Forwarding alone would call live routing predicates dead; reads alone would accept a key merely
 * mentioned in a message string. Neither arm alone is the contract.
 *
 * ── WHY THE MAP IS AUTHORED AND NOT GENERATED ──────────────────────────────────────────────────
 * `npm run probe:action-params` generates a first cut from this same walk. If the shipped map were
 * only ever that cut, this gate could not be red about the cut — which is exactly how the
 * `evergreen` bug survived: `RbookLearningsReaffirmParams` under-declared the key in the same way
 * the router under-forwarded it, so the derived answer agreed with the defect. The map is allowed
 * — required — to be permitted as a SUPERSET of what generation alone produces, and the fifth case
 * below proves that superset is load-bearing by rerunning the applicability check against a
 * synthesised pre-s86-m03 walk.
 *
 * ── FALSE-NEGATIVE PROFILE (accepted and recorded, not fixed) ──────────────────────────────────
 *  a. MONOLITHIC action-bearing tools have no per-action branch to read evidence from. rbook_feedback
 *     is the only one (it dispatches on inline `if (action === '…')` blocks). Its entries are
 *     checked against the entry function's own parameter keys, so this gate cannot catch a
 *     rbook_feedback entry filed under the wrong ACTION — only one naming a key the tool does not
 *     accept. Its map is hand-audited against the handler body and cited there.
 *  b. PASS-THROUGH routers (rbook_auth, rbook_message) hand the whole params object over, so the
 *     evidence is the CALLEE's own reads. A handler that destructured its parameter
 *     (`const {keyId} = params`) instead of reading `params.keyId` would read as taking nothing;
 *     none does today, and such a handler would make this gate RED, never falsely green.
 *  c. The applicability arms answer "does the branch touch this key", not "does it honour it".
 *     A branch that reads a key and ignores the value satisfies arm two. That is the same limit
 *     s86-m03's guard has, and closing it is value-flow analysis, not name-flow.
 *  d. This gate cannot see a MISSING entry that no other check catches — a key genuinely
 *     applicable to two actions but claimed by one still satisfies coverage. Case 2 bounds that:
 *     an entry omitted from EVERY action is red.
 */

import { RBOOK_TOOL_DEFINITIONS, RBOOK_ACTION_PARAMS } from '../../../src/tools/rbook/index';
import {
  walkRouterParams,
  actionEvidence,
  type WalkResult,
  type ToolModel,
} from '../../../scripts/lib/router-param-walker';

/** Building a real ts.Program is ~2s; every case shares ONE walk of the real tree. */
const TIMEOUT_MS = 120_000;

type ToolDef = {
  name: string;
  inputSchema?: {
    properties?: Record<string, { enum?: readonly string[] } | undefined>;
    required?: readonly string[];
  };
};

const DEFS = RBOOK_TOOL_DEFINITIONS as unknown as readonly ToolDef[];
const MAPS = RBOOK_ACTION_PARAMS as Record<string, Record<string, readonly string[]>>;

/** THE PARTITION RULE, stated once and used by every case that needs it. */
function actionEnumOf(def: ToolDef): readonly string[] | undefined {
  const prop = def.inputSchema?.properties?.action;
  return prop && Array.isArray(prop.enum) ? prop.enum : undefined;
}

function schemaKeysOf(def: ToolDef): string[] {
  return Object.keys(def.inputSchema?.properties ?? {});
}

let real: WalkResult;

beforeAll(() => {
  real = walkRouterParams({
    toolDefinitions: DEFS as unknown as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>,
  });
}, TIMEOUT_MS);

/**
 * The applicability check, factored out so the counterfactual case can run the SAME rule against a
 * synthesised walk. Returns one string per violating entry.
 */
function applicabilityViolations(
  models: readonly ToolModel[],
  maps: Record<string, Record<string, readonly string[]>> = MAPS
): string[] {
  const violations: string[] = [];
  for (const def of DEFS) {
    const actions = actionEnumOf(def);
    if (!actions) continue;
    const model = models.find((t) => t.tool === def.name);
    if (!model) {
      violations.push(`${def.name}: the router walk produced no model — cannot verify any entry`);
      continue;
    }
    const evidence = actionEvidence(model);
    // ARM (a) of the false-negative profile: a MONOLITHIC action-bearing tool has no branches, so
    // the entry function's own parameter keys are the only oracle available.
    const monolithicOracle = new Set(model.entryParamKeys);
    for (const action of actions) {
      const claimed = maps[def.name]?.[action] ?? [];
      const ev = evidence.get(action) ?? {
        forwarded: [],
        read: [],
        routerScope: model.routerScopeReadKeys,
      };
      const supported =
        model.shape === 'MONOLITHIC'
          ? monolithicOracle
          : new Set([...ev.forwarded, ...ev.read, ...ev.routerScope]);
      for (const key of claimed) {
        if (!supported.has(key)) {
          violations.push(
            `${def.name}(${action}) publishes \`${key}\`, but the ${model.shape} router neither ` +
              `forwards it to a handler that accepts it nor reads it on that action`
          );
        }
      }
    }
  }
  return violations;
}

describe('ACTION_PARAMS partition is derived by rule (s86-m04)', () => {
  it('a tool has a map IFF its inputSchema declares properties.action.enum', () => {
    const withEnum = DEFS.filter((d) => actionEnumOf(d) !== undefined).map((d) => d.name);
    const withMap = Object.keys(MAPS);
    expect([...withMap].sort()).toEqual([...withEnum].sort());
    // The measured partition, recorded so a change is visible in a diff rather than absorbed.
    expect(withEnum).toHaveLength(12);
    expect(DEFS).toHaveLength(15);
  });

  it('rbook_agent_onboard, rbook_status and rbook_review have no map, because they have no action', () => {
    for (const name of ['rbook_agent_onboard', 'rbook_status', 'rbook_review']) {
      const def = DEFS.find((d) => d.name === name);
      expect(def).toBeDefined();
      expect(actionEnumOf(def as ToolDef)).toBeUndefined();
      expect(MAPS[name]).toBeUndefined();
    }
  });

  it('giving an action-less tool an action enum makes its missing map a violation', () => {
    // The biconditional is what is asserted, so it must fail from BOTH sides. Synthesise the
    // change rather than asserting the current three names: a rule that only ever sees today's
    // tree is a list wearing a rule's clothes.
    const mutated = DEFS.map((d) =>
      d.name === 'rbook_status'
        ? {
            ...d,
            inputSchema: {
              ...d.inputSchema,
              properties: {
                ...(d.inputSchema?.properties ?? {}),
                action: { enum: ['probe'] as const },
              },
            },
          }
        : d
    ) as readonly ToolDef[];
    const withEnum = mutated.filter((d) => actionEnumOf(d) !== undefined).map((d) => d.name);
    expect(withEnum).toContain('rbook_status');
    expect([...Object.keys(MAPS)].sort()).not.toEqual([...withEnum].sort());
  });
});

describe('ACTION_PARAMS claims every published key and no dead ones (s86-m04)', () => {
  it('every action of every action-bearing tool has a list, and no list names a phantom action', () => {
    const violations: string[] = [];
    for (const def of DEFS) {
      const actions = actionEnumOf(def);
      if (!actions) continue;
      const map = MAPS[def.name] ?? {};
      for (const action of actions) {
        if (!Array.isArray(map[action])) violations.push(`${def.name}: no list for "${action}"`);
      }
      for (const listed of Object.keys(map)) {
        if (!actions.includes(listed)) {
          violations.push(`${def.name}: list for "${listed}", which is not in its action enum`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every schema key of an action-bearing tool appears in at least one action list', () => {
    const violations: string[] = [];
    for (const def of DEFS) {
      const actions = actionEnumOf(def);
      if (!actions) continue;
      const claimed = new Set(actions.flatMap((a) => MAPS[def.name]?.[a] ?? []));
      for (const key of schemaKeysOf(def)) {
        if (!claimed.has(key)) {
          violations.push(`${def.name}.${key} is published but no action claims it`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no action list names a key the tool does not publish', () => {
    const violations: string[] = [];
    for (const def of DEFS) {
      const actions = actionEnumOf(def);
      if (!actions) continue;
      const published = new Set(schemaKeysOf(def));
      for (const action of actions) {
        for (const key of MAPS[def.name]?.[action] ?? []) {
          if (!published.has(key))
            violations.push(`${def.name}(${action}) names unpublished ${key}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('deleting a key from a list is caught — the coverage check is not vacuous', () => {
    // Assertion 2 above only bites if some key would otherwise be uncovered. Prove it does by
    // removing `evergreen` from BOTH lists that claim it on rbook_learnings.
    const mutated: Record<string, readonly string[]> = Object.fromEntries(
      Object.entries(MAPS.rbook_learnings).map(([action, keys]) => [
        action,
        keys.filter((k) => k !== 'evergreen'),
      ])
    );
    const def = DEFS.find((d) => d.name === 'rbook_learnings') as ToolDef;
    const claimed = new Set(Object.values(mutated).flat());
    const uncovered = schemaKeysOf(def).filter((k) => !claimed.has(k));
    expect(uncovered).toEqual(['evergreen']);
  });
});

describe('every ACTION_PARAMS entry is something the router actually does (s86-m04)', () => {
  it(
    'no entry is unforwarded, unread and out of router scope',
    () => {
      expect(applicabilityViolations(real.tools)).toEqual([]);
    },
    TIMEOUT_MS
  );

  it(
    'evergreen is claimed for reaffirm — and would be RED against the pre-s86-m03 router',
    () => {
      // THE SUPERSET, LOAD-BEARING. Until s86-m03, `rbook_learnings(action="reaffirm")` neither
      // forwarded `evergreen` nor declared it on RbookLearningsReaffirmParams, so a map generated
      // from the handler would not have claimed it and no gate could be red. The authored map
      // claims it. Synthesise that earlier tree — strip the key from the reaffirm branch's
      // evidence exactly as removing `evergreen: params.evergreen` from rbook-learnings.ts would —
      // and the SAME rule that is green above turns red on the real defect.
      expect(MAPS.rbook_learnings.reaffirm).toContain('evergreen');
      expect(MAPS.rbook_learnings.update).toContain('evergreen');

      const preM03 = real.tools.map((tool) =>
        tool.tool !== 'rbook_learnings'
          ? tool
          : {
              ...tool,
              branches: tool.branches.map((branch) =>
                branch.action !== 'reaffirm'
                  ? branch
                  : {
                      ...branch,
                      readKeys: branch.readKeys.filter((k) => k !== 'evergreen'),
                      calls: branch.calls.map((call) => ({
                        ...call,
                        accepted: call.accepted.filter((k) => k !== 'evergreen'),
                        forwarded: call.forwarded.filter((k) => k !== 'evergreen'),
                        forwardedFrom: Object.fromEntries(
                          Object.entries(call.forwardedFrom).filter(([k]) => k !== 'evergreen')
                        ),
                      })),
                    }
              ),
            }
      );

      expect(applicabilityViolations(preM03)).toEqual([
        'rbook_learnings(reaffirm) publishes `evergreen`, but the SWITCH-ROUTER router neither ' +
          'forwards it to a handler that accepts it nor reads it on that action',
      ]);
    },
    TIMEOUT_MS
  );

  it(
    'the check bites on an invented entry, not just on the one it was written for',
    () => {
      // A rule proven red on exactly one historical instance is a regression test. This drives the
      // SAME `applicabilityViolations` the green case calls — an inlined re-implementation would
      // prove the idea works and leave the function itself unexercised in the red direction.
      // rbook_auth(login) reads no request parameter at all (rbook-auth.ts passes only process
      // wiring), so claiming `graceSeconds` for it is a plain false claim.
      const bogus = {
        ...MAPS,
        rbook_auth: { ...MAPS.rbook_auth, login: ['action', 'graceSeconds'] },
      };
      expect(applicabilityViolations(real.tools, bogus)).toEqual([
        'rbook_auth(login) publishes `graceSeconds`, but the SWITCH-ROUTER router neither ' +
          'forwards it to a handler that accepts it nor reads it on that action',
      ]);
    },
    TIMEOUT_MS
  );

  it(
    'the check reaches EVERY action-bearing tool, not only the two it names',
    () => {
      // Both red proofs above target one tool each. A rule that silently skipped the other ten
      // would still pass them. Claim a parameter no tool applies to on EVERY action of EVERY
      // action-bearing tool, and require one violation per (tool, action) pair.
      const poisoned = Object.fromEntries(
        Object.entries(MAPS).map(([tool, byAction]) => [
          tool,
          Object.fromEntries(
            Object.entries(byAction).map(([action, keys]) => [
              action,
              [...keys, '__no_such_param__'],
            ])
          ),
        ])
      );
      const violations = applicabilityViolations(real.tools, poisoned);
      const pairs = new Set(violations.map((v) => v.slice(0, v.indexOf(')') + 1)));
      const expectedPairs = Object.entries(MAPS).reduce(
        (n, [, byAction]) => n + Object.keys(byAction).length,
        0
      );
      expect(violations).toHaveLength(expectedPairs);
      expect(pairs.size).toBe(expectedPairs);
      expect(new Set(violations.map((v) => v.slice(0, v.indexOf('(')))).size).toBe(12);
    },
    TIMEOUT_MS
  );
});

describe('ACTION_PARAMS vacuity floor (s86-m04)', () => {
  it(
    'the measured surface is large enough that an empty walk cannot pass green',
    () => {
      const actionBearing = DEFS.filter((d) => actionEnumOf(d) !== undefined);
      const actionCount = actionBearing.reduce((n, d) => n + (actionEnumOf(d)?.length ?? 0), 0);
      const entryCount = actionBearing.reduce(
        (n, d) => n + Object.values(MAPS[d.name] ?? {}).reduce((m, keys) => m + keys.length, 0),
        0
      );

      // MEASURED 2026-08-12, against the plan's UNVERIFIED-BASELINE of "~194 params". That figure
      // was the count of DECLARED KEYS (197 pre-s86-m03, 200 after), a different quantity: the
      // entry count is the sum over actions of applicable params. Generated cut 367; shipped 379.
      // The 12-entry gap is rbook_feedback's four hand-audited lists, the map's only superset over
      // what the walk alone can derive.
      expect(actionBearing).toHaveLength(12);
      // s86-m08: 79 -> 80 actions and 379 -> 384 entries. rbook_mission gains action `move`,
      // whose ACTION_PARAMS list is 5 keys (action, missionId, toSprintId, reason, projectRoot).
      // Both moves are the arithmetic of adding exactly one action with exactly five params.
      // s88-m04: 384 -> 385 entries when capture adds the learning-only `evergreen` parameter.
      // s91-m04: 80 -> 81 actions and 385 -> 394 entries when rbook_decisions adds `record` with
      // exactly nine applicable params.
      // s92-m05: 394 -> 395 entries when sprint `complete` adds the opt-in `archive` parameter.
      // s92-m03: 395 -> 396 entries when session `capture` accepts an explicit `sprintId`.
      // s92-m08: 81 -> 83 actions and 396 -> 402 entries when rbook_decisions and rbook_learnings
      // add `show`, each with exactly three params (action, the row id, projectRoot).
      // s92-m09: 83 -> 84 actions and 402 -> 409 entries for rbook_db prune_snapshots (action,
      // confirm, keepIds, keepSince, keepSources, keepLast, projectRoot).
      // Feedback list adds acrossProjects; triage now accepts resolutionNote: 409 -> 411.
      // s93-m06: decisions record accepts fromDraft: 411 -> 412.
      // s96-m12: 84 -> 86 actions and 417 -> 425 entries for rbook_db conflicts (action,
      // projectRoot) and settle (action, table, recordId, field, value, projectRoot).
      // s96-m13: 86 -> 92 actions and 425 -> 448 entries for rbook_project share (3), invite (4),
      // join (8), members (2), remove (3) and sync (3).
      // s97-m11: 92 -> 93 actions and 448 -> 455 entries: share gains via and confirm, join via and
      // project, and rbook_project adds move (action, projectRoot, to).
      // s102-m04: separately audited reopen adds one action and four parameter entries.
      expect(actionCount).toBe(94);
      // s94-m04: record adds context, alternatives, consequences, deciders and mode.
      // s97-m13: start adds targetStatus (Current promotes without starting).
      // s97-m07: rbook_feedback resolve adds feedbackIds (many rows in one call): 456 -> 457.
      expect(entryCount).toBe(461);

      // Floors, so a walker that silently stops producing branches fails here rather than passing
      // every applicability case with nothing to check.
      expect(real.tools.length).toBeGreaterThanOrEqual(15);
      const branchCount = real.tools
        .filter((t) => t.shape === 'SWITCH-ROUTER')
        .reduce((n, t) => n + t.branches.length, 0);
      expect(branchCount).toBeGreaterThanOrEqual(70);
      expect(entryCount).toBeGreaterThanOrEqual(370);
    },
    TIMEOUT_MS
  );
});

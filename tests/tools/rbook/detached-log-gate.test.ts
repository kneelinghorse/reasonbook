// ABOUTME: s86-m01 structural gate — the fire-and-forget checkpoint path must not write through
// ABOUTME: the global console object, and a new detached promise-returner must not appear unseen.

/**
 * Sprint 86 m01 — a detached async body must not log through `console`.
 *
 * `triggerCheckpointBackfill` deliberately does not block its caller: rbook_sprint(complete)
 * and rbook_session(complete) start it and drop the promise, so its body routinely outlives
 * the call that started it. Under Jest that means it can still be running after a suite has
 * finished, and Jest replaces the global console object at teardown — so a late write through
 * it throws "Cannot log after tests are done". That surfaces AFTER the run reports green, as a
 * nonzero exit with every test passing. It cost a full CI investigation (decision #970) and
 * re-diagnosis in s86-m01, where the arming file turned out to be a single describe whose
 * afterEach tore down dashboard credentials while a sync was mid-flight.
 *
 * The fix is that the three modules on that path write to `process.stderr` directly, which Jest
 * does not patch. This gate keeps the fix from silently eroding on a later commit.
 *
 * DISCRIMINATION IS BY RULE, NOT BY ALLOWLIST (Process Hardening #2). There is no allowlist file
 * and no skip list. Arm A names its three modules explicitly because "the detached path" is a
 * reachability property, not a syntactic one — that set is the mission's finding, stated in the
 * ARM A comment with the reason each module is on it. Arms B and C are pure AST rules over the
 * whole tree.
 *
 * ── FALSE-NEGATIVE PROFILE (what this gate does NOT catch) ────────────────────────────────────
 * Written out rather than implied, because a gate whose blind spots are undocumented reads as
 * stronger than it is — this sprint's own defect class.
 *
 *  1. INFERRED PROMISE RETURNS. Arm B matches an explicit `: Promise<…>` return annotation. A
 *     function whose promise return is inferred (`export function f() { return g(); }`) is
 *     invisible to it. Catching those needs a full ts.Program type-checker pass, which was
 *     rejected on cost — the precedent gate in this tree (agent-prompt-tool-names.test.ts) is
 *     likewise syntax-only, and the quality gate already runs lint + format:check + 180 suites.
 *  2. A PROMISE DETACHED INSIDE AN ASYNC FUNCTION. `void doThing()` or a bare `doThing();` inside
 *     an `async` function creates the same late-log hazard, and Arm B (which requires a
 *     NON-async declaration) will not see it.
 *  3. MODULES OUTSIDE src/tools/rbook. Arm B is scoped to that directory. The three known
 *     non-async promise returners elsewhere — decisionsAcrossProjects, activeMissionsAcrossProjects
 *     and learningsTaggedAcrossProjects in src/intelligence/cross-store-queries.ts — are always
 *     returned to their caller, never detached, so scoping there buys nothing today.
 *  4. WRONG-CHANNEL WRITES. A `process.stderr.write` of a line that should have been a thrown
 *     error, or a diagnostic that should never have been emitted at all, passes every arm. This
 *     gate is about the CHANNEL, not about whether the message deserved to exist.
 *  5. EXPORTED CONST ARROW / FUNCTION-EXPRESSION DECLARATIONS. Arm B walks function DECLARATIONS.
 *     `export const f = (): Promise<void> => …` would not be matched. Arm B asserts that shape's
 *     population is currently ZERO under src/tools/rbook, so the blindness is vacuous today —
 *     disclosed here rather than papered over, and that assertion fails loudly if it stops holding.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_ROOT = path.resolve(__dirname, '../../../src');
const RBOOK_TOOLS_ROOT = path.join(SRC_ROOT, 'tools', 'rbook');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

function hasExportModifier(node: ts.FunctionDeclaration): boolean {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasAsyncModifier(node: ts.FunctionDeclaration): boolean {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** True when the declaration carries an explicit `: Promise<…>` return annotation. */
function returnsAnnotatedPromise(node: ts.FunctionDeclaration): boolean {
  const t = node.type;
  if (!t || !ts.isTypeReferenceNode(t)) return false;
  return ts.isIdentifier(t.typeName) && t.typeName.text === 'Promise';
}

describe('s86-m01 detached-log gate', () => {
  // ── ARM A ────────────────────────────────────────────────────────────────────────────────────
  /**
   * The three modules reachable from the fire-and-forget checkpoint IIFE must not contain a
   * single `console.` occurrence — in code OR in prose, so that a comment cannot quietly
   * reintroduce the pattern it warns about.
   *
   * Why these three, and why the set is stated rather than derived: membership is REACHABILITY
   * from the detached body, which no syntactic rule over this tree computes.
   *   - checkpoint-backfill.ts        — declares the detached IIFE itself.  Baseline: 10 sites.
   *   - rbook-db-backfill.ts           — the event-replay fallback arm calls it. Baseline: 5 sites.
   *   - project-graph-registry.ts     — reached via `ProjectGraphRegistry.create()`, whose two
   *     marker-gated backfills both call `register()`, which holds the collision refusal.
   *     Baseline: 1 site. (A plan-time critic claimed this module is off the detached path; the
   *     chain above refutes that, and it is why the module is named here rather than dropped.)
   */
  const ARM_A_MODULES = [
    path.join(RBOOK_TOOLS_ROOT, 'checkpoint-backfill.ts'),
    path.join(RBOOK_TOOLS_ROOT, 'checkpoint-registration.ts'),
    path.join(RBOOK_TOOLS_ROOT, 'dashboard-upload.ts'),
    path.join(RBOOK_TOOLS_ROOT, 'dashboard-upload-scheduler.ts'),
    path.join(RBOOK_TOOLS_ROOT, 'rbook-db-backfill.ts'),
    path.join(SRC_ROOT, 'intelligence', 'project-graph-registry.ts'),
  ];

  it('ARM A: the named detached-path modules contain zero console usages', () => {
    const offenders: string[] = [];

    for (const file of ARM_A_MODULES) {
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('console.')) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1} — ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  // ── ARM B ────────────────────────────────────────────────────────────────────────────────────
  /**
   * Census of every exported, NON-async, explicitly-`Promise<…>`-annotated function declaration
   * under src/tools/rbook. That shape is the fingerprint of a function that hands back a promise
   * its caller is expected to ignore — precisely the hazard this mission cleaned up.
   *
   * Adding one is allowed; adding one SILENTLY is not. A new entry reds this test and the author
   * has to say, in this list, that the new function is safe to detach.
   *
   * MEASURED, not assumed:
   *   - trackDashboardUpload — reserves work synchronously before its first await and tracks both
   *     resolution paths for shutdown draining. Its module is covered by Arm A; the detached
   *     checkpoint caller catches failures, while the manual backfill caller awaits its result.
   *   - triggerCheckpointBackfill  — the detached checkpoint sync itself.
   *   - __drainCheckpointBackfill is now async: it drains all projects' pending attempts,
   *     including attempts started while the drain was awaiting an earlier one.
   */
  const ARM_B_EXPECTED = ['trackDashboardUpload', 'triggerCheckpointBackfill'];

  it('ARM B: the exported non-async Promise-returning declarations under src/tools/rbook are exactly the known set', () => {
    const found: string[] = [];

    for (const file of walkTsFiles(RBOOK_TOOLS_ROOT)) {
      const sf = parse(file);
      sf.forEachChild((node) => {
        if (!ts.isFunctionDeclaration(node) || !node.name) return;
        if (!hasExportModifier(node)) return;
        if (hasAsyncModifier(node)) return;
        if (!returnsAnnotatedPromise(node)) return;
        found.push(node.name.text);
      });
    }

    expect(found.sort()).toEqual(ARM_B_EXPECTED);
  });

  it('ARM B (disclosed blindness): exported const arrow/function-expression declarations under src/tools/rbook are still zero', () => {
    // This is the shape Arm B cannot see. Asserting the population is empty is what makes that
    // blindness vacuous rather than load-bearing — and reds loudly the day it stops being empty.
    const found: string[] = [];

    for (const file of walkTsFiles(RBOOK_TOOLS_ROOT)) {
      const sf = parse(file);
      sf.forEachChild((node) => {
        if (!ts.isVariableStatement(node)) return;
        const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) return;
        for (const decl of node.declarationList.declarations) {
          const init = decl.initializer;
          if (!init) continue;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            found.push(
              `${path.basename(file)}:${ts.isIdentifier(decl.name) ? decl.name.text : '?'}`
            );
          }
        }
      });
    }

    expect(found).toEqual([]);
  });

  // ── ARM C ────────────────────────────────────────────────────────────────────────────────────
  /**
   * Census of `triggerCheckpointBackfill` across src/. A THIRD detached call site cannot be added
   * without turning this red, which is the point: each new fire-and-forget site is a new place a
   * log can land after teardown, and the decision to add one belongs in review, not in a diff
   * nobody reads.
   *
   * MEASURED: 5 REFERENCES — the declaration name, two import specifiers, and two
   * statement-position calls (rbook-sprint.ts and rbook-session.ts), of which exactly 2 are calls
   * whose result is discarded.
   *
   * The reference census counts IDENTIFIER NODES, not matching text lines. That is deliberate
   * and follows the precedent gate's discipline: a mention inside a `//` comment or a JSDoc block
   * is excluded by construction, so it was never a candidate. A raw-text count would red this arm
   * every time someone documents the function by name — which is the shape of gate that gets
   * weakened rather than obeyed. (This is not hypothetical: s86-m01's own explanatory comments on
   * the detached path added two such prose mentions.)
   */
  it('ARM C: triggerCheckpointBackfill has exactly two statement-position call sites under src/', () => {
    const references: string[] = [];
    const statementCalls: string[] = [];

    for (const file of walkTsFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('triggerCheckpointBackfill')) continue;

      const sf = parse(file);

      const countRefs = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'triggerCheckpointBackfill') {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          references.push(`${path.relative(SRC_ROOT, file)}:${line + 1}`);
        }
        ts.forEachChild(node, countRefs);
      };
      countRefs(sf);
      const visit = (node: ts.Node): void => {
        // A call whose result is thrown away: the call IS the whole statement.
        if (ts.isExpressionStatement(node)) {
          const expr = node.expression;
          if (
            ts.isCallExpression(expr) &&
            ts.isIdentifier(expr.expression) &&
            expr.expression.text === 'triggerCheckpointBackfill'
          ) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            statementCalls.push(`${path.relative(SRC_ROOT, file)}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // The scheduler adds one import and one awaited call, tracked by its drainable job set.
    expect(references).toHaveLength(7);

    // ASSERTED BY FILE, NOT BY LINE (s86-m04). This assertion pinned `file:line` and false-fired
    // TWICE on edits that never touched a call site — s86-m03 declaring two params on
    // rbook_session's schemas pushed one down 33 lines, and a prettier pass moved the other by 3.
    // The invariant is "exactly TWO statement-position calls, and they are in THESE two files";
    // a line number is not part of it, and pinning one turns every unrelated reformat into a red
    // gate that the next agent is tempted to weaken rather than obey.
    expect(statementCalls).toHaveLength(2);
    expect(statementCalls.map((c) => c.split(':')[0]).sort()).toEqual([
      'tools/rbook/rbook-session.ts',
      'tools/rbook/rbook-sprint.ts',
    ]);
  });
});

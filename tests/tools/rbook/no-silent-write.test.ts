// SPDX-License-Identifier: Apache-2.0
// ABOUTME: No-silent-write gate — every client execute/raw/transaction result in src/ must be
// ABOUTME: inspected, so Reasonbook reports facts rather than intended writes.

/**
 * Sprint 86 m02b — "say only what you know", enforced on the write side.
 *
 * THE RULE. The client's `.execute(...)`, `.raw(...)`, and `.transaction(...)` return a `RbookToolResult`
 * envelope. Its `success` flag is the only evidence that the statement or atomic unit ran. Code
 * that discards it, or folds it into a counter/object list with no negative arm, produces an
 * ANSWER THAT ASSERTS SOMETHING NOT SO — before s90-m05 that included
 * `nextStepsReconciled: 4` when the UPDATE errored; current examples include
 * `alreadyCurrent: true` when a raw CREATE VIRTUAL TABLE failed, or “all writes landed” after a
 * transaction rolled back. This gate makes that shape unrepresentable.
 *
 * MEASURED PRE-FIX RED BASELINE: 99 violations = 44 discarded + 49 bound-with-no-negative-arm +
 * 6 console-only. Separately and NOT counted as violations: 3 SQL-verb exemptions and 2 delegated
 * sites whose obligation moves to their call sites.
 *
 * The plan pre-committed 98 (…+ 48 bound). Both numbers are right, for different rules, and the
 * measured one wins: the plan's rule attributed a discharge by IDENTIFIER NAME anywhere in the
 * enclosing function, which cannot see rbook-session-start.ts's `let insertResult =
 * client.execute('SELECT 1')` type-placeholder — its result is overwritten by the very next
 * statement, yet a negative arm forty lines later, on the SAME name after a REBINDING, appeared to
 * discharge it. This gate attributes discharge PER BINDING (see DischargeWindow), which sees it.
 * 99 - 98 = that one site.
 *
 * s88-m09 RAW BASELINE, RE-DERIVED BEFORE THE FIX: 18 production code calls = 9 discarded +
 * 5 bound-with-no-negative-arm + 4 inspected. All 18 were in schema-migrations.ts. The exact
 * publishable command excludes the doc-comment occurrence of `client.raw()`:
 *
 *   rg -n --glob '*.ts' --pcre2 '^(?!\s*(?://|/\*|\*)).*\.raw\s*\(' src \
 *     | tee /dev/stderr | wc -l
 *
 * CURRENT POST-FIX SHAPE: 5 production calls, still all in schema-migrations.ts. Two are the
 * centralized `ensureVirtualTableObject` / `ensureSchemaTrigger` calls nested directly in
 * `checkWrite`; three have explicit negative arms. The 14 baseline violations therefore no
 * longer exist as individual raw sites. The fourth formerly inspected site — the decisions_fts
 * virtual-table CREATE — also moved into the guarded helper so its failure is diagnostic rather
 * than merely returning `alreadyCurrent: false`.
 *
 * DISCRIMINATION IS BY RULE, NOT BY ALLOWLIST (Process Hardening #2, agents.md). There is no
 * allowlist file and no per-site exemption list anywhere in this suite. The ONE exemption —
 * transaction verbs on already-failing paths — is DERIVED from the SQL string argument
 * (`/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i`), so a bare non-transaction `execute` added inside a
 * `catch` clause is still caught. Patching a bare ROLLBACK would mask the original failure,
 * which is why the exemption exists at all; deriving it from the SQL is why it cannot grow.
 *
 * WHY A JEST AST TEST AND NOT A CUSTOM ESLINT RULE — recorded so a later sprint does not
 * re-litigate it. The precedent is in-tree (tests/tools/rbook/agent-prompt-tool-names.test.ts and
 * tests/tools/rbook/event-type-coverage.test.ts both walk source from jest), `typescript` is
 * already a devDependency, and bucket (b) needs CALL-SITE resolution across files — a delegated
 * `return client.execute(...)` moves the obligation to the callers of the enclosing function.
 * ESLint's per-file model makes that cross-file step awkward; a jest test just reads the tree.
 *
 * ── FALSE-NEGATIVE PROFILE ─────────────────────────────────────────────────────────────────
 * This gate proves a result is INSPECTED. It does not, and cannot, prove the inspection is
 * CORRECT. Every limit below is a KNOWN hole, named here rather than discovered later:
 *
 *  1. SHAPE, NOT SEMANTICS. `if (!r.success) { /* best effort *\/ }` passes the gate and tells
 *     the operator nothing. So does an arm that pushes a warning into a sink no formatter
 *     renders. The gate is a floor, not a proof of disclosure.
 *     Inline local helpers count only when their first argument's `!success` arm unconditionally
 *     throws and their second statement returns that argument's data. Direct parameter/block
 *     shadows are rejected; computed reassignment and dynamic rebinding are not resolved. A direct
 *     relative named import may resolve to the same proven exported body in the scanned source
 *     map; package imports, re-export barrels and namespace imports fail closed. This is structural
 *     module resolution, not a whole-program type or runtime-binding proof.
 *  2. RAW better-sqlite3 IS INVISIBLE. `db.prepare(...).run()` — used at rbook-project-init.ts
 *     (the fresh-store bootstrap, ~:479-508) and throughout tests/ — is not a client envelope
 *     call and is never walked. That is OUT OF SCOPE BY CONSTRUCTION, not by oversight: `.run()`
 *     THROWS on failure rather than returning a result envelope, so it is a different failure
 *     mode with a different remedy (try/catch). `RbookDatabaseClient.raw(...)` DOES return an
 *     envelope and is covered by the same rule as `.execute(...)`. Similarly, an immediately
 *     invoked `db.transaction(callback)()` is a throwing SQLite transaction factory, not an
 *     envelope; the census names it separately and still walks writes inside its callback.
 *     This is a syntax distinction, not type resolution: an incorrectly invoked client envelope
 *     would throw a TypeError rather than silently discard failure (and fail typed compilation).
 *     Stored or indirectly invoked SQLite factories remain conservative candidates; this gate
 *     cannot prove that a returned factory is eventually run or its exceptions are reported.
 *  3. THE CONSOLE-ONLY TIGHTENING IS A HEURISTIC OVER ARM CONTENT. An arm whose entire body is a
 *     `console.*` call does not count as inspection — that rule is what catches the six
 *     session_events sites, and without it this gate is green while durable provenance is lost.
 *     But it reads the arm's SHAPE, and there are at least three ways past it:
 *       (a) an arm that reaches a logger through an indirection (`log.warn(...)`, a helper, a
 *           bound method) is not recognised as console-only;
 *       (b) HOISTING THE NEGATION out of the `if` defeats it entirely —
 *           `const failed = !r.success; if (failed) { console.warn(...); }` has no arm this gate
 *           can attribute, so it takes the `inspectionOutsideAnIf` path below and reads as
 *           `inspected`. Same for a ternary (`const label = !r.success ? 'no' : 'yes'`).
 *       (c) `inspectionOutsideAnIf` is a deliberate escape hatch for `return !r.success ? … : …`
 *           and `if (!a.success || !b.success)` shapes we cannot attribute an arm to. It grants
 *           `inspected` WITHOUT the console-only check ever running. Zero sites in the current
 *           tree reach it, so it costs nothing today — but it is the widest hole here.
 *  8. THE NEGATIVE TEST MAY LIVE IN A NESTED FUNCTION. `findNegativeTests` walks into nested
 *     function bodies, so an inner closure that happens to use the same parameter name can
 *     discharge an outer site. Scoping is by enclosing function and binding position, not by
 *     true lexical resolution.
 *  9. `client['execute'](…)` / `client['raw'](…)` / `client['transaction'](…)` (element access)
 *     is not a candidate — `isWriteEnvelopeCall` requires a PropertyAccessExpression. Plain,
 *     non-dynamic, invisible.
 * 10. THE SWEEP COVERS `src/` ONLY. `scripts/` is not walked, and it contains bare discarded
 *     writes today. That is why this mission's `scripts/measure-cross-store-baseline.ts` fix had
 *     to be made and tested BY HAND — no gate protects it.
 * 11. `pragma()` RETURNS NO ENVELOPE. `RbookDatabaseClient.pragma()` returns `unknown` (and bare
 *     `undefined` when its connection fails), so this result-envelope classifier cannot cover
 *     it. Its 5 src/ consumers are schema-migrations.ts:1854-1856 and :1907-1908; only the
 *     `foreign_keys` read verifies a value. That complement needs a different rule if it grows.
 *  4. THE READ SIDE IS NOT WALKED AT ALL. `getOne` / `getMany` have the identical defect —
 *     a failed SELECT that reads as "no rows" — and this gate says nothing about them (fork f10).
 *     Two read-side sites were fixed by hand in this mission (scripts/measure-cross-store-
 *     baseline.ts `safeCount`, rbook-session-complete.ts persistContext's existence SELECT)
 *     precisely BECAUSE no gate will catch a regression there.
 *  5. DYNAMIC DISPATCH IS INVISIBLE. A write reached through a callback, a method looked up on a
 *     record, or any indirection that does not spell `.execute(` / `.raw(` / `.transaction(` in
 *     the source is not a candidate.
 *  6. IT SAYS NOTHING ABOUT A WRITE THAT SUCCEEDS WITH THE WRONG VALUE. `success: true` on an
 *     UPDATE that matched the wrong rows is, to this gate, a clean write.
 *  7. IT CANNOT JUDGE WHETHER `changes === 0` IS MEANINGFUL. A zero from a WHERE that matched
 *     nothing is legitimate; a zero from a statement that errored is not. `countWrite` moves that
 *     judgement to the call site, where the caller knows whether it first selected an expected id
 *     set or received ids from the caller (as rbook-next-steps.ts does).
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_ROOT = path.resolve(__dirname, '../../../src');
const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * The client wrapper itself is where `.execute` / `.raw` / `.transaction` are DEFINED — its own
 * internal calls are the implementation of the envelope, not consumers of it.
 */
const WRAPPER_RELATIVE = path.join('tools', 'rbook', 'client.ts');
/**
 * s96-m03: the change helper wraps the client's writes for a shared record, as the client wraps
 * better-sqlite3's, so it is a wrapper too; its own writes throw on failure.
 */
const RECORD_HELPER_RELATIVE = path.join('tools', 'rbook', 'record-changes.ts');
/**
 * s96-m03: the change helper's calls that replaced `client.execute`, `client.writeTransaction`
 * and, as `recordedChange`, a write that ran with no transaction at the converted sites return
 * the same envelope, so their results are held to the same rule.
 * `recordedWrite` replaced s96-m01's `sharedStoreWrite`, which the gate never tracked: the writes
 * inside its callbacks are tracked where they run.
 */
const RECORD_HELPER_CALLS = new Set(['recordedExecute', 'recordedTransaction', 'recordedChange']);

/**
 * ROLLBACK on an already-failing path. Derived from the SQL, never from a file list.
 *
 * NARROWED TO ROLLBACK ALONE, deliberately. The exemption's whole justification is that patching
 * a bare ROLLBACK would MASK THE ORIGINAL FAILURE it is unwinding. That argument does not extend
 * to BEGIN or COMMIT: a discarded COMMIT loses the entire transaction, which is the worst possible
 * instance of this mission's class. Verified this still selects exactly the same 3 sites — every
 * BEGIN/COMMIT in the tree is already bound and inspected.
 */
const TRANSACTION_VERB_RE = /^\s*ROLLBACK\b/i;

/** The two helpers from src/tools/rbook/write-guard.ts that discharge the obligation. */
const GUARD_HELPERS = new Set(['checkWrite', 'countWrite']);

/** A local wrapper is trusted by its body, never merely by a familiar function name. */
function checkedLocalThrowingGuard(
  source: ts.SourceFile,
  call: ts.CallExpression,
  sources: ReadonlyMap<string, string>
): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  const name = call.expression.text;
  let guard = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!guard) {
    // One direct relative named import only: no package lookup, barrels, namespace aliases,
    // runtime rebinding or name-based exemptions. The resolved exported body must prove itself.
    const matches = source.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith('.') ||
        statement.importClause?.isTypeOnly
      )
        return [];
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return [];
      return bindings.elements
        .filter((binding) => !binding.isTypeOnly && binding.name.text === name)
        .map((binding) => ({
          module,
          name: (binding.propertyName ?? binding.name).text,
        }));
    });
    if (matches.length !== 1) return false;
    const imported = matches[0];
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(source.fileName), `${imported.module}.ts`)
    );
    const text = sources.get(resolved);
    if (text === undefined) return false;
    const target = parse(resolved, text);
    const declarations = target.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === imported.name &&
        !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
    if (declarations.length !== 1) return false;
    guard = declarations[0];
  }
  const parameter = guard?.parameters[0]?.name;
  const statements = guard?.body?.statements;
  if (!parameter || !ts.isIdentifier(parameter) || statements?.length !== 2) return false;
  // A same-named parameter or local declaration would call a different function.
  for (
    let ancestor: ts.Node | undefined = call.parent;
    ancestor && ancestor !== source;
    ancestor = ancestor.parent
  ) {
    if (
      ts.isFunctionLike(ancestor) &&
      ancestor.parameters.some((p) => p.name.getText(source) === name)
    )
      return false;
    if (
      ts.isBlock(ancestor) &&
      ancestor.statements.some(
        (statement) =>
          (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((d) => d.name.getText(source) === name))
      )
    )
      return false;
  }
  const [check, returned] = statements;
  if (
    !ts.isIfStatement(check) ||
    check.elseStatement ||
    !ts.isPrefixUnaryExpression(check.expression) ||
    check.expression.operator !== ts.SyntaxKind.ExclamationToken
  )
    return false;
  const condition = check.expression.operand;
  const throwing =
    ts.isBlock(check.thenStatement) && check.thenStatement.statements.length === 1
      ? check.thenStatement.statements[0]
      : check.thenStatement;
  const propertyOfParameter = (value: ts.Node | undefined, property: string): boolean => {
    // Type-only assertions and parentheses do not change which envelope was inspected.
    while (
      value &&
      (ts.isAsExpression(value) ||
        ts.isTypeAssertionExpression(value) ||
        ts.isParenthesizedExpression(value))
    )
      value = value.expression;
    return (
      !!value &&
      ts.isPropertyAccessExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === parameter.text &&
      value.name.text === property
    );
  };
  return (
    propertyOfParameter(condition, 'success') &&
    ts.isThrowStatement(throwing) &&
    ts.isReturnStatement(returned) &&
    propertyOfParameter(returned.expression, 'data')
  );
}

type Bucket =
  | 'exempt-transaction-verb'
  | 'invoked-transaction-factory'
  | 'inspected'
  | 'discarded'
  | 'delegated'
  | 'no-negative-arm'
  | 'console-only-arm'
  | 'unclassified';

interface WriteSite {
  readonly file: string;
  readonly line: number;
  readonly bucket: Bucket;
  /** For `delegated`: the enclosing function whose callers inherit the obligation. */
  readonly enclosingFunction?: string;
  readonly detail: string;
}

const VIOLATION_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>([
  'discarded',
  'no-negative-arm',
  'console-only-arm',
  'unclassified',
]);

// ── AST helpers ────────────────────────────────────────────────────────────────────────────

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Any receiver whose property name is an envelope-returning write method. */
function isWriteEnvelopeCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  // s96-m03: a converted site writes through the change helper, and its result is held to the
  // same rule as the `client.execute` it replaced.
  if (ts.isIdentifier(node.expression)) return RECORD_HELPER_CALLS.has(node.expression.text);
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'execute' ||
      node.expression.name.text === 'raw' ||
      node.expression.name.text === 'transaction' ||
      // s96-m11: the record writers' transactions, which take the write lock at BEGIN.
      node.expression.name.text === 'writeTransaction')
  );
}

/** The SQL text we can see statically: a string literal, or a template's head. */
function staticSqlPrefix(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text;
  return null;
}

/** Skip the wrappers that do not change what the value IS. */
function effectiveParent(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  let parent = current.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    current = parent;
    parent = current.parent;
  }
  return parent;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function enclosingFunction(node: ts.Node): FunctionLike | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function functionName(fn: FunctionLike): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  // `const activateParentSprint = (…) => {}` / `function foo() {}` assigned to a variable.
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return '<anonymous>';
}

/** `name.success` */
function isSuccessAccessOf(node: ts.Node, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'success' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

/**
 * A NEGATIVE test of `name.success` — the two forms the mission's rule names:
 * `!name.success` and `name.success === false` (`== false` included).
 * Returns the negating node so the caller can locate its guarded arm.
 */
function findNegativeTests(root: ts.Node, name: string): ts.Node[] {
  const hits: ts.Node[] = [];
  walk(root, (node) => {
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      if (isSuccessAccessOf(node.operand, name)) hits.push(node);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const eq =
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
      if (
        eq &&
        isSuccessAccessOf(node.left, name) &&
        node.right.kind === ts.SyntaxKind.FalseKeyword
      ) {
        hits.push(node);
      }
    }
  });
  return hits;
}

/** Any read of `name.success` that is not itself the operand of a `!`. */
function findPositiveTests(root: ts.Node, name: string): ts.Node[] {
  const hits: ts.Node[] = [];
  walk(root, (node) => {
    if (!isSuccessAccessOf(node, name)) return;
    const parent = node.parent;
    const negated =
      parent &&
      ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken;
    if (!negated) hits.push(node);
  });
  return hits;
}

/**
 * The span of source in which a discharge may be attributed to ONE binding.
 *
 * WHY A WINDOW AND NOT THE WHOLE FUNCTION. Keying discharge on the identifier NAME alone lets one
 * `checkWrite(insertResult, …)` satisfy every OTHER `insertResult` in the same function — and
 * `insertResult` / `result` / `res` are reused in 12 real scopes here, concentrated in exactly the
 * Tier-1 sites. Under a name-keyed rule, reverting one of the four extraction folds in
 * rbook-session-complete.ts back to `if (insertResult.success) count++` left the gate GREEN. The
 * gate would then be unable to catch the regression it exists to catch.
 */
interface DischargeWindow {
  readonly from: number;
  readonly to: number;
}

function inWindow(node: ts.Node, sf: ts.SourceFile, window: DischargeWindow): boolean {
  const pos = node.getStart(sf);
  return pos >= window.from && pos < window.to;
}

/** Every position in `root` at which `name` is (re)bound — a declaration or an assignment. */
function bindingPositions(root: ts.Node, sf: ts.SourceFile, name: string): number[] {
  const positions: number[] = [];
  walk(root, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      positions.push(node.getStart(sf));
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      positions.push(node.getStart(sf));
    }
  });
  return positions.sort((a, b) => a - b);
}

/** `name` passed as argument 0 to `checkWrite` / `countWrite`, within this binding's window. */
function hasGuardHelperCall(
  root: ts.Node,
  sf: ts.SourceFile,
  name: string,
  window: DischargeWindow
): boolean {
  let found = false;
  walk(root, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : null;
    if (!callee || !GUARD_HELPERS.has(callee)) return;
    const first = node.arguments[0];
    if (first && ts.isIdentifier(first) && first.text === name && inWindow(node, sf, window)) {
      found = true;
    }
  });
  return found;
}

/** The nearest `if` whose CONDITION contains `node`. */
function guardingIf(node: ts.Node, stopAt: ts.Node): ts.IfStatement | null {
  let child: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (current && current !== stopAt.parent) {
    if (ts.isIfStatement(current) && current.expression === child) return current;
    child = current;
    current = current.parent;
  }
  return null;
}

function statementsOf(arm: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(arm) ? arm.statements : [arm];
}

/** True when EVERY statement in the arm is a `console.*(…)` call, and there is at least one. */
function isConsoleOnlyArm(arm: ts.Statement): boolean {
  const statements = statementsOf(arm);
  if (statements.length === 0) return false;
  return statements.every((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const expression = statement.expression;
    if (!ts.isCallExpression(expression)) return false;
    const callee = expression.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console'
    );
  });
}

/**
 * Does the enclosing function body inspect `name`'s failure, and is that inspection more than a
 * `console.*` call?
 *
 * THE RULE IS DELIBERATELY ONE-SIDED — a NEGATIVE test (`!name.success`, `name.success === false`)
 * or `name` as argument 0 of checkWrite/countWrite. `if (name.success) { … } else { … }` does NOT
 * satisfy it, even though the else IS technically a negative arm, and that asymmetry is the whole
 * point rather than an oversight:
 *
 *   The mission's flagship defect HAS such an else. rbook-session-capture.ts's decision INSERT has
 *   carried `} else { resultData.decisionExtractionCount = 0; decisionAlreadyExtracted = false; }`
 *   since Sprint 20 — an else arm that inspects the failure and then renders it as
 *   "Decision Extraction: Extraction skipped". Nothing was skipped; an INSERT errored. A rule that
 *   accepted a positive-test-with-else would call that site compliant and let a future author
 *   regress it to the same lie with the gate still green.
 *
 * The cost is named rather than hidden: three sites that were already CORRECT (they return the DB
 * error verbatim from an else arm) were inverted to `if (!x.success) { return … }` early-return
 * form to satisfy this. That inversion is behaviour-preserving De Morgan, and the stricter gate is
 * worth it. Accepting positive-with-else would ALSO reproduce a lower baseline than the one this
 * mission pre-committed (43 instead of the measured 48) — see the mission notes.
 */
function classifyBoundSite(
  body: ts.Node,
  sf: ts.SourceFile,
  name: string,
  window: DischargeWindow
): 'inspected' | 'no-negative-arm' | 'console-only-arm' {
  if (hasGuardHelperCall(body, sf, name, window)) return 'inspected';

  const arms: ts.Statement[] = [];
  let inspectionOutsideAnIf = false;

  for (const negative of findNegativeTests(body, name)) {
    if (!inWindow(negative, sf, window)) continue;
    const owner = guardingIf(negative, body);
    if (owner) {
      arms.push(owner.thenStatement);
    } else {
      // `return !r.success ? … : …`, `!a.success || !b.success` folded into a wider expression, a
      // throw guard — the failure is read somewhere other than an `if` condition we can attribute
      // an arm to. Treat as inspected; the console-only tightening cannot apply.
      inspectionOutsideAnIf = true;
    }
  }

  if (inspectionOutsideAnIf) return 'inspected';
  if (arms.length === 0) return 'no-negative-arm';
  return arms.some((arm) => !isConsoleOnlyArm(arm)) ? 'inspected' : 'console-only-arm';
}

// ── the sweep ──────────────────────────────────────────────────────────────────────────────

/** Classify every `.execute(...)` / `.raw(...)` / `.transaction(...)` in one source text. */
function collectWriteSites(
  relPath: string,
  text: string,
  sources: ReadonlyMap<string, string> = new Map()
): WriteSite[] {
  const sf = parse(relPath, text);
  const sites: WriteSite[] = [];

  /**
   * The exemption REMOVES AN OBLIGATION, so it is applied to the classification, not before it.
   * Applying it first would also swallow the `BEGIN IMMEDIATE` / `COMMIT` sites that are already
   * bound and inspected, inflating the exempt count and hiding a future regression there.
   */
  const push = (site: WriteSite, sql: string | null): void => {
    if (VIOLATION_BUCKETS.has(site.bucket) && sql !== null && TRANSACTION_VERB_RE.test(sql)) {
      sites.push({
        ...site,
        bucket: 'exempt-transaction-verb',
        detail: `transaction verb: ${sql.trim().split(/\s+/)[0].toUpperCase()} on an already-failing path`,
      });
      return;
    }
    sites.push(site);
  };

  walk(sf, (node) => {
    if (!isWriteEnvelopeCall(node)) return;

    const sql = staticSqlPrefix(node.arguments[0]);
    const parent = effectiveParent(node);
    const line = lineOf(node, sf);

    // SQLite returns a transaction FUNCTION: its immediate invocation throws on failure.
    // A client transaction instead returns the result envelope this gate protects. Restrict the
    // distinction to callee position, so `ignore(client.transaction(...))` stays a violation.
    // s96-m11: `.immediate()`, `.deferred()` and `.exclusive()` invoke the same factory.
    const invokedMode =
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      ['immediate', 'deferred', 'exclusive'].includes(node.parent.name.text) &&
      ts.isCallExpression(node.parent.parent) &&
      node.parent.parent.expression === node.parent;
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction' &&
      ((ts.isCallExpression(node.parent) && node.parent.expression === node) || invokedMode)
    ) {
      sites.push({
        file: relPath,
        line,
        bucket: 'invoked-transaction-factory',
        detail: 'transaction factory invoked immediately; errors throw, no result envelope',
      });
      return;
    }

    if (parent && ts.isExpressionStatement(parent)) {
      push({ file: relPath, line, bucket: 'discarded', detail: 'result discarded outright' }, sql);
      return;
    }

    // `checkWrite(client.execute(...), sink, what)` — the obligation is discharged INLINE, with
    // no identifier to bind. This is the tersest compliant shape and the classifier must know it,
    // otherwise the cleanest fix in the codebase reads as an unrecognised one.
    if (
      parent &&
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      ts.isIdentifier(parent.expression) &&
      (GUARD_HELPERS.has(parent.expression.text) || checkedLocalThrowingGuard(sf, parent, sources))
    ) {
      push(
        {
          file: relPath,
          line,
          bucket: 'inspected',
          detail: `passed inline to ${parent.expression.text}()`,
        },
        sql
      );
      return;
    }

    if (parent && ts.isReturnStatement(parent)) {
      const fn = enclosingFunction(node);
      sites.push({
        file: relPath,
        line,
        bucket: 'delegated',
        enclosingFunction: fn ? functionName(fn) : '<anonymous>',
        detail: 'returned to the caller; the obligation moves to its call sites',
      });
      return;
    }

    // Bound to an identifier — directly, through a conditional initializer, or by assignment.
    let boundName: string | null = null;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      boundName = parent.name.text;
    } else if (parent && ts.isConditionalExpression(parent)) {
      const grand = effectiveParent(parent);
      if (grand && ts.isVariableDeclaration(grand) && ts.isIdentifier(grand.name)) {
        boundName = grand.name.text;
      } else if (
        grand &&
        ts.isBinaryExpression(grand) &&
        grand.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(grand.left)
      ) {
        boundName = grand.left.text;
      }
    } else if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(parent.left)
    ) {
      boundName = parent.left.text;
    }

    if (boundName === null) {
      push(
        {
          file: relPath,
          line,
          bucket: 'unclassified',
          detail: `write-envelope result in an unrecognised position (parent: ${
            parent ? ts.SyntaxKind[parent.kind] : 'none'
          }) — extend the classifier rather than ignoring it`,
        },
        sql
      );
      return;
    }

    const fn = enclosingFunction(node);
    const scope: ts.Node = fn?.body ?? sf;
    // The discharge must land between THIS binding and the next rebinding of the same name.
    const bindAt = node.getStart(sf);
    const nextBind = bindingPositions(scope, sf, boundName).find((pos) => pos > bindAt);
    push(
      {
        file: relPath,
        line,
        bucket: classifyBoundSite(scope, sf, boundName, {
          from: bindAt,
          to: nextBind ?? Number.MAX_SAFE_INTEGER,
        }),
        detail: `bound to \`${boundName}\``,
      },
      sql
    );
  });

  return sites;
}

/**
 * Bucket (b): a `return client.execute(...)` moves the obligation to the CALLERS of the
 * enclosing function. Classify every call to those functions by the same parent-kind rules.
 */
function collectDelegatedCallSites(
  files: readonly { rel: string; text: string }[],
  delegated: readonly WriteSite[]
): WriteSite[] {
  const names = new Set(
    delegated
      .map((site) => site.enclosingFunction)
      .filter((n): n is string => !!n && n !== '<anonymous>')
  );
  if (names.size === 0) return [];

  const sites: WriteSite[] = [];
  for (const { rel, text } of files) {
    const sf = parse(rel, text);
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const callee = node.expression.text;
      if (!names.has(callee)) return;

      const parent = effectiveParent(node);
      const line = lineOf(node, sf);
      if (parent && ts.isExpressionStatement(parent)) {
        sites.push({
          file: rel,
          line,
          bucket: 'discarded',
          detail: `delegated write via ${callee}(): result discarded outright`,
        });
        return;
      }
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const fn = enclosingFunction(node);
        const scope: ts.Node = fn?.body ?? sf;
        const bindAt = node.getStart(sf);
        const nextBind = bindingPositions(scope, sf, parent.name.text).find((pos) => pos > bindAt);
        sites.push({
          file: rel,
          line,
          bucket: classifyBoundSite(scope, sf, parent.name.text, {
            from: bindAt,
            to: nextBind ?? Number.MAX_SAFE_INTEGER,
          }),
          detail: `delegated write via ${callee}(), bound to \`${parent.name.text}\``,
        });
        return;
      }
      // Anything else — returned onward, folded into a wider expression, pushed onto an array.
      // The obligation MIGHT be discharged where it lands, and this classifier cannot see where.
      // FAIL LOUD rather than assume: an unresolvable delegated call is a violation, not a pass.
      sites.push({
        file: rel,
        line,
        bucket: 'unclassified',
        detail:
          `delegated write via ${callee}() reaches an unrecognised position (parent: ` +
          `${parent ? ts.SyntaxKind[parent.kind] : 'none'}) — the obligation cannot be traced; ` +
          `bind it to an identifier or discharge it in place`,
      });
    });
  }
  return sites;
}

function loadSrcFiles(): { rel: string; text: string }[] {
  return listTsFiles(SRC_ROOT)
    .map((full) => ({ rel: path.relative(SRC_ROOT, full), full }))
    .filter(({ rel }) => rel !== WRAPPER_RELATIVE && rel !== RECORD_HELPER_RELATIVE)
    .map(({ rel, full }) => ({ rel, text: fs.readFileSync(full, 'utf8') }));
}

function sweep(): { sites: WriteSite[]; violations: WriteSite[] } {
  const files = loadSrcFiles();
  const sources = new Map(files.map(({ rel, text }) => [rel, text]));
  const sites = files.flatMap(({ rel, text }) => collectWriteSites(rel, text, sources));
  const delegatedSites = collectDelegatedCallSites(
    files,
    sites.filter((site) => site.bucket === 'delegated')
  );
  const all = [...sites, ...delegatedSites];
  return { sites: all, violations: all.filter((site) => VIOLATION_BUCKETS.has(site.bucket)) };
}

function census(sites: readonly WriteSite[]): Record<Bucket, number> {
  const counts = {
    'exempt-transaction-verb': 0,
    'invoked-transaction-factory': 0,
    inspected: 0,
    discarded: 0,
    delegated: 0,
    'no-negative-arm': 0,
    'console-only-arm': 0,
    unclassified: 0,
  } as Record<Bucket, number>;
  for (const site of sites) counts[site.bucket] += 1;
  return counts;
}

function render(sites: readonly WriteSite[]): string {
  return sites
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((site) => `  ${site.bucket.padEnd(22)} src/${site.file}:${site.line} — ${site.detail}`)
    .join('\n');
}

// ── the gate ───────────────────────────────────────────────────────────────────────────────

describe('no-silent-write: every execute(), raw(), and transaction() result is inspected', () => {
  const { sites, violations } = sweep();

  /**
   * Re-measuring the baseline is a mission requirement, not a one-off: run
   * `RBOOK_WRITE_CENSUS=1 npx jest tests/tools/rbook/no-silent-write.test.ts` to print the full
   * per-site classification instead of reading it out of a truncated assertion message.
   */
  if (process.env.RBOOK_WRITE_CENSUS) {
    // eslint-disable-next-line no-console
    console.log(
      ['', 'CENSUS:', JSON.stringify(census(sites), null, 2), '', 'ALL SITES:', render(sites)].join(
        '\n'
      )
    );
  }

  it('finds write sites to classify at all (guards against a silently empty sweep)', () => {
    expect(sites.length).toBeGreaterThan(100);
  });

  it('classifies every envelope-returning write call — an unrecognised shape fails loudly', () => {
    // Asserting on the RENDERED list, not the count, so the failure message names the sites.
    // (`expect(render(x) && x.length).toBe(0)` looks equivalent and is not: for an empty list
    // `'' && 0` is `''`, so it can never pass. Exactly the kind of assertion this mission exists
    // to distrust — one whose green and red both come from the wrong place.)
    const unclassified = sites.filter((site) => site.bucket === 'unclassified');
    expect(render(unclassified)).toBe('');
  });

  it('reports ZERO discarded, folded, or console-only write results', () => {
    const counts = census(sites);
    const message = [
      '',
      `Write-result census over src/ (excluding ${WRAPPER_RELATIVE} and ${RECORD_HELPER_RELATIVE}):`,
      JSON.stringify(counts, null, 2),
      '',
      'Violations:',
      render(violations),
      '',
      'Fix each by routing the result through checkWrite/countWrite (src/tools/rbook/write-guard.ts)',
      'or by adding a negative arm that does more than call console.*.',
    ].join('\n');
    expect(violations.length === 0 ? '' : message).toBe('');
  });

  // s92-m09: 3 -> 4. rbook-db-prune-snapshots.ts unwinds every failure inside its transaction (a
  // failed re-read, tombstone UPDATE or COMMIT) through one bare ROLLBACK, the exempt shape
  // exactly: the original failure is already in the answer, and inspecting the ROLLBACK would only
  // risk masking it.
  // s93-m11: 4 -> 5. staleness-detection.ts's repair unwinds the same way (a failed restore, ledger
  // write or COMMIT), and the failure it rolls back is already in the repair's warnings.
  it('derives the transaction-verb exemption from the SQL and selects exactly the 14 known ROLLBACKs', () => {
    const exempt = sites.filter((site) => site.bucket === 'exempt-transaction-verb');
    // s94-m05 adds rbook-mission-update's finally cleanup, guarded by transactionOpen.
    // The m04 migration rollback inspects its result, so it is NOT part of this exemption.
    // s94-m08 adds two mission-drop rollback arms after a failed required write or thrown fault.
    // s96-m11: 8 -> 9. schema-migrations.ts's underMigrationLock unwinds a first-write migration
    // that threw, and rethrows that error, which inspecting the ROLLBACK could only mask.
    // s102-m04: block/unblock each add one rollback; reopen adds three inspected rollback arms.
    expect({ count: exempt.length, sites: render(exempt) }).toMatchObject({ count: 14 });
    expect(exempt.every((site) => site.detail.startsWith('transaction verb: ROLLBACK'))).toBe(true);
  });
});

describe('no-silent-write: the rule bites on synthetic shapes', () => {
  it('distinguishes an immediately invoked SQLite transaction factory from a result envelope', () => {
    const source = `
      export function f(db: any) {
        return db.transaction(() => db.prepare('SELECT 1').get())();
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((site) => site.bucket)).toEqual([
      'invoked-transaction-factory',
    ]);
  });

  it('treats a factory invoked through .immediate() as invoked, but not one only read', () => {
    const source = `
      export function f(db: any) {
        db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run()).immediate();
        const later = db.transaction(() => true).immediate;
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((site) => site.bucket)).toEqual([
      'invoked-transaction-factory',
      'unclassified',
    ]);
  });

  it('still guards client write envelopes inside an invoked transaction factory', () => {
    const source = `
      export function f(db: any, client: any) {
        db.transaction(() => {
          client.execute('UPDATE missions SET status = ?', ['Done']);
        })();
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((site) => site.bucket)).toEqual([
      'invoked-transaction-factory',
      'discarded',
    ]);
  });

  it('does not treat a transaction passed to an unchecked caller as an invoked factory', () => {
    const source = `
      export function f(client: any) {
        ignore(client.transaction(() => true));
        const result = client.transaction(() => true);
        return 'all writes landed';
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((site) => site.bucket)).toEqual([
      'unclassified',
      'no-negative-arm',
    ]);
  });

  it('rejects a discarded transaction envelope even when its inner write is inspected', () => {
    const source = `
      export function f(client: any) {
        client.transaction(() => {
          const result = client.execute(
            'UPDATE missions SET status = ? WHERE id = ?',
            ['Done', 'm1']
          );
          if (!result.success) {
            throw new Error('inner write failed');
          }
          return true;
        });
        return 'all writes landed';
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((site) => site.bucket)).toEqual([
      'discarded',
      'inspected',
    ]);
  });

  it('applies the same rule to raw DDL without a per-site allowlist', () => {
    const source = `
      export function f(client: any, warnings: string[]) {
        client.raw('CREATE TRIGGER discarded AFTER INSERT ON t BEGIN SELECT 1; END');
        const folded = client.raw('CREATE VIRTUAL TABLE folded USING fts5(content)');
        if (folded.success) {
          return 'created';
        }
        checkWrite(
          client.raw('CREATE VIRTUAL TABLE guarded USING fts5(content)'),
          warnings,
          'guarded virtual table'
        );
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'discarded',
      'no-negative-arm',
      'inspected',
    ]);
  });

  it('still catches a bare non-transaction execute inside a catch clause', () => {
    const source = `
      export function f(client: any) {
        try {
          doWork();
        } catch (err) {
          client.execute('UPDATE missions SET status = ? WHERE id = ?', ['Blocked', 'm1']);
        }
      }
    `;
    const sites = collectWriteSites('fixture.ts', source);
    expect(sites.map((s) => s.bucket)).toEqual(['discarded']);
  });

  it('exempts a bare ROLLBACK in the same position, by SQL and not by file', () => {
    const source = `
      export function f(client: any) {
        try {
          doWork();
        } catch (err) {
          client.execute('ROLLBACK');
        }
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'exempt-transaction-verb',
    ]);
  });

  it('rejects a negative arm whose only body is console.*', () => {
    const source = `
      export function f(client: any) {
        const r = client.execute('INSERT INTO session_events (ts) VALUES (?)', [1]);
        if (!r.success) {
          console.warn('failed', r.error);
        }
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'console-only-arm',
    ]);
  });

  it('accepts the same arm once it also reaches a sink', () => {
    const source = `
      export function f(client: any, warnings: string[]) {
        const r = client.execute('INSERT INTO session_events (ts) VALUES (?)', [1]);
        if (!r.success) {
          console.warn('failed', r.error);
          warnings.push('event logging failed');
        }
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual(['inspected']);
  });

  it('rejects a positive fold with no else — the defect this mission closes', () => {
    const source = `
      export function f(client: any) {
        let count = 0;
        const r = client.execute('INSERT INTO learnings (content) VALUES (?)', ['x']);
        if (r.success) {
          count++;
        }
        return count;
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'no-negative-arm',
    ]);
  });

  it('accepts the assignment form (parent BinaryExpression) when it carries a negative arm', () => {
    const withArm = `
      export function f(client: any, warnings: string[]) {
        let insertResult: any;
        insertResult = client.execute('INSERT INTO sessions (id) VALUES (?)', ['s']);
        if (!insertResult.success) {
          warnings.push('session insert failed');
        }
      }
    `;
    const withoutArm = `
      export function f(client: any) {
        let insertResult: any;
        insertResult = client.execute('INSERT INTO sessions (id) VALUES (?)', ['s']);
        if (insertResult.success) {
          return 1;
        }
      }
    `;
    expect(collectWriteSites('fixture.ts', withArm).map((s) => s.bucket)).toEqual(['inspected']);
    expect(collectWriteSites('fixture.ts', withoutArm).map((s) => s.bucket)).toEqual([
      'no-negative-arm',
    ]);
  });

  it('accepts an execute() passed inline as argument 0 of checkWrite', () => {
    const source = `
      export function f(client: any, warnings: string[]) {
        checkWrite(
          client.execute('INSERT INTO session_events (ts) VALUES (?)', [1]),
          warnings,
          'session event logging'
        );
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual(['inspected']);
  });

  it('does NOT accept an execute() passed inline to some other function', () => {
    const source = `
      export function f(client: any) {
        logIt(client.execute('INSERT INTO session_events (ts) VALUES (?)', [1]));
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual(['unclassified']);
  });

  it('accepts a local envelope guard only when its negative arm unconditionally throws', () => {
    const guard = `function requireSuccess(result: any) {
      if (!result.success) throw new Error('write failed');
      return result.data;
    }`;
    const call = `function f(client: any) { requireSuccess(client.raw('ALTER TABLE x ADD COLUMN y TEXT'), 'step'); }`;
    expect(collectWriteSites('fixture.ts', guard + call).map((s) => s.bucket)).toEqual([
      'inspected',
    ]);
    for (const mutant of [
      guard.replace('!result.success', 'result.success'),
      guard.replace('!result.success', '!other.success'),
      guard.replace("throw new Error('write failed')", "console.warn('write failed')"),
      guard.replace("throw new Error('write failed')", 'return undefined'),
    ])
      expect(collectWriteSites('fixture.ts', mutant + call).map((s) => s.bucket)).toEqual([
        'unclassified',
      ]);
    expect(
      collectWriteSites(
        'fixture.ts',
        guard + call.replace('client: any)', 'client: any, requireSuccess: any)')
      ).map((s) => s.bucket)
    ).toEqual(['unclassified']);
  });

  it('proves a direct imported throwing guard and rejects changed bodies or import targets', () => {
    const modulePath = path.join('tools', 'rbook', 'record-link-store.ts');
    const actual = fs.readFileSync(path.join(SRC_ROOT, modulePath), 'utf8');
    const consumer = `import { requireLinkSuccess as verify } from './record-link-store';
      function f(client: any) { verify(client.raw('CREATE TABLE x(id)'), 'fixture'); }`;
    const classify = (body: string, text = consumer) =>
      collectWriteSites(
        path.join('tools', 'rbook', 'consumer.ts'),
        text,
        new Map([[modulePath, body]])
      ).map((site) => site.bucket);
    expect(classify(actual)).toEqual(['inspected']);
    const noThrow = actual.replace('throw new Error(', 'console.warn(');
    expect(noThrow).not.toBe(actual);
    expect(classify(noThrow)).toEqual(['unclassified']);
    const redirected = consumer.replace("'./record-link-store'", "'./unchecked-store'");
    expect(
      collectWriteSites(
        path.join('tools', 'rbook', 'consumer.ts'),
        redirected,
        new Map([
          [modulePath, actual],
          [
            path.join('tools', 'rbook', 'unchecked-store.ts'),
            'export function requireLinkSuccess(result: any) { return result.data; }',
          ],
        ])
      ).map((site) => site.bucket)
    ).toEqual(['unclassified']);
    expect(
      classify(actual, consumer.replace("'./record-link-store'", "'./unchecked-store'"))
    ).toEqual(['unclassified']);
    expect(
      classify(actual.replace('export function requireLinkSuccess', 'function requireLinkSuccess'))
    ).toEqual(['unclassified']);
    expect(
      classify(
        actual,
        consumer.replace('function f(client: any)', 'function f(client: any, verify: any)')
      )
    ).toEqual(['unclassified']);
  });

  it('checks asserted imported envelope data without trusting a cast over the wrong object', () => {
    const modulePath = path.join('tools', 'rbook', 'spin-out-store.ts');
    const actual = fs.readFileSync(path.join(SRC_ROOT, modulePath), 'utf8');
    const consumer = `import { requireSpinOut } from './spin-out-store';
      function f(client: any) { requireSpinOut(client.raw('COMMIT'), 'fixture'); }`;
    const classify = (body: string) =>
      collectWriteSites(
        path.join('tools', 'rbook', 'consumer.ts'),
        consumer,
        new Map([[modulePath, body]])
      ).map((site) => site.bucket);
    expect(classify(actual)).toEqual(['inspected']);
    for (const changed of [
      actual.replace('return result.data as T;', 'return other.data as T;'),
      actual.replace('if (!result.success)', 'if (result.success)'),
      actual.replace('throw new Error(', 'console.warn('),
    ]) {
      expect(changed).not.toBe(actual);
      expect(classify(changed)).toEqual(['unclassified']);
    }
  });

  it('attributes discharge PER BINDING, not per identifier name', () => {
    // THE REGRESSION THIS GATE EXISTS TO CATCH. `insertResult` / `result` / `res` are reused
    // across sibling blocks in 12 real scopes here, concentrated in the Tier-1 sites. Keying
    // discharge on the NAME let one checkWrite satisfy every other binding of that name in the
    // same function — so reverting a single extraction fold to `if (r.success) count++` left the
    // gate GREEN. Only the SECOND binding below is discharged; the first must still be a
    // violation.
    const source = `
      export function f(client: any, warnings: string[]) {
        let count = 0;
        {
          const r = client.execute('INSERT INTO a (x) VALUES (?)', [1]);
          if (r.success) {
            count++;
          }
        }
        {
          const r = client.execute('INSERT INTO b (x) VALUES (?)', [1]);
          checkWrite(r, warnings, 'b insert');
        }
        return count;
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'no-negative-arm',
      'inspected',
    ]);
  });

  it('does not let a discharge BEFORE a rebinding cover the value written after it', () => {
    // The retry-loop shape: a placeholder binding whose result is overwritten immediately. The
    // arm at the bottom belongs to the SECOND binding, not the first — which is exactly how
    // rbook-session-start.ts's `client.execute('SELECT 1')` placeholder hid for 99 - 98 = 1 site.
    const source = `
      export function f(client: any, warnings: string[]) {
        let r = client.execute('SELECT 1', []);
        r = client.execute('INSERT INTO a (x) VALUES (?)', [1]);
        if (!r.success) {
          warnings.push('insert failed');
        }
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'no-negative-arm',
      'inspected',
    ]);
  });

  it('fails loudly when a delegated write lands somewhere it cannot be traced', () => {
    const files = [
      {
        rel: 'delegator.ts',
        text: `
          function activateParentSprint(client: any, id: string) {
            return client.execute('UPDATE sprints SET status = ? WHERE id = ?', ['Active', id]);
          }
          export function caller(client: any, out: any[]) {
            out.push(activateParentSprint(client, 's1'));
          }
        `,
      },
    ];
    const sites = collectWriteSites(files[0].rel, files[0].text);
    const callSites = collectDelegatedCallSites(
      files,
      sites.filter((s) => s.bucket === 'delegated')
    );
    // Not silently assumed-discharged: an untraceable delegated write is a violation.
    expect(callSites.map((s) => s.bucket)).toEqual(['unclassified']);
  });

  it('accepts a conditional-initializer pair routed through countWrite', () => {
    const source = `
      export function f(client: any, warnings: string[], flag: boolean) {
        const r = flag
          ? client.execute('UPDATE constraints SET a = ? WHERE id = ?', [1, 2])
          : client.execute('UPDATE constraints SET b = ? WHERE id = ?', [1, 2]);
        return countWrite(r, warnings, 'constraint update');
      }
    `;
    expect(collectWriteSites('fixture.ts', source).map((s) => s.bucket)).toEqual([
      'inspected',
      'inspected',
    ]);
  });

  it('carries the obligation to the call sites of a delegated return', () => {
    const files = [
      {
        rel: 'delegator.ts',
        text: `
          function activateParentSprint(client: any, id: string) {
            return client.execute('UPDATE sprints SET status = ? WHERE id = ?', ['Active', id]);
          }
          export function caller(client: any) {
            activateParentSprint(client, 's1');
          }
        `,
      },
    ];
    const sites = collectWriteSites(files[0].rel, files[0].text);
    expect(sites.map((s) => s.bucket)).toEqual(['delegated']);
    const callSites = collectDelegatedCallSites(
      files,
      sites.filter((s) => s.bucket === 'delegated')
    );
    expect(callSites.map((s) => s.bucket)).toEqual(['discarded']);
  });
});

describe('no-silent-write: the guard module it points at exists', () => {
  it('exports checkWrite and countWrite from src/tools/rbook/write-guard.ts', () => {
    const guardPath = path.join(SRC_ROOT, 'tools', 'rbook', 'write-guard.ts');
    expect(fs.existsSync(guardPath)).toBe(true);
    const text = fs.readFileSync(guardPath, 'utf8');
    expect(text).toContain('export function checkWrite');
    expect(text).toContain('export function countWrite');
  });

  it("carries no allowlist — checked against this file's own source, not a filename guess", () => {
    // A two-filename existence check would pass against an allowlist under any other name, in
    // another directory, or inlined here as an array literal. Assert on the SOURCE instead: the
    // only path-shaped constant this gate may hold is WRAPPER_RELATIVE (client.ts, where
    // `.execute` is DEFINED — sanctioned by the mission plan).
    // Only STRING-LITERAL nodes count, so a path named in a comment (the false-negative profile
    // cites scripts/measure-cross-store-baseline.ts by name) is excluded structurally rather than
    // by a regex that has to guess. Same technique as agent-prompt-tool-names.test.ts.
    const self = parse(__filename, fs.readFileSync(__filename, 'utf8'));
    const pathLiterals: string[] = [];
    walk(self, (node) => {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
      if (/^[\w./-]*\/[\w./-]+\.ts$/.test(node.text)) pathLiterals.push(node.text);
    });
    const unexpected = pathLiterals.filter((literal) => !literal.includes('client.ts'));
    expect(unexpected).toEqual([]);

    for (const name of ['no-silent-write.allowlist.json', 'no-silent-write.allowlist.ts']) {
      expect(fs.existsSync(path.join(REPO_ROOT, 'tests', 'tools', 'rbook', name))).toBe(false);
    }
  });
});

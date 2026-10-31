// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m03 shared AST walker — derives, per registered tool, its dispatch SHAPE, what each
// ABOUTME: delegated handler ACCEPTS, and what its router actually FORWARDS. One copy, two consumers.

/**
 * Sprint 86 m03 — "no consolidated router may declare a parameter it silently drops".
 *
 * ONE WALKER, TWO CONSUMERS, DELIBERATELY (critic 2, major 2). This module is imported by BOTH
 * `tests/tools/rbook/router-param-forwarding.test.ts` (the gate) and `scripts/probe-router-params.ts`
 * (the codegen entry point `npm run probe:router-params`, which s86-m04 uses to generate its
 * ACTION_PARAMS first cut). A jest test is not invokable as a codegen step, and two copies of this
 * walk would drift on the unwrap trap documented below. Nothing new ships: `scripts/` is absent
 * from package.json `files[]`.
 *
 * ── THE NON-OBVIOUS AST MECHANIC ───────────────────────────────────────────────────────────────
 * The forwarded object literal is wrapped in a `satisfies` or `as` expression in NINE of the
 * routers — `satisfies` in rbook-learnings / decisions / sprint / db / mission / mission-transition /
 * project, `as` in rbook-context / rbook-session, and rbook-project carries one of each — so
 * `ts.isObjectLiteralExpression(call.arguments[0])` is FALSE for them.
 *
 * MEASURED, not assumed: deleting only the satisfies/as arm of `unwrap()` moves 49 calls from
 * OBJECT-LITERAL to NOT-A-FORWARDING-SITE (67 -> 18). POSITIONAL is unchanged at 13, so the
 * once-stated "reports (positional) for every one of them" was wrong. The consequence is worse than
 * that phrasing suggested in one direction and different in the other: assertion A goes VACUOUSLY
 * GREEN (nothing left to score), while assertion B turns RED on a false positive — `rbook_context
 * types`, whose rename source `params.searchTypes as RankedResultType[]` is lost with the unwrap.
 * That is why this lives in exactly one place.
 *
 * ── WHAT IS DERIVED, NOT CONFIGURED ────────────────────────────────────────────────────────────
 * There is no tool→handler map in this file. The map is READ from the real dispatch: the
 * `executeMissionProtocolTool` switch in src/index.ts, where each `case '<toolName>':` binds its
 * entry function as the initializer of a `result` variable. A registered tool with no case, or a
 * case with no such call, is an assertion-C failure — not a skip.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// ─── Public model ────────────────────────────────────────────────────────────

/** How a tool's entry function dispatches. Derived and printed for all 15 registered tools. */
export type DispatchShape = 'SWITCH-ROUTER' | 'MONOLITHIC';

/** How ONE delegated call passes (or fails to pass) the router's params along. */
export type CallShape = 'OBJECT-LITERAL' | 'PASS-THROUGH' | 'POSITIONAL' | 'NOT-A-FORWARDING-SITE';

export interface SourceRef {
  readonly file: string;
  readonly line: number;
}

/** Why one raw `params.<key>` read before the tool's entry call does or does not need preflight. */
export type PreDispatchReadClassification =
  | 'requires-preflight'
  | 'safe-enum-discriminant'
  | 'non-string-schema';

/** One dispatcher-level params read, retained even when a rule proves it cannot throw. */
export interface PreDispatchRead extends SourceRef {
  readonly key: string;
  readonly classification: PreDispatchReadClassification;
  readonly reason: string;
}

/** A key excluded from the forwarding rules, with the RULE that excluded it. Never an allowlist. */
export interface ExcludedKey extends SourceRef {
  readonly key: string;
  /** `underscore` | `internal-jsdoc` | `outside-parameter-0` */
  readonly rule: string;
  /** For `internal-jsdoc`, the author's stated reason, verbatim. */
  readonly reason: string;
}

/** One delegated call reached from a case branch (or from a monolithic entry function). */
export interface DelegatedCall extends SourceRef {
  readonly callee: string;
  readonly shape: CallShape;
  /** Keys the callee's parameter-0 object type declares (object-shaped callees only). */
  readonly accepted: readonly string[];
  /** Non-infrastructure positional parameter names (POSITIONAL callees only). */
  readonly positionalAccepted: readonly string[];
  /** Keys the router actually passes. */
  readonly forwarded: readonly string[];
  /**
   * For a PASS-THROUGH callee, the accepted keys its own body actually READS — s86-m04.
   *
   * A pass-through hands the WHOLE params object over, so `forwarded` is every accepted key and
   * says nothing about applicability: it would claim `deviceCode` applies to `rbook_auth(rotate)`.
   * The callee's own reads are the honest per-action answer. Empty for every other shape, where
   * `forwardedFrom` already names keys one at a time.
   */
  readonly calleeReadKeys: readonly string[];
  /**
   * For each forwarded key, the ROUTER key it came from — `limit` ← `searchLimit`. Routers rename
   * on the way through, so assertion B needs the source name to tell a rename from a gap.
   */
  readonly forwardedFrom: Readonly<Record<string, string>>;
  /** accepted − forwarded − excluded. Assertion A's red set. */
  readonly dropped: readonly string[];
  /** Keys excluded by rule at this call, echoed for printing. */
  readonly excluded: readonly ExcludedKey[];
  /** True when this callee is itself switch-shaped (a sub-router we recursed into). */
  readonly isSubRouter: boolean;
  /** Recursion depth: 1 = reached from the tool entry, 2 = reached from a sub-router. */
  readonly depth: number;
}

export interface Branch {
  /** The `case` label, or `(monolithic)` for a tool with no action switch. */
  readonly action: string;
  readonly calls: readonly DelegatedCall[];
  /**
   * Every `<params>.<key>` this branch READS, forwarded or not — s86-m04's second arm.
   *
   * FORWARDING ALONE IS NOT CONSUMPTION. `rbook_learnings(action="list")` reads
   * `params.acrossProjects` to pick between two handlers and hands it to neither
   * (rbook-learnings.ts:254); `rbook_project(action="list")` does the same with `params.validate`.
   * Those params are live and applicable to their action, so a per-action applicability contract
   * scored on forwarding alone would call them dead. A key in NEITHER set is the real defect:
   * the tool publishes it for an action that does nothing with it.
   */
  readonly readKeys: readonly string[];
}

export interface ToolModel {
  readonly tool: string;
  readonly entry: SourceRef & { readonly fn: string };
  readonly shape: DispatchShape;
  /** Why this shape was computed — printed for MONOLITHIC tools so nothing is silently skipped. */
  readonly shapeReason: string;
  /** Top-level property names on the tool's published JSON inputSchema. */
  readonly inputSchemaKeys: readonly string[];
  /** Parameter-0 object keys of the ENTRY function (assertion B's oracle for MONOLITHIC tools). */
  readonly entryParamKeys: readonly string[];
  /**
   * Keys the entry function reads OUTSIDE its action switch — s86-m04. They apply to EVERY action,
   * so they are the third arm of the applicability evidence and the reason no per-key carve-out is
   * needed for the discriminant.
   *
   * TWO REAL INSTANCES, both invisible to a per-branch read: `action` itself (every router opens
   * with `typeof params.action === 'string' ? params.action : ''` before the switch), and
   * `rbook_message.projectRoot`, which `rbookMessage` consumes ONCE at rbook-message.ts:1175 to build
   * the dashboard client for all six delegated actions. Scoring branch-local reads alone would
   * publish `projectRoot` as inapplicable to every rbook_message action.
   */
  readonly routerScopeReadKeys: readonly string[];
  /** Raw `params.<key>` reads in src/index.ts before this case reaches its entry call. */
  readonly preDispatchReads: readonly PreDispatchRead[];
  readonly branches: readonly Branch[];
}

/** A fact the walk could not compute. Assertion C turns every one of these into a failure. */
export interface Unclassifiable extends SourceRef {
  readonly what: string;
  readonly detail: string;
}

export interface WalkResult {
  readonly tools: readonly ToolModel[];
  /** Exported literal guard scope read from src/index.ts; malformed declarations are C failures. */
  readonly preflightParams: readonly string[];
  readonly unclassifiable: readonly Unclassifiable[];
  /** Every @internal/underscore/outside-parameter-0 exclusion made anywhere in the walk. */
  readonly exclusions: readonly ExcludedKey[];
  /** In-src calls inside a branch that return no RbookToolResult — printed, never silently dropped. */
  readonly nonDelegatingCalls: readonly (SourceRef & { readonly callee: string })[];
  readonly programFileCount: number;
  readonly programBuildMs: number;
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * THE FOURTH EXCLUSION RULE, named as such (build-time critic 1, #3).
 *
 * A positional parameter of an infrastructure type is a wiring seam the enclosing function supplies,
 * not a caller-supplied value, so it is not a "drop" when the router does not forward it —
 * `reaffirmConstraint(client, id, evergreen)` receives its `client` from `withClientValidated`.
 *
 * TWO CONSTRAINTS KEEP IT FROM BEING AN ALLOWLIST. (1) It holds ONLY types measured to be exercised
 * by a real positional callee — the three speculative entries it originally carried
 * (DashboardClient, CredentialStore, ProjectGraphRegistry) matched nothing in the tree and were
 * removed; a genuinely new infra type turns the gate RED and must be added in a visible diff.
 * (2) Every exclusion it makes is recorded in `ctx.exclusions` and printed, exactly like the
 * @internal ones — it used to `return` silently, so the "complete excluded set" was not complete.
 */
const INFRASTRUCTURE_TYPES = new Set(['RbookDatabaseClient']);

/** Union-safe: `t.getSymbol()` is undefined for `RbookDatabaseClient | undefined`. */
function isInfrastructureType(t: ts.Type, checker: ts.TypeChecker): boolean {
  const parts = t.isUnion() ? t.types : [t];
  return parts.some((part) => {
    const name = part.getSymbol()?.getName() ?? checker.typeToString(part);
    return INFRASTRUCTURE_TYPES.has(name);
  });
}

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../..');
const DISPATCH_FN = 'executeMissionProtocolTool';

/** Per-walk roots. Parameterized so the gate can walk a SYNTHETIC fixture tree and prove that
 *  assertion C actually fires — a no-silent-skip claim asserted but never demonstrated would be
 *  this sprint's own defect class inside its own gate. */
interface Paths {
  readonly repoRoot: string;
  readonly srcDir: string;
  readonly indexTs: string;
}

// ─── AST helpers ─────────────────────────────────────────────────────────────

/**
 * Strip `satisfies` / `as` / parentheses. THE load-bearing helper — see the module header.
 */
export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function refOf(node: ts.Node, paths: Paths): SourceRef {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: path.relative(paths.repoRoot, sf.fileName), line: line + 1 };
}

function isUnderSrc(fileName: string, paths: Paths): boolean {
  return path.resolve(fileName).startsWith(paths.srcDir + path.sep);
}

/** Unwrap `Promise<T>` to `T`; otherwise identity. */
function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const sym = type.getSymbol();
  if (sym?.getName() === 'Promise') {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) return args[0];
  }
  return type;
}

/**
 * Does this call return a `RbookToolResult<…>` (possibly promise-wrapped, possibly one arm of a
 * union)?
 *
 * THE UNION ARM MATTERS (build-time critic finding 4). Matching only the top-level alias name
 * demotes a real handler returning `RbookToolResult<T> | null` — a shape live in-tree at
 * rbook-context-condense.ts:646 — to a "non-delegating call", where nothing scores it.
 */
function returnsRbookToolResult(sig: ts.Signature, checker: ts.TypeChecker): boolean {
  const ret = unwrapPromise(checker.getReturnTypeOfSignature(sig), checker);
  const names = (t: ts.Type): string[] =>
    t.isUnion()
      ? t.types.flatMap(names)
      : [t.aliasSymbol?.getName() ?? t.getSymbol()?.getName() ?? ''];
  return names(ret).includes('RbookToolResult');
}

/**
 * Is parameter 0 a CALLBACK? Then this is a higher-order COMBINATOR, not a delegated handler —
 * `withClientValidated(fn, {projectRoot})` and friends (client.ts). Its options object configures
 * the DB client, not the tool's parameter surface, and the real handler work lives in the callback
 * body, which the walk already covers because that body is lexically inside the enclosing function.
 *
 * Scoring these was a structural green (build-time critic finding 2): `accepted` was read from
 * parameter 0 — a function type with no properties — so every combinator reported `accepted: []`
 * and could never be red, while `rbook_status` and `rbook_agent_onboard` had NO other scored call.
 */
function isCombinator(sig: ts.Signature, checker: ts.TypeChecker, at: ts.Node): boolean {
  const p0 = sig.parameters[0];
  if (!p0) return false;
  return checker.getTypeOfSymbolAtLocation(p0, at).getCallSignatures().length > 0;
}

/** Property names of an object type, in declaration order. */
function typeKeys(type: ts.Type): string[] {
  return type.getProperties().map((p) => p.getName());
}

/**
 * The `@internal` exclusion rule, resolved from the property's own declaration.
 *
 * ANTI-ABUSE (folded from critic finding): `@internal` is an allowlist with better manners unless
 * it is constrained, so the tag must carry a REASON and the caller (the gate) asserts that every
 * excluded key is ALSO absent from the tool's published inputSchema — a key cannot be both
 * internal and published — and prints the complete excluded set on every run.
 */
function internalTagReason(symbol: ts.Symbol): string | undefined {
  for (const decl of symbol.getDeclarations() ?? []) {
    for (const tag of ts.getJSDocTags(decl)) {
      if (tag.tagName.getText() !== 'internal') continue;
      const comment = tag.comment;
      const text =
        typeof comment === 'string'
          ? comment
          : (comment ?? []).map((c) => ('text' in c ? c.text : '')).join('');
      // A BARE `@internal` with no reason does NOT exclude (build-time critic finding 9). The tag
      // is a CLAIM — "no caller has business setting this" — and a claim with no stated grounds is
      // precisely what this sprint refuses to accept. Returning undefined here leaves the key
      // scored, so A and B go red until someone writes down why.
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}

/**
 * Classify a key as excluded-by-rule, or not. THREE rules, no fourth, no per-site list:
 *   1. a leading underscore (`_getNow`) — the in-tree convention for a test hook;
 *   2. an `@internal` JSDoc tag resolved via ts.getJSDocTags on the property declaration;
 *   3. a position outside parameter 0 (handled by the caller — such a key is never in the
 *      parameter-0 property set at all, so it cannot appear here).
 */
function exclusionFor(symbol: ts.Symbol): { rule: string; reason: string } | undefined {
  const name = symbol.getName();
  if (name.startsWith('_')) {
    return {
      rule: 'underscore',
      reason: 'leading underscore — in-tree convention for a test hook',
    };
  }
  const reason = internalTagReason(symbol);
  if (reason !== undefined) {
    return { rule: 'internal-jsdoc', reason };
  }
  return undefined;
}

// ─── The walk ────────────────────────────────────────────────────────────────

interface Ctx {
  readonly checker: ts.TypeChecker;
  readonly paths: Paths;
  readonly unclassifiable: Unclassifiable[];
  readonly exclusions: ExcludedKey[];
  readonly nonDelegatingCalls: (SourceRef & { callee: string })[];
}

/**
 * Find the ACTION switch: a string-cased switch whose discriminant reads a PROPERTY OF THE ROUTER'S
 * OWN PARAMS, directly or through ONE local binding.
 *
 * THE DISCRIMINANT TEST IS LOAD-BEARING (build-time critic 1, #5). "First string-cased switch
 * anywhere in the body" is hijackable, and each hijack yields a GREEN gate that walked the wrong
 * branches and scored nothing: a `switch (poll.status)` inside a nested helper (live at
 * rbook-auth.ts:847, which is why `handleLoginComplete` was being mislabelled a sub-router), or any
 * incidental string switch in a delegate (`switch (type)` in rbook-mission-depends.ts).
 *
 * ANY params property, not just `action` — the sub-routers dispatch on `params.constraintAction`
 * (rbook-constraints.ts:142) and `params.nextStepAction` (rbook-next-steps.ts:73). Requiring the
 * literal name `action` silently stopped recursing into BOTH of them, which cost every depth-2
 * POSITIONAL call its scoring. That regression was caught by this walker's own printed output.
 *
 * AMBIGUITY IS REPORTED, NOT RESOLVED. Two top-level params-discriminated string switches mean the
 * walk cannot say which one is the dispatch, so it names the fact instead of picking one.
 *
 * NESTED BODIES ARE SEARCHED, and the discriminant test — not a syntactic skip — is what excludes
 * a closure's own control flow. Both real sub-routers put their action switch INSIDE the
 * `withClientValidated` callback, so skipping nested functions stopped recursing into either and
 * silently cost every depth-2 call its scoring. The discriminant test already rejects the closure
 * cases: `switch (poll.status)` resolves `poll` to a call result, and a helper switching on its own
 * parameter resolves to a ParameterDeclaration — neither is a property of the router's params.
 */
function findActionSwitches(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): ts.SwitchStatement[] {
  const paramName = fn.parameters[0]?.name.getText();
  if (!paramName) return [];

  /** Does this expression read `<paramName>.<anything>`, directly or through one local binding? */
  const readsParamsProperty = (expr: ts.Expression): boolean =>
    paramsSourceKey(expr, paramName, checker) !== undefined;

  const found: ts.SwitchStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      const stringCases = node.caseBlock.clauses.filter(
        (c): c is ts.CaseClause => ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression)
      );
      if (stringCases.length > 0 && readsParamsProperty(node.expression)) {
        found.push(node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}

/** The single action switch, or undefined when there is none (MONOLITHIC) or more than one. */
function findActionSwitch(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): ts.SwitchStatement | undefined {
  const all = findActionSwitches(fn, checker);
  return all.length === 1 ? all[0] : undefined;
}

/**
 * The MCP dispatch switch in src/index.ts. Separate from `findActionSwitch` on purpose: this one
 * discriminates on the TOOL NAME (`switch (name)`), a different question from a router's `action`,
 * so it must not be forced through the action-discriminant test.
 */
function findToolNameSwitch(fn: ts.FunctionLikeDeclaration): ts.SwitchStatement | undefined {
  let found: ts.SwitchStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(node)) return;
    if (ts.isSwitchStatement(node)) {
      const stringCases = node.caseBlock.clauses.filter(
        (c): c is ts.CaseClause => ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression)
      );
      if (stringCases.length > 0) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}

/** Resolve a call expression's declared function, if it lives in src/. */
function declarationOf(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  paths: Paths
): ts.FunctionLikeDeclaration | undefined {
  const sym = checker.getSymbolAtLocation(call.expression);
  const resolved = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  for (const decl of resolved?.getDeclarations() ?? []) {
    if (!isUnderSrc(decl.getSourceFile().fileName, paths)) continue;
    if (
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isArrowFunction(decl) ||
      ts.isFunctionExpression(decl)
    ) {
      return decl;
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
  }
  return undefined;
}

/**
 * Does this call DIRECTLY forward the router's params — the bare identifier, a `params.<key>`
 * argument, or an object-literal property whose VALUE is a `params.<key>` access?
 *
 * THIS IS WHAT MAKES A CALL A FORWARDING SITE, and both halves of the rule are load-bearing.
 *
 * Returning a `RbookToolResult` is NOT sufficient. `createError({code, message})` and
 * `createSuccess({...})` return one too, and they are RESPONSE CONSTRUCTORS: a router that does
 * not pass `suggestion` to `createError` has dropped nothing. Scoring them produced a red set of
 * error-shape keys (`validValues`, `availableActions`, `phase`, …) on first measurement — noise
 * that would have been silenced with an allowlist, which is exactly what this gate forbids.
 *
 * DIRECT is the second half. `createError({ message: \`Feedback #${params.feedbackId} not found\` })`
 * mentions params but does not FORWARD one — the value is consumed into a message, not handed on.
 * So a params reference must sit at the root of an argument or of a property value (through
 * `??`/`||`, a ternary, `as`/`satisfies`, `!`), not anywhere inside it.
 *
 * A call that forwards nothing is NOT-A-FORWARDING-SITE — the same class the plan defines for
 * `handleLogin(store, deviceCodeFlow, dashboardBaseUrl)` — and is printed, never scored.
 *
 * FALSE NEGATIVE, NAMED: a delegated handler invoked with a wholly literal argument
 * (`rbookMissionStatus({})`) forwards nothing and is therefore not scored. No such call exists in
 * the tree today; if one is added, assertion A will not see its drops.
 */
function paramsSourceKey(
  expr: ts.Expression,
  routerParamName: string,
  checker: ts.TypeChecker,
  hops = 0
): string | undefined {
  const u = unwrap(expr);
  if (
    ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === routerParamName
  ) {
    return u.name.getText();
  }
  if (ts.isBinaryExpression(u)) {
    return (
      paramsSourceKey(u.left, routerParamName, checker, hops) ??
      paramsSourceKey(u.right, routerParamName, checker, hops)
    );
  }
  if (ts.isConditionalExpression(u)) {
    return (
      paramsSourceKey(u.whenTrue, routerParamName, checker, hops) ??
      paramsSourceKey(u.whenFalse, routerParamName, checker, hops)
    );
  }
  if (ts.isNonNullExpression(u))
    return paramsSourceKey(u.expression, routerParamName, checker, hops);
  if (ts.isIdentifier(u) && hops < 1) {
    // ONE hop through a local binding. `rbook-review.ts:297` does `const projectRoot =
    // params.projectRoot` and forwards the LOCAL, so a purely syntactic `params.<key>` test reports
    // "no params reach this call" about a call params demonstrably reach (build-time critic 1, #2).
    const sym = checker.getSymbolAtLocation(u);
    for (const decl of sym?.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return paramsSourceKey(decl.initializer, routerParamName, checker, hops + 1);
      }
    }
  }
  return undefined;
}

/**
 * Does this call DIRECTLY forward the router's params — the bare identifier, a `params.<key>`
 * argument (possibly through `??`, a ternary, `as`/`satisfies`, `!`, or ONE local binding), or an
 * object-literal property whose VALUE is one of those?
 *
 * THIS IS WHAT MAKES A CALL A FORWARDING SITE, and both halves of the rule are load-bearing.
 *
 * Returning a `RbookToolResult` is NOT sufficient. `createError({code, message})` returns one too and
 * is a RESPONSE CONSTRUCTOR: a router that does not pass `suggestion` to `createError` has dropped
 * nothing. Scoring the constructors produced a red set of error-shape keys (`validValues`,
 * `availableActions`, `phase`, …) on first measurement — noise that would have been silenced with
 * an allowlist, which is exactly what this gate forbids.
 *
 * DIRECT is the second half. `createError({ message: `Feedback #${params.feedbackId} not found` })`
 * MENTIONS params but does not FORWARD one — the value is consumed into a message, not handed on.
 * So a params reference must sit at the ROOT of an argument or of a property value, not anywhere
 * inside it.
 */
function referencesParams(
  call: ts.CallExpression,
  routerParamName: string,
  checker: ts.TypeChecker
): boolean {
  const forwards = (n: ts.Expression): boolean =>
    paramsSourceKey(n, routerParamName, checker) !== undefined;

  for (const raw of call.arguments) {
    const arg = unwrap(raw);
    if (ts.isIdentifier(arg) && arg.text === routerParamName) return true; // PASS-THROUGH
    if (forwards(arg)) return true; // POSITIONAL (incl. `??`-wrapped and one-hop locals)
    const literals = objectLiteralsOf(arg);
    for (const lit of literals) {
      for (const prop of lit.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          // `{ projectRoot }` where `projectRoot` is a local bound from params. classifyCall already
          // counts shorthand as forwarded, so skipping it here made the two halves disagree.
          if (paramsSourceKey(prop.name, routerParamName, checker) !== undefined) return true;
          continue;
        }
        if (ts.isSpreadAssignment(prop)) {
          // A BARE `...params` spread reaches the call. It must be recognised HERE or the call is
          // dismissed as NOT-A-FORWARDING-SITE and never reaches the object-literal loop that
          // records the unnameable-key failure — green AND blind on the single most natural
          // refactor of a consolidated router (build-time critic 2, #1).
          const sp = unwrap(prop.expression);
          if (ts.isIdentifier(sp) && sp.text === routerParamName) return true;
          if (forwards(prop.expression)) return true;
        }
        if (ts.isPropertyAssignment(prop) && forwards(prop.initializer)) return true;
      }
    }
  }
  return false;
}

/** Object literals reachable from an argument, descending ternary arms. */
function objectLiteralsOf(expr: ts.Expression): ts.ObjectLiteralExpression[] {
  const u = unwrap(expr);
  if (ts.isObjectLiteralExpression(u)) return [u];
  if (ts.isConditionalExpression(u)) {
    return [...objectLiteralsOf(u.whenTrue), ...objectLiteralsOf(u.whenFalse)];
  }
  return [];
}

/**
 * Every `<routerParamName>.<key>` read syntactically inside `node`, in first-seen order.
 *
 * SYNTACTIC AND SHALLOW, deliberately. It answers "does this branch touch this key at all?", which
 * is the weaker of the two arms s86-m04's applicability gate accepts — the stronger arm (forwarded
 * to a handler that accepts it) is `DelegatedCall.forwardedFrom`. Widening this to follow a local
 * binding would let a branch claim a key it merely aliased, and the gate's job is to be red when a
 * published claim has no basis, not to hunt for one.
 */
function readParamKeys(nodes: readonly ts.Node[], routerParamName: string): string[] {
  const seen = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === routerParamName
    ) {
      seen.add(n.name.getText());
    }
    ts.forEachChild(n, visit);
  };
  for (const node of nodes) visit(node);
  return [...seen];
}

/** Every call expression syntactically inside `node`. */
function callsIn(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return out;
}

/**
 * Classify ONE delegated call and compute its accepted / forwarded / dropped sets.
 *
 * Four shapes, all derived (no configuration):
 *   OBJECT-LITERAL         — argument 0 unwraps to an object literal; forwarded = its keys.
 *   PASS-THROUGH           — an argument is the bare `params` identifier; A is satisfied by
 *                            identity (rbook_auth, rbook_message are structurally immune).
 *   POSITIONAL             — no object literal, no bare `params`, but ≥1 `params.<key>` access;
 *                            accepted = non-infrastructure parameter names.
 *   NOT-A-FORWARDING-SITE  — none of the above and no params reach it at all
 *                            (e.g. handleLogin(store, deviceCodeFlow, dashboardBaseUrl)).
 */
function classifyCall(
  call: ts.CallExpression,
  callee: ts.FunctionLikeDeclaration,
  routerParamName: string,
  depth: number,
  ctx: Ctx
): DelegatedCall {
  const { checker } = ctx;
  const ref = refOf(call, ctx.paths);
  const calleeName = ts.isFunctionDeclaration(callee)
    ? (callee.name?.getText() ?? '(anonymous)')
    : (call.expression.getText() ?? '(anonymous)');
  const isSubRouter = findActionSwitch(callee, checker) !== undefined;

  const sig = checker.getResolvedSignature(call);
  if (!sig) {
    ctx.unclassifiable.push({
      ...ref,
      what: `unresolvable signature for ${calleeName}`,
      detail:
        'getResolvedSignature returned undefined; the walk cannot say what this call accepts, ' +
        'so it must not report a green forwarding result for it.',
    });
  }

  const args = call.arguments.map((a) => unwrap(a));
  // INDEX-MATCHED, not "the first object literal anywhere" (build-time critic finding 2). When the
  // literal sits at argument >= 1, reading `accepted` off parameter 0 describes a DIFFERENT
  // parameter and every drop silently disappears.
  const objectArgIndex = args.findIndex((a) => objectLiteralsOf(a).length > 0);
  const objectArgLiterals = objectArgIndex >= 0 ? objectLiteralsOf(args[objectArgIndex]) : [];
  const objectArg = objectArgLiterals[0];
  const passThrough = args.some((a) => ts.isIdentifier(a) && a.text === routerParamName);
  // THE SAME PREDICATE as `forwardsAnything`, deliberately. A strict raw-PropertyAccess filter here
  // while `forwardsAnything` accepted `??`/ternary/locals meant a call could prove params reach it
  // and then fall through to the `else` and be PRINTED as "no params reach them, nothing to drop" —
  // a false statement about three live sites (rbook-next-steps.ts:92/:95, rbook-constraints.ts:164/:166)
  // whose siblings three lines away WERE scored (build-time critic 1, #1).
  const positionalArgs = args.filter(
    (a) =>
      !ts.isObjectLiteralExpression(a) && paramsSourceKey(a, routerParamName, checker) !== undefined
  );

  const excluded: ExcludedKey[] = [];
  const forwardedFrom: Record<string, string> = {};
  const calleeReadKeys: string[] = [];
  let shape: CallShape;
  // A RbookToolResult-returning call that no params REACH cannot have dropped one. Two very
  // different callees land here and both are correctly scored at zero: `handleLogin(store,
  // deviceCodeFlow, dashboardBaseUrl)` (rbook-auth), whose parameter 0 is a CredentialStore and
  // which takes no params at all; and the response CONSTRUCTORS `createError`/`createSuccess`,
  // which return a RbookToolResult but whose keys (`suggestion`, `validValues`, `phase`, …) were
  // never the router's to supply. Scoring the constructors produced a red set of error-shape keys
  // on first measurement — noise that would have been silenced with an allowlist.
  const forwardsAnything = referencesParams(call, routerParamName, checker);
  const accepted: string[] = [];
  const positionalAccepted: string[] = [];
  let forwarded: string[] = [];

  /** The router key at the root of a forwarded value, if the value forwards one. */
  const sourceKeyOf = (expr: ts.Expression): string | undefined =>
    paramsSourceKey(expr, routerParamName, checker);

  if (!forwardsAnything) {
    shape = 'NOT-A-FORWARDING-SITE';
  } else if (objectArg) {
    shape = 'OBJECT-LITERAL';

    // Forwarded keys. An unnameable key (spread, computed) is an assertion-C failure, never a skip:
    // a spread could satisfy any obligation and the walk would have no way to know.
    // UNION across ternary arms — `projectRoot ? { projectRoot } : {}` (rbook-review.ts:299) is one
    // forwarding site with two literals. NAMED LIMIT, see the gate's false-negative profile: a key
    // forwarded on only ONE arm reads as forwarded, because this gate checks name flow, not value
    // flow, and an intersection would report a drop on a path the caller deliberately guards.
    for (const prop of objectArgLiterals.flatMap((l) => [...l.properties])) {
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name;
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
          forwarded.push(name.text);
          const src = ts.isPropertyAssignment(prop) ? sourceKeyOf(prop.initializer) : name.text; // shorthand `{ projectRoot }` — same name on both sides
          if (src) forwardedFrom[name.text] = src;
          continue;
        }
      }
      ctx.unclassifiable.push({
        ...refOf(prop, ctx.paths),
        what: `unnameable forwarded key in ${calleeName}`,
        detail: `property kind ${ts.SyntaxKind[prop.kind]} — a spread or computed key can satisfy any obligation, so the walk cannot report this call as complete.`,
      });
    }

    // Accepted keys: the type of the parameter this literal actually occupies.
    const acceptingParam = sig?.parameters[objectArgIndex];
    if (sig && !acceptingParam) {
      ctx.unclassifiable.push({
        ...ref,
        what: `no parameter at position ${objectArgIndex} of ${calleeName}`,
        detail:
          'an object literal is passed at a position the resolved signature does not declare (rest ' +
          'parameter or overload); the walk cannot say what it accepts, so it must not score it.',
      });
    }
    if (sig && acceptingParam) {
      const p0 = checker.getTypeOfSymbolAtLocation(acceptingParam, call);
      // A PRIMITIVE accepting parameter yields the whole of `String.prototype` as "accepted" —
      // a red set of `toString, charAt, charCodeAt, …` (build-time critic 1, #6). That is a shape
      // the walk cannot score, so it is REPORTED. A union or bare-generic parameter yields zero
      // properties instead and scores a vacuous zero — named as false-negative 10 rather than
      // reported, because zero-with-no-claim is not a false statement.
      const isPrimitive =
        (p0.getFlags() &
          (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !==
        0;
      if (isPrimitive) {
        ctx.unclassifiable.push({
          ...ref,
          what: `primitive accepting parameter on ${calleeName}`,
          detail: `parameter ${objectArgIndex} has type \`${checker.typeToString(p0)}\`, whose members are prototype methods rather than wire keys; the walk cannot say what this call accepts.`,
        });
      }
      // RULE 3, RECORDED. A key at parameter >= 1 never enters the parameter-0 property set, so it
      // used to leave NO trace anywhere — making "move it to parameter 1" the cheapest way to
      // silence this gate, with none of the @internal anti-abuse constraints applying and nothing
      // in the printed set to show for it. This mission itself used that move twice
      // (rbook-learnings-list.ts, rbook-mission-status.ts), so the hole was self-inflicted.
      sig.parameters.forEach((otherParam, i) => {
        if (i === objectArgIndex) return;
        const t = checker.getTypeOfSymbolAtLocation(otherParam, call);
        if ((t.getFlags() & ts.TypeFlags.Object) === 0) return;
        if (t.getCallSignatures().length > 0) return;
        // RULE 4 here too (s106-m03): a database client beside the literal is the same wiring
        // seam the positional branch excludes by name, not 28 of its members as caller keys.
        if (isInfrastructureType(t, checker)) {
          const e: ExcludedKey = {
            ...refOf(callee, ctx.paths),
            key: otherParam.getName(),
            rule: 'infrastructure-type',
            reason: `parameter type ${checker.typeToString(t)} is a wiring seam supplied by the enclosing scope, not a caller value`,
          };
          excluded.push(e);
          ctx.exclusions.push(e);
          return;
        }
        for (const propSym of t.getProperties()) {
          const e: ExcludedKey = {
            ...refOf(callee, ctx.paths),
            key: propSym.getName(),
            rule: 'outside-parameter-0',
            reason: `declared on parameter ${i} (${otherParam.getName()}) of ${calleeName}, not on the caller-facing parameter 0`,
          };
          excluded.push(e);
          ctx.exclusions.push(e);
        }
      });

      for (const propSym of isPrimitive ? [] : p0.getProperties()) {
        const rule = exclusionFor(propSym);
        if (rule) {
          const e: ExcludedKey = { ...refOf(callee, ctx.paths), key: propSym.getName(), ...rule };
          excluded.push(e);
          ctx.exclusions.push(e);
          continue;
        }
        accepted.push(propSym.getName());
      }
    }
  } else if (passThrough) {
    shape = 'PASS-THROUGH';
    // The whole params object goes over, so A is satisfied by identity — there is no key to drop.
    // But the EXCLUSION RULES still apply and the keys still reach assertion B: a pass-through
    // handler's parameter-0 type IS the tool's wire surface, and a widened one (rbook-message.ts's
    // `InternalRbookMessageParams extends RbookMessageParams`) can smuggle an unpublished, untagged
    // key past both. It did — `advertisedRoots` (build-time critic finding 6).
    if (sig && sig.parameters.length > 0) {
      const p0 = checker.getTypeOfSymbolAtLocation(sig.parameters[0], call);
      for (const propSym of p0.getProperties()) {
        const rule = exclusionFor(propSym);
        if (rule) {
          const e: ExcludedKey = { ...refOf(callee, ctx.paths), key: propSym.getName(), ...rule };
          excluded.push(e);
          ctx.exclusions.push(e);
          continue;
        }
        accepted.push(propSym.getName());
      }
      forwarded = accepted.slice();
      for (const k of accepted) forwardedFrom[k] = k;
      const calleeParamName = callee.parameters[0]?.name.getText();
      if (calleeParamName && callee.body) {
        const acceptedSet = new Set(accepted);
        for (const k of readParamKeys([callee.body], calleeParamName)) {
          if (acceptedSet.has(k)) calleeReadKeys.push(k);
        }
      }
    }
  } else if (positionalArgs.length > 0) {
    shape = 'POSITIONAL';
    if (sig) {
      const suppliedIdx = new Set<number>();
      call.arguments.forEach((a, i) => {
        const u = unwrap(a);
        const isUndefinedLiteral = ts.isIdentifier(u) && u.text === 'undefined';
        if (!isUndefinedLiteral) suppliedIdx.add(i);
      });
      sig.parameters.forEach((paramSym, i) => {
        const t = checker.getTypeOfSymbolAtLocation(paramSym, call);
        if (isInfrastructureType(t, checker)) {
          const e: ExcludedKey = {
            ...refOf(callee, ctx.paths),
            key: paramSym.getName(),
            rule: 'infrastructure-type',
            reason: `parameter type ${checker.typeToString(t)} is a wiring seam supplied by the enclosing scope, not a caller value`,
          };
          excluded.push(e);
          ctx.exclusions.push(e);
          return;
        }
        // The SAME three rules as everywhere else. Without this, `_getNow` is excluded at an
        // object-literal site and RED at a positional one — the printed "complete excluded set"
        // would be incomplete and the rule would not be one rule (build-time critic finding 7).
        const rule = exclusionFor(paramSym);
        if (rule) {
          const e: ExcludedKey = { ...refOf(callee, ctx.paths), key: paramSym.getName(), ...rule };
          excluded.push(e);
          ctx.exclusions.push(e);
          return;
        }
        positionalAccepted.push(paramSym.getName());
        if (suppliedIdx.has(i)) {
          forwarded.push(paramSym.getName());
          const src = sourceKeyOf(call.arguments[i]);
          if (src) forwardedFrom[paramSym.getName()] = src;
        }
      });
    }
  } else {
    shape = 'NOT-A-FORWARDING-SITE';
  }

  const forwardedSet = new Set(forwarded);
  const dropped =
    shape === 'OBJECT-LITERAL'
      ? accepted.filter((k) => !forwardedSet.has(k))
      : shape === 'POSITIONAL'
        ? positionalAccepted.filter((k) => !forwardedSet.has(k))
        : [];

  return {
    ...ref,
    callee: calleeName,
    shape,
    accepted,
    positionalAccepted,
    forwarded,
    calleeReadKeys,
    forwardedFrom,
    dropped,
    excluded,
    isSubRouter,
    depth,
  };
}

/** Collect the delegated calls inside one branch body, recursing ONE level into sub-routers. */
function walkBranch(
  body: ts.Node,
  routerParamName: string,
  depth: number,
  ctx: Ctx
): DelegatedCall[] {
  const out: DelegatedCall[] = [];
  for (const call of callsIn(body)) {
    const sig = ctx.checker.getResolvedSignature(call);
    const callee = declarationOf(call, ctx.checker, ctx.paths);

    if (!callee) {
      // `declarationOf` resolves function declarations, methods, arrows and function-valued
      // variables. A handler reached any OTHER way — an object property, a dispatch table, a
      // re-export whose initializer is a factory call — resolves to nothing. If such a call
      // nonetheless returns a RbookToolResult from src/, the walk cannot say what it accepts, which
      // is assertion C's exact trigger. Dropping it silently was a real hole (critic finding 3).
      const declFile = sig?.declaration?.getSourceFile().fileName;
      if (
        sig &&
        declFile &&
        isUnderSrc(declFile, ctx.paths) &&
        returnsRbookToolResult(sig, ctx.checker)
      ) {
        ctx.unclassifiable.push({
          ...refOf(call, ctx.paths),
          what: `unresolvable callee ${call.expression.getText()}`,
          detail:
            'the call returns a RbookToolResult from src/ but its declaration could not be resolved ' +
            'to a function-like node, so the walk cannot enumerate what it accepts.',
        });
        continue;
      }
      continue; // genuinely out of tree (lib / node_modules) — never a forwarding site
    }

    // A call that returns no RbookToolResult is not a handler at all — a string helper, a logger,
    // a date format. Recorded and printed, never scored.
    if (!sig || !returnsRbookToolResult(sig, ctx.checker)) {
      ctx.nonDelegatingCalls.push({ ...refOf(call, ctx.paths), callee: call.expression.getText() });
      continue;
    }

    // A higher-order combinator (withClientValidated / withClientAsync) is not a delegated handler.
    // Its callback body is lexically inside the enclosing function and is already walked.
    if (isCombinator(sig, ctx.checker, call)) {
      ctx.nonDelegatingCalls.push({ ...refOf(call, ctx.paths), callee: call.expression.getText() });
      continue;
    }

    const classified = classifyCall(call, callee, routerParamName, depth, ctx);
    out.push(classified);

    if (!classified.isSubRouter) continue;
    if (depth >= 2) {
      // A third-level router is out of the walk's stated reach. FAIL rather than under-report.
      ctx.unclassifiable.push({
        ...refOf(call, ctx.paths),
        what: `third-level sub-router ${classified.callee}`,
        detail:
          'the walk recurses ONE level into sub-routers; a third level would be walked with an ' +
          'un-derived params name, so it is reported rather than silently truncated.',
      });
      continue;
    }
    const subSwitch = findActionSwitch(callee, ctx.checker);
    const subParamName = callee.parameters[0]?.name.getText() ?? routerParamName;
    if (subSwitch) {
      for (const clause of subSwitch.caseBlock.clauses) {
        for (const stmt of clause.statements) {
          out.push(...walkBranch(stmt, subParamName, depth + 1, ctx));
        }
      }
    }
  }
  return out;
}

interface DispatchEntry {
  readonly call: ts.CallExpression;
  readonly callee: ts.FunctionLikeDeclaration;
  readonly clause: ts.CaseClause;
  readonly paramsName: string;
  readonly paramsDeclaration: ts.Identifier;
}

/**
 * Read the exported literal that owns the dispatcher preflight's scope. A missing, hidden,
 * computed, empty, duplicate, or non-string declaration is not an empty scope — it is a fact the
 * walk cannot establish, so assertion C must fail it loudly.
 */
function readPreflightParams(sf: ts.SourceFile, ctx: Ctx): string[] {
  const declarations: Array<{
    statement: ts.VariableStatement;
    declaration: ts.VariableDeclaration;
  }> = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'PREFLIGHT_PARAMS') {
        declarations.push({ statement, declaration });
      }
    }
  }

  const fail = (node: ts.Node, detail: string): string[] => {
    ctx.unclassifiable.push({
      ...refOf(node, ctx.paths),
      what: 'pre-dispatch PREFLIGHT_PARAMS is not an exported non-empty string-literal tuple',
      detail,
    });
    return [];
  };

  if (declarations.length === 0) {
    return fail(
      sf,
      'src/index.ts must export exactly one literal `PREFLIGHT_PARAMS = [...] as const`; no declaration was found.'
    );
  }
  if (declarations.length !== 1) {
    return fail(
      declarations[0].declaration,
      `found ${declarations.length} declarations; the guard scope must have one source of truth.`
    );
  }

  const { statement, declaration } = declarations[0];
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    return fail(declaration, 'PREFLIGHT_PARAMS must be declared with const.');
  }
  const exported = statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
  if (!exported) {
    return fail(
      declaration,
      'PREFLIGHT_PARAMS exists but is not exported, so the standing gate cannot share the shipped scope.'
    );
  }
  if (!declaration.initializer) {
    return fail(declaration, 'PREFLIGHT_PARAMS has no initializer.');
  }

  const initializer = unwrap(declaration.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) {
    return fail(
      declaration.initializer,
      'PREFLIGHT_PARAMS must be an inline array literal; computed values make the scope unauditable.'
    );
  }
  if (initializer.elements.length === 0) {
    return fail(initializer, 'PREFLIGHT_PARAMS must not be empty.');
  }

  const values: string[] = [];
  for (const element of initializer.elements) {
    if (!ts.isStringLiteralLike(element)) {
      return fail(element, 'every PREFLIGHT_PARAMS member must be a string literal.');
    }
    if (element.text.length === 0) {
      return fail(element, 'PREFLIGHT_PARAMS members must not be empty strings.');
    }
    values.push(element.text);
  }
  if (new Set(values).size !== values.length) {
    return fail(initializer, 'PREFLIGHT_PARAMS contains duplicate members.');
  }
  return values;
}

function enumStringsOf(schemaProperty: unknown): string[] {
  if (!schemaProperty || typeof schemaProperty !== 'object') return [];
  const enumValue = (schemaProperty as { enum?: unknown }).enum;
  return Array.isArray(enumValue)
    ? enumValue.filter((value): value is string => typeof value === 'string')
    : [];
}

/** Strip wrappers that have no runtime effect on a value. Unlike `unwrap`, do not erase `await`. */
function unwrapStatic(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isSatisfiesExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** Walk outward through wrappers that have no runtime effect on a value. */
function outerStatic(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (
      (ts.isSatisfiesExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
    } else {
      return current;
    }
  }
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * The matched entry call is the end of the pre-dispatch boundary, but only for forwarding itself.
 * A nested computation such as `entry(normalize(params))` still executes before entry and must not
 * inherit a blanket exemption merely because it is lexically inside the call.
 */
function isDirectEntryParamsForward(node: ts.Node, entry: DispatchEntry): boolean {
  if (!ts.isIdentifier(node)) return false;
  const value = outerStatic(node);
  if (entry.call.arguments.some((argument) => argument === value)) return true;

  if (!ts.isSpreadAssignment(value.parent) || value.parent.expression !== value) return false;
  const object = value.parent.parent;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const objectArgument = outerStatic(object);
  return entry.call.arguments.some((argument) => argument === objectArgument);
}

function preDispatchMutationKind(
  read: ts.Expression
): 'assignment' | 'update' | 'delete' | undefined {
  let value: ts.Node = outerStatic(read);
  let parent = value.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === value &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return 'assignment';
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === value &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return 'update';
  }
  if (ts.isDeleteExpression(parent) && parent.expression === value) return 'delete';

  // Follow an assignment-pattern target outward: `({ action: params.action } = source)`,
  // `[params.action] = source`, and their rest forms all write the same field as a simple `=`.
  for (;;) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === value) {
      value = parent;
    } else if (
      (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) &&
      parent.expression === value
    ) {
      value = parent;
    } else if (
      ts.isObjectLiteralExpression(parent) &&
      parent.properties.some((property) => property === value)
    ) {
      value = outerStatic(parent);
    } else if (
      ts.isArrayLiteralExpression(parent) &&
      parent.elements.some((element) => element === value)
    ) {
      value = outerStatic(parent);
    } else {
      break;
    }
    parent = value.parent;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === value &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return 'assignment';
  }
  if (
    (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
    parent.initializer === value
  ) {
    return 'assignment';
  }
  return undefined;
}

function isEntryParamsIdentifier(
  node: ts.Node,
  entry: DispatchEntry,
  checker: ts.TypeChecker
): boolean {
  const declarationSymbol = checker.getSymbolAtLocation(entry.paramsDeclaration);
  return (
    declarationSymbol !== undefined &&
    ts.isIdentifier(node) &&
    node.text === entry.paramsName &&
    checker.getSymbolAtLocation(node) === declarationSymbol
  );
}

function entryParamKeyOf(
  expression: ts.Expression,
  entry: DispatchEntry,
  checker: ts.TypeChecker
): string | undefined {
  const value = unwrapStatic(expression);
  if (
    ts.isPropertyAccessExpression(value) &&
    isEntryParamsIdentifier(value.expression, entry, checker)
  ) {
    return value.name.text;
  }
  if (
    ts.isElementAccessExpression(value) &&
    isEntryParamsIdentifier(value.expression, entry, checker) &&
    value.argumentExpression &&
    ts.isStringLiteralLike(value.argumentExpression)
  ) {
    return value.argumentExpression.text;
  }
  return undefined;
}

function strictComparisonProof(
  condition: ts.Expression,
  key: string,
  entry: DispatchEntry,
  checker: ts.TypeChecker,
  enumValues: readonly string[]
): { readonly operator: ts.SyntaxKind } | undefined {
  const value = unwrapStatic(condition);
  if (
    !ts.isBinaryExpression(value) ||
    (value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return undefined;
  }

  const left = unwrapStatic(value.left);
  const right = unwrapStatic(value.right);
  const matches = (read: ts.Expression, literal: ts.Expression): boolean =>
    entryParamKeyOf(read, entry, checker) === key &&
    ts.isStringLiteralLike(literal) &&
    enumValues.includes(literal.text);
  if (!matches(left, right) && !matches(right, left)) return undefined;
  return { operator: value.operatorToken.kind };
}

function typeofStringProof(
  condition: ts.Expression,
  key: string,
  entry: DispatchEntry,
  checker: ts.TypeChecker
): { readonly operator: ts.SyntaxKind } | undefined {
  const value = unwrapStatic(condition);
  if (
    !ts.isBinaryExpression(value) ||
    (value.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return undefined;
  }

  const left = unwrapStatic(value.left);
  const right = unwrapStatic(value.right);
  const matches = (typeQuery: ts.Expression, literal: ts.Expression): boolean =>
    ts.isTypeOfExpression(typeQuery) &&
    entryParamKeyOf(typeQuery.expression, entry, checker) === key &&
    ts.isStringLiteralLike(literal) &&
    literal.text === 'string';
  if (!matches(left, right) && !matches(right, left)) return undefined;
  return { operator: value.operatorToken.kind };
}

/** Whether this truth arm proves the raw wire value is a string without trusting static types. */
function conditionProvesString(
  condition: ts.Expression,
  whenTrue: boolean,
  key: string,
  entry: DispatchEntry,
  checker: ts.TypeChecker,
  enumValues: readonly string[]
): boolean {
  const value = unwrapStatic(condition);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    return conditionProvesString(value.operand, !whenTrue, key, entry, checker, enumValues);
  }

  const proof =
    strictComparisonProof(value, key, entry, checker, enumValues) ??
    typeofStringProof(value, key, entry, checker);
  if (!proof) return false;
  return proof.operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? whenTrue : !whenTrue;
}

/** A case arm is safe only when every clause that can fall through to it proves an enum string. */
function isSafeEnumSwitchArm(
  read: ts.Expression,
  key: string,
  entry: DispatchEntry,
  checker: ts.TypeChecker,
  enumValues: readonly string[]
): boolean {
  let clause: ts.CaseOrDefaultClause | undefined;
  for (let current: ts.Node | undefined = read.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
    if (ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      clause = current;
      break;
    }
    if (current === entry.clause) return false;
  }
  if (!clause || !ts.isCaseClause(clause)) return false;
  const caseBlock = clause.parent;
  if (!ts.isCaseBlock(caseBlock)) return false;
  const statement = caseBlock.parent;
  if (
    !ts.isSwitchStatement(statement) ||
    entryParamKeyOf(statement.expression, entry, checker) !== key
  ) {
    return false;
  }

  const target = caseBlock.clauses.indexOf(clause);
  return caseBlock.clauses.slice(0, target + 1).every((candidate) => {
    if (!ts.isCaseClause(candidate)) return false;
    const expression = unwrapStatic(candidate.expression);
    return ts.isStringLiteralLike(expression) && enumValues.includes(expression.text);
  });
}

/** A string enum read is safe only when runtime syntax proves the discriminator is a string. */
function isSafeEnumDiscriminantRead(
  read: ts.Expression,
  key: string,
  schemaProperty: unknown,
  entry: DispatchEntry,
  checker: ts.TypeChecker
): boolean {
  const enumValues = enumStringsOf(schemaProperty);
  if (enumValues.length === 0) return false;

  const outer = outerStatic(read);
  const parent = outer.parent;
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    const other =
      parent.left === outer ? parent.right : parent.right === outer ? parent.left : undefined;
    if (other) {
      const unwrapped = unwrapStatic(other);
      if (ts.isStringLiteralLike(unwrapped) && enumValues.includes(unwrapped.text)) return true;
    }
  }

  if (ts.isTypeOfExpression(parent) && parent.expression === outer) return true;
  if (ts.isSwitchStatement(parent) && parent.expression === outer) return true;

  for (let current: ts.Node | undefined = read.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
    if (ts.isIfStatement(current)) {
      if (
        isWithin(read, current.thenStatement) &&
        conditionProvesString(current.expression, true, key, entry, checker, enumValues)
      ) {
        return true;
      }
      if (
        current.elseStatement &&
        isWithin(read, current.elseStatement) &&
        conditionProvesString(current.expression, false, key, entry, checker, enumValues)
      ) {
        return true;
      }
    } else if (ts.isConditionalExpression(current)) {
      if (
        isWithin(read, current.whenTrue) &&
        conditionProvesString(current.condition, true, key, entry, checker, enumValues)
      ) {
        return true;
      }
      if (
        isWithin(read, current.whenFalse) &&
        conditionProvesString(current.condition, false, key, entry, checker, enumValues)
      ) {
        return true;
      }
    }
    if (current === entry.clause) break;
  }

  return isSafeEnumSwitchArm(read, key, entry, checker, enumValues);
}

function schemaTypeOf(schemaProperty: unknown): unknown {
  return schemaProperty && typeof schemaProperty === 'object'
    ? (schemaProperty as { type?: unknown }).type
    : undefined;
}

/**
 * Read raw dispatcher params accesses up to and including the matched entry call. Reads after the
 * entry call belong to response formatting, not the pre-dispatch boundary. Dynamic element access
 * is reported to C instead of disappearing from a name-based set.
 */
function readPreDispatchReads(
  entry: DispatchEntry,
  schemaProperties: Record<string, unknown>,
  ctx: Ctx
): PreDispatchRead[] {
  const reads: PreDispatchRead[] = [];
  const cutoff = entry.call.getEnd();
  const sf = entry.clause.getSourceFile();

  const record = (node: ts.Expression, key: string): void => {
    const schemaProperty = schemaProperties[key];
    const mutationKind = preDispatchMutationKind(node);
    if (mutationKind) {
      ctx.unclassifiable.push({
        ...refOf(node, ctx.paths),
        what: `pre-dispatch params field mutation for ${entry.clause.expression.getText()}`,
        detail:
          `${mutationKind} of params.${key} invalidates any earlier runtime string proof; ` +
          'the gate does not model mutable field flow, so the write must be removed or explicitly modeled.',
      });
    }
    let classification: PreDispatchReadClassification;
    let reason: string;
    if (schemaTypeOf(schemaProperty) !== 'string') {
      classification = 'non-string-schema';
      reason = 'the published top-level schema does not declare this key as type:string';
    } else if (isSafeEnumDiscriminantRead(node, key, schemaProperty, entry, ctx.checker)) {
      classification = 'safe-enum-discriminant';
      reason =
        'a published string enum is protected by a runtime strict comparison, typeof guard, or switch case';
    } else {
      classification = 'requires-preflight';
      reason =
        'published type:string read before entry without a demonstrated runtime narrowing rule';
    }
    reads.push({ ...refOf(node, ctx.paths), key, classification, reason });
  };

  const visit = (node: ts.Node): void => {
    if (node.getStart(sf) > cutoff) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      isEntryParamsIdentifier(node.expression, entry, ctx.checker)
    ) {
      record(node, node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isEntryParamsIdentifier(node.expression, entry, ctx.checker)
    ) {
      const argument = node.argumentExpression;
      if (argument && ts.isStringLiteralLike(argument)) {
        record(node, argument.text);
      } else {
        ctx.unclassifiable.push({
          ...refOf(node, ctx.paths),
          what: `dynamic pre-dispatch params access for ${entry.clause.expression.getText()}`,
          detail:
            'the dispatcher reads params through a non-literal element key before entry; the walk cannot map it to a published schema property.',
        });
      }
    } else if (
      isEntryParamsIdentifier(node, entry, ctx.checker) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) &&
      !isDirectEntryParamsForward(node, entry)
    ) {
      ctx.unclassifiable.push({
        ...refOf(node, ctx.paths),
        what: `unsupported pre-dispatch params value flow for ${entry.clause.expression.getText()}`,
        detail:
          'the dispatcher aliases, destructures, spreads, or otherwise passes the whole params value before entry; the walk follows only direct literal-key reads, so this value flow must be made explicit or taught to the gate.',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.clause);
  return reads;
}

/**
 * Read the REAL tool→entry-function map out of the `executeMissionProtocolTool` switch in
 * src/index.ts. Deriving it (rather than configuring it here) is what makes a newly-registered
 * tool with no dispatch case an assertion-C failure instead of an invisible gap.
 */
function readDispatchMap(
  program: ts.Program,
  ctx: Ctx
): { entries: Map<string, DispatchEntry>; preflightParams: string[] } {
  const map = new Map<string, DispatchEntry>();
  const sf = program.getSourceFile(ctx.paths.indexTs);
  if (!sf) {
    ctx.unclassifiable.push({
      file: path.relative(ctx.paths.repoRoot, ctx.paths.indexTs),
      line: 0,
      what: 'dispatch source file missing from the program',
      detail: `${ctx.paths.indexTs} is not in the ts.Program; the tool→entry map cannot be derived.`,
    });
    return { entries: map, preflightParams: [] };
  }

  const preflightParams = readPreflightParams(sf, ctx);

  let dispatchFn: ts.FunctionLikeDeclaration | undefined;
  const findFn = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText() === DISPATCH_FN) dispatchFn = node;
    ts.forEachChild(node, findFn);
  };
  ts.forEachChild(sf, findFn);
  if (!dispatchFn) {
    ctx.unclassifiable.push({
      file: path.relative(ctx.paths.repoRoot, ctx.paths.indexTs),
      line: 0,
      what: `${DISPATCH_FN} not found`,
      detail: 'the MCP dispatch function was renamed or moved; the derived map is unavailable.',
    });
    return { entries: map, preflightParams };
  }

  const sw = findToolNameSwitch(dispatchFn);
  if (!sw) return { entries: map, preflightParams };

  for (const clause of sw.caseBlock.clauses) {
    if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) continue;
    const toolName = clause.expression.text;

    // RULE, TWO PARTS. (1) Candidate entry calls are the initializers of `result` bindings in the
    // case body. (2) The entry is the candidate whose parameter-0 type ACCEPTS the case's own
    // `args as Rbook…Params` cast type.
    //
    // Part (2) is not decoration. rbook_message's case has an EARLY-RETURN `whoami` branch with its
    // own `result` binding (`getWhoamiDiagnostics({explicitProjectRoot, mcpRoots})`) BEFORE the
    // main `rbookMessage` call, so "first result binding" silently walks the wrong function and
    // reports rbook_message's dispatch shape and accepted keys off a diagnostics helper. Assignability
    // rather than name equality, because rbook_agent_onboard's handler widens the cast type
    // (`InternalRbookAgentOnboardParams extends RbookAgentOnboardParams`).
    let castType: ts.Type | undefined;
    let paramsName: string | undefined;
    let paramsDeclaration: ts.Identifier | undefined;
    const findCast = (n: ts.Node): void => {
      if (castType) return;
      if (ts.isVariableDeclaration(n) && n.name.getText() === 'params' && n.initializer) {
        const init = n.initializer;
        if (ts.isAsExpression(init)) {
          castType = ctx.checker.getTypeFromTypeNode(init.type);
          if (ts.isIdentifier(n.name)) {
            paramsName = n.name.text;
            paramsDeclaration = n.name;
          }
        }
      }
      ts.forEachChild(n, findCast);
    };
    ts.forEachChild(clause, findCast);

    const candidates: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === 'result' && n.initializer) {
        const init = unwrap(n.initializer);
        if (ts.isCallExpression(init)) candidates.push(init);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(clause, visit);
    if (candidates.length === 0) continue; // non-tool cases exist in this switch

    const matches = candidates.filter((call) => {
      const sig = ctx.checker.getResolvedSignature(call);
      if (!sig || sig.parameters.length === 0) return false;
      if (!castType) return true;
      const p0 = ctx.checker.getTypeOfSymbolAtLocation(sig.parameters[0], call);
      return ctx.checker.isTypeAssignableTo(castType, p0);
    });

    if (matches.length !== 1) {
      ctx.unclassifiable.push({
        ...refOf(clause, ctx.paths),
        what: `ambiguous entry function for ${toolName}`,
        detail: `${candidates.length} \`result\` call(s) in the case body, ${matches.length} of which accept the case's cast type — the walk cannot name the entry, so it must not report this tool as classified.`,
      });
      continue;
    }

    const entryCall = matches[0];
    const callee = declarationOf(entryCall, ctx.checker, ctx.paths);
    if (!callee) continue;
    if (!paramsName || !paramsDeclaration) {
      ctx.unclassifiable.push({
        ...refOf(clause, ctx.paths),
        what: `pre-dispatch params binding unavailable for ${toolName}`,
        detail:
          'the case entry cast did not bind an identifier the pre-dispatch read arm can follow.',
      });
      continue;
    }
    map.set(toolName, { call: entryCall, callee, clause, paramsName, paramsDeclaration });
  }
  return { entries: map, preflightParams };
}

/** Top-level property names on a tool definition's published JSON inputSchema. */
function inputSchemaTopLevelKeys(tool: {
  inputSchema?: { properties?: Record<string, unknown> };
}): string[] {
  return Object.keys(tool.inputSchema?.properties ?? {});
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface WalkOptions {
  /** Registered tool definitions — the ONLY oracle. Deprecated standalone defs are not a surface. */
  readonly toolDefinitions: ReadonlyArray<{
    name: string;
    inputSchema?: { properties?: Record<string, unknown> };
  }>;
  /**
   * Repo root to walk. Defaults to this repo. The gate overrides it with a SYNTHETIC fixture tree
   * to demonstrate that assertion C actually fires on each unclassifiable shape — a no-silent-skip
   * guarantee that is asserted but never demonstrated is exactly the false assurance this sprint
   * exists to close.
   */
  readonly projectRoot?: string;
}

/**
 * Walk every registered tool and return the full model. Pure: no assertions, no printing — the
 * gate turns `unclassifiable` into failures and the probe script prints the model.
 */
export function walkRouterParams(opts: WalkOptions): WalkResult {
  const repoRoot = opts.projectRoot ?? DEFAULT_REPO_ROOT;
  const paths: Paths = {
    repoRoot,
    srcDir: path.join(repoRoot, 'src'),
    indexTs: path.join(repoRoot, 'src', 'index.ts'),
  };
  const started = Date.now();
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (p) => fs.readFileSync(p, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, repoRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const programBuildMs = Date.now() - started;

  const ctx: Ctx = {
    checker,
    paths,
    unclassifiable: [],
    exclusions: [],
    nonDelegatingCalls: [],
  };

  const dispatch = readDispatchMap(program, ctx);
  const tools: ToolModel[] = [];

  for (const def of opts.toolDefinitions) {
    const entry = dispatch.entries.get(def.name);
    if (!entry) {
      ctx.unclassifiable.push({
        file: path.relative(paths.repoRoot, paths.indexTs),
        line: 0,
        what: `no dispatch case for registered tool ${def.name}`,
        detail: `${def.name} is in RBOOK_TOOL_DEFINITIONS but ${DISPATCH_FN} has no case binding a \`result\` call for it. The walk cannot classify its dispatch, so it must not report it as covered.`,
      });
      continue;
    }

    const { callee } = entry;
    const preDispatchReads = readPreDispatchReads(entry, def.inputSchema?.properties ?? {}, ctx);
    const routerParamName = callee.parameters[0]?.name.getText() ?? 'params';
    const entryRef = { ...refOf(callee, paths), fn: def.name };
    // The SAME three exclusion rules apply here as at a delegated call. Without this a MONOLITHIC
    // tool's internal seams (rbook_agent_onboard's `advertisedRoots`/`callerProvidedProjectRoot`,
    // which only src/index.ts can supply) would read as unpublished surface obligations.
    const entryParamKeys = (() => {
      const p0 = callee.parameters[0];
      if (!p0) return [];
      const out: string[] = [];
      for (const propSym of checker.getTypeAtLocation(p0).getProperties()) {
        const rule = exclusionFor(propSym);
        if (rule) {
          ctx.exclusions.push({ ...refOf(callee, paths), key: propSym.getName(), ...rule });
          continue;
        }
        out.push(propSym.getName());
      }
      return out;
    })();

    const allActionSwitches = findActionSwitches(callee, checker);
    if (allActionSwitches.length > 1) {
      ctx.unclassifiable.push({
        ...refOf(callee, paths),
        what: `ambiguous dispatch in ${def.name}`,
        detail: `${allActionSwitches.length} top-level params-discriminated string switches at ${allActionSwitches.map((sw) => refOf(sw, paths).line).join(', ')}; the walk cannot say which is the action dispatch.`,
      });
    }
    const actionSwitch = findActionSwitch(callee, checker);
    const branches: Branch[] = [];
    let shape: DispatchShape;
    let shapeReason: string;
    const insideSwitch = new Set(
      actionSwitch ? readParamKeys([actionSwitch], routerParamName) : []
    );
    const routerScopeReadKeys = callee.body
      ? readParamKeys([callee.body], routerParamName).filter((k) => !insideSwitch.has(k))
      : [];

    if (actionSwitch) {
      shape = 'SWITCH-ROUTER';
      shapeReason = `action switch at ${refOf(actionSwitch, paths).file}:${refOf(actionSwitch, paths).line}`;
      for (const clause of actionSwitch.caseBlock.clauses) {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) continue;
        const calls: DelegatedCall[] = [];
        for (const stmt of clause.statements) {
          calls.push(...walkBranch(stmt, routerParamName, 1, ctx));
        }
        branches.push({
          action: clause.expression.text,
          calls,
          readKeys: readParamKeys(clause.statements, routerParamName),
        });
      }
    } else {
      shape = 'MONOLITHIC';
      // The computed reason is PRINTED, and assertion A is vacuous here BY CONSTRUCTION — which is
      // exactly why assertion B must still cover these tools. Never a skip.
      shapeReason = `no action switch in the entry function at ${entryRef.file}:${entryRef.line}; any action is handled inline against the received params`;
      const calls = callee.body ? walkBranch(callee.body, routerParamName, 1, ctx) : [];
      branches.push({
        action: '(monolithic)',
        calls,
        readKeys: callee.body ? readParamKeys([callee.body], routerParamName) : [],
      });
    }

    tools.push({
      tool: def.name,
      entry: entryRef,
      shape,
      shapeReason,
      inputSchemaKeys: inputSchemaTopLevelKeys(def),
      entryParamKeys,
      routerScopeReadKeys,
      preDispatchReads,
      branches,
    });
  }

  return {
    tools,
    preflightParams: dispatch.preflightParams,
    unclassifiable: ctx.unclassifiable,
    exclusions: ctx.exclusions,
    nonDelegatingCalls: ctx.nonDelegatingCalls,
    programFileCount: program.getSourceFiles().filter((f) => isUnderSrc(f.fileName, paths)).length,
    programBuildMs,
  };
}

/** One handler-accepted key and, if the router renames on the way through, where it came from. */
export interface SurfaceKey {
  readonly key: string;
  /** The router key this was forwarded from — `searchLimit` for a handler's `limit`. */
  readonly from?: string;
}

/**
 * Assertion B's accepted-key oracle for one tool.
 *
 * SCOPED BY RULE, pre-committed so nothing is adjudicated at gate-run time:
 *
 *   • SWITCH-ROUTER  → the union of every OBJECT-LITERAL **and PASS-THROUGH** delegated handler's
 *     accepted keys. Those are the sets whose members are wire KEYS. This is what makes B red on
 *     the reachability gaps: `RbookSessionCaptureParams` accepts `expiresAt` while rbook_session's
 *     inputSchema did not declare it. PASS-THROUGH was added after a build-time critic showed its
 *     omission left rbook_auth and rbook_message with an EMPTY B oracle — 2 of 15 tools with no
 *     effective coverage from either assertion, which is how `advertisedRoots` stayed unpublished,
 *     untagged and green on rbook_message while its twin on rbook_agent_onboard had to carry a tag.
 *
 *   • MONOLITHIC     → the entry function's own parameter-0 keys, since there is no delegate.
 *     Assertion A is vacuous for these tools by construction, so B is their only coverage.
 *
 *   • POSITIONAL callees contribute NOTHING to B — deliberately. A positional parameter's name is
 *     a local of the callee (`reaffirmConstraint(client, id, evergreen)` → `id`), not a published
 *     key; the published key is `constraintId`. Treating `id` as a surface obligation would make B
 *     red on a name that was never a wire contract. Those callees are still fully covered by
 *     assertion A, which checks SUPPLY rather than naming.
 *
 *   • RENAMES ARE NOT GAPS. A router may rename on the way through — rbook_context forwards
 *     `limit: params.searchLimit` and `types: params.searchTypes`. The handler key `limit` is not
 *     on the inputSchema and never should be; `searchLimit` is. So B is satisfied when EITHER the
 *     accepted key OR the router key it was forwarded from is declared. Requiring the handler's
 *     own name would demand publishing an internal name — a lie in the opposite direction.
 */
export function surfaceAcceptedKeys(model: ToolModel): SurfaceKey[] {
  if (model.shape === 'MONOLITHIC') return model.entryParamKeys.map((key) => ({ key }));
  const keys = new Map<string, SurfaceKey>();
  for (const branch of model.branches) {
    for (const call of branch.calls) {
      // OBJECT-LITERAL and PASS-THROUGH both name wire KEYS. Excluding PASS-THROUGH left rbook_auth
      // and rbook_message with an EMPTY B oracle — 2 of 15 tools with no effective A or B coverage,
      // which is how `advertisedRoots` stayed unpublished, untagged and green (critic finding 6).
      if (call.shape !== 'OBJECT-LITERAL' && call.shape !== 'PASS-THROUGH') continue;
      for (const k of call.accepted) {
        const from = call.forwardedFrom[k];
        const existing = keys.get(k);
        // Prefer an entry that records a source key: one branch may forward `limit` from
        // `searchLimit` while another drops it entirely.
        if (!existing || (from && !existing.from))
          keys.set(k, from ? { key: k, from } : { key: k });
      }
    }
  }
  return [...keys.values()];
}

/**
 * What one action branch demonstrably does with each of the router's own keys — s86-m04's
 * applicability oracle, living beside the walk that computes it so the gate and the codegen
 * (`npm run probe:action-params`) cannot disagree about what "applies" means.
 */
export interface ActionEvidence {
  /** Router keys handed to a handler that DECLARES the receiving key. The strong arm. */
  readonly forwarded: readonly string[];
  /** Router keys the branch reads but forwards to nobody — a routing predicate. The weak arm. */
  readonly read: readonly string[];
  /** Keys the router consumes outside the switch, so they apply to every action. */
  readonly routerScope: readonly string[];
}

/**
 * Per-action evidence for a SWITCH-ROUTER tool, keyed by action.
 *
 * FORWARDED requires BOTH halves of "forwarded by its branch AND accepted by its handler": the
 * router key must be the source of some value in the delegated call AND the receiving key must be
 * one the callee declares. Checking only the first half would score
 * `someHandler({ notAParam: params.x })` as evidence for `x`.
 *
 * MONOLITHIC tools return an EMPTY map on purpose. rbook_feedback is action-bearing but dispatches
 * with inline `if (action === '…')` blocks, so no per-action branch exists to read evidence from;
 * inventing an if-chain dispatch shape here to serve one tool would put a second, differently-
 * derived notion of "branch" in the tree. The gate names the fallback and records the false
 * negative rather than pretending the evidence exists.
 */
export function actionEvidence(model: ToolModel): Map<string, ActionEvidence> {
  const out = new Map<string, ActionEvidence>();
  if (model.shape !== 'SWITCH-ROUTER') return out;
  const routerScope = new Set(model.routerScopeReadKeys);
  for (const branch of model.branches) {
    const forwarded = new Set<string>();
    for (const call of branch.calls) {
      if (call.shape === 'PASS-THROUGH') {
        // The whole object goes over, so `forwardedFrom` names every accepted key and proves
        // nothing about applicability. The callee's own reads are the honest answer.
        for (const k of call.calleeReadKeys) forwarded.add(k);
        continue;
      }
      const declares = new Set([...call.accepted, ...call.positionalAccepted]);
      for (const [handlerKey, routerKey] of Object.entries(call.forwardedFrom)) {
        if (declares.has(handlerKey)) forwarded.add(routerKey);
      }
    }
    out.set(branch.action, {
      forwarded: [...forwarded].filter((k) => !routerScope.has(k)),
      read: branch.readKeys.filter((k) => !forwarded.has(k) && !routerScope.has(k)),
      routerScope: [...routerScope],
    });
  }
  return out;
}

/** B's red set for one tool: accepted keys that neither they nor their source key publish. */
export function undeclaredSurfaceKeys(model: ToolModel): SurfaceKey[] {
  const declared = new Set(model.inputSchemaKeys);
  return surfaceAcceptedKeys(model).filter(
    (s) => !declared.has(s.key) && !(s.from && declared.has(s.from))
  );
}

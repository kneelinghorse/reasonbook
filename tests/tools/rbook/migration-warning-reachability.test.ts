// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-derives calls to MigrationResult-compatible exports in the two declared migration roots.
// ABOUTME: Reachable answers must deliver warnings; carrier-less residuals are named with reasons.

import { describe, expect, it } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const MIGRATIONS_FILE = path.join(SRC_ROOT, 'tools/rbook/schema-migrations.ts');
const PRODUCER_FILES = [
  MIGRATIONS_FILE,
  path.join(SRC_ROOT, 'tools/rbook/record-link-migration.ts'),
];

/**
 * Reproduce with:
 *   npx jest tests/tools/rbook/migration-warning-reachability.test.ts --runInBand --coverage=false
 *
 * Scope is deliberately the exported MigrationResult-compatible helpers declared in
 * schema-migrations.ts and record-link-migration.ts and their shipped src/ callers. It is not a claim about every producer
 * in the repository (for example, project-identity.ts also exports a MigrationResult producer).
 * Fresh pre-fix RED: 21 producers / 48 calls / 11 consumed / 30 reachable / 7 carrier-less.
 * Fixed contract: 21 producers / 48 calls / 36 direct answer boundaries / 5 verified forwarding
 * carriers / 7 named carrier-less residuals.
 *
 * Unlike the original owner-level `.warnings` census, this gate correlates each producer read
 * with the exact warning sink carried through the handler's single post-callback return. Four
 * deliberately shared helpers are checked through their result/mutable-sink forwarding chains.
 * False-negative profile: this proves static symbol/sink routes, not that arbitrary code never
 * clears or rewrites warning contents. It does not cover migration producers outside the two
 * declared roots, dynamic dispatch, or formatter behavior; real rendered-warning fixtures are
 * the explicit complement. Adding a producer root requires an audited denominator change.
 * The paired real-SQLite gate pins representative post-migration error answers:
 *   npx jest tests/tools/rbook/migration-warning-store-compat.test.ts --runInBand --coverage=false
 */

interface MigrationCallSite {
  readonly file: string;
  readonly line: number;
  readonly producer: string;
  readonly owner: string;
  readonly call: ts.CallExpression;
}

interface ResidualReason {
  readonly key: string;
  readonly call: string;
  readonly reason: string;
}

interface ForwardingCarrier {
  readonly key: string;
  readonly reason: string;
}

const EXPECTED_PRODUCERS = [
  'ensureAgentFeedbackTable',
  'ensureArchivalColumns',
  // s96-m02: author_name on the logged tables, under its own marker.
  'ensureAuthorNameColumns',
  'ensureAuthorNamespaceColumns',
  'ensureColumnWithCheck',
  'ensureConstraintEvergreen',
  'ensureConstraintReviewTimestamp',
  'ensureConstraintsTable',
  'ensureContentPrunedColumn',
  // s93-m06: the approval columns, run only when a draft is recorded; it reaches attachWarnings.
  'ensureDecisionApprovalColumns',
  'ensureDecisionShapeColumns',
  'ensureDecisionsFts5',
  'ensureFirehoseEventColumns',
  // s92-m03: the implicit-session columns; every call runs at an answer boundary.
  'ensureImplicitSessionColumns',
  'ensureLearningsTable',
  'ensureRecordLinks',
  'ensureMissionTimestamps',
  'ensureNextStepsTable',
  'ensureRenamedColumn',
  'ensureReviewTimestamps',
  'ensureSessionMissionsTable',
  'ensureSprintSummaryView',
  'ensureStrategicDecisionsSchema',
  'ensureVectorStorage',
  // s96-m11: makes vector storage, under the write lock, before an embedding write needs it.
  'ensureVectorStorageForWrite',
  'migrateContentHash',
  'migrateStrategicDecisionsV21',
] as const;

/**
 * The only shipped callers with no answer warning carrier to splice into.
 *
 * These are residuals, not exemptions from a reachable-answer rule. Each key includes the
 * enclosing function and exact normalized call, so the marker and every-table calls in one
 * function have separate obligations. s93-m11 removed the three staleness residuals: the staleness read runs
 * no migration at all now, because reads never write the record.
 */
const STRUCTURAL_RESIDUALS: readonly ResidualReason[] = [
  {
    key: 'tools/rbook/fts5-retriever.ts:search:ensureDecisionsFts5',
    call: 'ensureDecisionsFts5(this.client)',
    reason: 'search() returns RankedResult[] and has no RbookToolResult warning envelope',
  },
  {
    key: 'tools/rbook/fts5-retriever.ts:search:ensureVectorStorage',
    call: 'ensureVectorStorage(this.client)',
    reason: 'search() returns RankedResult[] and has no RbookToolResult warning envelope',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureFirehoseEventColumns',
    call: 'ensureFirehoseEventColumns(client)',
    reason:
      'ensureGenesisSchema serves genesisColumns, whose GenesisStamp is spliced into SQL writes, and the change helper, which runs it before its token; neither carries a warnings channel',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureAuthorNamespaceColumns',
    call: 'ensureAuthorNamespaceColumns(client)',
    reason:
      'ensureGenesisSchema serves genesisColumns, whose GenesisStamp is spliced into SQL writes, and the change helper, which runs it before its token; neither carries a warnings channel',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureAuthorNameColumns',
    call: 'ensureAuthorNameColumns(client)',
    reason:
      'ensureGenesisSchema serves genesisColumns, whose GenesisStamp is spliced into SQL writes, and the change helper, which runs it before its token; neither carries a warnings channel',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureFirehoseEventColumns',
    call: 'ensureFirehoseEventColumns(client,{everyTable:true})',
    reason:
      'late-table recovery has no warning carrier; the final PRAGMA check refuses a stamp if required columns are still absent',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureAuthorNamespaceColumns',
    call: 'ensureAuthorNamespaceColumns(client,{everyTable:true})',
    reason:
      'late-table recovery has no warning carrier; the final PRAGMA check refuses a stamp if required columns are still absent',
  },
  {
    key: 'tools/rbook/genesis-columns.ts:ensureGenesisSchema:ensureAuthorNameColumns',
    call: 'ensureAuthorNameColumns(client,{everyTable:true})',
    reason:
      'late-table recovery has no warning carrier; the final PRAGMA check refuses a stamp if required columns are still absent',
  },
] as const;

/**
 * Producer owners that intentionally forward through a shared helper before reaching an answer.
 * Each shape has an executable, symbol-aware verifier below; this is not an owner-level allowlist.
 */
const FORWARDING_CARRIERS: readonly ForwardingCarrier[] = [
  ...[
    'ensureFirehoseEventColumns',
    'ensureAuthorNamespaceColumns',
    'ensureAuthorNameColumns',
    'ensureDecisionShapeColumns',
    'ensureRecordLinks',
  ].map((producer) => ({
    key: `tools/rbook/spin-out-store.ts:prepareSpinOutStore:${producer}`,
    reason:
      'the shared mutable sink reaches both spin-out preparation calls and the success/refusal answer arms',
  })),
  ...[
    'ensureAuthorNamespaceColumns',
    'ensureLearningsTable',
    'ensureFirehoseEventColumns',
    'ensureDecisionShapeColumns',
    'ensureRecordLinks',
  ].map((producer) => ({
    key: `tools/rbook/record-link-write.ts:prepareRecordLinkWrite:${producer}`,
    reason:
      'the exact mutable warnings parameter reaches all five writer answer boundaries, including refusals',
  })),
  {
    key: 'tools/rbook/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable',
    reason:
      'RecordAgentFeedbackResult.warnings is spliced by all four answer callers, including the standalone CLI',
  },
  ...[
    'ensureFirehoseEventColumns',
    'ensureAuthorNamespaceColumns',
    'ensureAuthorNameColumns',
    'ensureImplicitSessionColumns',
    // s96-m03: the recorded review and evergreen columns, which a copy needs before its guards.
    'ensureReviewTimestamps',
    'ensureLearningsTable',
    'ensureConstraintReviewTimestamp',
    'ensureConstraintEvergreen',
    'ensureDecisionShapeColumns',
  ].map((producer) => ({
    key: `tools/rbook/sharing-preconditions.ts:prepareForSharing:${producer}`,
    reason:
      "SharingReadiness.warnings carries them to s96-m13's share, whose answer attaches them, its refusal included",
  })),
  {
    key: 'intelligence/embedding-pipeline.ts:recordEmbedding:ensureVectorStorageForWrite',
    reason:
      "RecordEmbeddingResult.warnings is spliced by all six callers: decision write, mission add, update and complete, session capture and complete; a merge embeds through embedMergedRows and embedLive, whose callers, the sync's apply and a bundle's import, attach them to their answers",
  },
  {
    key: 'tools/rbook/learning-reaffirm.ts:reaffirmLearningsByIds:ensureReviewTimestamps',
    reason: 'the mutable warning sink crosses applyLearningReaffirm into both session answers',
  },
  {
    key: 'tools/rbook/rbook-mission-complete.ts:ensureMissionIdColumn:ensureStrategicDecisionsSchema',
    reason:
      'the string[] carrier is spliced directly (capture, session complete, decisions record) or through captureDecisions',
  },
  {
    key: 'tools/rbook/rbook-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureArchivalColumns',
    reason: 'ArchiveOutcome.warnings is spliced into the sprint-complete answer sink',
  },
  {
    key: 'tools/rbook/rbook-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureLearningsTable',
    reason: 'ArchiveOutcome.warnings is spliced into the sprint-complete answer sink',
  },
  {
    key: 'tools/rbook/first-write-maintenance.ts:repairSearchIndexes:ensureDecisionsFts5',
    reason: "the upkeep's notes are recorded on the call's Store upkeep section (s93-m11)",
  },
  {
    key: 'tools/rbook/first-write-maintenance.ts:repairSearchIndexes:ensureVectorStorage',
    reason: "the upkeep's notes are recorded on the call's Store upkeep section (s93-m11)",
  },
] as const;

function loadProgram(overrides: ReadonlyMap<string, string> = new Map()): ts.Program {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const replacement = overrides.get(path.resolve(fileName));
    return replacement === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, replacement, languageVersion, true);
  };
  return ts.createProgram(parsed.fileNames, parsed.options, host);
}

function migrationResultProducerNames(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resultSource: ts.SourceFile = sourceFile
): ReadonlySet<string> {
  const names = new Set<string>();
  const resultDeclaration = resultSource.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'MigrationResult'
  );
  if (!resultDeclaration) throw new Error('MigrationResult interface is missing');
  const migrationResultType = checker.getTypeAtLocation(resultDeclaration);

  for (const node of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const signature = checker.getSignatureFromDeclaration(node);
    const compatible =
      signature &&
      checker.isTypeAssignableTo(checker.getReturnTypeOfSignature(signature), migrationResultType);
    if (exported && compatible) {
      names.add(node.name.text);
    }
  }
  return names;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name) return current.name.getText(current.getSourceFile());
    return '<anonymous>';
  }
  return '<module>';
}

function collectCallSites(program: ts.Program): {
  readonly producerNames: ReadonlySet<string>;
  readonly sites: readonly MigrationCallSite[];
} {
  const checker = program.getTypeChecker();
  const migrations = program.getSourceFile(MIGRATIONS_FILE);
  if (!migrations) throw new Error(`Missing ${MIGRATIONS_FILE}`);
  const producerNames = new Set<string>();
  for (const file of PRODUCER_FILES) {
    const producerSource = program.getSourceFile(file);
    if (!producerSource) throw new Error(`Missing ${file}`);
    for (const name of migrationResultProducerNames(producerSource, checker, migrations))
      producerNames.add(name);
  }
  const sites: MigrationCallSite[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    const absolute = path.resolve(sourceFile.fileName);
    if (
      !absolute.startsWith(SRC_ROOT + path.sep) ||
      PRODUCER_FILES.includes(absolute) ||
      absolute.endsWith('.d.ts')
    ) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        const declaration = symbol?.declarations?.find((decl) =>
          PRODUCER_FILES.includes(path.resolve(decl.getSourceFile().fileName))
        );
        const producer =
          declaration && ts.isFunctionDeclaration(declaration) ? declaration.name?.text : undefined;
        if (producer && producerNames.has(producer)) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          sites.push({
            file: path.relative(SRC_ROOT, absolute),
            line: location.line + 1,
            producer,
            owner: enclosingFunctionName(node),
            call: node,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { producerNames, sites };
}

function callReadsWarnings(site: MigrationCallSite, checker: ts.TypeChecker): boolean {
  for (let current: ts.Node | undefined = site.call.parent; current; current = current.parent) {
    if (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === 'warnings' &&
      current.expression === site.call
    ) {
      return true;
    }
    if (ts.isFunctionLike(current)) break;
  }

  const declaration = site.call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const binding = checker.getSymbolAtLocation(declaration.name);
  if (!binding) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner) return false;

  let readsWarnings = false;
  const visit = (node: ts.Node): void => {
    if (readsWarnings) return;
    if (node !== owner && ts.isFunctionLike(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'warnings' &&
      ts.isIdentifier(node.expression) &&
      checker.getSymbolAtLocation(node.expression) === binding
    ) {
      readsWarnings = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return readsWarnings;
}

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function identifierSymbol(
  node: ts.Node | undefined,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  return node && ts.isIdentifier(node) ? resolvedSymbol(node, checker) : undefined;
}

function nodeContains(container: ts.Node, candidate: ts.Node): boolean {
  return candidate.pos >= container.pos && candidate.end <= container.end;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && 'body' in current && current.body) {
      return current as ts.FunctionLikeDeclaration;
    }
  }
  return undefined;
}

function directReturns(fn: ts.FunctionLikeDeclaration): readonly ts.ReturnStatement[] {
  if (!fn.body || !ts.isBlock(fn.body)) return [];
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returns;
}

function callNameIs(call: ts.CallExpression, expected: string, checker: ts.TypeChecker): boolean {
  const symbol = resolvedSymbol(call.expression, checker);
  return symbol?.name === expected;
}

function pushReceiverSymbol(
  node: ts.Node,
  stopAt: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== stopAt;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'push' &&
      current.arguments.some((argument) => nodeContains(argument, node))
    ) {
      return identifierSymbol(current.expression.expression, checker);
    }
  }
  return undefined;
}

/** Resolve the array that receives a call's warnings or warning-bearing result. */
function warningSinkForCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const owner = enclosingFunction(call);
  if (!owner) return undefined;

  // warnings.push(...producer().warnings) and warnings.push(...helper())
  const directPush = pushReceiverSymbol(call, owner, checker);
  if (directPush) return directPush;

  // const warnings = [...producer().warnings]
  for (
    let current: ts.Node | undefined = call.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      nodeContains(current.initializer, call) &&
      ts.isIdentifier(current.name)
    ) {
      const declarationSymbol = resolvedSymbol(current.name, checker);
      const readsCallWarnings = (() => {
        let found = false;
        const visit = (node: ts.Node): void => {
          if (
            ts.isPropertyAccessExpression(node) &&
            node.name.text === 'warnings' &&
            node.expression === call
          ) {
            found = true;
            return;
          }
          if (!found) ts.forEachChild(node, visit);
        };
        visit(current.initializer);
        return found;
      })();
      if (readsCallWarnings) return declarationSymbol;
      break;
    }
  }

  // const migration = producer(); warnings.push(...migration.warnings)
  // const outcome = helper(); warnings.push(...outcome.warnings)
  let resultDeclaration: ts.VariableDeclaration | undefined;
  for (
    let current: ts.Node | undefined = call.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      nodeContains(current.initializer, call) &&
      ts.isIdentifier(current.name)
    ) {
      resultDeclaration = current;
      break;
    }
  }
  if (!resultDeclaration || !ts.isIdentifier(resultDeclaration.name) || !owner.body) {
    return undefined;
  }
  const resultSymbol = resolvedSymbol(resultDeclaration.name, checker);
  if (!resultSymbol) return undefined;

  let sink: ts.Symbol | undefined;
  const visit = (node: ts.Node): void => {
    if (sink || (node !== owner.body && ts.isFunctionLike(node))) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'warnings' &&
      identifierSymbol(node.expression, checker) === resultSymbol
    ) {
      sink = pushReceiverSymbol(node, owner, checker);
      if (sink) return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner.body, visit);
  return sink;
}

function isAttachReturn(
  statement: ts.ReturnStatement,
  resultSymbol: ts.Symbol,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const expression = statement.expression;
  return Boolean(
    expression &&
    ts.isCallExpression(expression) &&
    callNameIs(expression, 'attachWarnings', checker) &&
    identifierSymbol(expression.arguments[0], checker) === resultSymbol &&
    identifierSymbol(expression.arguments[1], checker) === warningSink
  );
}

/**
 * Prove that `node` runs inside the initializer for a single result variable and every direct
 * return after that initializer is the exact `attachWarnings(result, warningSink)` boundary.
 * Pre-initializer validation returns are intentionally outside this contract because no migration
 * has run yet and their historical warning-free answer shape must remain unchanged.
 */
function reachesAttachBoundary(
  node: ts.Node,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isVariableDeclaration(current) || !ts.isIdentifier(current.name)) continue;
    const resultSymbol = resolvedSymbol(current.name, checker);
    const fn = enclosingFunction(current);
    if (!resultSymbol || !fn) continue;
    const postInitializerReturns = directReturns(fn).filter(
      (statement) => statement.getStart() > current.end
    );
    if (
      postInitializerReturns.length === 1 &&
      isAttachReturn(postInitializerReturns[0], resultSymbol, warningSink, checker)
    ) {
      return true;
    }
  }
  return false;
}

function returnObjectCarriesWarnings(
  statement: ts.ReturnStatement,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const expression = statement.expression;
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'warnings') {
      return checker.getShorthandAssignmentValueSymbol(property) === warningSink;
    }
    return (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'warnings' &&
      identifierSymbol(property.initializer, checker) === warningSink
    );
  });
}

function callbackReturnsSuccessWithSink(
  node: ts.Node,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const callback = enclosingFunction(node);
  if (!callback) return false;
  const postCallReturns = directReturns(callback).filter(
    (statement) => statement.getStart() > node.end
  );
  if (
    postCallReturns.length === 0 ||
    !postCallReturns.every((statement) => {
      const expression = statement.expression;
      return Boolean(
        expression &&
        ts.isCallExpression(expression) &&
        callNameIs(expression, 'createSuccess', checker) &&
        expression.arguments.some((argument) => identifierSymbol(argument, checker) === warningSink)
      );
    })
  ) {
    return false;
  }

  for (let current: ts.Node | undefined = callback.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      current.arguments.some((argument) => argument === callback)
    ) {
      for (let parent: ts.Node | undefined = current.parent; parent; parent = parent.parent) {
        if (ts.isReturnStatement(parent) && nodeContains(parent.expression ?? parent, current)) {
          return true;
        }
        if (ts.isFunctionLike(parent)) break;
      }
      return false;
    }
  }
  return false;
}

function sourceFunctionByName(
  program: ts.Program,
  relativeFile: string,
  name: string
): ts.FunctionDeclaration {
  const source = program.getSourceFile(path.join(SRC_ROOT, relativeFile));
  if (!source) throw new Error(`Missing ${relativeFile}`);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (!found) throw new Error(`Missing ${relativeFile}:${name}`);
  return found;
}

function callsToFunction(
  program: ts.Program,
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker
): readonly ts.CallExpression[] {
  const target = declaration.name && resolvedSymbol(declaration.name, checker);
  if (!target) throw new Error(`Missing symbol for ${declaration.name?.text ?? '<anonymous>'}`);
  const calls: ts.CallExpression[] = [];
  for (const source of program.getSourceFiles()) {
    const absolute = path.resolve(source.fileName);
    if (!absolute.startsWith(SRC_ROOT + path.sep) || absolute.endsWith('.d.ts')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && resolvedSymbol(node.expression, checker) === target) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return calls;
}

/** Trace a helper's mutable warning parameter through every shipped caller to an answer sink. */
function mutableSinkReachesAnswers(
  node: ts.Node,
  warningSink: ts.Symbol,
  program: ts.Program,
  checker: ts.TypeChecker,
  visited: ReadonlySet<ts.Symbol> = new Set()
): boolean {
  if (
    reachesAttachBoundary(node, warningSink, checker) ||
    callbackReturnsSuccessWithSink(node, warningSink, checker)
  ) {
    return true;
  }

  const declaration = warningSink.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration)) return false;
  const owner = enclosingFunction(declaration);
  if (!owner || !owner.name || !ts.isIdentifier(owner.name)) return false;
  const ownerSymbol = resolvedSymbol(owner.name, checker);
  if (!ownerSymbol || visited.has(ownerSymbol)) return false;
  const parameterIndex = owner.parameters.indexOf(declaration);
  if (parameterIndex < 0 || !ts.isFunctionDeclaration(owner)) return false;

  const nextVisited = new Set(visited);
  nextVisited.add(ownerSymbol);
  const callers = callsToFunction(program, owner, checker);
  return (
    callers.length > 0 &&
    callers.every((call) => {
      const callerSink = identifierSymbol(call.arguments[parameterIndex], checker);
      return Boolean(
        callerSink && mutableSinkReachesAnswers(call, callerSink, program, checker, nextVisited)
      );
    })
  );
}

function helperReturnCarrierIsComplete(
  site: MigrationCallSite,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner) return false;
  const postMigrationReturns = directReturns(owner).filter(
    (statement) => statement.getStart() > site.call.end
  );
  return (
    postMigrationReturns.length > 0 &&
    postMigrationReturns.every((statement) =>
      returnObjectCarriesWarnings(statement, warningSink, checker)
    )
  );
}

function verifyAgentFeedbackCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'tools/rbook/agent-feedback.ts',
    'recordAgentFeedback'
  );
  const calls = callsToFunction(program, helper, checker);
  return (
    // Count every symbol-resolved call in shipped src/: onboard, mission close, session close,
    // and the standalone feedback CLI. Every caller must prove its exact warning boundary.
    calls.length === 4 &&
    calls.every((call) => {
      const callerSink = warningSinkForCall(call, checker);
      return Boolean(
        callerSink &&
        (reachesAttachBoundary(call, callerSink, checker) ||
          callbackReturnsSuccessWithSink(call, callerSink, checker))
      );
    })
  );
}

/** s96-m11: the embedding write's storage warnings ride RecordEmbeddingResult to six answers. */
function verifyRecordEmbeddingCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'intelligence/embedding-pipeline.ts',
    'recordEmbedding'
  );
  const calls = callsToFunction(program, helper, checker);
  // s96-m12: embedMergedRows embeds what a merge wrote, after its transaction, and returns the
  // warnings in its own result. s96-m13: its one caller, embedLive, returns that result, and each
  // of embedLive's callers pushes its warnings into a sink that reaches the answer's boundary, as
  // the sync's apply and a bundle's import do.
  const merged = sourceFunctionByName(program, 'tools/rbook/record-derived.ts', 'embedMergedRows');
  const live = sourceFunctionByName(program, 'tools/rbook/record-apply-embed.ts', 'embedLive');
  const inMerged = calls.filter((call) => {
    for (let node: ts.Node | undefined = call; node; node = node.parent)
      if (ts.isFunctionDeclaration(node)) return node === merged;
    return false;
  });
  const mergedCalls = callsToFunction(program, merged, checker);
  const liveCalls = callsToFunction(program, live, checker);
  const returnedByLive = (call: ts.CallExpression): boolean =>
    enclosingFunction(call) === live &&
    ts.isReturnStatement(call.parent) &&
    call.parent.expression === call;
  const reachesAnswer = (call: ts.CallExpression): boolean => {
    const callerSink = warningSinkForCall(call, checker);
    return Boolean(
      callerSink &&
      (reachesAttachBoundary(call, callerSink, checker) ||
        callbackReturnsSuccessWithSink(call, callerSink, checker) ||
        mutableSinkReachesAnswers(call, callerSink, program, checker))
    );
  };
  return (
    calls.length === 7 &&
    inMerged.length === 1 &&
    mergedCalls.length === 1 &&
    mergedCalls.every(returnedByLive) &&
    liveCalls.length > 0 &&
    liveCalls.every(reachesAnswer) &&
    calls
      .filter((call) => !inMerged.includes(call))
      .every((call) => {
        const callerSink = warningSinkForCall(call, checker);
        return Boolean(
          callerSink &&
          (reachesAttachBoundary(call, callerSink, checker) ||
            callbackReturnsSuccessWithSink(call, callerSink, checker) ||
            mutableSinkReachesAnswers(call, callerSink, program, checker))
        );
      })
  );
}

/**
 * s96-m01: the sharing preconditions' migration warnings ride SharingReadiness.warnings. s96-m13's
 * share and s96-m14's import are two of their callers, and s97-m09 adds two: a fresh copy's schema
 * preparation (record-fresh-copy.ts, whose answer the referee library's own answers carry) and the
 * referee library's migrate. Each pushes them into a sink that its answer's attachWarnings boundary
 * returns, a refusal included.
 */
function verifySharingCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'tools/rbook/sharing-preconditions.ts',
    'prepareForSharing'
  );
  const calls = callsToFunction(program, helper, checker);
  return (
    calls.length === 4 &&
    calls.every((call) => {
      const callerSink = warningSinkForCall(call, checker);
      return Boolean(callerSink && reachesAttachBoundary(call, callerSink, checker));
    })
  );
}

function verifyLearningReaffirmCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner || owner.parameters.length < 4) return false;
  const sink = identifierSymbol(owner.parameters[3].name, checker);
  if (!sink || !owner.body) return false;
  let pushesIntoSink = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      identifierSymbol(node.expression.expression, checker) === sink
    ) {
      pushesIntoSink = true;
      return;
    }
    if (!pushesIntoSink) ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner.body, visit);
  if (!pushesIntoSink || !ts.isFunctionDeclaration(owner)) return false;

  const directCalls = callsToFunction(program, owner, checker);
  // s92-m04: one call. The second one was the implicit keyword-overlap reaffirm, now retired.
  if (directCalls.length !== 1) return false;
  const apply = sourceFunctionByName(
    program,
    'tools/rbook/learning-reaffirm.ts',
    'applyLearningReaffirm'
  );
  const applySink = identifierSymbol(apply.parameters[2]?.name, checker);
  if (
    !applySink ||
    !directCalls.every((call) => identifierSymbol(call.arguments[3], checker) === applySink)
  ) {
    return false;
  }
  return mutableSinkReachesAnswers(apply, applySink, program, checker);
}

function verifyMissionIdCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner || !ts.isFunctionDeclaration(owner)) return false;
  const returnStatement = site.call.parent.parent;
  if (
    !ts.isBinaryExpression(returnStatement) &&
    !(ts.isReturnStatement(returnStatement) || ts.isReturnStatement(returnStatement.parent))
  ) {
    return false;
  }
  const calls = callsToFunction(program, owner, checker);
  // s94-m06 adds mission-complete preflight; captureDecisions still independently forwards
  // its compatibility migration warning. All five exact sinks must reach an answer.
  return (
    calls.length === 5 &&
    calls.every((call) => {
      const callerSink = warningSinkForCall(call, checker);
      return Boolean(callerSink && mutableSinkReachesAnswers(call, callerSink, program, checker));
    })
  );
}

function verifyArchiveCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'tools/rbook/rbook-sprint-complete.ts',
    'archiveSprintDecisionsAndLearnings'
  );
  const calls = callsToFunction(program, helper, checker);
  if (calls.length !== 1) return false;
  const callerSink = warningSinkForCall(calls[0], checker);
  return Boolean(callerSink && mutableSinkReachesAnswers(calls[0], callerSink, program, checker));
}

/**
 * s93-m11 — first-write upkeep's index repair. Each migration's warnings are pushed into the
 * helper's notes, which every later return hands back; the helper's one caller pushes them into
 * runFirstWriteMaintenance's notes, which every return after that declaration hands back; and the
 * one shipped caller of that iterates its result into recordStoreUpkeepNote, the call's
 * "Store upkeep:" carrier (rendered by attachStoreUpkeepNotes, shown in first-write-upkeep.test.ts).
 */
function verifyStoreUpkeepCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const returnsSinkAfter = (
    fn: ts.FunctionLikeDeclaration,
    sink: ts.Symbol,
    after: number
  ): boolean => {
    const returns = directReturns(fn).filter((statement) => statement.getStart() > after);
    return (
      returns.length > 0 &&
      returns.every((statement) => identifierSymbol(statement.expression, checker) === sink)
    );
  };

  const helper = enclosingFunction(site.call);
  const helperSink = warningSinkForCall(site.call, checker);
  if (!helper || !ts.isFunctionDeclaration(helper) || !helperSink) return false;
  if (!returnsSinkAfter(helper, helperSink, site.call.end)) return false;

  const helperCalls = callsToFunction(program, helper, checker);
  if (helperCalls.length !== 1) return false;
  const upkeepSink = warningSinkForCall(helperCalls[0], checker);
  const sinkDeclaration = upkeepSink?.valueDeclaration;
  if (!upkeepSink || !sinkDeclaration || !ts.isVariableDeclaration(sinkDeclaration)) return false;
  const upkeep = enclosingFunction(sinkDeclaration);
  if (!upkeep || !ts.isFunctionDeclaration(upkeep)) return false;
  if (!returnsSinkAfter(upkeep, upkeepSink, sinkDeclaration.end)) return false;

  const dispatchCalls = callsToFunction(program, upkeep, checker);
  return (
    dispatchCalls.length === 1 &&
    dispatchCalls.every((call) => {
      const awaited = call.parent;
      const loop = awaited?.parent;
      if (!ts.isAwaitExpression(awaited) || !loop || !ts.isForOfStatement(loop)) return false;
      const declarations = loop.initializer;
      if (!ts.isVariableDeclarationList(declarations)) return false;
      const note = declarations.declarations[0]?.name;
      const noteSymbol = note && ts.isIdentifier(note) ? resolvedSymbol(note, checker) : undefined;
      let recorded = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          callNameIs(node, 'recordStoreUpkeepNote', checker) &&
          identifierSymbol(node.arguments[0], checker) === noteSymbol
        ) {
          recorded = true;
        }
        if (!recorded) ts.forEachChild(node, visit);
      };
      visit(loop.statement);
      return Boolean(noteSymbol) && recorded;
    })
  );
}

/** The new preflight owns no answer; prove its exact parameter reaches every writer answer. */
function verifyRecordLinkCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner || !ts.isFunctionDeclaration(owner)) return false;
  const sink = warningSinkForCall(site.call, checker);
  const parameter = identifierSymbol(owner.parameters[1]?.name, checker);
  return Boolean(
    sink &&
    sink === parameter &&
    callsToFunction(program, owner, checker).length === 5 &&
    mutableSinkReachesAnswers(site.call, sink, program, checker)
  );
}

/** Spin-out carries one mutable sink across both stores, including preparation throws. */
function verifySpinOutCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const helper = enclosingFunction(site.call);
  const sink = warningSinkForCall(site.call, checker);
  if (
    !helper ||
    !ts.isFunctionDeclaration(helper) ||
    !sink ||
    identifierSymbol(helper.parameters[1]?.name, checker) !== sink
  )
    return false;
  // The six array-dispatched producers are the census's named dynamic complement. Verify
  // their exact population and shared warning sink rather than silently omitting that loop.
  const loops =
    helper.body?.statements
      .filter(ts.isForOfStatement)
      .filter(
        (loop) =>
          ts.isArrayLiteralExpression(loop.expression) &&
          loop.expression.elements.every(ts.isIdentifier)
      ) ?? [];
  if (loops.length !== 1) return false;
  const loop = loops[0];
  if (
    !ts.isArrayLiteralExpression(loop.expression) ||
    JSON.stringify(loop.expression.elements.map((node) => node.getText()).sort()) !==
      JSON.stringify(
        [
          'ensureStrategicDecisionsSchema',
          'ensureMissionTimestamps',
          'ensureLearningsTable',
          'ensureNextStepsTable',
          'ensureConstraintsTable',
          'ensureReviewTimestamps',
        ].sort()
      ) ||
    !ts.isVariableDeclarationList(loop.initializer)
  )
    return false;
  const dispatch = identifierSymbol(loop.initializer.declarations[0]?.name, checker);
  let loopWarningRead = false;
  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      identifierSymbol(node.expression, checker) === dispatch &&
      warningSinkForCall(node, checker) === sink &&
      callReadsWarnings({ ...site, call: node }, checker)
    )
      loopWarningRead = true;
    ts.forEachChild(node, inspect);
  };
  inspect(loop.statement);
  if (!dispatch || !loopWarningRead) return false;
  const calls = callsToFunction(program, helper, checker);
  if (calls.length !== 2) return false;
  return calls.every((call) => {
    const outer = enclosingFunction(call);
    const answerSink = identifierSymbol(call.arguments[1], checker);
    if (!outer || !answerSink || !ts.isIdentifier(call.arguments[1])) return false;
    let protectedByCatch = false;
    for (let node: ts.Node | undefined = call.parent; node && node !== outer; node = node.parent)
      if (ts.isTryStatement(node) && node.catchClause && nodeContains(node.tryBlock, call))
        protectedByCatch = true;
    if (!protectedByCatch) return false;
    const carries = (expression: ts.Expression | undefined): boolean => {
      if (!expression) return false;
      if (ts.isIdentifier(expression)) {
        const declaration = resolvedSymbol(expression, checker)?.valueDeclaration;
        return (
          !!declaration &&
          ts.isVariableDeclaration(declaration) &&
          !!declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          carries(declaration.initializer)
        );
      }
      if (ts.isCallExpression(expression)) {
        const declaration = resolvedSymbol(expression.expression, checker)?.valueDeclaration;
        if (
          !declaration ||
          !ts.isVariableDeclaration(declaration) ||
          !declaration.initializer ||
          !ts.isArrowFunction(declaration.initializer)
        )
          return false;
        const returns = directReturns(declaration.initializer);
        return (
          returns.length === 1 &&
          returns.every((statement) => {
            const value = statement.expression;
            return (
              !!value &&
              ts.isCallExpression(value) &&
              callNameIs(value, 'createSuccess', checker) &&
              identifierSymbol(value.arguments[1], checker) === answerSink
            );
          })
        );
      }
      if (!ts.isObjectLiteralExpression(expression)) return false;
      return expression.properties.some((property) => {
        if (!ts.isSpreadAssignment(property) || !ts.isParenthesizedExpression(property.expression))
          return false;
        const conditional = property.expression.expression;
        if (
          !ts.isConditionalExpression(conditional) ||
          !ts.isPropertyAccessExpression(conditional.condition) ||
          conditional.condition.name.text !== 'length' ||
          identifierSymbol(conditional.condition.expression, checker) !== answerSink ||
          !ts.isObjectLiteralExpression(conditional.whenTrue) ||
          !ts.isObjectLiteralExpression(conditional.whenFalse) ||
          conditional.whenFalse.properties.length !== 0
        )
          return false;
        return conditional.whenTrue.properties.some(
          (field) =>
            ts.isShorthandPropertyAssignment(field) &&
            field.name.text === 'warnings' &&
            checker.getShorthandAssignmentValueSymbol(field) === answerSink
        );
      });
    };
    const returns = directReturns(outer).filter((statement) => statement.getStart() > call.end);
    return returns.length > 0 && returns.every((statement) => carries(statement.expression));
  });
}

function forwardingCarrierIsVerified(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  switch (siteKey(site)) {
    case 'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureFirehoseEventColumns':
    case 'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureAuthorNamespaceColumns':
    case 'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureAuthorNameColumns':
    case 'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureDecisionShapeColumns':
    case 'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureRecordLinks':
      return verifySpinOutCarrier(site, program, checker);
    case 'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureAuthorNamespaceColumns':
    case 'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureLearningsTable':
    case 'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureFirehoseEventColumns':
    case 'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureDecisionShapeColumns':
    case 'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureRecordLinks':
      return verifyRecordLinkCarrier(site, program, checker);
    case 'tools/rbook/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable':
      return verifyAgentFeedbackCarrier(site, program, checker);
    case 'intelligence/embedding-pipeline.ts:recordEmbedding:ensureVectorStorageForWrite':
      return verifyRecordEmbeddingCarrier(site, program, checker);
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureFirehoseEventColumns':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureAuthorNamespaceColumns':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureAuthorNameColumns':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureImplicitSessionColumns':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureReviewTimestamps':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureLearningsTable':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureConstraintReviewTimestamp':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureConstraintEvergreen':
    case 'tools/rbook/sharing-preconditions.ts:prepareForSharing:ensureDecisionShapeColumns':
      return verifySharingCarrier(site, program, checker);
    case 'tools/rbook/learning-reaffirm.ts:reaffirmLearningsByIds:ensureReviewTimestamps':
      return verifyLearningReaffirmCarrier(site, program, checker);
    case 'tools/rbook/rbook-mission-complete.ts:ensureMissionIdColumn:ensureStrategicDecisionsSchema':
      return verifyMissionIdCarrier(site, program, checker);
    case 'tools/rbook/rbook-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureArchivalColumns':
    case 'tools/rbook/rbook-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureLearningsTable':
      return verifyArchiveCarrier(site, program, checker);
    case 'tools/rbook/first-write-maintenance.ts:repairSearchIndexes:ensureDecisionsFts5':
    case 'tools/rbook/first-write-maintenance.ts:repairSearchIndexes:ensureVectorStorage':
      return verifyStoreUpkeepCarrier(site, program, checker);
    default:
      return false;
  }
}

function siteKey(site: MigrationCallSite): string {
  return `${site.file}:${site.owner}:${site.producer}`;
}

describe('s88-m09 MigrationResult warning reachability census', () => {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const census = collectCallSites(program);
  const consumed = census.sites.filter((site) => callReadsWarnings(site, checker));
  const unconsumed = census.sites.filter((site) => !callReadsWarnings(site, checker));
  const expectedForwarders = new Map(
    FORWARDING_CARRIERS.map((carrier) => [carrier.key, carrier.reason])
  );
  const forwarded = consumed.filter((site) => expectedForwarders.has(siteKey(site)));
  const directlyBounded = consumed.filter((site) => {
    const sink = warningSinkForCall(site.call, checker);
    return Boolean(sink && reachesAttachBoundary(site.call, sink, checker));
  });

  it('re-derives the current producer and shipped-call denominators', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[migration-warning-census] producers=${census.producerNames.size} ` +
        `srcCalls=${census.sites.length} directBoundaries=${directlyBounded.length} ` +
        `forwarded=${forwarded.length} residual=${unconsumed.length}`
    );
    expect([...census.producerNames].sort()).toEqual([...EXPECTED_PRODUCERS].sort());
    // s91-m04: 48 -> 50 — rbook-decisions-record.ts runs ensureFirehoseEventColumns and
    // ensureAuthorNamespaceColumns before its transaction; both reach attachWarnings.
    // s92-m03: 50 -> 55 — ensureImplicitSessionColumns runs in session capture, complete and
    // start, decisions record, and mission complete; all five reach attachWarnings.
    // s92-m09: 55 -> 58 — ensureContentPrunedColumn runs in session complete and mission complete
    // (their persist copies go content-less) and in rbook_db(prune_snapshots) before it applies;
    // all three reach the handler's answer, refusals included.
    // s93-m11: 58 -> 57 — the staleness read runs no migration (-3: two ensureLearningsTable, one
    // ensureReviewTimestamps), and an explicit decision status update stamps its review (+2:
    // ensureReviewTimestamps in decisions update and batch update; both reach attachWarnings).
    // s93-m11 critic fold: 57 -> 59 — first-write upkeep rebuilds an index a read left out of step
    // (ensureDecisionsFts5, ensureVectorStorage); both forward to the Store upkeep section.
    // s93-m06: 59 -> 60 — decisions record runs ensureDecisionApprovalColumns before a draft's
    // transaction; it reaches attachWarnings.
    // s94-m04: replace the draft-only approval migration (-1) with six guarded shape calls (+6).
    // s94-m06: three inline author calls move into one shared preflight (-3 +4 producer
    // calls); the scoped producer universe now also covers ensureRecordLinks (+3 callers).
    // s94-m08: four directly named preparation producers join the forwarding paths.
    // Six array-dispatched preparations are the declared dynamic-dispatch complement below.
    // s96-m11: 73 -> 74 — recordEmbedding makes vector storage before its write, forwarded.
    // s96-m01: 74 -> 78 — the sharing preconditions run four schema migrations, forwarded.
    // s96-m02: 78 -> 81 — author_name's migration, in genesisColumns (a residual), spin-out's
    // preparation and the sharing preconditions (both forwarded).
    // s96-m03: four more readiness migrations in prepareForSharing.
    // s96-m14: 85 -> 87 — the import migrates its temporary copy (decisions' v2.1 step and missions'
    // timestamps), and its answer attaches their warnings.
    // s96-m08: 87 -> 82 — retirement removes exactly five direct producers: backfill's
    // migrateContentHash, plus ensureDecisionShapeColumns and ensureRecordLinks in each of
    // sync-pull.ts and sync-bootstrap.ts. No producer declaration or residual is removed.
    // s96-m09: 82 -> 85 — genesis schema preparation adds three every-table recovery calls
    // for late-created tables. Each is a separately named residual below.
    // s100-m03: 85 -> 87 — a next-step capture prepares next_steps and, with a missionId,
    // session_missions before its write lock; both reach the capture's attachWarnings.
    // s102-m03: +5 — start prepares implicit sessions, junction and firehose; complete adds
    // junction and firehose preparations. Its existing implicit preparation only moves.
    // s102-m04: reopen adds one migration read at its outer answer boundary.
    expect(census.sites.length).toBe(93);
  });

  it('carries every reachable producer through its exact answer boundary', () => {
    const directKeys = new Set(directlyBounded.map(siteKey));
    const unsafe = consumed.filter(
      (site) => !directKeys.has(siteKey(site)) && !expectedForwarders.has(siteKey(site))
    );
    const invalidForwarders = forwarded.filter(
      (site) => !forwardingCarrierIsVerified(site, program, checker)
    );

    expect(
      unsafe.map((site) => `${siteKey(site)}:${site.line} has no post-migration answer boundary`)
    ).toEqual([]);
    expect(
      invalidForwarders.map(
        (site) =>
          `${siteKey(site)}:${site.line} broke its verified forwarding chain — ${expectedForwarders.get(siteKey(site))}`
      )
    ).toEqual([]);
    // s91-m04: +2 in rbook-decisions-record.ts; s92-m03: +5 (the implicit-session columns).
    // s92-m09: +3 (the content tombstone column in session complete, mission complete and the
    // snapshot prune).
    // s93-m11: +2 (the review-timestamp migration in decisions update and batch update).
    // s93-m06: +1 (the approval columns in decisions record).
    // s94-m04: six shape-call boundaries replace the draft-only approval boundary (+5 net).
    // Three author boundaries move to the shared helper; pull/bootstrap add two link boundaries.
    // s96-m14: +2 — the import's two direct migrations of its temporary copy.
    // s96-m08: -5 — the removed backfill migration and pull/clone's two migrations each.
    // The exact-boundary and forwarding assertions above still cover every remaining call.
    // s100-m03: +2 — the next-step capture's two preparations, at its attachWarnings boundary.
    // s102-m03: +5 direct transition preparations; every warning reaches attachWarnings.
    expect(directlyBounded).toHaveLength(58);
    expect(forwarded.map(siteKey).sort()).toEqual([...expectedForwarders.keys()].sort());
  });

  it('does not mistake an owner-level warnings read for an answer boundary', () => {
    const forwardingOwner = consumed.find(
      (site) =>
        siteKey(site) ===
        'tools/rbook/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable'
    );
    expect(forwardingOwner).toBeDefined();
    expect(callReadsWarnings(forwardingOwner!, checker)).toBe(true);
    const localSink = warningSinkForCall(forwardingOwner!.call, checker);
    expect(localSink).toBeDefined();
    expect(reachesAttachBoundary(forwardingOwner!.call, localSink!, checker)).toBe(false);
    expect(forwardingCarrierIsVerified(forwardingOwner!, program, checker)).toBe(true);
  });

  it.each(['producer-read', 'caller-sink', 'answer-boundary'])(
    'rejects a broken record-link warning forwarding %s',
    (mutation) => {
      const helperFile = path.join(SRC_ROOT, 'tools/rbook/record-link-write.ts');
      const callerFile = path.join(SRC_ROOT, 'tools/rbook/rbook-decisions-update.ts');
      const file = mutation === 'producer-read' ? helperFile : callerFile;
      const original = fs.readFileSync(file, 'utf8');
      const changed =
        mutation === 'producer-read'
          ? original.replace('warnings.push(...(author.warnings ?? []));', 'void author;')
          : mutation === 'caller-sink'
            ? original.replace(
                'prepareRecordLinkWrite(client, warnings)',
                'prepareRecordLinkWrite(client, [])'
              )
            : original.replace('return attachWarnings(result, warnings);', 'return result;');
      expect(changed).not.toBe(original);
      const mutant = loadProgram(new Map([[file, changed]]));
      const mutantChecker = mutant.getTypeChecker();
      const site = collectCallSites(mutant).sites.find(
        (candidate) =>
          siteKey(candidate) ===
          'tools/rbook/record-link-write.ts:prepareRecordLinkWrite:ensureAuthorNamespaceColumns'
      );
      expect(site).toBeDefined();
      expect(verifyRecordLinkCarrier(site!, mutant, mutantChecker)).toBe(false);
    }
  );

  it.each(['producer-read', 'dynamic-read', 'caller-sink', 'success-answer', 'refusal-answer'])(
    'rejects broken spin-out warning forwarding %s',
    (mutation) => {
      const file = path.join(
        SRC_ROOT,
        ['producer-read', 'dynamic-read'].includes(mutation)
          ? 'tools/rbook/spin-out-store.ts'
          : 'tools/rbook/spin-out.ts'
      );
      const original = fs.readFileSync(file, 'utf8');
      const changed =
        mutation === 'producer-read'
          ? original.replace('warnings.push(...(shape.warnings ?? []));', 'void shape;')
          : mutation === 'dynamic-read'
            ? original.replace(
                'warnings.push(...(ensure(client).warnings ?? []));',
                'void ensure(client);'
              )
            : mutation === 'caller-sink'
              ? original.replace(
                  'prepareSpinOutStore(target, warnings)',
                  'prepareSpinOutStore(target, [])'
                )
              : mutation === 'success-answer'
                ? original.replace('      warnings\n    );', '      []\n    );')
                : original.replace('...(warnings.length ? { warnings } : {})', '...({})');
      expect(changed).not.toBe(original);
      const mutant = loadProgram(new Map([[file, changed]]));
      const checker = mutant.getTypeChecker();
      const site = collectCallSites(mutant).sites.find(
        (row) =>
          siteKey(row) ===
          'tools/rbook/spin-out-store.ts:prepareSpinOutStore:ensureDecisionShapeColumns'
      );
      expect(site).toBeDefined();
      expect(verifySpinOutCarrier(site!, mutant, checker)).toBe(false);
    }
  );

  it('leaves only named, structurally carrier-less residuals', () => {
    const expectedEntries = STRUCTURAL_RESIDUALS.map(
      (residual) => [`${residual.key}:${residual.call}`, residual.reason] as const
    );
    expect(new Set(expectedEntries.map(([key]) => key)).size).toBe(expectedEntries.length);
    const expected = new Map(expectedEntries);
    const actual = unconsumed.map((site) => ({
      key: `${siteKey(site)}:${site.call.getText().replace(/\s+/g, '')}`,
      line: site.line,
      reason:
        expected.get(`${siteKey(site)}:${site.call.getText().replace(/\s+/g, '')}`) ??
        'REACHABLE ANSWER DROPS THIS WARNING',
    }));
    // eslint-disable-next-line no-console
    console.log(
      `[migration-warning-census] residuals:\n${actual
        .map((row) => `- ${row.key}:${row.line} — ${row.reason}`)
        .join('\n')}`
    );

    expect(actual.map((row) => row.key).sort()).toEqual([...expected.keys()].sort());
    // s92-m03: +5, s92-m09: +3, s93-m11: +2 directly bounded and +2 forwarded (the upkeep).
    // s93-m06: +1 (ensureDecisionApprovalColumns in decisions record).
    // s94-m04: all six shape callers carry warnings through their final answer (+5 net).
    // s94-m06: 53 direct + 12 structurally verified forwarded warning reads.
    // s94-m08: 53 direct + 16 verified forwarded reads; four residuals remain unchanged.
    // s96-m11: 53 direct + 17 verified forwarded reads (recordEmbedding's storage warnings).
    // s96-m01: 53 direct + 21 verified forwarded reads (the four sharing preconditions).
    // s96-m02: 53 direct + 23 forwarded (author_name in spin-out and the sharing preconditions).
    // s96-m03: the four readiness migrations, forwarded through SharingReadiness.
    // s96-m14: +2, the import's two direct migrations, at its attachWarnings boundary.
    // s96-m08: 50 direct + 27 verified forwarded reads after five retired direct calls leave.
    // s96-m09: all three late-table recovery calls remain separately named, making eight residuals.
    // s102-m04: 58 direct + 27 verified forwarded reads; the residuals are unchanged.
    expect(consumed).toHaveLength(85);
    expect(unconsumed).toHaveLength(STRUCTURAL_RESIDUALS.length);
  });
});

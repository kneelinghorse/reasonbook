// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m02 — the suggestion-site universe and its partition, before any repair edit.
// ABOUTME: Run from the repository root: node tests/sweeps/s106-m02/census.js > tests/sweeps/s106-m02/before.json
const { execFileSync } = require('child_process');
const fs = require('fs');
const ts = require('typescript');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const FACTORIES = new Set(['missingParameter', 'invalidParameter', 'invalidAction']);
// Sub-predicates over an authored suggestion's own initializer text, case-insensitive.
const REMOVAL = /\b(?:alone|remove|omit|drop|without|leave out)\b/i;
const RETRY = /\b(?:retry|try again|re-run|rerun|run again|call again)\b/i;
const CONDITION = /\b(?:then|after|once|when|if|until|before)\b/i;

// P0, the design's universe: every physical line under src/ that names a suggestion assignment.
const universe = git('grep', '-nE', 'suggestion[[:space:]]*(:|=)', '--', 'src')
  .split('\n')
  .filter(Boolean);
const colonLines = universe.filter((line) =>
  line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).includes('suggestion:')
);

const files = git('ls-files', '--', 'src/*.ts')
  .split('\n')
  .filter((file) => file && !file.endsWith('.d.ts'));

const sites = [];
const declarations = [];
const factoryCalls = [];
const textOf = (node, source) => node.getText(source).replace(/\s+/g, ' ');
const lineOf = (node, source) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const named = (node) =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : null;

/** The function a node sits in, by its declared or assigned name. */
function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent))
      return named(parent) ?? '(anonymous)';
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      parent.parent &&
      (ts.isVariableDeclaration(parent.parent) || ts.isPropertyAssignment(parent.parent))
    )
      return named(parent.parent) ?? '(anonymous)';
  }
  return '(module)';
}

/** The nearest enclosing condition that guards the node: an if, a ternary or a logical operand. */
function guardOf(node, source) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child)
      return textOf(parent.expression, source).slice(0, 160);
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child)
      return textOf(parent.condition, source).slice(0, 160);
    if (ts.isFunctionLike(parent)) return null;
  }
  return null;
}

function initializerKind(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isTemplateExpression(node)) return 'template';
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return 'concatenation';
  if (ts.isConditionalExpression(node)) return 'conditional';
  if (ts.isCallExpression(node)) return 'call';
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'suggestion') return 'forwarding';
  if (ts.isIdentifier(node)) return 'identifier';
  return ts.SyntaxKind[node.kind];
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const sanitizeCalls = [];
  const findSanitize = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sanitizeContentField'
    )
      sanitizeCalls.push({ function: enclosingFunction(node), position: node.getStart(source) });
    ts.forEachChild(node, findSanitize);
  };
  findSanitize(source);
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && named(node) === 'suggestion') {
      const literal = node.parent;
      const code = literal.properties.find(
        (property) => ts.isPropertyAssignment(property) && named(property) === 'code'
      );
      const initializer = textOf(node.initializer, source);
      sites.push({
        site: `${file}:${lineOf(node, source)}`,
        refusalShaped: Boolean(code),
        code: code ? textOf(code.initializer, source).slice(0, 80) : null,
        kind: initializerKind(node.initializer),
        callBearing: /rbook_[a-z_]+\(/.test(initializer),
        insideFactory:
          file === 'src/tools/rbook/errors.ts' && FACTORIES.has(enclosingFunction(node)),
        removal: REMOVAL.test(initializer),
        retry: RETRY.test(initializer),
        retryCondition: CONDITION.test(initializer),
      });
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'suggestion') {
      sites.push({ site: `${file}:${lineOf(node, source)}`, kind: 'shorthand' });
    } else if (ts.isPropertySignature(node) && named(node) === 'suggestion') {
      declarations.push(`${file}:${lineOf(node, source)}`);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      FACTORIES.has(node.expression.name.text)
    ) {
      const [first, , third] = node.arguments;
      factoryCalls.push({
        site: `${file}:${lineOf(node, source)}`,
        factory: node.expression.name.text,
        field: first ? textOf(first, source).slice(0, 80) : null,
        thirdArgument:
          node.expression.name.text === 'invalidParameter' ? third !== undefined : null,
        function: enclosingFunction(node),
        guard: guardOf(node, source),
        // A check that runs after the content sanitizer can fire on a value the caller supplied.
        afterSanitize: sanitizeCalls.some(
          (call) =>
            call.function === enclosingFunction(node) && call.position < node.getStart(source)
        ),
        file,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const count = (list, predicate) => list.filter(predicate).length;
const authored = sites.filter((site) => site.kind !== 'forwarding' && site.kind !== 'shorthand');
const prose = authored.filter((site) => site.refusalShaped && !site.callBearing);
const missing = factoryCalls.filter((call) => call.factory === 'missingParameter');
const groups = new Map();
for (const call of missing) {
  const key = `${call.file}#${call.function}`;
  groups.set(key, [...(groups.get(key) ?? []), call.site]);
}
for (const call of factoryCalls) delete call.file;
process.stdout.write(
  `${JSON.stringify(
    {
      head: git('rev-parse', 'HEAD').trim(),
      srcMatchesHead: git('status', '--porcelain', '--', 'src') === '',
      universe: {
        predicate: "git grep -nE 'suggestion[[:space:]]*(:|=)' -- src",
        unit: 'physical lines',
        lines: universe.length,
        withSuggestionColon: colonLines.length,
        otherLines: universe.filter((line) => !colonLines.includes(line)),
      },
      ast: {
        predicate:
          'Over git ls-files -- src/*.ts (no .d.ts): every PropertyAssignment and shorthand property named suggestion, every PropertySignature named suggestion, and every call whose callee is a property access ending in missingParameter, invalidParameter or invalidAction.',
        filesScanned: files.length,
        propertyAssignments: sites.length,
        shorthand: count(sites, (site) => site.kind === 'shorthand'),
        forwarding: count(sites, (site) => site.kind === 'forwarding'),
        authored: authored.length,
        authoredRefusalShaped: count(authored, (site) => site.refusalShaped),
        authoredCallBearing: count(authored, (site) => site.callBearing),
        authoredProse: count(authored, (site) => !site.callBearing),
        refusalShapedCallBearing: count(authored, (site) => site.refusalShaped && site.callBearing),
        refusalShapedProse: prose.length,
        notRefusalShaped: count(authored, (site) => !site.refusalShaped),
        insideFactories: count(sites, (site) => site.insideFactory),
        typeDeclarations: declarations.length,
        byKind: Object.fromEntries(
          [...new Set(sites.map((site) => site.kind))].map((kind) => [
            kind,
            count(sites, (site) => site.kind === kind),
          ])
        ),
      },
      factories: {
        calls: factoryCalls.length,
        byFactory: Object.fromEntries(
          [...FACTORIES].map((name) => [name, count(factoryCalls, (call) => call.factory === name)])
        ),
        invalidParameterWithoutThirdArgument: count(
          factoryCalls,
          (call) => call.factory === 'invalidParameter' && call.thirdArgument === false
        ),
        sequentialMissingChecks: {
          rule: 'Functions holding two or more missingParameter calls: a call that omits both meets the second after following the first.',
          functions: [...groups.entries()]
            .filter(([, list]) => list.length > 1)
            .map(([key, list]) => ({ function: key, sites: list })),
        },
        missingAfterSanitize: {
          rule: 'missingParameter calls positioned after a sanitizeContentField call in the same function.',
          sites: missing.filter((call) => call.afterSanitize).map((call) => call.site),
        },
      },
      prose: {
        rule: 'Authored, refusal-shaped suggestions with no rbook_*( prescription; sub-predicates match the initializer text.',
        sites: prose.length,
        removal: {
          pattern: REMOVAL.source,
          sites: prose.filter((site) => site.removal).map((site) => site.site),
        },
        retryWithoutCondition: {
          pattern: `${RETRY.source} and not ${CONDITION.source}`,
          retrySites: count(prose, (site) => site.retry),
          sites: prose
            .filter((site) => site.retry && !site.retryCondition)
            .map((site) => site.site),
        },
      },
      sites,
      declarations,
      factoryCalls,
    },
    null,
    2
  )}\n`
);

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sprint-101 plan-time class predicate (practice 8), read-only: prints every site of a defect class
// ABOUTME: with its count over tracked src files. Usage: node sweep.cjs <repo> [class]
// Read-only class sweeps for the sprint-101 (4.5.1) plan. Usage: node sweep.cjs <repo> <class: upload|active|remedy|status410>
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const repo = path.resolve(process.argv[2]);
const which = process.argv[3];
const ts = require(require.resolve('typescript', { paths: [repo] }));
const files = execFileSync('git', ['-C', repo, 'ls-files', 'src/*.ts', 'src/**/*.ts'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const uniq = [...new Set(files)];
const out = [];
const textOf = (node, sf) => {
  // String literal text, template literal head+spans, and + concatenations.
  if (!node) return '';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return textOf(node.left, sf) + textOf(node.right, sf);
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression, sf);
  if (ts.isConditionalExpression(node))
    return textOf(node.whenTrue, sf) + ' ¦ ' + textOf(node.whenFalse, sf);
  return '';
};
for (const rel of uniq) {
  const file = path.join(repo, rel);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    if (which === 'upload' && ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const name = callee.split('.').pop();
      const starters = [
        'triggerCheckpointBackfill',
        'observeDashboardUploadProject',
        'markDashboardUploadOwed',
        'withUploadLease',
        'withUploadSnapshot',
        'rbookDbBackfill',
        'syncSqliteFile',
        'registerProject',
        'launch',
      ];
      if (
        starters.includes(name) &&
        !(name === 'launch' && !rel.endsWith('dashboard-upload-scheduler.ts'))
      ) {
        let p = node.parent;
        while (p && ts.isParenthesizedExpression(p)) p = p.parent;
        const awaited =
          ts.isAwaitExpression(p) ||
          ts.isReturnStatement(p) ||
          (ts.isArrowFunction(p) && p.body === node);
        const dropped = ts.isExpressionStatement(p) || ts.isVoidExpression(p);
        out.push(
          `${rel}:${line(node)} ${name} ${awaited ? 'awaited/returned' : dropped ? 'NOT AWAITED (dropped)' : 'held: ' + ts.SyntaxKind[p.kind]}`
        );
      }
      if (
        /^process\.exit$/.test(callee) ||
        (/^process\.(on|once)$/.test(callee) &&
          /SIG|exit|beforeExit/.test(node.arguments[0]?.getText(sf) ?? '')) ||
        /stdin\.(once|on)$/.test(callee)
      )
        out.push(
          `${rel}:${line(node)} EXIT-PATH ${callee}(${node.arguments[0]?.getText(sf) ?? ''})`
        );
    }
    if (which === 'active' && ts.isCallExpression(node)) {
      const name = node.expression.getText(sf).split('.').pop();
      const set = [
        'activeProtocolCopies',
        'protocolBlockers',
        'nextWriteProtocol',
        'currentWriteProtocol',
        'protocolSwitch',
        'readerRefusal',
        'readableChanges',
        'reportedCopy',
        'ownersOtherCopies',
        'rememberCopyReport',
        'protocolForWrite',
        'keptOut',
        'latestReplicas',
      ];
      if (set.includes(name)) out.push(`${rel}:${line(node)} ${name}`);
      if (name === 'recordOwnChanges')
        out.push(
          `${rel}:${line(node)} recordOwnChanges${/admittingReads/.test(node.getText(sf)) ? ' (admittingReads)' : ''}`
        );
      if (name === 'changesSince' && node.arguments.length >= 3)
        out.push(`${rel}:${line(node)} changesSince(recipient)`);
    }
    if (which === 'remedy' && ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sf).replace(/['"]/g, '');
      if (['suggestion', 'hint', 'message'].includes(key)) {
        const text = textOf(node.initializer, sf);
        const re =
          /set[- ]aside|setting it aside|set it aside|sharing page|owner's page|project's page|on the dashboard|confirms? recovery/i;
        if (
          re.test(text) &&
          (key !== 'message' || /\b(Ask|Run|run|preview|Preview|have the)\b/.test(text))
        )
          out.push(`${rel}:${line(node)} ${key}: ${text.replace(/\s+/g, ' ').slice(0, 170)}`);
      }
    }
    if (
      which === 'status410' &&
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === 'fetch'
    ) {
      // Find the enclosing method and whether its body handles 410.
      let fn = node.parent;
      while (
        fn &&
        !ts.isMethodDeclaration(fn) &&
        !ts.isFunctionDeclaration(fn) &&
        !ts.isArrowFunction(fn)
      )
        fn = fn.parent;
      const body = fn ? fn.getText(sf) : '';
      const name = fn && fn.name ? fn.name.getText(sf) : '(anonymous)';
      out.push(
        `${rel}:${line(node)} fetch in ${name}: 410 ${/\b410\b|PROJECT_DELETED/.test(body) ? 'handled' : 'NOT handled'}; generic non-OK -> ${/dashboardError\(/.test(body) ? 'dashboardError' : /!response\.ok/.test(body) ? 'other' : 'none'}`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(out.join('\n'));
console.log(`# ${which}: ${out.length} sites over ${uniq.length} tracked src .ts files`);

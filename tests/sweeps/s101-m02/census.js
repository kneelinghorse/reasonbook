// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Count protocol activity, admission and egress candidates before the m02 repair.
// ABOUTME: Pair the ratified source AST predicate with a whole tracked UTF-8 lexical census.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { TextDecoder } = require('util');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const names = [
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
  'recordOwnChanges',
  'changesSince',
];
const predicate = new RegExp('\\b(?:' + names.join('|') + ')\\s*\\(');
const scopes = {};
let utf8Files = 0;
let matchingLines = 0;
for (const file of files) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  utf8Files++;
  for (const line of text.split('\n')) {
    if (!predicate.test(line)) continue;
    matchingLines++;
    const scope = file.split('/')[0];
    scopes[scope] = (scopes[scope] || 0) + 1;
  }
}
const sourceAst = execFileSync(
  'node',
  ['rbook/research/2026-10-s101-probes/predicates/sweep.cjs', '.', 'active'],
  { encoding: 'utf8' }
)
  .trim()
  .split('\n');
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      wholeTree: {
        predicate:
          'git ls-files -z, all extensions, valid UTF-8 without NUL; one matching line per listed function-name followed by opening parenthesis',
        names,
        utf8Files,
        matchingLines,
        scopes,
      },
      sourceAst: {
        predicate:
          'ratified sweep.cjs active: named calls in tracked src TypeScript; changesSince only with at least three arguments',
        count: sourceAst.length - 1,
        sites: sourceAst.slice(0, -1),
        summary: sourceAst[sourceAst.length - 1],
      },
    },
    null,
    2
  ) + '\n'
);

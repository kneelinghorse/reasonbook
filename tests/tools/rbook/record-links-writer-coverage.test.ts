// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every executable decision/learning INSERT must keep an explicit citation-write owner.
// ABOUTME: AST discovery excludes documentation, while mutation controls expose new or bypassed writers.

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../src');
const owners: Record<string, { sites: number; guard: string; caller: string }> = {
  'tools/rbook/decision-write.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'record/capture own the synchronous transaction',
  },
  'tools/rbook/rbook-session-capture.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'capture owns authoritative append plus learning and links',
  },
  'tools/rbook/rbook-session-complete.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'close owns its decision batch before lifecycle writes',
  },
  'tools/rbook/rbook-mission-complete.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'each optional mission row owns a transaction',
  },
  'tools/rbook/sync-merge.ts': {
    sites: 2,
    guard: 'requireRecordLinks(',
    caller: 'retained standalone helper owns a transaction; legacy pull/bootstrap callers retired',
  },
};

// Scope: executable SQL literals/templates throughout src TypeScript. The raw seven-match
// sweep includes genesis-columns.ts's SQL documentation example, which the AST excludes.
// Complement: SQL assembled wholly at runtime, other-language scripts and test fixtures are
// not governed here; their pre-edit inventory/classification lives in the m06 sweep and map.
function sources(dir = root): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const item of sources(full)) result.set(...item);
    else if (entry.name.endsWith('.ts'))
      result.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
  }
  return result;
}

function sites(source: string): number {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:strategic_decisions|learnings)\b/i.test(node.getText(ast))
    )
      count++;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return count;
}

function violations(files: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [file, source] of files) {
    const count = sites(source);
    if (!count) continue;
    const owner = owners[file];
    if (!owner || count !== owner.sites) failures.push(`${file}: unclassified INSERT`);
    else if (!source.includes(owner.guard)) failures.push(`${file}: missing required links`);
  }
  for (const entry of [
    'rbook-decisions-record',
    'rbook-decisions-update',
    'rbook-session-capture',
    'rbook-session-complete',
    'rbook-mission-complete',
  ]) {
    const source = files.get(`tools/rbook/${entry}.ts`) ?? '';
    // s96-m11: these writers own a write transaction, which takes the write lock at BEGIN.
    // s96-m03: recordedTransaction is that transaction, recorded on a shared record.
    if (
      !source.includes('prepareRecordLinkWrite(') ||
      !(source.includes('.writeTransaction(') || source.includes('recordedTransaction('))
    )
      failures.push(`${entry}: missing required unit`);
  }
  // s96-m08: pull and bootstrap now refuse before any row write; their retired batch
  // repair/transaction obligations leave this inventory. The two retained sync-merge INSERTs
  // remain governed by their required-links owner above, so the executable site count stays six.
  return failures;
}

it('derives all six executable INSERT sites and requires their writer ownership', () => {
  const files = sources();
  expect([...files.values()].reduce((count, source) => count + sites(source), 0)).toBe(6);
  expect(violations(files)).toEqual([]);
});

it('rejects an added writer, duplicate INSERT and removed required repair', () => {
  const files = sources();
  const sql = 'const sql = `INSERT INTO learnings(content) VALUES (?)`;';
  files.set('uncovered.ts', sql);
  expect(violations(files)).toContain('uncovered.ts: unclassified INSERT');
  const source = files.get('tools/rbook/decision-write.ts')!;
  files.set('tools/rbook/decision-write.ts', source + '\n' + sql);
  expect(violations(files)).toContain('tools/rbook/decision-write.ts: unclassified INSERT');
  const bypassed = source.replace('requireRecordLinks(', 'bypassedRepair(');
  expect(bypassed).not.toBe(source);
  files.set('tools/rbook/decision-write.ts', bypassed);
  expect(violations(files)).toContain('tools/rbook/decision-write.ts: missing required links');
  const merge = files.get('tools/rbook/sync-merge.ts')!;
  const bypassedMerge = merge.replace('requireRecordLinks(', 'bypassedRepair(');
  expect(bypassedMerge).not.toBe(merge);
  files.set('tools/rbook/sync-merge.ts', bypassedMerge);
  expect(violations(files)).toContain('tools/rbook/sync-merge.ts: missing required links');
});

it('rejects a record writer back on a deferred transaction (s96-m11)', () => {
  const files = sources();
  const record = files.get('tools/rbook/rbook-decisions-record.ts')!;
  const deferred = record
    .replace(/\.writeTransaction\(/g, '.transaction(')
    .replace(/recordedTransaction\(client, /g, 'client.transaction(');
  expect(deferred).not.toBe(record);
  files.set('tools/rbook/rbook-decisions-record.ts', deferred);
  expect(violations(files)).toContain('rbook-decisions-record: missing required unit');
});

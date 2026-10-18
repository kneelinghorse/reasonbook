// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Discover every TypeScript SQL decision insert and require shaped input or a reasoned exemption.
// ABOUTME: Mutation controls catch new writers, duplicate sites and a removed shared-field splice.

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
const root = path.resolve(__dirname, '../../../src');
const exemptions: Record<string, string> = {
  'tools/rbook/rbook-mission-complete.ts':
    'Legacy decisions[] contains headlines only; nullable fields remain unknown.',
  'tools/rbook/rbook-session-complete.ts':
    'Defensive session extraction contains headlines only; approval cannot be invented.',
  'tools/rbook/sync-merge.ts':
    'The retained legacy merge DTO lacks shape/evidence/approval; preserve origin provenance and NULL fields.',
};
// Scope: SQL literals/templates in all src TypeScript. Complement: dynamic SQL assembled outside
// literals, non-TypeScript historical writers, scripts and fixtures; these are explicitly outside
// the runtime TypeScript gate, and their treatment is in the pre-edit m04 writer map.
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
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+strategic_decisions\b/i.test(node.getText(ast))
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
    if (count !== 1 || (file !== 'tools/rbook/decision-write.ts' && !exemptions[file]))
      failures.push(file);
    if (
      file === 'tools/rbook/decision-write.ts' &&
      !/Object\.entries\(storedDecisionFields\(input\)\)/.test(source)
    )
      failures.push(`${file}: missing fields`);
  }
  return failures;
}
it('covers every discovered production writer, including deliberate text-only and sync omissions', () => {
  const files = sources();
  expect([...files.values()].reduce((count, source) => count + sites(source), 0)).toBe(4);
  expect(violations(files)).toEqual([]);
  // s96-m08: pull and bootstrap refuse before writing and no longer require the shape migration.
  // The retained merge helper remains an explicit omission above; the SQL INSERT count stays four.
  for (const file of [
    'rbook-decisions-record',
    'rbook-session-capture',
    'rbook-mission-complete',
    'rbook-session-complete',
  ]) {
    expect(files.get(`tools/rbook/${file}.ts`)).toMatch(
      /ensureDecisionShapeColumns\((?:client|db)\)/
    );
  }
});
it('rejects new or duplicate writers and removed shared shape input', () => {
  const files = sources();
  const sql = 'const x = `INSERT INTO strategic_decisions (decision_text) VALUES (?)`;';
  files.set('tools/rbook/uncovered.ts', sql);
  expect(violations(files)).toContain('tools/rbook/uncovered.ts');
  files.set(
    'tools/rbook/rbook-session-complete.ts',
    files.get('tools/rbook/rbook-session-complete.ts') + '\n' + sql
  );
  expect(violations(files)).toContain('tools/rbook/rbook-session-complete.ts');
  const writer = files.get('tools/rbook/decision-write.ts')!;
  const withoutFields = writer.replace('storedDecisionFields(input)', '{}');
  expect(withoutFields).not.toBe(writer);
  files.set('tools/rbook/decision-write.ts', withoutFields);
  expect(violations(files)).toContain('tools/rbook/decision-write.ts: missing fields');
});

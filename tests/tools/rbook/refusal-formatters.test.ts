// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Offered refusal remedies must reach text across every formatter, including router fallbacks.
// ABOUTME: The fifteen F8 flags are exercised separately; sync health is checked through its non-envelope producer.
import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as ts from 'typescript';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

const root = path.resolve(__dirname, '../../..');
const remedy = 'F8_REMEDY: inspect the current state before retrying.';
const message = 'F8_MESSAGE: this operation was refused.';
const flagged = [
  'formatProjectIdentityViewForLLM',
  'formatProjectIdentityUpdateForLLM',
  'formatContextSearchForLLM',
  'formatReconciliationForLLM',
  'formatPgOrphanReportForLLM',
  'formatPurgeForLLM',
  'formatProjectSweepForLLM',
  'formatProjectUpdateForLLM',
  'formatSprintAnalyticsForLLM',
  'formatAuthForLLM',
  'formatConstraintsForLLM',
  'formatFeedbackForLLM',
  'formatWhoamiForLLM',
  'formatNextStepsForLLM',
  'formatSyncHealthForLLM',
];
const inventory = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const rows: Array<{
      file: string;
      name: string;
      envelope: number;
      actions: string[];
      exported: boolean;
    }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && /^format\w*ForLLM$/.test(node.name.text)) {
        const actions: string[] = [];
        const cases = (child: ts.Node): void => {
          if (ts.isCaseClause(child) && ts.isStringLiteral(child.expression))
            actions.push(child.expression.text);
          ts.forEachChild(child, cases);
        };
        if (node.parameters.some((param) => param.name.getText(source) === 'action')) cases(node);
        rows.push({
          file,
          name: node.name.text,
          envelope: node.parameters.findIndex((param) =>
            /\bRbookToolResult\b/.test(param.type?.getText(source) ?? '')
          ),
          actions,
          exported: !!node.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
          ),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return rows;
  });

async function render(row: (typeof inventory)[number], result: RbookToolResult): Promise<string[]> {
  const module = require(path.join(root, row.file));
  if (row.name === 'formatSyncHealthForLLM') {
    const reconcile = require('../../../src/tools/rbook/rbook-db-backfill');
    const spy = jest.spyOn(reconcile, 'rbookDbReconcile').mockResolvedValueOnce(result as never);
    try {
      return [module.formatSyncHealthForLLM(await module.checkSyncHealth())];
    } finally {
      spy.mockRestore();
    }
  }
  if (!row.exported) {
    expect(row.file).toBe('src/tools/rbook/rbook-message.ts');
    const action = row.name.replace(/^format|ForLLM$/g, '').toLowerCase();
    return [module.formatMessageForLLM(action, result)];
  }
  expect(row.envelope).toBeGreaterThanOrEqual(0);
  return ['unknown-action', ...row.actions].map((action) => {
    const args = row.envelope === 0 ? [result] : [action, result];
    return module[row.name](...args);
  });
}

describe('all F8 refusal text paths', () => {
  it('covers all 95 declarations and the original fifteen flagged sites without silent exclusions', () => {
    // s102-m04 adds the reopen formatter; it is exercised by the same refusal matrix.
    expect(inventory).toHaveLength(95);
    expect(
      inventory
        .filter((row) => flagged.includes(row.name))
        .map((row) => row.name)
        .sort()
    ).toEqual([...flagged].sort());
    expect(inventory.filter((row) => row.envelope < 0).map((row) => row.name)).toEqual([
      'formatSyncHealthForLLM',
    ]);
  });

  it.each(inventory)(
    '$name renders the offered remedy in every action/default refusal',
    async (row) => {
      for (const code of ['F8_REFUSAL', 'INVALID_ACTION']) {
        const result = Object.freeze({
          success: false,
          error: Object.freeze({ code, message, suggestion: remedy }),
        });
        for (const text of await render(row, result)) {
          expect(text).toContain(message);
          expect(text.split(remedy)).toHaveLength(2);
        }
      }
    }
  );

  it.each(inventory.filter((row) => flagged.includes(row.name)))(
    '$name keeps absent/empty remedies absent',
    async (row) => {
      for (const suggestion of [undefined, '']) {
        const result = { success: false, error: { code: 'F8_REFUSAL', message, suggestion } };
        for (const text of await render(row, result)) {
          expect(text).toContain(message);
          expect(text).not.toContain('Suggestion:');
          expect(text).not.toContain('undefined');
        }
      }
    }
  );
});

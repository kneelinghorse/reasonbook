// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s88-m04 RED contract for capture IDs, durability receipts, evergreen-at-write, and supported supersession.

// Enter through published routers; SQL verifies state but never supplies a follow-up call's ID.
// The structured receipt describes the projection, not the always-immediate capture blob, and
// separates timing from outcome so a rejected projection cannot claim materialized success.

import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { seedRbookDb } from '../../helpers/seedRbookDb';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import {
  rbookSession,
  formatSessionForLLM,
  type RbookSessionParams,
} from '../../../src/tools/rbook/rbook-session';

type MaterializationTiming = 'immediate' | 'session-close';
type MaterializationOutcome = 'materialized' | 'existing' | 'deferred' | 'failed';
type MaterializationTarget =
  | 'strategic_decisions'
  | 'learnings'
  | 'constraints'
  | 'master_context.context_notes'
  | 'next_steps';

interface StructuredMaterializationReceipt {
  [key: string]: unknown;
  timing: MaterializationTiming;
  outcome: MaterializationOutcome;
  target: MaterializationTarget;
}

interface CaptureReceipt {
  category: string;
  decisionId?: number;
  learningId?: number;
  decisionExtractionFailed?: string;
  learningExtracted?: boolean;
  supersessionCandidates?: Array<{ id: number }>;
  supersessionMessage?: string;
  structuredMaterialization?: StructuredMaterializationReceipt;
  writeFailures?: Array<{ op: string; code: string; message: string }>;
}

interface CaptureArgs {
  category: 'decision' | 'learning' | 'constraint' | 'context' | 'next-step';
  content: string;
  evergreen?: boolean;
}

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

function withDb<T>(projectRoot: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function makeActiveStore(title: string): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-s88-m04-capture-'));
  roots.push(projectRoot);
  seedRbookDb(projectRoot, {
    projectName: 's88-m04 capture receipt fixture',
    projectId: 's88-m04-capture-fixture',
  });

  const started = await rbookSession({
    action: 'start',
    type: 'planning',
    title,
    autoRefreshMasterContext: false,
    projectRoot,
  });
  if (!started.success) {
    throw new Error(`fixture session failed to start: ${JSON.stringify(started.error)}`);
  }
  return projectRoot;
}

async function capture(projectRoot: string, args: CaptureArgs) {
  // The future-surface cast lets the pre-fix router fail at runtime, not at TypeScript compile time.
  return rbookSession({
    action: 'capture',
    category: args.category,
    content: args.content,
    ...(args.evergreen !== undefined ? { evergreen: args.evergreen } : {}),
    projectRoot,
  } as unknown as RbookSessionParams);
}

function receiptOf(result: Awaited<ReturnType<typeof rbookSession>>): CaptureReceipt {
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
  return result.data as unknown as CaptureReceipt;
}

function expectMaterialization(
  receipt: CaptureReceipt,
  expected: StructuredMaterializationReceipt
): void {
  expect(receipt.structuredMaterialization).toMatchObject(expected);
}

describe('s88-m04 rbook_session(capture) public receipt contract', () => {
  it('returns the real decision row ID and reports a successful immediate projection', async () => {
    const projectRoot = await makeActiveStore('decision ID receipt');
    const content = 'Use returned IDs as the supported decision handle';
    const result = await capture(projectRoot, {
      category: 'decision',
      content,
    });
    const receipt = receiptOf(result);

    expect(receipt.decisionId).toEqual(expect.any(Number));
    const stored = withDb(
      projectRoot,
      (db) =>
        db
          .prepare('SELECT id, decision_text FROM strategic_decisions WHERE id = ?')
          .get(receipt.decisionId) as { id: number; decision_text: string } | undefined
    );
    expect(stored).toEqual({
      id: receipt.decisionId,
      decision_text: 'Use returned IDs as the supported decision handle',
    });
    expectMaterialization(receipt, {
      target: 'strategic_decisions',
      timing: 'immediate',
      outcome: 'materialized',
    });

    const rendered = formatSessionForLLM('capture', result);
    expect(rendered).toContain(`Decision ID: #${receipt.decisionId}`);
    expect(rendered.toLowerCase()).toContain('immediate');

    const duplicate = receiptOf(await capture(projectRoot, { category: 'decision', content }));
    expect(duplicate.decisionId).toBe(receipt.decisionId);
    expectMaterialization(duplicate, {
      target: 'strategic_decisions',
      timing: 'immediate',
      outcome: 'existing',
    });
  });

  it('returns the next-step row ID at capture, and the close keeps that one row (s100-m03)', async () => {
    // s100-m03 (#712): this projection was deferred to the session's close until 4.2.1, so a next step
    // captured in a session that stayed open was invisible to every reader of next_steps.
    const projectRoot = await makeActiveStore('next-step ID receipt');
    const content = 'Write this next step the moment it is captured';
    const result = await capture(projectRoot, { category: 'next-step', content });
    const receipt = receiptOf(result) as CaptureReceipt & { nextStepId?: number };

    expect(receipt.nextStepId).toEqual(expect.any(Number));
    const rowsOf = () =>
      withDb(
        projectRoot,
        (db) =>
          db.prepare('SELECT id, status FROM next_steps WHERE content = ?').all(content) as Array<{
            id: number;
            status: string;
          }>
      );
    expect(rowsOf()).toEqual([{ id: receipt.nextStepId, status: 'pending' }]);
    expectMaterialization(receipt, {
      target: 'next_steps',
      timing: 'immediate',
      outcome: 'materialized',
    });
    const rendered = formatSessionForLLM('capture', result);
    expect(rendered).toContain(`Next step ID: #${receipt.nextStepId}`);
    expect(rendered.toLowerCase()).not.toContain('session close');

    const completed = await rbookSession({
      action: 'complete',
      summary: 'Close the next-step receipt fixture',
      projectRoot,
    });
    expect(completed.success).toBe(true);
    expect(rowsOf()).toEqual([{ id: receipt.nextStepId, status: 'pending' }]);
  });

  it('completes supersession through supported routers using only returned IDs', async () => {
    // s92-m04: the receipt no longer OFFERS the old row (the automatic offer was retired); the
    // agent that knows what it replaced names it. Both ids still come from capture receipts.
    const projectRoot = await makeActiveStore('supported supersession');
    const oldResult = await capture(projectRoot, {
      category: 'decision',
      content: 'Use SQLite for persistent database storage in capture receipt tests',
    });
    const oldReceipt = receiptOf(oldResult);
    expect(oldReceipt.decisionId).toEqual(expect.any(Number));
    if (typeof oldReceipt.decisionId !== 'number') return;

    const newResult = await capture(projectRoot, {
      category: 'decision',
      content:
        'Replace SQLite persistent database storage with PostgreSQL in capture receipt tests',
    });
    const newReceipt = receiptOf(newResult);
    expect(newReceipt.decisionId).toEqual(expect.any(Number));
    if (typeof newReceipt.decisionId !== 'number') return;

    expect(newReceipt.supersessionCandidates).toBeUndefined();
    expect(newReceipt.supersessionMessage).toBeUndefined();
    expect(formatSessionForLLM('capture', newResult)).not.toContain('supersededBy=');

    // No SQL lookup supplies either argument: both IDs came from capture receipts.
    const updated = await rbookDecisions({
      action: 'update',
      decisionId: oldReceipt.decisionId,
      supersededBy: newReceipt.decisionId,
      projectRoot,
    });
    expect(updated.success).toBe(true);

    const stored = withDb(
      projectRoot,
      (db) =>
        db
          .prepare('SELECT status, superseded_by FROM strategic_decisions WHERE id = ?')
          .get(oldReceipt.decisionId) as { status: string; superseded_by: number }
    );
    expect(stored).toEqual({ status: 'superseded', superseded_by: newReceipt.decisionId });
  });

  it('returns the learning ID and applies explicit evergreen flips while omission preserves', async () => {
    const projectRoot = await makeActiveStore('evergreen receipt semantics');
    const content = 'Standing capture rules remain evergreen until explicitly changed';

    const created = receiptOf(
      await capture(projectRoot, { category: 'learning', content, evergreen: true })
    );
    expect(created.learningId).toEqual(expect.any(Number));
    if (typeof created.learningId !== 'number') return;
    expectMaterialization(created, {
      target: 'learnings',
      timing: 'immediate',
      outcome: 'materialized',
    });
    expect(
      withDb(projectRoot, (db) =>
        db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(created.learningId)
      )
    ).toEqual({ evergreen: 1 });

    const cleared = receiptOf(
      await capture(projectRoot, { category: 'learning', content, evergreen: false })
    );
    expect(cleared.learningId).toBe(created.learningId);
    expect(cleared.learningExtracted).toBe(false);
    expectMaterialization(cleared, {
      target: 'learnings',
      timing: 'immediate',
      outcome: 'existing',
    });
    expect(
      withDb(projectRoot, (db) =>
        db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(created.learningId)
      )
    ).toEqual({ evergreen: 0 });

    const restored = receiptOf(
      await capture(projectRoot, { category: 'learning', content, evergreen: true })
    );
    expect(restored.learningId).toBe(created.learningId);
    expect(
      withDb(projectRoot, (db) =>
        db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(created.learningId)
      )
    ).toEqual({ evergreen: 1 });

    const omitted = receiptOf(await capture(projectRoot, { category: 'learning', content }));
    expect(omitted.learningId).toBe(created.learningId);
    const preserved = withDb(projectRoot, (db) =>
      db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(created.learningId)
    );
    expect(preserved).toEqual({ evergreen: 1 });
  });

  it('migrates a legacy learnings table before writing evergreen through the router', async () => {
    const projectRoot = await makeActiveStore('legacy evergreen migration');
    withDb(projectRoot, (db) => {
      const columns = (
        db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>
      ).map((column) => column.name);
      // Today's seed is already pre-s61; keep this total if the canonical schema later catches up.
      if (columns.includes('evergreen')) {
        db.exec('DROP INDEX IF EXISTS idx_learnings_evergreen');
        db.exec('ALTER TABLE learnings DROP COLUMN evergreen');
      }
    });
    expect(
      withDb(projectRoot, (db) =>
        (db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      )
    ).not.toContain('evergreen');

    const receipt = receiptOf(
      await capture(projectRoot, {
        category: 'learning',
        content: 'Legacy stores accept evergreen on the first capture',
        evergreen: true,
      })
    );
    expect(receipt.learningId).toEqual(expect.any(Number));
    if (typeof receipt.learningId !== 'number') return;

    const migrated = withDb(projectRoot, (db) => ({
      columns: (db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>).map(
        (column) => column.name
      ),
      row: db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(receipt.learningId),
    }));
    expect(migrated.columns).toContain('evergreen');
    expect(migrated.row).toEqual({ evergreen: 1 });
  });

  it('rejects evergreen on a non-learning capture instead of silently dropping it', async () => {
    const projectRoot = await makeActiveStore('invalid evergreen category');
    const result = await capture(projectRoot, {
      category: 'decision',
      content: 'A decision cannot be marked as a learning-level evergreen rule',
      evergreen: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(result.error?.field).toBe('evergreen');
    expect(
      withDb(projectRoot, (db) =>
        db
          .prepare('SELECT COUNT(*) AS count FROM strategic_decisions WHERE decision_text = ?')
          .get('A decision cannot be marked as a learning-level evergreen rule')
      )
    ).toEqual({ count: 0 });
  });

  it('rolls back the capture when its required decision projection fails', async () => {
    const projectRoot = await makeActiveStore('failed decision projection');
    withDb(projectRoot, (db) => {
      db.exec(`
        CREATE TRIGGER force_s88_decision_insert_failure
        BEFORE INSERT ON strategic_decisions
        BEGIN
          SELECT RAISE(FAIL, 'forced s88 decision insert failure');
        END;
      `);
    });

    const before = withDb(projectRoot, (db) =>
      db.prepare('SELECT id,captures FROM sessions ORDER BY id').all()
    );
    const result = await capture(projectRoot, {
      category: 'decision',
      content: 'This required capture and decision must commit together',
    });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error?.message).toContain('forced s88 decision insert failure');
    expect(result.error?.suggestion).toBeTruthy();
    expect(
      withDb(projectRoot, (db) => db.prepare('SELECT id,captures FROM sessions ORDER BY id').all())
    ).toEqual(before);

    const rendered = formatSessionForLLM('capture', result);
    expect(rendered).toContain('Failed');
    expect(rendered).not.toContain('Decision ID:');
    expect(
      withDb(projectRoot, (db) =>
        db
          .prepare('SELECT COUNT(*) AS count FROM strategic_decisions WHERE decision_text = ?')
          .get('This required capture and decision must commit together')
      )
    ).toEqual({ count: 0 });
  });
});

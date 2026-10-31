// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — every record the opener's staleness advisory counts has a surface that shows its
// ABOUTME: age: rbook_decisions(action="review") lists learnings too, and runs under the review role.

/**
 * The m11 contract critic's probe: a store with one learning past the review age and one marked
 * stale got the advisory "run rbook_decisions(action="review") to see each one with its age", and the
 * review then answered "No decisions need attention", showing neither. Under the review role the
 * review was refused outright, because it was classified as a write.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { READ_ONLY_AGENT_ENV } from '../../../src/tools/rbook/read-only-agent-guard';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let projectRoot: string;
const savedRole = process.env[READ_ONLY_AGENT_ENV];

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m11-review-learnings-'));
  const dbPath = seedRbookDb(projectRoot, { projectName: 'review learnings' });
  reidentifyRbookTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    db.exec('ALTER TABLE learnings ADD COLUMN last_reviewed_at TEXT');
    // s97-m13: sprint-1..30 closed in label order, two weeks apart; review ages count the closes.
    const sprint = db.prepare(
      'INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)'
    );
    for (let n = 1; n <= 31; n++)
      sprint.run(
        `sprint-${n}`,
        `S${n}`,
        n === 31 ? 'Active' : 'Completed',
        n === 31 ? null : new Date(Date.now() - ((31 - n) * 14 + 1) * 86400_000).toISOString()
      );
    const learning = db.prepare(
      `INSERT INTO learnings (id, content, created_at, sprint_id, status)
       VALUES (?, ?, '2026-01-01T00:00:00Z', ?, ?)`
    );
    learning.run(1, 'Old learning nobody has reviewed.', 'sprint-3', 'active');
    learning.run(2, 'A learning someone marked stale.', 'sprint-29', 'stale');
    learning.run(3, 'A recent learning.', 'sprint-30', 'active');
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
});

afterEach(() => {
  if (savedRole === undefined) delete process.env[READ_ONLY_AGENT_ENV];
  else process.env[READ_ONLY_AGENT_ENV] = savedRole;
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const textOf = (result: Awaited<ReturnType<typeof executeMissionProtocolTool>>): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

describe('s93-m11 — the review shows the learnings the advisory counts', () => {
  it('the opener counts them and names the review; the review shows each with its age', async () => {
    const onboard = await executeMissionProtocolTool(
      'rbook_agent_onboard',
      { projectRoot },
      context
    );
    expect(textOf(onboard)).toContain('0 active decision(s) and 1 learning(s) are 20+ sprints old');
    expect(textOf(onboard)).toContain('0 decision(s) and 1 learning(s) are marked stale');
    expect(textOf(onboard)).toContain('see each decision and learning with its age');

    const review = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'review', projectRoot },
      context
    );
    const text = textOf(review);
    expect(review.isError).not.toBe(true);
    // s106-m03: the review pages; this one page holds both, and says they are all of them.
    expect(text).toContain('**📚 Learnings: showing 1–2 of 2 learnings**');
    expect(text).toContain(
      '#1 [sprint-3] active, 27 sprints old — Old learning nobody has reviewed.'
    );
    expect(text).toContain(
      '#2 [sprint-29] stale, 1 sprints old — A learning someone marked stale.'
    );
    expect(text).not.toContain('A recent learning.');
    expect(text).toContain('rbook_learnings(action="reaffirm", learningId=…)');
    const structured = review.structuredContent as {
      data: { learnings: Array<{ id: number; sprintAge: number; suggestedAction: string }> };
    };
    expect(structured.data.learnings.map((l) => [l.id, l.sprintAge, l.suggestedAction])).toEqual([
      [1, 27, 'reaffirm'],
      [2, 1, 'review'],
    ]);
  });

  it('runs under the review role, which the opener sends to it', async () => {
    process.env[READ_ONLY_AGENT_ENV] = 'review';
    const review = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'review', projectRoot },
      context
    );
    expect(review.isError).not.toBe(true);
    expect(textOf(review)).toContain('**📚 Learnings: showing 1–2 of 2 learnings**');
  });
});

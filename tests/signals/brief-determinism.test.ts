// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m03 — the brief from real store files is a function of the files and now: the same bytes at a now 30 days off
// ABOUTME: the wall clock, another brief after a write, and every id it names resolves to a row of the store it names.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildBrief, readSignals, renderBrief, type SignalsReport } from '../../src/signals';
import { withClient } from '../../src/tools/rbook/client';
import { ensureProposalsTable, insertDraft, rawRunner } from '../../src/tools/rbook/proposals';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import {
  ensureLearningsTable,
  ensureReviewTimestamps,
} from '../../src/tools/rbook/schema-migrations';

const DAY = 86_400_000;
const WALL = Date.now();
/** Thirty days off the wall clock, as the design asks, so a rule or renderer reading it fails. */
const NOW = WALL - 30 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
const saved = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
beforeAll(() => {
  process.env.RBOOK_CONFIG_DIR = tmp('rbook-brief-det-home-');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
});
afterAll(() => {
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function store(name: string): Promise<string> {
  const root = tmp('rbook-brief-det-');
  expect((await rbookProjectInit({ projectRoot: root, projectName: name } as never)).success).toBe(
    true
  );
  const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  await withClient(
    (client) => {
      ensureLearningsTable(client);
      ensureReviewTimestamps(client);
      return { success: true, data: null };
    },
    { dbPath }
  );
  return dbPath;
}

/** Rows that place a store in four sections at NOW: drafts, a block, closes and a quiet stamp. */
function seed(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    for (const days of [3, 1])
      insertDraft(run, {
        text: 'A choice for the operator.',
        kind: 'decision',
        sourceSession: null,
        assistantExcerpt: null,
        evidence: [],
        outsideContent: null,
        createdAt: iso(NOW - days * DAY),
      });
    db.prepare(
      "INSERT INTO missions (id, name, status, domain_fields) VALUES ('m-wait', 'Waiting', 'Blocked', ?)"
    ).run(JSON.stringify({ blockedSince: iso(NOW - 12 * DAY) }));
    const close = db.prepare(
      "INSERT INTO sprints (id, title, status, end_date) VALUES (?, 'Closed', 'Completed', ?)"
    );
    for (let i = 0; i < 4; i++) close.run(`c-${i}`, iso(NOW - (40 - i * 8) * DAY));
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('Carry the brief.', 'pending', ?)"
    ).run(iso(NOW - 50 * DAY));
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, status) VALUES ('Moved this week.', ?, 'active')"
    ).run(iso(NOW - 2 * DAY));
  } finally {
    db.close();
  }
}

/** Whether a row id the brief names is a row of the store. */
function resolves(dbPath: string, id: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const [, prefix, number] = /^(P|n:|d:|l:|c:|f:)(\d+)$/.exec(id) ?? [];
    const table = {
      P: 'proposals',
      'n:': 'next_steps',
      'd:': 'strategic_decisions',
      'l:': 'learnings',
      'c:': 'constraints',
      'f:': 'agent_feedback',
    }[prefix ?? ''];
    if (table)
      return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(number)));
    return Boolean(db.prepare('SELECT 1 FROM missions WHERE id = ?').get(id));
  } finally {
    db.close();
  }
}

describe('the brief from real store files (s97-m03)', () => {
  it('gives the same bytes for the same files and now, and another brief after a write', async () => {
    const one = await store('One');
    const two = await store('Two');
    seed(one);
    const reports = (): SignalsReport[] =>
      [one, two].map((file) => readSignals(file, { now: NOW }));
    const first = renderBrief(reports(), { now: NOW, windowDays: 7 });
    expect(renderBrief(reports(), { now: NOW, windowDays: 7 })).toBe(first);
    expect(first).toContain(
      `# Weekly brief, ${iso(NOW - 7 * DAY).slice(0, 10)} to ${iso(NOW).slice(0, 10)}`
    );
    expect(first).toMatch(/One \(.*\): 2 drafts \(P1, P2\), oldest/);
    expect(first).toMatch(/1 blocked mission \(m-wait\)/);
    expect(first).toMatch(/1 decision/);
    // A write the brief should see: a third draft in store two.
    const db = new Database(two);
    const run = rawRunner(db);
    ensureProposalsTable(run);
    insertDraft(run, {
      text: 'Another choice.',
      kind: 'decision',
      sourceSession: null,
      assistantExcerpt: null,
      evidence: [],
      outsideContent: null,
      createdAt: iso(NOW - DAY),
    });
    db.close();
    expect(renderBrief(reports(), { now: NOW, windowDays: 7 })).not.toBe(first);
  });

  it('names only ids that resolve to a row of the store each line names', async () => {
    const one = await store('Resolving');
    seed(one);
    const report = readSignals(one, { now: NOW });
    const brief = buildBrief([report], { now: NOW, windowDays: 7 });
    const ids = brief.sections.flatMap((part) => part.items.flatMap((item) => item.ids));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids)
      expect({ id, resolves: resolves(one, id) }).toEqual({ id, resolves: true });
  });
});

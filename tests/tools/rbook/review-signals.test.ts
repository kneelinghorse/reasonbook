// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — the review's portfolio carries other projects' signals that need a person, driven at the MCP dispatch
// ABOUTME: boundary: counted with this machine's draft runtime, this project's own left out, names framed, inside 4,096 bytes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { openDraftRuntime, recordSessionStart } from '../../../src/tools/rbook/draft-runtime';
import { ensureProposalsTable, insertDraft, rawRunner } from '../../../src/tools/rbook/proposals';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import {
  finishDigest,
  formatReviewForLLM,
  rbookReview,
  type PortfolioSection,
  type RbookReviewResult,
} from '../../../src/tools/rbook/rbook-review';
import { formatReviewPresentation } from '../../../src/tools/rbook/review-presentation';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
const savedEnv = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
beforeAll(async () => {
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  context = await buildMissionProtocolContext();
});
beforeEach(() => {
  process.env.RBOOK_CONFIG_DIR = tmp('rbook-review-signals-home-');
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});
afterAll(() => {
  if (savedEnv.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedEnv.config;
  if (savedEnv.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = savedEnv.sync;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Project {
  readonly root: string;
  readonly dbPath: string;
  readonly projectId: string;
}

/** A project as init makes it, which also registers it on this machine. */
async function project(name: string): Promise<Project> {
  const root = tmp('rbook-review-signals-');
  expect((await rbookProjectInit({ projectRoot: root, projectName: name } as never)).success).toBe(
    true
  );
  const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  const db = new Database(dbPath);
  try {
    const { value } = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as {
      value: string;
    };
    return { root, dbPath, projectId: value };
  } finally {
    db.close();
  }
}

function needsAPerson(p: Project, drafts: readonly number[], blocked: number): void {
  const db = new Database(p.dbPath);
  try {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    for (const at of drafts)
      insertDraft(run, {
        text: 'A choice for the operator.',
        kind: 'decision',
        sourceSession: null,
        assistantExcerpt: null,
        evidence: [],
        outsideContent: null,
        createdAt: iso(at),
      });
    const mission = db.prepare("INSERT INTO missions (id, name, status) VALUES (?, ?, 'Blocked')");
    for (let i = 0; i < blocked; i++) mission.run(`${p.projectId}-b${i}`, 'Waiting on a review');
  } finally {
    db.close();
  }
}

function textOf(response: Awaited<ReturnType<typeof executeMissionProtocolTool>>): string {
  return response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

describe('the review shows what needs a person in the other projects (s97-m01)', () => {
  it('labels an unnamed registered project by its folder without replacing its stored name', async () => {
    const local = await project('Local');
    const other = await project('Other');
    needsAPerson(other, [], 1);
    const registry = await ProjectGraphRegistry.create();
    registry.register({ project_id: other.projectId, store_path: other.root, name: '  ' });
    const response = await executeMissionProtocolTool(
      'rbook_review',
      { projectRoot: local.root },
      context
    );
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent as unknown as RbookToolResult<RbookReviewResult>;
    expect(result.data!.portfolio!.signals!.top).toEqual([
      { projectId: other.projectId, name: path.basename(other.root), blocked: 1 },
    ]);
    expect(textOf(response)).toContain(path.basename(other.root));
    expect(registry.get(other.projectId)?.name).toBe('  ');
  });

  it('counts them at the MCP boundary with this machine’s draft runtime, leaving this project’s own out', async () => {
    const local = await project('Local');
    const other = await project('Other');
    await project('Quiet');
    const now = Date.now();
    // This project's own draft and block are in its own digest, not in the portfolio's list.
    needsAPerson(local, [now - DAY], 1);
    // Another project: two drafts and a blocked mission. Three session starts on this machine
    // since the older draft expire it, so one draft counts only when the review passes the runtime.
    needsAPerson(other, [now - 3 * DAY, now - DAY / 4], 1);
    const runtime = openDraftRuntime(other.dbPath, process.env)!;
    expect(runtime).not.toBeNull();
    for (const at of [now - 2.5 * DAY, now - 2 * DAY, now - 1.5 * DAY])
      recordSessionStart(runtime, 'a1b2c3d4e5f60718', at);
    runtime.close();

    const response = await executeMissionProtocolTool(
      'rbook_review',
      { projectRoot: local.root },
      context
    );
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent as unknown as RbookToolResult<RbookReviewResult>;
    expect(result.success).toBe(true);
    const portfolio = result.data!.portfolio!;
    expect(portfolio.projects).toBe(3);
    expect(portfolio.signals).toEqual({
      projects: 1,
      top: [{ projectId: other.projectId, name: 'Other', drafts: 1, blocked: 1 }],
    });
    expect(textOf(response)).toContain(
      `Needs a person in 1 other project:\n  ⟪untrusted, from proj:${other.projectId}⟫ Other ⟪/untrusted⟫: 1 draft, 1 blocked mission`
    );
    const bytes = Buffer.byteLength(JSON.stringify(result.data));
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(result.data!.digestSizeBytes).toBe(bytes);
  });

  it('lists the eight most counted, keeps the count of all, and stays within the budget', async () => {
    const local = await project('Local');
    const others: Project[] = [];
    for (let i = 1; i <= 10; i++) {
      const p = await project(`Busy project number ${String(i).padStart(2, '0')} with a long name`);
      needsAPerson(p, [], i);
      others.push(p);
    }
    const result = await rbookReview({ projectRoot: local.root });
    expect(result.success).toBe(true);
    const signals = result.data!.portfolio!.signals!;
    expect(signals.projects).toBe(10);
    // The most blocked first; a name is capped as the drift list caps it.
    expect(signals.top.map((item) => item.blocked)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(signals.top[0]).toEqual({
      projectId: others[9].projectId,
      name: 'Busy project number 10 with a…',
      blocked: 10,
    });
    expect(result.data!.digestSizeBytes).toBeLessThanOrEqual(4096);
  });

  it('counts a project whose signal failed as unread, and still lists what could be read', async () => {
    const local = await project('Local');
    const broken = await project('Broken');
    needsAPerson(broken, [], 1);
    // A drafts table the rule cannot read: the store is damaged, not an older layout.
    const db = new Database(broken.dbPath);
    db.exec(
      'DROP TABLE IF EXISTS proposals; CREATE TABLE proposals (body TEXT, outcome TEXT, created_at TEXT)'
    );
    db.close();
    const response = await executeMissionProtocolTool(
      'rbook_review',
      { projectRoot: local.root },
      context
    );
    const result = response.structuredContent as unknown as RbookToolResult<RbookReviewResult>;
    expect(result.data!.portfolio!.signals).toEqual({
      projects: 1,
      top: [{ projectId: broken.projectId, name: 'Broken', blocked: 1 }],
      unread: 1,
    });
    expect(textOf(response)).toContain('Some signals could not be read in 1 other project.');
  });

  it('counts a project whose signals could not be computed at all as unread', async () => {
    const local = await project('Local');
    const damaged = await project('Damaged');
    needsAPerson(damaged, [Date.now() - DAY], 1);
    const db = new Database(damaged.dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const { rootpage } = db
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'metadata'")
      .get() as { rootpage: number };
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    db.close();
    // The metadata table, which every report reads first, damaged as a disk fault would.
    const fd = fs.openSync(damaged.dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (rootpage - 1) * pageSize);
    fs.closeSync(fd);
    const result = await rbookReview({ projectRoot: local.root });
    expect(result.data!.portfolio!.signals).toEqual({ projects: 0, top: [], unread: 1 });
  });

  it('counts a registered project whose store cannot be queried as unread', async () => {
    const local = await project('Local');
    const gone = await project('Gone');
    fs.rmSync(path.join(gone.root, 'rbook', 'db'), { recursive: true, force: true });
    const result = await rbookReview({ projectRoot: local.root });
    expect(result.data!.portfolio!.signals).toEqual({ projects: 0, top: [], unread: 1 });
  });

  it('keeps a project’s signals when its freshness cannot be read, and says freshness unknown', async () => {
    const local = await project('Local');
    const stampless = await project('Stampless');
    needsAPerson(stampless, [Date.now() - DAY], 0);
    const db = new Database(stampless.dbPath);
    db.exec('DROP TABLE sessions; CREATE VIEW sessions AS SELECT * FROM no_such_table');
    db.close();
    const result = await rbookReview({ projectRoot: local.root });
    const portfolio = result.data!.portfolio!;
    expect(portfolio.signals!.top).toEqual([
      { projectId: stampless.projectId, name: 'Stampless', drafts: 1 },
    ]);
    expect(
      portfolio.drift!.stale.find((item) => item.projectId === stampless.projectId)?.reason
    ).toMatch(/freshness unknown/);
  });

  it('leaves this project out by its folder too, when its store took a new id', async () => {
    const local = await project('Local');
    await project('Quiet');
    needsAPerson(local, [Date.now() - DAY], 1);
    // The registry keeps the id it registered for this folder; the store now names another.
    const db = new Database(local.dbPath);
    db.prepare("UPDATE metadata SET value = 'local-rekeyed' WHERE key = 'project_id'").run();
    db.close();
    const result = await rbookReview({ projectRoot: local.root });
    expect(result.success).toBe(true);
    expect(result.data!.localProjectId).toBe('local-rekeyed');
    expect(result.data!.portfolio!.signals).toBeNull();
  });

  it('carries no list when no other project needs a person', async () => {
    const local = await project('Local');
    await project('Quiet');
    needsAPerson(local, [Date.now() - DAY], 2);
    const result = await rbookReview({ projectRoot: local.root });
    expect(result.success).toBe(true);
    expect(result.data!.portfolio!.signals).toBeNull();
  });
});

describe('the digest under its budget, with the list (s97-m01)', () => {
  const section = (nameLength: number): RbookReviewResult => {
    const name = (i: number) => `Project number ${i} with a long display name`.slice(0, 30);
    const portfolio: PortfolioSection = {
      projects: 20,
      reachable: 12,
      silent: 8,
      unmigrated: 0,
      unreadable: 0,
      activeMissions: {
        count: 5,
        top: Array.from({ length: 5 }, (_, i) => ({
          id: `m-${i}`,
          name: name(i),
          projectId: `p-${i}`,
        })),
      },
      fanInP95Ms: 12,
      drift: {
        staleThresholdDays: 21,
        stale: Array.from({ length: 8 }, (_, i) => ({
          projectId: `p-${i}`,
          name: name(i),
          reason: `no new Reasonbook rows in ${30 + i}d`,
          ageDays: 30 + i,
        })),
      },
      signals: {
        projects: 12,
        top: Array.from({ length: 8 }, (_, i) => ({
          projectId: `p-${i}`,
          name: name(i),
          drafts: 2,
          lapsing: 3,
        })),
      },
    };
    return {
      next_actions: [],
      project: {
        name: 'L'.repeat(nameLength),
        rbook_address: 'rbook://x/y',
        status: null,
        tier: 'build',
      },
      sprint: null,
      workQueue: {
        inProgress: { count: 0, top: [] },
        current: { count: 0, top: [] },
        queued: { count: 0, top: [] },
        blocked: { count: 0 },
        nextAction: 'Nothing queued.',
      },
      recentDecisions: [],
      recentLearnings: [],
      localProjectId: 'local',
      portfolio,
      freshness: { lagDays: 0, isStale: false },
      digestSizeBytes: 0,
    };
  };

  it('stays at or under 4,096 bytes at every size, and trims the list last of the portfolio', () => {
    const seen = new Set<string>();
    for (let length = 1500; length <= 4500; length += 1) {
      const digest = finishDigest(section(length));
      const bytes = Buffer.byteLength(JSON.stringify(digest), 'utf8');
      expect(digest.digestSizeBytes).toBe(bytes);
      const p = digest.portfolio;
      // Past here the project's own part alone is over the budget, which no stage trims.
      if (!p && bytes > 4096) break;
      expect({ length, bytes }).toEqual({ length, bytes: Math.min(bytes, 4096) });
      if (!p) {
        seen.add('dropped');
        continue;
      }
      // The list shrinks only once the missions and the drift list are gone, and keeps its count.
      if (p.signals!.top.length < 8) {
        expect(p.activeMissions.top).toEqual([]);
        expect(p.drift).toBeNull();
        expect(p.signals!.projects).toBe(12);
        seen.add('list trimmed');
      } else if (p.drift === null || p.activeMissions.top.length < 5) seen.add('earlier stages');
      else seen.add('whole');
    }
    expect([...seen].sort()).toEqual(['dropped', 'earlier stages', 'list trimmed', 'whole']);
  });

  it('prints the list in the long text form too, each name framed, with its counts', () => {
    const digest = finishDigest(section(10));
    digest.portfolio!.signals = { ...digest.portfolio!.signals!, unread: 1 };
    const text = formatReviewForLLM({ success: true, data: digest });
    expect(text).toContain('  ⚑ needs a person in 12 other project(s)');
    expect(text).toContain(
      '    · ⟪untrusted, from proj:p-0⟫ Project number 0 with a long d ⟪/untrusted⟫ [proj:p-0] — 2 drafts, 3 next steps about to lapse'
    );
    expect(text).toContain('  ⚑ some signals could not be read in 1 other project(s)');
  });

  it('prints no list header when only unread projects remain, in both text forms', () => {
    const context = renderDigestV2({
      project: { name: 'Local', level: 'ledger' },
      localProjectId: 'local',
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      work: [],
    });
    const portfolio = { ...section(10).portfolio!, signals: { projects: 0, top: [], unread: 2 } };
    const text = formatReviewPresentation(context, portfolio, 'local');
    expect(text).toContain('Some signals could not be read in 2 other projects.');
    expect(text).not.toContain('Needs a person in 0');
    const digest = finishDigest(section(10));
    digest.portfolio!.signals = { projects: 0, top: [], unread: 2 };
    const long = formatReviewForLLM({ success: true, data: digest });
    expect(long).toContain('  ⚑ some signals could not be read in 2 other project(s)');
    expect(long).not.toContain('needs a person in 0');
  });
});

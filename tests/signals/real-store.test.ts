// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — every signal fires on a copy of this project's real store, written by the tools' own paths, and each
// ABOUTME: count the server also computes equals the server's own function on the same copy, at the wall clock.

/**
 * Why a real store: practice 4 asks for a positive fire on a real store, since a fixture schema
 * cannot catch a rule reading the wrong column of a store that years of migrations made. The copy
 * is taken read-only with SQLite's backup, so it holds what the live store's WAL holds too; every
 * write below goes to the copy. shared_conflicts cannot fire here, since this store is not shared:
 * tests/signals/shared-conflicts.test.ts fires it on copies the merge itself left in conflict.
 */

import { afterAll, beforeAll, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BRIEF_MAX_LINES,
  buildBrief,
  readSignals,
  renderBrief,
  type SignalEntry,
  type SignalsReport,
} from '../../src/signals';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { withClient } from '../../src/tools/rbook/client';
import { readDigestV2 } from '../../src/tools/rbook/digest-v2-store';
import { draftRuntimeDir } from '../../src/tools/rbook/draft-runtime';
import { rawGenesisColumns } from '../../src/tools/rbook/genesis-columns';
import { leaseState, LEASE_WARN_AT, readLeaseAges } from '../../src/tools/rbook/next-step-lease';
import { insertDraft, rawRunner } from '../../src/tools/rbook/proposals';
import { rbookAgentOnboard } from '../../src/tools/rbook/rbook-agent-onboard';
import { rbookDecisions } from '../../src/tools/rbook/rbook-decisions';
import { rbookFeedback } from '../../src/tools/rbook/rbook-feedback';
import { rbookMission } from '../../src/tools/rbook/rbook-mission';
import { rbookMissionTransition } from '../../src/tools/rbook/rbook-mission-transition';
import { newestRowStampMs } from '../../src/tools/rbook/rbook-review';
import { rbookSession } from '../../src/tools/rbook/rbook-session';
import { rbookSprint } from '../../src/tools/rbook/rbook-sprint';
import { readStaleness } from '../../src/tools/rbook/staleness-detection';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The positive fires run on a copy of the private live Reasonbook store; the same rules fire on init-made stores in read-signals.test.ts.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const DAY = 86_400_000;
const tmpDirs: string[] = [];
const saved = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;

function signal(report: SignalsReport, kind: SignalEntry['kind']): SignalEntry {
  return report.signals.find((entry) => entry.kind === kind)!;
}
const report = (): SignalsReport =>
  readSignals(dbPath, { now: Date.now(), draftRuntimeDir: draftRuntimeDir(env) });

afterAll(() => {
  RbookDetector.resetInstance();
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

PRIVATE.describe('the signals on a copy of this project’s real store (s97-m01)', () => {
  beforeAll(async () => {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-signals-real-home-'))
    );
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-signals-real-')));
    tmpDirs.push(home, root);
    process.env.RBOOK_CONFIG_DIR = home;
    process.env.RBOOK_CHECKPOINT_SYNC = 'off';
    env = { ...process.env };
    RbookDetector.resetInstance();
    dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const live = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
    try {
      await live.backup(dbPath);
    } finally {
      live.close();
    }
  }, 120_000);

  it('fires every signal this store can hold, by the tools’ own writes, and equals the server where it counts', async () => {
    const before = report();
    const projectRoot = root;

    // Writes through the product's own paths.
    const db = new Database(dbPath);
    const draftId = insertDraft(rawRunner(db), {
      text: 'Ship the brief on Mondays.',
      kind: 'decision',
      sourceSession: null,
      assistantExcerpt: null,
      evidence: [],
      outsideContent: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    db.close();
    const decide = async (content: string, supersedes?: number[]): Promise<number> => {
      const result = await rbookDecisions({
        action: 'record',
        content,
        projectRoot,
        ...(supersedes ? { supersedes } : {}),
      });
      expect(result.success).toBe(true);
      return (result.data as { decisionId: number }).decisionId;
    };
    const replaced = await decide('Keep the weekly brief in the digest.');
    await decide(`Keep the weekly brief on the dashboard; this supersedes d:${replaced}.`, [
      replaced,
    ]);
    const learning = await rbookSession({
      action: 'capture',
      category: 'learning',
      content: `The digest was the wrong home for the brief (d:${replaced}).`,
      projectRoot,
    });
    expect(learning.success).toBe(true);
    const learningId = (learning.data as { learningId: number }).learningId;
    const step = await rbookSession({
      action: 'capture',
      category: 'next-step',
      content: 'Read the weekly brief once the dashboard shows it.',
      projectRoot,
    });
    expect(step.success).toBe(true);
    const stepId = (step.data as { nextStepId: number }).nextStepId;
    const constraint = await rbookSession({
      action: 'capture',
      category: 'constraint',
      content: 'Hold the dashboard request until the brief renders.',
      expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      projectRoot,
    });
    expect(constraint.success).toBe(true);
    // The test's own mission, added and started by the tools: the live store need not hold one in
    // progress, and at a sprint's close it holds none (sprint-100's first pre-close witness).
    const working = 'signals-real-m1';
    for (const step of [
      () =>
        rbookSprint({
          action: 'add',
          sprintId: 'signals-real-sprint',
          title: 'Signals on the real store',
          status: 'Planned',
          projectRoot,
        }),
      () =>
        rbookMission({
          action: 'add',
          missionId: working,
          name: 'Wait on the dashboard',
          sprintId: 'signals-real-sprint',
          projectRoot,
        }),
      () => rbookMissionTransition({ action: 'start', missionId: working, projectRoot }),
    ]) {
      const done = await step();
      expect({ ok: done.success, error: done.error }).toEqual({ ok: true, error: undefined });
    }
    const blocked = await rbookMissionTransition({
      action: 'block',
      missionId: working,
      reason: 'Waiting on the dashboard.',
      projectRoot,
    });
    expect({ ok: blocked.success, error: blocked.error }).toEqual({ ok: true, error: undefined });
    await rbookAgentOnboard({
      agentFeedback:
        'rbook_mission(action="status") returned 93KB, past the tool-result token cap.',
      projectRoot,
      offline: true,
    });
    // Twenty closes after every row above, the age at which reviews fall due and leases warn. A
    // close is a completed sprint's end, each row stamped as init stamps the sprint it writes.
    const writes = Date.now();
    const closes = new Database(dbPath);
    for (let i = 1; i <= 20; i++) {
      const g = rawGenesisColumns(closes, 'sprints', 'cmos-mcp-pro');
      closes
        .prepare(
          `INSERT INTO sprints (id, title, status, end_date, ${g.columns.join(', ')}) VALUES (?, 'Closed for the test', 'Completed', ?, ${g.placeholders})`
        )
        .run(`signals-real-close-${i}`, new Date(writes + i).toISOString(), ...g.values);
    }
    closes.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = report();
    const count = (r: SignalsReport, kind: SignalEntry['kind']) => signal(r, kind).count;

    // drafts_pending: the new draft counts, as the digest's own reader counts it.
    expect(count(after, 'drafts_pending')).toBe((count(before, 'drafts_pending') ?? 0) + 1);
    expect(signal(after, 'drafts_pending').ids).toContain(`P${draftId}`);
    const digest = await readDigestV2(root, env);
    expect(count(after, 'drafts_pending')).toBe(digest.drafts?.length ?? 0);

    // The server's own counts, on the same copy, at the wall clock.
    const server = await withClient(
      (client) => ({
        success: true,
        data: { staleness: readStaleness(client), leases: readLeaseAges(client) ?? [] },
      }),
      { dbPath }
    );
    const { staleness, leases } = server.data!;
    const lapsing = signal(after, 'next_steps_lapsing');
    expect(lapsing.count).toBe(leases.filter((row) => row.closesSurvived >= LEASE_WARN_AT).length);
    expect(lapsing.lapseDue).toBe(
      leases.filter((row) => leaseState(row.closesSurvived, row.ageDays) === 'lapsing').length
    );
    expect(lapsing.count).toBeGreaterThan(0);
    // The captured step survived the twenty closes, so the server holds it at the warning age.
    expect(leases.some((row) => row.id === stepId && row.closesSurvived >= LEASE_WARN_AT)).toBe(
      true
    );
    const reviews = signal(after, 'reviews_due');
    expect(reviews.count).toBe(staleness.dueDecisions + staleness.dueLearnings);
    expect(reviews.count).toBeGreaterThan(0);

    // superseded_cited: the learning cites the replaced decision; the replacement's own citation
    // of its predecessor is left out.
    const cited = signal(after, 'superseded_cited');
    expect(cited.ids).toContain(`l:${learningId}`);
    expect(cited.count).toBe((count(before, 'superseded_cited') ?? 0) + 1);

    // missions_blocked: the block the tool recorded, as onboard counts blocked missions.
    const onboard = await rbookAgentOnboard({ projectRoot, offline: true });
    expect(count(after, 'missions_blocked')).toBe(onboard.data!.blockedMissions.length);
    expect(signal(after, 'missions_blocked').ids).toContain(working);

    // feedback_open: friction by kind as rbook_feedback counts the open rows.
    const listed = await rbookFeedback({ action: 'list', status: 'open', projectRoot });
    const byKind = (listed.data as { countsByKind: Record<string, number> }).countsByKind;
    const feedback = signal(after, 'feedback_open');
    expect(feedback.byKind).toEqual(
      Object.fromEntries(Object.keys(feedback.byKind!).map((kind) => [kind, byKind[kind]]))
    );
    expect(feedback.unclassified).toBe(byKind.unclassified);
    expect(feedback.byKind!.payload).toBe(
      (signal(before, 'feedback_open').byKind?.payload ?? 0) + 1
    );

    // quiet_days: the newest row stamp the review's drift probe reads.
    const stamps = new Database(dbPath, { readonly: true });
    const newest = newestRowStampMs(stamps);
    stamps.close();
    expect(count(after, 'quiet_days')).toBe(Math.floor((Date.now() - newest!) / DAY));
    expect(count(after, 'quiet_days')).toBe(0);

    // constraints_expiring: the constraint captured to expire in three days.
    expect(count(after, 'constraints_expiring')).toBe(
      (count(before, 'constraints_expiring') ?? 0) + 1
    );

    // shared_conflicts: this store is not shared, which is unavailable and not a failure.
    expect(signal(after, 'shared_conflicts')).toMatchObject({ available: false, count: null });
    expect(signal(after, 'shared_conflicts').failed).toBeUndefined();
  }, 120_000);

  it('briefs this store within 60 lines, every id it names a row of the copy (s97-m03)', () => {
    const now = Date.now();
    const copy = readSignals(dbPath, { now, draftRuntimeDir: draftRuntimeDir(env) });
    const text = renderBrief([copy], { now, windowDays: 7 });
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    const ids = buildBrief([copy], { now, windowDays: 7 }).sections.flatMap((part) =>
      part.items.flatMap((item) => item.ids)
    );
    expect(ids.length).toBeGreaterThan(0);
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables: Record<string, string> = {
        P: 'proposals',
        'n:': 'next_steps',
        'd:': 'strategic_decisions',
        'l:': 'learnings',
      };
      for (const id of ids) {
        const [, prefix, number] = /^(P|n:|d:|l:)(\d+)$/.exec(id) ?? [];
        const found = prefix
          ? db.prepare(`SELECT 1 FROM ${tables[prefix]} WHERE id = ?`).get(Number(number))
          : db.prepare('SELECT 1 FROM missions WHERE id = ?').get(id);
        expect({ id, found: Boolean(found) }).toEqual({ id, found: true });
      }
    } finally {
      db.close();
    }
  });
});

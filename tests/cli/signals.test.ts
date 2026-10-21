// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — reasonbook signals: every registered project's nine signals with this machine's draft runtime, or one
// ABOUTME: project's with --project-root; a store that cannot be read is named, not dropped, and no store is written.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { SIGNAL_KINDS, type SignalsReport } from '../../src/signals';
import { openDraftRuntime, recordSessionStart } from '../../src/tools/rbook/draft-runtime';
import { ensureProposalsTable, insertDraft, rawRunner } from '../../src/tools/rbook/proposals';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';

const DAY = 86_400_000;
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

let env: NodeJS.ProcessEnv;
let busy: { root: string; dbPath: string; projectId: string };
let gone: { root: string; projectId: string };
const saved = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };

async function project(name: string): Promise<{ root: string; dbPath: string; projectId: string }> {
  const root = tmp('rbook-cli-signals-');
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

beforeAll(async () => {
  const config = tmp('rbook-cli-signals-home-');
  process.env.RBOOK_CONFIG_DIR = config;
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  env = { ...process.env, RBOOK_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: '' };
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  busy = await project('Busy');
  const db = new Database(busy.dbPath);
  try {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    for (const at of [Date.now() - 3 * DAY, Date.now() - DAY / 4])
      insertDraft(run, {
        text: 'A choice for the operator.',
        kind: 'decision',
        sourceSession: null,
        assistantExcerpt: null,
        evidence: [],
        outsideContent: null,
        createdAt: new Date(at).toISOString(),
      });
    db.prepare(
      "INSERT INTO missions (id, name, status) VALUES ('busy-b', 'Waiting', 'Blocked')"
    ).run();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  // Three session starts on this machine since the older draft: with the runtime, it has expired.
  const runtime = openDraftRuntime(busy.dbPath, env)!;
  for (const at of [Date.now() - 2.5 * DAY, Date.now() - 2 * DAY, Date.now() - 1.5 * DAY])
    recordSessionStart(runtime, 'a1b2c3d4e5f60718', at);
  runtime.close();
  // A registered project whose store has since gone.
  const lost = await project('Gone');
  fs.rmSync(path.join(lost.root, 'rbook', 'db'), { recursive: true, force: true });
  gone = { root: lost.root, projectId: lost.projectId };
  ProjectGraphRegistry.resetInstance();
});

afterAll(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env,
    cwd: os.tmpdir(),
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  return { code: await runCli(['signals', ...argv], io), stdout, stderr };
}

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('reasonbook signals (s97-m01)', () => {
  it('reports every registered project with this machine’s draft runtime, and names a store it cannot read', async () => {
    const before = sha(busy.dbPath);
    const result = await run(['--format', 'json']);
    expect(result).toMatchObject({ code: 0, stderr: [] });
    const out = JSON.parse(result.stdout) as {
      reports: SignalsReport[];
      unreadable: Array<{ projectId: string; error: string }>;
    };
    const report = out.reports.find((r) => r.project.id === busy.projectId)!;
    expect(report.schema).toBe('rbook.signals/1');
    expect(report.signals.map((entry) => entry.kind)).toEqual([...SIGNAL_KINDS]);
    const drafts = report.signals.find((entry) => entry.kind === 'drafts_pending')!;
    expect(drafts).toMatchObject({ available: true, count: 1 });
    expect(drafts.reason).toBeUndefined();
    expect(report.signals.find((entry) => entry.kind === 'missions_blocked')).toMatchObject({
      count: 1,
      ids: ['busy-b'],
    });
    expect(out.unreadable.map((store) => store.projectId)).toEqual([gone.projectId]);
    expect(out.reports.map((r) => r.project.id)).not.toContain(gone.projectId);
    // Reading changed no byte of the store.
    expect(sha(busy.dbPath)).toBe(before);
  });

  it('prints each project’s name framed as data, with its counts and the store it could not read', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`⟪untrusted, from proj:${busy.projectId}⟫ Busy ⟪/untrusted⟫`);
    expect(result.stdout).toMatch(/\n {2}drafts_pending: 1 — P2\n/);
    // Blocked by a direct write, so no block time is recorded: counted, and said.
    expect(result.stdout).toContain(
      '  missions_blocked: 1 (1 blocked since an unknown time) — busy-b'
    );
    expect(result.stdout).toMatch(/shared_conflicts: unavailable — not a shared copy/);
    expect(result.stdout).toContain(`Unreadable: proj:${gone.projectId}`);
  });

  it('reports one project with --project-root, and refuses a folder with no store', async () => {
    const one = await run(['--project-root', busy.root, '--format', 'json']);
    expect(one.code).toBe(0);
    const out = JSON.parse(one.stdout) as { reports: SignalsReport[] };
    expect(out.reports.map((r) => r.project.id)).toEqual([busy.projectId]);
    const none = await run(['--project-root', tmp('rbook-cli-signals-empty-')]);
    expect(none.code).toBe(1);
    expect(none.stderr.join('\n')).toMatch(/reasonbook signals: no Reasonbook store/);
    const bad = await run(['--format', 'yaml']);
    expect(bad.code).toBe(1);
    expect(bad.stderr[0]).toContain('Usage: reasonbook signals');
    // An empty root would otherwise fall through to the working folder's project.
    const empty = await run(['--project-root=']);
    expect(empty.code).toBe(1);
    expect(empty.stderr.join('\n')).toMatch(/--project-root needs a folder/);
  });

  it('fails when every signal of the store asked for failed, and names a failed one once', async () => {
    // Registered where this file's machine keeps its projects, not the per-test folder.
    process.env.RBOOK_CONFIG_DIR = env.RBOOK_CONFIG_DIR;
    ProjectGraphRegistry.resetInstance();
    const broken = await project('Every table broken');
    const db = new Database(broken.dbPath);
    db.pragma('foreign_keys = OFF');
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as Array<{ name: string }>)
      db.exec(`DROP TRIGGER "${name}"`);
    for (const table of [
      'proposals',
      'next_steps',
      'sprints',
      'strategic_decisions',
      'learnings',
      'missions',
      'agent_feedback',
      'constraints',
      'sessions',
      'record_conflicts',
    ]) {
      const kind = (
        db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as
          | { type: string }
          | undefined
      )?.type;
      if (kind === 'table') db.exec(`DROP TABLE ${table}`);
      db.exec(`CREATE VIEW ${table} AS SELECT * FROM no_such_table`);
    }
    db.close();
    const result = await run(['--project-root', broken.root]);
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toMatch(/reasonbook signals: could not be read/);
    // In the whole machine's list the same store prints each signal's reason once.
    const all = await run([]);
    expect(all.stdout).toMatch(/drafts_pending: could not be read — no such table/);
    expect(all.stdout).not.toMatch(/could not be read.*could not be read/);
  });

  it('fails, and says why, when the one store asked for cannot be read', async () => {
    const root = tmp('rbook-cli-signals-broken-');
    const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x5a));
    const result = await run(['--project-root', root]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.join('\n')).toMatch(/reasonbook signals: store unreadable/);
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Upload notices read real old and current registries without migrating either store.
// ABOUTME: Deleted holds fade from session starts only, while review and status retain the reason.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  ensureUploadColumns,
  claimUpload,
  finishUpload,
  claimUploadProbe,
  finishUploadProbe,
  markUploadOwed,
} from '../../../src/intelligence/project-upload-state';
import { readUploadNotice } from '../../../src/tools/rbook/dashboard-upload-notice';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';

let root: string;
let dbPath: string;
let registryPath: string;
let registry: Database.Database;
let env: NodeJS.ProcessEnv;
let now: number;
beforeEach(() => {
  now = Date.now();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-notice-'));
  dbPath = seedRbookDb(root, { projectId: 'one', projectName: 'Upload notice' });
  const config = path.join(root, 'config');
  fs.mkdirSync(config);
  env = { ...process.env, RBOOK_CONFIG_DIR: config };
  registryPath = path.join(config, 'project-graph.sqlite');
  registry = new Database(registryPath);
  registry.exec(
    'CREATE TABLE projects(project_id TEXT PRIMARY KEY, store_path TEXT, archived_at INTEGER, last_synced_at INTEGER)'
  );
  registry.prepare('INSERT INTO projects(project_id,store_path) VALUES(?,?)').run('one', root);
  ensureUploadColumns(registry);
});
afterEach(() => {
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function pause(reason: 'auth' | 'deleted' | 'replaced'): void {
  markUploadOwed(registry, 'one', now, true);
  const lease = claimUpload(registry, 'one', now, true)!;
  finishUpload(registry, 'one', lease, now + 1, { success: false, pauseReason: reason });
}

it('renders a live holder as uploading but an exited tied holder as interrupted', () => {
  markUploadOwed(registry, 'one', now, true);
  const lease = claimUpload(registry, 'one', now, true)!;
  expect(readUploadNotice(root, { env, now: now + 1 })?.text).toContain(
    `uploading since ${new Date(now).toISOString()} (process ${process.pid})`
  );
  registry
    .prepare('UPDATE projects SET upload_lease_holder=?')
    .run(`${lease.token}:123456789@${os.hostname()}`);
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  try {
    const notice = readUploadNotice(root, { env, now: now + 1 })!;
    expect(notice.text).toContain('interrupted');
    expect(notice.text).not.toContain('; uploading');
  } finally {
    kill.mockRestore();
  }
});

it('shows pause reason, next check, last success and a remedy that works', () => {
  pause('auth');
  const text = readUploadNotice(root, { env, now: now + 1 })!.text;
  expect(text).toContain('automatic uploads paused');
  expect(text).toContain('reason auth');
  expect(text).toContain('next check');
  expect(text).toContain('last success never');
  expect(text).not.toContain('until an explicit close succeeds');
});

it.each(['deleted', 'replaced'] as const)(
  '%s is shown on the first three session starts, always in review, without a write',
  async (reason) => {
    pause(reason);
    const project = new Database(dbPath);
    try {
      for (let starts = 0; starts < 4; starts++) {
        const before = fs.readFileSync(dbPath);
        const notice = readUploadNotice(root, { env, sessionStart: true });
        expect(Boolean(notice)).toBe(starts < 3);
        expect(fs.readFileSync(dbPath)).toEqual(before);
        expect(readUploadNotice(root, { env })?.text).toContain(`reason ${reason}`);
        if (starts < 3)
          project
            .prepare('INSERT INTO sessions(id,type,title,started_at) VALUES(?,?,?,?)')
            .run(
              `new-${starts}`,
              'build',
              'New session',
              new Date(now + 1000 + starts).toISOString()
            );
      }
      const review = renderDigestV2(await readDigestV2(root, env)).text;
      const hook = renderDigestV2(
        await readDigestV2(root, env, Infinity, undefined, { sessionStart: true })
      ).text;
      expect(review).toContain(`reason ${reason}`);
      expect(hook).not.toContain('Dashboard upload:');
      expect(review).toContain('not available in this version');
    } finally {
      project.close();
    }
  }
);

it('an old registry is read without adding columns and blocked zero overrides its stale reason', () => {
  registry.exec(
    'DROP TABLE projects; CREATE TABLE projects(project_id TEXT PRIMARY KEY, store_path TEXT, archived_at INTEGER, upload_blocked INTEGER, upload_last_error TEXT, upload_pause_reason TEXT, last_synced_at INTEGER)'
  );
  registry
    .prepare(
      'INSERT INTO projects(project_id,store_path,upload_blocked,upload_last_error,upload_pause_reason) VALUES(?,?,1,?,NULL)'
    )
    .run('one', root, 'HTTP 401');
  const before = registry.prepare('PRAGMA table_info(projects)').all();
  expect(readUploadNotice(root, { env })?.state.pauseReason).toBe('auth');
  expect(registry.prepare('PRAGMA table_info(projects)').all()).toEqual(before);
  registry.exec("UPDATE projects SET upload_blocked=0, upload_pause_reason='deleted'");
  expect(readUploadNotice(root, { env })?.state.pauseReason).toBeNull();
});

it('missing and pre-upload registries create nothing and do not invent state', () => {
  expect(
    readUploadNotice(root, { env: { ...env, RBOOK_CONFIG_DIR: path.join(root, 'absent') } })
  ).toBeNull();
  expect(fs.existsSync(path.join(root, 'absent'))).toBe(false);
  registry.exec(
    'DROP TABLE projects; CREATE TABLE projects(project_id TEXT, store_path TEXT, archived_at INTEGER)'
  );
  expect(readUploadNotice(root, { env })).toBeNull();
});

it('recent debt stays quiet in the digest, while overdue debt and failures are included', async () => {
  markUploadOwed(registry, 'one', now);
  expect(readUploadNotice(root, { env, now, attentionOnly: true })).toBeNull();
  registry.prepare('UPDATE projects SET upload_first_owed_at=?').run(now - 31 * 60000);
  expect(renderDigestV2(await readDigestV2(root, env)).text).toContain('Dashboard upload:');
  expect(readUploadNotice(path.join(root, 'other'), { env })).toBeNull();
});

it('upload attention retains its complete reason within a full digest allocation', async () => {
  pause('deleted');
  const model = await readDigestV2(root, env);
  const rows = (kind: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${kind}:${index + 1}`,
      text: 'A'.repeat(500),
      projectId: null,
    }));
  const digest = renderDigestV2({
    ...model,
    project: { name: 'n'.repeat(200), level: 'builder' },
    sprint: {
      id: 'sprint-1',
      title: 't'.repeat(300),
      focus: 'f'.repeat(300),
      status: 'Active',
      projectId: null,
    },
    profile: { path: '/profile', text: 'p'.repeat(1100), chars: 1100, overCap: false },
    rules: rows('c', 4),
    decisions: { rows: rows('d', 8), total: 20 },
    learnings: { rows: rows('l', 3), total: 9 },
    work: rows('m', 5),
    feedback: 'f'.repeat(100),
    drafts: [{ id: 1, kind: 'decision', text: 'Pending choice.' }],
  });
  expect(digest.text.length).toBeLessThanOrEqual(4000);
  expect(digest.text).toContain(model.dashboardUpload);
  expect(digest.text).toContain('not available in this version');
});

it.each([
  ['upload', 'deleted'],
  ['upload', 'replaced'],
  ['probe', 'deleted'],
  ['probe', 'replaced'],
] as const)(
  '%s changing auth to %s starts three new notices after the earlier auth sessions',
  (method, reason) => {
    pause('auth');
    const project = new Database(dbPath);
    const changedAt = now + 3600002;
    const addSession = (id: string, time: number): void => {
      project
        .prepare('INSERT INTO sessions(id,type,title,started_at) VALUES(?,?,?,?)')
        .run(id, 'build', 'Recorded session', new Date(time).toISOString());
    };
    try {
      for (let index = 0; index < 3; index++) addSession(`auth-${index}`, now + 1000 + index);
      if (method === 'upload') {
        const lease = claimUpload(registry, 'one', changedAt - 1, true)!;
        expect(
          finishUpload(registry, 'one', lease, changedAt, { success: false, pauseReason: reason })
        ).toBe(true);
      } else {
        const claim = claimUploadProbe(registry, 'one', changedAt - 1)!;
        expect(
          finishUploadProbe(registry, 'one', claim, changedAt, {
            recovered: false,
            pauseReason: reason,
          })
        ).toBe(true);
      }
      for (let starts = 0; starts < 4; starts++) {
        const notice = readUploadNotice(root, { env, sessionStart: true });
        expect(Boolean(notice)).toBe(starts < 3);
        if (notice) expect(notice.state.pausedAt).toBe(changedAt);
        if (starts < 3) addSession(`terminal-${starts}`, changedAt + 1000 + starts);
      }
      expect(readUploadNotice(root, { env })?.state.pausedAt).toBe(changedAt);
    } finally {
      project.close();
    }
  }
);

it.each(['upload', 'probe'])(
  '%s continuing the same auth hold preserves its original pause time',
  (method) => {
    pause('auth');
    const nextAt = now + 3600002;
    if (method === 'upload') {
      const lease = claimUpload(registry, 'one', nextAt - 1, true)!;
      finishUpload(registry, 'one', lease, nextAt, { success: false, pauseReason: 'auth' });
    } else {
      const claim = claimUploadProbe(registry, 'one', nextAt - 1)!;
      finishUploadProbe(registry, 'one', claim, nextAt, { recovered: false, pauseReason: 'auth' });
    }
    expect(readUploadNotice(root, { env })?.state.pausedAt).toBe(now + 1);
  }
);

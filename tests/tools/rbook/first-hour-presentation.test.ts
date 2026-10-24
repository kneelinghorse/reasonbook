// SPDX-License-Identifier: Apache-2.0
// ABOUTME: First-hour answers use a readable project name without changing the stored identity.
// ABOUTME: Real initialized stores exercise CLI and MCP reads, empty feedback, and the first digest.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import { executeMissionProtocolTool } from '../../../src/index';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { readSignals, renderBrief } from '../../../src/signals';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';

let root: string;
let dbPath: string;
let home: string;
let projectId: string;
const saved = {
  config: process.env.RBOOK_CONFIG_DIR,
  sync: process.env.RBOOK_CHECKPOINT_SYNC,
};

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-first-hour-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-first-hour-home-'));
  process.env.RBOOK_CONFIG_DIR = home;
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  const initialized = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Initial stored name',
  } as never);
  expect(initialized.success).toBe(true);
  // Onboarding already performs lazy schema/identity repairs. Settle those before measuring
  // this display-only change; the untouched stored-name assertion below covers its boundary.
  const onboard = await executeMissionProtocolTool(
    'rbook_agent_onboard',
    { projectRoot: root },
    {} as never
  );
  expect(onboard.isError).not.toBe(true);
  dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  const db = new Database(dbPath);
  projectId = (
    db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as {
      value: string;
    }
  ).value;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
});

afterEach(() => {
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const hash = (): string => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

function names(name: string | null): void {
  const db = new Database(dbPath);
  try {
    // Foreign/older stores can carry NULL despite today's metadata NOT NULL declaration.
    if (name === null)
      db.exec(`ALTER TABLE metadata RENAME TO old_metadata;
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO metadata SELECT * FROM old_metadata;
        DROP TABLE old_metadata;`);
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'project_name'").run(name);
    const rows = db.prepare('SELECT id, content FROM contexts').all() as Array<{
      id: string;
      content: string;
    }>;
    for (const row of rows) {
      const content = JSON.parse(row.content);
      if (row.id === 'project_identity') content.project_name = name;
      if (content.project) content.project.name = name;
      if (content.project_identity) content.project_identity.name = name;
      db.prepare('UPDATE contexts SET content = ? WHERE id = ?').run(
        JSON.stringify(content),
        row.id
      );
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

async function cli(command: string[]): Promise<string> {
  let text = '';
  const errors: string[] = [];
  const code = await runCli(command, {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
    readStdin: async () => '',
    stdout: (value) => {
      text += value;
    },
    stderr: (value) => {
      errors.push(value);
    },
  });
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
  return text;
}

it.each(['', '   ', null, 'Stored project name'])(
  'uses the stored name or folder for %p across read surfaces, without store writes',
  async (name) => {
    names(name);
    const expected = name?.trim() || path.basename(root);
    const before = hash();
    const model = await readDigestV2(root);
    expect(model.project.name).toBe(expected);
    expect(hash()).toBe(before);
    const report = readSignals(dbPath, { now: Date.now() });
    expect(report.project).toEqual({ id: projectId, name: expected });
    expect(hash()).toBe(before);
    expect(await cli(['review', '--project-root', root])).toContain(expected);
    expect(hash()).toBe(before);
    expect(await cli(['signals', '--project-root', root])).toContain(expected);
    expect(hash()).toBe(before);
    // Give the brief a reason to display this project's label without writing a work item.
    const stale = { ...report, computedAt: new Date(Date.now() - 1000).toISOString() };
    expect(renderBrief([stale], { now: Date.now() })).toContain(expected);
    for (const tool of ['rbook_agent_onboard', 'rbook_review']) {
      const answer = await executeMissionProtocolTool(tool, { projectRoot: root }, {} as never);
      expect(answer.isError).not.toBe(true);
      const text = answer.content.map((part) => ('text' in part ? part.text : '')).join('\n');
      expect(text).toContain(expected);
      expect(hash()).toBe(before);
    }
    expect(hash()).toBe(before);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get()).toEqual({
        value: name,
      });
    } finally {
      db.close();
    }
  }
);

it('the first digest teaches one next step without empty fleet administration or retired commands', async () => {
  const before = hash();
  const digest = renderDigestV2(await readDigestV2(root)).text;
  expect(digest).not.toMatch(/Fleet feedback|show by ID|context search/);
  expect(digest).not.toMatch(/rbook_\w+\s*\(/);
  expect(digest).toContain('Would record: <decision>');
  const answer = await executeMissionProtocolTool(
    'rbook_review',
    { projectRoot: root },
    {} as never
  );
  expect(answer.isError).not.toBe(true);
  const text = answer.content.map((part) => ('text' in part ? part.text : '')).join('\n');
  expect(text).not.toMatch(/Fleet feedback|show by ID|context search/);
  expect(text.match(/rbook_\w+\([^\n]*\)/g)).toEqual(['rbook_agent_onboard()']);
  expect(hash()).toBe(before);
});

it('a fresh store names the optional feedback absence without a missing-table warning', async () => {
  const before = hash();
  const report = readSignals(dbPath, { now: Date.now() });
  expect(report.signals.find((entry) => entry.kind === 'feedback_open')).toMatchObject({
    available: false,
    count: null,
    reason: 'no feedback yet',
  });
  expect(report.feedbackKinds).toMatchObject({ available: false, reason: 'no feedback yet' });
  const text = await cli(['signals', '--project-root', root]);
  expect(text).toContain('no feedback yet');
  expect(text).not.toContain('no agent_feedback table');
  expect(hash()).toBe(before);
});

it('keeps the folder fallback for legacy record layouts and standalone store files', () => {
  names('');
  const standalone = path.join(root, 'standalone.sqlite');
  fs.copyFileSync(dbPath, standalone);
  expect(readSignals(standalone, { now: Date.now() }).project.name).toBe(path.basename(root));
  fs.renameSync(path.join(root, 'rbook'), path.join(root, 'cmos'));
  const legacy = path.join(root, 'cmos', 'db', 'rbook.sqlite');
  expect(readSignals(legacy, { now: Date.now() }).project.name).toBe(path.basename(root));
});

it('uses the stored identity name consistently when metadata has no name', async () => {
  names('');
  const db = new Database(dbPath);
  db.prepare(
    "UPDATE contexts SET content = json_set(content, '$.project_name', ?) WHERE id = 'project_identity'"
  ).run('Identity-only name');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const before = hash();
  expect((await readDigestV2(root)).project.name).toBe('Identity-only name');
  expect(readSignals(dbPath, { now: Date.now() }).project.name).toBe('Identity-only name');
  const answer = await executeMissionProtocolTool(
    'rbook_agent_onboard',
    { projectRoot: root },
    {} as never
  );
  expect(answer.isError).not.toBe(true);
  expect(answer.structuredContent).toMatchObject({
    data: { project: { name: 'Identity-only name' } },
  });
  expect(hash()).toBe(before);
});

it('fails loudly if the empty-record check cannot read optional local history', async () => {
  const db = new Database(dbPath);
  db.exec('CREATE VIEW agent_feedback AS SELECT * FROM missing_feedback_source');
  db.close();
  await expect(readDigestV2(root)).rejects.toThrow(/missing_feedback_source/);
});

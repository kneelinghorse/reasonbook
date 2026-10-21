// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m03 — reasonbook brief: the weekly brief over every project this machine registers, by the library's renderer,
// ABOUTME: a store that cannot be opened named as unreadable, --format json the sections as data, and bad options refused.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { BRIEF_MAX_LINES, type Brief } from '../../src/signals';
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
let busyId: string;
let goneId: string;
const saved = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };

async function project(name: string): Promise<{ root: string; dbPath: string; projectId: string }> {
  const root = tmp('rbook-cli-brief-');
  expect((await rbookProjectInit({ projectRoot: root, projectName: name } as never)).success).toBe(
    true
  );
  const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  const db = new Database(dbPath, { readonly: true });
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
  const config = tmp('rbook-cli-brief-home-');
  process.env.RBOOK_CONFIG_DIR = config;
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  env = { ...process.env, RBOOK_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: '' };
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  const busy = await project('Busy');
  busyId = busy.projectId;
  const db = new Database(busy.dbPath);
  try {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    insertDraft(run, {
      text: 'A choice for the operator.',
      kind: 'decision',
      sourceSession: null,
      assistantExcerpt: null,
      evidence: [],
      outsideContent: null,
      createdAt: new Date(Date.now() - DAY).toISOString(),
    });
  } finally {
    db.close();
  }
  const gone = await project('Gone');
  goneId = gone.projectId;
  fs.rmSync(path.join(gone.root, 'rbook', 'db'), { recursive: true, force: true });
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
  return { code: await runCli(['brief', ...argv], io), stdout, stderr };
}

describe('reasonbook brief (s97-m03)', () => {
  it('prints the week over every registered project, naming a store it cannot open', async () => {
    const result = await run([]);
    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(result.stdout).toMatch(/^# Weekly brief, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\n/);
    expect(result.stdout).toContain(`2 projects; 1 could not be read (${goneId})`);
    expect(result.stdout).toMatch(new RegExp(`- Busy \\(${busyId}\\): 1 draft \\(P1\\), oldest `));
    expect(result.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
  });

  it('prints the sections as data with --format json, over the window --days names', async () => {
    const result = await run(['--days', '14', '--format', 'json']);
    expect(result.code).toBe(0);
    const brief = JSON.parse(result.stdout) as Brief;
    expect(brief).toMatchObject({ windowDays: 14, projects: 2, unreadable: [goneId] });
    expect(brief.sections[0]).toMatchObject({
      id: 'needs_a_decision',
      items: [{ projectId: busyId, ids: ['P1'] }],
    });
  });

  it('refuses a window or a format it cannot use', async () => {
    for (const argv of [
      ['--days', '0'],
      ['--days', 'week'],
      ['--format', 'html'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(1);
      expect(result.stderr[0]).toContain('Usage: reasonbook brief');
    }
  });
});

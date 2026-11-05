// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Registry maintenance selects a registered folder, never the identity in its project database.
// ABOUTME: Scratch v1 registries prove preview avoids schema/backfill writes and apply changes one archive field.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { CliTelemetry } from '../../src/cli/telemetry';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

jest.mock('../../src/cli/telemetry', () => ({
  CliTelemetry: jest.fn(() => ({ resolve: jest.fn(), patch: jest.fn(), finish: jest.fn() })),
}));

let scratch: string;
let config: string;
let registryFile: string;
let selected: string;
let other: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  jest.clearAllMocks();
  ProjectGraphRegistry.resetInstance();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-registry-cli-'));
  config = path.join(scratch, 'config');
  registryFile = path.join(config, 'project-graph.sqlite');
  selected = path.join(scratch, 'selected project');
  other = path.join(scratch, 'other project');
  for (const directory of [config, selected, other]) fs.mkdirSync(directory);
  env = { HOME: scratch, RBOOK_CONFIG_DIR: config };
  const db = new Database(registryFile);
  try {
    // Deliberately old: create() would add columns/tables and consume compatibility markers.
    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY, store_path TEXT NOT NULL, name TEXT NOT NULL,
        registered_at INTEGER, last_seen_at INTEGER, schema_version INTEGER, archived_at INTEGER
      );
      CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const now = Date.now();
    const insert = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, 1, NULL)');
    insert.run('selected-id', selected, 'Selected', now, now);
    insert.run('other-id', other, 'Other', now, now);
  } finally {
    db.close();
  }
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function state() {
  const db = new Database(registryFile, { readonly: true, fileMustExist: true });
  try {
    return {
      rows: db.prepare('SELECT * FROM projects ORDER BY project_id').all() as Array<{
        project_id: string;
        archived_at: number | null;
      }>,
      schema: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
      metadata: db.prepare('SELECT * FROM registry_meta ORDER BY key').all(),
    };
  } finally {
    db.close();
  }
}

async function call(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    env: { ...env, ...overrides },
    cwd: scratch,
    readStdin: jest.fn(async () => {
      throw new Error('Registry maintenance must not read stdin');
    }),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const code = await runCli(['registry', ...args], io);
  expect(io.readStdin).not.toHaveBeenCalled();
  return { code, out: stdout.join(''), err: stderr.join('\n') };
}
const args = (action = 'archive', root = selected) => [action, '--project-root', root];

function projectCopy(root: string) {
  const dir = path.join(root, 'rbook', 'db');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'rbook.sqlite'));
  try {
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('project_id', 'other-id');
  } finally {
    db.close();
  }
}

describe('registry archive and restore', () => {
  it('previews an existing row without schema, backfill or row changes and without telemetry', async () => {
    const before = state();
    const report = await call([...args(), '--format', 'json']);
    expect(report.code).toBe(0);
    expect(JSON.parse(report.out)).toMatchObject({
      success: true,
      data: { action: 'archive', dryRun: true, changed: false, projectId: 'selected-id' },
    });
    expect(report.out).toContain("project's next write-open restores it");
    expect(state()).toEqual(before);
    expect(CliTelemetry).not.toHaveBeenCalled();
  });

  it('applies only the selected archive field, restores it, and makes repeats no-ops', async () => {
    const before = state();
    expect((await call([...args(), '--apply'])).code).toBe(0);
    const archived = state();
    const index = archived.rows.findIndex((row) => row.project_id === 'selected-id');
    expect(archived.rows[index].archived_at).toEqual(expect.any(Number));
    const expected = {
      ...before,
      rows: before.rows.map((row, i) =>
        i === index ? { ...row, archived_at: archived.rows[index].archived_at } : row
      ),
    };
    expect(archived).toEqual(expected);
    const again = await call([...args(), '--apply', '--format=json']);
    expect(JSON.parse(again.out)).toMatchObject({ success: true, data: { changed: false } });
    expect(state()).toEqual(archived);
    const preview = await call([...args('restore'), '--format=json']);
    expect(preview.code).toBe(0);
    expect(state()).toEqual(archived);
    expect((await call([...args('restore'), '--apply'])).code).toBe(0);
    expect(state()).toEqual(before);
    expect(
      JSON.parse((await call([...args('restore'), '--apply', '--format=json'])).out)
    ).toMatchObject({ success: true, data: { changed: false } });
    expect(state()).toEqual(before);
  });

  it('archives a registered folder even after the project folder is gone', async () => {
    fs.rmdirSync(selected);
    expect((await call([...args(), '--apply'])).code).toBe(0);
    expect(
      state().rows.find((row) => row.project_id === 'selected-id')?.archived_at
    ).not.toBeNull();
    expect(fs.existsSync(selected)).toBe(false);
  });

  it('selects by registered path even when that project database holds another row’s id', async () => {
    projectCopy(selected);
    const projectFile = path.join(selected, 'rbook', 'db', 'rbook.sqlite');
    const beforeFile = fs.readFileSync(projectFile);
    expect((await call([...args(), '--apply'])).code).toBe(0);
    expect(state().rows.find((row) => row.project_id === 'other-id')?.archived_at).toBeNull();
    expect(
      state().rows.find((row) => row.project_id === 'selected-id')?.archived_at
    ).not.toBeNull();
    expect(fs.readFileSync(projectFile)).toEqual(beforeFile);
  });

  it('refuses an unregistered copied folder without following its project id', async () => {
    const copied = path.join(scratch, 'unregistered copy');
    projectCopy(copied);
    const before = state();
    const report = await call([...args('archive', copied), '--apply', '--format=json']);
    expect(report.code).toBe(1);
    expect(JSON.parse(report.out)).toMatchObject({
      success: false,
      error: { suggestion: expect.any(String) },
    });
    expect(report.out).toContain('registered');
    expect(state()).toEqual(before);
  });

  it('resolves relative roots, trailing separators and a physical directory alias', async () => {
    const alias = path.join(scratch, 'alias');
    fs.symlinkSync(selected, alias, 'dir');
    const report = await call([...args('archive', 'alias/'), '--apply']);
    expect(report.code).toBe(0);
    expect(
      state().rows.find((row) => row.project_id === 'selected-id')?.archived_at
    ).not.toBeNull();
    expect((await call([...args('restore', selected + path.sep), '--apply'])).code).toBe(0);
    expect(state().rows.every((row) => row.archived_at === null)).toBe(true);
  });

  it.each([false, true])(
    'refuses a missing registry without creating configuration (apply=%s)',
    async (apply) => {
      fs.rmSync(config, { recursive: true });
      const report = await call([...args(), ...(apply ? ['--apply'] : [])]);
      expect(report.code).toBe(1);
      expect(report.err).toMatch(/registry/i);
      expect(fs.existsSync(config)).toBe(false);
      expect(CliTelemetry).not.toHaveBeenCalled();
    }
  );

  it('uses scratch HOME for the ordinary config fallback when the config variable is unset', async () => {
    const fallback = path.join(scratch, '.config', 'rbook');
    fs.mkdirSync(path.dirname(fallback));
    fs.renameSync(config, fallback);
    registryFile = path.join(fallback, 'project-graph.sqlite');
    const report = await call([...args(), '--format=json'], { RBOOK_CONFIG_DIR: undefined });
    expect(report.code).toBe(0);
    expect(JSON.parse(report.out).data.projectId).toBe('selected-id');
    expect(state().rows.every((row) => row.archived_at === null)).toBe(true);
  });

  it('allows local registry maintenance in directory mode without opening the project database', async () => {
    const dbDir = path.join(selected, 'rbook', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const file = path.join(dbDir, 'rbook.sqlite');
    fs.writeFileSync(file, 'deliberately not a SQLite record');
    const report = await call([...args(), '--apply'], { RBOOK_EDITION: 'directory' });
    expect(report.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('deliberately not a SQLite record');
    expect(CliTelemetry).not.toHaveBeenCalled();
  });

  it('keeps preview available to review agents but refuses their apply before registry access', async () => {
    expect((await call(args(), { RBOOK_AGENT_ROLE: 'review' })).code).toBe(0);
    ProjectGraphRegistry.resetInstance();
    fs.rmSync(config, { recursive: true });
    const report = await call([...args(), '--apply'], { RBOOK_AGENT_ROLE: 'review' });
    expect(report.code).toBe(1);
    expect(report.err).toMatch(/read|review/i);
    expect(fs.existsSync(config)).toBe(false);
  });

  it('prints useful text by default, with help inert before opening a registry', async () => {
    expect((await call(args())).out).toMatch(/Preview:.*--apply/);
    fs.rmSync(config, { recursive: true });
    const report = await call(['--help']);
    expect(report.code).toBe(0);
    expect(report.out).toContain('registry archive|restore --project-root <root>');
    expect(fs.existsSync(config)).toBe(false);
  });

  it.each([
    [],
    ['delete'],
    ['archive'],
    ['archive', '--project-root'],
    ['archive', '--project-root='],
    ['archive', '--project-root=/a', '--project-root=/b'],
    ['archive', '--project-root=/a', '--apply=false'],
    ['archive', '--project-root=/a', '--apply', '--apply'],
    ['archive', '--project-root=/a', '--format=xml'],
    ['archive', '--project-root=/a', '--format'],
    ['archive', '--project-root=/a', '--unknown'],
    ['archive', '--project-root=/a', 'extra'],
  ])('refuses invalid arguments %j without changing rows', async (...argv) => {
    const before = state();
    expect((await call(argv)).code).toBe(1);
    expect(state()).toEqual(before);
    expect(CliTelemetry).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Record operations clear abandoned private copies even with dashboard uploads switched off.
// ABOUTME: A test-owned temp root proves age/owner/link safety and cleanup after replay setup fails.

import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sweepStaleUploadCopies } from '../../../src/tools/rbook/dashboard-upload';
import { joinThroughDashboard } from '../../../src/tools/rbook/record-dashboard-join';
import { shareThroughDashboard } from '../../../src/tools/rbook/record-dashboard-share';
import { openImportCopy } from '../../../src/tools/rbook/record-import-copy';
import { replayCheck } from '../../../src/tools/rbook/record-replay';

const PREFIXES = ['reasonbook-upload-', 'reasonbook-join-', 'rbook-import-', 'rbook-replay-'];
const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let me: number;
let restoreTmp: () => void;
let previousSharing: string | undefined;
let previousUploads: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-temp-cleanup-test-'));
  me = fs.lstatSync(tmp).uid;
  const spy = jest.spyOn(os, 'tmpdir').mockReturnValue(tmp);
  restoreTmp = () => spy.mockRestore();
  previousSharing = process.env.RBOOK_DASHBOARD_SHARING;
  previousUploads = process.env.RBOOK_CHECKPOINT_SYNC;
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  process.env.RBOOK_DASHBOARD_SHARING = 'off';
});

afterEach(() => {
  restoreTmp();
  if (previousSharing === undefined) delete process.env.RBOOK_DASHBOARD_SHARING;
  else process.env.RBOOK_DASHBOARD_SHARING = previousSharing;
  if (previousUploads === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = previousUploads;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function copy(name: string, age = 2 * DAY, parent = tmp): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record.sqlite'), 'private record');
  const at = (Date.now() - age) / 1000;
  fs.utimesSync(dir, at, at);
  return dir;
}

it.each(PREFIXES)('%s removes only old owned real directories among direct children', (prefix) => {
  const stale = copy(`${prefix}stale`);
  const fresh = copy(`${prefix}fresh`, DAY - 60_000);
  const foreign = copy(`${prefix}foreign`);
  const unrelated = copy(`x-${prefix}old`);
  const nested = copy(`${prefix}nested`, 2 * DAY, path.join(tmp, 'inside'));
  const target = copy('target');
  const link = path.join(tmp, `${prefix}link`);
  fs.symlinkSync(target, link, 'dir');
  const old = (Date.now() - 2 * DAY) / 1000;
  fs.lutimesSync(link, old, old);
  const file = path.join(tmp, `${prefix}file`);
  fs.writeFileSync(file, 'not a directory');
  fs.utimesSync(file, old, old);

  expect(
    sweepStaleUploadCopies({
      tmpdir: tmp,
      uid: me,
      lstat: (name) => {
        const stat = fs.lstatSync(name);
        return {
          isDirectory: () => stat.isDirectory(),
          mtimeMs: stat.mtimeMs,
          uid: name === foreign ? me + 1 : stat.uid,
        };
      },
    })
  ).toEqual([stale]);
  expect(fs.existsSync(stale)).toBe(false);
  for (const kept of [fresh, foreign, unrelated, nested, target, link, file])
    expect([kept, fs.existsSync(kept)]).toEqual([kept, true]);
  expect(fs.readFileSync(path.join(target, 'record.sqlite'), 'utf8')).toBe('private record');
});

it.each(PREFIXES)('%s keeps everything when ownership cannot be established', (prefix) => {
  const stale = copy(`${prefix}stale`);
  expect(sweepStaleUploadCopies({ tmpdir: tmp, uid: undefined })).toEqual([]);
  expect(fs.existsSync(stale)).toBe(true);
});

function abandoned(): string[] {
  return PREFIXES.map((prefix) => copy(`${prefix}abandoned`));
}

function expectSwept(copies: string[]): void {
  for (const dir of copies) expect([dir, fs.existsSync(dir)]).toEqual([dir, false]);
}

it('a refused dashboard share still sweeps copies with sharing and uploads disabled', async () => {
  const stale = abandoned();
  const open = async () => {
    throw new Error('disabled sharing must not open a store');
  };
  const result = await shareThroughDashboard(open, open, path.join(tmp, 'absent.sqlite'), {});
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('Sharing through the dashboard is off');
  expectSwept(stale);
});

it('a refused dashboard join still sweeps copies with sharing and uploads disabled', async () => {
  const stale = abandoned();
  const result = await joinThroughDashboard({ folder: path.join(tmp, 'join'), address: 'unused' });
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('Sharing through the dashboard is off');
  expectSwept(stale);
});

it('a local import sweeps without uploads and keeps the source unchanged', () => {
  const stale = abandoned();
  const source = path.join(tmp, 'source.sqlite');
  const db = new Database(source);
  db.exec('CREATE TABLE example(value TEXT)');
  db.close();
  const before = fs.readFileSync(source);
  const imported = openImportCopy(source);
  try {
    expectSwept(stale);
    expect(fs.existsSync(imported.dbPath)).toBe(true);
    expect(fs.readFileSync(source)).toEqual(before);
  } finally {
    imported.dispose();
  }
  expect(fs.existsSync(imported.dbPath)).toBe(false);
});

it('a local replay sweeps without uploads', () => {
  const stale = abandoned();
  expect(() =>
    replayCheck(path.join(tmp, 'store.sqlite'), path.join(tmp, 'absent.sqlite'))
  ).toThrow(/ENOENT/);
  expectSwept(stale);
});

it('a local replay removes its new folder when copying fails', () => {
  expect(() =>
    replayCheck(path.join(tmp, 'store.sqlite'), path.join(tmp, 'absent.sqlite'))
  ).toThrow(/ENOENT/);
  expect(fs.readdirSync(tmp)).toEqual([]);
});

it('a local replay removes its copied record when opening the live store fails', () => {
  const base = path.join(tmp, 'base.sqlite');
  const db = new Database(base);
  db.close();
  expect(() => replayCheck(path.join(tmp, 'absent', 'store.sqlite'), base)).toThrow();
  expect(fs.readdirSync(tmp)).toEqual(['base.sqlite']);
});

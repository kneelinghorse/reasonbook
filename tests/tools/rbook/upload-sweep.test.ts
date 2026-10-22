// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m08 — an upload that dies leaves a copy of the whole store in the temp folder; the next
// ABOUTME: upload removes only this user's day-old copies, never a fresh, foreign or linked one.

import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEGACY } from '../../../src/intelligence/legacy-compat';

import {
  sweepStaleUploadCopies,
  withUploadSnapshot,
} from '../../../src/tools/rbook/dashboard-upload';

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let me: number;

beforeEach(() => {
  // A temp folder of the test's own, so the sweep never touches a real user's copies.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sweep-'));
  me = fs.lstatSync(tmp).uid;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A copy as an upload leaves it: a folder holding the store's snapshot, last changed `ageMs` ago. */
function copy(name: string, ageMs: number, parent = tmp): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rbook.sqlite'), 'snapshot');
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(dir, at, at);
  return dir;
}

it('removes stale copies from either name so old snapshots do not survive the rename', () => {
  const legacy = copy(`${LEGACY.uploadPrefix}old`, 2 * DAY);
  const current = copy('rbook-dashboard-upload-old', 2 * DAY);
  expect(sweepStaleUploadCopies({ tmpdir: tmp, uid: me }).sort()).toEqual([legacy, current].sort());
});

/**
 * lstat as it is, except that `foreign` reads as another user's: a test without root cannot create a
 * folder another user owns.
 */
function lstatWithForeign(foreign: string) {
  return (file: string) => {
    const stat = fs.lstatSync(file);
    return {
      isDirectory: () => stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      uid: file === foreign ? stat.uid + 1 : stat.uid,
    };
  };
}

it("removes this user's day-old copy and keeps a fresh one, another user's, a symlink and the rest", () => {
  const stale = copy('rbook-dashboard-upload-stale', DAY + 60_000);
  const fresh = copy('rbook-dashboard-upload-fresh', 60_000);
  // Age is the protection (an upload lasts seconds, its lease five minutes), so a copy just under a
  // day old is kept, and only a name that starts with the prefix counts (the s95-m08 critic).
  const underADay = copy('rbook-dashboard-upload-23h', DAY - 60 * 60_000);
  const notOurs = copy('x-rbook-dashboard-upload-old', 2 * DAY);
  const foreign = copy('rbook-dashboard-upload-foreign', 2 * DAY);
  const target = copy('elsewhere', 2 * DAY);
  const link = path.join(tmp, 'rbook-dashboard-upload-link');
  fs.symlinkSync(target, link, 'dir');
  const old = (Date.now() - 2 * DAY) / 1000;
  fs.lutimesSync(link, old, old);
  const unrelated = copy('rbook-jest-old', 2 * DAY);
  const nested = copy('rbook-dashboard-upload-nested', 2 * DAY, path.join(tmp, 'inner'));

  const removed = sweepStaleUploadCopies({
    tmpdir: tmp,
    uid: me,
    lstat: lstatWithForeign(foreign),
  });

  expect(removed).toEqual([stale]);
  expect(fs.existsSync(stale)).toBe(false);
  for (const kept of [fresh, underADay, notOurs, foreign, link, target, unrelated, nested]) {
    expect([kept, fs.existsSync(kept)]).toEqual([kept, true]);
  }
  // The link's target is not followed.
  expect(fs.existsSync(path.join(target, 'rbook.sqlite'))).toBe(true);
});

it("keeps a day-old symlink named like a copy on the platform's own lstat", () => {
  const target = copy('elsewhere', 2 * DAY);
  const link = path.join(tmp, 'rbook-dashboard-upload-link');
  fs.symlinkSync(target, link, 'dir');
  const old = (Date.now() - 2 * DAY) / 1000;
  fs.lutimesSync(link, old, old);
  expect(sweepStaleUploadCopies({ tmpdir: tmp, uid: me })).toEqual([]);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

it('without user ids, as on Windows, keeps everything', () => {
  const stale = copy('rbook-dashboard-upload-stale', 2 * DAY);
  expect(sweepStaleUploadCopies({ tmpdir: tmp, uid: undefined })).toEqual([]);
  expect(fs.existsSync(stale)).toBe(true);
});

it('a copy it cannot read is reported and left, and the rest are still swept', () => {
  const unreadable = copy('rbook-dashboard-upload-a', 2 * DAY);
  const stale = copy('rbook-dashboard-upload-b', 2 * DAY);
  const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const removed = sweepStaleUploadCopies({
      tmpdir: tmp,
      uid: me,
      lstat: (file) => {
        if (file === unreadable) throw new Error('EACCES: permission denied');
        return fs.lstatSync(file);
      },
    });
    expect(removed).toEqual([stale]);
    expect(fs.existsSync(unreadable)).toBe(true);
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(`Could not remove the old record copy ${unreadable}: EACCES`)
    );
  } finally {
    write.mockRestore();
  }
});

it('an upload sweeps before it copies, and removes its own copy after', async () => {
  const stale = copy('rbook-dashboard-upload-stale', 2 * DAY);
  const store = path.join(tmp, 'store.sqlite');
  const db = new Database(store);
  db.exec('CREATE TABLE t(x)');
  db.close();
  let sent = '';
  await withUploadSnapshot(
    store,
    async (file) => {
      sent = file;
      expect(path.basename(path.dirname(file))).toMatch(/^rbook-dashboard-upload-/);
      expect(path.basename(file)).toBe(LEGACY.databaseFile);
      expect(fs.existsSync(stale)).toBe(false);
    },
    { tmpdir: tmp, uid: me }
  );
  expect(sent).not.toBe('');
  expect(fs.existsSync(sent)).toBe(false);
});

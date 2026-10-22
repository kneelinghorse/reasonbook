// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A stale-lock reclaim claim cannot delete a replacement inode or guess another claim is dead.
// ABOUTME: Owned filesystem fixtures exercise the interleavings without waiting for lease timeouts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withSyncLock } from '../../../src/tools/rbook/record-sync-trigger';

let tmp: string;
let store: string;
let file: string;
let saved: string | undefined;
beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-reclaim-')));
  store = path.join(tmp, 'store.sqlite');
  fs.writeFileSync(store, 'owned fixture');
  saved = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  await withSyncLock(store, async () => {
    const folder = path.join(tmp, 'config', 'sync-locks');
    file = path.join(folder, fs.readdirSync(folder)[0]);
  });
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }));
  jest.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid !== process.pid) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    return true;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('refuses an existing reclaim claim with an actionable remedy and keeps both files', async () => {
  const identity = fs.statSync(file);
  const claim = `${file}.${identity.dev}-${identity.ino}.reclaim`;
  fs.linkSync(file, claim);
  await expect(withSyncLock(store, async () => 'unsafe')).rejects.toThrow(
    /reclaim.*inspect|inspect.*reclaim/i
  );
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(claim)).toBe(true);
});

it('revalidates a claim that linked a newer inode after the original stale-owner read', async () => {
  const link = fs.linkSync;
  const old = fs.openSync(file, 'r');
  const replacement = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'new-owner' });
  const linked = jest.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
    fs.unlinkSync(source);
    fs.writeFileSync(source, replacement);
    link(source, destination);
  });
  try {
    expect(await withSyncLock(store, async () => 'unsafe')).toBeNull();
    expect(linked).toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  } finally {
    fs.closeSync(old);
  }
});

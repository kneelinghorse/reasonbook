// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Prevents work awaiting registration from creating another snapshot after shutdown starts.
// ABOUTME: Active cleanup is repeatable and the upload's later finally can still finish safely.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanupActiveUploadCopies,
  withUploadSnapshot,
} from '../../../src/tools/rbook/dashboard-upload';

it('cleans a pending copy and refuses snapshots that reach the upload stage after shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-cleanup-'));
  const source = path.join(directory, 'source.sqlite');
  const db = new Database(source);
  db.exec('CREATE TABLE witness(value TEXT)');
  db.close();
  let started!: (file: string) => void;
  const uploading = new Promise<string>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const stalled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const upload = withUploadSnapshot(
    source,
    (file) => {
      started(file);
      return stalled;
    },
    { tmpdir: directory }
  );
  try {
    const copy = await uploading;
    expect(fs.existsSync(copy)).toBe(true);
    cleanupActiveUploadCopies();
    cleanupActiveUploadCopies();
    expect(fs.existsSync(path.dirname(copy))).toBe(false);

    const send = jest.fn(async () => undefined);
    await expect(withUploadSnapshot(source, send, { tmpdir: directory })).rejects.toThrow(
      'shutting down'
    );
    expect(send).not.toHaveBeenCalled();
  } finally {
    finish();
    await upload;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

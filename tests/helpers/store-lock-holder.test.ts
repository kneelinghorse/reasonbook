// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s105-m01 — proves the lock holder blocks today's 100 ms lookup on a WAL store until its hold ends.
// ABOUTME: It must wait for other connections to close, report a marker that never came, and write nothing.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { targetForStore } from '../../src/tools/rbook/local-telemetry';
import { holdStore } from './store-lock-holder';

let root: string;
let dbPath: string;
function snapshot(): Buffer {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.serialize();
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-lock-holder-'));
  dbPath = path.join(root, 'rbook.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('project_id', 'fixture');
  db.pragma('journal_mode = WAL');
  db.close();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("holds a WAL store against today's lookup until its marker and the hold after it", async () => {
  const before = snapshot();
  const marker = path.join(root, 'marker');
  const hold = holdStore(dbPath, { marker, afterMarkerMs: 200 });
  try {
    expect(await hold.held).toMatchObject({ attempts: 1, marker, sawMarker: null });
    expect(targetForStore(dbPath)).toBeNull();
    fs.writeFileSync(marker, '');
    const record = await hold.released;
    expect(record).toMatchObject({ sawMarker: true, afterMarkerMs: 200 });
    expect(record.releasedAt).not.toBeNull();
    expect(targetForStore(dbPath)).toEqual({ projectId: 'fixture', dbPath });
    // The two-process test compares the store's bytes before and after: a hold must not write.
    expect(snapshot()).toEqual(before);
  } finally {
    await hold.stop();
  }
});

it('waits for another open connection to close before it holds', async () => {
  const open = new Database(dbPath, { readonly: true });
  open.prepare('SELECT value FROM metadata').get();
  const hold = holdStore(dbPath, { afterMarkerMs: 0 });
  try {
    // The holder says when the open connection first refuses it, however slowly it started.
    await hold.waiting;
    open.close();
    expect((await hold.held).attempts).toBeGreaterThan(1);
    expect((await hold.released).sawMarker).toBeNull();
  } finally {
    if (open.open) open.close();
    await hold.stop();
  }
});

it('records a marker that never came, and still lets go', async () => {
  const hold = holdStore(dbPath, {
    marker: path.join(root, 'never'),
    afterMarkerMs: 0,
    markerWaitMs: 100,
  });
  try {
    await hold.held;
    expect(await hold.released).toMatchObject({ sawMarker: false, markerSeenAt: null });
  } finally {
    await hold.stop();
  }
});

it('fails loudly when the store never comes free', async () => {
  const open = new Database(dbPath, { readonly: true });
  open.prepare('SELECT value FROM metadata').get();
  const hold = holdStore(dbPath, { afterMarkerMs: 0, freeWaitMs: 100 });
  try {
    await expect(hold.held).rejects.toThrow(/failed to take: SQLITE_BUSY/);
    await expect(hold.released).rejects.toThrow(/failed to take/);
  } finally {
    open.close();
    await hold.stop();
  }
});

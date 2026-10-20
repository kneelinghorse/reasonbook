// SPDX-License-Identifier: Apache-2.0
// ABOUTME: When a shared record syncs on its own (design §s96-m13 item 4): at session start and end, detached from the
// ABOUTME: hook, and on the server's timer, each under RBOOK_SHARED_SYNC alone; two triggers at once run one sync.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { resolveConfigDirectory, settingIsOff } from '../../intelligence/legacy-compat';
import { isReadOnlyAgentSession } from './read-only-agent-guard';

/** The shared record's own switch: off stops every sync it starts itself; RBOOK_CHECKPOINT_SYNC is another's. */
export const SHARED_SYNC_ENV = 'RBOOK_SHARED_SYNC';

/** A lock older than this is a dead sync's, however its holder looks. */
const STALE_LOCK_MS = 15 * 60 * 1000;
/** How often the server syncs each shared project it opened; each sync opens SSH connections. */
export const SHARED_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export function sharedSyncEnabled(): boolean {
  return !settingIsOff(SHARED_SYNC_ENV) && !isReadOnlyAgentSession();
}

/**
 * Whether this store is a copy of a shared record with a route to some other copy: only such a copy
 * starts a sync. Read from the raw file, so a hook pays one small read. A store that cannot be read
 * is no, and says why on stderr; `null` is that answer, for a caller that asks again later.
 */
export function syncsOnItsOwn(dbPath: string): boolean {
  return readsAsSyncing(dbPath) === true;
}

/** syncsOnItsOwn's answer, or null when the store could not be read (and stderr says why). */
export function readsAsSyncing(dbPath: string): boolean | null {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    const table = (name: string) =>
      db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!table('metadata') || !table('record_peers')) return false;
    return Boolean(
      db.prepare("SELECT 1 FROM metadata WHERE key = 'replica_id' AND value <> ''").get() &&
      db.prepare('SELECT 1 FROM record_peers WHERE route IS NOT NULL LIMIT 1').get()
    );
  } catch (error) {
    process.stderr.write(
      `[SYNC] Could not read ${dbPath} to see whether it syncs: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Start `reasonbook sync` for this project, detached: the caller, a hook, returns at once and never
 * waits on the network. `bin` is the Reasonbook entry this process runs.
 */
export function launchSync(projectRoot: string, bin: string = process.argv[1] ?? ''): boolean {
  // Only Reasonbook's own entry starts one: a hook run inside a test runner never spawns it. An
  // adapter runs `reasonbook hook` through the npm bin link, which names the entry by its own name.
  let entry = bin;
  try {
    entry = fs.realpathSync(bin);
  } catch {
    return false;
  }
  if (path.basename(entry) !== 'bin.js' || !fs.existsSync(path.join(path.dirname(entry), 'cli.js')))
    return false;
  const child = spawn(process.execPath, [entry, 'sync', '--project-root', projectRoot, '--auto'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', () => undefined);
  child.unref();
  return true;
}

function lockPath(dbPath: string): string {
  const key = createHash('sha256').update(path.resolve(dbPath)).digest('hex').slice(0, 32);
  return path.join(resolveConfigDirectory(), 'sync-locks', `${key}.lock`);
}

/** A lock file its holder has made but not yet written, read in that instant, is a live holder's. */
const UNWRITTEN_LOCK_MS = 5 * 1000;

function holderAlive(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    const { pid, at } = JSON.parse(text) as { pid: number; at: number };
    if (Date.now() - at > STALE_LOCK_MS) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      return !text && Date.now() - fs.statSync(file).mtimeMs < UNWRITTEN_LOCK_MS;
    } catch {
      return false;
    }
  }
}

/**
 * Run `work` while this process holds the copy's sync lock, or return null when another live sync
 * holds it: two triggers at once run one sync, and the second says so. A dead holder's lock is taken.
 */
export async function withSyncLock<T>(dbPath: string, work: () => Promise<T>): Promise<T | null> {
  const file = lockPath(dbPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (holderAlive(file)) return null;
      fs.rmSync(file, { force: true });
      continue;
    }
    try {
      return await work();
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: When a shared record syncs on its own (design §s96-m13 item 4): at session start and end, detached from the
// ABOUTME: hook, and on the server's timer, each under RBOOK_SHARED_SYNC alone; two triggers at once run one sync.

import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { resolveConfigDirectory, settingIsOff } from '../../intelligence/legacy-compat';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import { isActiveDashboardRoute, isDashboardRoute } from './record-dashboard-route';

/** The shared record's own switch: off stops every sync it starts itself; RBOOK_CHECKPOINT_SYNC is another's. */
export const SHARED_SYNC_ENV = 'RBOOK_SHARED_SYNC';

/** Refresh even during a long move; a delayed heartbeat never disproves a live PID. */
const LOCK_REFRESH_MS = 60 * 1000;
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
    if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'replica_id' AND value <> ''").get())
      return false;
    const rows = db
      .prepare('SELECT route FROM record_peers WHERE route IS NOT NULL')
      .all() as Array<{ route: string }>;
    // Parse every held route before deciding: malformed JSON must not become a silent "no".
    const routes: unknown[] = rows.map((row) => JSON.parse(row.route));
    return routes.some((route) => !isDashboardRoute(route) || isActiveDashboardRoute(route));
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
  const key = createHash('sha256').update(fs.realpathSync(dbPath)).digest('hex').slice(0, 32);
  return path.join(resolveConfigDirectory(), 'sync-locks', `${key}.lock`);
}

/** A lock file its holder has made but not yet written, read in that instant, is a live holder's. */
const UNWRITTEN_LOCK_MS = 5 * 1000;

interface LockSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly text: string;
}

/** Read the payload and identity through one descriptor, even if its pathname is replaced. */
function readLock(file: string): LockSnapshot | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { dev, ino, mtimeMs } = fs.fstatSync(fd);
    return { dev, ino, mtimeMs, text: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

function lockOwner(file: string, held: LockSnapshot): { pid: number; token?: string } {
  let owner: { pid?: unknown; token?: unknown };
  try {
    owner = JSON.parse(held.text);
  } catch {
    owner = {};
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
    throw new Error(
      `The sync lock ${file} has no verifiable owner. Inspect it and stop any sync using this store before removing the lock and retrying.`
    );
  return {
    pid: owner.pid as number,
    ...(typeof owner.token === 'string' ? { token: owner.token } : {}),
  };
}

function holderAlive(file: string, held: LockSnapshot): boolean {
  if (!held.text && Date.now() - held.mtimeMs < UNWRITTEN_LOCK_MS) return true;
  const owner = lockOwner(file, held);
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/** Recheck the observed inode and payload; a newer acquisition is never deliberately removed. */
function removeLock(file: string, held: LockSnapshot): void {
  const current = readLock(file);
  if (
    !current ||
    current.dev !== held.dev ||
    current.ino !== held.ino ||
    current.text !== held.text
  )
    return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Only one contender may unlink a dead inode; a link made after replacement proves nothing. */
function reclaimLock(file: string, held: LockSnapshot): void {
  const claim = `${file}.${held.dev}-${held.ino}.reclaim`;
  try {
    fs.linkSync(file, claim);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'EEXIST')
      throw new Error(
        `The sync lock has an existing reclaim claim ${claim}. Another sync may be reclaiming it; retry after it finishes. If it persists, inspect it and stop all syncs for this store before removing the claim and retrying.`
      );
    throw error;
  }
  const claimed = readLock(claim);
  try {
    if (
      claimed &&
      claimed.dev === held.dev &&
      claimed.ino === held.ino &&
      claimed.text === held.text
    )
      removeLock(file, held);
  } finally {
    if (claimed) removeLock(claim, claimed);
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
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = readLock(file);
      if (held && holderAlive(file, held)) return null;
      if (held) reclaimLock(file, held);
      continue;
    }
    let identity: fs.Stats | undefined;
    const token = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    let refreshError: unknown;
    const refresh = () => {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }), 0, 'utf8');
    };
    try {
      identity = fs.fstatSync(fd);
      refresh();
      timer = setInterval(() => {
        try {
          refresh();
        } catch (error) {
          refreshError = error;
          clearInterval(timer);
          process.stderr.write(
            `[SYNC] Could not refresh the sync lock ${file}: ${String(error)}\n`
          );
        }
      }, LOCK_REFRESH_MS);
      timer.unref();
      const result = await work();
      if (refreshError) throw refreshError;
      return result;
    } finally {
      if (timer) clearInterval(timer);
      try {
        const current = readLock(file);
        if (
          identity &&
          current &&
          current.dev === identity.dev &&
          current.ino === identity.ino &&
          (!current.text || lockOwner(file, current).token === token)
        )
          removeLock(file, current);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return null;
}

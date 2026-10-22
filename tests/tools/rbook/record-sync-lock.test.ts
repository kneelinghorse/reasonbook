// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A shared-sync lease excludes path aliases and survives a slow but live holder.
// ABOUTME: Owned scratch files prove refresh, refusal and cleanup without a long real-time wait.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { readsAsSyncing, withSyncLock } from '../../../src/tools/rbook/record-sync-trigger';

let tmp: string;
let store: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-lock-')));
  store = path.join(tmp, 'record.sqlite');
  fs.writeFileSync(store, 'owned fixture');
  saved = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});
function lockFile(): string {
  const folder = path.join(tmp, 'config', 'sync-locks');
  const locks = fs.readdirSync(folder).filter((name) => name.endsWith('.lock'));
  expect(locks).toHaveLength(1);
  return path.join(folder, locks[0]);
}
function hold() {
  let release!: () => void;
  const result = withSyncLock(
    store,
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve('held');
      })
  );
  return { result, release: () => release() };
}

it('one physical store has one lock through a symlink alias', async () => {
  const alias = path.join(tmp, 'alias.sqlite');
  fs.symlinkSync(store, alias);
  const held = hold();
  try {
    expect(await withSyncLock(alias, async () => 'overlap')).toBeNull();
  } finally {
    held.release();
    await held.result;
  }
});

it('refreshes a long move and clears its timer and file when done', async () => {
  jest.useFakeTimers();
  const held = hold();
  const file = lockFile();
  const first = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number };
  try {
    jest.advanceTimersByTime(16 * 60_000);
    const refreshed = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number };
    expect(refreshed.at).toBeGreaterThan(first.at);
    expect(await withSyncLock(store, async () => 'overlap')).toBeNull();
  } finally {
    held.release();
    await held.result;
  }
  expect(jest.getTimerCount()).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
});

it('never takes a verified live PID merely because its heartbeat was paused', async () => {
  const held = hold();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
  try {
    expect(await withSyncLock(store, async () => 'overlap')).toBeNull();
  } finally {
    clock.mockRestore();
    held.release();
    await held.result;
  }
});

it('does not refresh or remove a replacement lock owned by another acquisition', async () => {
  jest.useFakeTimers();
  const held = hold();
  const file = lockFile();
  fs.unlinkSync(file);
  const replacement = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'replacement' });
  fs.writeFileSync(file, replacement);
  try {
    jest.advanceTimersByTime(2 * 60_000);
    expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
  } finally {
    held.release();
    await held.result;
  }
  expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
  expect(jest.getTimerCount()).toBe(0);
});

it('cleans up its descriptor, timer and lock when work throws', async () => {
  jest.useFakeTimers();
  const close = jest.spyOn(fs, 'closeSync');
  await expect(
    withSyncLock(store, async () => {
      throw new Error('work failed');
    })
  ).rejects.toThrow('work failed');
  expect(close).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  expect(fs.readdirSync(path.join(tmp, 'config', 'sync-locks'))).toEqual([]);
  expect(await withSyncLock(store, async () => 'next')).toBe('next');
});

it('closes the acquired descriptor if inspecting it fails before work starts', async () => {
  const open = jest.spyOn(fs, 'openSync');
  const stat = jest.spyOn(fs, 'fstatSync').mockImplementationOnce(() => {
    throw new Error('stat failed');
  });
  const work = jest.fn(async () => 'unsafe');
  let descriptor: number | undefined;
  try {
    await expect(withSyncLock(store, work)).rejects.toThrow('stat failed');
    descriptor = open.mock.results[open.mock.calls.findIndex((args) => args[1] === 'wx')]
      .value as number;
    expect(work).not.toHaveBeenCalled();
    expect(() => fs.fstatSync(descriptor!)).toThrow(/bad file descriptor|EBADF/);
  } finally {
    stat.mockRestore();
    if (descriptor !== undefined)
      try {
        fs.closeSync(descriptor);
      } catch {
        /* Already closed. */
      }
  }
});

it('preserves an initial lock write failure and clears its owned empty file', async () => {
  const write = jest.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
    throw new Error('initial write failed');
  });
  const work = jest.fn(async () => 'unsafe');
  await expect(withSyncLock(store, work)).rejects.toThrow('initial write failed');
  write.mockRestore();
  expect(work).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(tmp, 'config', 'sync-locks'))).toEqual([]);
});

it('takes a proven dead PID but refuses malformed ownership instead of deleting it', async () => {
  const held = hold();
  const file = lockFile();
  held.release();
  await held.result;
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  });
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }));
  expect(await withSyncLock(store, async () => 'taken')).toBe('taken');
  kill.mockRestore();
  fs.writeFileSync(file, '{not valid JSON');
  await expect(withSyncLock(store, async () => 'unsafe')).rejects.toThrow(
    /lock.*owner|owner.*lock/i
  );
  expect(fs.readFileSync(file, 'utf8')).toBe('{not valid JSON');
});

it("two stale-lock reclaimers cannot remove one another's newly acquired lock", async () => {
  const held = hold();
  const file = lockFile();
  held.release();
  await held.result;
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }));
  jest.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid !== process.pid) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    return true;
  });
  const unlink = fs.unlinkSync;
  let inserted = false;
  let other: Promise<unknown> | undefined;
  let release: (() => void) | undefined;
  let active = 0;
  let peak = 0;
  jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (target === file && !inserted) {
      inserted = true;
      other = withSyncLock(store, () => {
        peak = Math.max(peak, ++active);
        return new Promise<void>((resolve) => {
          release = () => {
            active -= 1;
            resolve();
          };
        });
      }).catch((error: unknown) => error);
    }
    return unlink(target);
  });
  try {
    await withSyncLock(store, async () => {
      peak = Math.max(peak, ++active);
      active -= 1;
    });
    expect(inserted).toBe(true);
    expect(peak).toBe(1);
  } finally {
    release?.();
    await other;
  }
});

it('treats an inaccessible live PID as occupied, not abandoned', async () => {
  const held = hold();
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  });
  try {
    expect(await withSyncLock(store, async () => 'unsafe')).toBeNull();
  } finally {
    kill.mockRestore();
    held.release();
    await held.result;
  }
});

it('holds a fresh unwritten file but refuses an old file with no verifiable owner', async () => {
  const held = hold();
  const file = lockFile();
  held.release();
  await held.result;
  fs.writeFileSync(file, '');
  expect(await withSyncLock(store, async () => 'unsafe')).toBeNull();
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(file, old, old);
  await expect(withSyncLock(store, async () => 'unsafe')).rejects.toThrow(
    /lock.*owner|owner.*lock/i
  );
  expect(fs.existsSync(file)).toBe(true);
});

it('excludes an alias while a separate live process holds the physical store', async () => {
  const module = path.resolve('src/tools/rbook/record-sync-trigger.ts');
  const script = `require(${JSON.stringify(module)}).withSyncLock(process.argv[1], () => new Promise(resolve => { process.once('message', resolve); process.send('held'); })).then(() => process.disconnect(), error => { console.error(error); process.exit(1); });`;
  const child = spawn(
    process.execPath,
    ['-r', path.resolve('tests/helpers/ts-register.js'), '-e', script, store],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
  );
  let errors = '';
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`lock child exited ${code}: ${errors}`)));
    });
    const alias = path.join(tmp, 'child-alias.sqlite');
    fs.symlinkSync(store, alias);
    expect(await withSyncLock(alias, async () => 'overlap')).toBeNull();
  } finally {
    if (child.connected) child.send('release');
    else if (child.exitCode === null) child.kill();
    await exited;
  }
  expect(await withSyncLock(store, async () => 'released')).toBe('released');
});

function routeStore(routes: Array<string | null>): void {
  fs.unlinkSync(store);
  const db = new Database(store);
  try {
    db.exec(
      "CREATE TABLE metadata(key TEXT,value TEXT); INSERT INTO metadata VALUES('replica_id','ours'); CREATE TABLE record_peers(route TEXT)"
    );
    for (const route of routes) db.prepare('INSERT INTO record_peers VALUES(?)').run(route);
  } finally {
    db.close();
  }
}

it('keeps ended dashboard routes visible without starting automatic sync; active and SSH routes still start', () => {
  const dashboard = { kind: 'dashboard', url: 'https://example.test', projectId: 'p', ended: true };
  routeStore([JSON.stringify(dashboard), null]);
  expect(readsAsSyncing(store)).toBe(false);
  const db = new Database(store);
  try {
    db.prepare('INSERT INTO record_peers VALUES(?)').run(
      JSON.stringify({ ...dashboard, ended: undefined })
    );
  } finally {
    db.close();
  }
  expect(readsAsSyncing(store)).toBe(true);
  routeStore([JSON.stringify({ host: 'studio', root: '/project' })]);
  expect(readsAsSyncing(store)).toBe(true);
});

it('surfaces malformed persisted route JSON instead of silently disabling automatic sync', () => {
  routeStore(['{broken']);
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(readsAsSyncing(store)).toBeNull();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
});

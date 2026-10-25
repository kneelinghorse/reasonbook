// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (design §s96-m13 items 4, 5) — a shared copy with a route syncs on its own under RBOOK_SHARED_SYNC
// ABOUTME: alone, one sync per copy at a time, from Reasonbook's own entry; the review and status show each peer's health.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { resolveConfigDirectory } from '../../../src/intelligence/legacy-compat';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { rbookStatus } from '../../../src/tools/rbook/rbook-status';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { joinRoute } from '../../../src/tools/rbook/record-sync';
import {
  __resetSharedSyncScheduler,
  __runSharedSync,
  __sharedSyncTargets,
  observeSharedSync,
} from '../../../src/tools/rbook/record-sync-scheduler';
import {
  launchSync,
  sharedSyncEnabled,
  syncsOnItsOwn,
  withSyncLock,
} from '../../../src/tools/rbook/record-sync-trigger';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';
import { farEndsExited, routeTo, standinSsh } from '../../helpers/standin-ssh';
import Database from 'better-sqlite3';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../../helpers/upload-server-source';

let compiled: string;
let farEnd: string;
beforeAll(() => {
  const repo = path.resolve(__dirname, '../../..');
  // s102-m13: the source stand-in previously transpiled the CLI during every 120 s handshake.
  // Warm it before the transport starts; the production handshake deadline stays unchanged.
  compiled = prepareUploadServerSources(repo, ['src/cli.ts']);
  farEnd = path.join(compiled, 'sync-far-end.cjs');
  fs.writeFileSync(
    farEnd,
    `${uploadServerSourceLoader(compiled)}
require(${JSON.stringify(path.join(repo, 'src/cli.ts'))}).main(process.argv.slice(2));`
  );
}, 180_000);
afterAll(() => {
  if (compiled) fs.rmSync(compiled, { recursive: true, force: true });
});

let fixture: ReplicaFixture;
const keys = ['RBOOK_SHARED_SYNC', 'RBOOK_CHECKPOINT_SYNC'] as const;
let previous: Record<string, string | undefined>;
beforeEach(() => {
  fixture = replicaFixture('rbook-trigger-');
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
});
afterEach(async () => {
  for (const key of keys)
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  await farEndsExited(fixture.tmp);
  fixture.restore();
});

/** The owner's copy and a member's joined over the stand-in ssh, the route remembered on the owner. */
async function joinedPair(): Promise<{ owner: Copy; studio: { root: string; machine: string } }> {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
  const root = path.join(fixture.tmp, 'studio');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(owner.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  useMachine(fixture.tmp, 'machine-studio');
  writeUserAuthor('Darryl');
  const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
  const joined = await joinRoute(
    (step) => onCopy(fixture.tmp, owner, step),
    { ...routeTo(root, path.join(fixture.tmp, 'config-machine-studio')), bin: farEnd },
    'Darryl',
    { ssh }
  );
  if (!joined.success) throw new Error(JSON.stringify(joined.error));
  return { owner, studio: { root, machine: 'machine-studio' } };
}

async function cli(argv: string[]) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: process.env,
    cwd: fixture.tmp,
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  return { code: await runCli(argv, io), stdout, stderr };
}

describe('the switch and the target', () => {
  it('RBOOK_SHARED_SYNC=off turns off what the record starts itself; RBOOK_CHECKPOINT_SYNC=off leaves it alone', () => {
    expect(sharedSyncEnabled()).toBe(true);
    process.env.RBOOK_CHECKPOINT_SYNC = 'off';
    expect(sharedSyncEnabled()).toBe(true);
    process.env.RBOOK_SHARED_SYNC = 'off';
    expect(sharedSyncEnabled()).toBe(false);
  });

  it('only a shared copy with a route syncs on its own: not a member without one, not a solo store', async () => {
    const { owner, studio } = await joinedPair();
    useMachine(fixture.tmp, 'solo');
    const solo = project(fixture.tmp, 'solo');
    expect([owner.root, studio.root, solo].map((root) => syncsOnItsOwn(dbOf(root)))).toEqual([
      true,
      false,
      false,
    ]);
  }, 240000);
});

describe('one sync per copy at a time', () => {
  it('a second sync while one runs does nothing and says so, and a dead holder never blocks', async () => {
    const { owner } = await joinedPair();
    useMachine(fixture.tmp, owner.machine);
    let release!: () => void;
    const held = withSyncLock(
      dbOf(owner.root),
      () => new Promise<string>((resolve) => (release = () => resolve('first')))
    );
    const second = await cli(['sync', '--project-root', owner.root]);
    expect(second.stdout).toMatch(/already running, so this one did nothing/);
    release();
    expect(await held).toBe('first');
    // A lock a dead process left behind is taken, not waited on.
    const lockDir = path.join(fixture.tmp, `config-${owner.machine}`, 'sync-locks');
    let lockName = '';
    await withSyncLock(dbOf(owner.root), async () => {
      [lockName] = fs.readdirSync(lockDir);
    });
    expect(fs.readdirSync(lockDir)).toEqual([]);
    fs.writeFileSync(
      path.join(lockDir, lockName),
      JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() })
    );
    expect(await withSyncLock(dbOf(owner.root), async () => 'taken')).toBe('taken');
  }, 240000);

  it("a hook starts a sync only from Reasonbook's own entry, detached", async () => {
    expect(launchSync('/nowhere', path.join(fixture.tmp, 'jest.js'))).toBe(false);
    const dist = path.join(fixture.tmp, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const marker = path.join(fixture.tmp, 'launched.json');
    fs.writeFileSync(
      path.join(dist, 'bin.js'),
      `const fs = require('fs');\n` +
        `const marker = ${JSON.stringify(marker)}, temporary = marker + '.' + process.pid + '.tmp';\n` +
        `fs.writeFileSync(temporary, JSON.stringify(process.argv.slice(2)));\n` +
        `fs.renameSync(temporary, marker);\n`
    );
    fs.writeFileSync(path.join(dist, 'cli.js'), '');
    expect(launchSync('/some/project', path.join(dist, 'bin.js'))).toBe(true);
    for (let tries = 0; tries < 100 && !fs.existsSync(marker); tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    // s97-m10: a sync a hook starts is no person's, so it waits out a dashboard that keeps failing.
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual([
      'sync',
      '--project-root',
      '/some/project',
      '--auto',
    ]);
  }, 60000);
});

describe('sync health', () => {
  it("the owner's review and status name each member's copy, its last sync, pending and last error", async () => {
    const { owner } = await joinedPair();
    useMachine(fixture.tmp, owner.machine);
    const digest = renderDigestV2(await readDigestV2(owner.root)).text;
    expect(digest).toMatch(/Sync: Darryl's copy: synced \d+ min ago, 0 pending/);
    const status = await rbookStatus({ projectRoot: owner.root });
    expect(status.data!.shared_sync).toEqual([
      expect.objectContaining({
        peer: 'Darryl',
        pending: 0,
        last_error: null,
        last_synced_at: expect.any(String),
      }),
    ]);
  }, 240000);
});

describe('what starts a sync (s96-m13 build-time critics)', () => {
  /** A stand-in Reasonbook entry that writes the arguments it was started with. */
  function fakeEntry(): { readonly bin: string; readonly marker: string } {
    const dist = path.join(fixture.tmp, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const marker = path.join(fixture.tmp, 'launched.json');
    fs.writeFileSync(
      path.join(dist, 'bin.js'),
      `const fs = require('fs');\n` +
        `const marker = ${JSON.stringify(marker)}, temporary = marker + '.' + process.pid + '.tmp';\n` +
        `fs.writeFileSync(temporary, JSON.stringify(process.argv.slice(2)));\n` +
        `fs.renameSync(temporary, marker);\n`
    );
    fs.writeFileSync(path.join(dist, 'cli.js'), '');
    return { bin: path.join(dist, 'bin.js'), marker };
  }

  /** s98-m08: a launched process can take seconds to start on a loaded machine; 20 s, not 5. */
  async function launched(marker: string): Promise<unknown> {
    for (const until = Date.now() + 20_000; !fs.existsSync(marker) && Date.now() < until; )
      await new Promise((resolve) => setTimeout(resolve, 50));
    return fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  }

  it("a hook run through the npm bin link, as every adapter runs it, starts the sync from Reasonbook's entry", async () => {
    const { bin, marker } = fakeEntry();
    const link = path.join(fixture.tmp, 'npm-bin', 'reasonbook');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(bin, link);
    expect(launchSync('/some/project', link)).toBe(true);
    expect(await launched(marker)).toEqual(['sync', '--project-root', '/some/project', '--auto']);
  }, 60000);

  it('the session start and end hooks of a shared copy with a route start its sync', async () => {
    const { owner } = await joinedPair();
    const { bin, marker } = fakeEntry();
    const entry = process.argv[1];
    process.argv[1] = bin;
    try {
      for (const event of ['session-start', 'session-end']) {
        fs.rmSync(marker, { force: true });
        useMachine(fixture.tmp, owner.machine);
        await runCli(['hook', event, '--format', 'text'], {
          env: process.env,
          cwd: owner.root,
          // s98-m08: room load cannot spend (#1558); a hook out of its deadline launched nothing.
          startedAtMs: Date.now() + 20_000,
          readStdin: async () =>
            JSON.stringify({ cwd: owner.root, session_id: `hook-${event}`, source: 'startup' }),
          stdout: () => undefined,
          stderr: () => undefined,
        });
        expect(await launched(marker)).toEqual(['sync', '--project-root', owner.root, '--auto']);
      }
    } finally {
      process.argv[1] = entry;
    }
  }, 120000);

  it('an unwritten lock is held briefly, then refuses because its owner cannot be verified', async () => {
    const owner = await ownerCopy(fixture.tmp);
    useMachine(fixture.tmp, owner.machine);
    const dbPath = dbOf(owner.root);
    const key = createHash('sha256').update(fs.realpathSync(dbPath)).digest('hex').slice(0, 32);
    const lock = path.join(resolveConfigDirectory(), 'sync-locks', `${key}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    expect(await withSyncLock(dbPath, async () => 'ran')).toBeNull();
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    await expect(withSyncLock(dbPath, async () => 'ran')).rejects.toThrow(/no verifiable owner/);
    expect(fs.existsSync(lock)).toBe(true);
  }, 60000);

  it("the server's timer takes up a shared copy with a route, and asks again of a store it could not read", async () => {
    const { owner, studio } = await joinedPair();
    __resetSharedSyncScheduler();
    try {
      const later = path.join(fixture.tmp, 'later');
      fs.mkdirSync(path.dirname(dbOf(later)), { recursive: true });
      fs.writeFileSync(dbOf(later), 'not a store yet');
      useMachine(fixture.tmp, owner.machine);
      observeSharedSync(later);
      observeSharedSync(studio.root);
      observeSharedSync(owner.root);
      expect(__sharedSyncTargets()).toEqual([owner.root]);
      // Once that folder holds a copy of the owner's store, its next call takes it up.
      fs.rmSync(dbOf(later));
      const source = new Database(dbOf(owner.root));
      try {
        source.exec(`VACUUM INTO '${dbOf(later).replace(/'/g, "''")}'`);
      } finally {
        source.close();
      }
      // Asked again a sync interval later, not at every call.
      const now = Date.now();
      observeSharedSync(later);
      expect(__sharedSyncTargets()).toEqual([owner.root]);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1);
      try {
        observeSharedSync(later);
      } finally {
        clock.mockRestore();
      }
      expect([...__sharedSyncTargets()].sort()).toEqual([owner.root, later].sort());
    } finally {
      __resetSharedSyncScheduler();
    }
  }, 120000);
});

describe("the server's timer (s96-m13 critics, round 2)", () => {
  it('any tool call on a shared copy with a route hands it to the timer, and each tick syncs it', async () => {
    const { owner, studio } = await joinedPair();
    __resetSharedSyncScheduler();
    const path0 = process.env.PATH;
    process.env.PATH = `${path.join(fixture.tmp, 'bin')}:${path0 ?? ''}`;
    try {
      useMachine(fixture.tmp, owner.machine);
      expect((await call('rbook_status', { projectRoot: owner.root })).success).toBe(true);
      expect(__sharedSyncTargets()).toEqual([owner.root]);
      useMachine(fixture.tmp, owner.machine);
      const wrote = await call('rbook_decisions', {
        action: 'record',
        content: 'Synced by the timer.',
        projectRoot: owner.root,
      });
      expect(wrote.success).toBe(true);
      await __runSharedSync(owner.root);
      expect(
        read(
          studio as Copy,
          "SELECT id FROM strategic_decisions WHERE decision_text = 'Synced by the timer.'"
        )
      ).toHaveLength(1);
    } finally {
      process.env.PATH = path0;
      __resetSharedSyncScheduler();
    }
  }, 240000);
});

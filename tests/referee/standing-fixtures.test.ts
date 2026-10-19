// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 — practice 4's standing paths for the referee: this repository's own store hosted end to end, two processes
// ABOUTME: writing one referee store at once, bindings under configDir with the environment's folder unset, an old upload.
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { invite, members } from '../../src/referee';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import {
  ask,
  hostProject,
  joinThroughReferee,
  syncWithReferee,
  type Hosted,
} from '../helpers/referee-fixture';
import { reidentifyRbookTestStore } from '../helpers/seedRbookDb';
import { ownerCopy, read, recordedState, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-standing-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/**
 * A second process running the library on the same store, from source, as a second worker would.
 * It loads, says it is ready, and starts only when told, so its writes overlap the test's own;
 * each write's start and end time come back with its outcome.
 */
interface FarWorker {
  readonly ready: Promise<void>;
  go(): void;
  readonly done: Promise<Array<{ outcome: string; start: number; end: number }>>;
}

function inviteFromAnotherProcess(hosted: Hosted, accounts: readonly string[]): FarWorker {
  const script = path.join(fixture.tmp, 'other-worker.js');
  fs.writeFileSync(
    script,
    `require(${JSON.stringify(path.resolve(__dirname, '..', 'helpers', 'ts-register.js'))});
const { invite } = require(${JSON.stringify(path.resolve(__dirname, '..', '..', 'src', 'referee', 'index.ts'))});
process.stdout.write('ready\\n');
process.stdin.once('data', async () => {
  let head = ${JSON.stringify(hosted.referee.expectedHead)};
  const out = [];
  for (const accountId of ${JSON.stringify(accounts)}) {
    const start = Date.now();
    const outcome = await invite({ storePath: ${JSON.stringify(hosted.referee.storePath)}, configDir: ${JSON.stringify(hosted.referee.configDir)}, expectedHead: head }, { accountId, name: accountId.replace('acct-', '') });
    if (outcome.head) head = outcome.head;
    out.push({ outcome: outcome.result.success ? 'ok' : outcome.result.error.code, start, end: Date.now() });
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
});`
  );
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let readied: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (readied = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.startsWith('ready\n')) readied();
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Array<{ outcome: string; start: number; end: number }>>(
    (resolve, reject) =>
      child.on('exit', (code) =>
        code === 0 ? resolve(JSON.parse(stdout.slice('ready\n'.length))) : reject(new Error(stderr))
      )
  );
  return { ready, go: () => child.stdin.write('go\n'), done };
}

describe("the referee's standing fixture paths (s97-m09)", () => {
  it('two processes write one referee store at once; each waits its turn and nothing is lost', async () => {
    const hosted = await hostProject(fixture.tmp);
    const theirs = Array.from({ length: 8 }, (_, index) => `acct-far-${index}`);
    const ours = Array.from({ length: 8 }, (_, index) => `acct-near-${index}`);
    const far = inviteFromAnotherProcess(hosted, theirs);
    await far.ready;
    far.go();
    const near: Array<{ start: number; end: number }> = [];
    for (const accountId of ours) {
      const start = Date.now();
      const invited = await ask(hosted.referee, (location) =>
        invite(location, { accountId, name: accountId.replace('acct-', '') })
      );
      near.push({ start, end: Date.now() });
      expect(invited.error).toBeUndefined();
    }
    const farRuns = await far.done;
    expect(farRuns.map((run) => run.outcome)).toEqual(theirs.map(() => 'ok'));
    // The two processes really wrote at once: their write windows overlap.
    const span = (runs: ReadonlyArray<{ start: number; end: number }>) => ({
      from: Math.min(...runs.map((run) => run.start)),
      to: Math.max(...runs.map((run) => run.end)),
    });
    const [a, b] = [span(near), span(farRuns)];
    expect(a.from < b.to && b.from < a.to).toBe(true);
    const listed = (await ask(hosted.referee, (location) => members(location))).data!;
    expect(listed.map((member) => member.accountId).sort()).toEqual(
      ['acct-owner', ...theirs, ...ours].sort()
    );
  }, 240000);

  it('keeps its bindings under configDir alone, with the environment naming no folder or another one', async () => {
    const saved = { config: process.env.RBOOK_CONFIG_DIR, home: process.env.HOME };
    const home = path.join(fixture.tmp, 'empty-home');
    fs.mkdirSync(home);
    try {
      process.env.HOME = home;
      const hosted = await hostProject(fixture.tmp);
      delete process.env.RBOOK_CONFIG_DIR;
      expect(
        (
          await ask(hosted.referee, (location) =>
            invite(location, { accountId: 'acct-a', name: 'a' })
          )
        ).error
      ).toBeUndefined();
      process.env.RBOOK_CONFIG_DIR = path.join(fixture.tmp, 'elsewhere');
      expect(
        (
          await ask(hosted.referee, (location) =>
            invite(location, { accountId: 'acct-b', name: 'b' })
          )
        ).error
      ).toBeUndefined();
      expect(fs.existsSync(path.join(fixture.tmp, 'elsewhere', 'project-graph.sqlite'))).toBe(
        false
      );
      expect(fs.readdirSync(home)).toEqual([]);
      const [folder] = fs.readdirSync(path.join(hosted.referee.configDir, 'referees'));
      const registry = new Database(
        path.join(hosted.referee.configDir, 'referees', folder, 'project-graph.sqlite'),
        { readonly: true }
      );
      try {
        expect(
          registry.prepare('SELECT replica_id FROM replicas WHERE retired_at IS NULL').all()
        ).toEqual([{ replica_id: hosted.refereeReplica }]);
      } finally {
        registry.close();
      }
    } finally {
      if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
      else process.env.RBOOK_CONFIG_DIR = saved.config;
      process.env.HOME = saved.home;
    }
  }, 240000);

  it('refuses an upload that predates a recorded column, as the store it came from would need upgrading', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const upload = path.join(fixture.tmp, 'old-upload.sqlite');
    const source = new Database(dbOf(owner.root));
    try {
      source.exec(`VACUUM INTO '${upload}'`);
    } finally {
      source.close();
    }
    const old = new Database(upload);
    try {
      // A store from before the column: no index, trigger or column of it.
      for (const { name } of old
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'learnings'")
        .all() as Array<{ name: string }>)
        old.exec(`DROP TRIGGER "${name}"`);
      old.exec('DROP INDEX IF EXISTS idx_learnings_evergreen');
      old.exec('ALTER TABLE learnings DROP COLUMN evergreen');
    } finally {
      old.close();
    }
    await expect(buildFreshCopy(upload, path.join(fixture.tmp, 'fresh.sqlite'))).rejects.toThrow(
      /learnings lacks recorded columns: evergreen/
    );
  }, 120000);
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The hosted real-store fire hands this repository's own store at the 4.1.0 release, shared, to a referee and joins a member to it; the public mirror carries neither.",
  revisions: { release: 'v4.1.0' },
});

PRIVATE.describe("this repository's own store, hosted (practice 4's real-store fire)", () => {
  it('hands in, joins a member from a first copy, and converges on every recorded value', async () => {
    const root = path.join(fixture.tmp, 'owner');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '..', '..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root, 'p-shared');
    const started = Date.now();
    const hosted = await hostProject(fixture.tmp, { realStore: root });
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    process.stdout.write(
      `[s97-m09] the v4.1.0 store handed in and joined in ${Date.now() - started} ms\n`
    );
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this on the real record.',
    });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    expect(
      read(
        hosted.owner,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Darryl decided this on the real record.'"
      )
    ).toEqual([{ n: 1 }]);
    expect(recordedState(darryl)).toEqual(recordedState(hosted.owner));
    expect(
      read<{ n: number }>(darryl, 'SELECT count(*) AS n FROM strategic_decisions')[0].n
    ).toBeGreaterThan(1000);
  }, 600000);
});

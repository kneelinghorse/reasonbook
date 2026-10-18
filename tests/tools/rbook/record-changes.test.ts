// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m03 (ADR s96 §4) — every change to a shared table is recorded in the same transaction as its row, one
// ABOUTME: change per row for a set-based write, and replaying the log onto the replay base reproduces the record.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import {
  resetFirstWriteMaintenance,
  runFirstWriteMaintenance,
} from '../../../src/tools/rbook/first-write-maintenance';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordedChange, recordedExecute } from '../../../src/tools/rbook/record-changes';
import { reidentifyReplica } from '../../../src/tools/rbook/replica-check';
import { readReplicaIdentity } from '../../../src/tools/rbook/replica-identity';
import { replayCheck } from '../../../src/tools/rbook/record-replay';
import { saveReplayBase, shareRecord } from '../../../src/tools/rbook/record-share';
import { guardProblems, readGuardState } from '../../../src/tools/rbook/record-guards';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import {
  call,
  dbOf,
  project,
  record,
  replicaFixture,
  useMachine,
  withClient,
  type Answer,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store replay shares a copy of this repository's own store, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.0.2' },
});

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-record-');
  useMachine(fixture.tmp, 'air');
});
afterEach(() => fixture.restore());

const DAY = 24 * 60 * 60 * 1000;

/** Make a store the first authority copy of a shared record, as the share step does. */
async function shareStore(root: string): Promise<string> {
  // ADR §4: the baseline names its owner, so the share step needs an author name.
  writeUserAuthor('Owner');
  return withClient(
    root,
    (client) => {
      const readiness = prepareForSharing(client);
      if (!readiness.ready) throw new Error(readiness.problems.join(' '));
      return shareRecord(client).replayBase;
    },
    { replicaCheck: false }
  );
}

async function shared(name = 'owner'): Promise<{ root: string; base: string }> {
  const root = project(fixture.tmp, name);
  return { root, base: await shareStore(root) };
}

function rows<T>(root: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** A write a test makes to set up state, recorded through the change helper like any other. */
async function recordedSetup(root: string, sql: string, params: unknown[] = []): Promise<void> {
  const done = await withClient(root, (client) => recordedExecute(client, sql, params));
  if (!done.success) throw new Error(done.error?.message);
}

/** A step of a workflow must succeed; its error, when it does not, is the failure message. */
async function ok(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const answer = await call(tool, args);
  if (!answer.success)
    throw new Error(`${tool} ${String(args.action)}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** Every converted tool path, through dispatch, on a shared record. */
async function workflow(root: string): Promise<void> {
  const projectRoot = root;
  await ok('rbook_sprint', {
    action: 'add',
    sprintId: 'sprint-1',
    title: 'One',
    status: 'Planned',
    projectRoot,
  });
  await ok('rbook_sprint', {
    action: 'add',
    sprintId: 'sprint-2',
    title: 'Two',
    status: 'Planned',
    projectRoot,
  });
  await ok('rbook_mission', {
    action: 'add',
    missionId: 's1-m01',
    name: 'First',
    sprintId: 'sprint-1',
    projectRoot,
  });
  await ok('rbook_mission', {
    action: 'add',
    missionId: 's1-m02',
    name: 'Second',
    sprintId: 'sprint-1',
    projectRoot,
  });
  await ok('rbook_mission', { action: 'depends', fromId: 's1-m02', toId: 's1-m01', projectRoot });
  await ok('rbook_mission_transition', {
    action: 'start',
    missionId: 's1-m01',
    notes: 'Begun.',
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'block',
    missionId: 's1-m01',
    reason: 'Waiting.',
    blockers: ['an answer'],
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'unblock',
    missionId: 's1-m01',
    resolution: 'Answered.',
    projectRoot,
  });
  await ok('rbook_mission', {
    action: 'update',
    missionId: 's1-m02',
    fields: { objective: 'Do the second thing.' },
    projectRoot,
  });
  await ok('rbook_mission', { action: 'undepends', fromId: 's1-m02', toId: 's1-m01', projectRoot });
  await ok('rbook_mission', {
    action: 'move',
    missionId: 's1-m02',
    toSprintId: 'sprint-2',
    reason: 'Later.',
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'defer',
    missionId: 's1-m02',
    reason: 'Parked.',
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'drop',
    missionId: 's1-m02',
    reason: 'Not needed.',
    projectRoot,
  });
  const decision = await ok('rbook_decisions', {
    action: 'record',
    content: 'A choice made here.',
    missionId: 's1-m01',
    projectRoot,
  });
  await ok('rbook_decisions', {
    action: 'record',
    content: 'A better choice.',
    supersedes: [decision.data?.decisionId],
    projectRoot,
  });
  const other = await ok('rbook_decisions', {
    action: 'record',
    content: 'Another choice.',
    projectRoot,
  });
  await ok('rbook_decisions', {
    action: 'update',
    decisionId: other.data?.decisionId,
    status: 'archived',
    projectRoot,
  });
  await ok('rbook_decisions', {
    action: 'batch_update',
    decisionIds: [other.data?.decisionId],
    status: 'active',
    projectRoot,
  });
  const learning = await ok('rbook_session', {
    action: 'capture',
    category: 'learning',
    content: 'A lesson learned here.',
    missionId: 's1-m01',
    projectRoot,
  });
  const learningId = learning.data?.learningId;
  await ok('rbook_learnings', { action: 'update', learningId, evergreen: true, projectRoot });
  await ok('rbook_learnings', { action: 'reaffirm', learningId, projectRoot });
  await ok('rbook_session', {
    action: 'capture',
    category: 'constraint',
    content: 'A rule that holds here.',
    projectRoot,
  });
  await ok('rbook_session', {
    action: 'capture',
    category: 'next-step',
    content: 'Something to do next.',
    projectRoot,
  });
  await ok('rbook_session', {
    action: 'capture',
    category: 'next-step',
    content: 'Another thing to do.',
    projectRoot,
  });
  await ok('rbook_session', { action: 'complete', summary: 'The session closed.', projectRoot });
  const steps = rows<{ id: number }>(
    root,
    "SELECT id FROM next_steps WHERE status = 'pending' ORDER BY id"
  );
  await ok('rbook_context', {
    action: 'next_steps',
    nextStepAction: 'complete',
    nextStepIds: [steps[0].id],
    projectRoot,
  });
  await ok('rbook_context', {
    action: 'next_steps',
    nextStepAction: 'reopen',
    nextStepIds: [steps[0].id],
    projectRoot,
  });
  await ok('rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    carryToSprint: 'sprint-2',
    projectRoot,
  });
  const constraints = rows<{ id: number }>(root, 'SELECT id FROM constraints ORDER BY id');
  await ok('rbook_context', {
    action: 'constraints',
    constraintAction: 'reaffirm',
    constraintId: constraints[0].id,
    evergreen: true,
    projectRoot,
  });
  await ok('rbook_context', {
    action: 'constraints',
    constraintAction: 'archive',
    constraintIds: [constraints[0].id],
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'complete',
    missionId: 's1-m01',
    notes: 'Finished.',
    projectRoot,
  });
  await ok('rbook_sprint', {
    action: 'update',
    sprintId: 'sprint-2',
    fields: { focus: 'The second focus.' },
    projectRoot,
  });
  // The seed is a build project, so a change of type is what records both keys.
  await ok('rbook_project', { action: 'update', projectType: 'managed', projectRoot });
  await ok('rbook_context', {
    action: 'update',
    contextType: 'project_identity',
    fieldUpdates: [{ path: 'description', value: 'A shared project.' }],
    projectRoot,
  });
  await ok('rbook_sprint', {
    action: 'complete',
    sprintId: 'sprint-1',
    summary: 'Closed.',
    projectRoot,
  });
}

/** The converted branches the first workflow does not take, each through dispatch. */
async function branches(root: string): Promise<void> {
  const projectRoot = root;
  for (const [sprintId, title] of [
    ['sprint-1', 'One'],
    ['sprint-2', 'Two'],
  ])
    await ok('rbook_sprint', { action: 'add', sprintId, title, status: 'Planned', projectRoot });
  await ok('rbook_mission', {
    action: 'add',
    missionId: 'b-m01',
    name: 'Branches',
    sprintId: 'sprint-1',
    projectRoot,
  });
  await ok('rbook_mission_transition', { action: 'start', missionId: 'b-m01', projectRoot });
  // One open sprint at a time: opening another demotes the first.
  await ok('rbook_sprint', {
    action: 'update',
    sprintId: 'sprint-2',
    fields: { status: 'Active' },
    projectRoot,
  });
  await ok('rbook_sprint', {
    action: 'update',
    sprintId: 'sprint-1',
    fields: { status: 'Active' },
    projectRoot,
  });
  const learning = await ok('rbook_session', {
    action: 'capture',
    category: 'learning',
    content: 'A lesson to cite.',
    projectRoot,
  });
  const learningId = learning.data?.learningId;
  // A decision that cites a learning reaffirms it.
  await ok('rbook_decisions', {
    action: 'record',
    content: 'A choice citing the lesson.',
    citesLearningIds: [learningId],
    projectRoot,
  });
  // An update that changes nothing still stamps the review; a reaffirm with and without the flag.
  await ok('rbook_learnings', { action: 'update', learningId, status: 'active', projectRoot });
  await ok('rbook_learnings', { action: 'reaffirm', learningId, projectRoot });
  await ok('rbook_learnings', { action: 'reaffirm', learningId, evergreen: false, projectRoot });
  const kept = await ok('rbook_decisions', { action: 'record', content: 'Kept.', projectRoot });
  const archived = await ok('rbook_decisions', {
    action: 'record',
    content: 'Archived.',
    projectRoot,
  });
  const decisionIds = [kept.data?.decisionId, archived.data?.decisionId];
  // Both already active: each gets only its review stamp. Then one changes status.
  await ok('rbook_decisions', {
    action: 'batch_update',
    decisionIds,
    status: 'active',
    projectRoot,
  });
  await ok('rbook_decisions', {
    action: 'batch_update',
    decisionIds: [archived.data?.decisionId],
    status: 'archived',
    projectRoot,
  });
  // An expired constraint, archived by the call that names none.
  await ok('rbook_session', {
    action: 'capture',
    category: 'constraint',
    content: 'Held until yesterday.',
    expiresAt: new Date(Date.now() - DAY).toISOString(),
    projectRoot,
  });
  await ok('rbook_context', { action: 'constraints', constraintAction: 'archive', projectRoot });
  await ok('rbook_session', {
    action: 'capture',
    category: 'constraint',
    content: 'Holds on.',
    projectRoot,
  });
  const [holding] = rows<{ id: number }>(
    root,
    "SELECT id FROM constraints WHERE status = 'active' ORDER BY id"
  );
  await ok('rbook_context', {
    action: 'constraints',
    constraintAction: 'reaffirm',
    constraintId: holding.id,
    projectRoot,
  });
  // A constraint captured and then archived is extracted again when its session closes, and the
  // close's nextSteps[] makes rows of its own.
  await ok('rbook_context', {
    action: 'constraints',
    constraintAction: 'archive',
    constraintIds: [holding.id],
    projectRoot,
  });
  await ok('rbook_session', {
    action: 'complete',
    summary: 'Closed.',
    nextSteps: ['A step from the close.', 'Another step from the close.'],
    projectRoot,
  });
  const [step, lapsing] = rows<{ id: number }>(
    root,
    "SELECT id FROM next_steps WHERE status = 'pending' ORDER BY id"
  );
  await ok('rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    nextStepIds: [step.id],
    carryToSprint: 'sprint-2',
    projectRoot,
  });
  await ok('rbook_mission_transition', {
    action: 'complete',
    missionId: 'b-m01',
    notes: 'Done.',
    decisions: ['Decided at the completion.'],
    projectRoot,
  });
  // A lease that lapsed: the step is a month old and has survived four closes.
  await recordedSetup(root, 'UPDATE next_steps SET created_at = ? WHERE id = ?', [
    new Date(Date.now() - 30 * DAY).toISOString(),
    lapsing.id,
  ]);
  for (const days of [4, 3, 2, 1]) {
    const sprintId = `closed-${days}`;
    await ok('rbook_sprint', {
      action: 'add',
      sprintId,
      title: sprintId,
      status: 'Planned',
      projectRoot,
    });
    await recordedSetup(
      root,
      "UPDATE sprints SET status = 'Completed', end_date = ? WHERE id = ?",
      [new Date(Date.now() - days * DAY).toISOString(), sprintId]
    );
  }
  // The close drops the lapsed step and, asked to, archives the sprint's records.
  await ok('rbook_sprint', {
    action: 'complete',
    sprintId: 'sprint-1',
    summary: 'Closed.',
    archive: true,
    projectRoot,
  });
  expect(rows(root, 'SELECT status FROM next_steps WHERE id = ?', [lapsing.id])).toEqual([
    { status: 'dropped' },
  ]);
}

describe('the share step', () => {
  it('sets up the log, the guards and the baseline in one transaction, then saves the replay base', async () => {
    const { root, base } = await shared();
    expect(fs.existsSync(base)).toBe(true);
    const changes = rows<{ kind: string; replica_seq: number; value: string }>(
      root,
      'SELECT kind, replica_seq, value FROM record_changes'
    );
    expect(changes.map((change) => [change.kind, change.replica_seq])).toEqual([['baseline', 1]]);
    const [{ value: replicaId }] = rows<{ value: string }>(
      root,
      "SELECT value FROM metadata WHERE key = 'replica_id'"
    );
    expect(JSON.parse(changes[0].value)).toEqual({
      owner: 'Owner',
      authority: replicaId,
      epoch: 1,
    });
    const db = new Database(dbOf(root), { readonly: true });
    try {
      expect(guardProblems(readGuardState((sql) => db.prepare(sql).all() as never))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses a store already shared', async () => {
    const { root } = await shared();
    await expect(shareStore(root)).rejects.toThrow(/already a copy of a shared record/);
  });

  it('refuses a store with no author name to name its owner', async () => {
    const root = project(fixture.tmp, 'nameless');
    await expect(
      withClient(
        root,
        (client) => {
          prepareForSharing(client);
          return shareRecord(client);
        },
        { replicaCheck: false }
      )
    ).rejects.toThrow(/no author name to name its owner: set one with reasonbook config author/);
  });

  it('refuses an identity the app and SQLite would read differently', async () => {
    const root = project(fixture.tmp, 'doubled');
    const db = new Database(dbOf(root));
    try {
      const { content } = db
        .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
        .get() as { content: string };
      db.prepare("UPDATE contexts SET content = ? WHERE id = 'project_identity'").run(
        content.replace(/}\s*$/, ', "project_name": "Doubled"}')
      );
    } finally {
      db.close();
    }
    await expect(shareStore(root)).rejects.toThrow(
      /project identity names a key twice[\s\S]*an identity update through rbook_context rewrites it/
    );
    // An identity update rewrites the doubled row, and the store then shares.
    await ok('rbook_context', {
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'description', value: 'Rewritten once.' }],
      projectRoot: root,
    });
    await expect(shareStore(root)).resolves.toMatch(/replay-bases/);
  });

  it('refuses an identity that is not a plain JSON object, naming a restore', async () => {
    const root = project(fixture.tmp, 'unreadable');
    const db = new Database(dbOf(root));
    try {
      db.prepare("UPDATE contexts SET content = '{name: 1}' WHERE id = 'project_identity'").run();
    } finally {
      db.close();
    }
    await expect(shareStore(root)).rejects.toThrow(
      /project identity is not a plain JSON object, which no tool writes: restore it from a backup/
    );
  });

  it('refuses a column no class names, and a stable id no unique index holds', async () => {
    const root = project(fixture.tmp, 'unknown');
    await withClient(root, (client) => prepareForSharing(client), { replicaCheck: false });
    const db = new Database(dbOf(root));
    try {
      db.exec('ALTER TABLE missions ADD COLUMN priority TEXT');
    } finally {
      db.close();
    }
    await expect(shareStore(root)).rejects.toThrow(/columns no class names: missions\.priority/);
    const db2 = new Database(dbOf(root));
    try {
      db2.exec('ALTER TABLE missions DROP COLUMN priority');
      db2.exec('DROP INDEX idx_learnings_stable_event_id_unique');
    } finally {
      db2.close();
    }
    await expect(
      withClient(root, (client) => shareRecord(client), { replicaCheck: false })
    ).rejects.toThrow(/stable ids are not held unique in learnings/);
  });

  it('a replay base that could not be saved is saved again on its own', async () => {
    const root = project(fixture.tmp, 'retry');
    writeUserAuthor('Owner');
    // A file where the replay-bases folder goes makes the save fail after the share step.
    const folder = path.join(process.env.RBOOK_CONFIG_DIR!, 'replay-bases');
    fs.mkdirSync(path.dirname(folder), { recursive: true });
    fs.writeFileSync(folder, 'in the way');
    await expect(
      withClient(
        root,
        (client) => {
          prepareForSharing(client);
          return shareRecord(client);
        },
        { replicaCheck: false }
      )
    ).rejects.toThrow();
    fs.rmSync(folder);
    const [{ value: replicaId }] = rows<{ value: string }>(
      root,
      "SELECT value FROM metadata WHERE key = 'replica_id'"
    );
    const base = await withClient(root, (client) => saveReplayBase(client, replicaId));
    await record(root, 'A choice after the retry.');
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('keeps the replay base beside an explicit registry, with RBOOK_CONFIG_DIR unset', () => {
    // A child process with a scratch HOME, so a regression cannot write the real config folder.
    const home = path.join(fixture.tmp, 'home');
    const pinned = path.join(fixture.tmp, 'pinned-config');
    fs.mkdirSync(home, { recursive: true });
    const root = project(fixture.tmp, 'pinned');
    const script = String.raw`
      const fs=require('fs'),ts=require('typescript');
      require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
      const [src, root, pinned] = process.argv.slice(1);
      const { ProjectGraphRegistry } = require(src + '/intelligence/project-graph-registry');
      const { RbookDatabaseClient } = require(src + '/tools/rbook/client');
      const { prepareForSharing } = require(src + '/tools/rbook/sharing-preconditions');
      const { shareRecord } = require(src + '/tools/rbook/record-share');
      (async () => {
        const registry = ProjectGraphRegistry.getInstance({ configDir: pinned });
        const opened = await RbookDatabaseClient.create({ dbPath: root + '/rbook/db/rbook.sqlite', replicaCheck: false });
        const client = opened.data;
        prepareForSharing(client);
        // The copy's own name, so no user setting is read from a config folder.
        client.execute("INSERT INTO metadata (key, value) VALUES ('replica_author', 'Owner')");
        const shared = shareRecord(client, registry);
        client.close();
        process.stdout.write(JSON.stringify(shared));
      })().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });`;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.RBOOK_CONFIG_DIR;
    const out = execFileSync(
      process.execPath,
      ['-e', script, path.resolve(__dirname, '..', '..', '..', 'src'), root, pinned],
      { env, encoding: 'utf8' }
    );
    const shared = JSON.parse(out) as { replicaId: string; replayBase: string };
    expect(shared.replayBase).toBe(path.join(pinned, 'replay-bases', `${shared.replicaId}.sqlite`));
    expect(fs.existsSync(shared.replayBase)).toBe(true);
    // Nothing was written under the scratch HOME, where the environment's folder would be.
    expect(fs.readdirSync(home)).toEqual([]);
  }, 60000);
});

describe('every change recorded', () => {
  it('on a fresh store, every converted path records its changes, and the replay reproduces the record', async () => {
    const { root, base } = await shared();
    await workflow(root);
    const kinds = new Set(
      rows<{ entity: string; kind: string }>(root, 'SELECT entity, kind FROM record_changes').map(
        (change) => `${change.entity}:${change.kind}`
      )
    );
    for (const expected of [
      'sprints:create',
      'sprints:set',
      'missions:create',
      'missions:set',
      'missions:append',
      'mission_dependencies:link',
      'mission_dependencies:unlink',
      'strategic_decisions:create',
      'strategic_decisions:set',
      'learnings:create',
      'learnings:set',
      'constraints:create',
      'constraints:set',
      'next_steps:create',
      'next_steps:set',
      'sessions:create',
      'sessions:set',
      'sessions:append',
      'session_missions:link',
      'project:set',
    ])
      expect({ expected, present: kinds.has(expected) }).toEqual({ expected, present: true });
    // The project type is recorded twice over: its metadata key and the identity's tier.
    const fields = rows<{ field: string }>(
      root,
      "SELECT field FROM record_changes WHERE entity = 'project' AND kind = 'set'"
    ).map((change) => change.field);
    expect(fields).toEqual(
      expect.arrayContaining(['metadata.project_type', 'identity.tier', 'identity.description'])
    );
    // The copy's sequence is contiguous: one per change, from the baseline's 1.
    const seqs = rows<{ replica_seq: number }>(
      root,
      'SELECT replica_seq FROM record_changes ORDER BY replica_seq'
    ).map((change) => change.replica_seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const replay = replayCheck(dbOf(root), base);
    expect(replay.mismatches).toEqual([]);
    expect(replay.applied).toBe(seqs.length - 1);
  }, 120000);

  it('every branch the first workflow does not take records its changes too', async () => {
    const { root, base } = await shared();
    await branches(root);
    const seqs = rows<{ replica_seq: number }>(
      root,
      'SELECT replica_seq FROM record_changes ORDER BY replica_seq'
    ).map((change) => change.replica_seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    // One transaction, one clock reading: the sprint demotion and its update share both.
    const clocks = rows<{ txn_id: string; n: number }>(
      root,
      'SELECT txn_id, count(DISTINCT hlc) AS n FROM record_changes GROUP BY txn_id HAVING n > 1'
    );
    expect(clocks).toEqual([]);
    expect(
      rows(
        root,
        "SELECT entity_id FROM record_changes WHERE entity = 'sprints' AND field = 'status' AND value = '\"Planned\"'"
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  }, 180000);

  it('a copy re-identified after its client opened records under its new identity', async () => {
    const { root } = await shared();
    await ok('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-1',
      title: 'One',
      status: 'Planned',
      projectRoot: root,
    });
    const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    const client = opened.data!;
    try {
      const before = readReplicaIdentity(client)!.replicaId;
      const { identity } = await withClient(
        root,
        (other) => reidentifyReplica(other, { block: 1, authorityReceived: null }),
        { replicaCheck: false }
      );
      expect(identity.replicaId).not.toBe(before);
      const done = recordedExecute(
        client,
        "UPDATE sprints SET title = 'Renamed' WHERE id = 'sprint-1'"
      );
      expect(done.error).toBeUndefined();
    } finally {
      client.close();
    }
    const [last] = rows<{ replica_id: string }>(
      root,
      'SELECT replica_id FROM record_changes ORDER BY rowid DESC LIMIT 1'
    );
    const [{ value: now }] = rows<{ value: string }>(
      root,
      "SELECT value FROM metadata WHERE key = 'replica_id'"
    );
    expect(last.replica_id).toBe(now);
  });

  it('on a solo store, recordedChange runs the write as before: no transaction, and a throw propagates', async () => {
    const root = project(fixture.tmp, 'solo');
    expect(
      await withClient(root, (client) => recordedChange(client, () => client.inTransaction))
    ).toMatchObject({ success: true, data: false });
    await expect(
      withClient(root, (client) =>
        recordedChange(client, () => {
          throw new Error('thrown as before');
        })
      )
    ).rejects.toThrow('thrown as before');
  });

  it('a set-based write records one change per row', async () => {
    const { root } = await shared();
    for (const content of ['First step.', 'Second step.', 'Third step.'])
      await ok('rbook_session', {
        action: 'capture',
        category: 'next-step',
        content,
        projectRoot: root,
      });
    await ok('rbook_session', { action: 'complete', summary: 'Closed.', projectRoot: root });
    await ok('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-9',
      title: 'Nine',
      status: 'Planned',
      projectRoot: root,
    });
    await ok('rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      carryToSprint: 'sprint-9',
      projectRoot: root,
    });
    const carried = rows<{ txn_id: string; entity_id: string }>(
      root,
      "SELECT txn_id, entity_id FROM record_changes WHERE entity = 'next_steps' AND field = 'status'"
    );
    expect(carried).toHaveLength(3);
    expect(new Set(carried.map((change) => change.entity_id)).size).toBe(3);
    expect(new Set(carried.map((change) => change.txn_id)).size).toBe(1);
  });

  it('captures and notes are appends', async () => {
    const { root } = await shared();
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'a-m01',
      name: 'Noted',
      projectRoot: root,
    });
    await ok('rbook_mission_transition', {
      action: 'start',
      missionId: 'a-m01',
      notes: 'Begun.',
      projectRoot: root,
    });
    await ok('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'A note for the session.',
      projectRoot: root,
    });
    const appends = rows<{ entity: string; field: string; value: string }>(
      root,
      "SELECT entity, field, value FROM record_changes WHERE kind = 'append'"
    );
    expect(appends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'missions', field: 'notes' }),
        expect.objectContaining({ entity: 'sessions', field: 'captures' }),
      ])
    );
    const note = appends.find((change) => change.field === 'notes');
    expect(JSON.parse(note!.value)).toContain('[Started] Begun.');
  });
});

describe('seeded faults fail the replay check', () => {
  it('a write made after the replay base while holding the token, but not recorded', async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    const db = new Database(dbOf(root));
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO record_write_token (txn_id) VALUES ('fault')").run();
        db.prepare("UPDATE strategic_decisions SET status = 'archived'").run();
        db.prepare('DELETE FROM record_staged').run();
        db.prepare('DELETE FROM record_write_token').run();
      }).immediate();
    } finally {
      db.close();
    }
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([
      expect.stringMatching(/^strategic_decisions .* status: the store holds "archived"/),
    ]);
  });

  it('a wrongly recorded set-based write', async () => {
    const { root, base } = await shared();
    for (const content of ['First step.', 'Second step.'])
      await ok('rbook_session', {
        action: 'capture',
        category: 'next-step',
        content,
        projectRoot: root,
      });
    await ok('rbook_session', { action: 'complete', summary: 'Closed.', projectRoot: root });
    await ok('rbook_context', { action: 'next_steps', nextStepAction: 'carry', projectRoot: root });
    // The recorder kept one change for the two rows it carried.
    const db = new Database(dbOf(root));
    try {
      db.prepare(
        "DELETE FROM record_changes WHERE change_id = (SELECT change_id FROM record_changes WHERE entity = 'next_steps' AND field = 'status' ORDER BY replica_seq DESC LIMIT 1)"
      ).run();
    } finally {
      db.close();
    }
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([
      expect.stringMatching(
        /^next_steps .* status: the store holds "carried", the replay "pending"/
      ),
    ]);
  });
});

describe('the replay is exact', () => {
  it('a logged text equal to the stored one only as JSON is a mismatch', async () => {
    const { root, base } = await shared();
    await record(root, '1.0');
    const db = new Database(dbOf(root));
    try {
      db.prepare(
        "UPDATE record_changes SET value = json_set(value, '$.decision_text', '1') WHERE kind = 'create' AND entity = 'strategic_decisions'"
      ).run();
    } finally {
      db.close();
    }
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([
      expect.stringMatching(/decision_text: the store holds "1\.0", the replay "1"/),
    ]);
  });

  it('a reference logged unresolved while its row exists is a mismatch, not a throw', async () => {
    const { root, base } = await shared();
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'r-m01',
      name: 'Named',
      projectRoot: root,
    });
    await ok('rbook_decisions', {
      action: 'record',
      content: 'A choice for a mission.',
      missionId: 'r-m01',
      projectRoot: root,
    });
    const db = new Database(dbOf(root));
    try {
      db.prepare(
        `UPDATE record_changes SET value = json_set(value, '$.mission_id', json('{"unresolved":"r-m01"}')) WHERE kind = 'create' AND entity = 'strategic_decisions'`
      ).run();
    } finally {
      db.close();
    }
    // The change that could not be applied is reported, and so is the row it left unmade.
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([
      expect.stringMatching(
        /strategic_decisions\.mission_id is logged unresolved, but names a row/
      ),
      expect.stringMatching(
        /^strategic_decisions \S+: in the store, not reproduced by the replay$/
      ),
    ]);
  });

  it('a reference to no row is logged unresolved, as the row holds it', async () => {
    // A store without the learnings foreign keys lets a learning name a mission not yet made.
    const root = project(fixture.tmp, 'loose');
    const db = new Database(dbOf(root));
    try {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'learnings'").get() as {
          sql: string;
        }
      ).sql;
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'learnings'").run(
        sql.replace(
          /,\s*FOREIGN KEY \(\w+\) REFERENCES \w+\(\w+\)(?: ON DELETE (?:SET NULL|CASCADE))?/g,
          ''
        )
      );
      db.pragma('writable_schema = OFF');
    } finally {
      db.close();
    }
    const base = await shareStore(root);
    await ok('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'Names a mission made later.',
      missionId: 'later-m01',
      projectRoot: root,
    });
    const [create] = rows<{ value: string }>(
      root,
      "SELECT value FROM record_changes WHERE kind = 'create' AND entity = 'learnings'"
    );
    expect(JSON.parse(create.value).mission_id).toEqual({ unresolved: 'later-m01' });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'later-m01',
      name: 'Later',
      projectRoot: root,
    });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });
});

describe('automatic maintenance on a shared record', () => {
  it("a mission complete leaves the identity's recorded keys to the authority", async () => {
    const { root, base } = await shared();
    const status = (): unknown =>
      JSON.parse(
        rows<{ content: string }>(
          root,
          "SELECT content FROM contexts WHERE id = 'project_identity'"
        )[0].content
      ).status;
    const before = status();
    await recordedSetup(
      root,
      "INSERT INTO metadata (key, value) VALUES ('project_status', 'paused') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'c-m01',
      name: 'Converge',
      projectRoot: root,
    });
    await ok('rbook_mission_transition', {
      action: 'start',
      missionId: 'c-m01',
      projectRoot: root,
    });
    await ok('rbook_mission_transition', {
      action: 'complete',
      missionId: 'c-m01',
      notes: 'Done.',
      projectRoot: root,
    });
    expect(status()).toBe(before);
    expect(rows(root, "SELECT 1 FROM record_changes WHERE field = 'identity.status'")).toEqual([]);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    // A solo store converges as it always did.
    // A solo store on another machine, so its registration does not meet the shared copy's.
    useMachine(fixture.tmp, 'studio');
    const solo = project(fixture.tmp, 'solo');
    await recordedSetup(
      solo,
      "INSERT INTO metadata (key, value) VALUES ('project_status', 'paused') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'c-m01',
      name: 'Converge',
      projectRoot: solo,
    });
    await ok('rbook_mission_transition', {
      action: 'start',
      missionId: 'c-m01',
      projectRoot: solo,
    });
    await ok('rbook_mission_transition', {
      action: 'complete',
      missionId: 'c-m01',
      notes: 'Done.',
      projectRoot: solo,
    });
    expect(
      JSON.parse(
        rows<{ content: string }>(
          solo,
          "SELECT content FROM contexts WHERE id = 'project_identity'"
        )[0].content
      ).status
    ).toBe('paused');
  });

  it('the staleness repair leaves a shared record alone, and still restores a solo store', async () => {
    const stale = async (root: string): Promise<number> => {
      for (const sprintId of ['sprint-1', 'sprint-11'])
        await ok('rbook_sprint', {
          action: 'add',
          sprintId,
          title: sprintId,
          status: 'Planned',
          projectRoot: root,
        });
      const made = await ok('rbook_decisions', {
        action: 'record',
        content: 'Marked stale by an old flagger.',
        sprintId: 'sprint-1',
        projectRoot: root,
      });
      const id = made.data!.decisionId!;
      // As an old flagger left it: stale, and unreviewed where the store has a review column.
      const reviewed = rows<{ name: string }>(
        root,
        "SELECT name FROM pragma_table_info('strategic_decisions') WHERE name = 'last_reviewed_at'"
      ).length;
      await recordedSetup(
        root,
        `UPDATE strategic_decisions SET status = 'stale'${reviewed ? ', last_reviewed_at = NULL' : ''} WHERE id = ?`,
        [id]
      );
      return id;
    };
    const { root } = await shared();
    const id = await stale(root);
    resetFirstWriteMaintenance();
    expect(await runFirstWriteMaintenance(root)).toEqual([]);
    expect(rows(root, 'SELECT status FROM strategic_decisions WHERE id = ?', [id])).toEqual([
      { status: 'stale' },
    ]);
    // A solo store on another machine, so its registration does not meet the shared copy's.
    useMachine(fixture.tmp, 'studio');
    const solo = project(fixture.tmp, 'solo');
    const soloId = await stale(solo);
    resetFirstWriteMaintenance();
    expect((await runFirstWriteMaintenance(solo)).join(' ')).toMatch(/Restored 1 decision/);
    expect(rows(solo, 'SELECT status FROM strategic_decisions WHERE id = ?', [soloId])).toEqual([
      { status: 'active' },
    ]);
  });

  it("a sprint close leaves a shared record's end dates alone, and still repairs a solo store", async () => {
    const planned = new Date(Date.now() + 10 * DAY).toISOString();
    const setUp = async (root: string): Promise<void> => {
      for (const sprintId of ['kept-date', 'closing'])
        await ok('rbook_sprint', {
          action: 'add',
          sprintId,
          title: sprintId,
          status: 'Planned',
          projectRoot: root,
        });
      await recordedSetup(
        root,
        "UPDATE sprints SET status = 'Completed', end_date = ? WHERE id = 'kept-date'",
        [planned]
      );
      const db = new Database(dbOf(root));
      try {
        db.prepare(
          "INSERT INTO session_events (ts, mission, action, raw_event) VALUES (?, 'kept-date', 'sprint_complete', '{}')"
        ).run(new Date(Date.now() - DAY).toISOString());
      } finally {
        db.close();
      }
    };
    const endDate = (root: string): unknown =>
      rows<{ end_date: string }>(root, "SELECT end_date FROM sprints WHERE id = 'kept-date'")[0]
        .end_date;
    const { root, base } = await shared();
    await setUp(root);
    const closed = await ok('rbook_sprint', {
      action: 'complete',
      sprintId: 'closing',
      summary: 'Closed.',
      projectRoot: root,
    });
    expect(JSON.stringify(closed)).not.toMatch(/end_date repair|RECORD_WRITE_UNRECORDED/);
    expect(endDate(root)).toBe(planned);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    // A solo store on another machine, so its registration does not meet the shared copy's.
    useMachine(fixture.tmp, 'studio');
    const solo = project(fixture.tmp, 'solo');
    await setUp(solo);
    await ok('rbook_sprint', {
      action: 'complete',
      sprintId: 'closing',
      summary: 'Closed.',
      projectRoot: solo,
    });
    expect(endDate(solo)).not.toBe(planned);
  });
});

PRIVATE.describe("this repository's own store", () => {
  it('shares a copy of it, records a working session on it, and replays the log exactly', async () => {
    const root = path.join(fixture.tmp, 'real');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '..', '..', '..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root);
    const base = await shareStore(root);
    await ok('rbook_mission', {
      action: 'add',
      missionId: 'real-m01',
      name: 'On the real store',
      projectRoot: root,
    });
    await ok('rbook_mission_transition', {
      action: 'start',
      missionId: 'real-m01',
      notes: 'Begun.',
      projectRoot: root,
    });
    await record(root, 'A choice on a copy of the real store.');
    await ok('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'A lesson on the real store.',
      projectRoot: root,
    });
    await ok('rbook_mission_transition', {
      action: 'complete',
      missionId: 'real-m01',
      notes: 'Done.',
      projectRoot: root,
    });
    const replay = replayCheck(dbOf(root), base);
    expect(replay.mismatches).toEqual([]);
    expect(replay.applied).toBeGreaterThan(5);
  }, 240000);
});

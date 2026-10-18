// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12's property (ADR s96 §5, §7): one log, delivered to a copy in any order, ends in one state. Copies of
// ABOUTME: three writers and an outsider make the log; observers take it in random chunks, gaps and orders.
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { admitMember, applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { RECORD_COLUMNS, type SharedTable } from '../../../src/tools/rbook/record-columns';
import type { OpenConflict } from '../../../src/tools/rbook/record-settle';
import type { LoggedChange } from '../../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { memberCopy, onCopy, ownerCopy, read, sync, type Copy } from '../../helpers/shared-copies';

/** How many orders to try; the build note records a run of 1,000 (RBOOK_INTERLEAVINGS=1000). */
const INTERLEAVINGS = Number(process.env.RBOOK_INTERLEAVINGS ?? 100);
// A count that is not a whole number above zero would run no order and pass (the solo critic).
if (!Number.isInteger(INTERLEAVINGS) || INTERLEAVINGS < 1)
  throw new Error(
    `RBOOK_INTERLEAVINGS must be a whole number above zero, not ${process.env.RBOOK_INTERLEAVINGS}`
  );

let fixture: ReplicaFixture;
let owner: Copy;
let members: Copy[];
let observer: Copy;
let clashOnY: Array<{ id: string; name: string }>;
let observerBytes: Buffer;
/** Y's copy holding its own writes, which the owner refused, before any verdict on them reached it. */
let yBytes: Buffer;
let log: LoggedChange[];

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const notes = (copy: Copy, id: string): string =>
  read<{ notes: string | null }>(copy, 'SELECT notes FROM missions WHERE id = ?', [id])[0]?.notes ??
  '';
const appendNote = async (copy: Copy, id: string, note: string) =>
  ok(copy, 'rbook_mission', {
    action: 'update',
    missionId: id,
    fields: { notes: `${notes(copy, id)}${note}` },
  });

/** Everything a copy's state is compared by: heads, candidates, standings and recorded columns. */
function stateOf(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all();
    const state: Record<string, unknown> = {
      heads: all(
        'SELECT entity, entity_id, field, change_id FROM record_heads ORDER BY 1, 2, 3, 4'
      ),
      conflicts: all('SELECT entity, entity_id, field FROM record_conflicts ORDER BY 1, 2, 3'),
      standings: all('SELECT txn_id, replica_id, state, cause FROM record_txn_state ORDER BY 1'),
      aliases: all(
        'SELECT entity, renamed_id, plain_id, stable_event_id FROM record_aliases ORDER BY 1, 2'
      ),
    };
    for (const table of Object.keys(RECORD_COLUMNS) as SharedTable[]) {
      const present = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      );
      const recorded = RECORD_COLUMNS[table].recorded.filter((column) => present.has(column));
      const key = RECORD_COLUMNS[table].link ? recorded : ['stable_event_id', ...recorded];
      state[table] = all(
        `SELECT ${[...new Set(key)].map((c) => `"${c}"`).join(', ')} FROM ${table} ORDER BY ${[...new Set(key)].map((c) => `"${c}"`).join(', ')}`
      );
    }
    return state;
  } finally {
    db.close();
  }
}

/** A small seeded generator, so a failing order can be run again by its number. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each replica's stream cut into random chunks, then all chunks in a random order: gaps included. */
function deliveries(changes: readonly LoggedChange[], next: () => number): LoggedChange[][] {
  const streams = new Map<string, LoggedChange[]>();
  for (const change of changes)
    streams.set(change.replica_id, [...(streams.get(change.replica_id) ?? []), change]);
  const chunks: LoggedChange[][] = [];
  for (const stream of streams.values()) {
    stream.sort((a, b) => a.replica_seq - b.replica_seq);
    for (let at = 0; at < stream.length; ) {
      const size = 1 + Math.floor(next() * Math.min(12, stream.length - at));
      chunks.push(stream.slice(at, at + size));
      at += size;
    }
  }
  for (let i = chunks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
  }
  return chunks;
}

/**
 * Deliver the whole log to a copy in the order this seed draws. The copy is put back to the bytes it
 * was saved with each time, in place, so it stays the copy its machine bound.
 */
async function observe(copy: Copy, bytes: Buffer, seed: number): Promise<Record<string, unknown>> {
  const dbPath = dbOf(copy.root);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.writeFileSync(dbPath, bytes);
  await onCopy(fixture.tmp, copy, (client) => {
    for (const chunk of deliveries(log, random(seed))) {
      const applied = applyRemote(client, chunk);
      if (process.env.RBOOK_INTERLEAVINGS_DEBUG)
        process.stderr.write(
          `PROBE ${seed} ${applied.success ? 'ok' : 'FAIL'} ${chunk.map((c) => `${c.replica_id.slice(-4)}#${c.replica_seq}:${c.kind}:${c.entity}:${c.field ?? ''}:${(c.value ?? '').slice(0, 60)}`).join(' | ')}\n`
        );
      if (!applied.success) throw new Error(`order ${seed}: ${applied.error?.message}`);
    }
  });
  return stateOf(dbPath);
}

beforeAll(async () => {
  fixture = replicaFixture('rbook-interleavings-');
  owner = await ownerCopy(fixture.tmp);
  const decision = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Contested.' }))
    .data!.decisionId!;
  await ok(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'i-m01',
    name: 'Shared',
    notes: '',
  });
  const a = await memberCopy(fixture.tmp, owner, 'a', 1);
  const b = await memberCopy(fixture.tmp, owner, 'b', 2);
  // Y is admitted only after its first writes reach the owner; X never is.
  const y = await memberCopy(fixture.tmp, owner, 'y', 3, { admit: false });
  const x = await memberCopy(fixture.tmp, owner, 'x', 7, { admit: false });
  members = [a, b, y];
  // A copy that only receives: every order of arrival is tried on it.
  observer = await memberCopy(fixture.tmp, owner, 'observer', 9, { admit: false });
  await onCopy(fixture.tmp, observer, (client) =>
    client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  );
  observerBytes = fs.readFileSync(dbOf(observer.root));
  // C joins after the observer was copied, so its admission reaches the observer in the owner's
  // stream; a verdict on C's create counts only once that admission has (the engine critic, round 2).
  const c = await memberCopy(fixture.tmp, owner, 'c', 4);
  members.push(c);
  for (const member of [a, b, c, y, x]) await sync(fixture.tmp, owner, member);

  // Concurrent writes: none of these copies has seen another's.
  await ok(owner, 'rbook_decisions', {
    action: 'update',
    decisionId: decision,
    status: 'archived',
  });
  await ok(a, 'rbook_decisions', { action: 'update', decisionId: decision, status: 'stale' });
  for (const [copy, said] of [
    [a, 'A says.'],
    [b, 'B says.'],
  ] as const)
    await ok(copy, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { objective: said },
    });
  for (const copy of [owner, a, b]) await appendNote(copy, 'i-m01', `[${copy.name}] `);
  // The same mission id on two copies: one keeps it, the other is renamed.
  for (const copy of [a, b])
    await ok(copy, 'rbook_mission', { action: 'add', missionId: 'i-m02', name: copy.name });
  // A third claimant of i-m02, from the copy that joined last: renamed with its own block.
  await ok(c, 'rbook_mission', { action: 'add', missionId: 'i-m02', name: 'c' });
  // A child in a later transaction than its parent.
  await ok(a, 'rbook_mission', { action: 'add', missionId: 'i-a01', name: 'Parent on A' });
  await ok(a, 'rbook_decisions', {
    action: 'record',
    content: 'A child of the parent on A.',
    missionId: 'i-a01',
  });
  // A link from A's new mission, which can arrive before the mission it names (the engine critic).
  await ok(a, 'rbook_mission', { action: 'depends', fromId: 'i-a01', toId: 'i-m01' });
  await ok(owner, 'rbook_mission', {
    action: 'update',
    missionId: 'i-m01',
    fields: { name: 'Named by the owner' },
  });
  await ok(x, 'rbook_mission', { action: 'add', missionId: 'i-x01', name: 'Outsider' });
  // An outsider's link to its own refused create, which the owner refuses without failing.
  await ok(x, 'rbook_mission', { action: 'depends', fromId: 'i-x01', toId: 'i-m01' });
  await ok(y, 'rbook_mission', {
    action: 'update',
    missionId: 'i-m01',
    fields: { name: 'Named by Y' },
  });
  await ok(y, 'rbook_mission', { action: 'add', missionId: 'i-y01', name: 'Made before Y joined' });
  // One id made first on Y, then by the owner: Y keeps it until the owner refuses Y's create, then
  // gives it back (the engine critic).
  await ok(y, 'rbook_mission', { action: 'add', missionId: 'i-c01', name: 'Made on Y first' });
  await ok(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'i-c01',
    name: 'The owner made it',
  });
  // And one made first by the owner, then on Y: Y renames its own until the owner refuses it, and the
  // row goes with its alias.
  await ok(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'i-d01',
    name: 'The owner made it first',
  });
  await ok(y, 'rbook_mission', { action: 'add', missionId: 'i-d01', name: 'Made on Y later' });

  // Y sees the owner's name beside its own and settles it; then the owner refuses Y's first writes.
  await sync(fixture.tmp, owner, y);
  // Before the refusal, Y keeps the plain id and names the owner's mission by its alias.
  clashOnY = read<{ id: string; name: string }>(
    y,
    "SELECT id, name FROM missions WHERE id LIKE 'i-c01%' OR id LIKE 'i-d01%' ORDER BY id"
  );
  await ok(y, 'rbook_db', {
    action: 'settle',
    table: 'missions',
    recordId: 'i-m01',
    field: 'name',
    value: 'Named by the owner',
  });
  await appendNote(y, 'i-y01', 'A dependent of a create the owner refuses.');
  const yChanges = await onCopy(fixture.tmp, y, (client) => changesSince(client, {}));
  const yOwn = yChanges.filter((change) => change.replica_id === y.replicaId);
  const settleTxn = yOwn.find((change) => change.kind === 'settle')!.txn_id;
  const firstSettle = yOwn.findIndex((change) => change.txn_id === settleTxn);
  await onCopy(fixture.tmp, owner, (client) => {
    const early = applyRemote(client, yOwn.slice(0, firstSettle));
    if (!early.success) throw new Error(early.error?.message);
    const admitted = admitMember(client, { replicaId: y.replicaId, block: 3, role: 'editor' });
    if (!admitted.success) throw new Error(admitted.error?.message);
  });
  for (const copy of [a, b, y, x]) await sync(fixture.tmp, copy, owner);
  // Y now holds its own writes as live, and the owner has refused some: no verdict on them has reached
  // Y yet, so the orders below can put one past a gap in the owner's stream (the engine critic, round 3).
  await onCopy(fixture.tmp, y, (client) => client.execute('PRAGMA wal_checkpoint(TRUNCATE)'));
  yBytes = fs.readFileSync(dbOf(y.root));
  // A child on B of A's row, which reaches B only through the owner.
  await sync(fixture.tmp, owner, b);
  await appendNote(b, 'i-a01', '[b] ');
  for (let round = 0; round < 2; round += 1)
    for (const copy of members) {
      await sync(fixture.tmp, copy, owner);
      await sync(fixture.tmp, owner, copy);
    }
  log = await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}));
}, 300000);

afterAll(() => fixture.restore());

describe('one log, any order of arrival', () => {
  it('the workload holds each case the property is about', () => {
    const state = stateOf(dbOf(owner.root));
    expect(state.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'strategic_decisions', field: 'status' }),
      ])
    );
    expect(state.aliases).toEqual([
      expect.objectContaining({ plain_id: 'i-m02', renamed_id: 'i-m02~2' }),
      expect.objectContaining({ plain_id: 'i-m02', renamed_id: 'i-m02~4' }),
    ]);
    const standings = state.standings as Array<{
      replica_id: string;
      state: string;
      cause: string;
    }>;
    const y = members[2];
    // Y's writes before it joined are refused, and the note on its refused create with them.
    expect(
      standings.filter((row) => row.replica_id === y.replicaId).map((row) => row.state)
    ).toEqual(expect.arrayContaining(['refused']));
    expect(standings.some((row) => /depends on .*refused/.test(row.cause))).toBe(true);
    // The outsider's data stays with the owner; members hold only its verdict.
    expect(log.some((change) => change.replica_id === 'x')).toBe(false);
    expect(read(owner, "SELECT name FROM missions WHERE id = 'i-m01'")).toEqual([
      { name: 'Named by the owner' },
    ]);
    // A's link reached every copy; the outsider's, refused with its create, reached none.
    expect(
      read(
        owner,
        "SELECT from_id, to_id FROM mission_dependencies WHERE to_id = 'i-m01' ORDER BY from_id"
      )
    ).toEqual([{ from_id: 'i-a01', to_id: 'i-m01' }]);
    // Y named the owner's mission by an alias while its own create stood, and gave the id back.
    expect(clashOnY).toEqual([
      { id: 'i-c01', name: 'Made on Y first' },
      { id: 'i-c01~0', name: 'The owner made it' },
      { id: 'i-d01', name: 'The owner made it first' },
      { id: 'i-d01~3', name: 'Made on Y later' },
    ]);
    for (const copy of [owner, ...members])
      expect({
        copy: copy.name,
        rows: read(
          copy,
          "SELECT id, name FROM missions WHERE id LIKE 'i-c01%' OR id LIKE 'i-d01%' ORDER BY id"
        ),
        aliases: read(
          copy,
          "SELECT renamed_id FROM record_aliases WHERE plain_id IN ('i-c01', 'i-d01')"
        ),
      }).toEqual({
        copy: copy.name,
        rows: [
          { id: 'i-c01', name: 'The owner made it' },
          { id: 'i-d01', name: 'The owner made it first' },
        ],
        aliases: [],
      });
  });

  it('every copy holds the same heads, candidates, standings and columns after full delivery', () => {
    const reference = stateOf(dbOf(owner.root));
    for (const member of members)
      expect({ copy: member.name, ...stateOf(dbOf(member.root)) }).toEqual({
        copy: member.name,
        ...reference,
      });
  });

  it(`${INTERLEAVINGS} random orders of arrival at a fresh copy each end in the owner's state`, async () => {
    const reference = stateOf(dbOf(owner.root));
    for (let seed = 1; seed <= INTERLEAVINGS; seed += 1) {
      const state = await observe(observer, observerBytes, seed);
      if (JSON.stringify(state) !== JSON.stringify(reference))
        expect({ seed, ...state }).toEqual({ seed, ...reference });
    }
  }, 1800000);

  it(`${INTERLEAVINGS} random orders of arrival at a copy holding its own refused writes each end in the owner's state`, async () => {
    const reference = stateOf(dbOf(owner.root));
    for (let seed = 1; seed <= INTERLEAVINGS; seed += 1) {
      const state = await observe(members[2], yBytes, seed);
      if (JSON.stringify(state) !== JSON.stringify(reference))
        expect({ seed, ...state }).toEqual({ seed, ...reference });
    }
  }, 1800000);

  it('two processes applying halves of one order to a copy at once end in the same state', async () => {
    const reference = stateOf(dbOf(owner.root));
    const dbPath = dbOf(observer.root);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    fs.writeFileSync(dbPath, observerBytes);
    useMachine(fixture.tmp, observer.machine);
    const chunks = deliveries(log, random(7));
    const halves = [chunks.filter((_, i) => i % 2 === 0), chunks.filter((_, i) => i % 2 === 1)];
    const modules = [
      path.resolve('src/tools/rbook/client.ts'),
      path.resolve('src/tools/rbook/record-apply.ts'),
    ];
    const source = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);const {RbookDatabaseClient}=require(process.argv[1]);const {applyRemote}=require(process.argv[2]);const chunks=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));process.stdout.write('ready\n');process.stdin.once('data',async()=>{const opened=await RbookDatabaseClient.create({dbPath:process.argv[3]});if(!opened.success){process.stdout.write(JSON.stringify([opened.error])+'\n');process.exit(1);}const out=[];for(const chunk of chunks){const r=applyRemote(opened.data,chunk);out.push(r.success?null:r.error);}opened.data.close();process.stdout.write(JSON.stringify(out)+'\n');process.exit(0);});`;
    const children = halves.map((half, n) => {
      const file = path.join(fixture.tmp, `half-${n}.json`);
      fs.writeFileSync(file, JSON.stringify(half));
      const child = spawn(process.execPath, ['-e', source, ...modules, dbPath, file], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '';
      let error = '';
      child.stderr.on('data', (chunk) => (error += String(chunk)));
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('ready\n')) resolve();
        });
        child.once('close', (code) => reject(new Error(`exited ${code} before ready: ${error}`)));
      });
      const done = new Promise<string>((resolve) => child.once('close', () => resolve(output)));
      return { child, ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    children.forEach((c) => c.child.stdin.end('go'));
    const failures = (await Promise.all(children.map((c) => c.done))).flatMap((out) =>
      (JSON.parse(out.trim().split('\n').slice(-1)[0]) as unknown[]).filter(Boolean)
    );
    expect(failures).toEqual([]);
    expect(stateOf(dbPath)).toEqual(reference);
  }, 300000);

  it('once every conflict is settled, every copy holds the same recorded columns and no conflict', async () => {
    const listed = await ok(owner, 'rbook_db', { action: 'conflicts' });
    const open = (listed.data as { conflicts: OpenConflict[] }).conflicts;
    expect(open.length).toBeGreaterThanOrEqual(2);
    for (const conflict of open)
      await ok(owner, 'rbook_db', {
        action: 'settle',
        table: conflict.table,
        recordId: conflict.recordId,
        field: conflict.field,
        value: conflict.candidates[0].value,
      });
    for (const member of members) await sync(fixture.tmp, owner, member);
    const reference = stateOf(dbOf(owner.root));
    expect(reference.conflicts).toEqual([]);
    for (const member of members)
      expect({ copy: member.name, ...stateOf(dbOf(member.root)) }).toEqual({
        copy: member.name,
        ...reference,
      });
  }, 120000);
});

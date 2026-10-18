// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Copies of one shared record on separate machines for the merge tests (s96-m12): the owner's copy shares,
// ABOUTME: a member is a consistent copy with its own identity in its own block, and a sync applies what each lacks.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import {
  admitMember,
  applyRemote,
  changesSince,
  replicaMarks,
  type ApplyReport,
} from '../../src/tools/rbook/record-apply';
import {
  clientPeer,
  exchange as exchangeCopies,
  type Peer,
} from '../../src/tools/rbook/record-exchange';
import { answerJoin, applyJoin, requestJoin } from '../../src/tools/rbook/record-join';
import { inviteMember } from '../../src/tools/rbook/record-membership';
import { shareRecord } from '../../src/tools/rbook/record-share';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../src/tools/rbook/record-columns';
import {
  establishReplica,
  forgetReplicaIdentity,
  readReplicaIdentity,
} from '../../src/tools/rbook/replica-identity';
import { prepareForSharing } from '../../src/tools/rbook/sharing-preconditions';
import { dbOf, project, useMachine } from './replica-fixture';

export interface Copy {
  readonly name: string;
  readonly root: string;
  readonly machine: string;
  readonly replicaId: string;
  readonly block: number;
}

/** Open a copy's store on its own machine, run `use`, and close it. */
export async function onCopy<T>(
  tmp: string,
  copy: Pick<Copy, 'root' | 'machine'>,
  use: (client: RbookDatabaseClient) => T,
  options: { replicaCheck?: boolean } = {}
): Promise<Awaited<T>> {
  useMachine(tmp, copy.machine);
  const opened = await RbookDatabaseClient.create({ dbPath: dbOf(copy.root), ...options });
  if (!opened.success || !opened.data) throw new Error(opened.error?.message ?? 'no client');
  try {
    return await use(opened.data);
  } finally {
    opened.data.close();
  }
}

/** The owner's copy: a seeded project made ready and shared on its own machine. */
export async function ownerCopy(tmp: string, name = 'owner', author = 'Owner'): Promise<Copy> {
  return shareExisting(tmp, project(tmp, name), name, author);
}

/** s96-m14: share a store already written to, on its own machine, as the share step does. */
export async function shareExisting(
  tmp: string,
  root: string,
  name = 'owner',
  author = 'Owner'
): Promise<Copy> {
  const machine = `machine-${name}`;
  useMachine(tmp, machine);
  writeUserAuthor(author);
  const replicaId = await onCopy(
    tmp,
    { root, machine },
    (client) => {
      const readiness = prepareForSharing(client);
      if (!readiness.ready) throw new Error(readiness.problems.join(' '));
      return shareRecord(client).replicaId;
    },
    { replicaCheck: false }
  );
  return { name, root, machine, replicaId, block: 0 };
}

/**
 * A member's copy: a consistent copy of the owner's store on another machine, given its own identity
 * in `block`, and admitted by the owner unless `admit` is false (s96-m13's join does this for real).
 */
export async function memberCopy(
  tmp: string,
  owner: Copy,
  name: string,
  block: number,
  options: { admit?: boolean; author?: string } = {}
): Promise<Copy> {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(owner.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const machine = `machine-${name}`;
  useMachine(tmp, machine);
  writeUserAuthor(options.author ?? name);
  const replicaId = await onCopy(
    tmp,
    { root, machine },
    (client) => {
      forgetReplicaIdentity(client);
      return establishReplica(client, { block }).replicaId;
    },
    { replicaCheck: false }
  );
  const member = { name, root, machine, replicaId, block };
  if (options.admit !== false)
    await onCopy(tmp, owner, (client) => {
      const admitted = admitMember(client, { replicaId, block, role: 'editor' });
      if (!admitted.success) throw new Error(admitted.error?.message);
    });
  return member;
}

/** Apply to `to` what `from` holds past `to`'s marks; the star means one side is the owner's copy. */
export async function sync(tmp: string, from: Copy, to: Copy): Promise<ApplyReport> {
  const marks = await onCopy(tmp, to, (client) => replicaMarks(client));
  const changes = await onCopy(tmp, from, (client) => changesSince(client, marks));
  return onCopy(tmp, to, (client) => {
    const applied = applyRemote(client, changes);
    if (!applied.success) throw new Error(`${to.name}: ${applied.error?.message}`);
    return applied.data!;
  });
}

/** A member and the owner exchange both ways, the member's changes first. */
export async function exchange(tmp: string, owner: Copy, member: Copy): Promise<void> {
  await sync(tmp, member, owner);
  await sync(tmp, owner, member);
}

/** Read rows from a copy's file directly. */
export function read<T>(copy: Pick<Copy, 'root'>, sql: string, params: unknown[] = []): T[] {
  const db = new Database(dbOf(copy.root), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** This copy's replica id, read back from its store. */
export async function replicaOf(tmp: string, copy: Copy): Promise<string> {
  return onCopy(tmp, copy, (client) => readReplicaIdentity(client, { fresh: true })!.replicaId);
}

/**
 * s96-m13: a member's copy joined as the join does: the owner invites `author`, a consistent copy of
 * the owner's store on its own machine asks, the owner answers, and the copy applies the answer.
 */
export async function joinedCopy(
  tmp: string,
  owner: Copy,
  name: string,
  author = name
): Promise<Copy> {
  await onCopy(tmp, owner, (client) => {
    const invited = inviteMember(client, { name: author });
    if (!invited.success) throw new Error(invited.error?.message);
  });
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(owner.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const copy = { root, machine: `machine-${name}` };
  useMachine(tmp, copy.machine);
  writeUserAuthor(author);
  const request = await onCopy(tmp, copy, (client) => requestJoin(client), { replicaCheck: false });
  if (!request.success) throw new Error(request.error?.message);
  const answer = await onCopy(tmp, owner, (client) => answerJoin(client, request.data!, author));
  if (!answer.success) throw new Error(answer.error?.message);
  const applied = await onCopy(tmp, copy, (client) => applyJoin(client, answer.data!), {
    replicaCheck: false,
  });
  if (!applied.success) throw new Error(applied.error?.message);
  return { name, ...copy, replicaId: applied.data!.replicaId, block: applied.data!.block };
}

/** A copy as an exchange's peer, opened on its own machine; the steps that repair it skip its check. */
export function copyPeer(tmp: string, copy: Pick<Copy, 'name' | 'root' | 'machine'>): Peer {
  return clientPeer(
    copy.name,
    (step) => onCopy(tmp, copy, step),
    (step) => onCopy(tmp, copy, step, { replicaCheck: false })
  );
}

/** One exchange between two copies, which must succeed. */
export async function syncCopies(
  tmp: string,
  one: Pick<Copy, 'name' | 'root' | 'machine'>,
  other: Pick<Copy, 'name' | 'root' | 'machine'>
) {
  const result = await exchangeCopies(copyPeer(tmp, one), copyPeer(tmp, other));
  if (!result.success) throw new Error(`${one.name}: ${JSON.stringify(result.error)}`);
  return result.data!;
}

/**
 * Keep a copy's store, and with `machine` its machine's registry too, as a backup holds them; the
 * returned restore writes them back into the same files, so the store keeps its inode, as a restore
 * from a backup does.
 */
export async function backUp(
  tmp: string,
  copy: Pick<Copy, 'root' | 'machine'>,
  options: { machine?: boolean } = {}
): Promise<() => void> {
  await onCopy(tmp, copy, (client) => client.execute('PRAGMA wal_checkpoint(TRUNCATE)'), {
    replicaCheck: false,
  });
  const store = fs.readFileSync(dbOf(copy.root));
  const config = path.join(tmp, `config-${copy.machine}`);
  const saved = path.join(tmp, `backup-${copy.machine}-${Date.now()}`);
  if (options.machine) fs.cpSync(config, saved, { recursive: true });
  return () => {
    for (const suffix of ['-wal', '-shm'])
      fs.rmSync(`${dbOf(copy.root)}${suffix}`, { force: true });
    fs.writeFileSync(dbOf(copy.root), store);
    if (options.machine) {
      fs.rmSync(config, { recursive: true, force: true });
      fs.cpSync(saved, config, { recursive: true });
    }
    useMachine(tmp, copy.machine);
  };
}

/** Every recorded column of every shared table, and the open conflicts: what copies must agree on. */
export function recordedState(copy: Pick<Copy, 'root'>): Record<string, unknown> {
  const state: Record<string, unknown> = {
    conflicts: read(copy, 'SELECT entity, entity_id, field FROM record_conflicts ORDER BY 1, 2, 3'),
  };
  for (const table of RECORDED_TABLES) {
    const columns = RECORD_COLUMNS[table].recorded.map((column) => `"${column}"`).join(', ');
    state[table] = read(copy, `SELECT ${columns} FROM ${table} ORDER BY ${columns}`);
  }
  return state;
}

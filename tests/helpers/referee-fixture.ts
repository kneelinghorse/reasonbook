// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A project hosted by the referee library, in this process (s97-m09): the owner's copy hands over to a referee
// ABOUTME: store, members join through it, and a peer over the library lets the engine's own exchange run against it.
import * as fs from 'fs';
import * as path from 'path';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import {
  applyJoinAnswer,
  createReferee,
  invite,
  makeFirstCopy,
  peer,
  type Caller,
  type RefereeLocation,
  type RefereeOutcome,
  type StreamHead,
} from '../../src/referee';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { currentWriteProtocol } from '../../src/tools/rbook/record-protocol-state';
import { exchange, type ExchangeReport, type Peer } from '../../src/tools/rbook/record-exchange';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import {
  answerJoin,
  applyJoin,
  requestJoin,
  type JoinAnswer,
} from '../../src/tools/rbook/record-join';
import { handOver } from '../../src/tools/rbook/record-moves';
import { readReplicaIdentity, ReplicaRefusal } from '../../src/tools/rbook/replica-identity';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import { dbOf, useMachine } from './replica-fixture';
import { seedRbookDb } from './seedRbookDb';
import { copyPeer, onCopy, ownerCopy, shareExisting, type Copy } from './shared-copies';

/** A referee store's location, whose head follows every call made through `ask`. */
export interface Referee {
  readonly storePath: string;
  readonly configDir: string;
  expectedHead: StreamHead | null;
}

export interface Hosted {
  readonly referee: Referee;
  readonly owner: Copy;
  readonly ownerAccount: string;
  /** The referee's own replica, once it joined. */
  readonly refereeReplica: string;
}

/** Set while a library call runs, so a test can tell the library's own side effects from a copy's. */
export const inside = { referee: false };

export function refereeAt(tmp: string, name = 'project'): Referee {
  return {
    storePath: path.join(tmp, 'volume', 'referee', name, 'rbook.sqlite'),
    configDir: path.join(tmp, 'volume', 'referee-config'),
    expectedHead: null,
  };
}

/** One library call: the head it returns is recorded, as the dashboard records it after every call. */
export async function ask<T>(
  referee: Referee,
  call: (location: RefereeLocation) => Promise<RefereeOutcome<T>>
): Promise<RbookToolResult<T>> {
  inside.referee = true;
  try {
    const outcome = await call({ ...referee });
    if (outcome.head) referee.expectedHead = outcome.head;
    return outcome.result;
  } finally {
    inside.referee = false;
  }
}

/** The account a copy calls as, and the replica it is now, read from its own store. */
export async function callerOf(tmp: string, copy: Copy, accountId: string): Promise<Caller> {
  const replicaId = await onCopy(
    tmp,
    copy,
    (client) => readReplicaIdentity(client, { fresh: true })!.replicaId,
    { replicaCheck: false }
  );
  return { accountId, replicaId };
}

const value = <T>(answer: RbookToolResult<T>): T => {
  if (!answer.success) throw new ReplicaRefusal(answer.error!);
  return answer.data as T;
};

/** The referee as an exchange's peer, through the library: what the dashboard's routes carry. */
export function refereePeer(tmp: string, referee: Referee, copy: Copy, accountId: string): Peer {
  // The caller is read from the copy before the call: the copy's own reads are not the library's.
  const run = async (method: string, params?: unknown) => {
    const caller = await callerOf(tmp, copy, accountId);
    return ask(referee, (location) => peer(location, method, params, caller));
  };
  return {
    name: 'the referee',
    hello: async () =>
      value(
        await run('hello', {
          ...localCopyReport(),
          recordProtocol: await onCopy(tmp, copy, currentWriteProtocol, { replicaCheck: false }),
        })
      ) as never,
    chains: async (at) => value(await run('chains', at)) as never,
    changesSince: async (marks) => value(await run('changesSince', marks)) as never,
    apply: (changes, options = {}) => run('apply', { changes, ...options }) as never,
    admitSuccessor: (input) => run('admitSuccessor', input) as never,
    reblockSelf: () => run('reblockSelf') as never,
    takeSuccessor: (input) => run('takeSuccessor', input) as never,
    failed: async (input) => {
      await run('failed', input);
    },
  };
}

/** One exchange between a copy and the referee, which must succeed. */
export async function syncWithReferee(
  tmp: string,
  hosted: Pick<Hosted, 'referee'>,
  copy: Copy,
  accountId: string
): Promise<ExchangeReport> {
  const result = await exchange(
    copyPeer(tmp, copy),
    refereePeer(tmp, hosted.referee, copy, accountId)
  );
  if (!result.success) throw new Error(`${copy.name}: ${JSON.stringify(result.error)}`);
  return result.data!;
}

/** The handover in, up to the referee's join: the upload made, the referee created and joined. */
export interface HostOptions {
  readonly ownerAccount?: string;
  /** The referee store's folder name; a named project gets its own owner copy too. */
  readonly name?: string;
  /** The project id the owner's store is made with; the fixture's shared one by default. */
  readonly projectId?: string;
  /** A store already written, such as a real one, to share as the owner's instead of a seeded one. */
  readonly realStore?: string;
}

/** The owner's shared copy for a hosted project, on its own machine. */
async function ownerFor(tmp: string, options: HostOptions): Promise<Copy> {
  const name = options.name ? `owner-${options.name}` : 'owner';
  if (options.realStore) return shareExisting(tmp, options.realStore, name, 'Owner');
  if (!options.projectId) return ownerCopy(tmp, name);
  const root = path.join(tmp, name);
  seedRbookDb(root, { projectId: options.projectId, projectName: options.projectId });
  return shareExisting(tmp, root, name, 'Owner');
}

export async function joinedReferee(
  tmp: string,
  options: HostOptions = {}
): Promise<{ referee: Referee; owner: Copy; ownerAccount: string; refereeReplica: string }> {
  const ownerAccount = options.ownerAccount ?? 'acct-owner';
  const owner = await ownerFor(tmp, options);
  const referee = refereeAt(tmp, options.name);
  const upload = path.join(tmp, `upload-${options.name ?? 'project'}.sqlite`);
  await buildFreshCopy(dbOf(owner.root), upload);
  const created = await ask(referee, (location) =>
    createReferee(location, { copyFile: upload, ownerAccountId: ownerAccount })
  );
  const request = value(created).joinRequest;
  const answer = await onCopy(tmp, owner, (client) => answerJoin(client, request, 'Owner'));
  value(await ask(referee, (location) => applyJoinAnswer(location, value(answer) as JoinAnswer)));
  return { referee, owner, ownerAccount, refereeReplica: referee.expectedHead!.replicaId };
}

/**
 * The whole handover in (design §The client design, "Share through the dashboard"): the owner's copy
 * relays its stream to the joined referee, hands over to it, and the referee confirms the move itself
 * at the catch-up; one more exchange then runs at the new epoch.
 */
export async function hostProject(tmp: string, options: HostOptions = {}): Promise<Hosted> {
  const joined = await joinedReferee(tmp, options);
  const { owner, ownerAccount, referee } = joined;
  await syncWithReferee(tmp, joined, owner, ownerAccount);
  const moved = await onCopy(tmp, owner, (client) =>
    handOver(client, { to: joined.refereeReplica })
  );
  value(moved);
  await syncWithReferee(tmp, joined, owner, ownerAccount);
  await syncWithReferee(tmp, joined, owner, ownerAccount);
  return { referee, owner, ownerAccount, refereeReplica: joined.refereeReplica };
}

/** A member joined through the referee: invited by account, its first copy downloaded, its join answered. */
export async function joinThroughReferee(
  tmp: string,
  hosted: Pick<Hosted, 'referee'>,
  name: string,
  accountId: string
): Promise<Copy> {
  value(
    await ask(hosted.referee, (location) => invite(location, { accountId, name, role: 'editor' }))
  );
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  value(await ask(hosted.referee, (location) => makeFirstCopy(location, dbOf(root))));
  const place = { name, root, machine: `machine-${name}`, replicaId: '', block: -1 };
  useMachine(tmp, place.machine);
  writeUserAuthor(name);
  const request = value(
    await onCopy(tmp, place, (client) => requestJoin(client), { replicaCheck: false })
  );
  const answer = value(
    await ask(hosted.referee, (location) =>
      peer(location, 'answerJoin', request, { accountId, replicaId: request.replicaId })
    )
  ) as JoinAnswer;
  const applied = value(
    await onCopy(tmp, place, (client) => applyJoin(client, answer), { replicaCheck: false })
  );
  return { ...place, replicaId: applied.replicaId, block: applied.block };
}

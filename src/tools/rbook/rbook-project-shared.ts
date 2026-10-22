// SPDX-License-Identifier: Apache-2.0
// ABOUTME: rbook_project's shared-record actions (design §s96-m13): share, invite, join over SSH, members, remove and sync,
// ABOUTME: each on the project's own store, with their parameters, published schema and how each answer reads.

import { existsSync } from 'fs';
import { z } from 'zod';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';
import {
  INVITE_ROLES,
  inviteMember,
  listMembers,
  removeMember,
  type MemberView,
} from './record-membership';
import { confirmOwner, type Confirmed } from './record-moves';
import { isRecordedStore } from './record-recording';
import { shareProject, type ShareResult } from './record-share-action';
import { removalNote, type ExchangeReport } from './record-exchange';
import { answered, joinRoute, storeOpener, syncPeers, type PeerOutcome } from './record-sync';
import { observeSharedSync } from './record-sync-scheduler';
import { withSyncLock } from './record-sync-trigger';
import type { JoinApplied } from './record-join';
import { joinThroughDashboard, type DashboardJoined } from './record-dashboard-join';
import { moveBackFromDashboard, type MovedBack } from './record-dashboard-move';
import {
  shareThroughDashboard,
  type DashboardShared,
  type DashboardSharePlan,
} from './record-dashboard-share';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';

export const SHARED_PROJECT_ACTIONS = [
  'share',
  'invite',
  'join',
  'members',
  'remove',
  'sync',
  'move',
] as const;
export type SharedProjectAction = (typeof SHARED_PROJECT_ACTIONS)[number];

/** Which published parameter each action takes (s86-m04's action-params contract). */
export const SHARED_PROJECT_ACTION_PARAMS = {
  share: ['action', 'projectRoot', 'authorName', 'via', 'confirm'],
  invite: ['action', 'projectRoot', 'name', 'role'],
  join: [
    'action',
    'projectRoot',
    'member',
    'host',
    'remoteRoot',
    'remoteNode',
    'remoteBin',
    'remoteConfigDir',
    'via',
    'project',
  ],
  members: ['action', 'projectRoot'],
  remove: ['action', 'projectRoot', 'name'],
  sync: ['action', 'projectRoot', 'confirmOwner'],
  move: ['action', 'projectRoot', 'to'],
} as const;

const DESCRIPTIONS = {
  authorName: 'share: the author name the owner goes by, set here when this machine has none',
  role: 'invite: editor (the default), or owner for another copy of your own',
  member: 'join: the invited member the joining copy is for',
  host: 'join: the SSH host the joining copy is on',
  remoteRoot: 'join: the project folder on that host',
  remoteNode: "join: the node binary on that host, when a non-login SSH command's PATH lacks it",
  remoteBin: 'join: the Reasonbook entry on that host, when its PATH lacks reasonbook',
  remoteConfigDir: "join: the Reasonbook config folder on that host, when it is not the user's",
  confirmOwner: "sync: confirm the move of the owner's copy this copy holds, as your word",
  via: 'share, join: dashboard, to share or join through the dashboard, which referees the project; leave it out for SSH and bundles',
  confirm:
    'share via the dashboard: true sends the project after the dry run; without it, only the dry run',
  project:
    "join via the dashboard: the project's rbook:// address, which its owner shared with you",
  to: "move: owner, to move a project shared through the dashboard back to the owner's copy, run on that copy",
} as const;

export const sharedProjectZodFields = {
  authorName: z.string().optional().describe(DESCRIPTIONS.authorName),
  role: z.enum(INVITE_ROLES).optional().describe(DESCRIPTIONS.role),
  member: z.string().optional().describe(DESCRIPTIONS.member),
  host: z.string().optional().describe(DESCRIPTIONS.host),
  remoteRoot: z.string().optional().describe(DESCRIPTIONS.remoteRoot),
  remoteNode: z.string().optional().describe(DESCRIPTIONS.remoteNode),
  remoteBin: z.string().optional().describe(DESCRIPTIONS.remoteBin),
  remoteConfigDir: z.string().optional().describe(DESCRIPTIONS.remoteConfigDir),
  confirmOwner: z.boolean().optional().describe(DESCRIPTIONS.confirmOwner),
  via: z.enum(['dashboard']).optional().describe(DESCRIPTIONS.via),
  confirm: z.boolean().optional().describe(DESCRIPTIONS.confirm),
  project: z.string().optional().describe(DESCRIPTIONS.project),
  to: z.enum(['owner']).optional().describe(DESCRIPTIONS.to),
};

export const sharedProjectProperties = {
  authorName: { type: 'string', description: DESCRIPTIONS.authorName },
  role: { type: 'string', enum: [...INVITE_ROLES], description: DESCRIPTIONS.role },
  member: { type: 'string', description: DESCRIPTIONS.member },
  host: { type: 'string', description: DESCRIPTIONS.host },
  remoteRoot: { type: 'string', description: DESCRIPTIONS.remoteRoot },
  remoteNode: { type: 'string', description: DESCRIPTIONS.remoteNode },
  remoteBin: { type: 'string', description: DESCRIPTIONS.remoteBin },
  remoteConfigDir: { type: 'string', description: DESCRIPTIONS.remoteConfigDir },
  confirmOwner: { type: 'boolean', description: DESCRIPTIONS.confirmOwner },
  via: { type: 'string', enum: ['dashboard'], description: DESCRIPTIONS.via },
  confirm: { type: 'boolean', description: DESCRIPTIONS.confirm },
  project: { type: 'string', description: DESCRIPTIONS.project },
  to: { type: 'string', enum: ['owner'], description: DESCRIPTIONS.to },
} as const;

export type SharedProjectResult =
  | ShareResult
  | (MemberView & { readonly invited: boolean; readonly accepted?: number })
  | { readonly joined: JoinApplied; readonly sync: ExchangeReport }
  | { readonly members: readonly MemberView[]; readonly shared: boolean }
  | (MemberView & { readonly cuts: Readonly<Record<string, number>> })
  | { readonly peers: readonly PeerOutcome[] }
  | Confirmed
  | { readonly busy: true }
  | { readonly plan: DashboardSharePlan }
  | DashboardShared
  | DashboardJoined
  | MovedBack;

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

const unshared = <T>(): RbookToolResult<T> =>
  refuse<T>({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: 'This project is not shared, so it has no members and nothing to sync.',
    suggestion: 'Share it first: rbook_project(action="share").',
  });

/** Run `step` against the shared store, or say the project is not shared. */
function sharedOnly<T>(
  step: (client: RbookDatabaseClient) => RbookToolResult<T>
): (client: RbookDatabaseClient) => RbookToolResult<T> {
  return (client) => (isRecordedStore(client) ? step(client) : unshared<T>());
}

interface SharedStore {
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly open: ReturnType<typeof storeOpener>;
  readonly unchecked: ReturnType<typeof storeOpener>;
}

/** The project's store, opened with and without its copy check, or why there is none. */
function sharedStore(
  action: SharedProjectAction,
  projectRoot: string | undefined
): SharedStore | RbookToolResult<never> {
  const root = projectRoot ?? '';
  const dbPath = resolveRecordPaths(root).dbPath;
  if (!root || !existsSync(dbPath))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `No Reasonbook store at ${root || 'this folder'}, so there is no record to ${action}.`,
      suggestion:
        'Pass projectRoot as the project folder, or start a record there with rbook_project(action="init").',
    });
  return {
    projectRoot: root,
    dbPath,
    open: storeOpener(dbPath),
    unchecked: storeOpener(dbPath, { replicaCheck: false }),
  };
}

const missing = (store: SharedStore | RbookToolResult<never>): store is RbookToolResult<never> =>
  'success' in store;

/** share: this copy becomes the owner's of a record others join. */
export async function rbookProjectShare(params: {
  readonly projectRoot?: string;
  readonly authorName?: string;
  readonly via?: 'dashboard';
  readonly confirm?: boolean;
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('share', params.projectRoot);
  if (missing(store)) return store;
  // s97-m11: through the dashboard, the dry run first; the project goes up only with confirm.
  if (params.via === 'dashboard') {
    const shared = await answered(
      shareThroughDashboard(store.open, store.unchecked, store.dbPath, {
        confirm: params.confirm === true,
        authorName: params.authorName,
      })
    );
    if (shared.success && params.confirm) observeSharedSync(store.projectRoot, { recheck: true });
    return shared;
  }
  return store.unchecked((client) =>
    shareProject(client, store.projectRoot, { authorName: params.authorName })
  );
}

/** invite: a member, by the name their records will carry. */
export async function rbookProjectInvite(params: {
  readonly projectRoot?: string;
  readonly name?: string;
  readonly role?: (typeof INVITE_ROLES)[number];
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('invite', params.projectRoot);
  if (missing(store)) return store;
  return answered(
    store.open(
      sharedOnly((client) => inviteMember(client, { name: params.name ?? '', role: params.role }))
    )
  );
}

/** members: a read that answers on any store; an unshared one has no members, and says so. */
export async function rbookProjectMembers(params: {
  readonly projectRoot?: string;
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('members', params.projectRoot);
  if (missing(store)) return store;
  return answered(
    store.open((client) =>
      createSuccess(
        isRecordedStore(client)
          ? { members: listMembers(client), shared: true }
          : { members: [], shared: false }
      )
    )
  );
}

/** remove: a member, whose changes past the cut are quarantined. */
export async function rbookProjectRemove(params: {
  readonly projectRoot?: string;
  readonly name?: string;
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('remove', params.projectRoot);
  if (missing(store)) return store;
  return answered(store.open(sharedOnly((client) => removeMember(client, params.name ?? ''))));
}

/** join: admit a member's copy over SSH from the owner's copy, then sync with it. */
export async function rbookProjectJoin(params: {
  readonly projectRoot?: string;
  readonly member?: string;
  readonly host?: string;
  readonly remoteRoot?: string;
  readonly remoteNode?: string;
  readonly remoteBin?: string;
  readonly remoteConfigDir?: string;
  readonly via?: 'dashboard';
  readonly project?: string;
}): Promise<RbookToolResult<SharedProjectResult>> {
  // s97-m11: through the dashboard, on the joining machine, into a folder that holds no store yet.
  if (params.via === 'dashboard') {
    if (!params.projectRoot || !params.project)
      return createError({
        code: 'INVALID_PARAMETER',
        message:
          "A join through the dashboard names the folder to join into and the project's address.",
        suggestion: 'Pass projectRoot (an empty folder) and project (its rbook:// address).',
      });
    const joined = await answered(
      joinThroughDashboard({ folder: params.projectRoot, address: params.project })
    );
    if (joined.success) observeSharedSync(params.projectRoot, { recheck: true });
    return joined;
  }
  const store = sharedStore('join', params.projectRoot);
  if (missing(store)) return store;
  if (!params.host || !params.remoteRoot || !params.member)
    return createError({
      code: 'INVALID_PARAMETER',
      message: 'A join over SSH names the host, its project folder and the invited member.',
      suggestion:
        'Pass host, remoteRoot and member, with remoteNode and remoteBin when the host does not put node and reasonbook on a non-login PATH; a join by bundle is reasonbook join --request-out on the joining copy.',
    });
  const joined = await joinRoute(
    store.open,
    {
      host: params.host,
      root: params.remoteRoot,
      ...(params.remoteNode ? { node: params.remoteNode } : {}),
      ...(params.remoteBin ? { bin: params.remoteBin } : {}),
      ...(params.remoteConfigDir ? { configDir: params.remoteConfigDir } : {}),
    },
    params.member,
    { unchecked: store.unchecked }
  );
  // The project now has a route, so the server's own timer syncs it.
  if (joined.success) observeSharedSync(store.projectRoot, { recheck: true });
  return joined;
}

/** move: a project shared through the dashboard, back to the owner's copy this runs on (s97-m11). */
export async function rbookProjectMove(params: {
  readonly projectRoot?: string;
  readonly to?: 'owner';
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('move', params.projectRoot);
  if (missing(store)) return store;
  if (params.to !== 'owner')
    return createError({
      code: 'INVALID_PARAMETER',
      message: "A move names where the project goes: to the owner's copy, the one it runs on.",
      suggestion: 'Pass to="owner" on the owner\'s copy.',
    });
  if (!(await store.unchecked((client) => isRecordedStore(client)))) return unshared();
  return answered(moveBackFromDashboard(store.open, store.unchecked, store.dbPath));
}

/** sync: exchange with every copy this one has a route to, or confirm a move of the owner's copy. */
export async function rbookProjectSync(params: {
  readonly projectRoot?: string;
  readonly confirmOwner?: boolean;
}): Promise<RbookToolResult<SharedProjectResult>> {
  const store = sharedStore('sync', params.projectRoot);
  if (missing(store)) return store;
  if (params.confirmOwner) return store.unchecked(sharedOnly((client) => confirmOwner(client)));
  if (!(await store.unchecked((client) => isRecordedStore(client)))) return unshared();
  const synced = await withSyncLock(store.dbPath, () =>
    syncPeers(store.open, { unchecked: store.unchecked, projectRoot: store.projectRoot })
  );
  return synced ?? createSuccess({ busy: true as const });
}

const exchangeLine = (report: ExchangeReport): string =>
  [
    report.caughtUp
      ? report.caughtUp.confirmed
        ? `took in a move of the owner's copy to ${report.caughtUp.authority}, which the copy behind confirmed itself`
        : `took in a move of the owner's copy to ${report.caughtUp.authority}, to confirm with rbook_project(action="sync", confirmOwner=true) on the copy behind`
      : '',
    report.reidentified
      ? `took a new identity: ${report.reidentified.summary.replace(/\.$/, '')}`
      : '',
    ...(report.reblocked ?? []).map((moved) => `${moved.replicaId} moved to block ${moved.block}`),
    report.caughtUp
      ? `the copy behind took in ${report.received}`
      : (removalNote(report) ??
        `the owner's copy took in ${report.sent}, and the member's took in ${report.received}`),
    report.conflicts ? `${report.conflicts} field(s) in conflict` : '',
  ]
    .filter(Boolean)
    .join('; ');

const memberLine = (member: MemberView): string =>
  `  - ${member.name} (${member.role}): ${member.replicas.length ? member.replicas.map((replica) => `block ${replica.block}`).join(', ') : 'no copy joined yet'}`;

/** How each shared-record action's answer reads. */
export function formatSharedProjectForLLM(
  action: SharedProjectAction,
  result: RbookToolResult<SharedProjectResult>
): string {
  if (!result.success || !result.data) {
    const lines = [`❌ rbook_project(action="${action}") failed`, '', result.error?.message ?? ''];
    if (result.error?.suggestion) lines.push('', `Suggestion: ${result.error.suggestion}`);
    return lines.join('\n');
  }
  const data = result.data as unknown as Record<string, unknown>;
  const lines: string[] = [];
  switch (action) {
    case 'share': {
      const rows = (counts: Readonly<Record<string, number>>) =>
        Object.entries(counts)
          .map(([table, n]) => `${table} ${n}`)
          .join(', ') || 'nothing';
      if ('refereeReplica' in data) {
        const shared = data as unknown as DashboardShared;
        lines.push(
          `✓ Shared through ${shared.dashboard}: its copy holds the record from move ${shared.handover.epoch}, and this copy is the owner's member copy, syncing through it. Share it with people on the dashboard.`,
          `It sent the shared record: ${rows(shared.plan.up)}.`
        );
        break;
      }
      if ('plan' in data) {
        const { plan } = data as unknown as { plan: DashboardSharePlan };
        const omittedRows = rows(plan.stays);
        const omitted = `${omittedRows === 'nothing' ? '' : `${omittedRows}, `}the search index and the other context documents`;
        lines.push(
          `Dry run: sharing through ${plan.dashboard} sends the shared record: ${rows(plan.up)}${'record_changes' in plan.up ? '' : ', with the change log sharing starts for it'}.`,
          `The shared record leaves out ${omitted}. Until the handover, this copy's uploads to ${plan.dashboard} send its whole store, those included, as its registration there did; after it, they stop.`,
          'Nothing was sent. Show this to the person; send it with rbook_project(action="share", via="dashboard", confirm=true) only on their word.'
        );
        break;
      }
      const shared = data as unknown as ShareResult;
      lines.push(
        `✓ Shared: ${shared.owner} owns the record, in block ${shared.block}. Invite a member with rbook_project(action="invite", name=...).`
      );
      break;
    }
    case 'move': {
      const moved = data as unknown as MovedBack;
      lines.push(
        `✓ Moved back from ${moved.dashboard}: this copy holds the record again (move ${moved.epoch}), and the dashboard archived its copy. Catch each member's copy up from this copy over SSH or bundles; its operator then confirms the move with reasonbook sync --confirm-owner. After confirmation it syncs directly with this copy.`
      );
      break;
    }
    case 'invite':
    case 'remove': {
      const member = data as unknown as MemberView & {
        invited?: boolean;
        accepted?: number;
        refused?: number;
      };
      lines.push(
        action === 'remove'
          ? `✓ Removed ${member.name}: their changes past the cut are quarantined, and their copy receives nothing new.`
          : member.invited && member.accepted !== undefined
            ? `✓ Re-added ${member.name} as ${member.role}; ${member.accepted} quarantined change(s) of theirs are accepted from now${member.refused ? `, and ${member.refused} refused, as an ${member.role}'s would be` : ''}. A removal drops the route to their copy: set it again with reasonbook sync --ssh <host> --remote-root <folder>, or carry a bundle (reasonbook sync --bundle-out <file>).`
            : member.invited
              ? `✓ Invited ${member.name} as ${member.role}. Join their copy with rbook_project(action="join", member="${member.name}", host=..., remoteRoot=...).`
              : `✓ ${member.name} is a member already, as ${member.role}.`
      );
      break;
    }
    case 'join': {
      if ('dashboard' in data) {
        const joined = data as unknown as DashboardJoined;
        lines.push(
          `✓ Joined through ${joined.dashboard} as ${joined.joined.member}, in block ${joined.joined.block}${joined.sync ? `, and synced: ${exchangeLine(joined.sync)}` : '; sync once more to finish'}.`
        );
        break;
      }
      const joined = data as unknown as { joined: JoinApplied; sync: ExchangeReport };
      lines.push(
        `✓ Joined ${joined.joined.member}'s copy in block ${joined.joined.block}, and synced: ${exchangeLine(joined.sync)}.`
      );
      break;
    }
    case 'members': {
      const { members, shared } = data as unknown as { members: MemberView[]; shared: boolean };
      lines.push(
        ...(shared
          ? ['Members:', ...members.map(memberLine)]
          : [
              'This project is not shared, so it has no members. Share it with rbook_project(action="share").',
            ])
      );
      break;
    }
    case 'sync': {
      if ('busy' in data)
        lines.push('A sync of this copy is already running, so this one did nothing.');
      else if ('isAuthority' in data) {
        const confirmed = data as unknown as Confirmed;
        lines.push(
          confirmed.isAuthority
            ? `✓ Confirmed: this copy is the owner's copy now (move ${confirmed.epoch}).`
            : `✓ Confirmed: the owner's copy is ${confirmed.authority} from move ${confirmed.epoch}.`
        );
      } else
        for (const peer of (data as unknown as { peers: PeerOutcome[] }).peers)
          lines.push(
            `${peer.name ?? peer.replicaId}: ${peer.report ? exchangeLine(peer.report) : peer.error}`
          );
      break;
    }
  }
  appendWarnings(lines, result);
  return lines.join('\n');
}

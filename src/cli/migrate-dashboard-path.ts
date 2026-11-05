// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m02 — migrate's dashboard path step: the record found through /api/projects/mine, repointed only from
// ABOUTME: a file it already names, and each reason it cannot be given its own outcome and remedy.

import type { DashboardClient, OwnedProject } from '../tools/rbook/dashboard-client';
import type { RbookToolError } from '../tools/rbook/types';
import {
  recordNamesStoreFolder,
  SEPARATORS,
  STORE_TAILS,
  storeTailOf,
} from '../tools/rbook/dashboard-path-tie';
import fs from 'fs';
import path from 'path';

/**
 * What the step did. `done`: repointed, or nothing to do. `ended`: there is no record to repoint, so
 * the step is over, with a `left` line saying why. `pending`: a later retry can finish it; `left`
 * names the reason and its remedy. `notes` are lines for `left` that change nothing (a listed slug).
 */
export type PathStep =
  | { readonly status: 'done'; readonly notes: readonly string[] }
  | {
      readonly status: 'ended' | 'pending';
      readonly left: string;
      readonly notes: readonly string[];
    };

export interface PathStepInput {
  readonly root: string;
  /** The store's file after the move, the path the record is repointed to. */
  readonly dbPath: string;
  readonly projectId: string | null;
  readonly registered: boolean;
  readonly slug: string | null;
  /** resolveLocalOwner's rule: metadata.owner, else dashboard_username. */
  readonly owner: string | null;
  readonly retry: string;
}

type Resolve = (projectRoot: string | undefined) => Promise<{
  readonly success: boolean;
  readonly data?: { readonly client: DashboardClient; readonly keySource: string };
  readonly error?: RbookToolError;
}>;

/** A /mine answer that did not list the id, with whether this folder's project key read it. */
interface ReadList {
  readonly client: DashboardClient;
  readonly folderKey: boolean;
}

/** The signed-in account's /mine, when reading it failed without a refusal. */
interface Unread {
  readonly client: DashboardClient;
  readonly error: RbookToolError | undefined;
}

const pending = (left: string, notes: string[] = []): PathStep => ({
  status: 'pending',
  left,
  notes,
});

/** The account a client's key belongs to, by /me, or undefined when /me cannot say. */
async function usernameOf(client: DashboardClient): Promise<string | undefined> {
  const me = await client.getMyProjects();
  return (me.success ? me.data?.user?.username : undefined) ?? undefined;
}

/** A refusal of the credential itself: a 401, or the redirect to `/` an owner-only POST answers. */
function refusedCredential(error: RbookToolError | undefined): boolean {
  if (!error) return false;
  const state = error.currentState;
  const status =
    state && typeof state === 'object' ? (state as { httpStatus?: unknown }).httpStatus : undefined;
  return (
    error.code === 'DASHBOARD_AUTH_FAILED' ||
    error.code === 'DASHBOARD_FORBIDDEN' ||
    (typeof status === 'number' && status >= 300 && status < 400)
  );
}

/**
 * Settled item 9 (s110 design): the record's dashboard path is repointed only when the record already
 * names this store's file, by folder identity: an absolute path ending in either fixed store tail,
 * since the record names the pre-move file, whose folder is this store's root by isSameFolder. The
 * marker's free-form folder is never used to build a path. Sprint 112's user-key heal trusts the path
 * this writes, so migrate must not be a way to point a record at another store.
 */
export async function finishDashboardPath(
  input: PathStepInput,
  resolve: Resolve
): Promise<PathStep> {
  const { root, dbPath, projectId, retry } = input;
  if (!projectId)
    return input.registered
      ? {
          status: 'ended',
          left: `The dashboard path update ended: this store was registered with reasonbook.ai but holds no dashboard project id, so migrate cannot tell which record to repoint. If reasonbook.ai holds one for this store, save ${dbPath} under Local Database Path on that project's sharing page.`,
          notes: [],
        }
      : { status: 'done', notes: [] };

  const first = await resolve(root);
  if (!first.success || !first.data)
    return pending(
      `Dashboard path update pending: no dashboard credential answers for this folder (${first.error?.message ?? 'none'}). Sign in with rbook_auth, then ${retry}.`
    );
  let client = first.data.client;
  let owned = await client.listOwnedProjects();
  // Which credential answers (critic B3, B1): a deleted project's key gets a 401 and a key outside
  // its scope the redirect, so after either on the folder's own key the user-key chain answers.
  if (
    !owned.success &&
    refusedCredential(owned.error) &&
    first.data.keySource === 'project-scoped'
  ) {
    const user = await resolve(undefined);
    if (!user.success || !user.data || user.data.keySource === 'project-scoped')
      return pending(
        `Dashboard path update pending: reasonbook.ai refused this folder's project key (${owned.error?.message}), as it does both a deleted project's key and a revoked one. Sign in with rbook_auth, so the next retry can tell them apart, then ${retry}.`
      );
    client = user.data.client;
    owned = await client.listOwnedProjects();
  }
  if (!owned.success || !owned.data)
    return refusedCredential(owned.error)
      ? pending(
          `Dashboard path update pending: reasonbook.ai refused the signed-in account (${owned.error?.message}). Sign in as the account that owns this project's record${input.owner ? `, ${input.owner}` : ''}, then ${retry}.`
        )
      : pending(
          `Dashboard path update pending: reasonbook.ai's list of this account's projects could not be read (${owned.error?.message ?? 'unknown error'}). Retry later: ${retry}.`
        );

  let record = owned.data.projects.find((project) => project.id === projectId);
  const lists: ReadList[] = [];
  let unread: Unread | undefined;
  if (!record) {
    const folderKey = client === first.data.client && first.data.keySource === 'project-scoped';
    lists.push({ client, folderKey });
    // Critic round 1, F2 (decision #1864): a folder key belonging to another account lists only that
    // account's projects, so the signed-in account's list is read too before any verdict. A record it
    // holds is repointed through it. A failure that is no refusal leaves the verdict to a retry, unless
    // that list is the owner's own, which the folder key read in full (rounds 2 and 3, R2-4 and R3-1);
    // a refused key adds nothing.
    if (folderKey) {
      const user = await resolve(undefined);
      if (user.success && user.data && user.data.keySource !== 'project-scoped') {
        const again = await user.data.client.listOwnedProjects();
        if (again.success && again.data) {
          record = again.data.projects.find((project) => project.id === projectId);
          if (record) client = user.data.client;
          else lists.push({ client: user.data.client, folderKey: false });
        } else if (!refusedCredential(again.error))
          unread = { client: user.data.client, error: again.error };
      }
    }
  }
  if (!record) return unlisted(input, lists, unread);

  const notes =
    record.slug && input.slug && record.slug !== input.slug
      ? [
          `reasonbook.ai lists this project's record under the slug '${record.slug}', while this store holds '${input.slug}'.`,
        ]
      : [];
  if (!recordNamesStoreFolder(record.localDbPath, root, [STORE_TAILS.current, STORE_TAILS.legacy]))
    return pending(otherPath(record, input, client.dashboardOrigin), notes);

  let posted = await client.updateLocalProjectPath(record.id, dbPath);
  if (!posted.success && refusedCredential(posted.error) && client === first.data.client) {
    const user = await resolve(undefined);
    if (user.success && user.data && user.data.keySource !== 'project-scoped')
      posted = await user.data.client.updateLocalProjectPath(record.id, dbPath);
  }
  if (posted.success) return { status: 'done', notes };
  if (!refusedCredential(posted.error))
    return pending(
      `Dashboard path update pending: reasonbook.ai did not take the path update for its record ${record.id} (${posted.error?.message ?? 'unknown error'}). Retry later: ${retry}.`,
      notes
    );
  // Critic rounds 3 and 4, W2: /mine lists only an account's own projects, so the account whose list
  // held the record owns it, whoever owns this store. /me names it; when it cannot, no one is named.
  const holder = await usernameOf(client);
  return pending(
    `Dashboard path update pending: reasonbook.ai refused the path update for its record ${record.id} (${posted.error?.message}). Sign in as the account that owns it${holder ? `, ${holder}` : ''}, then ${retry}.`,
    notes
  );
}

/**
 * The id is in none of the lists read, and /mine lists only an account's own projects. Whether that
 * means no record or another account's needs the account each list belongs to and this store's owner:
 * when either list is the owner's own, there is no record to repoint (critic round 2, R2-1).
 */
async function unlisted(
  input: PathStepInput,
  lists: readonly ReadList[],
  unread: Unread | undefined
): Promise<PathStep> {
  const { projectId, owner, retry } = input;
  const whose = (list: ReadList): string =>
    list.folderKey ? "the account this folder's project key belongs to" : 'the signed-in account';
  const unreadText = (what: string): string =>
    `Dashboard path update pending: reasonbook.ai lists no project ${projectId} for ${what}, and the signed-in account's list of its projects could not be read (${unread?.error?.message ?? 'unknown error'}). Retry later: ${retry}.`;
  // Critic round 3, W1: whose record it is waits on the list that could not be read too.
  if (!owner)
    return pending(
      unread
        ? unreadText(lists.map(whose).join(', nor for '))
        : `Dashboard path update pending: reasonbook.ai lists no project ${projectId} for ${lists.map(whose).join(', nor for ')}, and this store names no owner, so whose record it is cannot be told. Sign in as the account that owns its dashboard record with rbook_auth, then ${retry}.`
    );
  const named: string[] = [];
  let unknown: string | undefined;
  for (const list of lists) {
    const me = await list.client.getMyProjects();
    const account = me.success ? me.data?.user?.username : undefined;
    // Critic round 3, R3-1: the owner's whole list lacks the id, but a list that could not be read
    // could hold the record unless it is the owner's own too.
    if (account === owner && (!unread || (await usernameOf(unread.client)) === owner))
      return {
        status: 'ended',
        left: `The dashboard path update ended: reasonbook.ai lists no project ${projectId} for ${owner}, the account that owns this store, so there is no dashboard record to repoint.`,
        notes: [],
      };
    if (!account)
      unknown ??= `Dashboard path update pending: reasonbook.ai lists no project ${projectId} for ${whose(list)}, and which account that is could not be read (${me.error?.message ?? 'no account in the answer'}). Retry later: ${retry}.`;
    else
      named.push(
        list.folderKey
          ? `${account}, the account this folder's project key belongs to`
          : `the signed-in account, ${account}`
      );
  }
  if (unknown) return pending(unknown);
  if (unread) return pending(unreadText(named.join(', nor for ')));
  return pending(
    `Dashboard path update pending: reasonbook.ai lists no project ${projectId} for ${named.join(', nor for ')}, and this store's owner is ${owner}. Sign in as ${owner} with rbook_auth, then ${retry}.`
  );
}

/** Probe O's condition: a record naming no file or another one is this store's only if it moved here. */
function otherPath(record: OwnedProject, input: PathStepInput, baseUrl: string): string {
  const recorded = record.localDbPath;
  if (recorded && namesAnotherFile(recorded, input.dbPath))
    return `Dashboard path update pending: reasonbook.ai's record ${record.id} names ${recorded} as its Local Database Path, another store's file, so this store is a copy and must not take that record. No command yet gives a copy its own dashboard project.`;
  return `Dashboard path update pending: reasonbook.ai's record ${record.id} names ${recorded ?? 'no file'} as its Local Database Path, not this store's. If this store is that project's own and moved here, save ${input.dbPath} under Local Database Path on ${baseUrl.replace(/\/$/, '')}/projects/${record.id}/shares, then ${input.retry}. Otherwise this store is a copy and must not take that record.`;
}

/**
 * Critic round 1, F1: whether a recorded path names another store's file. A relative path would
 * resolve against the working folder, and a case-folding disk or a `..` can name this store's own file
 * in a spelling the tie refuses, so only an absolute path to a file with another device and inode
 * counts; anything else gets the form remedy, which finishes the step when the file is this one. The
 * dashboard stores a path as typed, so a folder (round 2, R2-2) or a file that is no store's database,
 * one not ending in a store tail (round 3, R3-2), names no store's file. A `..` (round 4, R4-1) is
 * refused as the tie refuses it: storeTailOf collapses it as text, while the system follows a symlink
 * before it, to a file whose own path may end in no store tail.
 */
function namesAnotherFile(recorded: string, dbPath: string): boolean {
  if (!path.isAbsolute(recorded) || recorded.split(SEPARATORS).includes('..')) return false;
  if (!storeTailOf(recorded)) return false;
  try {
    const [other, own] = [fs.statSync(recorded), fs.statSync(dbPath)];
    return other.isFile() && (other.dev !== own.dev || other.ino !== own.ino);
  } catch {
    return false;
  }
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The author a write stamps (ADR s96 §10): this copy's name, the user's, or the signed-in dashboard
// ABOUTME: account's, resolved once per call; and how a read shows a stored author, including a NULL one.

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';
import type { UserScopedKeyRecord } from '../../intelligence/credential-store';
import {
  getSetting,
  resolveConfigDirectory,
  resolveRecordPaths,
} from '../../intelligence/legacy-compat';
import {
  AUTHOR_BEFORE_RECORDED,
  AUTHOR_NOT_RECORDED,
  readDashboardIdentity,
  readUserAuthor,
  validAuthorName,
  type DashboardIdentity,
} from '../../intelligence/user-author';
import type { RbookDatabaseClient } from './client';
import {
  pickNewestUserScopedKey,
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  resolveDashboardBaseUrl,
} from './dashboard-client';
import { PROJECT_ENTITY } from './record-columns';
import type { LoggedChange } from './record-standing';
import { REPLICA_KEYS, storeFolder } from './replica-identity';
import { AUTHOR_NAMES_SINCE_KEY } from './schema-migrations';

/** ADR s96 §10's readings for a NULL author, kept beside the name rule that refuses them. */
export { AUTHOR_BEFORE_RECORDED, AUTHOR_NOT_RECORDED };

/** What a write stamps: `author_name`, and `author_user_id` when a sign-in vouches for it. */
export interface WriteAuthor {
  readonly name: string | null;
  readonly userId: string | null;
  /** Where the name came from, for `reasonbook config author`. */
  readonly source: 'copy' | 'user' | 'dashboard' | null;
}

const perClient = new WeakMap<RbookDatabaseClient, WriteAuthor>();
let reportedConfigProblem = false;

/** The user's setting, reported once on stderr when the config cannot be read rather than guessed. */
function userAuthor(env: NodeJS.ProcessEnv): string | null {
  try {
    return readUserAuthor(env);
  } catch (error) {
    if (!reportedConfigProblem) {
      reportedConfigProblem = true;
      process.stderr.write(
        `[Reasonbook] the author name in the user config could not be read, so writes take the sign-in's or none: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
    return null;
  }
}

interface StoredCredentials {
  readonly userScopedKeys?: Record<string, UserScopedKeyRecord>;
  readonly projectKeys?: Record<string, { key?: string; parentKeyId?: string }>;
}

/**
 * The credentials whose identity names this project's writes, best first. The first is the one
 * its dashboard client signs in with, in `DashboardClient.fromEnvForProject`'s order: the
 * project's own key, the newest user-scoped key, the environment's key, the environment's email.
 * A project key is followed by the user key it was issued under, which the dashboard binds it to
 * (one account), so a project registered after a sign-in is named before its key's first
 * checkpoint.
 */
function projectCredentials(projectRoot: string | null, env: NodeJS.ProcessEnv): string[] {
  let stored: StoredCredentials = {};
  try {
    stored = JSON.parse(
      readFileSync(path.join(resolveConfigDirectory(env), 'credentials.json'), 'utf8')
    ) as StoredCredentials;
  } catch {
    stored = {};
  }
  const projectKey = projectRoot ? stored.projectKeys?.[path.resolve(projectRoot)] : undefined;
  if (projectKey?.key) {
    const parent = projectKey.parentKeyId
      ? stored.userScopedKeys?.[projectKey.parentKeyId]?.key
      : undefined;
    return parent ? [projectKey.key, parent] : [projectKey.key];
  }
  const newest = pickNewestUserScopedKey(stored.userScopedKeys ?? {});
  if (newest) return newest.record.key ? [newest.record.key] : [];
  const envKey = getSetting(RBOOK_DASHBOARD_API_KEY_ENV, env);
  if (envKey) return [envKey];
  const email = getSetting(RBOOK_DASHBOARD_USER_ENV, env);
  return email && getSetting(RBOOK_DASHBOARD_PASSWORD_ENV, env) ? [`password:${email}`] : [];
}

/**
 * The identity the dashboard returned for this project's credential, against the dashboard
 * configured now; another sign-in's, a removed key's or another dashboard's is never taken.
 */
export function signedInIdentity(
  projectRoot: string | null,
  env: NodeJS.ProcessEnv = process.env
): DashboardIdentity | null {
  try {
    const baseUrl = resolveDashboardBaseUrl();
    for (const credential of projectCredentials(projectRoot, env)) {
      const identity = readDashboardIdentity(credential, baseUrl, env);
      if (identity) return identity;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The author for a write with no copy of its own to consult: the user's name, else the signed-in
 * account's username. A raw-connection write (project init) and the CLI use it.
 */
export function userAuthorForWrite(
  projectRoot: string | null = null,
  env: NodeJS.ProcessEnv = process.env
): WriteAuthor {
  const identity = signedInIdentity(projectRoot, env);
  const user = userAuthor(env);
  const name = user ?? identity?.username ?? null;
  return {
    name,
    userId: identity?.userId ?? null,
    source: user ? 'user' : identity?.username ? 'dashboard' : null,
  };
}

/** The name an invite gave this copy, which s96-m13's join stores in per-copy metadata. */
function copyAuthor(client: RbookDatabaseClient): string | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    REPLICA_KEYS.author,
  ]);
  return row.success && row.data?.value ? validAuthorName(row.data.value) : null;
}

/** The author every write through this client stamps, resolved once per client. */
export function authorForWrite(client: RbookDatabaseClient): WriteAuthor {
  const known = perClient.get(client);
  if (known) return known;
  const fallback = userAuthorForWrite(storeFolder(client.path));
  const copy = copyAuthor(client);
  // s96-m13 (#671): a joined copy writes under its invite's name, and stamps the signed-in user's
  // id only when that account goes by the same name: another account's sign-in is not the member.
  const signedIn = copy ? signedInIdentity(storeFolder(client.path)) : null;
  const author: WriteAuthor = copy
    ? {
        ...fallback,
        name: copy,
        source: 'copy',
        userId:
          signedIn?.username && validAuthorName(signedIn.username) === copy
            ? signedIn.userId
            : null,
      }
    : fallback;
  perClient.set(client, author);
  return author;
}

/**
 * s96-m13 (#671): the name this project's writes go by, as the review compares it: a joined copy's
 * invite name, read from its store's own metadata without a client, else the user's.
 */
export function writerName(projectRoot: string | null): string | null {
  if (projectRoot) {
    let db: Database.Database | null = null;
    try {
      db = new Database(resolveRecordPaths(projectRoot).dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      const row = db
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get(REPLICA_KEYS.author) as { value?: string } | undefined;
      const copy = row?.value ? validAuthorName(row.value) : null;
      if (copy) return copy;
    } catch {
      // No store, or one with no metadata: the user's name, as a write would resolve it.
    } finally {
      db?.close();
    }
  }
  return userAuthorForWrite(projectRoot).name;
}

/** When this store began recording authors, or null if it has not. */
export function authorNamesSince(client: RbookDatabaseClient): number | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    AUTHOR_NAMES_SINCE_KEY,
  ]);
  const since = Number(row.success ? row.data?.value : undefined);
  return Number.isFinite(since) ? since : null;
}

/** How a read shows a row's author (ADR s96 §10); both times are integer milliseconds. */
export function authorReading(
  name: string | null | undefined,
  occurredAtMs: number | null | undefined,
  sinceMs: number | null
): string {
  if (name) return name;
  if (sinceMs === null || typeof occurredAtMs !== 'number' || occurredAtMs < sinceMs)
    return AUTHOR_BEFORE_RECORDED;
  return AUTHOR_NOT_RECORDED;
}

/**
 * ADR s96 §10: a name another copy recorded, on the change or in its row, meets the rule every name a
 * copy stamps already meets (validAuthorName), so none brings a hidden or control character in.
 */
export function breaksNameRule(change: LoggedChange): boolean {
  const names: unknown[] = [change.author_name];
  if (change.entity !== PROJECT_ENTITY && change.value !== null) {
    const value: unknown = JSON.parse(change.value);
    if (change.kind === 'create' && value !== null && typeof value === 'object')
      names.push((value as Record<string, unknown>).author_name);
    else if (change.field === 'author_name') names.push(value);
  }
  return names.some(
    (name) =>
      name !== null &&
      name !== undefined &&
      (typeof name !== 'string' || validAuthorName(name) !== name)
  );
}

/** s96-m13: forget the author this client resolved, after the user's name was set mid-call (share). */
export function forgetAuthorForWrite(client: RbookDatabaseClient): void {
  perClient.delete(client);
}

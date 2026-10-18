// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sharing a project (design §s96-m13 item 1): refused while git tracks the store, it names the owner by an author
// ABOUTME: name, makes the store ready, then takes the first identity; the migrations' warnings ride the answer.

import { execFileSync } from 'child_process';
import path from 'path';
import { readUserAuthor, validAuthorName, writeUserAuthor } from '../../intelligence/user-author';
import { LEGACY } from '../../intelligence/legacy-compat';
import { authorForWrite, forgetAuthorForWrite } from './author-name';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { attachWarnings } from './format-warnings';
import { readReplicaIdentity, REPLICA_ERROR_CODES } from './replica-identity';
import { shareRecord } from './record-share';
import { prepareForSharing } from './sharing-preconditions';
import type { RbookToolResult } from './types';

export interface ShareResult {
  readonly replicaId: string;
  readonly block: number;
  readonly owner: string;
  readonly tablesCreated: readonly string[];
  readonly indexesCreated: readonly string[];
}

/** The store files a project could track in git: this layout's and the old one's. */
const STORE_FILES = [
  path.join('rbook', 'db', 'rbook.sqlite'),
  path.join(LEGACY.recordDirectory, 'db', LEGACY.databaseFile),
];

/**
 * The store file git tracks in this project, or null (fact 29's predicate). A `git pull` would
 * overwrite a copy's own changes with another's file, so such a project cannot be shared. With no
 * git, or no repository, nothing is tracked.
 */
export function trackedStore(projectRoot: string): string | null {
  for (const file of STORE_FILES) {
    try {
      execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', file], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return file;
    } catch {
      // Not tracked, not a repository, or no git: each means not tracked.
    }
  }
  return null;
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/**
 * Share this project: the owner's copy becomes the first authority, in block 0 (ADR s96 §4, §8). It
 * asks for an author name when none is set (ADR §10); `authorName` sets it for this user.
 */
export function shareProject(
  client: RbookDatabaseClient,
  projectRoot: string,
  options: { readonly authorName?: string } = {}
): RbookToolResult<ShareResult> {
  if (readReplicaIdentity(client, { fresh: true }))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'This project is shared already: this store is a copy of its shared record.',
      suggestion: 'List its members with rbook_project(action="members"), or invite one.',
    });
  const tracked = trackedStore(projectRoot);
  if (tracked)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `This project's git repository tracks its store (${tracked}), so a git pull would overwrite a copy's own changes with another's file; it cannot be shared.`,
      suggestion: `Stop tracking the store first (git rm --cached ${tracked}, and add it to .gitignore), then share.`,
    });
  if (options.authorName !== undefined) {
    const name = validAuthorName(options.authorName);
    if (!name)
      return refuse({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message:
          'An author name is one line of at most 80 characters with a visible one, and no hidden or control characters.',
        suggestion: 'Share again with the name your records will carry, such as your first name.',
      });
    let current: string | null = null;
    try {
      current = readUserAuthor();
    } catch {
      // An unreadable config is rewritten with the name this share was given.
    }
    if (!current) {
      writeUserAuthor(name);
      forgetAuthorForWrite(client);
    }
  }
  const owner = authorForWrite(client).name;
  if (!owner)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'Sharing names its owner by an author name, and none is set here.',
      suggestion: 'Share again with authorName, or set one first: reasonbook config author <name>.',
    });
  // The migrations that make the store ready say what they did on the answer, a refusal included.
  const warnings: string[] = [];
  const result = ((): RbookToolResult<ShareResult> => {
    const readiness = prepareForSharing(client);
    warnings.push(...readiness.warnings);
    if (!readiness.ready)
      return createError<ShareResult>({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `This store is not ready to share: ${readiness.problems.join(' ')}`,
        suggestion: 'Fix what it names, then share again; nothing was shared.',
      });
    const shared = shareRecord(client);
    return createSuccess({
      replicaId: shared.replicaId,
      block: 0,
      owner,
      tablesCreated: readiness.tablesCreated,
      indexesCreated: readiness.indexesCreated,
    });
  })();
  return attachWarnings(result, warnings);
}

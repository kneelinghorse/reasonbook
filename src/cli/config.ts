// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook config author sets the author name records carry (ADR s96 §10), as git's user.name does;
// ABOUTME: with no name it shows what each source gives and which one a write takes.

import Database from 'better-sqlite3';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import { readUserAuthor, validAuthorName, writeUserAuthor } from '../intelligence/user-author';
import { signedInIdentity } from '../tools/rbook/author-name';
import { REPLICA_KEYS } from '../tools/rbook/replica-identity';

const USAGE =
  'reasonbook config author [<name>]: set the author name your records carry, or show where it comes from.';

/** The name an invite gave this project's copy, read without opening the store for writing. */
function copyAuthor(dbPath: string): string | null {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get(REPLICA_KEYS.author) as { value?: string } | undefined;
      return row?.value ? validAuthorName(row.value) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function show(io: CliIo, projectRoot: string | undefined): number {
  let user: string | null = null;
  let problem: string | null = null;
  try {
    user = readUserAuthor(io.env);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const resolution = resolveCliProject({ projectRootArg: projectRoot, env: io.env, cwd: io.cwd });
  const identity = signedInIdentity(
    resolution.kind === 'store' ? resolution.projectRoot : null,
    io.env
  );
  const copy = resolution.kind === 'store' ? copyAuthor(resolution.dbPath) : null;
  const lines = [
    ...(resolution.kind === 'store'
      ? [`This copy's name (from an invite): ${copy ?? 'none'}`]
      : []),
    `Your name (reasonbook config author): ${user ?? (problem ? `unreadable: ${problem}` : 'none')}`,
    `Signed-in dashboard account: ${identity?.username ?? 'none'}`,
  ];
  const takes = copy ?? user ?? identity?.username ?? null;
  lines.push(
    takes
      ? `Records written here carry the author ${takes}.`
      : 'Records written here carry no author name: set one with reasonbook config author <name>.'
  );
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

export async function runConfig(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if (positional[0] !== 'author') {
    io.stderr(USAGE);
    return 1;
  }
  if (positional.length === 1) return show(io, flags['project-root']);
  try {
    // A name of several words may come quoted or not, as a person types it.
    const name = writeUserAuthor(positional.slice(1).join(' '), io.env);
    io.stdout(`Records you write from now on carry the author name ${name}.\n`);
    return 0;
  } catch (error) {
    io.stderr(`reasonbook config: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook repair --guard (ADR s96 §6): records what a shared record staged outside its change log, then
// ABOUTME: rebuilds its guard and capture triggers and clears a leftover token, holding the write lock throughout.

import { parseArgs, resolveCliProject, type CliIo } from './core';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { repairRecordGuards } from '../tools/rbook/record-changes';
import { DAMAGED_COPY_REMEDY } from '../tools/rbook/replica-check';
import { isSharedStore } from '../tools/rbook/replica-identity';
import {
  guardProblems,
  guardRemedy,
  readGuardState,
  type GuardRemedy,
  type GuardState,
} from '../tools/rbook/record-guards';

const USAGE =
  'reasonbook repair --guard [--project-root <root>]: record what a shared record staged, rebuild its write guard, and clear a leftover write token.';

const RESTORE = `This copy cannot be repaired in place. ${DAMAGED_COPY_REMEDY}`;
const UPGRADE =
  'This copy has columns this version does not know: upgrade with npm install -g @aquex/reasonbook@latest.';

export async function runRepair(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  if (!flags['guard']) {
    io.stderr(USAGE);
    return 1;
  }
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store') {
    io.stderr('reasonbook repair: no Reasonbook store found here; pass --project-root <root>.');
    return 1;
  }
  // Opened without the copy check, which refuses exactly the copies this repairs.
  const opened = await RbookDatabaseClient.create({
    dbPath: resolution.dbPath,
    replicaCheck: false,
    registerProject: false,
  });
  if (!opened.success) {
    io.stderr(`reasonbook repair: ${opened.error?.message ?? 'the store could not be opened'}`);
    return 1;
  }
  const client = opened.data!;
  try {
    const logged = client.getOne<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_changes'"
    );
    if (!logged.success) throw new Error(logged.error?.message ?? 'the schema could not be read');
    const shared = isSharedStore(client);
    if (!logged.data && !shared) {
      io.stdout('This store is not a shared record, so it has no write guard to repair.\n');
      return 0;
    }
    if (!shared) {
      io.stderr(
        `reasonbook repair: this store keeps a change log but has lost its replica identity. ${RESTORE}`
      );
      return 1;
    }
    const repair: { before?: GuardState; recorded: number; refused?: GuardRemedy } = {
      recorded: 0,
    };
    // BEGIN IMMEDIATE waits for the write lock, then holds it: no writer is mid-write while the
    // stage is recorded, the guard rebuilt and a leftover token cleared.
    const done = client.writeTransaction(() => {
      repair.before = readGuardState(<T>(sql: string) => rows<T>(client, sql));
      const remedy = guardRemedy(repair.before);
      if (remedy === 'restore' || remedy === 'upgrade') {
        repair.refused = remedy;
        throw new Error(`the copy needs a ${remedy}`);
      }
      if (remedy) repair.recorded = repairRecordGuards(client);
    });
    const problems = repair.before ? guardProblems(repair.before) : [];
    if (!done.success) {
      // A staged delete, or a row with no stable id, is a loss no repair rebuilds.
      const cause = repair.refused ? '' : `${done.error?.message ?? 'the repair failed'}. `;
      io.stderr(
        `reasonbook repair: ${problems.length ? `${problems.join('; ')}. ` : ''}${cause}${
          repair.refused === 'upgrade' ? UPGRADE : RESTORE
        }`
      );
      return 1;
    }
    const after = guardProblems(readGuardState(<T>(sql: string) => rows<T>(client, sql)));
    if (after.length) {
      io.stderr(`reasonbook repair: the write guard is still not whole: ${after.join('; ')}.`);
      return 1;
    }
    io.stdout(
      problems.length
        ? `Repaired this shared record's write guard: ${problems.join('; ')}.` +
            (repair.recorded
              ? ` Recorded ${repair.recorded} staged change${repair.recorded === 1 ? '' : 's'} in the change log.\n`
              : '\n')
        : "This shared record's write guard is whole; nothing was changed.\n"
    );
    return 0;
  } catch (error) {
    io.stderr(`reasonbook repair: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    client.close();
  }
}

function rows<T>(client: RbookDatabaseClient, sql: string): T[] {
  const read = client.getMany<T>(sql);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

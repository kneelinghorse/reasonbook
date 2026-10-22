// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared setup for the shared-record copy tests (s96-m01): one config folder per machine, stores
// ABOUTME: made ready with the real share log and guards, and answers read through dispatch.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { shareRecord } from '../../src/tools/rbook/record-share';
import { __resetSharedSyncScheduler } from '../../src/tools/rbook/record-sync-scheduler';
import { moveReplicaBlock } from '../../src/tools/rbook/replica-copy-keys';
import {
  establishReplica,
  readReplicaIdentity,
  REPLICA_KEYS,
} from '../../src/tools/rbook/replica-identity';
import { prepareForSharing } from '../../src/tools/rbook/sharing-preconditions';
import { seedRbookDb } from './seedRbookDb';

export interface ReplicaFixture {
  readonly tmp: string;
  restore(): void;
}

/** A temporary folder, with RBOOK_CONFIG_DIR saved so `restore` puts it back. */
export function replicaFixture(prefix: string): ReplicaFixture {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const saved = process.env.RBOOK_CONFIG_DIR;
  return {
    tmp,
    restore() {
      // s98-m08: stop the shared-sync timer a test's tool calls may have started. It outlived its
      // file in the jest worker, synced a removed copy and wrote its failure inside a later file's
      // hook, whose one stderr line then was not its own.
      __resetSharedSyncScheduler();
      ProjectGraphRegistry.resetInstance();
      RbookDetector.resetInstance();
      if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
      else process.env.RBOOK_CONFIG_DIR = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Each config folder stands for one machine's registry, as on the Air and the Studio. */
export function useMachine(tmp: string, name: string): void {
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, `config-${name}`);
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
}

export const dbOf = (root: string): string => path.join(root, 'rbook', 'db', 'rbook.sqlite');

export const PROJECT_ID = 'p-shared';

/** A fresh unshared store of the shared project, in `<tmp>/<name>`. */
export function project(tmp: string, name: string): string {
  const root = path.join(tmp, name);
  seedRbookDb(root, { projectId: PROJECT_ID, projectName: 'shared' });
  return root;
}

export async function withClient<T>(
  root: string,
  run: (client: RbookDatabaseClient) => T,
  options: { replicaCheck?: boolean } = {}
): Promise<Awaited<T>> {
  const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root), ...options });
  if (!opened.success || !opened.data) throw new Error(opened.error?.message ?? 'no client');
  const client = opened.data;
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/**
 * Make this folder a copy of the shared record in `block`, bound on the current machine, as the
 * share step does, then move its number block for allocation tests. A copied shared file already
 * has its log and guards, so it only takes a fresh identity, as the join does.
 */
export async function share(root: string, block: number): Promise<void> {
  writeUserAuthor('Owner');
  await withClient(
    root,
    (client) => {
      const readiness = prepareForSharing(client);
      if (!readiness.ready) throw new Error(readiness.problems.join(' '));
      if (readReplicaIdentity(client)) establishReplica(client, { block });
      else {
        shareRecord(client);
        if (block !== 0) moveReplicaBlock(client, block);
      }
    },
    { replicaCheck: false }
  );
}

export interface Answer {
  success: boolean;
  data?: { decisionId?: number; sessionId?: string } & Record<string, unknown>;
  error?: { code: string; message: string; suggestion?: string };
}

export async function call(name: string, args: Record<string, unknown>): Promise<Answer> {
  RbookDetector.resetInstance();
  const result = await executeMissionProtocolTool(name, args, await buildMissionProtocolContext());
  return result.structuredContent as unknown as Answer;
}

export const record = (root: string, content: string): Promise<Answer> =>
  call('rbook_decisions', { action: 'record', content, projectRoot: root });

/** The copy's own sequence, read from its file. */
export function seq(root: string): number {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(REPLICA_KEYS.seq) as
      | { value: string }
      | undefined;
    return Number(row?.value ?? 0);
  } finally {
    db.close();
  }
}

/** This machine's mark for the project's one live copy. */
export function mark(): number {
  return ProjectGraphRegistry.getInstance().liveReplicas(PROJECT_ID)[0].seq_mark;
}

/** A consistent single-file copy of the store, as a backup tool would make. */
export function backup(root: string, to: string): void {
  const db = new Database(dbOf(root));
  try {
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

export function dropSidecars(root: string): void {
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbOf(root) + suffix, { force: true });
}

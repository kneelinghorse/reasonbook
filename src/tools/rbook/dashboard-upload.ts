// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared lease and consistent SQLite snapshot for explicit and automatic dashboard uploads;
// ABOUTME: keeps pending work across failure or exit, and removes active or day-old abandoned copies.

import { LEGACY, resolveRecordPaths } from '../../intelligence/legacy-compat';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { UploadOutcome } from '../../intelligence/project-upload-state';
import { isSameDirectory } from '../../intelligence/resolution-policy';
import { RbookDatabaseClient } from './client';
import { isMembersCopy } from './record-membership';
import {
  sweepStaleRecordCopies as sweepStaleUploadCopies,
  type RecordCopySweepOptions as UploadSweepOptions,
} from './record-temp-copies';

export { sweepStaleUploadCopies, type UploadSweepOptions };

export interface UploadProject {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly name: string;
  readonly registered: boolean;
  /** s96-m13: a copy of a shared record, read from the raw file; isMembersStore says whose. */
  readonly shared: boolean;
}

/**
 * s96-m13 (design §s96-m13 item 3): whether this project's store is a member's copy of a shared
 * record, which never uploads: the copy the authority chain names, after any handover or recovery
 * (ADR s96 §8). An unshared store answers from the raw read alone. A shared one that cannot be read
 * counts as a member's, so it stays quiet, and says so.
 */
export async function isMembersStore(project: UploadProject): Promise<boolean> {
  if (!project.shared) return false;
  const opened = await RbookDatabaseClient.create({
    dbPath: project.dbPath,
    registerProject: false,
    replicaCheck: false,
  });
  if (!opened.success || !opened.data) {
    uploadLog(
      `Did not upload ${project.projectId}: its store could not be read to see whose copy it is (${opened.error?.message ?? 'unread'}).`
    );
    return true;
  }
  try {
    return isMembersCopy(opened.data);
  } finally {
    opened.data.close();
  }
}

export function uploadLog(message: string): void {
  process.stderr.write(`[CHECKPOINT] ${message}\n`);
}

/** Missing metadata means an old/foreign store; query failures remain visible to the caller. */
export function readUploadProject(projectRoot: string): UploadProject | null {
  const root = path.resolve(projectRoot);
  const dbPath = resolveRecordPaths(root).dbPath;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get())
      return null;
    const values = new Map(
      (
        db
          .prepare(
            "SELECT key,value FROM metadata WHERE key IN ('project_id','project_name','dashboard_registered','replica_id')"
          )
          .all() as Array<{ key: string; value: string | null }>
      ).map((r) => [r.key, r.value])
    );
    const projectId = values.get('project_id');
    if (!projectId) return null;
    return {
      projectId,
      projectRoot: root,
      dbPath,
      name: values.get('project_name') ?? projectId,
      registered: values.get('dashboard_registered') === 'true',
      shared: Boolean(values.get('replica_id')),
    };
  } finally {
    db.close();
  }
}

const UPLOAD_COPY_PREFIX = 'rbook-dashboard-upload-';
const activeUploadCopies = new Set<string>();
let uploadsStopped = false;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove only copies this process created; shutdown cannot await a stalled upload's finally. */
export function cleanupActiveUploadCopies(): void {
  uploadsStopped = true;
  for (const directory of activeUploadCopies) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      activeUploadCopies.delete(directory);
    } catch (error) {
      uploadLog(`Could not remove the active upload copy ${directory}: ${errorText(error)}`);
    }
  }
}

export async function withUploadSnapshot<T>(
  dbPath: string,
  send: (file: string) => Promise<T>,
  sweep: UploadSweepOptions = {}
): Promise<T> {
  if (uploadsStopped) throw new Error('Dashboard upload skipped: server is shutting down.');
  sweepStaleUploadCopies(sweep);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), UPLOAD_COPY_PREFIX));
  activeUploadCopies.add(directory);
  const file = path.join(directory, LEGACY.databaseFile);
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    await db.backup(file);
    db.close();
    db = undefined;
    if (uploadsStopped) throw new Error('Dashboard upload skipped: server is shutting down.');
    return await send(file);
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    activeUploadCopies.delete(directory);
  }
}

/** Both entry points take this lease before registration/reconciliation, snapshot or network work. */
export async function withUploadLease(
  projectRoot: string,
  explicit: boolean,
  send: () => Promise<UploadOutcome>
): Promise<void> {
  const project = readUploadProject(projectRoot);
  if (!project || (!explicit && !project.registered)) return;
  const registry = await ProjectGraphRegistry.create();
  let entry = registry.get(project.projectId);
  if (!entry && explicit)
    entry = registry.register({
      project_id: project.projectId,
      store_path: project.projectRoot,
      name: project.name,
    });
  if (!entry || !isSameDirectory(entry.store_path, project.projectRoot))
    throw new Error('Upload project identity does not match its registered store path.');
  if (explicit && !registry.markUploadOwed(project.projectId))
    throw new Error('Could not mark the explicit upload owed.');
  const lease = registry.claimUpload(project.projectId, explicit);
  if (!lease) return;
  let lost = false;
  const keepAlive = setInterval(() => {
    try {
      if (!registry.renewUploadLease(project.projectId, lease.token)) {
        lost = true;
        uploadLog(
          `Upload lease lost for ${project.projectId}; completion cannot clear pending work.`
        );
      }
    } catch (error) {
      lost = true;
      uploadLog(
        `Upload lease renewal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, 60_000);
  keepAlive.unref();
  let outcome: UploadOutcome;
  try {
    outcome = await send();
  } catch (error) {
    outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearInterval(keepAlive);
  }
  if (lost || !registry.finishUpload(project.projectId, lease, outcome)) {
    uploadLog(
      `Upload result could not be committed for ${project.projectId}; its pending mark remains.`
    );
  }
  if (!outcome.success)
    uploadLog(`Upload failed for ${project.projectId}: ${outcome.error ?? 'unknown'}`);
}

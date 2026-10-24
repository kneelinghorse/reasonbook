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
  // A host may close stderr before ending stdin; diagnostics must not abort lease cleanup.
  try {
    process.stderr.write(`[CHECKPOINT] ${message}\n`, () => {});
  } catch {
    /* closed pipe */
  }
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
let acceptingUploads = true;
const uploadJobs = new Set<Promise<unknown>>();
const heldUploads = new Map<string, () => void>();

/** Reserve the entire job before its first await, including credential resolution and lease waiting. */
export function trackDashboardUpload<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (!acceptingUploads) return Promise.resolve(undefined);
  const job = work();
  uploadJobs.add(job);
  void job.then(
    () => uploadJobs.delete(job),
    () => uploadJobs.delete(job)
  );
  return job;
}

export function stopAcceptingDashboardUploads(): void {
  acceptingUploads = false;
}

export async function drainDashboardUploads(): Promise<void> {
  while (uploadJobs.size) await Promise.allSettled([...uploadJobs]);
}

export function interruptDashboardUploads(): void {
  uploadsStopped = true;
  for (const release of heldUploads.values()) {
    try {
      release();
    } catch (error) {
      uploadLog(`Could not release an interrupted upload: ${errorText(error)}`);
    }
  }
}

export function __resetDashboardUploadLifecycle(): void {
  acceptingUploads = true;
  uploadsStopped = false;
}

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
  send: () => Promise<UploadOutcome>,
  options: { waitForLease?: boolean } = {}
): Promise<UploadOutcome | null> {
  const project = readUploadProject(projectRoot);
  if (!project || (!explicit && !project.registered)) return null;
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
  if (explicit && !registry.markUploadOwed(project.projectId, Date.now(), true))
    throw new Error('Could not mark the explicit upload owed.');
  if (uploadsStopped) return null;
  let lease = registry.claimUpload(project.projectId, explicit);
  while (!lease && explicit && options.waitForLease !== false && !uploadsStopped) {
    const state = registry.readUploadState(project.projectId);
    if (
      !state?.leaseToken ||
      (state.blocked && ['deleted', 'replaced'].includes(state.pauseReason ?? ''))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (uploadsStopped) return null;
    lease = registry.claimUpload(project.projectId, explicit);
  }
  if (!lease) return null;
  const claimed = lease;
  let lost = false;
  const keepAlive = setInterval(() => {
    try {
      if (!registry.renewUploadLease(project.projectId, claimed.token)) {
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
  heldUploads.set(claimed.token, () => {
    clearInterval(keepAlive);
    lost = true;
    registry.finishUpload(project.projectId, claimed, {
      success: false,
      interrupted: true,
      error: 'The server ended before the upload finished.',
    });
  });
  let outcome: UploadOutcome;
  try {
    outcome = await send();
  } catch (error) {
    outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearInterval(keepAlive);
    heldUploads.delete(claimed.token);
  }
  if (lost || !registry.finishUpload(project.projectId, claimed, outcome)) {
    uploadLog(
      `Upload result could not be committed for ${project.projectId}; its pending mark remains.`
    );
    return {
      success: false,
      error:
        'The upload result could not be committed because its lease was lost or expired; recovery is not confirmed.',
    };
  }
  if (!outcome.success)
    uploadLog(`Upload failed for ${project.projectId}: ${outcome.error ?? 'unknown'}`);
  return outcome;
}

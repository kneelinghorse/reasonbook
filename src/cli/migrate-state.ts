// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The durable files a move leaves: each phase flushed before its rename, and the marker naming the
// ABOUTME: follow-ups a committed move still owes, which a retry runs whenever the marker exists (s109-m01).
import fs from 'fs';
import path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';

export const PENDING = '.rbook-migration-pending.json';
export const JOURNAL = '.rbook-migration.json';
export const LOCK = '.rbook-migration.lock';

export interface Journal {
  readonly pid: number;
  readonly source: string;
  readonly destination: string;
  readonly originalIgnore: string | null;
  /** s109-m01: its bytes, base64, so rollback restores them exactly. */
  readonly originalIgnoreBytes?: string;
  /** s109-m01: false when the record's .gitignore is a link, which migrate does not write through. */
  readonly ignoreEdited?: boolean;
  readonly ignoreMode: number;
  readonly backup: string;
  readonly journalMode: string;
  /** s109-m01: the old folder's spelling on disk, which the git index step looks for. */
  readonly folder?: string;
  readonly steps?: string[];
  phase: 'prepared' | 'folder' | 'database' | 'committed';
}

/**
 * Test-only seams: s108-m05's between a move's final open-file check and its first rename, and
 * s109-m01's before that final check and before rollback puts the store back in its journal mode.
 */
export const cutoverSeams = {
  beforeFinalCheck: (): void => undefined,
  beforeRename: (): void => undefined,
  beforeRollbackVerify: (): void => undefined,
};

export function release(root: string): void {
  fs.rmSync(path.join(root, JOURNAL), { force: true });
  // A journal write that failed leaves its temporary file (build critic A, note 10).
  fs.rmSync(path.join(root, `${JOURNAL}.tmp`), { force: true });
  fs.rmSync(path.join(root, LOCK), { recursive: true, force: true });
}

/** Flush each phase before its rename, so recovery sees an intent even after a process crash. */
export function writeMigrationState(file: string, data: unknown): void {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

/** s109-m01: what a moved record still owes; a retry runs every step while the marker exists. */
export interface PendingMarker {
  readonly backup?: string;
  readonly remaining: string;
  readonly steps?: readonly string[];
  readonly folder?: string;
}

export function readPending(root: string): PendingMarker | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, PENDING), 'utf8')) as PendingMarker;
  } catch {
    return null;
  }
}

/** Writes the marker, keeping what an earlier write said that this one does not. */
export function writePending(root: string, update: Partial<PendingMarker>): void {
  writeMigrationState(path.join(root, PENDING), { ...(readPending(root) ?? {}), ...update });
}

export const followUps = (steps: readonly string[]) =>
  steps.length > 1 ? `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}` : steps[0];

/** The marker a committed move leaves; it names the git step whenever one may be owed. */
export function pendingAfterCommit(journal: {
  readonly backup: string;
  readonly steps?: readonly string[];
  readonly folder?: string;
}): PendingMarker {
  const steps = journal.steps ?? ['the git index', 'documents', 'registration'];
  return {
    backup: journal.backup,
    remaining: followUps(steps),
    steps,
    folder: journal.folder ?? LEGACY.recordDirectory,
  };
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Importing a copy made before sharing (ADR s96 §9): refused unless this is a copy of the shared record and the
// ABOUTME: copy is this project's from before sharing; a dry run that classifies every row first, applied on request.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { attachWarnings } from './format-warnings';
import { embedLive } from './record-apply-embed';
import { isRecordedStore } from './record-guards';
import { applyImport, type ImportApplied } from './record-import-apply';
import {
  folderOfStore,
  openImportCopy,
  sharedBase,
  sharedMarker,
  storesOf,
  type ImportCopy,
} from './record-import-copy';
import { planImport, type ImportPlan } from './record-import-plan';
import { recordedProjectId, REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import { ensureMissionTimestamps, ensureStrategicDecisionsSchema } from './schema-migrations';
import { prepareForSharing } from './sharing-preconditions';
import type { RbookToolResult } from './types';

export interface ImportReport extends ImportPlan {
  /** The copy's folder, and the store read in it. */
  readonly from: string;
  readonly store: string;
  /** Rows the copy holds of its own, which the import creates. */
  readonly ownRows: number;
  /** Rows deleted on the owner that `--include` brings in. */
  readonly includedRows: number;
  /** Fields the record holds differently, which archiving the copy would drop. */
  readonly differing: number;
  /** Of those, the ones whose copy-side row carries a time after the marker. */
  readonly flagged: number;
  /** The rows `--include` names that the record holds already, so it brings in nothing for them. */
  readonly alreadyIn: readonly string[];
  readonly applied: ImportApplied | null;
}

export interface ImportOptions {
  readonly apply?: boolean;
  /** Rows labelled deleted on the owner to bring in anyway, as `<table>:<id>`. */
  readonly include?: readonly string[];
}

function targetSnapshots(client: RbookDatabaseClient) {
  const read = client.getMany<{ id: number; created_at: string; content_hash: string | null }>(
    'SELECT id, created_at, content_hash FROM context_snapshots'
  );
  return read.success ? (read.data ?? []) : [];
}

function report(
  copy: ImportCopy,
  plan: ImportPlan,
  include: ReadonlySet<string>,
  applied: ImportApplied | null
): RbookToolResult<ImportReport> {
  const inRecord = new Set(
    plan.tables.flatMap((table) => table.inRecord.map((id) => `${table.table}:${id}`))
  );
  const fields = plan.tables.flatMap((table) => [
    ...table.conflicts,
    ...table.copyChanged,
    ...table.inConflict,
    ...table.flagKept,
    ...table.linkDiffers,
  ]);
  // A matched row's field naming a row left out is one the copy holds differently too.
  const keptForReference = plan.tables.flatMap((table) =>
    table.leftOut.filter((entry) => !entry.brought && !entry.waits && !entry.cites)
  );
  return createSuccess({
    ...plan,
    from: copy.folder,
    store: copy.store,
    ownRows: plan.tables.reduce((sum, table) => sum + table.own.length, 0),
    includedRows: plan.tables.reduce((sum, table) => sum + table.included.length, 0),
    differing: fields.length + keptForReference.length,
    flagged: [...fields, ...keptForReference].filter((field) => field.afterMarker).length,
    alreadyIn: [...include].filter((entry) => inRecord.has(entry)),
    applied,
  });
}

/** The plan against what this client holds now; under the write lock when it is to be applied. */
function planNow(
  client: RbookDatabaseClient,
  copy: ImportCopy,
  include: ReadonlySet<string>
): ImportPlan {
  const base = sharedBase(copy.snapshots, path.join(path.dirname(client.path), 'snapshots'));
  const copyDb = new Database(copy.dbPath, { readonly: true });
  let marker;
  try {
    marker = sharedMarker(copyDb, targetSnapshots(client));
  } finally {
    copyDb.close();
  }
  return { ...planImport(copy, client, base && copy.local(base), marker, include), base };
}

/** A zip archive, as a copy carried from another machine arrives, starts with its local header. */
function isZipArchive(file: string): boolean {
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    return false;
  }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

/** Why a copy could not be read, with the remedy that fits: access, or damage. */
function unreadable(from: string, error: unknown): RbookToolResult<ImportReport> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = `${from} could not be read as a copy: ${error instanceof Error ? error.message : String(error)}`;
  if (code === 'EACCES' || code === 'EPERM')
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message,
      suggestion: `Give this account read access to ${from}, then import it again.`,
    });
  return createError({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message,
    suggestion:
      'Restore the copy from a backup first; a copy that cannot be read cannot be brought in.',
  });
}

/**
 * Compare the copy at `from` with the shared record this client holds, and with `apply` write what
 * it would do as this copy's own changes. The copy's folder is only ever read.
 */
export async function importCopy(
  client: RbookDatabaseClient,
  from: string,
  options: ImportOptions = {}
): Promise<RbookToolResult<ImportReport>> {
  const stores = storesOf(from);
  if (stores.some((store) => sameFile(store, client.path))) {
    const message = `${from} holds the store this import would write to, so it cannot be brought into itself.`;
    // Run in the shared copy, the person named it by mistake; run in the old copy, the other way round.
    if (isRecordedStore(client))
      return createError({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message,
        suggestion:
          'Name the copy made before sharing with --from, not this copy of the shared record.',
      });
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message,
      suggestion:
        'Run the import in the copy of the shared record (--project-root <its folder>), naming this folder with --from.',
    });
  }
  if (!isRecordedStore(client))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'This project is not shared, so it holds no shared record for a copy to come into.',
      suggestion:
        'Share it first (rbook_project(action="share")), or run the import in a joined copy of the shared record.',
    });
  if (!stores.length)
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${from} holds no Reasonbook store: neither rbook/db/rbook.sqlite nor cmos/db/cmos.sqlite.`,
      suggestion: "Name the copy's project folder, or its store file.",
    });
  if (stores.length > 1)
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${from} holds both rbook/db/rbook.sqlite and cmos/db/cmos.sqlite, so which one is the copy is not clear.`,
      suggestion: 'Name the store file to bring in with --from.',
      validValues: stores,
    });
  if (isZipArchive(stores[0]))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${stores[0]} is a zip archive, not a Reasonbook store.`,
      suggestion: 'Unzip it first, then name the project folder it holds with --from.',
    });
  let copy: ImportCopy;
  try {
    copy = openImportCopy(from);
  } catch (error) {
    return unreadable(from, error);
  }
  try {
    const projectId = recordedProjectId(client);
    if (copy.projectId && copy.projectId !== projectId)
      return createError({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `${copy.folder} holds project ${copy.projectId}, and this copy holds ${projectId}.`,
        suggestion:
          "Import a copy of this project: a copy of another project belongs to that project's record.",
      });
    if (copy.replicaId)
      return createError({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `${copy.folder} is a copy of a shared record, not one made before sharing.`,
        suggestion:
          'Sync it instead: reasonbook sync in that folder, or join it with reasonbook join.',
      });
    const name = path.basename(folderOfStore(client.path));
    if (!copy.projectId && path.basename(copy.folder) !== name)
      return createError({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `${copy.folder} predates the project id, so it is matched by its folder's name, and that is not ${name}.`,
        suggestion: `Put the copy in a folder named ${name}, its store under ${name}/rbook/db/ or ${name}/cmos/db/, then import that folder.`,
      });
    const warnings: string[] = [];
    const include = new Set(options.include ?? []);
    const result = await (async (): Promise<RbookToolResult<ImportReport>> => {
      // Schema migrations only, on the temporary copy: the server's first-write upkeep never runs
      // here. A migration that warns may have read the copy wrong, so the answer carries its words.
      const opened = await RbookDatabaseClient.create({ dbPath: copy.dbPath, replicaCheck: false });
      if (!opened.success || !opened.data)
        return opened as unknown as RbookToolResult<ImportReport>;
      try {
        warnings.push(
          ...(ensureStrategicDecisionsSchema(opened.data).warnings ?? []),
          ...(ensureMissionTimestamps(opened.data).warnings ?? []),
          ...prepareForSharing(opened.data).warnings
        );
      } catch (error) {
        // A store missing the tables a Reasonbook store keeps cannot reach the sharing schema.
        return createError<ImportReport>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message: `${copy.folder}'s store could not be brought to the sharing schema: ${error instanceof Error ? error.message : String(error)}`,
          suggestion:
            "Name a copy of this project's Reasonbook folder; this store lacks what a Reasonbook store keeps.",
        });
      } finally {
        opened.data.close();
      }
      const plan = planNow(client, copy, include);
      const labelled = plan.tables.flatMap((table) => [
        ...table.deletedOnOwner.map((row) => `${table.table}:${row.id}`),
        ...table.perhapsIn.map((row) => `${table.table}:${row.id}`),
      ]);
      // A row the record holds now, as one an earlier --include brought in, needs nothing more.
      const held = new Set(
        plan.tables.flatMap((table) => table.inRecord.map((id) => `${table.table}:${id}`))
      );
      const unknown = [...include].filter((entry) => !labelled.includes(entry) && !held.has(entry));
      if (unknown.length)
        return createError<ImportReport>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message: `--include names ${unknown.join(', ')}, which the dry run labels neither deleted on the owner nor perhaps in the record already.`,
          suggestion:
            'Name only rows the dry run lists as deleted on the owner or perhaps in the record already, as <table>:<id>.',
          validValues: labelled,
        });
      if (!options.apply) return report(copy, plan, include, null);
      // Planned again under the write lock, so no other writer moves the record between the two.
      let applied: RbookToolResult<ImportApplied> | null = null;
      let final = plan;
      const locked = client.writeTransaction(() => {
        final = planNow(client, copy, include);
        applied = applyImport(client, final);
        if (!applied.success) throw new ReplicaRefusal(applied.error!);
      });
      const done = applied as RbookToolResult<ImportApplied> | null;
      if (done && !done.success) return done as unknown as RbookToolResult<ImportReport>;
      if (!locked.success || !done?.data) return locked as unknown as RbookToolResult<ImportReport>;
      // Its rows reach this copy's vectors once it commits, as a merge's do; a failure is said.
      const embedded = await embedLive(client, done.data.txns);
      warnings.push(...done.data.notes, ...embedded.warnings);
      return report(copy, final, include, done.data);
    })();
    return attachWarnings(result, warnings);
  } finally {
    copy.dispose();
  }
}

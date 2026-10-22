// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The copy an import reads (ADR s96 §9): found in its folder, copied to a temporary folder, its own schema read
// ABOUTME: before schema migrations bring the copy to the sharing schema, and the base and marker it shares with the record.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RECORDED_TABLES } from './record-columns';
import { sweepStaleRecordCopies } from './record-temp-copies';

/** The copy as its own schema held it, before anything migrated it. */
export interface ImportCopy {
  /** The folder the person named, or the store's folder when they named the file. */
  readonly folder: string;
  readonly store: string;
  /** The temporary copy, which the import migrates; the person's folder is never opened. */
  readonly dbPath: string;
  /** Each table the copy held, with its columns, before the schema step. */
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
  /** The stable ids each shared table held before the schema step minted any. */
  readonly ownStable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly projectId: string | null;
  /** A copy of a shared record has one; a copy made before sharing does not. */
  readonly replicaId: string | null;
  readonly snapshots: string | null;
  /** A copy of one of the person's files in the temporary folder, so opening it writes nothing there. */
  local(file: string): string;
  dispose(): void;
}

const LAYOUTS: ReadonlyArray<readonly string[]> = [
  ['rbook', 'db', 'rbook.sqlite'],
  ['cmos', 'db', 'cmos.sqlite'],
];

/** Every store a folder keeps, in the current layout or the cmos one older copies keep; a file is its own. */
export function storesOf(from: string): string[] {
  if (!fs.existsSync(from)) return [];
  if (fs.statSync(from).isFile()) return [from];
  return LAYOUTS.map((parts) => path.join(from, ...parts)).filter((store) => fs.existsSync(store));
}

/** Where a folder keeps its store: the current layout first. */
export function storeOfFolder(from: string): string | null {
  return storesOf(from)[0] ?? null;
}

/** A store's own folder: the project folder above its `rbook/db` or `cmos/db`, else the one it is in. */
export function folderOfStore(store: string): string {
  const parts = path.resolve(store).split(path.sep);
  const layout = LAYOUTS.some(
    (tail) => parts.slice(-tail.length).join(path.sep) === tail.join(path.sep)
  );
  return layout ? path.dirname(path.dirname(path.dirname(store))) : path.dirname(store);
}

/**
 * The columns each shared table held. Only those tables are read: a virtual table, such as a
 * vector table, needs a module this plain connection never loads.
 */
function readSchema(db: Database.Database): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  for (const table of RECORDED_TABLES) {
    const info = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
      name: string;
    }>;
    if (info.length) columns.set(table, new Set(info.map((column) => column.name)));
  }
  return columns;
}

function metadataValue(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

/**
 * Copy the person's store, and its WAL, to a temporary folder, and read what its own schema held;
 * the import then migrates that copy. A `mode=ro` open beside a WAL still writes its index, so the
 * person's folder is only ever read by the copy (fact 3, 2026-10-17).
 */
export function openImportCopy(from: string): ImportCopy {
  sweepStaleRecordCopies();
  const store = storeOfFolder(from);
  if (!store) throw new Error(`no store under ${from}`);
  const folder = fs.statSync(from).isFile() ? folderOfStore(store) : from;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-import-'));
  const dispose = () => fs.rmSync(temp, { recursive: true, force: true });
  try {
    const dbPath = path.join(temp, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(store, dbPath);
    if (fs.existsSync(`${store}-wal`)) fs.copyFileSync(`${store}-wal`, `${dbPath}-wal`);

    const raw = new Database(dbPath);
    let columns: Map<string, Set<string>>;
    const ownStable = new Map<string, Set<string>>();
    let projectId: string | null;
    let replicaId: string | null;
    try {
      const check = raw.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`the copy's store fails its integrity check: ${check}`);
      columns = readSchema(raw);
      for (const table of RECORDED_TABLES) {
        if (!columns.get(table)?.has('stable_event_id')) continue;
        const held = raw
          .prepare(`SELECT stable_event_id AS id FROM ${table} WHERE stable_event_id IS NOT NULL`)
          .all() as Array<{ id: string }>;
        ownStable.set(table, new Set(held.map((row) => row.id)));
      }
      projectId = metadataValue(raw, 'project_id');
      replicaId = metadataValue(raw, 'replica_id');
    } finally {
      raw.close();
    }

    const snapshots = path.join(path.dirname(store), 'snapshots');
    const copies = new Map<string, string>();
    // A snapshot keeps its WAL header, so even a read-only open writes its index beside it.
    const local = (file: string): string => {
      let copied = copies.get(file);
      if (!copied) {
        copied = path.join(temp, `local-${copies.size}.sqlite`);
        fs.copyFileSync(file, copied);
        copies.set(file, copied);
      }
      return copied;
    };
    return {
      folder,
      store,
      dbPath,
      columns,
      ownStable,
      projectId,
      replicaId,
      snapshots: fs.existsSync(snapshots) ? snapshots : null,
      local,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The base (ADR s96 §9): the newest whole-store snapshot both folders hold with identical content.
 * A file of the same size is hashed; the snapshot name carries its time, so the newest sorts last.
 */
export function sharedBase(copyDir: string | null, targetDir: string | null): string | null {
  // A joined copy carries the record without the owner's local snapshot directory.
  if (!copyDir || !targetDir || !fs.existsSync(targetDir)) return null;
  const list = (dir: string) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => ({
        name,
        file: path.join(dir, name),
        size: fs.statSync(path.join(dir, name)).size,
      }));
  const targets = list(targetDir);
  const shared = list(copyDir)
    .filter((copy) => {
      const same = targets.filter((target) => target.size === copy.size);
      if (!same.length) return false;
      const hash = fileHash(copy.file);
      return same.some((target) => fileHash(target.file) === hash);
    })
    .map((copy) => copy.file)
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return shared.length ? shared[shared.length - 1] : null;
}

export interface Marker {
  readonly id: number;
  readonly createdAt: string;
}

/**
 * The marker (ADR s96 §9): the newest context-snapshot row both stores hold with the same id,
 * creation time and content hash, a pruned hash read through its `pruned:` prefix.
 */
export function sharedMarker(
  copy: Database.Database,
  target: ReadonlyArray<{ id: number; created_at: string; content_hash: string | null }>
): Marker | null {
  const norm = (hash: string | null) => (hash ?? '').replace(/^pruned:/, '');
  let rows: Array<{ id: number; created_at: string; content_hash: string | null }>;
  try {
    rows = copy
      .prepare('SELECT id, created_at, content_hash FROM context_snapshots')
      .all() as typeof rows;
  } catch {
    return null;
  }
  const held = new Map(target.map((row) => [row.id, row]));
  let marker: Marker | null = null;
  for (const row of rows) {
    const other = held.get(row.id);
    if (!other || other.created_at !== row.created_at || !norm(row.content_hash)) continue;
    if (norm(other.content_hash) !== norm(row.content_hash)) continue;
    if (!marker || row.id > marker.id) marker = { id: row.id, createdAt: row.created_at };
  }
  return marker;
}

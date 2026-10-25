// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — a read never writes the record: every read-classified (tool, action) leaves each
// ABOUTME: store table, the config directory and the project tree unchanged, with and without the review role.

/**
 * WHY SEEDED COPIES. On an unmodified store almost no read can show a write: every row the old
 * staleness flagger could flag is already stale, and an address that is already canonical cannot be
 * healed. So each fixture holds the precondition of a write a read used to make (design doc
 * rbook/planning/s93-the-loop-runs-itself-build.md, m11 class 2):
 *  - every fixture holds an active decision and learning 29 sprints old, unreviewed and without
 *    evidence, which the old flagger set to 'stale';
 *  - `unknown-address`: project_identity says rbook://unknown/..., and metadata.owner knows the
 *    owner, so sender resolution's address repair would rewrite it;
 *  - `owner-less`: no metadata.owner, and a loopback dashboard that names one, so the opener's
 *    owner resolution would write it;
 *  - `unmigrated`: a store from before the lazy migrations and before the project_identity row,
 *    so each migration a read runs is exercised and an identity seed would show as an insert;
 *  - `search-drift`: search indexes built, then a decision stored while its index trigger was
 *    missing and the learnings/missions completion marker removed, so a search's index rebuild
 *    and marker write would show (the m11 reads critic, R2a and R2b);
 *  - `search-marker-other`: the same indexes, a learning the index missed, and the marker under an
 *    older value, which a search used to replace (R2c);
 *  - every config directory holds a registry row for a store that no longer exists, which
 *    `rbook_project(action="list", validate=true, prune=true)` archived, and registers the fixture
 *    itself and a sibling store, so cross-project reads have stores to open.
 * Each precondition has a positive control below: the write it enables really happens when a write
 * path runs, so a green run here is never the vacuous kind.
 *
 * WHAT "UNCHANGED" MEANS. Three detectors, because byte diffs cannot see a write that leaves a table
 * as it found it (an index rebuilt to the same rows):
 *  - no commit without DDL: a connection held open across the call sees PRAGMA data_version move
 *    only if the schema cookie moved too (every fixture is in WAL first, since a journal switch
 *    alone moves data_version);
 *  - no row write into a table that existed before the call: a tracer records every statement on
 *    the store that changed rows, by target table, whatever it left behind;
 *  - every table that existed before reads the same afterwards, row for row, over the columns it
 *    had before, sqlite_sequence included, and a table the call created holds rows only if it is
 *    the shadow table of a virtual table the call also created.
 * A table or column the call added is an exempt migration: DDL, plus filling a column or table
 * added in the same call (an FTS index built beside its new table). One more row is part of such a
 * migration: the completion marker a DDL migration writes under its own new metadata key
 * (MIGRATION_MARKER_KEYS), only in a call whose schema changed. No existing metadata value may
 * change: the schema label, which rewrites one, waits for a write. In the config directory only
 * the project-graph registry may change, and only by creating its schema or touching an existing
 * row's last_seen_at (decision #906). The project folder must gain or change no file besides the
 * database's own files, a registered sibling store must read the same, and the stub dashboard must
 * see no request except a GET, and none at all when no dashboard is configured.
 *
 * SCOPE AND WHAT IT CANNOT SEE (one contract). Scope: the read-classified pairs of
 * action-taxonomy.ts (26 on 2026-10-08, with decisions review; 27 with s96-m12's rbook_db conflicts; 28 with s96-m13's rbook_project members), derived here rather than listed, each called through the
 * MCP dispatch with the argument sets in ARGS. s93-m05 also runs CLI review, relevant, session-start
 * and first/later-prompt recall against the same fixtures and detectors; only each command's exact external
 * telemetry month, fail-open log, hashed recall/turn receipt and owned lifecycle files are exempted. Not seen:
 * argument combinations not in ARGS/the CLI cases; writes
 * to files outside the store, the config directory and the project folder; GET requests' effect on
 * a dashboard (non-loopback calls fail the run through the network deny); virtual tables, whose
 * shadow tables are compared instead; and the vector half of search, because the embedding model
 * does not load under jest, so search runs its keyword half here. These fixtures hold no pending
 * proposals: this suite does not exercise draft offers, binding or their runtime receipts; those
 * writes and their classification are covered by tests/cli/hook-drafts.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { runCli } from '../../../src/cli';
import { oneLine } from '../../../src/cli/core';
import { deliverFirstPrompt, recallStatePath } from '../../../src/cli/recall-runtime';
import { hookRuntimeIdentity, hookRuntimePath } from '../../../src/cli/hook-runtime';
import { lifecyclePaths } from '../../../src/cli/lifecycle-runtime';
import { targetForStore, telemetryKey } from '../../../src/tools/rbook/local-telemetry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { validateProject } from '../../../src/intelligence/sender-context';
import { READ_ONLY_ACTIONS, READ_ONLY_TOOLS } from '../../../src/tools/rbook/action-taxonomy';
import { withClientAsync } from '../../../src/tools/rbook/client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { resolveAndPersistOwner } from '../../../src/tools/rbook/owner-resolution';
import { READ_ONLY_AGENT_ENV } from '../../../src/tools/rbook/read-only-agent-guard';
import {
  ensureDecisionsFts5,
  ensureVectorStorage,
  VECTOR_STORAGE_SCHEMA_VERSION,
} from '../../../src/tools/rbook/schema-migrations';
import { seedRbookDb } from '../../helpers/seedRbookDb';

type FixtureKind =
  | 'flaggable'
  | 'unknown-address'
  | 'owner-less'
  | 'unmigrated'
  | 'search-drift'
  | 'search-marker-other';
const FIXTURES: readonly FixtureKind[] = [
  'flaggable',
  'unknown-address',
  'owner-less',
  'unmigrated',
  'search-drift',
  'search-marker-other',
];
const ROLES = ['unset', 'review'] as const;

const OPEN_SPRINT = 31;
const OLD_SPRINT = 2;
const STUB_OWNER = 'stubowner';
const STUB_PROJECT_ID = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

/** The argument sets each read pair is called with. A new read action fails the census below. */
const ARGS: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
  'rbook_review:': [{}],
  'rbook_status:': [{}],
  'rbook_context:view': [
    {},
    { sizeOnly: true },
    { contextType: 'master_context' },
    { contextType: 'project_context' },
    { contextType: 'project_identity' },
  ],
  'rbook_context:history': [{}],
  'rbook_context:search': [{ query: 'storage decision' }],
  'rbook_db:health': [{}],
  // s96-m12: lists a shared record's conflicts; a solo store has none, and nothing is written.
  'rbook_db:conflicts': [{}],
  'rbook_decisions:list': [{}, { acrossProjects: true }],
  'rbook_decisions:search': [{ query: 'storage' }, { query: 'storage', acrossProjects: true }],
  'rbook_decisions:show': [{ decisionId: 1 }],
  'rbook_decisions:review': [{}, { includeApproaching: false }],
  'rbook_feedback:list': [{}],
  'rbook_learnings:list': [{}, { acrossProjects: true, category: 'technical' }],
  'rbook_learnings:search': [{ query: 'storage' }],
  'rbook_learnings:show': [{ learningId: 1 }],
  'rbook_mission:list': [{}],
  'rbook_mission:show': [{ missionId: 'rnw-m01' }],
  'rbook_mission:status': [{}],
  'rbook_project:list': [{}, { validate: true }, { validate: true, prune: true }],
  // s96-m13: on an unshared store it says so, and reads nothing it would write.
  'rbook_project:members': [{}],
  'rbook_session:list': [{}],
  'rbook_session:search': [{ query: 'storage' }],
  'rbook_sprint:list': [{}],
  'rbook_sprint:show': [{ sprintId: `sprint-${OPEN_SPRINT}` }],
  'rbook_auth:list': [{}],
  'rbook_message:list': [{}],
  'rbook_message:directory': [{}],
  'rbook_message:whoami': [{}],
};

/** Tools whose calls take no projectRoot (registry- or user-level reads). */
const PROJECT_FREE = new Set(['rbook_project:list', 'rbook_auth:list']);

function readPairs(): string[] {
  const pairs = [...READ_ONLY_TOOLS].map((tool) => `${tool}:`);
  for (const [tool, actions] of Object.entries(READ_ONLY_ACTIONS)) {
    for (const action of actions) pairs.push(`${tool}:${action}`);
  }
  return pairs.sort();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────

function sprintRows(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, ?, ?, ?)'
  );
  const day = 24 * 60 * 60 * 1000;
  const base = Date.now() - (OPEN_SPRINT + 1) * 14 * day;
  for (let n = 1; n <= OPEN_SPRINT; n++) {
    const start = new Date(base + (n - 1) * 14 * day).toISOString();
    const end = n === OPEN_SPRINT ? null : new Date(base + n * 14 * day).toISOString();
    insert.run(
      `sprint-${n}`,
      `Sprint ${n}`,
      n === OPEN_SPRINT ? 'Active' : 'Completed',
      start,
      end
    );
  }
}

function recordRows(db: Database.Database, legacy: boolean): void {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO missions (id, sprint_id, name, status, objective) VALUES (?, ?, ?, 'Queued', ?)`
  ).run('rnw-m01', `sprint-${OPEN_SPRINT}`, 'Pick the storage', 'Choose the storage layer.');
  db.prepare(
    `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, summary)
     VALUES ('PS-2026-01-01-001', 'planning', 'Storage planning', ?, ?, ?, 'completed', ?)`
  ).run(`sprint-${OLD_SPRINT}`, old, old, 'Talked about the storage layer.');
  const sessionColumn = legacy ? 'session_id' : 'author_session_id';
  db.prepare(
    `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status, ${sessionColumn})
     VALUES (1, 'Use SQLite for storage, because the record is small and local.', ?, ?, 'active', NULL)`
  ).run(old, `sprint-${OLD_SPRINT}`);
  db.prepare(
    `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
     VALUES (2, 'Keep the storage file out of git.', ?, ?, 'active')`
  ).run(now, `sprint-${OPEN_SPRINT}`);
  db.prepare(
    `INSERT INTO learnings (id, content, created_at, sprint_id, status)
     VALUES (1, 'Storage migrations must be DDL only on a read.', ?, ?, 'active')`
  ).run(old, `sprint-${OLD_SPRINT}`);
}

/** A store from before the lazy migrations: no event columns, session_id, no review timestamps. */
function legacyStore(projectRoot: string): string {
  const dbDir = path.join(projectRoot, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT,
        start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT,
        context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT,
        domain_fields TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL,
        updated_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id), started_at TEXT NOT NULL, completed_at TEXT,
        agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]',
        next_steps TEXT, metadata TEXT);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT,
        session_id TEXT, mission_id TEXT, source_chunk_ids TEXT, category TEXT,
        superseded_by INTEGER, status TEXT NOT NULL DEFAULT 'active', evidence TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
        category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT,
        mission_id TEXT, created_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    const meta = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    meta.run('project_name', 'reads-unmigrated');
    meta.run('project_id', 'reads-unmigrated');
    meta.run('owner', 'tester');
    const context = db.prepare(
      'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
    );
    // A master_context blob from before blob schema v1, so the blob migration has work to do.
    context.run(
      'master_context',
      'rbook/context/master_context.json',
      JSON.stringify({ project: { name: 'reads-unmigrated' }, decisions_made: ['old copy'] }),
      now
    );
    context.run('project_context', 'rbook/context/project_context.json', '{}', now);
    sprintRows(db);
    recordRows(db, true);
  } finally {
    db.close();
  }
  return dbPath;
}

function buildStore(kind: FixtureKind, projectRoot: string): string {
  if (kind === 'unmigrated') return legacyStore(projectRoot);
  const name = `reads-${kind}`;
  const dbPath = seedRbookDb(projectRoot, {
    projectName: name,
    projectId: name,
    owner: kind === 'owner-less' ? null : 'tester',
    rbookAddress:
      kind === 'unknown-address'
        ? `rbook://unknown/${name}`
        : kind === 'owner-less'
          ? ''
          : `rbook://tester/${name}`,
  });
  const db = new Database(dbPath);
  try {
    sprintRows(db);
    recordRows(db, false);
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  return dbPath;
}

/** Store one row while its index trigger is missing, so the index holds one row fewer. */
function insertUnindexed(db: Database.Database, trigger: string, insertSql: string): void {
  const sql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger) as {
      sql: string;
    }
  ).sql;
  db.exec(`DROP TRIGGER ${trigger}`);
  db.prepare(insertSql).run(new Date().toISOString());
  db.exec(sql);
}

/**
 * The search fixtures: the indexes a search builds, built by the same migrations on a call that may
 * write, then put out of step the two ways the m11 reads critic found a read search rewrote.
 */
async function buildSearchIndexes(
  kind: 'search-drift' | 'search-marker-other',
  projectRoot: string,
  dbPath: string
): Promise<void> {
  const built = await withClientAsync(
    async (client) => {
      const decisions = ensureDecisionsFts5(client);
      const others = ensureVectorStorage(client);
      return createSuccess([...(decisions.warnings ?? []), ...(others.warnings ?? [])]);
    },
    { projectRoot, registerProject: false }
  );
  expect(built.data).toEqual([]);
  const db = new Database(dbPath);
  try {
    if (kind === 'search-drift') {
      insertUnindexed(
        db,
        'decisions_fts_insert',
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (3, 'A storage decision the index missed.', ?, 'active')`
      );
      db.prepare("DELETE FROM metadata WHERE key = 'vector_storage_columns'").run();
    } else {
      insertUnindexed(
        db,
        'learnings_fts_insert',
        `INSERT INTO learnings (id, content, created_at, status)
         VALUES (2, 'A storage learning the index missed.', ?, 'active')`
      );
      db.prepare("UPDATE metadata SET value = '2.2' WHERE key = 'vector_storage_columns'").run();
    }
  } finally {
    db.close();
  }
}

/** Rows in a table's FTS index and in the table itself. */
function indexCounts(dbPath: string, index: string, table: string): [number, number] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = (name: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
    return [count(`${index}_docsize`), count(table)];
  } finally {
    db.close();
  }
}

// ─── The statement tracer ──────────────────────────────────────────────────────────────────────

interface TracedWrite {
  readonly target: string | null;
  readonly sql: string;
}

/** The store file the tracer watches during one read, by every spelling of its path. */
let tracedFiles: ReadonlySet<string> = new Set();
const traced: TracedWrite[] = [];
const WRITE_TARGET =
  /^\s*(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?([A-Za-z_]\w*)/i;

type Method = (...args: unknown[]) => unknown;
const restoreTracer: Array<() => void> = [];

/**
 * Record every statement on a watched store that changed rows, whatever it left behind: a run, get,
 * all or iterate on a statement that may write, and an exec, each measured by total_changes().
 */
function installTracer(): void {
  const probe = new Database(':memory:');
  const changesOf = (db: Database.Database): number =>
    (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const statementProto = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Record<string, Method>;
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = statementProto[method];
    statementProto[method] = function (this: Database.Statement, ...args: unknown[]) {
      if (this.readonly || !tracedFiles.has(this.database.name)) return original.apply(this, args);
      const before = changesOf(this.database);
      const result = original.apply(this, args);
      if (changesOf(this.database) > before) {
        traced.push({
          target: WRITE_TARGET.exec(this.source)?.[1] ?? null,
          sql: this.source.replace(/\s+/g, ' ').slice(0, 160),
        });
      }
      return result;
    };
    restoreTracer.push(() => {
      statementProto[method] = original;
    });
  }
  const databaseProto = Object.getPrototypeOf(probe) as Record<string, Method>;
  const originalExec = databaseProto.exec;
  databaseProto.exec = function (this: Database.Database, ...args: unknown[]) {
    if (!tracedFiles.has(this.name)) return originalExec.apply(this, args);
    const before = changesOf(this);
    const result = originalExec.apply(this, args);
    // DDL counts the rows it writes into the shadow tables of what it creates; those fill what the
    // call added, and the table diff sees any DROP. Anything else through exec is a row write.
    const sql = String(args[0]);
    if (changesOf(this) > before && !/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) {
      traced.push({ target: null, sql: sql.replace(/\s+/g, ' ').slice(0, 160) });
    }
    return result;
  };
  restoreTracer.push(() => {
    databaseProto.exec = originalExec;
  });
  probe.close();
}

beforeAll(installTracer);
afterAll(() => {
  for (const restore of restoreTracer.splice(0)) restore();
});

/** Every table name in a store, virtual and shadow tables included. */
function tableNames(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name)
    );
  } finally {
    db.close();
  }
}

/**
 * Tables the call created that hold rows. Only a shadow table of a virtual table the call also
 * created may: that is filling what the call added.
 */
function filledNewTables(dbPath: string, before: ReadonlySet<string>): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const created = (
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
        sql: string | null;
      }>
    ).filter((t) => !before.has(t.name));
    const newVirtual = created
      .filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
      .map((t) => t.name);
    return created
      .filter((t) => !newVirtual.includes(t.name))
      .filter((t) => !newVirtual.some((v) => t.name.startsWith(`${v}_`)))
      .filter(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n > 0
      )
      .map((t) => t.name);
  } finally {
    db.close();
  }
}

// ─── Snapshots ─────────────────────────────────────────────────────────────────────────────────

interface TableShape {
  readonly columns: readonly string[];
  readonly rows: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Every ordinary table's rows, over its columns, ordered by rowid, sqlite_sequence included (an
 * insert into an AUTOINCREMENT table moves it even when the row is gone again). Virtual tables are
 * skipped; their shadow tables are compared.
 */
function snapshotTables(dbPath: string): Map<string, TableShape> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')`
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const shapes = new Map<string, TableShape>();
    for (const table of tables) {
      if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? '')) continue;
      const columns = (
        db.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      shapes.set(table.name, { columns, rows: rowsOver(db, table.name, columns) });
    }
    return shapes;
  } finally {
    db.close();
  }
}

function rowsOver(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  allowedNewMarkers: ReadonlySet<string> = new Set()
): string {
  const list = columns.map((c) => `"${c}"`).join(', ');
  let rows: unknown[];
  try {
    rows = db.prepare(`SELECT ${list} FROM "${table}" ORDER BY rowid`).raw().all();
  } catch {
    rows = db.prepare(`SELECT ${list} FROM "${table}" ORDER BY ${list}`).raw().all();
  }
  if (table === 'metadata' && allowedNewMarkers.size > 0) {
    const keyIndex = columns.indexOf('key');
    rows = rows.filter((row) => !allowedNewMarkers.has(String((row as unknown[])[keyIndex])));
  }
  return hash(JSON.stringify(rows));
}

/** Metadata keys present in a store, for the marker exemption. */
function metadataKeys(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return new Set(
      (db.prepare('SELECT key FROM metadata').all() as Array<{ key: string }>).map((r) => r.key)
    );
  } finally {
    db.close();
  }
}

/**
 * The completion markers of DDL-only migrations a read may run (schema-migrations.ts). A NEW row
 * under one of these keys is part of that migration; a changed value is not.
 */
const MIGRATION_MARKER_KEYS: ReadonlySet<string> = new Set(['vector_storage_columns']);

/** Known DDL renames: a column the call renamed is compared under its new name. */
const RENAMED: Readonly<Record<string, string>> = { session_id: 'author_session_id' };

function changedTables(
  dbPath: string,
  before: Map<string, TableShape>,
  keysBefore: ReadonlySet<string>,
  schemaChanged: boolean
): string[] {
  // A marker key the call added is exempt, and only in a call that ran DDL; one that existed
  // before must read the same.
  const newMarkers = schemaChanged
    ? new Set([...MIGRATION_MARKER_KEYS].filter((key) => !keysBefore.has(key)))
    : new Set<string>();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const changed: string[] = [];
    for (const [table, shape] of before) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) {
        changed.push(`${table} (table gone)`);
        continue;
      }
      const now = new Set(
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      );
      // A rename maps a column only onto a name the table did not have before, so a dropped column
      // is never hidden behind one that already existed.
      const mapped = shape.columns.map((c) =>
        now.has(c) || !RENAMED[c] || shape.columns.includes(RENAMED[c]) ? c : RENAMED[c]
      );
      const lost = mapped.filter((c) => !now.has(c));
      if (lost.length > 0) {
        changed.push(`${table} (columns gone: ${lost.join(', ')})`);
        continue;
      }
      if (rowsOver(db, table, mapped, newMarkers) !== shape.rows) changed.push(table);
    }
    return changed;
  } finally {
    db.close();
  }
}

const JOURNAL = /-(wal|shm|journal)$/;

/** Files under a folder, by relative path, as content hashes; the store's own files excluded. */
function snapshotTree(root: string, exclude: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (!JOURNAL.test(rel) && !exclude(rel)) {
        out.set(rel, hash(fs.readFileSync(full).toString('base64')));
      }
    }
  };
  walk(root);
  return out;
}

function treeChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [rel, digest] of after) {
    if (!before.has(rel)) changes.push(`${rel} (new)`);
    else if (before.get(rel) !== digest) changes.push(`${rel} (changed)`);
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push(`${rel} (removed)`);
  return changes;
}

const GRAPH_FILE = 'project-graph.sqlite';

/** The registry's projects rows over every column but last_seen_at, which a review may touch (#906). */
function registryRows(configDir: string): string | null {
  const file = path.join(configDir, GRAPH_FILE);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const columns = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>)
      .map((c) => `"${c.name}"`)
      .filter((c) => c !== '"last_seen_at"');
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM projects ORDER BY project_id`).all();
    const isDefault = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_meta'")
      .get()
      ? db.prepare('SELECT * FROM registry_meta ORDER BY 1').all()
      : [];
    return hash(JSON.stringify({ rows, isDefault }));
  } finally {
    db.close();
  }
}

// ─── The stub dashboard ────────────────────────────────────────────────────────────────────────

let stub: http.Server;
let stubUrl = '';
const stubHits: string[] = [];

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    stubHits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/projects/me')) {
      // s96-m02: the dashboard's sprint-61 shape (H3), with the caller's identity, so a read that
      // kept it for author names would change the config folder and fail below.
      res.end(
        JSON.stringify({
          projects: [
            {
              id: STUB_PROJECT_ID,
              slug: 'reads-owner-less',
              name: 'reads-owner-less',
              owner: STUB_OWNER,
              rbookAddress: `rbook://${STUB_OWNER}/reads-owner-less`,
            },
          ],
          user: { id: 'user-reads', username: STUB_OWNER },
        })
      );
      return;
    }
    if (req.url?.startsWith('/api/projects/directory/public')) {
      // s96-m02: the directory answers, so its read reaches the /api/projects/me join above.
      res.end(JSON.stringify({ projects: [], totalCount: 0 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

// ─── Per-test environment ──────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'RBOOK_CONFIG_DIR',
  READ_ONLY_AGENT_ENV,
  'RBOOK_DASHBOARD_URL',
  'RBOOK_DASHBOARD_API_KEY',
  'RBOOK_PROJECT_ROOT',
] as const;
const savedEnv: Record<string, string | undefined> = {};
let tmp: string;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-reads-never-write-'));
  stubHits.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  CredentialStore.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Prepared {
  readonly kind: FixtureKind;
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly configDir: string;
  /** A registered sibling store that cross-project reads open. */
  readonly siblingDbPath: string;
}

/** Put a store in WAL, so a journal switch by the call cannot move data_version. */
function walMode(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } finally {
    db.close();
  }
}

/**
 * A fresh store and config directory. The config registers the store itself, a sibling store and a
 * store that no longer exists.
 */
async function prepare(kind: FixtureKind, label: string): Promise<Prepared> {
  const projectRoot = path.join(tmp, label, 'project');
  const siblingRoot = path.join(tmp, label, 'sibling');
  const configDir = path.join(tmp, label, 'config');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(siblingRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const dbPath = buildStore(kind, projectRoot);
  if (kind === 'search-drift' || kind === 'search-marker-other') {
    await buildSearchIndexes(kind, projectRoot, dbPath);
  }
  const siblingDbPath = seedRbookDb(siblingRoot, {
    projectName: 'reads-sibling',
    projectId: 'reads-sibling',
    owner: 'tester',
    rbookAddress: 'rbook://tester/reads-sibling',
  });
  const sibling = new Database(siblingDbPath);
  try {
    const now = new Date().toISOString();
    sibling
      .prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (1, 'A sibling storage decision.', ?, 'active')`
      )
      .run(now);
    sibling
      .prepare(
        `INSERT INTO learnings (id, content, category, created_at, status)
         VALUES (1, 'A sibling storage learning.', 'technical', ?, 'active')`
      )
      .run(now);
  } finally {
    sibling.close();
  }
  walMode(dbPath);
  walMode(siblingDbPath);

  process.env.RBOOK_CONFIG_DIR = configDir;
  delete process.env.RBOOK_PROJECT_ROOT;
  if (kind === 'owner-less') {
    process.env.RBOOK_DASHBOARD_URL = stubUrl;
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_reads_never_write_stub';
  } else {
    delete process.env.RBOOK_DASHBOARD_URL;
    delete process.env.RBOOK_DASHBOARD_API_KEY;
  }
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  CredentialStore.resetInstance();

  const graph = await ProjectGraphRegistry.create();
  graph.register({
    project_id: 'reads-vanished',
    store_path: path.join(tmp, label, 'vanished-project'),
    name: 'vanished',
  });
  graph.register({ project_id: `reads-${kind}`, store_path: projectRoot, name: `reads-${kind}` });
  graph.register({ project_id: 'reads-sibling', store_path: siblingRoot, name: 'reads-sibling' });
  ProjectGraphRegistry.resetInstance();
  return { kind, projectRoot, dbPath, configDir, siblingDbPath };
}

function setRole(role: (typeof ROLES)[number]): void {
  if (role === 'review') process.env[READ_ONLY_AGENT_ENV] = 'review';
  else delete process.env[READ_ONLY_AGENT_ENV];
}

interface Observed {
  readonly call: string;
  readonly tables: string[];
  /** Commits with no schema change, row writes into tables that existed, filled new tables. */
  readonly writes: string[];
  readonly sibling: string[];
  readonly config: string[];
  readonly projectFiles: string[];
  readonly dashboard: string[];
  readonly isError: boolean;
  readonly text: string;
}

/** The store's commit and schema counters, read from a connection held open across the call. */
function counters(watcher: Database.Database): { data: number; schema: number } {
  return {
    data: watcher.pragma('data_version', { simple: true }) as number,
    schema: watcher.pragma('schema_version', { simple: true }) as number,
  };
}

/** Every spelling of a store's path a connection may be opened with. */
function spellings(dbPath: string): Set<string> {
  return new Set([dbPath, path.resolve(dbPath), fs.realpathSync(dbPath)]);
}

interface CliRead {
  readonly argv: readonly string[];
  readonly input: Record<string, string>;
  readonly later?: boolean;
}
/** Exact per-invocation paths only: siblings, adjacent files and other sessions are still observed. */
function cliConfigExempt(prepared: Prepared, cli?: CliRead): (rel: string) => boolean {
  const allowed = new Set([GRAPH_FILE]);
  if (!cli) return (rel) => allowed.has(rel);
  const env = { RBOOK_CONFIG_DIR: prepared.configDir };
  const target = targetForStore(prepared.dbPath);
  if (target)
    allowed.add(
      path.join('telemetry', telemetryKey(target), `${new Date().toISOString().slice(0, 7)}.jsonl`)
    );
  if (cli.argv[0] === 'hook') {
    allowed.add(path.join('runtime', 'fail-open.jsonl'));
    const event = cli.argv[1];
    const rawId = cli.input.session_id;
    if (rawId && (event === 'session-start' || event === 'prompt'))
      allowed.add(path.relative(prepared.configDir, recallStatePath(rawId, env)));
    const key = hookRuntimeIdentity(cli.input, env);
    if (key) {
      if (event === 'session-start')
        allowed.add(path.relative(prepared.configDir, lifecyclePaths(key, env).baseline));
      if (event === 'pre-compact')
        allowed.add(path.relative(prepared.configDir, lifecyclePaths(key, env).compact));
      if (cli.input.prompt_id && (event === 'prompt' || event === 'stop'))
        allowed.add(path.relative(prepared.configDir, hookRuntimePath(key, env)));
    }
  }
  return (rel) => allowed.has(rel);
}

async function runRead(
  pair: string,
  args: Record<string, unknown>,
  prepared: Prepared,
  cli?: CliRead
): Promise<Observed> {
  const [tool, action] = pair.split(':');
  if (cli?.later)
    deliverFirstPrompt(
      {
        dbPath: prepared.dbPath,
        rawSessionId: cli.input.session_id,
        env: { RBOOK_CONFIG_DIR: prepared.configDir },
        // s102-m13: setup must establish the prior prompt before snapshots begin.
        // The former 1 s fixture limit expired under load; this is not a hook latency assertion.
        deadlineAtMs: Date.now() + 30_000,
      },
      () => ({ text: '', returnedIds: [], items: [] }),
      () => ''
    );
  const isStoreFile = (rel: string): boolean => rel === path.join('rbook', 'db', 'rbook.sqlite');
  const tablesBefore = snapshotTables(prepared.dbPath);
  const namesBefore = tableNames(prepared.dbPath);
  const keysBefore = metadataKeys(prepared.dbPath);
  const siblingBefore = snapshotTables(prepared.siblingDbPath);
  const treeBefore = snapshotTree(prepared.projectRoot, isStoreFile);
  // The helper also powers an adjacent-file positive control below.
  const configExempt = cliConfigExempt(prepared, cli);
  const configBefore = snapshotTree(prepared.configDir, configExempt);
  const registryBefore = registryRows(prepared.configDir);

  const callArgs: Record<string, unknown> = {
    ...(action ? { action } : {}),
    ...args,
    ...(PROJECT_FREE.has(pair) ? {} : { projectRoot: prepared.projectRoot }),
  };
  const watcher = new Database(prepared.dbPath, { readonly: true, fileMustExist: true });
  const countersBefore = counters(watcher);
  stubHits.length = 0;
  traced.length = 0;
  tracedFiles = new Set([...spellings(prepared.dbPath), ...spellings(prepared.siblingDbPath)]);
  let result: Awaited<ReturnType<typeof executeMissionProtocolTool>>;
  try {
    if (cli) {
      const output: string[] = [];
      const errors: string[] = [];
      const code = await runCli(cli.argv, {
        env: {
          ...process.env,
          CLAUDE_PID: '',
          CLAUDE_PROJECT_DIR: '',
          RBOOK_PROJECT_ROOT: '',
          RBOOK_AMBIENT: 'on',
        },
        cwd: prepared.projectRoot,
        // s98-m08 (#749): room load cannot spend (#1558). The prompt hook's 800 ms counts from this
        // call, and a loaded machine spent it before the read, which then answered isError.
        startedAtMs: Date.now() + 20_000,
        readStdin: async () => JSON.stringify(cli.input),
        stdout: (text) => {
          output.push(text);
        },
        stderr: (text) => {
          errors.push(text);
        },
      }).catch((error: unknown) => {
        // main() normalizes a thrown command refusal at the executable boundary. Model that
        // here so missing legacy schema still reaches every detector below rather than escaping
        // the oracle. A refusal is an observed result, never an exemption from checking writes.
        errors.push(
          oneLine(`reasonbook: ${error instanceof Error ? error.message : String(error)}`)
        );
        return cli.argv[0] === 'hook' ? 0 : 1;
      });
      result = {
        content: [{ type: 'text', text: output.join('') + errors.join('\n') }],
        isError: code !== 0 || errors.length > 0,
      };
    } else result = await executeMissionProtocolTool(tool, callArgs, context);
  } finally {
    tracedFiles = new Set();
  }
  const countersAfter = counters(watcher);
  watcher.close();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();

  const schemaChanged = countersAfter.schema !== countersBefore.schema;
  const writes: string[] = [];
  if (countersAfter.data !== countersBefore.data && !schemaChanged) {
    writes.push('a commit with no schema change');
  }
  const newMarkerKeys = schemaChanged
    ? [...MIGRATION_MARKER_KEYS].filter((key) => !keysBefore.has(key))
    : [];
  for (const write of traced) {
    const isNewMarker =
      write.target === 'metadata' && newMarkerKeys.some((key) => write.sql.includes(`'${key}'`));
    if (write.target === null || (namesBefore.has(write.target) && !isNewMarker)) {
      writes.push(`row write: ${write.sql}`);
    }
  }
  for (const table of filledNewTables(prepared.dbPath, namesBefore)) {
    writes.push(`new table filled: ${table}`);
  }
  const dashboard =
    prepared.kind === 'owner-less'
      ? stubHits.filter((hit) => !hit.startsWith('GET '))
      : [...stubHits];

  const config = treeChanges(configBefore, snapshotTree(prepared.configDir, configExempt));
  const registryAfter = registryRows(prepared.configDir);
  if (registryBefore !== null && registryAfter !== registryBefore) {
    config.push(`${GRAPH_FILE} (registry rows changed beyond last_seen_at)`);
  }
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .slice(0, 400);
  return {
    call: `${tool}(${JSON.stringify(callArgs).replace(prepared.projectRoot, '<root>')})`,
    tables: changedTables(prepared.dbPath, tablesBefore, keysBefore, schemaChanged),
    writes,
    sibling: changedTables(prepared.siblingDbPath, siblingBefore, new Set(), false),
    config,
    projectFiles: treeChanges(treeBefore, snapshotTree(prepared.projectRoot, isStoreFile)),
    dashboard,
    isError: result.isError === true,
    text,
  };
}

/** The read-classified calls that must answer, not refuse: every store read. */
const MUST_SUCCEED_ON_CURRENT_STORES = (pair: string): boolean =>
  !pair.startsWith('rbook_message:') && !pair.startsWith('rbook_auth:');

// ─── The census ────────────────────────────────────────────────────────────────────────────────

describe('s93-m11 — the read universe', () => {
  it('derives 28 read-classified pairs and has an argument set for each', () => {
    const pairs = readPairs();
    // s93-m11 promoted rbook_decisions review (the opener's remedy) from 25 to 26.
    // s96-m12: rbook_db conflicts, a read, makes 27; s96-m13's rbook_project members, 28.
    expect(pairs).toHaveLength(28);
    expect(pairs.filter((pair) => !(pair in ARGS))).toEqual([]);
    expect(Object.keys(ARGS).filter((pair) => !pairs.includes(pair))).toEqual([]);
  });
});

// CLI reads exercise the same three write detectors, including repair-prone and un-migrated
// fixtures. Only exact per-call external runtime and telemetry files are allowed above.
describe.each(ROLES)('s93-m05 — CLI reads never write (role %s)', (role) => {
  it.each(FIXTURES)(
    'leaves the %s record, sibling and project files unchanged',
    async (kind) => {
      const commands = [
        ['review', '--format=context'],
        ['relevant', '--query', 'storage decision'],
        ['hook', 'session-start', '--format', 'text'],
        ['hook', 'prompt', '--format', 'text'],
        ['hook', 'prompt', '--format', 'text'],
        ['hook', 'pre-compact'],
      ];
      for (const [index, argv] of commands.entries()) {
        const prepared = await prepare(kind, `cli-${role}-${kind}-${index}`);
        setRole(role);
        const observed = await runRead(`cli:${argv.join(' ')}`, {}, prepared, {
          argv,
          later: index === 4,
          input: {
            session_id: 'oracle-session',
            cwd: prepared.projectRoot,
            prompt_id: 'oracle-turn',
            prompt: 'Explain why SQLite storage keeps this record small and local',
            source: 'startup',
          },
        });
        expect({
          tables: observed.tables,
          writes: observed.writes,
          sibling: observed.sibling,
          config: observed.config,
          projectFiles: observed.projectFiles,
          dashboard: observed.dashboard,
        }).toEqual({
          tables: [],
          writes: [],
          sibling: [],
          config: [],
          projectFiles: [],
          dashboard: [],
        });
        // Broken-index fixtures must actually recall: an empty/refused read proves no useful path.
        if ((kind === 'search-drift' || kind === 'search-marker-other') && argv[1] === 'prompt') {
          // s98-m08 (#749): a refused read prints its whole answer.
          expect({
            isError: observed.isError,
            text: observed.isError ? observed.text : '',
          }).toEqual({ isError: false, text: '' });
          expect(observed.text).toContain('  • d:');
        }
        if (kind !== 'unmigrated' && argv[0] !== 'hook') expect(observed.isError).toBe(false);
        if (kind === 'unmigrated' && (argv[0] === 'review' || argv[1] === 'session-start')) {
          expect(observed.isError).toBe(true);
          expect(observed.text).toContain('next_steps table is absent');
          expect(observed.text).toMatch(/^reasonbook(?: hook session-start)?: /);
        }
      }
    },
    180_000
  );
});

// ─── Positive controls: each precondition enables a real write on a write path ─────────────────

describe('s93-m11 — the fixtures make the old writes possible (positive controls)', () => {
  it('runtime exemptions still catch adjacent files and another session marker', async () => {
    const prepared = await prepare('flaggable', 'control-cli-runtime');
    const cli = {
      argv: ['hook', 'session-start'],
      input: { session_id: 'oracle-session', cwd: prepared.projectRoot },
    };
    const env = { RBOOK_CONFIG_DIR: prepared.configDir };
    const own = lifecyclePaths(hookRuntimeIdentity(cli.input, env)!, env).baseline;
    const other = lifecyclePaths(
      hookRuntimeIdentity({ ...cli.input, session_id: 'other-session' }, env)!,
      env
    ).baseline;
    const excluded = cliConfigExempt(prepared, cli);
    const before = snapshotTree(prepared.configDir, excluded);
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'owned runtime');
    fs.writeFileSync(`${own}.adjacent`, 'unowned');
    fs.writeFileSync(other, 'another session');
    expect(treeChanges(before, snapshotTree(prepared.configDir, excluded)).sort()).toEqual(
      [
        `${path.relative(prepared.configDir, own)}.adjacent (new)`,
        `${path.relative(prepared.configDir, other)} (new)`,
      ].sort()
    );
  });

  it('flaggable: the decision and learning are 29 sprints old, unreviewed and without evidence', async () => {
    const prepared = await prepare('flaggable', 'control-flaggable');
    const db = new Database(prepared.dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT status, sprint_id, evidence FROM strategic_decisions WHERE id = 1')
        .get() as { status: string; sprint_id: string; evidence: string | null };
      expect(row).toEqual({ status: 'active', sprint_id: `sprint-${OLD_SPRINT}`, evidence: null });
      const open = db.prepare("SELECT id FROM sprints WHERE status = 'Active'").get() as {
        id: string;
      };
      // The old flagger's cutoff: the open sprint minus the 20-sprint threshold.
      expect(OPEN_SPRINT - 20).toBeGreaterThanOrEqual(OLD_SPRINT);
      expect(open.id).toBe(`sprint-${OPEN_SPRINT}`);
    } finally {
      db.close();
    }
  });

  it('unknown-address: the write path heals the address the read must leave alone', async () => {
    const prepared = await prepare('unknown-address', 'control-heal');
    const healed = await validateProject(prepared.projectRoot, { heal: true });
    expect(healed.healed?.next).toBe('rbook://tester/reads-unknown-address');
  });

  it('owner-less: owner resolution against the stub writes metadata.owner', async () => {
    const prepared = await prepare('owner-less', 'control-owner');
    const resolved = await withClientAsync(
      async (client) => createSuccess(await resolveAndPersistOwner(client)),
      { projectRoot: prepared.projectRoot, registerProject: false }
    );
    expect(resolved.data?.owner).toBe(STUB_OWNER);
    const db = new Database(prepared.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'owner'").get()).toEqual({
        value: STUB_OWNER,
      });
    } finally {
      db.close();
    }
  });

  it('unmigrated: a write path seeds the identity row and migrates the blob the read must leave alone', async () => {
    const prepared = await prepare('unmigrated', 'control-unmigrated');
    const { ensureProjectIdentityRow } = await import('../../../src/tools/rbook/project-identity');
    const { applyPendingBlobMigrations } = await import('../../../src/tools/rbook/blob-migrations');
    const outcome = await withClientAsync(
      async (client) => {
        const seeded = ensureProjectIdentityRow(client);
        const raw = client.getOne<{ content: string }>(
          "SELECT content FROM contexts WHERE id = 'master_context'"
        ).data!.content;
        const migrated = applyPendingBlobMigrations(client, 'master_context', raw, JSON.parse(raw));
        return createSuccess({
          seeded: seeded.rowsUpdated,
          rewritten: migrated.rewritten,
          warnings: migrated.warnings,
          stored: JSON.parse(
            client.getOne<{ content: string }>(
              "SELECT content FROM contexts WHERE id = 'master_context'"
            ).data!.content
          ),
          version: client.getOne<{ value: string }>(
            "SELECT value FROM metadata WHERE key = 'blob_schema_version'"
          ).data?.value,
        });
      },
      { projectRoot: prepared.projectRoot, registerProject: false }
    );
    expect(outcome.data).toEqual({
      seeded: 1,
      rewritten: true,
      warnings: [
        expect.stringMatching(
          /context_snapshots pre-migration snapshot.*failed:.*missing project_id/
        ),
      ],
      stored: { project: { name: 'reads-unmigrated' } },
      version: '1',
    });
  });

  it('search-drift: a write path rebuilds the decisions index and writes the missing marker', async () => {
    const prepared = await prepare('search-drift', 'control-search-drift');
    const [indexed, total] = indexCounts(prepared.dbPath, 'decisions_fts', 'strategic_decisions');
    expect(indexed).toBe(total - 1);
    expect(metadataKeys(prepared.dbPath).has('vector_storage_columns')).toBe(false);
    await withClientAsync(
      async (client) => createSuccess((ensureDecisionsFts5(client), ensureVectorStorage(client))),
      { projectRoot: prepared.projectRoot, registerProject: false }
    );
    expect(indexCounts(prepared.dbPath, 'decisions_fts', 'strategic_decisions')).toEqual([
      total,
      total,
    ]);
    expect(metadataKeys(prepared.dbPath).has('vector_storage_columns')).toBe(true);
  });

  it('search-marker-other: a write path replaces the older marker and rebuilds the learnings index', async () => {
    const prepared = await prepare('search-marker-other', 'control-search-marker');
    const [indexed, total] = indexCounts(prepared.dbPath, 'learnings_fts', 'learnings');
    expect(indexed).toBe(total - 1);
    await withClientAsync(async (client) => createSuccess(ensureVectorStorage(client)), {
      projectRoot: prepared.projectRoot,
      registerProject: false,
    });
    expect(indexCounts(prepared.dbPath, 'learnings_fts', 'learnings')).toEqual([total, total]);
    const db = new Database(prepared.dbPath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT value FROM metadata WHERE key = 'vector_storage_columns'").get()
      ).toEqual({ value: VECTOR_STORAGE_SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });

  it('every config directory holds a registry row a prune would archive', async () => {
    const prepared = await prepare('flaggable', 'control-prune');
    const graph = await ProjectGraphRegistry.create();
    expect(graph.list().map((row) => row.project_id)).toContain('reads-vanished');
    expect(graph.pruneMissingStores()).toBeGreaterThanOrEqual(1);
    expect(graph.list().map((row) => row.project_id)).not.toContain('reads-vanished');
    expect(prepared.configDir).toBeTruthy();
  });
});

// ─── The oracle ────────────────────────────────────────────────────────────────────────────────

describe.each(ROLES)('s93-m11 — reads never write (RBOOK_AGENT_ROLE %s)', (role) => {
  it.each(FIXTURES)(
    'every read pair leaves the %s store, config and project folder unchanged',
    async (kind) => {
      const violations: string[] = [];
      const refusals: string[] = [];
      let index = 0;
      for (const pair of readPairs()) {
        for (const args of ARGS[pair]) {
          const prepared = await prepare(kind, `${role}-${kind}-${index++}`);
          setRole(role);
          const observed = await runRead(pair, args, prepared);
          const what = [
            ...observed.tables.map((t) => `table ${t}`),
            ...observed.writes,
            ...observed.sibling.map((t) => `sibling table ${t}`),
            ...observed.config.map((c) => `config ${c}`),
            ...observed.projectFiles.map((f) => `project file ${f}`),
            ...observed.dashboard.map((hit) => `dashboard ${hit}`),
          ];
          if (what.length > 0) violations.push(`${observed.call}: ${what.join('; ')}`);
          if (
            kind !== 'unmigrated' &&
            observed.isError &&
            MUST_SUCCEED_ON_CURRENT_STORES(pair) &&
            !(pair === 'rbook_project:list' && args.prune === true)
          ) {
            refusals.push(`${observed.call}: ${observed.text}`);
          }
        }
      }
      expect(violations).toEqual([]);
      // A refused read proves nothing about writes; the store reads must actually answer.
      expect(refusals).toEqual([]);
    },
    // Each case runs every read pair (28, with its argument sets) on a fresh fixture and diffs the
    // store, config and project folder after each: 5-17 s alone at load 22, past jest's 30 s
    // default under a full parallel run on a loaded machine. The bound is generous, not a hiding
    // place: a read that hangs still fails.
    180_000
  );
});

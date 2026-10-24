// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — the signals on stores that are not today's: a 3.0.0 layout reports each absent input unavailable,
// ABOUTME: never zero; a writer holding the WAL does not stop or leak into a read; an unreadable store is reported, not thrown.

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import {
  computeSignals,
  readSignals,
  SIGNAL_KINDS,
  SIGNAL_RULES,
  SIGNAL_RULES_AGE_ONLY,
  type SignalEntry,
  type SignalsReport,
} from '../../src/signals';
import { ensureProposalsTable, insertDraft, rawRunner } from '../../src/tools/rbook/proposals';

const DAY = 86_400_000;
const NOW = Date.now() - 45 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function signal(report: SignalsReport, kind: SignalEntry['kind']): SignalEntry {
  return report.signals.find((entry) => entry.kind === kind)!;
}

/** A store laid out as 3.0.0 made it: its seed schema, verbatim from tag v3.0.0. */
function store300(): string {
  const dbPath = path.join(tmp('rbook-signals-300-'), 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(
    fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'old-schemas', 'schema-3.0.0.sql'),
      'utf8'
    )
  );
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'old-store')"
  ).run();
  // The context rows init wrote at 3.0.0, which a decision's context_id references.
  const context = db.prepare(
    "INSERT INTO contexts (id, source_path, content) VALUES (?, '', '{}')"
  );
  for (const id of ['master_context', 'project_context']) context.run(id);
  db.close();
  return dbPath;
}

describe('the signals on stores that are not today’s (s97-m01)', () => {
  it('reports each input a 3.0.0 store lacks as unavailable, with its reason, and reads the rest', () => {
    const report = readSignals(store300(), { now: NOW });
    const absent: Record<string, RegExp> = {
      drafts_pending: /no proposals table/,
      feedback_open: /no feedback yet/,
      shared_conflicts: /no record_conflicts table/,
    };
    for (const kind of SIGNAL_KINDS) {
      const entry = signal(report, kind);
      if (absent[kind]) {
        expect(entry).toMatchObject({ available: false, count: null, ids: [] });
        expect(entry.reason).toMatch(absent[kind]);
      } else if (kind === 'quiet_days') {
        // An empty 3.0.0 store has its stamps but no row yet: unknown, not zero days.
        expect(entry).toMatchObject({ available: false, count: null });
        expect(entry.reason).toMatch(/no row stamped/);
      } else {
        expect(entry).toMatchObject({ available: true, count: 0 });
      }
    }
    // No feedback table: the window's kinds are unknown, never a row of zeros.
    expect(report.feedbackKinds).toMatchObject({
      available: false,
      counts: null,
      unclassified: null,
    });
    expect(report.project.id).toBe('old-store');
  });

  it('reads a 3.0.0 store’s citations by the typed fallback, and says so', () => {
    const dbPath = store300();
    const db = new Database(dbPath);
    const insert = db.prepare(
      'INSERT INTO strategic_decisions (decision_text, created_at, status, superseded_by) VALUES (?, ?, ?, ?)'
    );
    insert.run('The old way.', iso(NOW - 10 * DAY), 'active', null);
    insert.run('The new way supersedes d:1.', iso(NOW - 9 * DAY), 'active', null);
    insert.run('This still follows d:1.', iso(NOW - 8 * DAY), 'active', null);
    db.prepare(
      "UPDATE strategic_decisions SET status = 'superseded', superseded_by = 2 WHERE id = 1"
    ).run();
    db.close();
    const entry = signal(readSignals(dbPath, { now: NOW }), 'superseded_cited');
    expect(entry).toMatchObject({ available: true, count: 1, ids: ['d:3'] });
    expect(entry.reason).toMatch(/typed citations only/);
  });

  it('reports a store with none of the inputs as nine unavailable signals, never nine zeros', () => {
    const dbPath = path.join(tmp('rbook-signals-bare-'), 'bare.sqlite');
    new Database(dbPath).close();
    const report = readSignals(dbPath, { now: NOW });
    expect(report.signals.every((entry) => !entry.available && entry.count === null)).toBe(true);
    expect(report.window.counts).toEqual({
      decisions: null,
      learnings: null,
      missionsCompleted: null,
      sprintsClosed: null,
    });
    expect(report.project.id).toBe('unknown-project');
  });

  it('reports a store it cannot open, signal by signal, instead of throwing', () => {
    const report = readSignals(path.join(tmp('rbook-signals-none-'), 'absent.sqlite'), {
      now: NOW,
    });
    expect(report.signals).toHaveLength(SIGNAL_KINDS.length);
    for (const entry of report.signals) {
      expect(entry).toMatchObject({ available: false, count: null, failed: true });
      expect(entry.reason).toMatch(/store unreadable/);
    }
    expect(report.window.reason).toMatch(/store unreadable/);
    expect(report.feedbackKinds).toMatchObject({ counts: null, unclassified: null });
    // Said at the top, so a reader keeps its last good report rather than this one.
    expect(report.unreadable).toMatch(/^store unreadable/);
    expect(report.rules).toBe(SIGNAL_RULES_AGE_ONLY);
    const withRuntime = readSignals(path.join(tmp('rbook-signals-none-'), 'absent.sqlite'), {
      now: NOW,
      draftRuntimeDir: tmp('rbook-signals-runtime-'),
    });
    expect(withRuntime.rules).toBe(SIGNAL_RULES);
    expect(readSignals(store300(), { now: NOW }).unreadable).toBeUndefined();
  });

  it('keeps every signal that does not read a table whose pages are damaged', async () => {
    const dbPath = path.join(tmp('rbook-signals-corrupt-'), 'rbook.sqlite');
    const db = new Database(dbPath);
    db.exec(
      fs.readFileSync(
        path.join(__dirname, '..', 'fixtures', 'old-schemas', 'schema-3.0.0.sql'),
        'utf8'
      )
    );
    db.exec("INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'corrupt')");
    db.prepare(
      "INSERT INTO constraints (content, created_at, status, expires_at) VALUES ('Soon.', ?, 'active', ?)"
    ).run(iso(NOW - DAY), iso(NOW + DAY));
    db.prepare(
      "INSERT INTO missions (id, name, status) VALUES ('m-b', 'Waiting', 'Blocked')"
    ).run();
    const { rootpage } = db
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'constraints'")
      .get() as { rootpage: number };
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    db.close();
    // Overwrite the constraints table's root page, as a disk fault would.
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (rootpage - 1) * pageSize);
    fs.closeSync(fd);
    const report = readSignals(dbPath, { now: NOW });
    expect(signal(report, 'constraints_expiring')).toMatchObject({
      available: false,
      failed: true,
    });
    // The citation reader reads constraints too, so its signal fails, and says so.
    expect(signal(report, 'superseded_cited')).toMatchObject({ available: false, failed: true });
    expect(signal(report, 'missions_blocked')).toMatchObject({ available: true, count: 1 });
    expect(report.project.id).toBe('corrupt');
  });

  it('reads the store as one snapshot, so a commit made while the rules run reaches none of them', () => {
    const dbPath = path.join(tmp('rbook-signals-snapshot-'), 'rbook.sqlite');
    const setup = new Database(dbPath);
    setup.pragma('journal_mode = WAL');
    setup.exec(
      fs.readFileSync(
        path.join(__dirname, '..', 'fixtures', 'old-schemas', 'schema-3.0.0.sql'),
        'utf8'
      )
    );
    setup.prepare("INSERT INTO missions (id, name, status) VALUES ('m-1', 'One', 'Blocked')").run();
    setup.close();
    const reader = new Database(dbPath, { readonly: true });
    const writer = new Database(dbPath);
    let committed = false;
    // When the drafts rule prepares its read, another connection commits a second block; the
    // blocked missions are read after it, in the same snapshot as everything before.
    const watched = new Proxy(reader, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (!committed && /FROM proposals|PRAGMA table_info\(proposals\)/.test(sql)) {
              committed = true;
              writer
                .prepare("INSERT INTO missions (id, name, status) VALUES ('m-2', 'Two', 'Blocked')")
                .run();
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;
    try {
      const during = computeSignals(watched, { storePath: dbPath, now: NOW });
      expect(committed).toBe(true);
      expect(signal(during, 'missions_blocked').count).toBe(1);
      expect(signal(readSignals(dbPath, { now: NOW }), 'missions_blocked').count).toBe(2);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('reports a store another connection holds locked as busy, after its wait', () => {
    const dbPath = path.join(tmp('rbook-signals-busy-'), 'rbook.sqlite');
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('project_id', 'busy')"
    );
    // A rollback-journal store under an exclusive lock refuses every reader until it commits.
    db.exec('BEGIN EXCLUSIVE');
    db.exec("INSERT INTO metadata VALUES ('project_name', 'Busy')");
    try {
      const report = readSignals(dbPath, { now: NOW });
      for (const entry of report.signals) {
        expect(entry).toMatchObject({ available: false, failed: true });
        expect(entry.reason).toMatch(/^store busy/);
      }
    } finally {
      db.exec('COMMIT');
      db.close();
    }
    expect(readSignals(dbPath, { now: NOW }).project).toEqual({ id: 'busy', name: 'Busy' });
  });

  it('documents the rollback snapshot lock: a 250 ms writer can fail during the report', () => {
    const dbPath = store300();
    const reader = new Database(dbPath, { readonly: true });
    const writer = new Database(dbPath, { timeout: 250 });
    let attempted = false;
    const watched = new Proxy(reader, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (!attempted && /PRAGMA table_info\(proposals\)/.test(sql)) {
              attempted = true;
              // Metadata has already anchored the report's read snapshot.
              expect(() =>
                writer.prepare("INSERT INTO metadata VALUES ('during-report', 'x')").run()
              ).toThrow(/locked/);
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;
    try {
      expect(computeSignals(watched, { now: NOW, storePath: dbPath }).project.id).toBe('old-store');
      expect(attempted).toBe(true);
      expect(() =>
        writer.prepare("INSERT INTO metadata VALUES ('after-report', 'x')").run()
      ).not.toThrow();
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('allows SQLite WAL sidecars while preserving the store bytes, mtime and journal mode', () => {
    const dbPath = store300();
    const setup = new Database(dbPath);
    setup.pragma('journal_mode = WAL');
    setup.close();
    const hash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = { hash: hash(), mtime: fs.statSync(dbPath).mtimeMs };
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(readSignals(dbPath, { now: NOW }).project.id).toBe('old-store');
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
    expect({ hash: hash(), mtime: fs.statSync(dbPath).mtimeMs }).toEqual(before);
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      check.close();
    }
  });

  it('refuses a now or a window it cannot read: the caller’s error, not the store’s', () => {
    const dbPath = store300();
    expect(() => readSignals(dbPath, { now: 'not a time' })).toThrow(RangeError);
    expect(() => readSignals(dbPath, { now: NOW, windowDays: 0 })).toThrow(RangeError);
  });

  it('reads while another connection holds the WAL, and never sees its uncommitted rows', () => {
    const dbPath = path.join(tmp('rbook-signals-wal-'), 'rbook.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(
      "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('project_id', 'wal')"
    );
    const run = rawRunner(db);
    ensureProposalsTable(run);
    const draft = (text: string) =>
      insertDraft(run, {
        text,
        kind: 'decision',
        sourceSession: null,
        assistantExcerpt: null,
        evidence: [],
        outsideContent: null,
        createdAt: iso(NOW - DAY),
      });
    draft('Committed before the read.');
    const writer = new Database(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    rawRunner(writer).run(
      "INSERT INTO proposals (text, kind, created_at) VALUES ('Not committed yet.', 'decision', ?)",
      [iso(NOW - DAY)]
    );
    try {
      expect(signal(readSignals(dbPath, { now: NOW }), 'drafts_pending').count).toBe(1);
    } finally {
      writer.exec('COMMIT');
      writer.close();
    }
    expect(signal(readSignals(dbPath, { now: NOW }), 'drafts_pending').count).toBe(2);
    db.close();
  });

  it('counts an unreadable lease anchor apart, as undated, and not as lapsing', () => {
    const dbPath = store300();
    const db = new Database(dbPath);
    const close = db.prepare(
      "INSERT INTO sprints (id, title, status, end_date) VALUES (?, 'Closed', 'Completed', ?)"
    );
    for (const [i, days] of [30, 20, 10].entries()) close.run(`s${i}`, iso(NOW - days * DAY));
    const step = db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES (?, 'pending', ?)"
    );
    step.run('Old enough.', iso(NOW - 40 * DAY));
    step.run('No readable time.', 'sometime');
    db.close();
    expect(signal(readSignals(dbPath, { now: NOW }), 'next_steps_lapsing')).toMatchObject({
      count: 1,
      undated: 1,
    });
  });
});

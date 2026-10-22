// ABOUTME: Verifies sprint-close receipts against real private stores at the close boundary.
// ABOUTME: Covers session visibility, capture counts, rollback and producing-build telemetry.
/**
 * RED contracts for the sprint-close audit receipt introduced by s88-m04.
 *
 * These tests intentionally exercise the production close handler against private,
 * full-schema stores. They do not reproduce the close query or capture-counting logic.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import {
  initServerHealth,
  resetServerHealth,
  type BuildManifest,
} from '../../../src/server-health';
import {
  rbookSprintComplete,
  formatSprintCompleteForLLM,
  type RbookSprintCompleteResult,
} from '../../../src/tools/rbook/rbook-sprint-complete';
import { RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';
import { computeContentHash } from '../../../src/tools/rbook/schema-migrations';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

interface ActiveSessionAtClose {
  id: string;
  title: string;
  captureCount: number | null;
  deferredCaptureCount: number | null;
}

type AuditableSprintCloseResult = RbookSprintCompleteResult & {
  activeSessionsAtClose: ActiveSessionAtClose[];
  implicitSessionsAtClose: ActiveSessionAtClose[];
  startupBuildTime: string | null;
  driftMinutes: number | null;
};

const CLOSING_SPRINT_ID = 'sprint-audit';
const OTHER_SPRINT_ID = 'sprint-other';
const STARTUP_BUILD_TIME = '2026-08-28T12:00:00.000Z';

describe('rbook_sprint_complete auditable close receipt', () => {
  let projectRoot: string;
  let dbPath: string;
  let extraTempRoots: string[];
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sprint-close-audit-'));
    extraTempRoots = [];
    dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.exec(RBOOK_SCHEMA);
    db.prepare(
      `INSERT INTO metadata (key, value) VALUES
       ('project_id', 'sprint-close-audit-fixture'),
       ('project_name', 'Sprint Close Audit Fixture'),
       ('project_type', 'build')`
    ).run();
    db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date)
       VALUES (?, 'Audit sprint', 'Close receipt', 'Active', '2026-08-28')`
    ).run(CLOSING_SPRINT_ID);
    db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date)
       VALUES (?, 'Other sprint', 'Membership negative', 'Active', '2026-08-28')`
    ).run(OTHER_SPRINT_ID);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, completed_at)
       VALUES ('s-audit-m01', ?, 'Completed audit mission', 'Completed', '2026-08-28T12:00:00.000Z')`
    ).run(CLOSING_SPRINT_ID);
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at) VALUES
       ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-08-28T12:00:00.000Z'),
       ('project_context', 'context/PROJECT_CONTEXT.json', '{}', '2026-08-28T12:00:00.000Z')`
    ).run();
    db.close();

    RbookDetector.resetInstance();
    resetServerHealth();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    resetServerHealth();
    RbookDetector.resetInstance();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    for (const root of extraTempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function desiredData(
    result: RbookToolResult<RbookSprintCompleteResult>
  ): AuditableSprintCloseResult {
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    return result.data as AuditableSprintCloseResult;
  }

  async function closeSprint(): Promise<RbookToolResult<RbookSprintCompleteResult>> {
    return rbookSprintComplete({
      sprintId: CLOSING_SPRINT_ID,
      summary: 'Closed with an auditable receipt',
      projectRoot,
    });
  }

  function seedSession(params: {
    id: string;
    title: string;
    sprintId: string | null;
    status: 'active' | 'completed';
    captures?: string;
    implicit?: number;
    ownerKey?: string;
  }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO sessions
         (id, type, title, sprint_id, started_at, completed_at, status, captures, implicit, owner_key)
       VALUES (?, 'build', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.title,
      params.sprintId,
      new Date(Date.now() - 60_000).toISOString(),
      params.status === 'completed' ? new Date().toISOString() : null,
      params.status,
      params.captures ?? '[]',
      params.implicit ?? 0,
      params.ownerKey ?? null
    );
    db.close();
  }

  function writeManifest(root: string, manifest: BuildManifest): void {
    const distDir = path.join(root, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, '.build-manifest.json'),
      `${JSON.stringify(manifest)}\n`,
      'utf8'
    );
  }

  function manifest(buildHash: string, buildTime: string): BuildManifest {
    return { buildHash, buildTime, fileCount: 17 };
  }

  describe('activeSessionsAtClose', () => {
    it('uses exact direct sprint membership and reports total/deferred counts for mixed captures', async () => {
      const mixedCaptures = JSON.stringify(
        ['decision', 'learning', 'constraint', 'context', 'next-step'].map((category, index) => ({
          timestamp: `2026-08-28T12:0${index}:00.000Z`,
          category,
          content: `${category} capture`,
        }))
      );

      seedSession({
        id: 'S-DIRECT',
        title: 'Direct active session',
        sprintId: CLOSING_SPRINT_ID,
        status: 'active',
        captures: mixedCaptures,
      });
      seedSession({
        id: 'S-COMPLETED',
        title: 'Completed same-sprint session',
        sprintId: CLOSING_SPRINT_ID,
        status: 'completed',
      });
      seedSession({
        id: 'S-OTHER',
        title: 'Active other-sprint session',
        sprintId: OTHER_SPRINT_ID,
        status: 'active',
      });
      seedSession({
        id: 'S-NULL',
        title: 'Active unscoped session',
        sprintId: null,
        status: 'active',
      });
      seedSession({
        id: 'S-MISSION-LINKED',
        title: 'Mission-linked but not sprint-scoped',
        sprintId: null,
        status: 'active',
      });

      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO session_missions (session_id, mission_id, linked_at, source)
         VALUES ('S-MISSION-LINKED', 's-audit-m01', '2026-08-28T12:10:00.000Z', 'capture')`
      ).run();
      db.close();

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.activeSessionsAtClose).toStrictEqual([
        {
          id: 'S-DIRECT',
          title: 'Direct active session',
          captureCount: 5,
          deferredCaptureCount: 2,
        },
      ]);

      const rendered = formatSprintCompleteForLLM(result);
      expect(rendered).toMatch(/Active sessions at close:/i);
      expect(rendered).toMatch(/S-DIRECT.*5.*2/i);
      expect(rendered).not.toMatch(/S-COMPLETED|S-OTHER|S-NULL|S-MISSION-LINKED/);
    });

    // s100-m03 (#712): a next step captured since 4.2.1 is a row from its capture, so it is not work
    // the running session still holds back. One captured before 4.2.1 has no row and still is.
    it('counts a next-step capture as deferred only while it has no row', async () => {
      const captures = ['written at capture', 'captured before 4.2.1'].map((content, index) => ({
        timestamp: `2026-08-28T12:0${index}:00.000Z`,
        category: 'next-step',
        content,
      }));
      seedSession({
        id: 'S-ROWS',
        title: 'Running session with next steps',
        sprintId: CLOSING_SPRINT_ID,
        status: 'active',
        captures: JSON.stringify([
          ...captures,
          { timestamp: '2026-08-28T12:05:00.000Z', category: 'context', content: 'a note' },
        ]),
      });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO next_steps (content, status, session_id, created_at, content_hash)
         VALUES (?, 'pending', 'S-ROWS', '2026-08-28T12:00:00.000Z', ?)`
      ).run('written at capture', computeContentHash('written at capture', 'next-step'));
      db.close();

      const data = desiredData(await closeSprint());
      expect(data.activeSessionsAtClose).toStrictEqual([
        {
          id: 'S-ROWS',
          title: 'Running session with next steps',
          captureCount: 3,
          deferredCaptureCount: 2,
        },
      ]);
    });

    it('renders an explicit none when no direct active session remains', async () => {
      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.activeSessionsAtClose).toStrictEqual([]);
      expect(formatSprintCompleteForLLM(result)).toMatch(/Active sessions at close:\s*none/i);
    });

    it('keeps a malformed capture receipt visible with null counts and a named warning', async () => {
      seedSession({
        id: 'S-MALFORMED',
        title: 'Malformed captures session',
        sprintId: CLOSING_SPRINT_ID,
        status: 'active',
        captures: '{not-json',
      });

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.activeSessionsAtClose).toStrictEqual([
        {
          id: 'S-MALFORMED',
          title: 'Malformed captures session',
          captureCount: null,
          deferredCaptureCount: null,
        },
      ]);
      expect((result.warnings ?? []).join('\n')).toMatch(
        /S-MALFORMED.*(?:malformed|invalid).*captures.*JSON/i
      );
      expect(formatSprintCompleteForLLM(result)).toMatch(/S-MALFORMED.*(?:unknown|unavailable)/i);
    });

    it('fails and rolls back when the active-session receipt query cannot run', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TABLE session_missions; DROP TABLE sessions;');
      db.close();

      const result = await closeSprint();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DB_QUERY_FAILED');

      const verificationDb = new Database(dbPath, { readonly: true });
      const sprint = verificationDb
        .prepare('SELECT status, end_date FROM sprints WHERE id = ?')
        .get(CLOSING_SPRINT_ID) as { status: string; end_date: string | null };
      verificationDb.close();
      expect(sprint).toEqual({ status: 'Active', end_date: null });
    });
  });

  describe('implicitSessionsAtClose', () => {
    it('holds the close write lock while reading implicit sessions', async () => {
      seedSession({
        id: 'I-LOCK',
        title: 'Concurrent work',
        sprintId: null,
        status: 'active',
        implicit: 1,
      });
      const original = RbookDatabaseClient.prototype.getMany;
      let competingWrite = '';
      const spy = jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function (
        this: RbookDatabaseClient,
        sql,
        params
      ) {
        if (sql.includes('implicit = 1')) {
          competingWrite = execFileSync(
            process.execPath,
            [
              '-e',
              `
            const Database = require(process.argv[1]);
            const db = new Database(process.argv[2], { timeout: 0 });
            try {
              db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'I-LOCK'").run();
              process.stdout.write('wrote');
            } catch (error) { process.stdout.write(error.code); }
            finally { db.close(); }
          `,
              require.resolve('better-sqlite3'),
              dbPath,
            ],
            { encoding: 'utf8' }
          );
        }
        return original.call(this, sql, params);
      });
      let result;
      try {
        result = await closeSprint();
      } finally {
        spy.mockRestore();
      }
      expect(competingWrite).toBe('SQLITE_BUSY');
      expect(desiredData(result).implicitSessionsAtClose.map((session) => session.id)).toEqual([
        'I-LOCK',
      ]);
    });

    it('reports all active implicit owners through dispatch without claiming sprint membership or closing them', async () => {
      for (const [id, implicit, status] of [
        ['I-ONE', 1, 'active'],
        ['I-TWO', 1, 'active'],
        ['I-CLOSED', 1, 'completed'],
        ['EXPLICIT', 0, 'active'],
      ] as const) {
        seedSession({ id, title: id, sprintId: null, status, implicit, ownerKey: id });
      }
      const result = await rbookSprint({
        action: 'complete',
        sprintId: CLOSING_SPRINT_ID,
        summary: 'Keep concurrent work visible',
        projectRoot,
      });
      const data = desiredData(result as RbookToolResult<RbookSprintCompleteResult>);
      expect(data.activeSessionsAtClose).toEqual([]);
      expect(data.implicitSessionsAtClose).toEqual(
        ['I-ONE', 'I-TWO'].map((id) => ({
          id,
          title: id,
          captureCount: 0,
          deferredCaptureCount: 0,
        }))
      );
      const rendered = formatSprintCompleteForLLM(
        result as RbookToolResult<RbookSprintCompleteResult>
      );
      expect(rendered).toMatch(/Implicit sessions at close: 2/);
      expect(rendered).toContain('I-ONE');
      expect(rendered).toContain('I-TWO');
      expect(rendered).not.toMatch(/I-CLOSED|EXPLICIT/);
      const db = new Database(dbPath, { readonly: true });
      expect(
        db.prepare("SELECT id FROM sessions WHERE status = 'active' ORDER BY id").all()
      ).toEqual([{ id: 'EXPLICIT' }, { id: 'I-ONE' }, { id: 'I-TWO' }]);
      db.close();
    });

    it('retains implicit capture counts and makes malformed captures visible', async () => {
      seedSession({
        id: 'I-COUNTS',
        title: 'Implicit captures',
        sprintId: null,
        status: 'active',
        implicit: 1,
        captures: JSON.stringify(
          ['decision', 'context', 'next-step'].map((category) => ({
            category,
            timestamp: new Date().toISOString(),
            content: `${category} pending`,
          }))
        ),
      });
      seedSession({
        id: 'I-BAD',
        title: 'Bad captures',
        sprintId: null,
        status: 'active',
        implicit: 1,
        captures: '{bad',
      });
      const result = await closeSprint();
      expect(desiredData(result).implicitSessionsAtClose).toEqual(
        expect.arrayContaining([
          { id: 'I-COUNTS', title: 'Implicit captures', captureCount: 3, deferredCaptureCount: 2 },
          { id: 'I-BAD', title: 'Bad captures', captureCount: null, deferredCaptureCount: null },
        ])
      );
      expect(result.warnings?.join('\n')).toMatch(/I-BAD.*malformed/);
    });

    it('supports a legacy store with no implicit column without migrating it', async () => {
      const db = new Database(dbPath);
      db.exec('ALTER TABLE sessions DROP COLUMN implicit');
      db.close();
      const result = await closeSprint();
      expect(desiredData(result).implicitSessionsAtClose).toEqual([]);
      expect(formatSprintCompleteForLLM(result)).toMatch(/Implicit sessions at close: none/);
      const check = new Database(dbPath, { readonly: true });
      expect(
        (check.pragma('table_info(sessions)') as { name: string }[]).map((row) => row.name)
      ).not.toContain('implicit');
      check.close();
    });

    it('does not treat a NULL discriminator as implicit', async () => {
      seedSession({
        id: 'I-YES',
        title: 'Implicit',
        sprintId: null,
        status: 'active',
        implicit: 1,
      });
      seedSession({ id: 'I-NULL', title: 'Unknown', sprintId: null, status: 'active' });
      const db = new Database(dbPath);
      db.exec(
        "ALTER TABLE sessions RENAME COLUMN implicit TO old_implicit; ALTER TABLE sessions ADD COLUMN implicit INTEGER; UPDATE sessions SET implicit = 1 WHERE id = 'I-YES'"
      );
      db.close();
      expect(desiredData(await closeSprint()).implicitSessionsAtClose.map((row) => row.id)).toEqual(
        ['I-YES']
      );
    });

    it.each(['PRAGMA table_info(sessions)', 'implicit = 1'])(
      'rolls back rather than hiding a failed %s read',
      async (marker) => {
        const original = RbookDatabaseClient.prototype.getMany;
        const spy = jest
          .spyOn(RbookDatabaseClient.prototype, 'getMany')
          .mockImplementation(function (this: RbookDatabaseClient, sql, params) {
            return sql.includes(marker)
              ? {
                  success: false,
                  error: { code: 'DB_QUERY_FAILED', message: 'injected receipt failure' },
                }
              : original.call(this, sql, params);
          });
        let result;
        try {
          result = await closeSprint();
        } finally {
          spy.mockRestore();
        }
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('DB_QUERY_FAILED');
        const db = new Database(dbPath, { readonly: true });
        expect(
          db.prepare('SELECT status, end_date FROM sprints WHERE id = ?').get(CLOSING_SPRINT_ID)
        ).toEqual({ status: 'Active', end_date: null });
        db.close();
      }
    );
  });

  describe('runtime build telemetry', () => {
    it('returns and renders stale startup time/drift and names the live reconnect lever', async () => {
      writeManifest(projectRoot, manifest('a'.repeat(64), STARTUP_BUILD_TIME));
      initServerHealth(projectRoot);
      writeManifest(projectRoot, manifest('b'.repeat(64), '2026-08-28T12:42:00.000Z'));

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.startupBuildTime).toBe(STARTUP_BUILD_TIME);
      expect(data.driftMinutes).toBe(42);
      expect(formatSprintCompleteForLLM(result)).toMatch(
        /Runtime build at close:.*2026-08-28T12:00:00\.000Z.*42/i
      );

      const warnings = (result.warnings ?? []).join('\n');
      expect(warnings).toMatch(/new host session|reconnect/i);
      expect(warnings).not.toMatch(/restart/i);
    });

    it('returns and renders zero drift for a fresh process manifest', async () => {
      writeManifest(projectRoot, manifest('a'.repeat(64), STARTUP_BUILD_TIME));
      initServerHealth(projectRoot);

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.startupBuildTime).toBe(STARTUP_BUILD_TIME);
      expect(data.driftMinutes).toBe(0);
      expect(formatSprintCompleteForLLM(result)).toMatch(
        /Runtime build at close:.*2026-08-28T12:00:00\.000Z.*0/i
      );
    });

    it('returns and renders null telemetry when the producing process has no manifest', async () => {
      initServerHealth(projectRoot);

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.startupBuildTime).toBeNull();
      expect(data.driftMinutes).toBeNull();
      expect(formatSprintCompleteForLLM(result)).toMatch(
        /Runtime build at close:.*(?:unavailable|unknown|no manifest)/i
      );
    });

    it('always reports producer telemetry but scopes a stale warning away from foreign projects', async () => {
      const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-runtime-build-'));
      extraTempRoots.push(runtimeRoot);
      writeManifest(runtimeRoot, manifest('a'.repeat(64), STARTUP_BUILD_TIME));
      initServerHealth(runtimeRoot);
      writeManifest(runtimeRoot, manifest('b'.repeat(64), '2026-08-28T12:30:00.000Z'));

      const result = await closeSprint();
      const data = desiredData(result);

      expect(data.startupBuildTime).toBe(STARTUP_BUILD_TIME);
      expect(data.driftMinutes).toBe(30);
      expect(formatSprintCompleteForLLM(result)).toMatch(/Runtime build at close:.*30/i);
      expect((result.warnings ?? []).join('\n')).not.toMatch(
        /stale code|new host session|reconnect|restart/i
      );
    });
  });
});

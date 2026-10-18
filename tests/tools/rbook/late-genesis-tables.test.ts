// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A store-wide migration marker must not lose captures in tables created afterwards.
// ABOUTME: Real MCP writes preserve legacy rows and repair schema before taking a write lock.

import Database from 'better-sqlite3';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { ensureGenesisSchema, genesisColumns } from '../../../src/tools/rbook/genesis-columns';
import {
  ensureConstraintsTable,
  ensureLearningsTable,
  ensureNextStepsTable,
} from '../../../src/tools/rbook/schema-migrations';
import { call } from '../../helpers/replica-fixture';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-late-genesis-');
  const client = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
  try {
    ensureGenesisSchema(client);
  } finally {
    client.close();
  }
});
afterEach(async () => project.cleanup());

async function lateTable(table: 'constraints' | 'next_steps' | 'learnings', absent = false) {
  const db = new Database(project.dbPath);
  db.exec(`DROP TABLE ${table}`);
  db.close();
  if (absent) return;
  const client = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
  try {
    const ensure = {
      constraints: ensureConstraintsTable,
      next_steps: ensureNextStepsTable,
      learnings: ensureLearningsTable,
    }[table];
    ensure(client);
    const inserted = client.execute(`INSERT INTO ${table} (content, created_at) VALUES (?, ?)`, [
      'Keep the pre-existing row',
      new Date(Date.now() - 60_000).toISOString(),
    ]);
    expect(inserted.success).toBe(true);
  } finally {
    client.close();
  }
}

it.each([
  ['constraints', false],
  ['constraints', true],
  ['next_steps', false],
  ['next_steps', true],
] as const)(
  'materializes ordinary %s captures when its marked migration predates the table (absent=%s)',
  async (table, absent) => {
    const started = await call('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'Keep late-table captures',
      projectRoot: project.projectRoot,
    });
    expect(started.success).toBe(true);
    await lateTable(table, absent);
    const content = `Persist the ${table} capture`;
    const captured = await call('rbook_session', {
      action: 'capture',
      category: table === 'constraints' ? 'constraint' : 'next-step',
      content,
      sessionId: started.data!.sessionId,
      projectRoot: project.projectRoot,
    });
    expect(captured).toMatchObject({ success: true, data: { writeFailures: [] } });
    if (table === 'next_steps') {
      const closed = await call('rbook_session', {
        action: 'complete',
        sessionId: started.data!.sessionId,
        summary: 'Keep the deferred next step',
        projectRoot: project.projectRoot,
      });
      expect(closed).toMatchObject({
        success: true,
        data: { writeFailures: [], nextStepsExtracted: 1 },
      });
    }
    const db = new Database(project.dbPath, { readonly: true });
    try {
      expect(db.prepare(`SELECT content FROM ${table} ORDER BY id`).all()).toEqual([
        ...(!absent ? [{ content: 'Keep the pre-existing row' }] : []),
        { content },
      ]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE stable_event_id IS NULL OR event_type IS NULL`
          )
          .get()
      ).toEqual({ n: 0 });
      expect(
        (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
      ).toEqual(
        expect.arrayContaining(['author_user_id', 'author_name', 'project_id', 'stable_event_id'])
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  }
);

it.each([false, true])(
  'keeps a learning, its capture and its citation when migration markers predate the table (absent=%s)',
  async (absent) => {
    const started = await call('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'Keep late learning captures',
      projectRoot: project.projectRoot,
    });
    expect(started.success).toBe(true);
    const target = await call('rbook_decisions', {
      action: 'record',
      content: 'The prior decision explains this learning.',
      projectRoot: project.projectRoot,
    });
    expect(target.success).toBe(true);
    await lateTable('learnings', absent);
    const content = `Preserve the lesson from d:${target.data!.decisionId}.`;
    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'learning',
      content,
      sessionId: started.data!.sessionId,
      projectRoot: project.projectRoot,
    });
    expect(captured.error).toBeUndefined();
    expect(captured).toMatchObject({
      success: true,
      data: { captureCount: 1, writeFailures: [] },
    });
    const db = new Database(project.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT content FROM learnings ORDER BY id').all()).toEqual([
        ...(!absent ? [{ content: 'Keep the pre-existing row' }] : []),
        { content },
      ]);
      expect(db.prepare('SELECT from_kind, to_kind, to_id FROM record_links').all()).toEqual([
        { from_kind: 'learning', to_kind: 'decision', to_id: target.data!.decisionId },
      ]);
      const session = db
        .prepare('SELECT captures FROM sessions WHERE id = ?')
        .get(started.data!.sessionId) as { captures: string };
      expect(JSON.parse(session.captures)).toEqual([
        expect.objectContaining({ category: 'learning', content }),
      ]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM learnings WHERE stable_event_id IS NULL OR event_type IS NULL'
          )
          .get()
      ).toEqual({ n: 0 });
      expect(
        (db.pragma('table_info(learnings)') as Array<{ name: string }>).map((c) => c.name)
      ).toEqual(
        expect.arrayContaining(['author_user_id', 'author_name', 'project_id', 'stable_event_id'])
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  }
);

it('refuses unreadable learning preparation through the caller envelope before changing captures', async () => {
  const started = await call('rbook_session', {
    action: 'start',
    type: 'planning',
    title: 'Keep the failed preparation visible',
    projectRoot: project.projectRoot,
  });
  expect(started.success).toBe(true);
  await lateTable('learnings');
  const original = RbookDatabaseClient.prototype.getMany;
  const spy = jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function (
    this: RbookDatabaseClient,
    sql,
    params
  ) {
    if (sql === "PRAGMA table_info('learnings')")
      return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'schema read denied' } };
    return original.call(this, sql, params);
  });
  try {
    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'This capture requires a readable learning schema.',
      sessionId: started.data!.sessionId,
      projectRoot: project.projectRoot,
    });
    expect(captured).toMatchObject({
      success: false,
      error: {
        code: 'DB_QUERY_FAILED',
        message: 'Required record-link schema preparation failed; no record unit was written.',
      },
    });
    expect((captured as { warnings?: string[] }).warnings?.join(' ')).toContain(
      'schema read denied'
    );
  } finally {
    spy.mockRestore();
  }
  const db = new Database(project.dbPath, { readonly: true });
  try {
    expect(db.prepare('SELECT content FROM learnings').all()).toEqual([
      { content: 'Keep the pre-existing row' },
    ]);
    expect(
      db.prepare('SELECT captures FROM sessions WHERE id = ?').get(started.data!.sessionId)
    ).toEqual({ captures: '[]' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

it('refuses a required late-table rebuild inside a transaction before changing its schema', async () => {
  await lateTable('constraints');
  const client = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
  try {
    const before = client.getMany('PRAGMA table_info(constraints)');
    const result = client.writeTransaction(() =>
      genesisColumns(client, 'constraints', 'late-project')
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/prepare.*before.*transaction/i);
    expect(client.getMany('PRAGMA table_info(constraints)')).toEqual(before);
    expect(client.inTransaction).toBe(false);
  } finally {
    client.close();
  }
  const next = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
  try {
    expect(() => genesisColumns(next, 'constraints', 'late-project')).not.toThrow();
  } finally {
    next.close();
  }
});

it('surfaces an unreadable target schema instead of disabling its migration', async () => {
  const client = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
  const getMany = client.getMany.bind(client);
  const spy = jest.spyOn(client, 'getMany').mockImplementation((sql, params) => {
    if (sql === "PRAGMA table_info('constraints')")
      return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'schema read denied' } };
    return getMany(sql, params);
  });
  try {
    expect(() => genesisColumns(client, 'constraints', 'late-project')).toThrow(
      /Could not inspect constraints.*schema read denied/
    );
  } finally {
    spy.mockRestore();
    client.close();
  }
});

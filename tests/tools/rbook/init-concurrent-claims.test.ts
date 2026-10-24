// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Concurrent init keeps the identity and contexts another connection claimed after its reads.
// ABOUTME: Injects real competing SQLite writes at the stale-read boundary, without replacing write results.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-init-claims-'));
  dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});

afterEach(() => {
  jest.restoreAllMocks();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Keep the real missing-row result, but let another connection claim the row before it returns. */
function claimAfterMissingRead(
  query: string,
  key: string,
  claimSql: string,
  values: unknown[]
): () => boolean {
  const prepare = Database.prototype.prepare;
  let claimed = false;
  jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql) as Database.Statement;
    if (this.name !== dbPath || sql !== query) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'get') {
          return (...args: unknown[]) => {
            const row = target.get(...args);
            if (!claimed && args[0] === key && row === undefined) {
              const other = new Database(dbPath);
              try {
                (prepare.call(other, claimSql) as Database.Statement).run(...values);
                claimed = true;
              } finally {
                other.close();
              }
            }
            return row;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  return () => claimed;
}

describe('concurrent init claims', () => {
  it.each(['existing', 'missing'])(
    'uses the committed name while writing the %s master context',
    async (masterState) => {
      expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
      const seed = new Database(dbPath);
      try {
        seed.prepare("UPDATE metadata SET value = '' WHERE key = 'project_name'").run();
        if (masterState === 'missing')
          seed.prepare("DELETE FROM contexts WHERE id = 'master_context'").run();
        seed
          .prepare(
            "INSERT INTO contexts (id, source_path, content) VALUES ('project_identity', 'identity.json', ?)"
          )
          .run(JSON.stringify({ project_name: '' }));
      } finally {
        seed.close();
      }

      const chosen = 'Concurrent explicit name';
      let renamed = false;
      const commitRename = () => {
        renamed = true;
        const other = new Database(dbPath);
        try {
          other.transaction(() => {
            other.prepare("UPDATE metadata SET value = ? WHERE key = 'project_name'").run(chosen);
            other
              .prepare(
                "UPDATE contexts SET content = json_set(content, '$.project_name', ?) WHERE id = 'project_identity'"
              )
              .run(chosen);
            other
              .prepare(
                "UPDATE contexts SET content = json_set(content, '$.project_identity.name', ?) WHERE id = 'master_context'"
              )
              .run(chosen);
          })();
        } finally {
          other.close();
        }
      };
      if (masterState === 'existing') {
        const exec = Database.prototype.exec;
        jest.spyOn(Database.prototype, 'exec').mockImplementation(function (
          this: Database.Database,
          sql: string
        ) {
          if (!renamed && this.name === dbPath && sql === 'BEGIN IMMEDIATE') commitRename();
          return exec.call(this, sql);
        });
      } else {
        const prepare = Database.prototype.prepare;
        jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (
          this: Database.Database,
          sql: string
        ) {
          const statement = prepare.call(this, sql) as Database.Statement;
          if (this.name !== dbPath || sql !== 'SELECT id FROM contexts WHERE id = ?')
            return statement;
          return new Proxy(statement, {
            get(target, property) {
              if (property === 'get')
                return (...args: unknown[]) => {
                  const row = target.get(...args);
                  if (!renamed && args[0] === 'master_context' && row === undefined) commitRename();
                  return row;
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        });
      }

      const result = await rbookProjectInit({ projectRoot: root });
      expect(renamed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.data?.projectName).toBe(chosen);
      const db = new Database(dbPath, { readonly: true });
      try {
        const read = db.prepare('SELECT content FROM contexts WHERE id = ?').pluck();
        expect(JSON.parse(read.get('master_context') as string).project_identity.name).toBe(chosen);
        expect(JSON.parse(read.get('project_identity') as string).project_name).toBe(chosen);
      } finally {
        db.close();
      }
    }
  );

  it('does not replace a concurrently supplied name with the folder default', async () => {
    const claimed = claimAfterMissingRead(
      'SELECT value FROM metadata WHERE key = ?',
      'project_name',
      'INSERT INTO metadata (key, value) VALUES (?, ?)',
      ['project_name', 'First creator chose this name']
    );
    const result = await rbookProjectInit({ projectRoot: root });
    expect(claimed()).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data?.projectName).toBe('First creator chose this name');
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key='project_name'").pluck().get()).toBe(
        'First creator chose this name'
      );
      const master = db
        .prepare("SELECT content FROM contexts WHERE id='master_context'")
        .pluck()
        .get() as string;
      expect(JSON.parse(master).project_identity.name).toBe('First creator chose this name');
    } finally {
      db.close();
    }
  });

  it.each([undefined, 'first-creator'])(
    'returns the first claimed id when projectId is %s',
    async (projectId) => {
      const claimed = claimAfterMissingRead(
        'SELECT value FROM metadata WHERE key = ?',
        'project_id',
        'INSERT INTO metadata (key, value) VALUES (?, ?)',
        ['project_id', 'first-creator']
      );
      const result = await rbookProjectInit({ projectRoot: root, projectId });
      expect(claimed()).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data?.projectId).toBe('first-creator');
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").pluck().get()).toBe(
          'first-creator'
        );
      } finally {
        db.close();
      }
    }
  );

  it('refuses a supplied id that conflicts with the concurrent winner without replacing that identity', async () => {
    const claimed = claimAfterMissingRead(
      'SELECT value FROM metadata WHERE key = ?',
      'project_id',
      'INSERT INTO metadata (key, value) VALUES (?, ?)',
      ['project_id', 'first-creator']
    );
    const result = await rbookProjectInit({ projectRoot: root, projectId: 'second-creator' });
    expect(claimed()).toBe(true);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'projectId' });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").pluck().get()).toBe(
        'first-creator'
      );
      expect(db.prepare('SELECT count(*) FROM contexts').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each(['project_context', 'master_context'])(
    'keeps the concurrently created %s instead of failing or overwriting it',
    async (contextId) => {
      const content = JSON.stringify({ winner: contextId });
      const claimed = claimAfterMissingRead(
        'SELECT id FROM contexts WHERE id = ?',
        contextId,
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
        [contextId, 'first-creator.json', content, new Date().toISOString()]
      );
      const result = await rbookProjectInit({ projectRoot: root });
      expect(claimed()).toBe(true);
      expect(result.error).toBeUndefined();
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(
          db.prepare('SELECT source_path, content FROM contexts WHERE id = ?').get(contextId)
        ).toEqual({ source_path: 'first-creator.json', content });
      } finally {
        db.close();
      }
    }
  );
});

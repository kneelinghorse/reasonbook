// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m03 (ADR s96 §6) — the guards abort every write to a shared record made outside the change helper, let
// ABOUTME: per-copy keys and columns change freely, never commit the token, and fail closed until repaired.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordedExecute, recordedTransaction } from '../../../src/tools/rbook/record-changes';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../../src/tools/rbook/record-columns';
import { unclassifiedColumns } from '../../../src/tools/rbook/record-guards';
import { replayCheck } from '../../../src/tools/rbook/record-replay';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import * as migrations from '../../../src/tools/rbook/schema-migrations';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import {
  call,
  dbOf,
  project,
  record,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The column census reads this repository's own store and its v4.0.2 release copy, from its git history; the public mirror carries neither.",
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
  revisions: { release: 'v4.0.2' },
});

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-guards-');
  useMachine(fixture.tmp, 'air');
});
afterEach(() => fixture.restore());

async function shareStore(root: string): Promise<string> {
  // ADR §4: the baseline names its owner, so the share step needs an author name.
  writeUserAuthor('Owner');
  return withClient(
    root,
    (client) => {
      const readiness = prepareForSharing(client);
      if (!readiness.ready) throw new Error(readiness.problems.join(' '));
      return shareRecord(client).replayBase;
    },
    { replicaCheck: false }
  );
}

async function shared(name = 'owner'): Promise<{ root: string; base: string }> {
  const root = project(fixture.tmp, name);
  return { root, base: await shareStore(root) };
}

function raw<T>(root: string, run: (db: Database.Database) => T): T {
  const db = new Database(dbOf(root));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

const count = (root: string, sql: string): number =>
  raw(root, (db) => (db.prepare(sql).get() as { n: number }).n);

const logged = (root: string): number => count(root, 'SELECT count(*) AS n FROM record_changes');
const held = (root: string): { tokens: number; staged: number } => ({
  tokens: count(root, 'SELECT count(*) AS n FROM record_write_token'),
  staged: count(root, 'SELECT count(*) AS n FROM record_staged'),
});

function io(): CliIo & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    env: process.env,
    cwd: fixture.tmp,
    readStdin: async () => '',
    stdout(text: string) {
      sink.out += text;
    },
    stderr(text: string) {
      sink.err += `${text}\n`;
    },
  };
  return sink as unknown as CliIo & { out: string; err: string };
}

/** Run TypeScript source in a child process, as a hook or a second server would. */
function child(source: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const loader = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', loader + source, ...args], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (chunk) => (out += String(chunk)));
    proc.stderr.on('data', (chunk) => (out += String(chunk)));
    proc.once('close', (code) => resolve({ code, out }));
  });
}

describe('the guards abort with the upgrade remedy', () => {
  it('an insert, update and delete from an older server', async () => {
    const { root } = await shared();
    await record(root, 'A row for the older server to touch.');
    raw(root, (older) => {
      expect(() =>
        older
          .prepare(
            "INSERT INTO sprints (id, title, status) VALUES ('sprint-old', 'Old', 'Planned')"
          )
          .run()
      ).toThrow(/RECORD_WRITE_UNRECORDED[\s\S]*npm install -g @aquex\/reasonbook@latest/);
      expect(() =>
        older.prepare("UPDATE strategic_decisions SET status = 'archived'").run()
      ).toThrow(/RECORD_WRITE_UNRECORDED/);
      expect(() => older.prepare('DELETE FROM strategic_decisions').run()).toThrow(
        /RECORD_WRITE_UNRECORDED/
      );
    });
    expect(count(root, 'SELECT count(*) AS n FROM sprints')).toBe(0);
  });

  it('a dynamic-SQL write through a current client, without the helper', async () => {
    const { root } = await shared();
    await record(root, 'A row a stray statement touches.');
    const result = await withClient(root, (client) =>
      client.execute("UPDATE strategic_decisions SET status = 'archived'")
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/RECORD_WRITE_UNRECORDED/);
    expect(
      count(root, "SELECT count(*) AS n FROM strategic_decisions WHERE status = 'archived'")
    ).toBe(0);
  });

  it('an identity write without the token, as UPDATE and as INSERT OR REPLACE', async () => {
    const { root } = await shared();
    raw(root, (older) => {
      expect(() =>
        older
          .prepare(
            "UPDATE contexts SET content = json_set(content, '$.project_name', 'Renamed') WHERE id = 'project_identity'"
          )
          .run()
      ).toThrow(/RECORD_WRITE_UNRECORDED: the project identity/);
      const content = (
        older.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as {
          content: string;
        }
      ).content;
      const changed = JSON.stringify({ ...JSON.parse(content), description: 'Replaced.' });
      expect(() =>
        older
          .prepare(
            "INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', 'x', ?, 'now')"
          )
          .run(changed)
      ).toThrow(/RECORD_WRITE_UNRECORDED: the project identity/);
      for (const [key, value] of [
        ['project_name', 'Renamed'],
        ['project_domain', 'elsewhere'],
      ])
        expect(() =>
          older
            .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
            .run(key, value)
        ).toThrow(/RECORD_WRITE_UNRECORDED/);
    });
  });

  it('project_id and created_at never change, in metadata or the identity, even with the token', async () => {
    const { root } = await shared();
    for (const sql of [
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'another-project')",
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('created_at', '2000-01-01')",
      "UPDATE contexts SET content = json_set(content, '$.project_id', 'another-project') WHERE id = 'project_identity'",
      "UPDATE contexts SET content = json_set(content, '$.created_at', '2000-01-01') WHERE id = 'project_identity'",
      "DELETE FROM contexts WHERE id = 'project_identity'",
    ]) {
      const result = await withClient(root, (client) =>
        recordedTransaction(client, () => {
          const changed = client.execute(sql);
          if (!changed.success) throw new Error(changed.error?.message);
        })
      );
      expect({ sql, error: result.error?.message }).toEqual({
        sql,
        error: expect.stringMatching(/RECORD_IDENTITY_IMMUTABLE/),
      });
    }
  });

  it('a renumber through rowid, _rowid_ or oid', async () => {
    const { root, base } = await shared();
    await record(root, 'A row to renumber.');
    const [{ id }] = raw(root, (db) =>
      db.prepare('SELECT id FROM strategic_decisions').all()
    ) as Array<{
      id: number;
    }>;
    raw(root, (older) => {
      for (const alias of ['rowid', '_rowid_', 'oid'])
        expect(() =>
          older.prepare(`UPDATE strategic_decisions SET ${alias} = ? WHERE id = ?`).run(id + 7, id)
        ).toThrow(/RECORD_WRITE_UNRECORDED/);
    });
    // With the token, the renumber is a recorded change of the row's id.
    const renumbered = await withClient(root, (client) =>
      recordedExecute(client, 'UPDATE strategic_decisions SET rowid = ? WHERE id = ?', [id + 7, id])
    );
    expect(renumbered.success).toBe(true);
    expect(
      count(root, "SELECT count(*) AS n FROM record_changes WHERE kind = 'set' AND field = 'id'")
    ).toBe(1);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('an identity that SQLite and the app would read differently, even with the token', async () => {
    const { root } = await shared();
    const content = raw(
      root,
      (db) =>
        (
          db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as {
            content: string;
          }
        ).content
    );
    // SQLite reads a repeated key's first value and the app its last; JSON5 the app cannot parse.
    const duplicated = content.replace(/}\s*$/, ', "project_name": "Hijacked"}');
    const json5 = content.replace(/"(\w+)":/g, '$1:');
    for (const text of [duplicated, json5, '[]', 'not json']) {
      raw(root, (older) =>
        expect(() =>
          older.prepare("UPDATE contexts SET content = ? WHERE id = 'project_identity'").run(text)
        ).toThrow(/RECORD_IDENTITY_INVALID/)
      );
      const withToken = await withClient(root, (client) =>
        recordedExecute(client, "UPDATE contexts SET content = ? WHERE id = 'project_identity'", [
          text,
        ])
      );
      expect(withToken.error?.message).toMatch(/RECORD_IDENTITY_INVALID/);
    }
  });
});

describe('what passes freely', () => {
  it('per-copy identity keys, recording nothing', async () => {
    const { root, base } = await shared();
    const before = logged(root);
    raw(root, (db) => {
      db.prepare(
        "UPDATE contexts SET content = json_set(content, '$.cmos_address', 'rbook://elsewhere/shared', '$.rbook_address', 'rbook://elsewhere/shared', '$.updated_at', 'now'), updated_at = 'now' WHERE id = 'project_identity'"
      ).run();
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('owner', 'someone')").run();
    });
    const content = raw(root, (db) =>
      JSON.parse(
        (
          db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as {
            content: string;
          }
        ).content
      )
    );
    expect(content.cmos_address).toBe('rbook://elsewhere/shared');
    expect(logged(root)).toBe(before);
    expect((await record(root, 'A write after the per-copy changes.')).success).toBe(true);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('per-copy columns: owner_key, last_embedded_hash, and snapshot_id nulled by a hard prune', async () => {
    const { root, base } = await shared();
    await record(root, 'A decision with an embedding hash.');
    await call('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'Opens a session.',
      projectRoot: root,
    });
    const snap = await call('rbook_context', {
      action: 'snapshot',
      source: 'test',
      projectRoot: root,
    });
    expect(snap.error).toBeUndefined();
    const before = logged(root);
    raw(root, (db) => {
      db.prepare("UPDATE sessions SET owner_key = 'another-process'").run();
      // A store gets its embedding hash column with its first embedding.
      const columns = db.pragma("table_info('strategic_decisions')") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'last_embedded_hash'))
        db.exec('ALTER TABLE strategic_decisions ADD COLUMN last_embedded_hash TEXT');
      db.prepare("UPDATE strategic_decisions SET last_embedded_hash = 'hash'").run();
      const snapshot = (
        db.prepare('SELECT id FROM context_snapshots ORDER BY id DESC LIMIT 1').get() as {
          id: number;
        }
      ).id;
      db.pragma('foreign_keys = ON');
      // The decision points at the snapshot; the hard prune deletes it, and the FK nulls the column.
      db.prepare('UPDATE strategic_decisions SET snapshot_id = ?').run(snapshot);
      db.prepare('DELETE FROM context_snapshots WHERE id = ?').run(snapshot);
    });
    expect(
      count(root, 'SELECT count(*) AS n FROM strategic_decisions WHERE snapshot_id IS NOT NULL')
    ).toBe(0);
    expect(
      count(root, "SELECT count(*) AS n FROM sessions WHERE owner_key = 'another-process'")
    ).toBe(1);
    expect(logged(root)).toBe(before);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });
});

describe('the token', () => {
  it('no path commits a token: a write that fails or throws rolls it back with its changes', async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    const failed = await withClient(root, (client) =>
      recordedTransaction(client, () => {
        client.execute("UPDATE strategic_decisions SET status = 'archived'");
        throw new Error('the write failed after its update');
      })
    );
    expect(failed.success).toBe(false);
    expect(count(root, 'SELECT count(*) AS n FROM record_write_token')).toBe(0);
    expect(count(root, 'SELECT count(*) AS n FROM record_staged')).toBe(0);
    expect(
      count(root, "SELECT count(*) AS n FROM strategic_decisions WHERE status = 'archived'")
    ).toBe(0);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a write that commits, ends or rolls back the transaction itself, or runs a script, is refused, and the rest is recorded', async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    for (const [via, verb] of [
      ['execute', 'COMMIT'],
      ['execute', 'commit transaction'],
      ['execute', 'END'],
      ['execute', 'ROLLBACK'],
      ['execute', 'BEGIN IMMEDIATE'],
      ['execute', '/* a comment first */ COMMIT'],
      ['execute', '-- a note\nCOMMIT'],
      // SQLite skips empty statements before a verb.
      ['execute', ';COMMIT'],
      ['execute', '/* c */;COMMIT'],
      ['execute', ' ; END'],
      // Quoted text can hide a verb from any pattern, so a script is refused whatever it holds.
      ['raw', 'COMMIT'],
      ['raw', "SELECT '--'; COMMIT"],
      ['raw', "SELECT '/*'; COMMIT; SELECT '*/'"],
      ['raw', "UPDATE strategic_decisions SET category = 'x'; COMMIT; BEGIN IMMEDIATE"],
      ['raw', 'SELECT 1'],
    ] as const) {
      const before = logged(root);
      const done = await withClient(root, (client) =>
        recordedTransaction(client, () => {
          const changed = client.execute("UPDATE strategic_decisions SET status = 'archived'");
          if (!changed.success) throw new Error(changed.error?.message);
          const ended = via === 'raw' ? client.raw(verb) : client.execute(verb);
          return ended;
        })
      );
      expect({ verb, committed: done.success }).toEqual({ verb, committed: true });
      expect(done.data?.success).toBe(false);
      expect(done.data?.error?.code).toBe('RECORD_WRITE_REFUSED');
      expect(held(root)).toEqual({ tokens: 0, staged: 0 });
      // The update the write made before it tried is committed with its change recorded.
      expect(logged(root)).toBe(before + 1);
      await withClient(root, (client) =>
        recordedExecute(client, "UPDATE strategic_decisions SET status = 'active'")
      );
    }
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    // A savepoint's ROLLBACK TO stays inside the transaction, so it is allowed.
    const savepoint = await withClient(root, (client) =>
      recordedTransaction(client, () => {
        client.execute('SAVEPOINT inner');
        client.execute("UPDATE strategic_decisions SET status = 'archived'");
        return client.execute('ROLLBACK TO inner');
      })
    );
    expect(savepoint.data?.success).toBe(true);
    expect(held(root)).toEqual({ tokens: 0, staged: 0 });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a recorded write inside a deferred transaction is refused, since it cannot hold the write lock', async () => {
    const { root } = await shared();
    await record(root, 'A recorded choice.');
    const done = await withClient(root, (client) =>
      client.transaction(() => {
        const inner = recordedExecute(client, "UPDATE strategic_decisions SET status = 'archived'");
        if (!inner.success) throw new Error(inner.error?.message);
      })
    );
    expect(done.error?.message).toMatch(/cannot run inside a deferred transaction/);
    expect(held(root)).toEqual({ tokens: 0, staged: 0 });
  });

  it('a create on a shared copy runs its point-of-use migrations before the token, and records none of them', async () => {
    const { root, base } = await shared();
    // A marker a later release would raise: the migration runs again at the next create.
    raw(root, (db) =>
      db
        .prepare(
          "DELETE FROM metadata WHERE key IN ('author_name_columns', 'firehose_event_columns')"
        )
        .run()
    );
    const before = logged(root);
    const recorded = await record(root, 'A choice after the markers went.');
    expect(recorded.error).toBeUndefined();
    expect(
      count(
        root,
        "SELECT count(*) AS n FROM metadata WHERE key IN ('author_name_columns', 'firehose_event_columns')"
      )
    ).toBe(2);
    // The decision's create and its session's are the only changes; the migrations wrote none.
    const kinds = raw(root, (db) =>
      (
        db
          .prepare(
            'SELECT entity, kind FROM record_changes WHERE replica_seq > ? ORDER BY replica_seq'
          )
          .all(before) as Array<{ entity: string; kind: string }>
      ).map((change) => `${change.entity}:${change.kind}`)
    );
    expect(
      kinds.every((kind) => kind.endsWith(':create') || kind === 'session_missions:link')
    ).toBe(true);
    expect(kinds).toContain('strategic_decisions:create');
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it("a transaction ended past the client's refusal fails closed, and the repair records what it staged", async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    const done = await withClient(root, (client) =>
      recordedTransaction(client, () => {
        client.execute("UPDATE strategic_decisions SET status = 'archived'");
        // What no statement through the client can do: end the transaction under the helper.
        (client as unknown as { db: Database.Database }).db.exec('COMMIT');
      })
    );
    expect(done.success).toBe(false);
    expect(done.error?.message).toMatch(/ended its own transaction/);
    expect(held(root)).toEqual({ tokens: 1, staged: 1 });
    expect((await record(root, 'Refused until repaired.')).error?.code).toBe('RECORD_GUARD_BROKEN');
    expect(await runCli(['repair', '--guard', '--project-root', root], io())).toBe(0);
    expect(held(root)).toEqual({ tokens: 0, staged: 0 });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a failure while recording, or an async write, rolls back the token, the stage and the change', async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    const archived = (): number =>
      count(root, "SELECT count(*) AS n FROM strategic_decisions WHERE status = 'archived'");
    // The log refuses its insert, as a full disk would: the change is never committed unrecorded.
    raw(root, (db) =>
      db.exec(
        "CREATE TRIGGER fault_log_full BEFORE INSERT ON record_changes BEGIN SELECT RAISE(ABORT, 'log full'); END"
      )
    );
    const failed = await withClient(root, (client) =>
      recordedExecute(client, "UPDATE strategic_decisions SET status = 'archived'")
    );
    expect(failed.error?.message).toMatch(/log full/);
    raw(root, (db) => db.exec('DROP TRIGGER fault_log_full'));
    expect({ ...held(root), archived: archived() }).toEqual({ tokens: 0, staged: 0, archived: 0 });
    // A delete is staged and then refused when its change is drafted.
    const deleted = await withClient(root, (client) =>
      recordedExecute(client, 'DELETE FROM strategic_decisions')
    );
    expect(deleted.error?.code).toBe('RECORD_WRITE_REFUSED');
    expect(count(root, 'SELECT count(*) AS n FROM strategic_decisions')).toBe(1);
    // better-sqlite3 refuses a transaction function that returns a promise, after its first part ran.
    const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    const client = opened.data!;
    try {
      let later: Promise<unknown> | undefined;
      const asynchronous = recordedTransaction(client, () => {
        later = (async () => {
          client.execute("UPDATE strategic_decisions SET status = 'archived'");
          await Promise.resolve();
          return client.execute("UPDATE strategic_decisions SET status = 'archived'");
        })();
        return later;
      });
      expect(asynchronous.success).toBe(false);
      // Its second part ran outside the helper, so the guard aborted it.
      expect(await later).toMatchObject({
        success: false,
        error: { message: expect.stringMatching(/RECORD_WRITE_UNRECORDED/) },
      });
    } finally {
      client.close();
    }
    expect({ ...held(root), archived: archived() }).toEqual({ tokens: 0, staged: 0, archived: 0 });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a client opened without the check counts its own token as its own', async () => {
    const { root, base } = await shared();
    for (const missionId of ['u-m01', 'u-m02'])
      await call('rbook_mission', { action: 'add', missionId, name: missionId, projectRoot: root });
    // Its first shared-table insert runs the copy check inside the helper's own transaction.
    const linked = await withClient(
      root,
      (client) =>
        recordedExecute(
          client,
          "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('u-m02', 'u-m01', 'blocks')"
        ),
      { replicaCheck: false }
    );
    expect(linked.error).toBeUndefined();
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    // A token another writer left is still refused there.
    raw(root, (db) =>
      db.prepare("INSERT INTO record_write_token (txn_id) VALUES ('left over')").run()
    );
    const refused = await withClient(
      root,
      (client) =>
        recordedExecute(client, "UPDATE missions SET name = 'Renamed' WHERE id = 'u-m01'"),
      { replicaCheck: false }
    );
    expect(refused.error?.code).toBe('RECORD_GUARD_BROKEN');
    expect(refused.error?.suggestion).toMatch(/reasonbook repair --guard/);
  });

  it('a seeded leftover token fails closed, and reasonbook repair --guard clears it', async () => {
    const { root } = await shared();
    raw(root, (db) =>
      db.prepare("INSERT INTO record_write_token (txn_id) VALUES ('left over')").run()
    );
    const refused = await record(root, 'A write the broken guard refuses.');
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('RECORD_GUARD_BROKEN');
    expect(refused.error?.suggestion).toMatch(/reasonbook repair --guard/);
    // Reads still work.
    expect((await call('rbook_decisions', { action: 'list', projectRoot: root })).success).toBe(
      true
    );
    const sink = io();
    expect(await runCli(['repair', '--guard', '--project-root', root], sink)).toBe(0);
    expect(sink.out).toMatch(/leftover write token/);
    expect((await record(root, 'A write after the repair.')).success).toBe(true);
  });

  it.each(['the log alone', 'the log and all guard objects'])(
    'a shared identity still refuses writes after losing %s',
    async (damage) => {
      const { root } = await shared();
      expect((await record(root, 'The last intact recorded choice.')).success).toBe(true);
      const before = count(root, 'SELECT count(*) AS n FROM strategic_decisions');
      raw(root, (db) => {
        if (damage === 'the log and all guard objects') {
          // The pre-s96-m03 fixture shape: an identity alone must not make a store writable.
          for (const { name } of db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'record_%'"
            )
            .all() as Array<{ name: string }>)
            db.exec(`DROP TRIGGER "${name}"`);
          for (const { name } of db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'record_%' AND name <> 'record_links'"
            )
            .all() as Array<{ name: string }>)
            db.exec(`DROP TABLE "${name}"`);
        } else db.exec('DROP TABLE record_changes');
      });
      const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
      opened.data?.close();
      const refused = await record(root, 'A missing history must never become a solo write.');
      expect({ opened: opened.success, written: refused.success }).toEqual({
        opened: false,
        written: false,
      });
      expect(opened.error?.code).toBe('RECORD_GUARD_BROKEN');
      expect(opened.error?.message).toMatch(/missing tables:.*record_changes/);
      expect(refused.error?.code).toBe('RECORD_GUARD_BROKEN');
      expect(refused.error?.suggestion).toMatch(/lost part of its record.*restore the store file/);
      expect((await call('rbook_decisions', { action: 'list', projectRoot: root })).success).toBe(
        true
      );
      expect(count(root, 'SELECT count(*) AS n FROM strategic_decisions')).toBe(before);
      expect(
        count(root, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'record_changes'")
      ).toBe(0);
    }
  );

  it('repair refuses a lost change log instead of reporting an unshared store or recreating history', async () => {
    const { root } = await shared();
    expect((await record(root, 'A choice whose history cannot be manufactured.')).success).toBe(
      true
    );
    const before = count(root, 'SELECT count(*) AS n FROM strategic_decisions');
    raw(root, (db) => db.exec('DROP TABLE record_changes'));
    const sink = io();
    expect(await runCli(['repair', '--guard', '--project-root', root], sink)).toBe(1);
    expect(sink.err).toMatch(/missing tables: record_changes/);
    expect(sink.err).toMatch(/restore the store file from a backup or join a fresh copy/);
    expect(sink.out).not.toMatch(/not a shared record/);
    expect(count(root, 'SELECT count(*) AS n FROM strategic_decisions')).toBe(before);
    expect(
      count(root, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'record_changes'")
    ).toBe(0);
  });

  it('a genuinely unshared store still writes and has no guard to repair', async () => {
    const root = project(fixture.tmp, 'solo-no-log');
    expect((await record(root, 'Solo work does not require a shared change log.')).success).toBe(
      true
    );
    const sink = io();
    expect(await runCli(['repair', '--guard', '--project-root', root], sink)).toBe(0);
    expect(sink.out).toMatch(/not a shared record/);
    expect(
      count(root, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'record_changes'")
    ).toBe(0);
  });

  it.each([
    [
      'dropped',
      'DROP TRIGGER record_guard_missions_update',
      /missing triggers: record_guard_missions_update/,
    ],
    [
      'changed',
      'DROP TRIGGER record_guard_missions_update; CREATE TRIGGER record_guard_missions_update BEFORE UPDATE OF name ON missions WHEN 0 BEGIN SELECT 1; END',
      /changed triggers: record_guard_missions_update/,
    ],
    ['lost stage', 'DROP TABLE record_staged', /missing guard tables: record_staged/],
  ])('a %s guard fails closed, and the repair restores it', async (_name, damage, expected) => {
    const { root } = await shared();
    raw(root, (db) => db.exec(damage));
    const refused = await call('rbook_mission', {
      action: 'add',
      missionId: 'g-m01',
      name: 'Refused',
      projectRoot: root,
    });
    expect(refused.error?.code).toBe('RECORD_GUARD_BROKEN');
    expect(refused.error?.message).toMatch(expected);
    expect(refused.error?.suggestion).toMatch(/reasonbook repair --guard/);
    expect(await runCli(['repair', '--guard', '--project-root', root], io())).toBe(0);
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'g-m01',
          name: 'Kept',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
  });

  it('the repair records what an older server wrote while a token was left over', async () => {
    const { root, base } = await shared();
    await record(root, 'A recorded choice.');
    raw(root, (db) => {
      db.prepare("INSERT INTO record_write_token (txn_id) VALUES ('left over')").run();
      // The guard passes it, since a token is there, and the capture stages it.
      db.prepare("UPDATE strategic_decisions SET status = 'archived'").run();
    });
    expect(held(root)).toEqual({ tokens: 1, staged: 1 });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([
      expect.stringMatching(/status: the store holds "archived"/),
    ]);
    const sink = io();
    expect(await runCli(['repair', '--guard', '--project-root', root], sink)).toBe(0);
    expect(sink.out).toMatch(/Recorded 1 staged change in the change log/);
    expect(held(root)).toEqual({ tokens: 0, staged: 0 });
    // The repairer did not make the change, so it carries no author ("author not recorded").
    expect(
      raw(root, (db) =>
        db
          .prepare(
            "SELECT author_name, author_user_id FROM record_changes WHERE field = 'status' ORDER BY replica_seq DESC LIMIT 1"
          )
          .get()
      )
    ).toEqual({ author_name: null, author_user_id: null });
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
    expect((await record(root, 'A write after the repair.')).success).toBe(true);
  });

  it.each([
    [
      'a lost shared table',
      'DROP TABLE session_missions',
      /missing tables: session_missions/,
      /restore the store file from a backup or join a fresh copy/,
    ],
    [
      'a lost log table',
      'DROP TABLE record_heads',
      /missing tables: record_heads/,
      /restore the store file from a backup or join a fresh copy/,
    ],
    [
      'an unknown column',
      'ALTER TABLE missions ADD COLUMN priority TEXT',
      /columns this version does not know: missions\.priority/,
      /upgrade with npm install -g @aquex\/reasonbook@latest/,
    ],
    [
      'a staged delete',
      "INSERT INTO record_write_token (txn_id) VALUES ('left over'); DELETE FROM sprints WHERE id = 'gone'",
      /1 staged change\(s\) never recorded/,
      /restore the store file from a backup or join a fresh copy/,
    ],
  ])('the repair refuses %s, and names the remedy', async (name, damage, problem, remedy) => {
    const { root } = await shared();
    await call('rbook_sprint', {
      action: 'add',
      sprintId: 'gone',
      title: 'Gone',
      status: 'Planned',
      projectRoot: root,
    });
    raw(root, (db) => db.exec(damage));
    const refused = await record(root, 'A write the copy refuses.');
    expect(refused.error?.code).toBe('RECORD_GUARD_BROKEN');
    expect(refused.error?.message).toMatch(problem);
    // A staged delete is found only when the repair drafts it; until then it reads as a repair.
    if (name !== 'a staged delete') expect(refused.error?.suggestion).toMatch(remedy);
    const sink = io();
    expect(await runCli(['repair', '--guard', '--project-root', root], sink)).toBe(1);
    expect(sink.err).toMatch(remedy);
  });
});

describe('the standing fixtures', () => {
  it('an unmigrated store is refused until it is made ready', async () => {
    // A freshly seeded store has not yet had its lazy migrations, so it lacks recorded columns.
    const root = project(fixture.tmp, 'unready');
    await expect(
      withClient(root, (client) => shareRecord(client), { replicaCheck: false })
    ).rejects.toThrow(/This store cannot be shared: \w+ lacks recorded columns: /);
    await expect(shareStore(root)).resolves.toMatch(/replay-bases/);
  });

  it('a table absent at share time is made, and its writes are guarded and recorded', async () => {
    const root = project(fixture.tmp, 'absent');
    raw(root, (db) => db.exec('DROP TABLE session_missions'));
    const base = await shareStore(root);
    await call('rbook_mission', {
      action: 'add',
      missionId: 't-m01',
      name: 'Linked',
      projectRoot: root,
    });
    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'Linked to a mission.',
      missionId: 't-m01',
      projectRoot: root,
    });
    expect(captured.success).toBe(true);
    expect(
      count(root, "SELECT count(*) AS n FROM record_changes WHERE entity = 'session_missions'")
    ).toBe(1);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a loose store, without its learnings foreign keys, records too', async () => {
    const root = project(fixture.tmp, 'loose');
    raw(root, (db) => {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'learnings'").get() as {
          sql: string;
        }
      ).sql;
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'learnings'").run(
        sql.replace(
          /,\s*FOREIGN KEY \(\w+\) REFERENCES \w+\(\w+\)(?: ON DELETE (?:SET NULL|CASCADE))?/g,
          ''
        )
      );
      db.pragma('writable_schema = OFF');
    });
    const base = await shareStore(root);
    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'A loose store records its changes as a strict one does.',
      projectRoot: root,
    });
    expect(captured.success).toBe(true);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('NULL values are recorded as NULL, and replayed as NULL', async () => {
    const { root, base } = await shared();
    const recorded = await record(root, 'A decision with no sprint, mission or session.');
    expect(recorded.success).toBe(true);
    const value = raw(root, (db) =>
      JSON.parse(
        (
          db
            .prepare(
              "SELECT value FROM record_changes WHERE kind = 'create' AND entity = 'strategic_decisions'"
            )
            .get() as {
            value: string;
          }
        ).value
      )
    );
    expect(value.mission_id).toBeNull();
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('two processes writing at once both record, on one contiguous sequence', async () => {
    const { root, base } = await shared();
    const decisions = path.resolve('src/tools/rbook/rbook-decisions.ts');
    const source = String.raw`const {rbookDecisions}=require(process.argv[1]);(async()=>{const out=[];for(let n=0;n<4;n++){const r=await rbookDecisions({action:'record',content:'Decision '+n+' from '+process.argv[3],projectRoot:process.argv[2]});out.push(r.success);}process.stdout.write(JSON.stringify(out)+'\n');process.exit(0);})();`;
    const runs = await Promise.all(
      ['first', 'second'].map((name) => child(source, [decisions, root, name]))
    );
    for (const run of runs)
      expect(run.out.trim().split('\n').slice(-1)[0]).toBe(JSON.stringify(Array(4).fill(true)));
    expect(
      count(
        root,
        "SELECT count(*) AS n FROM record_changes WHERE kind = 'create' AND entity = 'strategic_decisions'"
      )
    ).toBe(8);
    const seqs = raw(root, (db) =>
      (
        db.prepare('SELECT replica_seq FROM record_changes ORDER BY replica_seq').all() as Array<{
          replica_seq: number;
        }>
      ).map((row) => row.replica_seq)
    );
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  }, 120000);

  it('a hook process writing records its change', async () => {
    const { root, base } = await shared();
    const cli = path.resolve('src/cli.ts');
    const source = String.raw`const {runCli}=require(process.argv[1]);runCli(['capture','--session-id','hook-session','--category','learning','--content','Written by a hook process.','--project-root',process.argv[2]]).then((code)=>process.exit(code));`;
    const run = await child(source, [cli, root]);
    expect({ code: run.code, out: run.out.slice(-400) }).toMatchObject({ code: 0 });
    expect(
      count(
        root,
        "SELECT count(*) AS n FROM record_changes WHERE kind = 'create' AND entity = 'learnings'"
      )
    ).toBe(1);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  }, 120000);
});

describe('a solo store', () => {
  it('is untouched: no log, no guards or captures, and writes as before', async () => {
    const root = project(fixture.tmp, 'solo');
    expect((await record(root, 'A solo choice.')).success).toBe(true);
    const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    try {
      const tables = opened.data!.getMany<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name IN ('record_changes', 'record_heads', 'record_conflicts', 'record_write_token', 'record_staged') OR name LIKE 'record\\_guard\\_%' ESCAPE '\\' OR name LIKE 'record\\_capture\\_%' ESCAPE '\\'"
      );
      expect(tables.data).toEqual([]);
    } finally {
      opened.data!.close();
    }
  });
});

describe('the column classes', () => {
  const classified = (table: (typeof RECORDED_TABLES)[number]): string[] => {
    const classes = RECORD_COLUMNS[table];
    return [...classes.recorded, ...classes.perCopyLocal, ...classes.perCopyDerived];
  };
  const unknown = (file: string): string[] => {
    const db = new Database(file, { readonly: true });
    try {
      return unclassifiedColumns((sql) => db.prepare(sql).all() as never);
    } finally {
      db.close();
    }
  };

  it('name each column of a shared table in exactly one class', () => {
    for (const table of RECORDED_TABLES) {
      const names = classified(table);
      expect({ table, twice: names.filter((name, i) => names.indexOf(name) !== i) }).toEqual({
        table,
        twice: [],
      });
    }
  });

  it('cover every column a store has after every migration that takes only a client', async () => {
    const root = project(fixture.tmp, 'migrated');
    // A migration that fails here leaves its columns unchecked, so each failure is named.
    const failed: string[] = [];
    await withClient(
      root,
      (client) => {
        prepareForSharing(client);
        for (const [name, migrate] of Object.entries(migrations))
          if (name.startsWith('ensure') && typeof migrate === 'function' && migrate.length === 1)
            try {
              (migrate as (c: RbookDatabaseClient) => unknown)(client);
            } catch (error) {
              failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
      },
      { replicaCheck: false }
    );
    raw(root, (db) => {
      // The embedding hash columns come with a store's first embedding.
      for (const table of ['strategic_decisions', 'learnings', 'missions'])
        if (
          !(db.pragma(`table_info('${table}')`) as Array<{ name: string }>).some(
            (c) => c.name === 'last_embedded_hash'
          )
        )
          db.exec(`ALTER TABLE ${table} ADD COLUMN last_embedded_hash TEXT`);
    });
    expect(failed).toEqual([]);
    expect(unknown(dbOf(root))).toEqual([]);
  });

  it('cover every column the source adds to a shared table by name', () => {
    const src = path.resolve(__dirname, '..', '..', '..', 'src');
    const added: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.ts'))
          for (const match of fs
            .readFileSync(file, 'utf8')
            .matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi))
            if ((RECORDED_TABLES as readonly string[]).includes(match[1]))
              added.push(`${match[1]}.${match[2]}`);
      }
    };
    walk(src);
    expect(added.length).toBeGreaterThan(0);
    expect(
      added.filter((column) => {
        const [table, name] = column.split('.');
        return !classified(table as (typeof RECORDED_TABLES)[number]).includes(name);
      })
    ).toEqual([]);
  });
});

PRIVATE.describe("the column classes on this repository's own stores", () => {
  it('cover every column of its live store and its v4.0.2 copy, once prepared', async () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    for (const name of ['live', 'release'] as const) {
      const root = path.join(fixture.tmp, name);
      fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
      if (name === 'live')
        for (const suffix of ['', '-wal', '-shm']) {
          const source = `${PRIVATE.paths.liveDb}${suffix}`;
          if (fs.existsSync(source)) fs.copyFileSync(source, `${dbOf(root)}${suffix}`);
        }
      else
        fs.writeFileSync(
          dbOf(root),
          execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
            cwd: repo,
            maxBuffer: 256 * 1024 * 1024,
          })
        );
      reidentifyRbookTestStore(root);
      await withClient(root, (client) => prepareForSharing(client), { replicaCheck: false });
      const db = new Database(dbOf(root), { readonly: true });
      try {
        expect({
          name,
          unknown: unclassifiedColumns((sql) => db.prepare(sql).all() as never),
        }).toEqual({
          name,
          unknown: [],
        });
      } finally {
        db.close();
      }
    }
  }, 120000);
});

describe('no REPLACE on a shared table', () => {
  // REPLACE's implicit delete fires no delete trigger, so a shared row it replaced would be lost
  // unrecorded (ADR s96 §6). Counting rule: every INSERT OR REPLACE, REPLACE INTO and UPDATE OR
  // REPLACE in src/ that names one of the nine shared tables, and every ON CONFLICT REPLACE clause
  // in their schema; the expected count is zero.
  it('the source writes none', () => {
    const src = path.resolve(__dirname, '..', '..', '..', 'src');
    const found: string[] = [];
    const pattern = new RegExp(
      `(?:\\b(?:INSERT|UPDATE)\\s+OR\\s+REPLACE(?:\\s+INTO)?|\\bREPLACE\\s+INTO)\\s+["\`[]?(${RECORDED_TABLES.join('|')})\\b`,
      'gi'
    );
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.ts'))
          for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern))
            found.push(`${path.relative(src, file)}: ${match[0]}`);
      }
    };
    walk(src);
    expect(found).toEqual([]);
  });

  it('the source names no dynamic REPLACE target, which the count above could not read', () => {
    const src = path.resolve(__dirname, '..', '..', '..', 'src');
    const found: string[] = [];
    const pattern =
      /(?:\b(?:INSERT|UPDATE)\s+OR\s+REPLACE(?:\s+INTO)?|\bREPLACE\s+INTO)\s+["`[]?\$\{/gi;
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.ts'))
          for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern))
            found.push(`${path.relative(src, file)}: ${match[0]}`);
      }
    };
    walk(src);
    expect(found).toEqual([]);
  });

  it('the shared tables hold no ON CONFLICT REPLACE', async () => {
    const root = project(fixture.tmp, 'conflict');
    await withClient(root, (client) => prepareForSharing(client), { replicaCheck: false });
    const schemas = raw(root, (db) =>
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE tbl_name IN (${RECORDED_TABLES.map(() => '?').join(', ')}) AND sql LIKE '%ON CONFLICT REPLACE%'`
        )
        .all(...RECORDED_TABLES)
    );
    expect(schemas).toEqual([]);
  });
});

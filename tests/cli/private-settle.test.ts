// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives paired private settlement through the real CLI with both of its SQLite stores.
// ABOUTME: A preview, refusal, neighbor, retried answer and independent approval keep their evidence.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as matcher from '../../src/tools/rbook/private-answer-match';
import { markReplaced, rawRunner } from '../../src/tools/rbook/proposals';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { share } from '../helpers/replica-fixture';
import type { DraftRuntime } from '../../src/tools/rbook/draft-runtime';
import { EXCERPT_TTL_MS } from '../../src/tools/rbook/draft-runtime-excerpts';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { createSettlementFixture } from '../helpers/private-settlement';

let tmp: string;
let root: string;
let store: Database.Database;
let runtime: DraftRuntime;
let env: NodeJS.ProcessEnv;
let selected: string[];
let fixture: ReturnType<typeof createSettlementFixture>;
let cli: typeof fixture.cli;
beforeEach(() => {
  fixture = createSettlementFixture();
  ({ tmp, root, store, runtime, env, selected, cli } = fixture);
});
afterEach(() => fixture.close());

const projectState = () => ({
  schema: store.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('proposals'),
  drafts: store.prepare('SELECT * FROM proposals ORDER BY id').all(),
  decisions: store.prepare('SELECT * FROM strategic_decisions ORDER BY id').all(),
});
const runtimeState = () => runtime.db.serialize();
function excerpt(db: Database.Database, id: number, reply: string, at = Date.now()) {
  db.prepare(
    "INSERT INTO excerpts(session,draft_id,message,reply,window_size,at,late) VALUES(?,?,'fixture',?,1,?,0)"
  ).run(reply, id, reply, at);
}
const expectRefused = async (expected: RegExp) => {
  const before = projectState();
  const words = runtimeState();
  for (const extra of [['--dry-run'], []]) {
    const answer = await cli([...selected, ...extra]);
    expect(answer.code).toBe(1);
    expect(answer.err).toMatch(expected);
    expect(projectState()).toEqual(before);
    expect(runtimeState()).toEqual(words);
  }
};

it('previews the same pair without changing either store, then links just the selection once', async () => {
  setExternalSessionOwner('another-writing-chat');
  store.exec('ALTER TABLE proposals DROP COLUMN settled_by');
  store.exec(
    'CREATE TABLE annotations(draft INTEGER REFERENCES proposals(id)); INSERT INTO annotations VALUES(1)'
  );
  store.exec(
    'INSERT INTO proposals(id,text,created_at,source_session,replaced_by) SELECT 2,text,created_at,source_session,1 FROM proposals WHERE id=1; INSERT INTO proposals(id,text,created_at,source_session) SELECT 3,text,created_at,source_session FROM proposals WHERE id=1; UPDATE proposals SET replaced_by=3 WHERE id=1'
  );
  excerpt(runtime.db, 2, 'approval');
  excerpt(runtime.db, 1, 'other');
  excerpt(runtime.db, 1, 'question');
  excerpt(runtime.db, 1, 'unknown', Date.now() - EXCERPT_TTL_MS);
  const before = projectState();
  const bytes = store.serialize();
  const words = runtimeState();
  expect(await cli([...selected, '--dry-run'])).toMatchObject({
    code: 0,
    out: expect.stringMatching(/would settle P1 by d:7/i),
  });
  expect(projectState()).toEqual(before);
  expect(store.serialize().equals(bytes)).toBe(true);
  expect(runtimeState()).toEqual(words);
  expect(await cli()).toMatchObject({ code: 0, out: expect.stringMatching(/settled P1 by d:7/i) });
  const after = projectState();
  expect(after.decisions).toEqual(before.decisions);
  expect(after.drafts[0]).toMatchObject({
    outcome: 'answered',
    record_id: 'd:7',
    approval_mode: 'settled',
    settled_by: harnessSessionHash('another-writing-chat'),
    answered_at: expect.any(String),
  });
  for (const i of [1, 2])
    expect(after.drafts[i]).toEqual({ ...(before.drafts[i] as object), settled_by: null });
  expect(runtimeState()).toEqual(words);
  expect(await cli(selected.map((arg) => (arg === '7' ? '8' : arg)))).toMatchObject({
    code: 0,
    out: expect.stringMatching(/already answered as d:7/i),
  });
  expect(projectState()).toEqual(after);
});

it.each([
  ['another harness', "UPDATE sessions SET owner_key = 'ext:someone-else'"],
  ['null origin', 'UPDATE proposals SET source_session = NULL'],
  ['another project', "UPDATE strategic_decisions SET project_id = 'elsewhere'"],
  ['foreign session', "UPDATE sessions SET project_id='elsewhere'"],
  ['unknown kind', "UPDATE proposals SET kind='other'"],
  ['expired', "UPDATE proposals SET created_at = datetime('now','-8 days')"],
  ['future', "UPDATE strategic_decisions SET created_at = datetime('now','+1 day')"],
  ['unreadable time', "UPDATE strategic_decisions SET created_at = 'yesterday'"],
  ['superseded', 'UPDATE strategic_decisions SET superseded_by=id'],
  ['archived', "UPDATE strategic_decisions SET status='archived'"],
  ['autonomous', "UPDATE strategic_decisions SET approval_mode='autonomous'"],
  [
    'duplicate answer',
    'INSERT INTO strategic_decisions(id,decision_text,created_at,status,author_session_id,project_id) SELECT 8,decision_text,created_at,status,author_session_id,project_id FROM strategic_decisions',
  ],
])(
  'leaves both stores unchanged when the selected evidence is ineligible: %s',
  async (_name, sql) => {
    store.exec(sql);
    await expectRefused(/refused/i);
  }
);

it.each([
  [
    'three starts',
    (db: Database.Database) => {
      const add = db.prepare('INSERT INTO starts(at) VALUES(?)');
      for (let i = 0; i < 3; i++) add.run(Date.now());
    },
  ],
  [
    'retained decline',
    (db: Database.Database) =>
      db.prepare('INSERT INTO pending_declines(draft_id,at) VALUES(1,?)').run(Date.now()),
  ],
  ['approval in another session', (db: Database.Database) => excerpt(db, 1, 'approval')],
  [
    'live window',
    (db: Database.Database) =>
      db
        .prepare("INSERT INTO windows(session,draft_ids,open,at) VALUES('other','[1]',1,?)")
        .run(Date.now()),
  ],
  [
    'unreadable window',
    (db: Database.Database) =>
      db
        .prepare("INSERT INTO windows(session,draft_ids,open,at) VALUES('other','bad-json',1,?)")
        .run(Date.now()),
  ],
  ['missing declines', (db: Database.Database) => db.exec('DROP TABLE pending_declines')],
  ['unrecognized live reply', (db: Database.Database) => excerpt(db, 1, 'unknown')],
  ['missing starts', (db: Database.Database) => db.exec('DROP TABLE starts')],
  ['missing windows', (db: Database.Database) => db.exec('DROP TABLE windows')],
])('cannot take a draft when its private runtime says %s', async (_name, setup) => {
  setup(runtime.db);
  await expectRefused(/refused/i);
});

it.each([
  ['--draft', 'P2'],
  ['--decision', '7'],
  ['--decision', '8'],
  ['--project-root', '.'],
  ['--dry-run', '--dry-run'],
  ['--all'],
  ['extra'],
])('rejects duplicate, conflicting or foreign arguments before linking (%j)', async (...extra) => {
  const answer = await cli([...selected, ...extra]);
  expect(answer.code).toBe(1);
  expect(store.prepare('SELECT outcome FROM proposals').pluck().get()).toBe('pending');
});

it('refuses unsafe or absent runtime files without initializing a replacement', async () => {
  const file = runtime.path;
  runtime.close();
  const moved = file + '.original';
  fs.renameSync(file, moved);
  expect((await cli()).code).toBe(1);
  expect(fs.existsSync(file)).toBe(false);
  fs.symlinkSync(moved, file);
  expect((await cli()).code).toBe(1);
  expect(store.prepare('SELECT outcome FROM proposals').pluck().get()).toBe('pending');
});

it('checks both locks on previews and revalidates a revision after the other writer commits', async () => {
  for (const held of [runtime.db, store]) {
    held.exec('BEGIN IMMEDIATE');
    try {
      expect(await cli([...selected, '--dry-run'])).toMatchObject({
        code: 1,
        err: expect.stringMatching(/busy|locked/i),
      });
    } finally {
      held.exec('ROLLBACK');
    }
  }
  store.exec(
    "BEGIN IMMEDIATE; UPDATE proposals SET outcome='replaced',replaced_by=8 WHERE id=1; COMMIT"
  );
  await expectRefused(/replaced/i);
});

it('refuses a review agent and the directory edition before creating a writable runtime', async () => {
  const file = runtime.path;
  runtime.close();
  fs.unlinkSync(file);
  for (const setting of [{ RBOOK_AGENT_ROLE: 'review' }, { RBOOK_EDITION: 'directory' }]) {
    expect((await cli(selected, { ...env, ...setting })).code).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  }
});

it.each([
  [
    'a restrictive row constraint',
    "ALTER TABLE proposals DROP COLUMN settled_by; ALTER TABLE proposals ADD COLUMN allowed INTEGER CHECK(outcome != 'answered')",
  ],
  [
    'a deferred reference',
    'CREATE TABLE allowed_links(link TEXT PRIMARY KEY); ALTER TABLE proposals DROP COLUMN record_id; ALTER TABLE proposals ADD COLUMN record_id TEXT REFERENCES allowed_links(link) DEFERRABLE INITIALLY DEFERRED',
  ],
  [
    'a deferred reference to the selected outcome',
    "CREATE UNIQUE INDEX outcomes ON proposals(outcome); CREATE TABLE prior_outcome(value TEXT REFERENCES proposals(outcome) DEFERRABLE INITIALLY DEFERRED); INSERT INTO prior_outcome VALUES('pending')",
  ],
  ['missing audit field', 'ALTER TABLE proposals DROP COLUMN answered_at'],
  ['an existing target', "UPDATE proposals SET record_id='d:9'"],
  ['a preserved audit mark', "UPDATE proposals SET settled_by='previous-writer'"],
  ['an unknown approval mode', "UPDATE strategic_decisions SET approval_mode='unknown'"],
  ['a broken revision', 'UPDATE proposals SET replaced_by=22'],
])('refuses the same unsupported state on preview and apply: %s', async (_name, sql) => {
  store.exec(sql);
  await expectRefused(/refused/i);
});

it('predicts whether SQLite can change a project file with its write permission removed', async () => {
  const mode = fs.statSync(store.name).mode;
  try {
    fs.chmodSync(store.name, 0o444);
    const before = projectState();
    const preview = await cli([...selected, '--dry-run']);
    expect(projectState()).toEqual(before);
    const actual = await cli();
    expect(preview.code).toBe(actual.code);
    if (process.getuid?.()) expect(actual.code).toBe(1);
  } finally {
    fs.chmodSync(store.name, mode);
  }
});

it.each(['decline', 'revision'])(
  'keeps both stores reserved through the selected write before a racing %s',
  async (other) => {
    store.pragma('busy_timeout=0');
    runtime.db.pragma('busy_timeout=0');
    const real = matcher.privateAnswerMatches;
    const check = jest.spyOn(matcher, 'privateAnswerMatches').mockImplementation((...input) => {
      expect(() => runtime.db.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
      expect(() => store.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
      return real(...input);
    });
    try {
      expect(await cli()).toMatchObject({ code: 0 });
      expect(check).toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
    if (other === 'revision')
      expect(markReplaced(rawRunner(store), 1, 2, new Date().toISOString())).toBe(0);
    else
      expect(
        store
          .prepare("UPDATE proposals SET outcome='declined' WHERE id=1 AND outcome='pending'")
          .run().changes
      ).toBe(0);
    expect(store.prepare('SELECT record_id FROM proposals').pluck().get()).toBe('d:7');
  }
);

it('honors copy write refusals and resolves only decisions already present on a valid shared copy', async () => {
  const previous = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = env.RBOOK_CONFIG_DIR;
  try {
    await share(root, 0);
    const decisionCount = store.prepare('SELECT count(*) FROM strategic_decisions').pluck().get();
    const log = store.prepare('SELECT count(*) FROM record_changes').pluck().get();
    expect(await cli(selected.map((arg) => (arg === '7' ? '83' : arg)))).toMatchObject({
      code: 1,
      err: expect.stringMatching(/sync first/i),
    });
    const registry = ProjectGraphRegistry.getInstance();
    const binding = registry.liveReplicas('fixture')[0];
    const graph = new Database(registry.path);
    try {
      graph
        .prepare('UPDATE replicas SET seq_mark = seq_mark + 50 WHERE replica_id = ?')
        .run(binding.replica_id);
      await expectRefused(/restored|replaced/i);
      graph
        .prepare('UPDATE replicas SET seq_mark = ? WHERE replica_id=?')
        .run(binding.seq_mark, binding.replica_id);
    } finally {
      graph.close();
    }
    expect(await cli()).toMatchObject({
      code: 0,
      out: expect.stringMatching(/settled P1 by d:7/i),
    });
    expect(store.prepare('SELECT count(*) FROM strategic_decisions').pluck().get()).toBe(
      decisionCount
    );
    expect(store.prepare('SELECT count(*) FROM record_changes').pluck().get()).toBe(log);
  } finally {
    ProjectGraphRegistry.resetInstance();
    if (previous === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = previous;
  }
});

it.each([
  ['--draft', '1', '--decision', '7'],
  ['--draft', 'P0', '--decision', '7'],
  ['--draft', 'P1', '--decision', '-7'],
  ['--draft', 'P1', '--decision', '9007199254740993'],
  ['--draft', 'P9007199254740993', '--decision', '7'],
  ['--draft', 'P1', '--decision'],
  ['--draft', '--decision', '7'],
  ['--draft', 'P1', '--decision', '7', '--dry-run=false'],
])('rejects an incomplete or unrepresentable pair in the real CLI (%j)', async (...args) => {
  expect((await cli(['drafts', 'settle', '--project-root', root, ...args])).code).toBe(1);
  expect(store.prepare('SELECT outcome FROM proposals').pluck().get()).toBe('pending');
});

it('waits for project migration recovery and never creates a missing store', async () => {
  fs.writeFileSync(path.join(root, '.rbook-migration.lock'), 'test');
  expect(await cli()).toMatchObject({ code: 1, err: expect.stringMatching(/migration|migrate/i) });
  const missing = path.join(tmp, 'absent-project');
  expect((await cli(selected.map((arg) => (arg === root ? missing : arg)))).code).toBe(1);
  expect(fs.existsSync(missing)).toBe(false);
  expect(store.prepare('SELECT outcome FROM proposals').pluck().get()).toBe('pending');
});

it('leaves both files intact when an existing-file open sees a foreign table or unsafe sidecar', async () => {
  const journal = runtime.path + '-journal';
  fs.symlinkSync(store.name, journal);
  expect((await cli()).code).toBe(1);
  fs.unlinkSync(journal);
  store.exec('ALTER TABLE proposals RENAME TO foreign_proposals');
  expect(await cli()).toMatchObject({
    code: 1,
    err: expect.stringMatching(/unsupported|no such table/i),
  });
  expect(store.prepare("SELECT 1 FROM sqlite_master WHERE name='proposals'").get()).toBeUndefined();
});

it('refuses a cyclic replacement link before trying to settle the selected row', async () => {
  store.exec('UPDATE proposals SET replaced_by=id WHERE id=1');
  await expectRefused(/revision/i);
});

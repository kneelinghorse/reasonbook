// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b fork f23 — a migration that HALF-APPLIES must say so in the answer, not
// ABOUTME: report `alreadyCurrent` and move on. Forced DDL failure, asserted on the rendered text.

/**
 * Sprint 86 m02b, success criterion 15 (fork f23) — the migration half of "say only what you
 * know".
 *
 * WHY THIS MATTERS, not just what is asserted (agents.md Rule 9).
 *
 * `MigrationResult` reports `columnsAdded`, `indexesCreated`, `rowsUpdated`, `alreadyCurrent`.
 * Every one of those fields describes what the migration code INTENDED to do. Before this
 * mission every `client.execute` in `schema-migrations.ts` either discarded its envelope
 * outright or folded it into `if (result.success) list.push(name)` — so a `CREATE INDEX` that
 * the database REJECTED was indistinguishable from an index that was already there. The
 * function then wrote its own "I am done" marker into `metadata` and returned
 * `alreadyCurrent: true`. A half-applied schema is the purest instance of this sprint's defect
 * class: the store is now permanently wrong, the marker guarantees the migration will never
 * retry, and nothing anywhere said a word.
 *
 * THE FIX IS DISCLOSURE, NOT ABORTION. `MigrationResult.warnings` is optional and additive;
 * `success` and the migration's own control flow are unchanged. What changes is that the
 * failure reaches a HUMAN- AND AGENT-READABLE ANSWER.
 *
 * WHICH IS WHY EVERY ASSERTION BELOW LANDS ON THE FORMATTED TEXT. `src/index.ts` returns
 * `content: [{type:'text', text: formatSessionForLLM(...)}]` beside `structuredContent`; an
 * agent reads the text. A warning that exists only on `result.warnings` and is rendered by no
 * formatter is the exact shipped-invisible failure s85-m04's `missionId` advisory suffered.
 * Producer-side alone is NOT the criterion — reaching a rendered answer is.
 *
 * NO MOCK CLIENT ANYWHERE (agents.md Process Hardening #4). A mock that returns
 * `{success:false}` proves the plumbing and nothing about the SQL. Every failure here is forced
 * at the DATABASE, on a real `seedRbookDb` store in an `fs.mkdtempSync` directory. The live
 * `rbook/db/rbook.sqlite` is never opened.
 *
 * THE FORCING MECHANISM, stated so a later reader can re-derive it:
 *   `ensureAuthorNamespaceColumns` step 2 runs
 *   `CREATE INDEX IF NOT EXISTS idx_learnings_author_session ON learnings (author_session_id)`.
 *   In SQLite, indexes and tables/views share ONE name namespace, and `IF NOT EXISTS` only
 *   suppresses the error when the existing object is an index of that name. So the fixture drops
 *   the seeded index and creates a VIEW under the same name; the migration's CREATE INDEX then
 *   fails with `there is already a table named idx_learnings_author_session`. That statement is
 *   one of the twenty `schema-migrations.ts` sites fork f23 covers (the folded
 *   `if (created.success && !hadNew)` arm), and it is reached only when the `metadata` marker
 *   gate is OPEN — which the "marker gate CLOSED" negative control below proves by closing it.
 *
 * DIVERGENCE FROM THE CRITERION'S LITERAL WORDING — READ THIS BEFORE "FIXING" THE TEST.
 * Criterion 15 says to force an ALTER TABLE failure. NO `ALTER TABLE` inside
 * `ensureAuthorNamespaceColumns` routes through `checkWrite`: all three of them
 * (`ensureRenamedColumn`'s RENAME/ADD at schema-migrations.ts, and the two
 * `ADD COLUMN author_user_id` / `ADD COLUMN user_id` sites) inspect `result.success` and THROW
 * `SchemaMigrationError`. They were already fail-LOUD before this mission and were therefore
 * never in fork f23's ten-site list, which names the DROP INDEX and the marker INSERT in this
 * function. The "DIVERGENCE, PINNED" test below forces one anyway and asserts the ACTUAL
 * behaviour — a failed RENAME REJECTS the `rbook_session(capture)` promise instead of surfacing
 * in its text — so the divergence is recorded rather than papered over.
 *
 * CONSUMER COMPLETENESS lives in migration-warning-reachability.test.ts. Its TypeChecker census
 * resolves exported MigrationResult-compatible producers (including subtype returns), resolves
 * their shipped callers by symbol, and verifies every reachable answer consumes `.warnings`.
 * The historical text assertions below retain the original six regression anchors only; they no
 * longer pretend that six was the whole consumer surface.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import {
  rbookSessionCapture,
  formatSessionCaptureForLLM,
} from '../../../src/tools/rbook/rbook-session-capture';
import {
  rbookLearningsList,
  formatLearningsListForLLM,
} from '../../../src/tools/rbook/rbook-learnings-list';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  AUTHOR_NAMESPACE_SCHEMA_VERSION,
  ensureAuthorNamespaceColumns,
} from '../../../src/tools/rbook/schema-migrations';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const SRC_ROOT = path.resolve(__dirname, '../../../src');
const MIGRATIONS_FILE = path.join(SRC_ROOT, 'tools/rbook/schema-migrations.ts');

/** The `metadata` key whose presence makes `ensureAuthorNamespaceColumns` return early. */
const MARKER_KEY = 'author_namespace_columns';
/** The index the migration recreates in step 2 — and the name the fixture collides with. */
const COLLIDING_INDEX = 'idx_learnings_author_session';

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A temp project whose store is a fresh `seedRbookDb` fixture.
 *
 * NOTE ON FIXTURE FIDELITY (seedRbookDb's own header): a fixture is born into the CURRENT
 * `schema.ts`, so `author_session_id` / `author_user_id` / `user_id` and both
 * `idx_*_author_session` indexes already exist. That is exactly the state this test needs —
 * every step of `ensureAuthorNamespaceColumns` is then a no-op EXCEPT the one the fixture
 * deliberately breaks, so a warning that appears can only have come from that statement.
 */
function newProject(prefix: string): { projectRoot: string; dbPath: string } {
  const projectRoot = mkTmp(prefix);
  const dbPath = seedRbookDb(projectRoot, { projectName: 'm02b migration warnings' });
  reidentifyRbookTestStore(projectRoot);
  return { projectRoot, dbPath };
}

/** Insert an active session directly, so no handler runs (and no migration marker is set). */
function seedActiveSession(dbPath: string, sessionId: string): void {
  const db = new Database(dbPath);
  try {
    const projectId =
      (
        db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
          | { value: string }
          | undefined
      )?.value ?? 'test-project';
    db.prepare(
      `INSERT INTO sessions
         (id, type, title, sprint_id, started_at, agent, status, captures,
          project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      'build',
      's86-m02b migration-warning fixture',
      null,
      new Date().toISOString(),
      'jest',
      'active',
      '[]',
      projectId,
      `M02B${sessionId.replace(/\D/g, '')}`.padEnd(26, '0'),
      Date.now(),
      1,
      'session_started',
      1
    );
  } finally {
    db.close();
  }
}

/**
 * Break the `CREATE INDEX` inside `ensureAuthorNamespaceColumns` step 2 at the DATABASE.
 * Returns nothing — the assertions that the gate is open live in the tests, on purpose.
 */
function collideTheIndexName(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`DROP INDEX ${COLLIDING_INDEX}`);
    db.exec(`CREATE VIEW ${COLLIDING_INDEX} AS SELECT 1 AS collided`);
  } finally {
    db.close();
  }
}

function readMarker(dbPath: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(MARKER_KEY) as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
}

async function captureADecision(projectRoot: string, sessionId: string) {
  const result = await rbookSessionCapture({
    sessionId,
    category: 'decision',
    content: `s86-m02b migration-warning probe ${sessionId}`,
    projectRoot,
  });
  return { result, text: formatSessionCaptureForLLM(result) };
}

/** Occurrence count, so "rendered exactly once" can be asserted rather than "present". */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. THE CLAUSE THAT MATTERS: the failure reaches a RENDERED ANSWER.
// ───────────────────────────────────────────────────────────────────────────────

describe('s86-m02b f23: a half-applied migration is named in the rbook_session(capture) text', () => {
  it('an empty learnings list stays successful and renders its real-SQLite migration warning', async () => {
    const { projectRoot, dbPath } = newProject('rbook-m09-learning-list-warning-');
    const collidedIndex = 'idx_learnings_status';
    const db = new Database(dbPath);
    try {
      db.exec(`DROP INDEX ${collidedIndex}`);
      db.exec(`CREATE VIEW ${collidedIndex} AS SELECT 1 AS collided`);
    } finally {
      db.close();
    }

    // This is deliberately the empty-success render mode. It proves both halves of the route:
    // the handler must splice MigrationResult.warnings, and the formatter must not return before
    // appendWarnings merely because the result set is empty.
    const result = await rbookLearningsList({ projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.learnings).toEqual([]);
    const warnings = (result.warnings ?? []).filter((warning) => warning.includes(collidedIndex));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DB_QUERY_FAILED');

    const text = formatLearningsListForLLM(result);
    expect(text).toContain('No learnings found matching the criteria.');
    expect(text).toContain('Warnings:');
    expect(countOccurrences(text, warnings[0])).toBe(1);
  });

  it('a forced DDL failure inside ensureAuthorNamespaceColumns appears in the ANSWER TEXT', async () => {
    const { projectRoot, dbPath } = newProject('rbook-m02b-mig-fire-');

    // PROBE BEFORE ENCODE (agents.md Process Hardening #5). Two preconditions decide whether
    // this fixture is a reproduction or a tautology, and both are asserted, not assumed.
    expect(readMarker(dbPath)).toBeUndefined(); // (a) the marker gate is OPEN
    const probe = new Database(dbPath, { readonly: true });
    try {
      // (b) `learnings.author_session_id` exists, so step 2 does NOT `continue` past the
      //     index rename before ever reaching the statement we are about to break.
      const cols = (
        probe.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(cols).toContain('author_session_id');
      expect(
        probe.prepare(`SELECT type FROM sqlite_master WHERE name = ?`).get(COLLIDING_INDEX) as {
          type: string;
        }
      ).toEqual({ type: 'index' });
    } finally {
      probe.close();
    }

    collideTheIndexName(dbPath);
    const sessionId = 'PS-2026-08-11-921';
    seedActiveSession(dbPath, sessionId);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    // DISCLOSURE, NOT ABORTION (fork f09). The capture DID happen; a schema index did not.
    expect(result.success).toBe(true);

    const migrationWarnings = (result.warnings ?? []).filter((w) => w.includes(COLLIDING_INDEX));
    expect(migrationWarnings).toHaveLength(1);
    // The DB error code AND the verbatim DB message, not a generic "migration failed".
    expect(migrationWarnings[0]).toContain('DB_QUERY_FAILED');
    expect(migrationWarnings[0]).toMatch(/already a table named idx_learnings_author_session/);

    // *** THE CRITERION. *** Not `structuredContent` — the string an agent actually reads.
    expect(text).toContain('Warnings:');
    expect(countOccurrences(text, migrationWarnings[0])).toBe(1);
    expect(text).toMatch(/CREATE INDEX idx_learnings_author_session failed/);

    // The text assertion above is load-bearing, and here is the proof: re-render the IDENTICAL
    // result with the envelope channel emptied and the message vanishes. So it is reaching the
    // text through `result.warnings` and a formatter that renders it — not because the string
    // happens to appear on some other line of the answer. Drop `appendWarnings` from this leaf
    // and the assertion above goes red while the structured assertions stay green, which is
    // exactly the shipped-invisible failure mode this mission exists to close.
    expect(formatSessionCaptureForLLM({ ...result, warnings: undefined })).not.toContain(
      COLLIDING_INDEX
    );

    // The capture itself is unharmed: this is a warning channel, not an error channel.
    expect(text).toContain('**Decision Extraction**: Auto-extracted (1)');
    expect(text).not.toContain('Write failures');
  });

  it('NEGATIVE CONTROL: the same fixture without the name collision says nothing at all', async () => {
    // Without this, a test that goes green because the fixture is broken in some unrelated way
    // (missing session, unreadable store, a formatter that prints every warning it can find)
    // would look exactly like a successful reproduction.
    const { projectRoot, dbPath } = newProject('rbook-m02b-mig-clean-');
    const sessionId = 'PS-2026-08-11-922';
    seedActiveSession(dbPath, sessionId);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    expect(result.success).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
    expect(text).not.toContain('Warnings:');
    expect(text).not.toContain(COLLIDING_INDEX);
    expect(text).toContain('**Decision Extraction**: Auto-extracted (1)');
  });

  it('NEGATIVE CONTROL: with the marker gate CLOSED the mechanism cannot fire', async () => {
    // Proves the warning in the first test came from the statement inside
    // ensureAuthorNamespaceColumns and not from some other CREATE INDEX elsewhere in the
    // capture path: pre-set the marker, keep the identical collision, and the function returns
    // early with nothing to say.
    const { projectRoot, dbPath } = newProject('rbook-m02b-mig-gated-');
    collideTheIndexName(dbPath);

    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`).run(
        MARKER_KEY,
        AUTHOR_NAMESPACE_SCHEMA_VERSION
      );
    } finally {
      db.close();
    }

    const sessionId = 'PS-2026-08-11-923';
    seedActiveSession(dbPath, sessionId);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    expect(result.success).toBe(true);
    expect((result.warnings ?? []).filter((w) => w.includes(COLLIDING_INDEX))).toEqual([]);
    expect(text).not.toContain(COLLIDING_INDEX);
  });

  it('the producer reports alreadyCurrent:true for the very run that half-applied — hence warnings', async () => {
    // The reason the field had to exist. `alreadyCurrent`, `columnsAdded` and `indexesCreated`
    // are all statements about INTENT: on the failing run they say "nothing to do here", the
    // marker is written anyway, and no later run will ever retry. `warnings` is the only field
    // that can contradict them.
    const { projectRoot, dbPath } = newProject('rbook-m02b-mig-producer-');
    collideTheIndexName(dbPath);

    const clientResult = await RbookDatabaseClient.create({ projectRoot });
    expect(clientResult.success).toBe(true);
    const client = clientResult.data!;
    try {
      const migration = ensureAuthorNamespaceColumns(client);

      expect(migration.warnings).toBeDefined();
      expect(migration.warnings!.filter((w) => w.includes(COLLIDING_INDEX))).toHaveLength(1);
      // The three intent fields are, on this run, all reassuring and all wrong.
      expect(migration.alreadyCurrent).toBe(true);
      expect(migration.indexesCreated).not.toContain(COLLIDING_INDEX);
      expect(migration.columnsAdded).toEqual([]);
    } finally {
      client.close();
    }

    // And the marker is now set, so the disclosure fires exactly ONCE per store, ever. Recorded
    // deliberately: it is the shape of the residual risk, not an accident of this fixture.
    expect(readMarker(dbPath)).toBe(AUTHOR_NAMESPACE_SCHEMA_VERSION);
  });

  it('DIVERGENCE, PINNED: an ALTER TABLE failure inside the migration THROWS, it does not warn', async () => {
    // Criterion 15 asks for a forced ALTER TABLE failure surfacing in the capture text. It does
    // not, and the reason is a deliberate design choice that predates this mission: every
    // ALTER TABLE reached from ensureAuthorNamespaceColumns is fail-LOUD (SchemaMigrationError),
    // never fail-disclosed, so none of them was in fork f23's site list. This test forces one
    // anyway and pins what SHIPS, so nobody re-derives the question from the plan text.
    //
    // Mechanism: put the store in the pre-s69-m04 shape (strategic_decisions.session_id, no
    // author_session_id) so the RENAME actually runs, then leave a view behind that references a
    // column that does not exist — SQLite reparses every view during ALTER TABLE RENAME COLUMN
    // and refuses.
    const { projectRoot, dbPath } = newProject('rbook-m02b-mig-alter-');
    const db = new Database(dbPath);
    try {
      db.exec('ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id');
      db.exec('CREATE VIEW rbook_m02b_broken_view AS SELECT no_such_col FROM strategic_decisions');
    } finally {
      db.close();
    }

    const sessionId = 'PS-2026-08-11-924';
    seedActiveSession(dbPath, sessionId);

    await expect(
      rbookSessionCapture({
        sessionId,
        category: 'decision',
        content: 'forced ALTER TABLE failure',
        projectRoot,
      })
    ).rejects.toThrow(/ensureRenamedColumn: failed to rename "session_id" → "author_session_id"/);

    // Nothing was half-applied quietly: the marker was never written, so a later run retries.
    expect(readMarker(dbPath)).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. THE STRUCTURAL FACTS THE CODE COMMENTS RECORD, so they cannot rot silently.
// ───────────────────────────────────────────────────────────────────────────────

describe('s86-m02b f23: the structural shape of the migration warnings channel', () => {
  it('MigrationResult.warnings is OPTIONAL', () => {
    // Load-bearing. Fork f23 chose an optional additive field precisely so the other 21
    // exported helpers and their ~57 call sites keep compiling untouched. Making it required
    // would turn a one-file change into a tree-wide one.
    const sf = parse(MIGRATIONS_FILE);
    let iface: ts.InterfaceDeclaration | undefined;
    sf.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'MigrationResult') iface = node;
    });
    expect(iface).toBeDefined();

    const warningsMember = iface!.members.find(
      (m) => ts.isPropertySignature(m) && m.name && (m.name as ts.Identifier).text === 'warnings'
    ) as ts.PropertySignature | undefined;
    expect(warningsMember).toBeDefined();
    expect(warningsMember!.questionToken).toBeDefined();
    expect(warningsMember!.type!.getText(sf)).toBe('string[]');

    // The four pre-existing fields stay REQUIRED — the channel is additive, not a rewrite.
    for (const required of ['columnsAdded', 'indexesCreated', 'rowsUpdated', 'alreadyCurrent']) {
      const member = iface!.members.find(
        (m) => ts.isPropertySignature(m) && m.name && (m.name as ts.Identifier).text === required
      ) as ts.PropertySignature | undefined;
      expect(member).toBeDefined();
      expect(member!.questionToken).toBeUndefined();
    }
  });

  it('no EXPORTED schema-migrations helper takes a warnings sink parameter', () => {
    // Fork f23 REJECTED option (ii) — threading a sink through 22 exported helpers and 57 call
    // sites — because it would have touched every read path. The private helpers may take one
    // (ensureColumn, ensureAggIndex, rebuildTableWithConstraints do); the exported surface may
    // not, or the rejected option has been adopted by drift.
    const sf = parse(MIGRATIONS_FILE);
    const offenders: string[] = [];
    sf.forEachChild((node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name) return;
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) return;
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === 'warnings') {
          offenders.push(node.name.text);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it('schema-migrations.ts discards ZERO client.execute results', () => {
    // The producer-side half of criterion 15: the bare sites route through a guard now. This is
    // scoped to this one module on purpose — the tree-wide gate is no-silent-write.test.ts, and
    // duplicating its classifier here would give two things to update and one to forget.
    const sf = parse(MIGRATIONS_FILE);
    const discarded: number[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'execute'
      ) {
        discarded.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
      node.forEachChild(visit);
    };
    visit(sf);
    expect(discarded).toEqual([]);

    // …and the guard it routes through is the shared one, not a local re-implementation.
    const source = fs.readFileSync(MIGRATIONS_FILE, 'utf8');
    expect(source).toMatch(/import \{ checkWrite, countWrite \} from '\.\/write-guard';/);
  });

  it('retains the original warning paths through direct splices and the shared preflight', () => {
    // Fork f23's original consumer-side regression anchors. The semantic census owns completeness.
    const expected: ReadonlyArray<{ file: string; splices: ReadonlyArray<[string, number]> }> = [
      {
        file: 'tools/rbook/rbook-sprint-complete.ts',
        splices: [
          ['warnings.push(...(ensureFirehoseEventColumns(client).warnings ?? []));', 1],
          ['warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));', 1],
        ],
      },
      {
        file: 'tools/rbook/record-link-write.ts',
        // s94-m06: the capture/complete author migration shares one preflight. The separate
        // symbol-aware reachability gate proves every caller's exact sink through refusals.
        splices: [['warnings.push(...(author.warnings ?? []));', 1]],
      },
      // s96-m08: retired event replay no longer runs the content-hash migration.
    ];

    let total = 0;
    for (const { file, splices } of expected) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      for (const [snippet, count] of splices) {
        expect({ file, snippet, count: countOccurrences(source, snippet) }).toEqual({
          file,
          snippet,
          count,
        });
        total += count;
      }
    }
    expect(total).toBe(3);
    for (const file of ['rbook-session-capture.ts', 'rbook-session-complete.ts']) {
      const source = fs.readFileSync(path.join(SRC_ROOT, 'tools', 'rbook', file), 'utf8');
      expect(
        source.match(/prepareRecordLinkWrite\(client, warnings(?:, category)?\)/g)
      ).toHaveLength(1);
    }
  });

  it('only carrier-less consumer modules remain unspliced, and the doc names that class', () => {
    // These modules have no envelope on their own return type (RankedResult[], GenesisStamp,
    // StalenessResult) — group C, "no answer to attach to". Reachable group B is now wired.
    for (const file of [
      'tools/rbook/fts5-retriever.ts',
      'tools/rbook/genesis-columns.ts',
      'tools/rbook/staleness-detection.ts',
    ]) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      expect({ file, splices: countOccurrences(source, '.warnings ?? []') }).toEqual({
        file,
        splices: 0,
      });
    }

    // The migration module's reach map must still name the structurally unreachable class.
    const migrations = fs.readFileSync(MIGRATIONS_FILE, 'utf8');
    expect(migrations).toContain('STRUCTURAL RESIDUALS');
    expect(migrations).toContain('no answer warning carrier');
    // migrateStrategicDecisionsV21 is reachable via ensureStrategicDecisionsSchema →
    // ensureMissionIdColumn; the old "test-only / ZERO call sites in src/" claim was false.
    expect(migrations).toContain('this helper is NOT test-only');
    expect(migrations).not.toContain('has ZERO call sites in src/');
  });
});

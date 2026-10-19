// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pins every store-level schema label setter, reader, and variable-key canary.
// ABOUTME: Exercises monotonic numeric writes and vector-owned retry semantics on real SQLite.

/**
 * SCOPE SENTENCE
 *
 * `metadata.schema_version` is a NON-AUTHORITATIVE, MONOTONIC HIGH-WATER LABEL: the highest
 * migration generation any migration on this store has reported reaching. It is NOT a ladder
 * position and NOT proof that any lower generation's structures exist (measured: 2 of 21 real
 * fleet stores read 2.4 with zero vec0/FTS objects). NO CODE MAY BRANCH ON IT. Every migration
 * that needs a completion signal owns its OWN marker key in `metadata`.
 *
 * FALSE-NEGATIVE PROFILE
 *
 * 1. “Highest generation” cannot say WHICH migrations ran. Only the dedicated
 *    `firehose_event_columns`, `author_namespace_columns`, `blob_schema_version`, and
 *    `vector_storage_columns`, `decision_shape_columns`, and `record_links_schema` markers can.
 *    The structural v2.1 and v2.2 migrations deliberately
 *    have no marker, so this gate does not claim they do.
 * 2. “No code may branch on it” covers direct executable reads. All 32 shipped literal-token
 *    occurrences are classified below, including the `project_identity` view projection, but a
 *    fully dynamic key and a sync payload remain indirect routes; this syntax gate cannot prove
 *    values obtained through those routes are not branched on.
 * 3. “Monotonic” is closed over the six logical setters classified below, and both mutable paths
 *    atomically re-check the current row before replacement. The seventeen variable-key metadata
 *    writer statements (sixteen INSERT forms and one UPDATE) and their 46 current
 *    declaration/call-site key roles (s96-m13's copy-key writer and block move added two) are a
 *    point-in-time enumeration; a changed ledger forces their keys to be re-audited. The key
 *    ledger cannot read s97-m09's fresh-copy writer, which runs a prepared statement on a plain
 *    connection: its keys are the fixed METADATA_KEYS list in record-fresh-copy.ts, which names
 *    no label, and only this statement census sees it.
 * 4. The label heal runs only on the retrieval path. A store that never performs retrieval does
 *    not heal its label, which is harmless because the label is not a control input.
 *
 * Mutation controls in this file prove the census rejects an extra helper/direct setter, a
 * missing expected role, an extra ARM-3 writer (REPLACE or UPSERT), whitespace/parameterized reads, multiline
 * inserts, direct updates, and an existing generic writer repointed at this key.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import {
  ensureFirehoseEventColumns,
  ensureVectorStorage,
  migrateContentHash,
  migrateStrategicDecisionsV21,
  VECTOR_STORAGE_SCHEMA_VERSION,
} from '../../../src/tools/rbook/schema-migrations';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const MIGRATIONS_FILE = 'tools/rbook/schema-migrations.ts';
const INIT_FILE = 'tools/rbook/rbook-project-init.ts';
const SCHEMA_FILE = 'tools/rbook/schema.ts';
const VECTOR_MARKER_KEY = 'vector_storage_columns';
const FIREHOSE_MARKER_KEY = 'firehose_event_columns';
const LABEL_READ = "SELECT value FROM metadata WHERE key = 'schema_version'";
// s96-m01 (fold): a variable-key UPDATE writes a key named by its caller too, so it is counted.
const VARIABLE_WRITER_RE =
  /INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+metadata\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*\?\s*,\s*\?\s*\)|UPDATE\s+metadata\s+SET\s+value\s*=[^`'";]*?WHERE\s+key\s*=\s*\?/g;

interface SourceSite {
  readonly file: string;
  readonly line: number;
  readonly role: string;
}

interface WriterKeySite extends SourceSite {
  readonly callee: string;
  readonly key: string;
}

type SourceMap = ReadonlyMap<string, string>;

function sortSourceSites<T extends SourceSite>(sites: readonly T[]): T[] {
  return [...sites].sort((a, b) =>
    `${a.file}:${String(a.line).padStart(6, '0')}:${a.role}`.localeCompare(
      `${b.file}:${String(b.line).padStart(6, '0')}:${b.role}`
    )
  );
}

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

function loadSources(): Map<string, string> {
  return new Map(
    sourceFilesUnder(SRC_ROOT).map((file) => [
      path.relative(SRC_ROOT, file).split(path.sep).join('/'),
      fs.readFileSync(file, 'utf8'),
    ])
  );
}

function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isFunctionExpression(current) && current.name) return current.name.text;
    if (
      ts.isArrowFunction(current) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return '<module>';
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function nodeAt(source: ts.SourceFile, position: number): ts.Node {
  let deepest: ts.Node = source;
  visit(source, (node) => {
    if (node.getFullStart() <= position && position < node.getEnd()) deepest = node;
  });
  return deepest;
}

function occurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  for (let from = 0; ; ) {
    const found = text.indexOf(needle, from);
    if (found === -1) return positions;
    positions.push(found);
    from = found + needle.length;
  }
}

/**
 * Whole-src literal census for the ambiguous token itself. This is deliberately broader than a
 * SQL grep: it sees parameter values, UPDATEs, multiline statements, the project_identity view,
 * and the distinct per-row/registry columns. A new occurrence must therefore be classified rather
 * than slipping through a formatting-shaped detector.
 */
function schemaVersionLiteralSites(sources: SourceMap): SourceSite[] {
  const sites: SourceSite[] = [];
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    visit(source, (node) => {
      if (!ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) return;
      const raw = node.getText(source);
      for (const match of raw.matchAll(/\bschema_version\b/g)) {
        const position = node.getStart(source) + (match.index ?? 0);
        sites.push({
          file,
          line: lineOf(source, position),
          role: enclosingFunctionName(node),
        });
      }
    });
  }
  return sortSourceSites(sites);
}

const EXPECTED_SCHEMA_VERSION_LITERALS: readonly SourceSite[] = sortSourceSites([
  // s92-m01 moved these three down (registry default confirmation + ephemeral options); no
  // schema_version literal was added, removed or re-roled. s92-m06 moved every rbook-project-init.ts
  // site down 46 lines (the AGENTS.md writer) and every schema.ts site up 15 (shorter SQL comments);
  // the same moves apply to the init and schema pins below. Nothing was added, removed or re-roled.
  // s93-m12 moved every rbook-project-init.ts site down (a re-init keeps the project's identity,
  // settles it before writing and refuses a different project id; the identity contexts follow a
  // new name or level); the same keys are written, now only when absent or passed.
  // s94-m10/m11: upload-state imports and init remedies move these source locations. The label
  // roles are unchanged; the removed init ambient-adoption write was never a schema-label setter.
  // s94-m04/m05 and integration fixes move source lines again. The 32 label roles and six
  // setters are unchanged; decision shape adds only its dedicated marker to the key ledger.
  // s99-m07: longer renamed identifiers shift four formatted lines; all 32 literal roles and
  // 39 generic-writer key roles were re-derived and compared without line numbers before repinning.
  // s99-m06: resolver/access guards move source lines only. The AST audit still pins the same
  // 32 literal roles, six logical setters and 39 generic-writer key roles; no key changed.
  // s94-m06 adds the owned citation schema and atomic sync units. Label roles remain unchanged;
  // record_links_schema joins only the generic-writer/key ledgers below.
  // s96-m01 (fold): the registry's confirmedCopy option moves these sites down 6 lines.
  // s96-m03 (fold): its configDirectory getter, for the replay base, moves them down 5 more.
  { file: 'intelligence/project-graph-registry.ts', line: 349, role: 'ensureSchema' },
  // Read-only registry projection; does not branch on or write the schema label.
  {
    file: 'intelligence/registered-stores-readonly.ts',
    line: 31,
    role: 'listRegisteredStoresReadOnly',
  },
  { file: 'intelligence/project-graph-registry.ts', line: 427, role: 'register' },
  { file: 'intelligence/project-graph-registry.ts', line: 428, role: 'register' },
  // s95-m06 moved every rbook-project-init.ts site down 6 lines (the seed copy moved to
  // level-files.ts; the level is settled, and an unreadable store refused, before the identity
  // reads) and rbook-project-update.ts's writer down 10; no role was added, removed or changed.
  // s96-m01 (fold): init checks a shared copy before it writes, moving these down 26 lines, and 9
  // more when the check opened read-only.
  // s96-m02: down six more (the author-time stamp for a new store).
  { file: INIT_FILE, line: 809, role: 'rbookProjectInit' },
  { file: INIT_FILE, line: 840, role: 'rbookProjectInit' },
  { file: INIT_FILE, line: 840, role: 'rbookProjectInit' },
  { file: INIT_FILE, line: 1012, role: 'rbookProjectInit' },
  // s96-m02: down five lines (the author stamp's imports). s96-m03: one more (record-guards).
  { file: 'tools/rbook/genesis-columns.ts', line: 34, role: '<module>' },
  // s96-m03: the change log's column classes name schema_version among the recorded genesis
  // columns; it is the row's stamp version, not the store-level label.
  { file: 'tools/rbook/record-columns.ts', line: 47, role: '<module>' },
  // s93-m11 (reads critic fold): the label's read and write moved into raiseSchemaVersionLabel,
  // which stampSchemaVersionAtLeast runs as a lazy repair; the sites below it moved down with the
  // read-deferral of index rebuilds. Nothing was added or removed.
  { file: MIGRATIONS_FILE, line: 130, role: 'raiseSchemaVersionLabel' },
  { file: MIGRATIONS_FILE, line: 135, role: 'raiseSchemaVersionLabel' },
  { file: MIGRATIONS_FILE, line: 145, role: 'raiseSchemaVersionLabel' },
  { file: MIGRATIONS_FILE, line: 148, role: 'raiseSchemaVersionLabel' },
  { file: MIGRATIONS_FILE, line: 164, role: 'raiseSchemaVersionLabel' },
  // s96-m11 moved these sites down 22 and 75 lines (ensureVectorStorageForWrite, then
  // underMigrationLock and markerIs); nothing was added or re-roled.
  { file: MIGRATIONS_FILE, line: 1598, role: 'ensureVectorStorage' },
  { file: MIGRATIONS_FILE, line: 2501, role: 'migrateFirehoseTable' },
  { file: SCHEMA_FILE, line: 128, role: '<module>' },
  // s96-m02: author_name follows author_user_id in each of the eight logged tables, moving each
  // later site down by the tables above it.
  { file: SCHEMA_FILE, line: 146, role: '<module>' },
  { file: SCHEMA_FILE, line: 184, role: '<module>' },
  { file: SCHEMA_FILE, line: 220, role: '<module>' },
  { file: SCHEMA_FILE, line: 273, role: '<module>' },
  // s92-m03 moved the sites below the sessions table down four lines (implicit, owner_key).
  // s93-m06 moved every schema.ts site down one (the proposals import), those below
  // strategic_decisions four more (the approval columns) and those below constraints three more
  // (the proposals table); schema-migrations.ts sites below ensureConstraintEvergreen moved down 28
  // (ensureDecisionApprovalColumns). Nothing was added, removed or re-roled.
  { file: SCHEMA_FILE, line: 320, role: '<module>' },
  { file: SCHEMA_FILE, line: 368, role: '<module>' },
  { file: SCHEMA_FILE, line: 464, role: '<module>' },
  { file: SCHEMA_FILE, line: 494, role: '<module>' },
  { file: SCHEMA_FILE, line: 515, role: '<module>' },
  { file: SCHEMA_FILE, line: 515, role: '<module>' },
  { file: 'tools/rbook/sync-merge.ts', line: 164, role: 'insertSprintRow' },
  { file: 'tools/rbook/sync-merge.ts', line: 192, role: 'insertMissionRow' },
  { file: 'tools/rbook/sync-merge.ts', line: 222, role: 'insertSessionRow' },
  { file: 'tools/rbook/sync-merge.ts', line: 258, role: 'insertDecisionRow' },
  { file: 'tools/rbook/sync-merge.ts', line: 297, role: 'insertLearningRow' },
]);

function staticSql(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * Pin the sixteen generic metadata-writer statements together with every shipped call-site key
 * expression that can reach their wrappers. This closes the natural bypass where an existing
 * `writeMetadata(..., 'owner', ...)` call is silently repointed to `schema_version` without adding
 * another helper declaration.
 */
function metadataWriterKeySites(sources: SourceMap): WriterKeySite[] {
  const sites: WriterKeySite[] = [];
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;

      let callee: string | null = null;
      let key: ts.Expression | undefined;
      if (
        ts.isIdentifier(node.expression) &&
        [
          'writeMetadata',
          'setIfEmpty',
          'writeMeta',
          'writeSpinOutMetadata',
          'writeReplicaKey',
        ].includes(node.expression.text)
      ) {
        callee = node.expression.text;
        key = node.arguments[1];
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'writeSpinOutRow' &&
        node.arguments.length > 2 &&
        ts.isArrayLiteralExpression(node.arguments[2]) &&
        /into metadata\s*\(\s*key\s*,\s*value\s*\)/i.test(staticSql(node.arguments[1]) ?? '')
      ) {
        callee = 'writeSpinOutRow';
        key = node.arguments[2].elements[0];
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'updateMetadata' &&
        node.expression.name.text === 'run'
      ) {
        callee = 'updateMetadata.run';
        key = node.arguments[0];
      } else if (
        (ts.isPropertyAccessExpression(node.expression) &&
          ['execute', 'getOne'].includes(node.expression.name.text) &&
          node.arguments.length > 1 &&
          ts.isArrayLiteralExpression(node.arguments[1])) ||
        // s96-m03: a converted site's `recordedExecute(client, sql, params)` is read as the
        // `client.execute(sql, params)` it replaced, so its key stays pinned.
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'recordedExecute' &&
          node.arguments.length > 2 &&
          ts.isArrayLiteralExpression(node.arguments[2]))
      ) {
        const recorded = ts.isIdentifier(node.expression);
        const sqlArg = node.arguments[recorded ? 1 : 0];
        const params = node.arguments[recorded ? 2 : 1] as ts.ArrayLiteralExpression;
        const verb = recorded
          ? 'execute'
          : (node.expression as ts.PropertyAccessExpression).name.text;
        const sql = staticSql(sqlArg);
        const normalized = sql?.replace(/\s+/g, ' ').toLowerCase() ?? '';
        if (
          verb === 'execute' &&
          normalized.includes('into metadata') &&
          /values\s*\(\s*\?\s*,\s*\?\s*\)/.test(normalized)
        ) {
          callee = 'metadata.execute';
          key = params.elements[0];
        } else if (/^update metadata set value\s*=.*where key\s*=\s*\?/.test(normalized)) {
          // s96-m01 (fold): a variable-key UPDATE's key is its last parameter, WHERE key = ?.
          callee = 'metadata.update';
          key = params.elements[params.elements.length - 1];
        }
      }

      if (!callee) return;
      sites.push({
        file,
        line: lineOf(source, node.getStart(source)),
        role: enclosingFunctionName(node),
        callee,
        key: key?.getText(source) ?? '<missing>',
      });
    });
  }
  return sortSourceSites(sites);
}

const EXPECTED_WRITER_KEYS: readonly WriterKeySite[] = sortSourceSites([
  {
    // s93-m01: the hook CLI's ambient switch — a constant key, never the label.
    // s96-m12: down 14 lines (relevant marks a row whose fields are in conflict).
    file: 'cli/commands.ts',
    line: 374,
    role: 'ambient',
    callee: 'metadata.execute',
    key: 'AMBIENT_METADATA_KEY',
  },
  {
    file: 'tools/rbook/blob-migrations.ts',
    line: 151,
    role: 'setBlobSchemaVersion',
    callee: 'metadata.execute',
    key: 'BLOB_SCHEMA_VERSION_KEY',
  },
  // s96-m01 (fold): down 35 lines, and s96-m02 six more, as above; the keys are unchanged.
  ...[
    [800, "'project_id'"],
    [802, "'project_name'"],
    [806, "'tracelab_project_id'"],
    [857, "'project_type'"],
    [860, "'project_type'"],
    // s93-m12: a store recreated beside an agents file takes back the level its Reasonbook line names.
    [863, "'project_type'"],
    // s94-m11: recreated stores no longer adopt an ambient setting from the agents file.
    [871, "'created_at'"],
  ].map(([line, key]) => ({
    file: INIT_FILE,
    line: Number(line),
    role: 'rbookProjectInit',
    callee: 'updateMetadata.run',
    key: String(key),
  })),
  {
    // s96-m03: down two lines, and read through recordedExecute, which records the change.
    // s96-m12: down one more (its refusal on a member's copy is imported).
    file: 'tools/rbook/rbook-project-update.ts',
    line: 74,
    role: 'rbookProjectUpdate',
    callee: 'metadata.execute',
    key: "'project_type'",
  },
  // s96-m01: a copy's replica identity, written through one helper with each key named.
  // s96-m03: down four lines (the change log's refusal codes). s96-m12: five more (the slot
  // clash and field-in-conflict codes, and the peer-sessions import). s96-m13: nine more (three
  // exchange refusal codes, and this helper's comment naming its one other caller). s97-m10: four
  // more (the oversized-transaction code, and carrying a refusal thrown on purpose whatever its code).
  // s97-m11: two more (the route-ended code).
  {
    file: 'tools/rbook/replica-identity.ts',
    line: 200,
    role: 'writeReplicaKey',
    callee: 'metadata.execute',
    key: 'key',
  },
  ...['REPLICA_KEYS.id', 'REPLICA_KEYS.block', 'REPLICA_KEYS.seq'].map((key, index) => ({
    file: 'tools/rbook/replica-identity.ts',
    line: 209 + index,
    role: 'writeIdentity',
    callee: 'writeReplicaKey',
    key,
  })),
  // s96-m13: a copy's own keys besides its identity, through writeCopyKey, whose key is a CopyKey:
  // the join it asked for, the moves it confirmed, its last new identity and its invite's name.
  // s97-m11: down two (the dashboard share's pending answer, a new copy key).
  {
    file: 'tools/rbook/replica-copy-keys.ts',
    line: 29,
    role: 'writeCopyKey',
    callee: 'writeReplicaKey',
    key: 'key',
  },
  // s96-m13: a copy that lost a block clash moves to a new block under its replica id.
  {
    file: 'tools/rbook/replica-copy-keys.ts',
    line: 41,
    role: 'moveReplicaBlock',
    callee: 'writeReplicaKey',
    key: 'REPLICA_KEYS.block',
  },
  // s96-m01 (fold): the copy's sequence, raised in one variable-key UPDATE; never the label.
  // s96-m12: down eight lines (the five above, and establishReplica marking the open sessions a
  // copy brought, at its first identity only). s96-m13: down nine (the lines above). s97-m10: four.
  // s97-m11: two.
  {
    file: 'tools/rbook/replica-identity.ts',
    line: 323,
    role: 'takeReplicaSeq',
    callee: 'metadata.update',
    key: 'KEYS.seq',
  },
  {
    // s94-m04 owns this marker; it is not the store-level schema label.
    file: 'tools/rbook/decision-shape-migration.ts',
    line: 236,
    role: 'migrateDecisionShapeColumns',
    callee: 'metadata.execute',
    key: 'MARKER',
  },
  // s96-m13: down one line (the member's-copy import), and the keys below five (a member's copy
  // never overwrites the owner or the dashboard keys).
  {
    file: 'tools/rbook/owner-resolution.ts',
    line: 176,
    role: 'writeMetadata',
    callee: 'metadata.execute',
    key: 'key',
  },
  // s96-m02: down three lines (owner resolution keeps the sign-in's identity for author names).
  ...[
    [262, "'dashboard_slug'"],
    [265, "'dashboard_project_id'"],
    [299, "'owner'"],
    [300, "'dashboard_username'"],
  ].map(([line, key]) => ({
    file: 'tools/rbook/owner-resolution.ts',
    line: Number(line),
    role: 'resolveAndPersistOwner',
    callee: 'writeMetadata',
    key: String(key),
  })),
  {
    // s94-m06 owns this backfill marker; it neither reads nor raises the schema label.
    file: 'tools/rbook/record-link-migration.ts',
    line: 50,
    role: 'ensureRecordLinks',
    callee: 'metadata.execute',
    key: 'RECORD_LINKS_MARKER',
  },
  {
    // s96-m02: down two lines (a copied row keeps its own author columns over the stamp's).
    file: 'tools/rbook/spin-out-copy.ts',
    line: 70,
    role: 'copySpinOutTarget',
    callee: 'writeSpinOutMetadata',
    key: '`${SPIN_OUT_ORIGIN_PREFIX}${provenance.kind}:${provenance.targetId}`',
  },
  {
    file: 'tools/rbook/spin-out-copy.ts',
    line: 152,
    role: 'copySpinOutTarget',
    callee: 'writeSpinOutMetadata',
    key: 'operationKey(operation.operationId)',
  },
  {
    file: 'tools/rbook/spin-out-ledger.ts',
    line: 61,
    role: 'writeSpinOutMetadata',
    callee: 'writeSpinOutRow',
    key: 'key',
  },
  {
    file: 'tools/rbook/spin-out-ledger.ts',
    line: 112,
    role: 'reserveSpinOut',
    callee: 'writeSpinOutMetadata',
    key: 'reservationKey(entry.source)',
  },
  {
    file: 'tools/rbook/spin-out-ledger.ts',
    line: 115,
    role: 'reserveSpinOut',
    callee: 'writeSpinOutMetadata',
    key: 'operationKey(operation.operationId)',
  },
  {
    file: 'tools/rbook/spin-out-mark.ts',
    line: 115,
    role: 'markSpinOutSource',
    callee: 'writeSpinOutMetadata',
    key: '`${SPIN_OUT_ROW_PREFIX}${provenance.kind}:${provenance.sourceId}`',
  },
  {
    file: 'tools/rbook/spin-out-mark.ts',
    line: 121,
    role: 'markSpinOutSource',
    callee: 'writeSpinOutMetadata',
    key: 'operationKey(operation.operationId)',
  },
  {
    // s92-m02: the one-time sprint end_date repair's marker — a constant key, never the label.
    // s96-m03: down two lines (a shared record skips the repair).
    file: 'tools/rbook/sprint-end-date-repair.ts',
    line: 140,
    role: 'repairCompletedSprintEndDates',
    callee: 'metadata.execute',
    key: 'END_DATE_REPAIR_MARKER',
  },
  {
    // s93-m11: the first-write staleness repair's ledger — a constant key, never the label.
    // s96-m03: down three lines (a shared record skips the restore).
    // s97-m13: up four (the close-time clock replaced the label cutoff).
    file: 'tools/rbook/staleness-detection.ts',
    line: 777,
    role: 'writeStalenessRepairLedger',
    callee: 'metadata.execute',
    key: 'STALENESS_REPAIR_LEDGER_KEY',
  },
  // s96-m08: retired clone no longer has metadata writers.
  {
    file: 'tools/rbook/sync-locks.ts',
    line: 20,
    role: 'writeMeta',
    callee: 'metadata.execute',
    key: 'key',
  },
  {
    file: 'tools/rbook/sync-locks.ts',
    line: 61,
    role: 'resolvePlatformProjectId',
    callee: 'writeMeta',
    key: 'cacheKey',
  },
  {
    file: 'tools/rbook/sync-merge.ts',
    line: 362,
    role: 'persistPullCursor',
    callee: 'metadata.execute',
    key: 'pullCursorKey(slug)',
  },
  {
    file: 'tools/rbook/sync-mutable.ts',
    line: 229,
    role: 'writeMeta',
    callee: 'metadata.execute',
    key: 'key',
  },
  {
    file: 'tools/rbook/sync-mutable.ts',
    line: 249,
    role: 'setCollabRole',
    callee: 'writeMeta',
    key: 'COLLAB_ROLE_KEY',
  },
  {
    file: 'tools/rbook/sync-mutable.ts',
    line: 291,
    role: 'writeStatusState',
    callee: 'writeMeta',
    key: 'statusStateKey(scope, entityId)',
  },
  {
    file: 'tools/rbook/sync-mutable.ts',
    line: 310,
    role: 'nextOriginSeq',
    callee: 'writeMeta',
    key: 'ORIGIN_SEQ_KEY',
  },
]);

function logicalSetterSites(sources: SourceMap): SourceSite[] {
  const sites: SourceSite[] = [];
  const schemaText = sources.get(SCHEMA_FILE) ?? '';
  const schemaSource = parseSource(SCHEMA_FILE, schemaText);
  const seedNeedle =
    "INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '${RBOOK_SCHEMA_VERSION}')";
  for (const position of occurrences(schemaText, seedNeedle)) {
    sites.push({ file: SCHEMA_FILE, line: lineOf(schemaSource, position), role: 'seed:ignore' });
  }

  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'stampSchemaVersionAtLeast'
      ) {
        sites.push({
          file,
          line: lineOf(source, node.getStart(source)),
          role: `migration:${enclosingFunctionName(node)}:${node.arguments[1]?.getText(source) ?? '<missing>'}`,
        });
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'run' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'schema_version'
      ) {
        sites.push({
          file,
          line: lineOf(source, node.getStart(source)),
          role: `prepared-run:${enclosingFunctionName(node)}:${node.arguments[1]?.getText(source) ?? '<missing>'}`,
        });
      }
    });
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

const EXPECTED_LOGICAL_SETTERS: readonly SourceSite[] = [
  // s96-m01: down one line (init imports rawGenesisColumns).
  // s96-m01 (fold): down 35 lines, and s96-m02 six more, as the init sites above.
  { file: INIT_FILE, line: 821, role: 'prepared-run:rbookProjectInit:RBOOK_SCHEMA_VERSION' },
  {
    file: MIGRATIONS_FILE,
    line: 326,
    role: "migration:migrateStrategicDecisionsV21:'2.1'",
  },
  { file: MIGRATIONS_FILE, line: 596, role: "migration:migrateContentHash:'2.2'" },
  // s96-m11 moved this setter down 22 lines (ensureVectorStorageForWrite above it).
  { file: MIGRATIONS_FILE, line: 1837, role: 'migration:ensureVectorStorage:labelVersion' },
  // s96-m11: the same setter, moved into applyFirehoseEventColumns, which
  // ensureFirehoseEventColumns now runs under the store's write lock.
  {
    file: MIGRATIONS_FILE,
    // s96-m01 (fold): down 50 lines (sharing's every-table checks and readiness above it).
    line: 2684,
    role: 'migration:applyFirehoseEventColumns:FIREHOSE_SCHEMA_VERSION',
  },
  { file: SCHEMA_FILE, line: 128, role: 'seed:ignore' },
].sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));

function variableWriterSites(sources: SourceMap): SourceSite[] {
  const sites: SourceSite[] = [];
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    for (const match of text.matchAll(VARIABLE_WRITER_RE)) {
      const position = match.index ?? 0;
      sites.push({
        file,
        line: lineOf(source, position),
        role: enclosingFunctionName(nodeAt(source, position)),
      });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file));
}

const EXPECTED_VARIABLE_WRITER_FILES = [
  // s93-m01: the hook CLI's per-project ambient switch (key AMBIENT_METADATA_KEY, a constant).
  'cli/commands.ts',
  'tools/rbook/blob-migrations.ts',
  // s94-m04: the atomic decision-fields migration's own completion marker.
  'tools/rbook/decision-shape-migration.ts',
  'tools/rbook/owner-resolution.ts',
  'tools/rbook/rbook-project-init.ts',
  'tools/rbook/rbook-project-update.ts',
  // s97-m09: a fresh copy of a shared record copies the fixed METADATA_KEYS list from its source
  // (the project's keys, the copy's identity, clock, moves and author marker); never the label.
  'tools/rbook/record-fresh-copy.ts',
  // s94-m06: atomic citation-schema creation/backfill stamps only RECORD_LINKS_MARKER.
  'tools/rbook/record-link-migration.ts',
  // s96-m12: a merge writes the recorded metadata identity keys its live changes give; only the
  // five recorded keys are ever captured, never the schema label.
  'tools/rbook/record-materialize.ts',
  // s96-m03: the replay check applies recorded metadata identity keys to a scratch copy of the
  // replay base; only the five recorded keys are ever captured, never the schema label.
  'tools/rbook/record-replay.ts',
  // s96-m12: an identity settle writes the one recorded metadata key it settles.
  'tools/rbook/record-settle.ts',
  // s96-m01: a copy's replica id, block and sequence (REPLICA_KEYS); never the schema label. The
  // second statement is the variable-key UPDATE that raises the sequence.
  'tools/rbook/replica-identity.ts',
  'tools/rbook/replica-identity.ts',
  // s94-m08: operation, reservation and row/provenance keys; never the schema label.
  'tools/rbook/spin-out-ledger.ts',
  // s92-m02: the one-time sprint end_date repair's marker (key END_DATE_REPAIR_MARKER, a constant).
  'tools/rbook/sprint-end-date-repair.ts',
  // s93-m11: the staleness repair's ledger (key STALENESS_REPAIR_LEDGER_KEY, a constant).
  'tools/rbook/staleness-detection.ts',
  'tools/rbook/sync-locks.ts',
  'tools/rbook/sync-merge.ts',
  'tools/rbook/sync-mutable.ts',
] as const;

function literalLabelReaders(sources: SourceMap): SourceSite[] {
  const sites: SourceSite[] = [];
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    for (const position of occurrences(text, LABEL_READ)) {
      sites.push({
        file,
        line: lineOf(source, position),
        role: enclosingFunctionName(nodeAt(source, position)),
      });
    }
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

function literalLabelSinks(sources: SourceMap): SourceSite[] {
  const sites: SourceSite[] = [];
  const sinkRe = /INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO\s+metadata[^\n]*'schema_version'/g;
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    for (const match of text.matchAll(sinkRe)) {
      const position = match.index ?? 0;
      sites.push({
        file,
        line: lineOf(source, position),
        role: enclosingFunctionName(nodeAt(source, position)),
      });
    }
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

function auditSources(sources: SourceMap): string[] {
  const findings: string[] = [];
  const setters = logicalSetterSites(sources);
  if (JSON.stringify(setters) !== JSON.stringify(EXPECTED_LOGICAL_SETTERS)) {
    findings.push(`logical setters changed: ${JSON.stringify(setters)}`);
  }

  const variableWriters = variableWriterSites(sources);
  const variableFiles = variableWriters.map((site) => site.file);
  if (JSON.stringify(variableFiles) !== JSON.stringify(EXPECTED_VARIABLE_WRITER_FILES)) {
    findings.push(`ARM 3 variable-key writers changed: ${JSON.stringify(variableWriters)}`);
  }

  const readers = literalLabelReaders(sources);
  const expectedReaders: readonly SourceSite[] = [
    { file: MIGRATIONS_FILE, line: 130, role: 'raiseSchemaVersionLabel' },
    { file: SCHEMA_FILE, line: 515, role: '<module>' },
  ];
  if (JSON.stringify(readers) !== JSON.stringify(expectedReaders)) {
    findings.push(`literal label readers changed: ${JSON.stringify(readers)}`);
  }

  const sinks = literalLabelSinks(sources);
  const expectedSinks: readonly SourceSite[] = [
    { file: MIGRATIONS_FILE, line: 145, role: 'raiseSchemaVersionLabel' },
    { file: SCHEMA_FILE, line: 128, role: '<module>' },
  ];
  if (JSON.stringify(sinks) !== JSON.stringify(expectedSinks)) {
    findings.push(`literal label sinks changed: ${JSON.stringify(sinks)}`);
  }

  const migrationText = sources.get(MIGRATIONS_FILE) ?? '';
  const migrationSource = parseSource(MIGRATIONS_FILE, migrationText);
  const vectorReads: string[] = [];
  let versionMatchIdentifiers = 0;
  visit(migrationSource, (node) => {
    if (ts.isIdentifier(node) && node.text === 'versionMatch') versionMatchIdentifiers += 1;
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      node.getText(migrationSource).includes("WHERE key IN ('vector_storage_columns'") &&
      node.getText(migrationSource).includes("'schema_version'") &&
      node.getText(migrationSource).includes("'firehose_event_columns'")
    ) {
      vectorReads.push(enclosingFunctionName(node));
    }
  });
  if (JSON.stringify(vectorReads) !== JSON.stringify(['ensureVectorStorage'])) {
    findings.push(`vector three-key read changed: ${JSON.stringify(vectorReads)}`);
  }
  if (versionMatchIdentifiers !== 0) {
    findings.push(`versionMatch identifiers found: ${versionMatchIdentifiers}`);
  }

  const initText = sources.get(INIT_FILE) ?? '';
  const initSource = parseSource(INIT_FILE, initText);
  const parameterizedInitReads: SourceSite[] = [];
  visit(initSource, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'prepare' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'SELECT value FROM metadata WHERE key = ?'
    ) {
      parameterizedInitReads.push({
        file: INIT_FILE,
        line: lineOf(initSource, node.getStart(initSource)),
        role: enclosingFunctionName(node),
      });
    }
  });
  if (
    JSON.stringify(parameterizedInitReads) !==
    JSON.stringify([{ file: INIT_FILE, line: 791, role: 'rbookProjectInit' }])
  ) {
    findings.push(
      `parameterized init label read changed: ${JSON.stringify(parameterizedInitReads)}`
    );
  }

  const helper = migrationSource.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'stampSchemaVersionAtLeast'
  );
  if (
    !helper ||
    helper.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    findings.push('stampSchemaVersionAtLeast must exist and remain module-private');
  }

  const literalSites = schemaVersionLiteralSites(sources);
  if (JSON.stringify(literalSites) !== JSON.stringify(EXPECTED_SCHEMA_VERSION_LITERALS)) {
    findings.push(`schema_version literal census changed: ${JSON.stringify(literalSites)}`);
  }

  const writerKeys = metadataWriterKeySites(sources);
  if (JSON.stringify(writerKeys) !== JSON.stringify(EXPECTED_WRITER_KEYS)) {
    findings.push(`metadata writer key ledger changed: ${JSON.stringify(writerKeys)}`);
  }
  return findings;
}

function mutate(
  sources: SourceMap,
  file: string,
  transform: (text: string) => string
): Map<string, string> {
  const copy = new Map(sources);
  copy.set(file, transform(copy.get(file) ?? ''));
  return copy;
}

const SHIPPED_SOURCES = loadSources();

describe('schema_version static contract', () => {
  it('keeps the scope and all four false-negative complements in this gate header', () => {
    const ownSource = fs.readFileSync(__filename, 'utf8');
    const header = ownSource.slice(0, ownSource.indexOf('import { afterAll'));
    for (const phrase of [
      'NON-AUTHORITATIVE, MONOTONIC HIGH-WATER LABEL',
      'NOT proof that any lower generation',
      'measured: 2 of 21 real',
      'fleet stores read 2.4 with zero vec0/FTS objects',
      'NO CODE MAY BRANCH ON',
      'owns its OWN marker key',
      'cannot say WHICH migrations ran',
      'project_identity` view',
      'six logical setters',
      'seventeen variable-key',
      'retrieval path',
    ]) {
      expect(header).toContain(phrase);
    }
  });

  it('pins setters, literal accesses, and every generic-writer call-site key', () => {
    expect(auditSources(SHIPPED_SOURCES)).toEqual([]);
    expect(logicalSetterSites(SHIPPED_SOURCES)).toEqual(EXPECTED_LOGICAL_SETTERS);
    // One statement per EXPECTED_VARIABLE_WRITER_FILES. s94-m10 changed the owner's statement
    // from REPLACE to a no-op-aware UPSERT; it remains a variable-key writer in this census.
    expect(variableWriterSites(SHIPPED_SOURCES)).toHaveLength(
      EXPECTED_VARIABLE_WRITER_FILES.length
    );
    expect(schemaVersionLiteralSites(SHIPPED_SOURCES)).toEqual(EXPECTED_SCHEMA_VERSION_LITERALS);
    expect(metadataWriterKeySites(SHIPPED_SOURCES)).toEqual(EXPECTED_WRITER_KEYS);
    expect(literalLabelReaders(SHIPPED_SOURCES)).toEqual([
      { file: MIGRATIONS_FILE, line: 130, role: 'raiseSchemaVersionLabel' },
      { file: SCHEMA_FILE, line: 515, role: '<module>' },
    ]);
  });

  it.each([
    {
      name: 'an extra helper caller',
      text: `\nfunction mutant(client: RbookDatabaseClient, warnings: string[]): void { stampSchemaVersionAtLeast(client, '9.9', warnings); }\n`,
      finding: 'logical setters changed',
    },
    {
      name: 'a direct literal sink',
      text: `\nfunction mutant(client: RbookDatabaseClient): void { client.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '9.9')", []); }\n`,
      finding: 'literal label sinks changed',
    },
  ])('mutation control rejects $name', ({ text, finding }) => {
    const changed = mutate(SHIPPED_SOURCES, MIGRATIONS_FILE, (source) => source + text);
    const changedSites =
      finding === 'logical setters changed'
        ? logicalSetterSites(changed)
        : literalLabelSinks(changed);
    const shippedSites =
      finding === 'logical setters changed'
        ? logicalSetterSites(SHIPPED_SOURCES)
        : literalLabelSinks(SHIPPED_SOURCES);
    expect(changedSites).not.toEqual(shippedSites);
  });

  it('mutation control rejects a removed expected setter role', () => {
    const changed = mutate(SHIPPED_SOURCES, MIGRATIONS_FILE, (source) =>
      source.replace(
        "stampSchemaVersionAtLeast(client, '2.1', warnings);",
        "renamedStampSchemaVersionAtLeast(client, '2.1', warnings);"
      )
    );
    expect(logicalSetterSites(changed)).not.toEqual(EXPECTED_LOGICAL_SETTERS);
  });

  it.each([
    'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'UPDATE metadata SET value = ? WHERE key = ?',
  ])('mutation control rejects an extra variable-key writer using %s', (sql) => {
    const changed = mutate(
      SHIPPED_SOURCES,
      MIGRATIONS_FILE,
      (source) =>
        `${source}\nfunction mutantWriter(client: RbookDatabaseClient, key: string, value: string): void { client.execute(${JSON.stringify(sql)}, [key, value]); }\n`
    );
    expect(variableWriterSites(changed)).toHaveLength(EXPECTED_VARIABLE_WRITER_FILES.length + 1);
    expect(metadataWriterKeySites(changed)).toHaveLength(EXPECTED_WRITER_KEYS.length + 1);
  });

  it('mutation control rejects a direct behavioural label reader outside the helper', () => {
    const changed = mutate(
      SHIPPED_SOURCES,
      MIGRATIONS_FILE,
      (source) =>
        `${source}\nfunction mutantRead(client: RbookDatabaseClient) { return client.getOne("${LABEL_READ}", []); }\n`
    );
    expect(literalLabelReaders(changed)).not.toEqual(literalLabelReaders(SHIPPED_SOURCES));
  });

  it.each([
    {
      name: 'a whitespace-varied parameterized SELECT',
      text: `\nfunction mutantParameterizedRead(client: RbookDatabaseClient) { return client.getOne("SELECT value\\nFROM metadata\\nWHERE key = ?", ['schema_version']); }\n`,
    },
    {
      name: 'a multiline INSERT',
      text: `\nfunction mutantMultilineInsert(client: RbookDatabaseClient) { return client.execute("INSERT OR REPLACE INTO metadata (key, value)\\nVALUES ('schema_version', '9.9')", []); }\n`,
    },
    {
      name: 'a direct UPDATE',
      text: `\nfunction mutantUpdate(client: RbookDatabaseClient) { return client.execute("UPDATE metadata SET value = '9.9' WHERE key = 'schema_version'", []); }\n`,
    },
  ])('literal census rejects $name', ({ text }) => {
    const changed = mutate(SHIPPED_SOURCES, MIGRATIONS_FILE, (source) => source + text);
    expect(schemaVersionLiteralSites(changed)).not.toEqual(EXPECTED_SCHEMA_VERSION_LITERALS);
  });

  it('writer-key ledger follows the spin-out wrapper and rejects a repointed operation key', () => {
    const changed = mutate(SHIPPED_SOURCES, 'tools/rbook/spin-out-ledger.ts', (source) =>
      source.replace(
        'writeSpinOutMetadata(client, operationKey(operation.operationId), operation)',
        "writeSpinOutMetadata(client, 'schema_version', operation)"
      )
    );
    expect(metadataWriterKeySites(changed)).not.toEqual(EXPECTED_WRITER_KEYS);
    expect(
      metadataWriterKeySites(changed).filter((site) => site.key === "'schema_version'")
    ).toHaveLength(1);
  });

  it('writer-key ledger rejects repointing an existing helper call to the label', () => {
    const changed = mutate(SHIPPED_SOURCES, 'tools/rbook/owner-resolution.ts', (source) =>
      source.replace(
        "writeMetadata(client, 'owner', trimmed, warnings);",
        "writeMetadata(client, 'schema_version', trimmed, warnings);"
      )
    );
    expect(metadataWriterKeySites(changed)).not.toEqual(EXPECTED_WRITER_KEYS);
  });

  it('writer-key ledger includes compact metadata writes and rejects marker repointing', () => {
    const file = 'tools/rbook/record-link-migration.ts';
    const markerSite = {
      file,
      line: 50,
      role: 'ensureRecordLinks',
      callee: 'metadata.execute',
      key: 'RECORD_LINKS_MARKER',
    };
    expect(metadataWriterKeySites(SHIPPED_SOURCES).filter((site) => site.file === file)).toEqual([
      markerSite,
    ]);
    const changed = mutate(SHIPPED_SOURCES, file, (source) =>
      source.replace("[RECORD_LINKS_MARKER, '1']", "['schema_version', '1']")
    );
    expect(metadataWriterKeySites(changed).filter((site) => site.file === file)).toEqual([
      { ...markerSite, key: "'schema_version'" },
    ]);
    expect(metadataWriterKeySites(changed)).not.toEqual(EXPECTED_WRITER_KEYS);
    expect(schemaVersionLiteralSites(changed)).not.toEqual(EXPECTED_SCHEMA_VERSION_LITERALS);
  });
});

const tempDirs: string[] = [];

function makeDb(sql: string, prefix: string): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  const dbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');
  const db = new Database(dbPath);
  db.exec(sql);
  db.close();
  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<RbookDatabaseClient> {
  const opened = await RbookDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error(opened.error?.message ?? 'open failed');
  return opened.data;
}

function metadataTable(label?: string): string {
  return `
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    ${label === undefined ? '' : `INSERT INTO metadata (key, value) VALUES ('schema_version', '${label}');`}
  `;
}

function vectorFixture(label: string): string {
  return `
    ${metadataTable(label)}
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Queued'
    );
  `;
}

function readMetadata(client: RbookDatabaseClient, key: string): string | undefined {
  return client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]).data
    ?.value;
}

function writeMetadata(client: RbookDatabaseClient, key: string, value: string): void {
  const write = client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
  expect(write.success).toBe(true);
}

afterAll(() => {
  for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('schema_version runtime contract', () => {
  it.each([
    {
      name: 'strategic-decisions v2.1',
      sql: `${metadataTable('2.10')}
        CREATE TABLE strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );`,
      run: migrateStrategicDecisionsV21,
      reached: (result: ReturnType<typeof migrateStrategicDecisionsV21>) =>
        result.columnsAdded.includes('mission_id'),
    },
    {
      name: 'content-hash v2.2',
      sql: `${metadataTable('2.10')}
        CREATE TABLE strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          project_domain TEXT
        );
        CREATE TABLE learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          created_at TEXT NOT NULL
        );`,
      run: migrateContentHash,
      reached: (result: ReturnType<typeof migrateContentHash>) =>
        result.columnsAdded.includes('strategic_decisions.content_hash'),
    },
    {
      name: 'vector storage v2.3',
      sql: vectorFixture('2.10'),
      run: ensureVectorStorage,
      reached: (result: ReturnType<typeof ensureVectorStorage>) => !result.alreadyCurrent,
    },
    {
      name: 'firehose v2.4',
      sql: metadataTable('2.10'),
      run: ensureFirehoseEventColumns,
      reached: () => true,
      marker: FIREHOSE_MARKER_KEY,
    },
  ])('$name preserves numeric 2.10 rather than comparing it lexically with 2.4', async (entry) => {
    const { dbPath } = makeDb(entry.sql, 'rbook-schema-label-high-');
    const client = await openClient(dbPath);
    try {
      const result = entry.run(client);
      expect(entry.reached(result)).toBe(true);
      expect(result.warnings ?? []).toEqual([]);
      expect(readMetadata(client, 'schema_version')).toBe('2.10');
      const expectedMarker = (entry as { marker?: string }).marker;
      if (expectedMarker) expect(readMetadata(client, expectedMarker)).toBe('2.4');
    } finally {
      client.close();
    }
  });

  it.each([
    {
      name: 'content-hash',
      sql: `${metadataTable('2.1')}
        CREATE TABLE strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          project_domain TEXT
        );
        CREATE TABLE learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          created_at TEXT NOT NULL
        );`,
      run: migrateContentHash,
      target: '2.2',
    },
    {
      name: 'firehose',
      sql: metadataTable('2.3'),
      run: ensureFirehoseEventColumns,
      target: '2.4',
      marker: FIREHOSE_MARKER_KEY,
    },
  ])('$name writer raises a lower label to its own generation', async (entry) => {
    const { dbPath } = makeDb(entry.sql, 'rbook-schema-label-raise-');
    const client = await openClient(dbPath);
    try {
      const result = entry.run(client);
      expect(result.warnings).toEqual([]);
      expect(readMetadata(client, 'schema_version')).toBe(entry.target);
      if (entry.marker) expect(readMetadata(client, entry.marker)).toBe(entry.target);
    } finally {
      client.close();
    }
  });

  it('re-checks the migration label atomically after another connection raises it', async () => {
    const { dbPath } = makeDb(
      `${metadataTable('2.0')}
       CREATE TABLE strategic_decisions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         decision_text TEXT NOT NULL,
         created_at TEXT NOT NULL
       );`,
      'rbook-schema-label-race-'
    );
    const client = await openClient(dbPath);
    const originalExecute = client.execute.bind(client);
    let barrierHit = false;
    client.execute = ((...args: Parameters<RbookDatabaseClient['execute']>) => {
      const [sql] = args;
      if (!barrierHit && /INTO\s+metadata[\s\S]*schema_version/i.test(sql)) {
        barrierHit = true;
        const contender = new Database(dbPath);
        contender.prepare("UPDATE metadata SET value = '3.0' WHERE key = 'schema_version'").run();
        contender.close();
      }
      return originalExecute(...args);
    }) as RbookDatabaseClient['execute'];

    try {
      const result = migrateStrategicDecisionsV21(client);
      expect(barrierHit).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(readMetadata(client, 'schema_version')).toBe('3.0');
    } finally {
      client.execute = originalExecute;
      client.close();
    }
  });

  it('raw rbook_project(init) preserves and reports a higher numeric label', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-schema-label-init-'));
    tempDirs.push(projectRoot);
    const input = {
      projectRoot,
      projectId: 'schema-label-init-test',
      projectName: 'schema label init test',
    };
    expect((await rbookProjectInit(input)).success).toBe(true);

    const dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
    const db = new Database(dbPath);
    db.prepare("UPDATE metadata SET value = '2.10' WHERE key = 'schema_version'").run();
    db.close();

    const result = await rbookProjectInit(input);
    expect(result.success).toBe(true);
    expect(result.data?.schemaVersion).toBe('2.10');
    const verified = new Database(dbPath, { readonly: true });
    expect(
      (
        verified.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value
    ).toBe('2.10');
    verified.close();
  });

  it('re-checks init atomically and reports a label raised by another connection', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-schema-label-init-race-'));
    tempDirs.push(projectRoot);
    const input = {
      projectRoot,
      projectId: 'schema-label-init-race-test',
      projectName: 'schema label init race test',
    };
    expect((await rbookProjectInit(input)).success).toBe(true);

    const dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
    const lower = new Database(dbPath);
    lower.prepare("UPDATE metadata SET value = '2.0' WHERE key = 'schema_version'").run();
    lower.close();

    const prototype = Database.prototype;
    const originalPrepare = prototype.prepare;
    let barrierHit = false;
    prototype.prepare = function (
      this: InstanceType<typeof Database>,
      ...args: Parameters<typeof originalPrepare>
    ) {
      const statement = originalPrepare.apply(this, args);
      if (!/INTO\s+metadata/i.test(String(args[0]))) return statement;
      const originalRun = statement.run.bind(statement) as (...params: unknown[]) => unknown;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'run') {
            return (...params: unknown[]) => {
              if (!barrierHit && params[0] === 'schema_version') {
                barrierHit = true;
                const contender = new Database(dbPath);
                contender
                  .prepare("UPDATE metadata SET value = '3.0' WHERE key = 'schema_version'")
                  .run();
                contender.close();
              }
              return originalRun(...params);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } as typeof prototype.prepare;

    let result: Awaited<ReturnType<typeof rbookProjectInit>> | undefined;
    try {
      result = await rbookProjectInit(input);
    } finally {
      prototype.prepare = originalPrepare;
    }

    expect(barrierHit).toBe(true);
    expect(result?.success).toBe(true);
    expect(result?.data?.schemaVersion).toBe('3.0');
    const verified = new Database(dbPath, { readonly: true });
    expect(
      (
        verified.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value
    ).toBe('3.0');
    verified.close();
  });

  it.each([undefined, 'not-a-version'])(
    'raises an absent or malformed label (%s)',
    async (label) => {
      const { dbPath } = makeDb(
        `${metadataTable(label)}
       CREATE TABLE strategic_decisions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         decision_text TEXT NOT NULL,
         created_at TEXT NOT NULL
       );`,
        'rbook-schema-label-repair-'
      );
      const client = await openClient(dbPath);
      try {
        const result = migrateStrategicDecisionsV21(client);
        expect(result.warnings ?? []).toEqual([]);
        expect(readMetadata(client, 'schema_version')).toBe('2.1');
      } finally {
        client.close();
      }
    }
  );

  it('uses the vector-owned marker as the retry signal even under a higher shared label', async () => {
    const { dbPath } = makeDb(
      `${vectorFixture('2.10')}
       INSERT INTO learnings (content, created_at) VALUES ('marker retry learning', '2026-08-29');
       INSERT INTO missions (id, name) VALUES ('s99-m01', 'marker retry mission');`,
      'rbook-vector-own-marker-'
    );
    const client = await openClient(dbPath);
    try {
      const first = ensureVectorStorage(client);
      expect(first.rowsUpdated).toBe(2);
      expect(readMetadata(client, VECTOR_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe('2.10');
      expect(ensureVectorStorage(client)).toMatchObject({ alreadyCurrent: true, rowsUpdated: 0 });

      expect(
        client.execute('DELETE FROM metadata WHERE key = ?', [VECTOR_MARKER_KEY]).success
      ).toBe(true);
      const retry = ensureVectorStorage(client);
      expect(retry).toMatchObject({ alreadyCurrent: false, rowsUpdated: 2, warnings: [] });
      expect(readMetadata(client, VECTOR_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
    } finally {
      client.close();
    }
  });

  it('heals the label from the firehose marker without counting label repair as vector work', async () => {
    const { dbPath } = makeDb(vectorFixture('2.1'), 'rbook-vector-firehose-heal-');
    const client = await openClient(dbPath);
    try {
      expect(ensureVectorStorage(client).warnings).toEqual([]);
      writeMetadata(client, 'schema_version', '2.1');
      writeMetadata(client, FIREHOSE_MARKER_KEY, '2.4');

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: true,
        warnings: [],
      });
      expect(readMetadata(client, 'schema_version')).toBe('2.4');
      expect(readMetadata(client, VECTOR_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
    } finally {
      client.close();
    }
  });

  it('stamps vector readiness even when the non-authoritative label write fails', async () => {
    const { dbPath } = makeDb(
      `${vectorFixture('2.1')}
       CREATE TRIGGER block_schema_label BEFORE INSERT ON metadata
       WHEN NEW.key = 'schema_version'
       BEGIN SELECT RAISE(FAIL, 'schema label blocked'); END;`,
      'rbook-vector-label-failure-'
    );
    const client = await openClient(dbPath);
    try {
      const first = ensureVectorStorage(client);
      expect(first.alreadyCurrent).toBe(false);
      expect(first.warnings).toEqual([
        'metadata.schema_version -> 2.3 failed: DB_QUERY_FAILED — Query failed: schema label blocked',
      ]);
      expect(readMetadata(client, VECTOR_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe('2.1');

      const second = ensureVectorStorage(client);
      expect(second).toMatchObject({ alreadyCurrent: true, rowsUpdated: 0 });
      expect(second.warnings).toEqual(first.warnings);
    } finally {
      client.close();
    }
  });

  it('discloses a foreign store with no metadata table without throwing', async () => {
    const { dbPath } = makeDb(
      `CREATE TABLE strategic_decisions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         decision_text TEXT NOT NULL,
         created_at TEXT NOT NULL
       );`,
      'rbook-schema-label-foreign-'
    );
    const client = await openClient(dbPath);
    try {
      const result = migrateStrategicDecisionsV21(client);
      expect(result.warnings).toEqual([
        "metadata.schema_version read failed: DB_SCHEMA_MISMATCH — Table 'metadata' does not exist",
      ]);
    } finally {
      client.close();
    }
  });
});

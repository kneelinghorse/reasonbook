// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Links an explicitly selected local decision draft to its unique recorded answer.
// ABOUTME: The private runtime stays locked across the project transaction; previews exercise both locks.
import Database from 'better-sqlite3';
import { assertNoRecordMigration } from '../intelligence/legacy-compat';
import { RbookDetector, type RbookDetectionResult } from '../intelligence/rbook-detector';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { harnessSessionOf } from '../tools/rbook/draft-evaluation';
import { openDraftRuntime, draftStoreKey, type DraftRuntime } from '../tools/rbook/draft-runtime';
import { EXCERPT_TTL_MS } from '../tools/rbook/draft-runtime-excerpts';
import { ensureSettledBy } from '../tools/rbook/draft-settle';
import { privateAnswerMatches } from '../tools/rbook/private-answer-match';
import { isExpired, rawRunner } from '../tools/rbook/proposals';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { assertJestDbPathIsolated } from '../tools/rbook/real-store-guard';
import { localDraftCopyRefusal } from '../tools/rbook/replica-check';
import { storeFolder } from '../tools/rbook/replica-identity';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { resolveCliProject, type CliIo } from './core';

const USAGE =
  'reasonbook drafts settle --draft P<n> --decision <n> --project-root <dir> [--dry-run]';
const LOCK_WAIT_MS = 100;
interface Pair {
  readonly draftId: number;
  readonly decisionId: number;
  readonly dryRun: boolean;
}
interface SelectedDraft {
  text: string;
  kind: string;
  source_session: string | null;
  created_at: string;
  outcome: string;
  record_id: string | null;
  answered_at: string | null;
  approval_mode: string | null;
  settled_by: string | null;
  replaced_by: number | null;
}
interface Candidate {
  id: number;
  decision_text: string;
  created_at: string;
}

function argumentsForPair(argv: readonly string[]): Pair & { root: string } {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' && !dryRun) {
      dryRun = true;
      continue;
    }
    const match = /^--(draft|decision|project-root)(?:=(.*))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    const value = match[2] ?? argv[++i];
    if (!value?.trim() || value.startsWith('--') || value === '-h') throw new Error(USAGE);
    values.set(match[1], value);
  }
  const draft = values.get('draft') ?? '';
  const decision = values.get('decision') ?? '';
  const root = values.get('project-root');
  const draftId = Number(draft.slice(1));
  const decisionId = Number(decision);
  if (
    !root ||
    !/^P[1-9]\d*$/.test(draft) ||
    !/^[1-9]\d*$/.test(decision) ||
    !Number.isSafeInteger(draftId) ||
    !Number.isSafeInteger(decisionId)
  )
    throw new Error(USAGE);
  return { draftId, decisionId, root, dryRun };
}

function checkRuntime(runtime: DraftRuntime, id: number, created: number, now: number): void {
  const db = runtime.db;
  // Strict reads are intentional: list/Stop can read old schemas, whereas a private
  // settlement cannot infer that a missing table means no earlier answer or expiry.
  const tables = db
    .prepare(
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('starts','pending_declines','excerpts','windows')"
    )
    .pluck()
    .get();
  if (tables !== 4) throw new Error('The private runtime lacks required draft evidence.');
  const starts = db.prepare('SELECT at FROM starts').pluck().all();
  if (!starts.every(Number.isSafeInteger)) throw new Error('Session start times are unreadable.');
  if (
    isExpired(
      { createdAt: new Date(created).toISOString() },
      starts.filter((at) => Number(at) > created).length,
      now
    )
  )
    throw new Error('The draft expired. Ask the underlying question again.');
  if (db.prepare('SELECT 1 FROM pending_declines WHERE draft_id = ?').get(id))
    throw new Error('A retained decline is waiting to be saved. Finish the pending prompt first.');
  const cutoff = now - EXCERPT_TTL_MS;
  const evidence = db.prepare('SELECT at,reply FROM excerpts WHERE draft_id = ?').all(id) as Array<{
    at: number;
    reply: string;
  }>;
  for (const item of evidence) {
    if (!Number.isSafeInteger(item.at)) throw new Error('The private answer time is unreadable.');
    if (item.at <= cutoff) continue;
    if (item.reply === 'approval' || item.reply === 'decline')
      throw new Error(
        'The draft has a protected answer. Finish recording the existing answer first.'
      );
    if (item.reply !== 'question' && item.reply !== 'other')
      throw new Error(
        'The private answer classification is unreadable. Review the existing answer.'
      );
  }
  const windows = db.prepare('SELECT draft_ids, at, open FROM windows').all() as Array<{
    draft_ids: string;
    at: number;
    open: number;
  }>;
  for (const row of windows) {
    if (!Number.isSafeInteger(row.at) || ![0, 1].includes(row.open))
      throw new Error('The approval window is unreadable.');
    if (!row.open || row.at <= cutoff) continue;
    const ids: unknown = JSON.parse(row.draft_ids);
    if (!Array.isArray(ids) || !ids.every((item) => Number.isSafeInteger(item) && item > 0))
      throw new Error('The approval window is unreadable.');
    if (ids.includes(id))
      throw new Error('A live approval window names this draft. Finish the current turn first.');
  }
}

function checkCopy(
  db: Database.Database,
  detection: RbookDetectionResult,
  env: NodeJS.ProcessEnv
): boolean {
  const shared = Boolean(
    db
      .prepare(
        "SELECT 1 FROM metadata WHERE key='replica_id' UNION ALL SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('record_peers','record_changes') LIMIT 1"
      )
      .get()
  );
  if (!shared) return false;
  // The caller holds the project's IMMEDIATE lock. This reader sees the same committed
  // identity and checks this machine's binding without upgrading either database.
  const opened = RbookDatabaseClient.fromDetection(detection, {
    readonly: true,
    loadVec: false,
    timeout: LOCK_WAIT_MS,
  });
  if (!opened.data) throw new Error(opened.error?.message ?? 'The shared copy could not be read.');
  try {
    const refused = localDraftCopyRefusal(opened.data, env);
    if (refused) throw new Error(`${refused.message} ${refused.suggestion}`);
    return true;
  } finally {
    opened.data.close();
  }
}

function settleLocked(
  db: Database.Database,
  runtime: DraftRuntime,
  detection: RbookDetectionResult,
  env: NodeJS.ProcessEnv,
  pair: Pair
): string {
  assertNoRecordMigration(detection.projectRoot);
  const shared = checkCopy(db, detection, env);
  const projectId = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get();
  if (
    typeof projectId !== 'string' ||
    !projectId.trim() ||
    projectId === 'unknown-project' ||
    runtime.storeKey !== draftStoreKey({ dbPath: db.name, projectId })
  )
    throw new Error(
      'The project and its private runtime could not be identified. Check the project root.'
    );
  const run = rawRunner(db);
  const columns = run.all<{ name: string; type: string; pk: number; hidden: number }>(
    'PRAGMA table_xinfo(proposals)'
  );
  // The project and seed differ by one supported audit column. A view, an unknown
  // identity column or a trigger on this copy-local table cannot guarantee one-row writes.
  const audit = columns.find((column) => column.name === 'settled_by');
  // A foreign key with no target columns references the entire primary key.
  const primaryKey = columns.filter((column) => column.pk > 0);
  if (
    primaryKey.length !== 1 ||
    primaryKey[0].name !== 'id' ||
    primaryKey[0].type.toUpperCase() !== 'INTEGER' ||
    // Generated columns could change alongside the five explicitly written fields.
    columns.some((column) => column.hidden !== 0) ||
    (audit && audit.type.toUpperCase() !== 'TEXT') ||
    run.get(
      "SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='proposals' COLLATE NOCASE"
    ) ||
    // Foreign keys involving the updated fields can defer rejection until COMMIT or
    // cascade the write. A reference to the draft's unchanged ID does neither.
    run.get(`WITH changed(field) AS (VALUES ('outcome'),('approval_mode'),('settled_by'),('record_id'),('answered_at'))
      SELECT 1 FROM sqlite_master AS t JOIN pragma_foreign_key_list(t.name) AS fk
      WHERE t.type='table' AND t.sql LIKE '%REFERENCES%' AND (
        (t.name='proposals' COLLATE NOCASE AND lower(fk."from") IN changed) OR
        (fk."table"='proposals' COLLATE NOCASE AND lower(fk."to") IN changed)
      ) LIMIT 1`)
  )
    throw new Error('This draft table has an unsupported layout. Use the normal recording path.');
  const draft = run.get<SelectedDraft>(
    `SELECT text,kind,source_session,created_at,outcome,record_id,replaced_by,answered_at,
      approval_mode,${audit ? 'settled_by' : 'NULL AS settled_by'}
     FROM proposals WHERE id=?`,
    [pair.draftId]
  );
  if (!draft) throw new Error('The selected draft is absent. Check drafts list in this project.');
  if (draft.kind !== 'decision')
    throw new Error('Only a decision draft can be linked to a decision.');
  if (draft.outcome === 'answered' && /^d:[1-9]\d*$/.test(draft.record_id ?? ''))
    return `P${pair.draftId} was already answered as ${draft.record_id}.`;
  if (draft.outcome !== 'pending')
    throw new Error(
      `The selected draft is ${draft.outcome}. Check its current state with drafts list --all.`
    );
  if (
    draft.answered_at !== null ||
    draft.approval_mode !== null ||
    draft.record_id !== null ||
    draft.settled_by !== null
  )
    throw new Error(
      'The pending draft already contains an answer or audit mark. Review the existing record.'
    );
  const now = Date.now();
  const created = storedTimeMs(draft.created_at);
  if (
    !Number.isFinite(created) ||
    created > now ||
    !/^[a-f0-9]{16}$/.test(draft.source_session ?? '')
  )
    throw new Error('The original harness or draft time could not be verified.');
  const seen = new Set([pair.draftId]);
  let next = draft.replaced_by;
  while (next !== null) {
    if (!Number.isSafeInteger(next) || next <= 0 || seen.has(next))
      throw new Error(
        'The linked revisions are unreadable. Review the draft before recording an answer.'
      );
    seen.add(next);
    const revision = run.get<{ replaced_by: number | null }>(
      'SELECT replaced_by FROM proposals WHERE id=?',
      [next]
    );
    if (!revision)
      throw new Error(
        'The linked revision is missing. Review the draft before recording an answer.'
      );
    next = revision.replaced_by;
  }
  checkRuntime(runtime, pair.draftId, created, now);
  if (!run.get('SELECT id FROM strategic_decisions WHERE id=?', [pair.decisionId]))
    throw new Error(
      shared
        ? 'The selected decision is missing from this copy. Sync first and retry.'
        : 'The selected decision is absent. Check the decision in this project.'
    );
  const candidates = db.prepare(`SELECT d.id, d.decision_text, d.created_at
      FROM strategic_decisions d JOIN sessions s ON s.id=d.author_session_id
      WHERE d.project_id=? AND s.project_id=? AND s.owner_key=? AND d.status='active'
      AND d.superseded_by IS NULL AND (d.approval_mode IS NULL OR d.approval_mode IN ('approved','agent-judged','agent-attested'))`);
  let matched = false;
  for (const row of candidates.iterate(
    projectId,
    projectId,
    'ext:' + draft.source_session
  ) as Iterable<Candidate>) {
    const at = storedTimeMs(row.created_at);
    if (!Number.isFinite(at) || at > now) {
      if (
        row.id === pair.decisionId ||
        (!Number.isFinite(at) && privateAnswerMatches(draft.text, row.decision_text, true))
      )
        throw new Error(
          'A possible answer has an invalid or future time. Check the recorded decision.'
        );
      continue;
    }
    if (!privateAnswerMatches(draft.text, row.decision_text, at > created)) continue;
    if (row.id !== pair.decisionId)
      throw new Error('Another decision qualifies for this draft. Review the recorded choices.');
    matched = true;
  }
  if (!matched)
    throw new Error(
      'The selected decision does not uniquely answer this draft in its original chat. Ask the underlying question.'
    );
  ensureSettledBy(run);
  const changed = run.run(
    `UPDATE OR ABORT proposals SET outcome='answered', approval_mode='settled', settled_by=?, record_id=?, answered_at=?
      WHERE id=? AND kind='decision' AND outcome='pending' AND replaced_by IS ?`,
    [
      harnessSessionOf(db.name),
      `d:${pair.decisionId}`,
      new Date(now).toISOString(),
      pair.draftId,
      draft.replaced_by,
    ]
  ).changes;
  if (changed !== 1) throw new Error('The draft changed. Read its current state before retrying.');
  return `${pair.dryRun ? 'Would settle' : 'Settled'} P${pair.draftId} by d:${pair.decisionId}.`;
}

export async function settlePrivateDraft(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  pair: Pair
): Promise<string> {
  if (isReadOnlyAgentSession(env))
    throw new Error('This session is read-only. Use a write-capable session.');
  assertJestDbPathIsolated(dbPath);
  const detection = await RbookDetector.getInstance().detect(storeFolder(dbPath), {
    forceRefresh: true,
  });
  if (!detection.hasDatabase || detection.databasePath !== dbPath)
    throw new Error('Check the existing project root.');
  for (let attempt = 0; ; attempt++) {
    let runtime: DraftRuntime | null = null;
    try {
      runtime = openDraftRuntime(dbPath, env, { existingOnly: true, timeoutMs: LOCK_WAIT_MS });
      if (!runtime)
        throw new Error(
          'The existing private draft runtime is missing or unsafe. Ask the underlying question.'
        );
      const locked = runtime;
      return locked.db
        .transaction(() => {
          const db = new Database(dbPath, { fileMustExist: true, timeout: LOCK_WAIT_MS });
          try {
            db.exec('BEGIN IMMEDIATE');
            if (pair.dryRun) db.exec('SAVEPOINT preview');
            const receipt = settleLocked(db, locked, detection, env, pair);
            // Committing even a reverted savepoint can increment the database header counter.
            db.exec(pair.dryRun ? 'ROLLBACK TO preview; ROLLBACK' : 'COMMIT');
            return receipt;
          } finally {
            // Closing abandons any unfinished transaction, including failed constraint checks.
            db.close();
          }
        })
        .immediate();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') throw error;
      if (attempt)
        throw new Error(
          'The project or private runtime is busy. Retry after the current write finishes.'
        );
    } finally {
      runtime?.close();
    }
  }
}

export async function runPrivateSettle(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const pair = argumentsForPair(argv);
    const resolved = resolveCliProject({ projectRootArg: pair.root, env: io.env, cwd: io.cwd });
    if (resolved.kind !== 'store')
      throw new Error('No existing project store at that root. Check --project-root.');
    const receipt = await settlePrivateDraft(resolved.dbPath, io.env, pair);
    io.stdout(receipt + '\n');
    return 0;
  } catch (error) {
    io.stderr(
      `Settlement refused. ${error instanceof Error ? error.message : String(error)} Check the project and use the normal decision question if a link cannot be verified.`
    );
    return 1;
  }
}

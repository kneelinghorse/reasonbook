// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Later prompts recall at most three unseen local decisions using bounded keyword search.
// ABOUTME: Retrieval opens SQLite readonly, applies an explicit match floor and never expands citations.

import { prepareSpinOutRead, spinOutSqliteReader } from '../tools/rbook/spin-out-read';
import Database from 'better-sqlite3';
import {
  composeDecisionText,
  decisionTextProjection,
  type DecisionTextRow,
} from '../tools/rbook/decision-fields';
import { extractKeywords } from '../tools/rbook/keyword-extraction';
import { getProjectId } from '../tools/rbook/project-id';
import type { RbookDatabaseClient, QueryParams } from '../tools/rbook/client';
import type { RbookToolResult } from '../tools/rbook/types';
import type { RecallItem, RecallResult } from '../tools/rbook/first-prompt-recall';
import { markConflicts, rawQuery } from '../tools/rbook/record-conflict-marks';
import { previewText } from '../tools/rbook/text-preview';

export const LATER_MIN_KEYWORD_MATCHES = 3;
export interface LaterRecallOptions {
  readonly deadlineAtMs?: number;
  readonly minKeywordMatches?: number;
}

/** Called after telemetry and, when implemented, m06 draft handling. First prompts never skip. */
export function skipLaterPrompt(query: string): boolean {
  const text = query.trim();
  return (
    text.startsWith('/') ||
    text.split(/\s+/).length < 6 ||
    /^(?:yes|yep|yeah|ok|okay|thanks|thank you|approved|approve|sounds good|go ahead|proceed)(?:[.,!]?\s+(?:please\s+)?(?:go ahead|proceed|continue)(?:\s+with\s+(?:that|the)(?:\s+agreed)?\s+plan)?)?[.!]*$/i.test(
      text
    )
  );
}

export function recallLaterPrompt(
  dbPath: string,
  query: string,
  seenIds: readonly string[],
  options: LaterRecallOptions = {}
): RecallResult {
  const deadline = options.deadlineAtMs ?? Date.now() + 700;
  const check = (): void => {
    if (Date.now() >= deadline) throw new Error('recall_deadline');
  };
  let db: Database.Database | undefined;
  let localProjectId: string | null = null;
  try {
    check();
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 50 });
    const columns = new Set(
      (db.pragma('table_info(strategic_decisions)') as { name: string }[]).map((row) => row.name)
    );
    if (!columns.has('id') || !columns.has('decision_text'))
      throw new Error('recall_schema_missing');
    if (
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decisions_fts'").get()
    )
      throw new Error('recall_index_missing');
    const identityDb = db;
    const reader: Pick<RbookDatabaseClient, 'getOne' | 'path'> = {
      path: dbPath,
      getOne: <T>(sql: string, params?: QueryParams): RbookToolResult<T | undefined> => ({
        success: true,
        data: (params ? identityDb.prepare(sql).get(params) : identityDb.prepare(sql).get()) as
          | T
          | undefined,
      }),
    };
    localProjectId = getProjectId(reader);
    const keywords = extractKeywords(query).slice(0, 64);
    const empty = (): RecallResult => ({
      items: [],
      localProjectId,
      warnings: [],
      available: true,
    });
    if (!keywords.length) return empty();
    const match = keywords.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR ');
    const visible = prepareSpinOutRead(spinOutSqliteReader(db)).predicate('decision', 'd.id');
    const where = [
      visible.sql,
      columns.has('status') ? "(d.status IS NULL OR d.status <> 'superseded')" : '1',
    ];
    if (columns.has('superseded_by')) where.push('d.superseded_by IS NULL');
    if (columns.has('project_id')) where.push('(d.project_id IS NULL OR d.project_id = ?)');
    const rows = db
      .prepare(
        `SELECT d.id, d.decision_text AS text,
      ${columns.has('status') ? "COALESCE(d.status,'active')" : "'active'"} AS status,
      ${columns.has('project_id') ? 'd.project_id' : 'NULL'} AS projectId, ${decisionTextProjection(columns, 'd.')}
      FROM decisions_fts JOIN strategic_decisions d ON d.id=decisions_fts.rowid
      WHERE decisions_fts MATCH ? AND ${where.join(' AND ')} ORDER BY decisions_fts.rank,d.id`
      )
      .iterate(match, ...visible.params, ...(columns.has('project_id') ? [localProjectId] : []));
    const seen = new Set(seenIds);
    const items: RecallItem[] = [];
    const floor = Math.max(1, options.minKeywordMatches ?? LATER_MIN_KEYWORD_MATCHES);
    for (const entry of rows) {
      check();
      const row = entry as {
        id: number;
        text: string;
        status: string;
        projectId: string | null;
      } & Omit<DecisionTextRow, 'decision_text'>;
      if (seen.has(`d:${row.id}`)) continue;
      const tokens = new Set(
        extractKeywords(composeDecisionText({ ...row, decision_text: row.text }))
      );
      if (keywords.filter((word) => tokens.has(word)).length < floor) continue;
      const preview = previewText(row.text);
      items.push({
        kind: 'decision',
        id: row.id,
        text: preview.preview,
        truncated: preview.truncated,
        status: row.status,
        projectId: row.projectId,
        retrievalSource: 'keyword',
        via: [],
      });
      if (items.length === 3) break;
    }
    check();
    return {
      items: markConflicts(rawQuery(db), items),
      localProjectId,
      warnings: [],
      available: true,
    };
  } catch (error) {
    const known = ['recall_deadline', 'recall_schema_missing', 'recall_index_missing'];
    const warning =
      error instanceof Error &&
      (known.includes(error.message) || error.message.startsWith('SPIN_OUT_READ_FAILED:'))
        ? error.message
        : 'recall_query_failed';
    return { items: [], localProjectId, warnings: [warning], available: false };
  } finally {
    db?.close();
  }
}

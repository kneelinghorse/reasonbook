// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read canonical source rows and the five-table collision inventory through a readonly adapter.
// ABOUTME: Query failures throw named context instead of masquerading as missing or empty data.

import type { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import type { CitationIdentity, InventoryKind, RecordKind } from './record-link-extractor';

export type RecordLinkReader = Pick<RbookDatabaseClient, 'getOne' | 'getMany' | 'path'>;
export type StoredLinkSource = CitationIdentity & {
  kind: RecordKind;
  fields: Record<string, unknown>;
};
export interface LinkInventory {
  localProjectId: string | null;
  /** s96-m12: a copy of a shared record, whose citations resolve by id alone. */
  byIdAlone: boolean;
  sources: StoredLinkSource[];
  identities: (CitationIdentity & { kind: InventoryKind })[];
}
export function requireLinkSuccess<T>(result: RbookToolResult<T>, step: string): T | undefined {
  if (!result.success)
    throw new Error(
      `${step}: ${result.error?.code ?? 'DB_ERROR'} — ${result.error?.message ?? 'unknown'}`
    );
  return result.data;
}
export function linkObject(
  reader: RecordLinkReader,
  name: string
): { type: string; sql: string | null } | undefined {
  return requireLinkSuccess(
    reader.getOne<{ type: string; sql: string | null }>(
      'SELECT type, sql FROM sqlite_master WHERE name=?',
      [name]
    ),
    `${name} schema read`
  );
}

/** Missing optional historical tables are empty; malformed existing tables are never empty. */
/**
 * s96-m12 (ADR s96 §5): on a copy of a shared record an id names one row on every copy and is never
 * reused, and copies' clocks differ, so a citation resolves by id alone. The sealed extractor's time
 * tests are kept true rather than changed: every row a citation can name reads as earlier than every
 * row that cites. A row citing itself is dropped by its callers, as the time test drops it elsewhere.
 */
const CITED_AT = '1970-01-01T00:00:00.000Z';
const CITING_AT = '9999-12-31T23:59:59.999Z';

export function loadLinkInventory(reader: RecordLinkReader, requireSources = false): LinkInventory {
  // A copy of a shared record keeps its change log.
  const byIdAlone = Boolean(
    requireLinkSuccess(
      reader.getMany<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'record_changes'"
      ),
      'shared record check'
    )?.length
  );
  const localProjectId =
    requireLinkSuccess(
      reader.getOne<{ value: string }>('SELECT value FROM metadata WHERE key=?', ['project_id']),
      'citation project identity'
    )?.value ?? null;
  const sources: StoredLinkSource[] = [];
  const identities: LinkInventory['identities'] = [];
  const tables = [
    ['strategic_decisions', 'decision', 'decision_text'],
    ['learnings', 'learning', 'content'],
    ['constraints', 'constraint', null],
    ['next_steps', 'next_step', null],
    ['agent_feedback', 'feedback', null],
  ] as const;
  for (const [table, kind, textColumn] of tables) {
    const object = linkObject(reader, table);
    if (!object) {
      if (requireSources && textColumn)
        throw new Error(`Required citation source ${table} is absent`);
      continue;
    }
    if (object.type !== 'table') throw new Error(`Citation source ${table} is not a table`);
    const columns = new Set(
      requireLinkSuccess(
        reader.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
        `${table} columns`
      )?.map((row) => row.name)
    );
    if (
      !columns.has('id') ||
      !columns.has('created_at') ||
      (textColumn && !columns.has(textColumn))
    )
      throw new Error(`Citation source ${table} lacks required id, time or text columns`);
    const rows =
      requireLinkSuccess(
        reader.getMany<Record<string, unknown>>(`SELECT * FROM ${table}`),
        `${table} citation rows`
      ) ?? [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0)
        throw new Error(`Citation source ${table} has an invalid record id`);
      const identity = {
        kind,
        id: Number(row.id),
        created_at: byIdAlone
          ? CITED_AT
          : typeof row.created_at === 'string'
            ? row.created_at
            : null,
        project_id: typeof row.project_id === 'string' ? row.project_id : null,
      };
      identities.push(identity);
      if (kind === 'decision' || kind === 'learning')
        sources.push({
          ...identity,
          ...(byIdAlone ? { created_at: CITING_AT } : {}),
          kind,
          fields: row,
        });
    }
  }
  return { localProjectId, byIdAlone, sources, identities };
}

/** s96-m12: the links a source makes, less one to itself, which only resolving by id alone admits. */
export function withoutSelfLinks<T extends { to_kind: string; to_id: number }>(
  links: readonly T[],
  source: { kind: string; id: number }
): T[] {
  return links.filter((link) => !(link.to_kind === source.kind && link.to_id === source.id));
}

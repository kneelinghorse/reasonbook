// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Applies committed spin-out visibility on each existing cross-store read connection.
// ABOUTME: Filtering precedes the sentinel cap and preserves the fan-out merge comparator.
import type { CrossStoreQueryOptions, CrossStoreRow } from './cross-store-query';
import {
  prepareSpinOutRead,
  spinOutSqliteReader,
  type SpinOutKind,
} from '../tools/rbook/spin-out-read';

export function spinOutQuery(
  kind: SpinOutKind,
  sql: string,
  params: unknown[] = []
): NonNullable<CrossStoreQueryOptions['perStoreQuery']> {
  return (db, _store, limitWithSentinel) => {
    const visible = prepareSpinOutRead(spinOutSqliteReader(db)).predicate(kind, 'visible_row.id');
    return db
      .prepare(
        `SELECT * FROM (${sql}) visible_row WHERE ${visible.sql}
      ORDER BY IFNULL(occurred_at,0) DESC, IFNULL(origin_seq,0) DESC, project_id ASC LIMIT ?`
      )
      .all(...params, ...visible.params, limitWithSentinel) as CrossStoreRow[];
  };
}

/** s106-m03: how many rows spinOutQuery would read without its cap, under the same visibility. */
export function spinOutCount(
  kind: SpinOutKind,
  sql: string,
  params: unknown[] = []
): (db: Parameters<NonNullable<CrossStoreQueryOptions['perStoreQuery']>>[0]) => number {
  return (db) => {
    const visible = prepareSpinOutRead(spinOutSqliteReader(db)).predicate(kind, 'visible_row.id');
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM (${sql}) visible_row WHERE ${visible.sql}`)
      .get(...params, ...visible.params) as { n: number };
    return row.n;
  };
}

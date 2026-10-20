// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copy a later release wrote, for the newer-protocol tests (s100-m01, settled item 6): its change log takes a
// ABOUTME: new kind, and its next change is of that kind in the next record protocol, numbered and clocked as its own.
import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import {
  PROTOCOL_VERSION,
  widenChangeKindsForTesting,
} from '../../src/tools/rbook/record-protocol';

const mint = monotonicFactory();

/** The kind a later release adds, which this version's change log cannot store. */
export const NEW_KIND = 'reshape';
/** The record protocol that later release writes. */
export const NEWER = PROTOCOL_VERSION + 1;

/** Rebuild a store's change log so it takes the new kind, as that release's migration would. */
export function widenStore(storePath: string): void {
  const db = new Database(storePath);
  try {
    widenChangeKindsForTesting((sql) => db.exec(sql), [NEW_KIND]);
  } finally {
    db.close();
  }
}

/**
 * The double for a copy that upgraded first: its store takes the new kind, and its next change is of
 * that kind, in the newer protocol, numbered and clocked as the copy numbers and clocks its own writes.
 */
export function writeAsNewerRelease(storePath: string): {
  readonly changeId: string;
  readonly seq: number;
} {
  widenStore(storePath);
  const db = new Database(storePath);
  try {
    const meta = (key: string) =>
      (db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string }).value;
    const replica = meta('replica_id');
    const [lastMs, lastCount] = meta('replica_hlc').split('-').map(Number);
    const ms = Math.max(lastMs, Date.now());
    const count = ms === lastMs ? lastCount + 1 : 0;
    const hlc = `${String(ms).padStart(13, '0')}-${String(count).padStart(6, '0')}`;
    const seq = Number(meta('replica_seq')) + 1;
    const changeId = mint();
    db.transaction(() => {
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_seq'").run(String(seq));
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run(hlc);
      db.prepare(
        `INSERT INTO record_changes (change_id, txn_id, project_id, replica_id, replica_seq, author_name,
           author_user_id, hlc, protocol_version, kind, entity, entity_id, field, value, base)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'replica', ?, NULL, '{"shape":1}', NULL)`
      ).run(changeId, mint(), meta('project_id'), replica, seq, hlc, NEWER, NEW_KIND, replica);
    })();
    return { changeId, seq };
  } finally {
    db.close();
  }
}

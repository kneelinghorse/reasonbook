// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The record protocol a copy writes and the change kinds it stores (ADR s96 §4), with the change log's DDL and the
// ABOUTME: named upgrade seam (s100-m01) that raises both as a later release would, so a held change can be taken in.

/** The change log's wire version (ADR s96 §4); only the upgrade seam below ever raises it. */
export let PROTOCOL_VERSION = 1;

export const CHANGE_KINDS = [
  'create',
  'set',
  'append',
  'link',
  'unlink',
  'settle',
  'alias',
  'renumber',
  'replica_joined',
  'member',
  'authority',
  'verdict',
  'baseline',
] as const;

/** The change log, its kind CHECK taking `kinds`: this version's, or a later release's (s100-m01). */
export function changeLogSql(kinds: readonly string[]): string {
  return `
CREATE TABLE IF NOT EXISTS record_changes (
  change_id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  replica_seq INTEGER NOT NULL,
  author_name TEXT,
  author_user_id TEXT,
  hlc TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${kinds.map((kind) => `'${kind}'`).join(', ')})),
  entity TEXT NOT NULL,
  entity_id TEXT,
  field TEXT,
  value TEXT,
  base TEXT,
  UNIQUE (project_id, replica_id, replica_seq)
);`;
}
export const CHANGE_LOG_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS record_changes_entity ON record_changes (entity, entity_id, field);
CREATE INDEX IF NOT EXISTS record_changes_txn ON record_changes (txn_id);
CREATE INDEX IF NOT EXISTS record_changes_create ON record_changes (entity_id) WHERE kind = 'create';
CREATE INDEX IF NOT EXISTS record_changes_replica ON record_changes (replica_id, replica_seq);`;

/** s100-m01: the kinds a later release adds, which this process knows only through the upgrade seam. */
const addedKinds = new Set<string>();

/** Every kind this process stores: this version's, and any the seam added. */
export function changeKinds(): string[] {
  return [...CHANGE_KINDS, ...addedKinds];
}

/** Whether a change of this kind is one this version stores. */
export function knownChangeKind(kind: string): boolean {
  return (CHANGE_KINDS as readonly string[]).includes(kind) || addedKinds.has(kind);
}

/**
 * Test seam (s100-m01, settled item 6): this process knows `kinds` too, as a later release that adds
 * them would, until the returned undo; upgradeRecordProtocolForTesting calls it.
 */
function addChangeKindsForTesting(kinds: readonly string[]): () => void {
  const added = kinds.filter((kind) => !knownChangeKind(kind));
  for (const kind of added) addedKinds.add(kind);
  return () => {
    for (const kind of added) addedKinds.delete(kind);
  };
}

/**
 * Test seam (s100-m01, settled item 6): rebuild a store's change log so its kind CHECK takes `kinds`
 * too, as a later release's migration would; every logged change is kept. No trigger or view names
 * the change log, so the rename carries nothing with it.
 */
export function widenChangeKindsForTesting(
  run: (sql: string) => void,
  kinds: readonly string[]
): void {
  const all = [...new Set([...CHANGE_KINDS, ...addedKinds, ...kinds])];
  run(`ALTER TABLE record_changes RENAME TO record_changes_widening;
${changeLogSql(all)}
INSERT INTO record_changes SELECT * FROM record_changes_widening;
DROP TABLE record_changes_widening;
${CHANGE_LOG_INDEXES_SQL}`);
}

/**
 * Test seam (s100-m01, settled item 6): this process speaks record protocol `version` and knows
 * `kinds`, as a later release that raises the protocol would, until the returned undo. A store keeps
 * its own kind CHECK until widenChangeKindsForTesting rebuilds it, as that release's migration would.
 */
export function upgradeRecordProtocolForTesting(
  version: number,
  kinds: readonly string[] = []
): () => void {
  const was = PROTOCOL_VERSION;
  PROTOCOL_VERSION = version;
  const forget = addChangeKindsForTesting(kinds);
  return () => {
    PROTOCOL_VERSION = was;
    forget();
  };
}

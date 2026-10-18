// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every copied column has an explicit policy, including fields outside the reference sweep.
// ABOUTME: Unknown columns refuse copying so future schema changes cannot silently lose provenance.
import type { SpinOutKind, SpinOutKey, SpinOutSourceSnapshot } from './spin-out-types';

export const SPIN_OUT_TABLES = {
  mission: 'missions',
  decision: 'strategic_decisions',
  learning: 'learnings',
  'next-step': 'next_steps',
} as const;
export type SpinOutColumnPolicy =
  | 'id'
  | 'keep'
  | 'text'
  | 'text-array'
  | 'null'
  | 'mission'
  | 'supersession'
  | 'context'
  | 'evidence'
  | 'metadata'
  | 'domain'
  | 'hash'
  | 'genesis'
  | 'legacy-session';
const genesis = {
  project_id: 'genesis',
  stable_event_id: 'genesis',
  occurred_at: 'genesis',
  origin_seq: 'genesis',
  event_type: 'genesis',
  schema_version: 'genesis',
} as const;
export const SPIN_OUT_COLUMN_POLICIES: Readonly<
  Record<SpinOutKind, Readonly<Record<string, SpinOutColumnPolicy>>>
> = {
  mission: {
    id: 'id',
    sprint_id: 'null',
    name: 'text',
    status: 'keep',
    completed_at: 'keep',
    notes: 'text',
    objective: 'text',
    context: 'text',
    success_criteria: 'text-array',
    deliverables: 'text-array',
    reference_docs: 'text-array',
    domain_fields: 'domain',
    metadata: 'metadata',
    created_at: 'keep',
    started_at: 'keep',
    updated_at: 'keep',
    last_embedded_hash: 'null',
    author_user_id: 'keep',
    author_name: 'keep',
    ...genesis,
  },
  decision: {
    id: 'id',
    context_id: 'context',
    decision_text: 'text',
    created_at: 'keep',
    sprint_id: 'null',
    snapshot_id: 'null',
    project_domain: 'keep',
    mission_id: 'mission',
    category: 'keep',
    superseded_by: 'supersession',
    status: 'keep',
    evidence: 'evidence',
    author_session_id: 'null',
    source_chunk_ids: 'keep',
    content_hash: 'hash',
    last_reviewed_at: 'keep',
    last_embedded_hash: 'null',
    author_user_id: 'keep',
    author_name: 'keep',
    context_text: 'text',
    alternatives: 'text-array',
    consequences: 'text',
    deciders: 'text-array',
    approval_mode: 'keep',
    approval_draft: 'null',
    approval_words: 'keep',
    ...genesis,
  },
  learning: {
    id: 'id',
    content: 'text',
    category: 'keep',
    status: 'keep',
    sprint_id: 'null',
    author_session_id: 'null',
    mission_id: 'mission',
    created_at: 'keep',
    content_hash: 'hash',
    last_reviewed_at: 'keep',
    evergreen: 'keep',
    last_embedded_hash: 'null',
    author_user_id: 'keep',
    author_name: 'keep',
    ...genesis,
  },
  'next-step': {
    id: 'id',
    content: 'text',
    status: 'keep',
    session_id: 'null',
    sprint_id: 'null',
    mission_id: 'mission',
    created_at: 'keep',
    resolved_at: 'keep',
    carried_to_sprint: 'null',
    content_hash: 'hash',
    author_user_id: 'keep',
    author_name: 'keep',
    ...genesis,
  },
};

/** Historical aliases are an explicit complement to the live 31-column census. */
export function spinOutColumnPolicy(
  kind: SpinOutKind,
  column: string
): SpinOutColumnPolicy | undefined {
  if (column === 'session_id' && (kind === 'decision' || kind === 'learning'))
    return 'legacy-session';
  return Object.prototype.hasOwnProperty.call(SPIN_OUT_COLUMN_POLICIES[kind], column)
    ? SPIN_OUT_COLUMN_POLICIES[kind][column]
    : undefined;
}

/** Same predicate as the pre-edit 31-column census; dependency endpoints complete the count. */
export function isSpinOutReferenceColumn(column: string): boolean {
  return (
    column !== 'id' &&
    (/(?:_id|_by|_to_sprint)$/.test(column) ||
      ['evidence', 'metadata', 'domain_fields'].includes(column))
  );
}

export function spinOutKeyText(key: SpinOutKey): string {
  if (
    !(key.kind in SPIN_OUT_TABLES) ||
    (key.kind === 'mission'
      ? typeof key.id !== 'string' || !key.id.trim()
      : !Number.isSafeInteger(key.id) || key.id <= 0)
  )
    throw new Error('Invalid spin-out row identity');
  return `${key.kind}:${key.id}`;
}

export function validateSpinOutSnapshot(snapshot: SpinOutSourceSnapshot): void {
  if (!snapshot.sourceProjectId.trim()) throw new Error('Missing source project identity');
  for (const [kind, columns] of Object.entries(snapshot.columns)) {
    if (!(kind in SPIN_OUT_TABLES)) throw new Error(`Unknown copy table kind ${kind}`);
    for (const column of columns)
      if (!spinOutColumnPolicy(kind as SpinOutKind, column))
        throw new Error(`Unclassified source column ${kind}.${column}`);
  }
  const seen = new Set<string>();
  for (const row of snapshot.rows) {
    const key = spinOutKeyText(row.key);
    if (seen.has(key) || row.values.id !== row.key.id)
      throw new Error(`Invalid or duplicate source row ${key}`);
    seen.add(key);
    for (const [column, value] of Object.entries(row.values)) {
      if (
        !snapshot.columns[row.key.kind]?.includes(column) ||
        !spinOutColumnPolicy(row.key.kind, column)
      )
        throw new Error(`Unclassified source column ${row.key.kind}.${column}`);
      if (
        value !== null &&
        typeof value !== 'string' &&
        (typeof value !== 'number' || !Number.isFinite(value))
      )
        throw new Error(`Unsupported stored value ${key}.${column}`);
    }
  }
  const identities = new Set<string>();
  for (const row of snapshot.collisionInventory) {
    const key = `${row.kind}:${row.id}`;
    if (
      !['decision', 'learning', 'constraint', 'next_step', 'feedback'].includes(row.kind) ||
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      identities.has(key)
    )
      throw new Error(`Invalid or duplicate citation identity ${key}`);
    identities.add(key);
  }
}

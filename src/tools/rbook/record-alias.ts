// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Two copies that create one mission, sprint or session id (ADR s96 §3): the earlier create keeps it, the other
// ABOUTME: becomes <id>~<its creator's block>, and a rename rewrites the row and every reference this copy keeps to it.

import type { RbookDatabaseClient } from './client';
import { txnStanding, type LoggedChange, type MergeContext } from './record-standing';

export type TextKeyed = 'missions' | 'sprints' | 'sessions';
/** s96-m13: sessions too, whose block-segmented ids clash only when two replicas write in one block. */
export const TEXT_KEYED: ReadonlySet<string> = new Set(['missions', 'sprints', 'sessions']);

/** The columns that name a mission or a sprint by id (s96-m12's published universe, section 1). */
const REFERENCES: Readonly<Record<TextKeyed, ReadonlyArray<[string, string]>>> = {
  missions: [
    ['strategic_decisions', 'mission_id'],
    ['learnings', 'mission_id'],
    ['next_steps', 'mission_id'],
    ['mission_dependencies', 'from_id'],
    ['mission_dependencies', 'to_id'],
    ['session_missions', 'mission_id'],
    ['agent_feedback', 'mission_id'],
    ['telemetry_events', 'mission'],
  ],
  sprints: [
    ['missions', 'sprint_id'],
    ['sessions', 'sprint_id'],
    ['strategic_decisions', 'sprint_id'],
    ['learnings', 'sprint_id'],
    ['next_steps', 'sprint_id'],
    ['next_steps', 'carried_to_sprint'],
    ['constraints', 'sprint_id'],
    ['agent_feedback', 'sprint_id'],
  ],
  // s96-m13's universe 4: the columns that name a session by id.
  sessions: [
    ['strategic_decisions', 'author_session_id'],
    ['learnings', 'author_session_id'],
    ['next_steps', 'session_id'],
    ['constraints', 'session_id'],
    ['session_missions', 'session_id'],
    ['agent_feedback', 'session_id'],
    ['context_snapshots', 'session_id'],
    ['proposals', 'source_session'],
  ],
};
/** Keys of per-copy JSON documents that hold a mission or sprint id. */
const JSON_KEYS: Readonly<Record<TextKeyed, ReadonlySet<string>>> = {
  missions: new Set(['mission_id', 'missionId', 'active_mission', 'last_completed_mission']),
  sprints: new Set(['sprint_id', 'sprintId', 'current_sprint', 'last_completed_sprint']),
  sessions: new Set(['session', 'session_id', 'sessionId']),
};
/**
 * The events whose `session_events.mission` holds each kind of id. A mission's start and complete
 * share their action with a session's, so a session event is told by the id its raw event names.
 */
const EVENT_ROWS: Readonly<Record<TextKeyed, string>> = {
  missions: "action <> 'sprint_complete'",
  sprints: "action = 'sprint_complete'",
  sessions:
    "action IN ('start', 'capture', 'complete') AND (CASE WHEN json_valid(raw_event) THEN json_extract(raw_event, '$.session') END) = mission",
};
/** The snapshot source each kind of completion writes. */
const SOURCE_PREFIX: Readonly<Record<TextKeyed, string>> = {
  missions: 'mission_complete:',
  sprints: 'sprint_complete:',
  sessions: 'session_complete:',
};

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

const tablePresent = (client: RbookDatabaseClient, table: string): boolean =>
  rows(client, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;

const order = (a: LoggedChange, b: LoggedChange): number =>
  a.hlc === b.hlc ? (a.change_id < b.change_id ? -1 : 1) : a.hlc < b.hlc ? -1 : 1;

/**
 * The id a live create of a mission or sprint takes on this copy: the earliest live create that
 * claims an id keeps it, by (hlc, change_id); each later one takes `<id>~<its creator's block>`.
 */
export function aliasedId(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  create: LoggedChange
): string {
  const plain = String((JSON.parse(create.value ?? '{}') as { id?: unknown }).id);
  const claims = rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'create' AND entity = ? AND json_extract(value, '$.id') = ?",
    [create.entity, plain]
  )
    .filter((claim) => txnStanding(client, ctx, claim.txn_id).state === 'live')
    .sort(order);
  if (!claims.length || claims[0].change_id === create.change_id) return plain;
  // A copy knows its own block before the authority admits it; another's comes from its admission.
  const block =
    ctx.members.get(create.replica_id)?.block ??
    (create.replica_id === ctx.ownReplica ? ctx.ownBlock : 0);
  return `${plain}~${block}`;
}

/** Rewrite every string under a key that names this kind of row, in a per-copy JSON document. */
function rewriteJson(
  value: unknown,
  table: TextKeyed,
  from: string,
  to: string,
  parent = ''
): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteJson(item, table, from, to, parent));
  // s96-m13: a session's next steps and resume notes are kept as "<session>: <note>".
  if (typeof value === 'string')
    return table === 'sessions' && value.startsWith(`${from}: `)
      ? `${to}${value.slice(from.length)}`
      : value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      const names =
        JSON_KEYS[table].has(key) ||
        (table === 'sprints' && key === 'id' && parent === 'current_sprint') ||
        (table === 'sessions' && key === 'id' && parent === 'recent_sessions');
      return [key, names && inner === from ? to : rewriteJson(inner, table, from, to, key)];
    })
  );
}

/**
 * Rename a mission, sprint or session in place: the row, every column that names it, the session
 * captures, the per-copy contexts, snapshot sources and events that name it by id, and the vector
 * index row.
 * At the moment a clash is found every stored reference to `from` names this row, since the other
 * create's dependents wait until it is written. Runs under the merge's token.
 */
export function renameRow(
  client: RbookDatabaseClient,
  table: TextKeyed,
  stableId: string,
  from: string,
  to: string
): void {
  run(client, `UPDATE ${table} SET id = ? WHERE stable_event_id = ?`, [to, stableId]);
  for (const [target, column] of REFERENCES[table])
    if (tablePresent(client, target))
      run(client, `UPDATE ${target} SET "${column}" = ? WHERE "${column}" = ?`, [to, from]);
  if (tablePresent(client, 'session_events'))
    run(
      client,
      `UPDATE session_events SET mission = ?${table === 'sessions' ? ", raw_event = json_set(raw_event, '$.session', ?)" : ''}
        WHERE mission = ? AND ${EVENT_ROWS[table]}`,
      table === 'sessions' ? [to, to, from] : [to, from]
    );
  const prefix = SOURCE_PREFIX[table];
  if (tablePresent(client, 'context_snapshots'))
    run(
      client,
      `UPDATE context_snapshots SET source = ? || substr(source, ?) WHERE source = ? OR substr(source, 1, ?) = ?`,
      [
        `${prefix}${to}`,
        `${prefix}${from}`.length + 1,
        `${prefix}${from}`,
        `${prefix}${from}:`.length,
        `${prefix}${from}:`,
      ]
    );
  for (const session of rows<{ id: string; captures: string }>(
    client,
    "SELECT id, captures FROM sessions WHERE captures LIKE '%' || ? || '%'",
    [from]
  )) {
    const rewritten = JSON.stringify(rewriteJson(JSON.parse(session.captures), table, from, to));
    if (rewritten !== session.captures)
      run(client, 'UPDATE sessions SET captures = ? WHERE id = ?', [rewritten, session.id]);
  }
  for (const context of rows<{ id: string; content: string }>(
    client,
    "SELECT id, content FROM contexts WHERE id <> 'project_identity' AND content LIKE '%' || ? || '%'",
    [from]
  )) {
    try {
      const rewritten = JSON.stringify(rewriteJson(JSON.parse(context.content), table, from, to));
      if (rewritten !== context.content)
        run(client, 'UPDATE contexts SET content = ? WHERE id = ?', [rewritten, context.id]);
    } catch {
      // A context that is not JSON names no id by key.
    }
  }
  if (table === 'missions') {
    // A store gets its embedding hash column with its first embedding.
    if (
      rows(client, "SELECT 1 FROM pragma_table_info('missions') WHERE name = 'last_embedded_hash'")
        .length
    )
      run(client, 'UPDATE missions SET last_embedded_hash = NULL WHERE stable_event_id = ?', [
        stableId,
      ]);
    if (tablePresent(client, 'missions_vec'))
      try {
        run(client, 'DELETE FROM missions_vec WHERE mission_id = ?', [from]);
      } catch {
        // The vector extension is not loaded here; the mission is embedded again under its new id.
      }
  }
  // A rename away from an aliased id ends that alias; only a rename to one notes a new alias.
  run(client, 'DELETE FROM record_aliases WHERE entity = ? AND renamed_id = ?', [table, from]);
  noteAlias(client, table, stableId, to);
}

/** Note a create that takes a renamed id at once, so reads name both for 14 days. */
export function noteAlias(
  client: RbookDatabaseClient,
  table: TextKeyed,
  stableId: string,
  id: string
): void {
  if (!/~\d+$/.test(id)) return;
  run(
    client,
    `INSERT INTO record_aliases (entity, renamed_id, plain_id, stable_event_id, renamed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entity, renamed_id) DO NOTHING`,
    [table, id, id.replace(/~\d+$/, ''), stableId, new Date().toISOString()]
  );
}

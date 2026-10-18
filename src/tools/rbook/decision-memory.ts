/**
 * Decision memory helpers
 *
 * Shared utilities for surfacing decision data from both strategic_decisions
 * and session capture history without double-counting.
 *
 * @module tools/rbook/decision-memory
 */

import { prepareSpinOutRead } from './spin-out-read';
import type { RbookDatabaseClient } from './client';
import { authorNamesSince, authorReading } from './author-name';
import { compareStoredTimes, storedTimeMs } from './stored-time';

export type DecisionSource = 'strategic' | 'session_capture';

export interface DecisionQueryFilters {
  domain?: string;
  sprintId?: string;
  /** s85-m04 (#487): restrict to decisions stamped with this mission. */
  missionId?: string;
  since?: string;
  until?: string;
}

export interface DecisionRecord {
  id: number;
  decision: string;
  domain: string | null;
  sprintId: string | null;
  snapshotId: number | null;
  missionId: string | null;
  createdAt: string;
  sessionId: string | null;
  source: DecisionSource;
  category: string | null;
  status: string | null;
  supersededBy: number | null;
  evidence: string | null;
  /** s78-m05: the row's genesis project_id (null pre-migration / for local session captures).
   *  Compared against the local store id to frame pull-merged foreign rows as untrusted. */
  projectId: string | null;
  /** s96-m02 (ADR s96 §10): who wrote it, or the reading for a NULL author. */
  author: string;
}

export interface SprintDecisionCounts {
  strategicDecisionsCount: number;
  sessionDecisionsCount: number;
  totalDecisionsCount: number;
}

interface StrategicDecisionRow {
  id: number | string;
  decision_text: string;
  project_domain: string | null;
  effective_sprint_id: string | null;
  snapshot_id: number | null;
  mission_id: string | null;
  created_at: string;
  session_id: string | null;
  category: string | null;
  status: string | null;
  superseded_by: number | null;
  evidence: string | null;
  project_id: string | null;
  author_name: string | null;
  occurred_at: number | null;
}

interface SessionDecisionRow {
  id: string;
  sprint_id: string | null;
  activity_at: string | null;
  captures: string | null;
  author_name: string | null;
  occurred_at: number | null;
}

interface SessionCaptureDecision {
  content: string;
  timestamp: string | null;
  missionId: string | null;
}

export function loadUnifiedDecisionRecords(
  client: RbookDatabaseClient,
  filters: DecisionQueryFilters = {}
): DecisionRecord[] {
  const strategicRecords = loadStrategicDecisionRecords(client, filters);
  const visible = prepareSpinOutRead(client);
  // Presentation dates/domains can exclude the newer canonical row while its older capture
  // still matches. Hidden canonical identities must suppress those historical duplicates.
  const hiddenCanonical = filters.sprintId
    ? loadStrategicDecisionRecords(client, {}, true).filter((record) =>
        visible.hidden('decision', record.id)
      )
    : [];
  const sessionFallbackRecords = filters.sprintId
    ? loadSessionFallbackDecisionRecords(client, filters, [...strategicRecords, ...hiddenCanonical])
    : [];

  return [
    ...strategicRecords.filter((record) => !visible.hidden('decision', record.id)),
    ...sessionFallbackRecords,
  ].sort(compareDecisionRecords);
}

export function getSprintDecisionCounts(
  client: RbookDatabaseClient,
  sprintId: string
): SprintDecisionCounts {
  const strategicRecords = loadStrategicDecisionRecords(client, { sprintId });
  const sessionFallbackRecords = loadSessionFallbackDecisionRecords(
    client,
    { sprintId },
    strategicRecords
  );

  return {
    strategicDecisionsCount: strategicRecords.length,
    sessionDecisionsCount: sessionFallbackRecords.length,
    totalDecisionsCount: strategicRecords.length + sessionFallbackRecords.length,
  };
}

function loadStrategicDecisionRecords(
  client: RbookDatabaseClient,
  filters: DecisionQueryFilters,
  requiredIdentityRead = false
): DecisionRecord[] {
  const decisionColumns = getTableColumns(client, 'strategic_decisions', requiredIdentityRead);
  if (!decisionColumns.has('created_at') || decisionColumns.size === 0) {
    return [];
  }

  const decisionTextExpr = decisionColumns.has('decision_text')
    ? 'sd.decision_text'
    : decisionColumns.has('decision')
      ? 'sd.decision'
      : "''";
  const domainExpr = decisionColumns.has('project_domain') ? 'sd.project_domain' : 'NULL';
  const snapshotExpr = decisionColumns.has('snapshot_id') ? 'sd.snapshot_id' : 'NULL';
  const missionExpr = decisionColumns.has('mission_id') ? 'sd.mission_id' : 'NULL';
  // s69-m04: prefer the renamed author_session_id; fall back to legacy session_id
  // for snapshot-restored DBs that predate the rename.
  const sessionCol = decisionColumns.has('author_session_id')
    ? 'author_session_id'
    : decisionColumns.has('session_id')
      ? 'session_id'
      : null;
  const sessionExpr = sessionCol ? `sd.${sessionCol}` : 'NULL';
  const categoryExpr = decisionColumns.has('category') ? 'sd.category' : 'NULL';
  const statusExpr = decisionColumns.has('status') ? 'sd.status' : "'active'";
  const supersededByExpr = decisionColumns.has('superseded_by') ? 'sd.superseded_by' : 'NULL';
  const evidenceExpr = decisionColumns.has('evidence') ? 'sd.evidence' : 'NULL';
  const projectExpr = decisionColumns.has('project_id') ? 'sd.project_id' : 'NULL';
  const authorExpr = decisionColumns.has('author_name') ? 'sd.author_name' : 'NULL';
  const occurredExpr = decisionColumns.has('occurred_at') ? 'sd.occurred_at' : 'NULL';
  const sprintExprBase = decisionColumns.has('sprint_id') ? 'sd.sprint_id' : 'NULL';

  const missionJoin =
    decisionColumns.has('mission_id') && hasTableColumn(client, 'missions', 'sprint_id')
      ? 'LEFT JOIN missions linked_mission ON linked_mission.id = sd.mission_id'
      : '';
  const sessionJoin =
    sessionCol && hasTableColumn(client, 'sessions', 'sprint_id')
      ? `LEFT JOIN sessions linked_session ON linked_session.id = sd.${sessionCol}`
      : '';

  const sprintParts = [sprintExprBase];
  if (missionJoin) {
    sprintParts.push('linked_mission.sprint_id');
  }
  if (sessionJoin) {
    sprintParts.push('linked_session.sprint_id');
  }
  const effectiveSprintExpr =
    sprintParts.length === 1 ? sprintParts[0] : `COALESCE(${sprintParts.join(', ')})`;

  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.domain) {
    clauses.push(`${domainExpr} = ?`);
    params.push(filters.domain);
  }
  if (filters.sprintId) {
    clauses.push(`${effectiveSprintExpr} = ?`);
    params.push(filters.sprintId);
  }
  // s85-m04 (#487). Column-presence guarded: on a store predating the v2.1 mission_id
  // migration, missionExpr is the literal NULL, and `NULL = ?` is never true — so the filter
  // correctly returns nothing rather than throwing "no such column".
  if (filters.missionId) {
    clauses.push(`${missionExpr} = ?`);
    params.push(filters.missionId);
  }
  if (filters.since) {
    clauses.push('julianday(sd.created_at) >= julianday(?)');
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push('julianday(sd.created_at) <= julianday(?)');
    params.push(filters.until);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = client.getMany<StrategicDecisionRow>(
    `SELECT
        sd.id AS id,
        ${decisionTextExpr} AS decision_text,
        ${domainExpr} AS project_domain,
        ${effectiveSprintExpr} AS effective_sprint_id,
        ${snapshotExpr} AS snapshot_id,
        ${missionExpr} AS mission_id,
        sd.created_at AS created_at,
        ${sessionExpr} AS session_id,
        ${categoryExpr} AS category,
        ${statusExpr} AS status,
        ${supersededByExpr} AS superseded_by,
        ${evidenceExpr} AS evidence,
        ${projectExpr} AS project_id,
        ${authorExpr} AS author_name,
        ${occurredExpr} AS occurred_at
       FROM strategic_decisions sd
       ${missionJoin}
       ${sessionJoin}
       ${whereClause}`,
    params
  );

  if (!result.success || !result.data) {
    if (requiredIdentityRead)
      throw new Error(
        `SPIN_OUT_READ_FAILED: ${result.error?.message ?? 'canonical identity query failed'}`
      );
    return [];
  }

  const since = authorNamesSince(client);
  return result.data.map((row, index) => ({
    id: normalizeRecordId(row.id, index + 1),
    decision: row.decision_text,
    domain: row.project_domain,
    sprintId: row.effective_sprint_id,
    snapshotId: row.snapshot_id,
    missionId: row.mission_id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    source: 'strategic' as DecisionSource,
    category: row.category,
    status: row.status,
    supersededBy: row.superseded_by,
    evidence: row.evidence,
    projectId: row.project_id,
    author: authorReading(row.author_name, row.occurred_at, since),
  }));
}

function loadSessionFallbackDecisionRecords(
  client: RbookDatabaseClient,
  filters: DecisionQueryFilters,
  strategicRecords: DecisionRecord[]
): DecisionRecord[] {
  if (!filters.sprintId || !hasTableColumn(client, 'sessions', 'captures')) {
    return [];
  }

  const projectDomain = getMetadataValue(client, 'project_domain');
  if (filters.domain && filters.domain !== projectDomain) {
    return [];
  }

  const sessionColumns = getTableColumns(client, 'sessions');
  const activityExpr =
    sessionColumns.has('completed_at') && sessionColumns.has('started_at')
      ? 'COALESCE(completed_at, started_at)'
      : sessionColumns.has('completed_at')
        ? 'completed_at'
        : sessionColumns.has('started_at')
          ? 'started_at'
          : 'NULL';

  const authorExpr = sessionColumns.has('author_name') ? 'author_name' : 'NULL';
  const occurredExpr = sessionColumns.has('occurred_at') ? 'occurred_at' : 'NULL';
  const sessionRows = client.getMany<SessionDecisionRow>(
    `SELECT id, sprint_id, ${activityExpr} AS activity_at, captures,
            ${authorExpr} AS author_name, ${occurredExpr} AS occurred_at
       FROM sessions
      WHERE sprint_id = ?`,
    [filters.sprintId]
  );
  // A decision captured in a session was written by the session's author.
  const since = authorNamesSince(client);

  if (!sessionRows.success || !sessionRows.data) {
    return [];
  }

  const seenStrategic = new Set(
    strategicRecords
      .filter((record) => record.sessionId)
      .map((record) => makeSessionDecisionKey(record.sessionId as string, record.decision))
  );

  const records: DecisionRecord[] = [];
  let nextSyntheticId = -1;

  for (const row of sessionRows.data) {
    const captures = readDecisionCaptures(row.captures, row.activity_at);
    const seenSession = new Set<string>();

    for (const capture of captures) {
      if (!capture.content || !matchesDateFilters(capture.timestamp, filters)) {
        continue;
      }

      const decisionKey = makeSessionDecisionKey(row.id, capture.content);
      if (seenStrategic.has(decisionKey) || seenSession.has(decisionKey)) {
        continue;
      }

      seenSession.add(decisionKey);
      records.push({
        id: nextSyntheticId--,
        decision: capture.content,
        domain: projectDomain,
        sprintId: row.sprint_id,
        snapshotId: null,
        missionId: capture.missionId,
        createdAt: capture.timestamp ?? row.activity_at ?? '',
        sessionId: row.id,
        source: 'session_capture',
        category: null,
        status: 'active',
        supersededBy: null,
        evidence: null,
        projectId: null, // local session capture — never foreign
        author: authorReading(row.author_name, row.occurred_at, since),
      });
    }
  }

  return records;
}

function readDecisionCaptures(
  capturesJson: string | null,
  fallbackTimestamp: string | null
): SessionCaptureDecision[] {
  if (!capturesJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(capturesJson);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry) => isPlainObject(entry))
      .filter(
        (entry) =>
          String(entry.category ?? '')
            .trim()
            .toLowerCase() === 'decision'
      )
      .map((entry) => ({
        content: typeof entry.content === 'string' ? entry.content.trim() : '',
        timestamp:
          typeof entry.timestamp === 'string'
            ? entry.timestamp
            : typeof entry.ts === 'string'
              ? entry.ts
              : fallbackTimestamp,
        missionId:
          typeof entry.missionId === 'string'
            ? entry.missionId
            : typeof entry.mission_id === 'string'
              ? entry.mission_id
              : null,
      }))
      .filter((entry) => entry.content.length > 0);
  } catch {
    return [];
  }
}

function getTableColumns(
  client: RbookDatabaseClient,
  tableName: string,
  requiredIdentityRead = false
): Set<string> {
  const result = client.getMany<{ name: string }>(`PRAGMA table_info('${tableName}')`, []);
  if (!result.success || !result.data) {
    if (requiredIdentityRead)
      throw new Error(
        `SPIN_OUT_READ_FAILED: ${result.error?.message ?? 'canonical schema query failed'}`
      );
    return new Set();
  }
  return new Set(result.data.map((row) => row.name));
}

function hasTableColumn(
  client: RbookDatabaseClient,
  tableName: string,
  columnName: string
): boolean {
  return getTableColumns(client, tableName).has(columnName);
}

function getMetadataValue(client: RbookDatabaseClient, key: string): string | null {
  if (!hasTableColumn(client, 'metadata', 'key') || !hasTableColumn(client, 'metadata', 'value')) {
    return null;
  }

  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    key,
  ]);
  return result.success ? (result.data?.value ?? null) : null;
}

/**
 * s93-m11: compared as instants, the way the SQL side compares through julianday(); a time either
 * side cannot read matches nothing, as a NULL comparison does there.
 */
function matchesDateFilters(timestamp: string | null, filters: DecisionQueryFilters): boolean {
  if (!timestamp) {
    return false;
  }
  const at = storedTimeMs(timestamp);
  if (filters.since && !(at >= storedTimeMs(filters.since))) {
    return false;
  }
  if (filters.until && !(at <= storedTimeMs(filters.until))) {
    return false;
  }
  return true;
}

/** Newest first by time (s93-m11: as instants, not text), then by id. */
function compareDecisionRecords(a: DecisionRecord, b: DecisionRecord): number {
  return compareStoredTimes(b.createdAt, a.createdAt) || b.id - a.id;
}

function makeSessionDecisionKey(sessionId: string, decision: string): string {
  return `${sessionId}::${decision.trim().toLowerCase()}`;
}

function normalizeRecordId(value: number | string, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

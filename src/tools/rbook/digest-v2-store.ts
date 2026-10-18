// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read a local digest snapshot without migrations, registration, lifecycle changes or network calls.
// ABOUTME: Recency and rule ranking use published predicates; failed reads cannot masquerade as empty context.

import { prepareSpinOutRead } from './spin-out-read';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import * as path from 'path';
import {
  composeDecisionText,
  decisionTextProjection,
  type DecisionTextRow,
} from './decision-fields';
import { RbookDetector } from '../../intelligence/rbook-detector';
import { isForeignProject } from '../../intelligence/provenance-frame';
import { RbookDatabaseClient } from './client';
import { resolveCurrentSprintId } from './current-sprint';
import { typedCitations } from './decision-citations';
import { getProjectId } from './genesis-columns';
import type { DigestRow, DigestV2Model } from './digest-v2';
import { readLeaseAges, leaseState } from './next-step-lease';
import { readProfile } from './operator-profile';
import { readProjectIdentity } from './project-identity';
import { readProjectLevel } from './project-level';
import { storedTimeMs } from './stored-time';
import { captureToolCall } from './tool-call-context';
import { feedbackDigestLine } from './feedback-fleet';
import { openDraftRuntime, startsSince } from './draft-runtime';
import { clientRunner, isExpired, pendingDrafts } from './proposals';
import { authorForWrite } from './author-name';
import { sharedRecordReview } from './record-review';

/** Distinct local/NULL source rows citing an explicit typed rule; repeated citations in one row count once. */
export const DIGEST_RULE_CITATION_RULE =
  'Local/NULL decision headline/reasoning fields and learning text, mission objective/notes and session summary/captures; ' +
  'one count per source row and explicitly typed rule ID. Bare #N never counts as a learning or constraint.';

function rows<T>(client: RbookDatabaseClient, sql: string, values: unknown[] = []): T[] {
  const result = client.getMany<T>(sql, values);
  if (!result.success || !result.data)
    throw new Error(result.error?.message ?? 'Digest query failed.');
  return result.data;
}

function columns(client: RbookDatabaseClient, table: string): Set<string> {
  const names = new Set(
    rows<{ name: string }>(client, `PRAGMA table_info(${table})`).map((row) => row.name)
  );
  if (!names.size) throw new Error(`Digest unavailable: ${table} table is absent.`);
  return names;
}

function field(cols: Set<string>, name: string): string {
  return cols.has(name) ? name : 'NULL';
}

interface RecordRow {
  id: number;
  text: string;
  createdAt: string;
  reviewedAt: string | null;
  projectId: string | null;
  author: string | null;
}

function recordRows(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings' | 'constraints',
  predicate = ''
): RecordRow[] {
  const cols = columns(client, table);
  const visible =
    table === 'constraints'
      ? { sql: '1=1', params: [] }
      : prepareSpinOutRead(client).predicate(
          table === 'learnings' ? 'learning' : 'decision',
          `${table}.id`
        );
  return rows<RecordRow>(
    client,
    `SELECT id, ${table === 'strategic_decisions' ? 'decision_text' : 'content'} AS text,
    created_at AS createdAt, ${field(cols, 'last_reviewed_at')} AS reviewedAt,
    ${field(cols, 'project_id')} AS projectId, ${field(cols, 'author_name')} AS author
    FROM ${table} WHERE COALESCE(status,'active') <> 'superseded'
    ${cols.has('superseded_by') ? 'AND superseded_by IS NULL' : ''} ${predicate} AND ${visible.sql}`,
    visible.params
  );
}

function changedAt(row: RecordRow): number {
  const created = storedTimeMs(row.createdAt);
  const reviewed = storedTimeMs(row.reviewedAt);
  const changed = Math.max(
    Number.isFinite(created) ? created : -Infinity,
    Number.isFinite(reviewed) ? reviewed : -Infinity
  );
  if (!Number.isFinite(changed))
    throw new Error('Digest record has no readable creation or review date.');
  return changed;
}

/**
 * The week's records, newest first. On a shared record (`writer` given) each names its author when
 * someone other than this copy's writer wrote it (s96-m12), as the structured review does (s96-m02).
 */
function recent(
  records: RecordRow[],
  kind: 'd' | 'l',
  max: number,
  now: number,
  writer?: string | null
): { rows: DigestRow[]; total: number } {
  const selected = records
    .map((row) => ({ row, changed: changedAt(row) }))
    .filter((item) => item.changed >= now - 7 * 86_400_000 && item.changed <= now)
    .sort((a, b) => b.changed - a.changed || b.row.id - a.row.id);
  return {
    total: selected.length,
    rows: selected.slice(0, max).map(({ row, changed }) => ({
      id: `${kind}:${row.id}`,
      text: row.text,
      projectId: row.projectId,
      date: new Date(changed).toISOString().slice(0, 10),
      ...(writer !== undefined && row.author && row.author !== writer
        ? { author: row.author }
        : {}),
    })),
  };
}

function citationCounts(client: RbookDatabaseClient, local: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [table, fields] of [
    ['strategic_decisions', ['decision_text']],
    ['learnings', ['content']],
    ['missions', ['objective', 'notes']],
    ['sessions', ['summary', 'captures']],
  ] as const) {
    const cols = columns(client, table);
    const text = fields
      .filter((name) => cols.has(name))
      .map((name) => `COALESCE(${name},'')`)
      .join(" || '\n' || ");
    if (!text) continue;
    const decisionProjection =
      table === 'strategic_decisions' ? `, ${decisionTextProjection(cols)}` : '';
    const visible =
      table === 'sessions'
        ? { sql: '1=1', params: [] }
        : prepareSpinOutRead(client).predicate(
            table === 'learnings' ? 'learning' : table === 'missions' ? 'mission' : 'decision',
            `${table}.id`
          );
    const records = rows<
      { text: string; projectId: string | null } & Omit<DecisionTextRow, 'decision_text'>
    >(
      client,
      `SELECT ${text} AS text, ${field(cols, 'project_id')} AS projectId${decisionProjection} FROM ${table} WHERE ${visible.sql}`,
      visible.params
    );
    for (const record of records) {
      if (isForeignProject(record.projectId, local)) continue;
      const citationText =
        table === 'strategic_decisions'
          ? composeDecisionText({ ...record, decision_text: record.text })
          : record.text;
      for (const id of new Set(typedCitations(citationText).filter((id) => /^[lc]:/.test(id))))
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function bindingRules(client: RbookDatabaseClient, local: string | null, now: number): DigestRow[] {
  const constraints = recordRows(
    client,
    'constraints',
    `AND status='active' AND (expires_at IS NULL OR julianday(expires_at) > julianday('${new Date(now).toISOString()}'))`
  );
  const learningCols = columns(client, 'learnings');
  const learnings = learningCols.has('evergreen')
    ? recordRows(client, 'learnings', "AND status='active' AND evergreen=1")
    : [];
  const counts = citationCounts(client, local);
  const rank = (records: RecordRow[], prefix: 'c' | 'l'): DigestRow[] =>
    records
      .filter((row) => !isForeignProject(row.projectId, local))
      .sort(
        (a, b) =>
          (counts.get(`${prefix}:${b.id}`) ?? 0) - (counts.get(`${prefix}:${a.id}`) ?? 0) ||
          (storedTimeMs(b.reviewedAt) || 0) - (storedTimeMs(a.reviewedAt) || 0) ||
          b.id - a.id
      )
      .map((row) => ({ id: `${prefix}:${row.id}`, text: row.text, projectId: row.projectId }));
  return [...rank(constraints, 'c'), ...rank(learnings, 'l')];
}

function snapshot(
  client: RbookDatabaseClient,
  root: string,
  env: NodeJS.ProcessEnv
): DigestV2Model {
  const now = Date.now();
  const metadata = new Map(
    rows<{ key: string; value: string }>(client, 'SELECT key,value FROM metadata').map((row) => [
      row.key,
      row.value,
    ])
  );
  const identity = readProjectIdentity(client);
  const local = getProjectId(client);
  // s95-m06: the shared reading, trimmed, so the digest and every other answer agree.
  const level = readProjectLevel(client);
  // Delegate selection to the canonical resolver; label fallback status rather than inventing another picker.
  const sprintId = resolveCurrentSprintId(client);
  const sprintCols = columns(client, 'sprints');
  const sprint = sprintId
    ? (rows<NonNullable<DigestV2Model['sprint']>>(
        client,
        `SELECT id,title,focus,status,${field(sprintCols, 'project_id')} AS projectId FROM sprints WHERE id=?`,
        [sprintId]
      )[0] ?? null)
    : null;
  const stepCols = columns(client, 'next_steps');
  const steps = rows<{ id: number; content: string; projectId: string | null }>(
    client,
    `SELECT id,content,${field(stepCols, 'project_id')} AS projectId FROM next_steps WHERE status IN ('pending','carried')`
  ).filter((row) => !isForeignProject(row.projectId, local));
  const missionCols = columns(client, 'missions');
  const missions = rows<{
    id: string;
    name: string;
    status: string;
    sprintId: string;
    projectId: string | null;
  }>(
    client,
    `SELECT id,name,status,sprint_id AS sprintId,${field(missionCols, 'project_id')} AS projectId FROM missions
     WHERE status IN ('In Progress','Current','Queued','Blocked')
     ORDER BY CASE status WHEN 'In Progress' THEN 0 WHEN 'Current' THEN 1 WHEN 'Queued' THEN 2 ELSE 3 END,id`
  );
  let work: DigestRow[] = [];
  if (level === 'planner') {
    const leases = readLeaseAges(client);
    if (leases === null) throw new Error('Digest next-step leases could not be read.');
    const states = new Map(
      leases.map((lease) => [lease.id, leaseState(lease.closesSurvived, lease.ageDays)])
    );
    work = steps
      .sort(
        (a, b) =>
          Number(states.get(b.id) !== 'ok') - Number(states.get(a.id) !== 'ok') || b.id - a.id
      )
      .slice(0, 5)
      .map((row) => ({
        id: `n:${row.id}`,
        text: `${states.get(row.id) !== 'ok' ? `[lease ${states.get(row.id)}] ` : ''}${row.content}`,
        projectId: row.projectId,
      }));
  } else if (level === 'builder') {
    const next = missions.find((mission) => mission.sprintId === sprint?.id);
    if (next)
      work = [{ id: next.id, text: `[${next.status}] ${next.name}`, projectId: next.projectId }];
  }
  const localTasks = missions.filter((row) => !isForeignProject(row.projectId, local)).length;
  const shared = sharedRecordReview(client);
  const writer = shared ? authorForWrite(client).name : undefined;
  return {
    project: {
      name: metadata.get('project_name') || identity?.project_name || path.basename(root),
      level,
    },
    localProjectId: local,
    sprint,
    profile: readProfile(env),
    stepUp:
      level === 'ledger' && steps.length >= 5
        ? 'Consider Planner: at least 5 open next steps.'
        : level === 'planner' && localTasks >= 10
          ? 'Consider Builder: at least 10 open tasks.'
          : null,
    rules: bindingRules(client, local, now),
    decisions: recent(recordRows(client, 'strategic_decisions'), 'd', 8, now, writer),
    learnings: recent(recordRows(client, 'learnings'), 'l', 3, now, writer),
    work,
    drafts: pendingUnexpired(client, env, now),
    shared,
  };
}

/**
 * s93-m06: pending drafts that have not expired, read-only. An absent table is no drafts (it is
 * created by the first Stop that stores one); session starts come from the runtime directory, and
 * with no runtime file there are none to count.
 */
function pendingUnexpired(
  client: RbookDatabaseClient,
  env: NodeJS.ProcessEnv,
  now: number
): Array<{ id: number; kind: string; text: string }> {
  const pending = pendingDrafts(clientRunner(client));
  if (!pending.length) return [];
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  try {
    return pending
      .filter(
        (row) =>
          !isExpired(row, runtime ? startsSince(runtime, storedTimeMs(row.createdAt)) : 0, now)
      )
      .map((row) => ({ id: row.id, kind: row.kind, text: row.text }));
  } finally {
    runtime?.close();
  }
}

/** A read-only connection plus a read transaction gives every section one coherent local snapshot. */
export async function readDigestV2(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  deadlineAtMs = Infinity
): Promise<DigestV2Model> {
  return (
    await captureToolCall('read', async () => {
      const detected = await RbookDetector.getInstance().detect(root);
      if (!detected.hasDatabase || !detected.databasePath)
        throw new Error('Digest Reasonbook store is absent.');
      const opened = await RbookDatabaseClient.create({
        dbPath: detected.databasePath,
        readonly: true,
        registerProject: false,
        timeout: 250,
      });
      if (!opened.success || !opened.data)
        throw new Error(opened.error?.message ?? 'Digest store could not be opened.');
      const client = opened.data;
      try {
        const result = client.transaction(() => snapshot(client, root, env));
        if (!result.success || !result.data)
          throw new Error(result.error?.message ?? 'Digest snapshot failed.');
        return {
          ...result.data,
          legacyRecord: resolveRecordPaths(root).legacy,
          feedback: await feedbackDigestLine(env, deadlineAtMs),
        };
      } finally {
        client.close();
      }
    })
  ).value;
}

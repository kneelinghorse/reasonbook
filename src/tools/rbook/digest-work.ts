// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Select local open next steps and the canonical mission for the bounded digest.
// ABOUTME: Rank lease urgency before current-sprint affinity and creation time without changing records.
import { prepareSpinOutRead } from './spin-out-read';
import type { RbookDatabaseClient } from './client';
import type { DigestRow } from './digest-v2';
import type { ProjectLevel } from './rules-files';
import { isForeignProject } from '../../intelligence/provenance-frame';
import { readLeaseAges, leaseState } from './next-step-lease';
import { firstReady, orderByRequires } from './work-queue-order';
import { storedTimeMs } from './stored-time';
import { nextStepWait } from './next-step-dates';
import { missionDueDay } from '../../signals/rules-due';

function rows<T>(client: RbookDatabaseClient, sql: string): T[] {
  const result = client.getMany<T>(sql);
  if (!result.success || !result.data)
    throw new Error(result.error?.message ?? 'Digest work query failed.');
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
interface Step {
  id: number;
  content: string;
  projectId: string | null;
  createdAt: string;
  sprintId: string | null;
  carriedToSprint: string | null;
  status: string;
  resolvedAt: string | null;
}
export function digestWork(
  client: RbookDatabaseClient,
  level: ProjectLevel,
  local: string | null,
  sprintId: string | null
): {
  work: DigestRow[];
  nextSteps?: { rows: DigestRow[]; total: number };
  stepCount: number;
  /** s108-m02: open next steps waiting until a date, left out of the rows and counts above. */
  waiting: number;
  /** s108-m03: Deferred missions whose current date has come: how many, and the earliest's id, name and day. */
  dueMissions: { count: number; first: string; name: string; since: string } | null;
  localTasks: number;
} {
  const visibility = prepareSpinOutRead(client);
  const stepCols = columns(client, 'next_steps');
  const steps = rows<Step>(
    client,
    `SELECT id,content,status,created_at AS createdAt,sprint_id AS sprintId,carried_to_sprint AS carriedToSprint,${field(stepCols, 'resolved_at')} AS resolvedAt,${field(stepCols, 'project_id')} AS projectId FROM next_steps WHERE status IN ('pending','carried')`
  ).filter(
    (row) => !isForeignProject(row.projectId, local) && !visibility.hidden('next-step', row.id)
  );
  // s108-m02: a row waiting until a date is not open work yet; one whose date has come ranks first.
  const waits = new Map(steps.map((row) => [row.id, nextStepWait(row.status, row.resolvedAt)]));
  const waiting = steps.filter((row) => waits.get(row.id)?.waitsUntil).length;
  const open = steps.filter((row) => !waits.get(row.id)?.waitsUntil);
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
  let selected: DigestRow[] = [];
  {
    const leases = readLeaseAges(client);
    if (leases === null) throw new Error('Digest next-step leases could not be read.');
    const states = new Map(
      leases.map((lease) => [lease.id, leaseState(lease.closesSurvived, lease.ageDays)])
    );
    const priority = { lapsing: 0, warning: 1, idle: 2, ok: 3 };
    const due = (row: Step): number => Number(!!waits.get(row.id)?.dueSince);
    const current = (row: Step): number =>
      Number(!!sprintId && (row.carriedToSprint ?? row.sprintId) === sprintId);
    selected = open
      .sort(
        (a, b) =>
          due(b) - due(a) ||
          priority[states.get(a.id) ?? 'ok'] - priority[states.get(b.id) ?? 'ok'] ||
          current(b) - current(a) ||
          (storedTimeMs(b.createdAt) || 0) - (storedTimeMs(a.createdAt) || 0) ||
          b.id - a.id
      )
      .slice(0, level === 'builder' ? 3 : 5)
      .map((row) => {
        const dueSince = waits.get(row.id)?.dueSince;
        const state = states.get(row.id);
        return {
          id: `n:${row.id}`,
          text: `${dueSince ? `[due since ${dueSince}] ` : ''}${state !== 'ok' ? `[lease ${state}] ` : ''}${row.content}`,
          projectId: row.projectId,
        };
      });
    if (level !== 'builder') work = selected;
  }
  if (level === 'builder') {
    // s97-m13 (#662): work under way first; else the first queued mission whose Requires targets
    // are complete; else the first queued one, saying what it waits on; else a blocked one.
    const inSprint = missions.filter((mission) => mission.sprintId === sprintId);
    const ordered = orderByRequires(
      client,
      inSprint.filter((mission) => mission.status === 'Queued')
    );
    if (ordered.warning) throw new Error('Digest work-queue edges could not be read.');
    const next:
      | { id: string; name: string; status: string; projectId: string | null; waitsOn?: string[] }
      | undefined =
      inSprint.find(
        (mission) => mission.status === 'In Progress' || mission.status === 'Current'
      ) ??
      firstReady(ordered.missions) ??
      ordered.missions[0] ??
      inSprint.find((mission) => mission.status === 'Blocked');
    if (next)
      work = [
        {
          id: next.id,
          text: `[${next.status}${next.waitsOn ? `, waits on ${next.waitsOn.join(', ')}` : ''}] ${next.name}`,
          projectId: next.projectId,
        },
      ];
  }
  const localTasks = missions.filter((row) => !isForeignProject(row.projectId, local)).length;
  // s108-m03: a Deferred mission is out of the queue until its current date comes (rules-due.ts).
  // The digest counts the due ones and names the earliest by its id and day.
  const nowMs = Date.now();
  const due = rows<{
    id: string;
    name: string;
    domainFields: unknown;
    projectId: string | null;
  }>(
    client,
    `SELECT id,name,${field(missionCols, 'domain_fields')} AS domainFields,${field(missionCols, 'project_id')} AS projectId FROM missions WHERE status = 'Deferred'`
  )
    .filter((mission) => !isForeignProject(mission.projectId, local))
    .map((mission) => ({ mission, day: missionDueDay(mission.domainFields) }))
    .filter(
      (entry): entry is { mission: typeof entry.mission; day: string } =>
        entry.day !== null && storedTimeMs(entry.day) <= nowMs
    )
    .sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : a.mission.id < b.mission.id ? -1 : 1
    );
  const dueMissions = due.length
    ? { count: due.length, first: due[0].mission.id, name: due[0].mission.name, since: due[0].day }
    : null;
  return {
    work,
    ...(level === 'builder' ? { nextSteps: { rows: selected, total: open.length } } : {}),
    stepCount: open.length,
    waiting,
    dueMissions,
    localTasks,
  };
}

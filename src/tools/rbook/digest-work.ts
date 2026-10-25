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
  localTasks: number;
} {
  const visibility = prepareSpinOutRead(client);
  const stepCols = columns(client, 'next_steps');
  const steps = rows<Step>(
    client,
    `SELECT id,content,created_at AS createdAt,sprint_id AS sprintId,carried_to_sprint AS carriedToSprint,${field(stepCols, 'project_id')} AS projectId FROM next_steps WHERE status IN ('pending','carried')`
  ).filter(
    (row) => !isForeignProject(row.projectId, local) && !visibility.hidden('next-step', row.id)
  );
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
    const current = (row: Step): number =>
      Number(!!sprintId && (row.carriedToSprint ?? row.sprintId) === sprintId);
    selected = steps
      .sort(
        (a, b) =>
          priority[states.get(a.id) ?? 'ok'] - priority[states.get(b.id) ?? 'ok'] ||
          current(b) - current(a) ||
          (storedTimeMs(b.createdAt) || 0) - (storedTimeMs(a.createdAt) || 0) ||
          b.id - a.id
      )
      .slice(0, level === 'builder' ? 3 : 5)
      .map((row) => ({
        id: `n:${row.id}`,
        text: `${states.get(row.id) !== 'ok' ? `[lease ${states.get(row.id)}] ` : ''}${row.content}`,
        projectId: row.projectId,
      }));
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
  return {
    work,
    ...(level === 'builder' ? { nextSteps: { rows: selected, total: steps.length } } : {}),
    stepCount: steps.length,
    localTasks,
  };
}

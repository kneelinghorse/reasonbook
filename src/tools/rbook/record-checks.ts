// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The cross-record checks (ADR s96 §5): states of a shared record that no one field conflict names, such as two
// ABOUTME: open sprints or a supersession cycle, for a person to settle; read from the record as it stands, never kept.

import type { RbookDatabaseClient } from './client';
import { ARCHIVE_WHERE } from './sprint-archive-scope';
import { isRecordedStore } from './record-guards';
import { openConflicts, type OpenConflict } from './record-settle';
import { SPRINT_OPEN_STATUSES, statusInSql } from './terminal-status';

export interface CheckFinding {
  readonly check: string;
  readonly subject: string;
  readonly detail: string;
}

/** The mission statuses a sprint close refuses to leave behind (rbook-sprint-complete.ts). */
const UNFINISHED_MISSION_STATUSES = ['Queued', 'Current', 'In Progress'] as const;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const holds = (conflict: OpenConflict, ...values: string[]): boolean =>
  values.every((value) => conflict.candidates.some((candidate) => candidate.value === value));

/** Every circle the supersession links make, each as its decision ids in order. */
function supersessionCycles(client: RbookDatabaseClient): number[][] {
  const next = new Map(
    rows<{ id: number; superseded_by: number }>(
      client,
      'SELECT id, superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL'
    ).map((row) => [row.id, row.superseded_by])
  );
  const walked = new Set<number>();
  const cycles: number[][] = [];
  for (const start of next.keys()) {
    const path: number[] = [];
    let at: number | undefined = start;
    while (at !== undefined && !walked.has(at) && !path.includes(at)) {
      path.push(at);
      at = next.get(at);
    }
    path.forEach((id) => walked.add(id));
    if (at !== undefined && path.includes(at))
      cycles.push(path.slice(path.indexOf(at)).sort((a, b) => a - b));
  }
  return cycles;
}

/**
 * The live changes that put a decision where a close finds it: its create, a change to its status,
 * sprint, mission or session, and a move of that mission or session to another sprint.
 */
const SCOPE_CHANGES = `SELECT replica_id, hlc FROM record_changes
   WHERE txn_id NOT IN (SELECT txn_id FROM record_txn_state)
     AND ((entity = 'strategic_decisions' AND entity_id = ?
           AND (kind = 'create' OR (kind IN ('set', 'settle')
                AND field IN ('status', 'sprint_id', 'mission_id', 'author_session_id'))))
       OR (entity IN ('missions', 'sessions') AND entity_id IN (?, ?)
           AND kind IN ('set', 'settle') AND field = 'sprint_id'))`;

/**
 * Active decisions in each sprint whose latest live close archived, that the close did not archive,
 * whose every live change to where they stand (SCOPE_CHANGES) came before the close by the clock,
 * one of them from another copy: an archiving close archives every active decision it sees in the
 * sprint, so the close had not seen that change. It skips a decision whose status is in conflict
 * and names it, so the check can list that one too, beside its conflict. A copy that has seen the
 * close has moved its clock past it (advanceClock), so what it changes afterwards is no finding.
 * The clock cannot tell a copy that had seen the close from one that had not, so a decision changed
 * after the close by the clock is never found, seen or not, even by a change that leaves it in the
 * sprint by another link: one made on a copy the close had not reached yet, or on one holding the
 * close behind a gap (a stored change moves the clock too). A close shows it archived by archiving
 * a decision or a learning; one that found nothing to archive leaves no mark. Both are admitted
 * holes.
 */
function decisionsLeftInClosedSprints(client: RbookDatabaseClient): CheckFinding[] {
  const latest = new Map<
    string,
    { replica_id: string; txn_id: string; hlc: string; archived: number }
  >();
  for (const close of rows<{
    sprint: string;
    replica_id: string;
    txn_id: string;
    hlc: string;
    archived: number;
  }>(
    client,
    `SELECT s.id AS sprint, c.replica_id, c.txn_id, c.hlc,
            EXISTS (SELECT 1 FROM record_changes a WHERE a.txn_id = c.txn_id
                     AND a.entity IN ('strategic_decisions', 'learnings')
                     AND a.field = 'status' AND a.value = '"archived"') AS archived
       FROM sprints s
       JOIN record_changes c ON c.entity = 'sprints' AND c.entity_id = s.stable_event_id
        AND c.kind IN ('set', 'settle') AND c.field = 'status' AND c.value = '"Completed"'
      WHERE ${statusInSql('s.status', ['Completed'])} AND c.txn_id NOT IN (SELECT txn_id FROM record_txn_state)
      ORDER BY c.hlc DESC, c.change_id DESC`
  ))
    if (!latest.has(close.sprint)) latest.set(close.sprint, close);
  const findings: CheckFinding[] = [];
  for (const [sprint, close] of latest) {
    if (!close.archived) continue;
    const left: number[] = [];
    for (const decision of rows<{
      id: number;
      stable: string;
      mission: string | null;
      session: string | null;
    }>(
      client,
      `SELECT id, stable_event_id AS stable,
              (SELECT m.stable_event_id FROM missions m WHERE m.id = strategic_decisions.mission_id) AS mission,
              (SELECT s.stable_event_id FROM sessions s WHERE s.id = strategic_decisions.author_session_id) AS session
         FROM strategic_decisions WHERE ${ARCHIVE_WHERE}
          AND NOT EXISTS (SELECT 1 FROM record_changes a WHERE a.txn_id = ?
                       AND a.entity = 'strategic_decisions' AND a.entity_id = strategic_decisions.stable_event_id)
        ORDER BY id`,
      [sprint, sprint, sprint, close.txn_id]
    )) {
      const changes = rows<{ replica_id: string; hlc: string }>(client, SCOPE_CHANGES, [
        decision.stable,
        decision.mission ?? '',
        decision.session ?? '',
      ]);
      // Every change that put it here came before the close by the clock, one from another copy.
      if (
        changes.every((change) => change.hlc < close.hlc) &&
        changes.some((change) => change.replica_id !== close.replica_id)
      )
        left.push(decision.id);
    }
    if (left.length)
      findings.push({
        check: 'active_decisions_in_closed_sprint',
        subject: sprint,
        detail: `${sprint} was closed with its decisions archived on one copy, but decision(s) ${left.join(', ')}, made or changed on another copy before that close reached it, are still active in it.`,
      });
  }
  return findings;
}

/** Each cross-record check, over this copy's record as it stands; none off a shared record. */
export function crossRecordFindings(client: RbookDatabaseClient): CheckFinding[] {
  if (!isRecordedStore(client)) return [];
  const findings: CheckFinding[] = [];
  const open = rows<{ id: string }>(
    client,
    `SELECT id FROM sprints WHERE ${statusInSql('status', SPRINT_OPEN_STATUSES)} ORDER BY id`
  ).map((row) => row.id);
  if (open.length > 1)
    findings.push({
      check: 'two_open_sprints',
      subject: open.join(','),
      detail: `${open.join(' and ')} are all open; close or plan all but one.`,
    });

  const conflicts = openConflicts(client);
  for (const conflict of conflicts) {
    const id = conflict.recordId ?? '';
    if (conflict.table === 'strategic_decisions' && conflict.field === 'superseded_by')
      findings.push({
        check: 'lineage_fork',
        subject: id,
        // s96-m14: an import's fork can keep the record's empty value as one candidate.
        detail: `decision ${id} is superseded by ${conflict.candidates.map((candidate) => (candidate.value === null || candidate.value === undefined ? 'nothing' : String(candidate.value))).join(' and ')}, which did not see each other; only the owner's copy settles it.`,
      });
    else if (
      conflict.table === 'missions' &&
      conflict.field === 'status' &&
      holds(conflict, 'Completed', 'Dropped')
    )
      findings.push({
        check: 'mission_completed_and_dropped',
        subject: id,
        detail: `mission ${id} was completed on one copy and dropped on another.`,
      });
    else if (
      conflict.table === 'next_steps' &&
      conflict.field === 'status' &&
      holds(conflict, 'completed', 'carried')
    )
      findings.push({
        check: 'next_step_completed_and_carried',
        subject: id,
        detail: `next step ${id} was completed on one copy and carried on another.`,
      });
  }

  for (const cycle of supersessionCycles(client))
    findings.push({
      check: 'supersession_cycle',
      subject: cycle.join(','),
      detail: `decisions ${cycle.join(', ')} supersede each other in a circle.`,
    });

  findings.push(...decisionsLeftInClosedSprints(client));

  for (const sprint of rows<{ id: string; missions: string }>(
    client,
    `SELECT s.id, group_concat(m.id, ', ') AS missions FROM sprints s
       JOIN missions m ON m.sprint_id = s.id
      WHERE ${statusInSql('s.status', ['Completed'])} AND ${statusInSql('m.status', UNFINISHED_MISSION_STATUSES)}
      GROUP BY s.id ORDER BY s.id`
  ))
    findings.push({
      check: 'completed_sprint_with_open_missions',
      subject: sprint.id,
      detail: `${sprint.id} is completed, but mission(s) ${sprint.missions} in it are still open.`,
    });
  return findings;
}

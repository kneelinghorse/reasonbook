// ABOUTME: Builds sprint retrospectives from recorded work and sprint-scoped session evidence.
// ABOUTME: Explicit sprint sessions and sessions linked through mission work count once per sprint.
/**
 * rbook_sprint retro action
 *
 * Auto-generates a sprint retrospective report from captured data:
 * missions, decisions, learnings, sessions, and computed KPIs.
 * Output is structured for both git commit summaries and dashboard rendering.
 *
 * Read-only — does not mutate the database.
 *
 * @module tools/rbook/rbook-sprint-retro
 */

import { normalizeMissionStatus } from './terminal-status';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import {
  prepareSpinOutRead,
  spinOutDetails,
  spinOutHistoryLines,
  type SpinOutDetails,
} from './spin-out-read';
import { createError, createSuccess, RbookErrors } from './errors';
import { buildUntaggedSessionAdvisory } from './untagged-advisory';
import { appendWarnings } from './format-warnings';
import { isParkedMissionStatus } from './terminal-status';
import { storedTimeMs } from './stored-time';
import {
  callText,
  nextPageCall,
  pageFacts,
  pageRequest,
  shownLine,
  type PageRequest,
} from './answer-page';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';

/**
 * s106-m03: missions, sessions, decisions and learnings per page. This repo's sprint-96 retro was
 * 114,044 characters (14 missions, 21 sessions, 123 decisions and 39 learnings, in full), past the
 * 20,000 cap; with previews, 5 of each still reached 21,403 on an OODS-Forge sprint, the commit
 * summary (one line per mission, 21 missions at most here) going out in both copies.
 */
export const RETRO_PAGE_SIZE = 3;

/**
 * Mission summary in the retrospective.
 */
export interface RetroMissionSummary extends SpinOutDetails {
  id: string;
  name: string;
  status: string;
  /** s106-m03: a preview of at most 300 characters; rbook_mission show has the notes whole */
  notes: string | null;
  notesTruncated: boolean;
  notesFullLength: number;
  startedAt: string | null;
  completedAt: string | null;
  cycleTimeDays: number | null;
}

/**
 * Decision summary in the retrospective.
 */
export interface RetroDecisionSummary {
  id: number;
  /** s106-m03: a preview of at most 300 characters; rbook_decisions show has it whole */
  text: string;
  truncated: boolean;
  fullLength: number;
  category: string | null;
  status: string;
}

/**
 * Learning summary in the retrospective.
 */
export interface RetroLearningSummary {
  id: number;
  /** s106-m03: a preview of at most 300 characters; rbook_learnings show has it whole */
  content: string;
  truncated: boolean;
  fullLength: number;
  category: string | null;
}

/**
 * Carry-forward item identified during retro.
 */
export interface RetroCarryForward {
  type: 'blocked_mission' | 'open_item';
  /** s106-m03: a preview of at most 300 characters; the mission's notes are whole in show */
  description: string;
  truncated: boolean;
  fullLength: number;
  missionId?: string;
}

/**
 * Session summary with linked missions for retrospective.
 */
export interface RetroSessionSummary {
  id: string;
  type: string;
  title: string;
  status: string;
  linkedMissionIds: string[];
}

/**
 * KPIs computed for the retrospective.
 */
export interface RetroKPIs {
  /** s86-m08: EXCLUDES parked (Deferred/Dropped) work — the denominator completionRate uses. */
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
  /** s86-m08: Deferred + Dropped. Outside totalMissions, reported so it is not hidden. */
  parkedMissions: number;
  completionRate: number;
  avgCycleTimeDays: number | null;
  totalDecisions: number;
  totalLearnings: number;
  totalSessions: number;
  /** Sessions with at least one mission linkage */
  linkedSessions: number;
}

/**
 * Full sprint retrospective result.
 */
export interface SprintRetroResult {
  /** Sprint metadata */
  sprint: {
    id: string;
    title: string;
    /** s106-m03: a preview of at most 300 characters; rbook_sprint show has it whole */
    focus: string | null;
    focusTruncated: boolean;
    focusFullLength: number;
    status: string | null;
    startDate: string | null;
    endDate: string | null;
  };

  /** Mission summaries: this page's, notes previewed; the kpis and commitSummary cover every one */
  missions: RetroMissionSummary[];

  /** Session summaries with linked missions: this page's; kpis.totalSessions counts all */
  sessions: RetroSessionSummary[];

  /** Decisions captured during the sprint: this page's, oldest first; kpis.totalDecisions counts all */
  decisions: RetroDecisionSummary[];

  /** Learnings captured during the sprint: this page's, oldest first; kpis.totalLearnings counts all */
  learnings: RetroLearningSummary[];

  /** Computed KPIs */
  kpis: RetroKPIs;

  /** Items that carry forward to the next sprint */
  carryForwards: RetroCarryForward[];

  /** Pre-formatted git commit summary */
  commitSummary: string;

  /** s106-m03: this page's number; each page holds RETRO_PAGE_SIZE rows of each list. */
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next page, or null on the last page. */
  nextPageCall: string | null;
}

export interface RbookSprintRetroParams {
  /** Sprint ID to generate retro for */
  sprintId: string;
  /** s106-m03: page of decisions and learnings, 1-based */
  page?: number;
  /** Optional project root */
  projectRoot?: string;
}

export async function rbookSprintRetro(
  params: RbookSprintRetroParams
): Promise<RbookToolResult<SprintRetroResult>> {
  if (!params.sprintId) {
    return createError(RbookErrors.missingParameter('sprintId'));
  }

  return withClient(
    (client) => {
      // Get sprint info
      const sprintRow = client.getOne<{
        id: string;
        title: string;
        focus: string | null;
        status: string | null;
        start_date: string | null;
        end_date: string | null;
      }>('SELECT id, title, focus, status, start_date, end_date FROM sprints WHERE id = ?', [
        params.sprintId,
      ]);

      if (!sprintRow.success || !sprintRow.data) {
        return createError<SprintRetroResult>({
          code: 'SPRINT_NOT_FOUND',
          message: `Sprint '${params.sprintId}' not found`,
          suggestion: 'Use rbook_sprint(action="list") to find valid sprint IDs',
        });
      }

      const sprint = sprintRow.data;

      // Get missions
      const visibility = prepareSpinOutRead(client);
      const missions = getMissions(client, params.sprintId).map((mission) => ({
        ...mission,
        ...spinOutDetails(visibility, 'mission', mission.id),
      }));

      // Get decisions
      const decisions = getDecisions(client, params.sprintId);

      // Get learnings
      const learnings = getLearnings(client, params.sprintId);

      // Get sessions with linked missions
      const sessionResult = getSessions(client, params.sprintId);
      if (!sessionResult.success) return createError<SprintRetroResult>(sessionResult.error!);
      const sessions = sessionResult.data!;
      const sessionCount = sessions.length;

      // Compute KPIs
      const completedMissions = missions.filter(
        (m) => normalizeMissionStatus(m.status) === 'Completed'
      );
      const blockedMissions = missions.filter((m) => m.status === 'Blocked');
      // s86-m08: retro computes from a raw missions SELECT, NOT from sprint_summary, so the
      // view fix does not reach it. Same rule, same source constant — a sprint is not scored
      // against work it deliberately parked, and the parked count is reported beside it.
      const parkedMissions = missions.filter((m) => isParkedMissionStatus(m.status));
      const ownedMissions = missions.length - parkedMissions.length;

      const cycleTimes = completedMissions
        .filter((m) => m.startedAt && m.completedAt)
        .map((m) => {
          const start = storedTimeMs(m.startedAt);
          const end = storedTimeMs(m.completedAt);
          return (end - start) / (1000 * 60 * 60 * 24);
        });

      const avgCycleTimeDays =
        cycleTimes.length > 0
          ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 100) / 100
          : null;

      const linkedSessions = sessions.filter((s) => s.linkedMissionIds.length > 0).length;

      const kpis: RetroKPIs = {
        totalMissions: ownedMissions,
        completedMissions: completedMissions.length,
        blockedMissions: blockedMissions.length,
        parkedMissions: parkedMissions.length,
        completionRate:
          ownedMissions > 0 ? Math.round((completedMissions.length / ownedMissions) * 100) : 0,
        avgCycleTimeDays,
        totalDecisions: decisions.length,
        totalLearnings: learnings.length,
        totalSessions: sessionCount,
        linkedSessions,
      };

      // Identify carry-forwards
      const carryForwards: RetroCarryForward[] = [];
      for (const m of blockedMissions) {
        const description = `${m.id}: ${m.name} — ${m.notes ?? 'No details'}`;
        carryForwards.push({
          type: 'blocked_mission',
          description,
          truncated: false,
          fullLength: description.length,
          missionId: m.id,
        });
      }

      // Generate commit summary
      const commitSummary = generateCommitSummary(
        sprint,
        missions,
        kpis,
        decisions.length,
        carryForwards
      );

      // Mission links include untagged sessions here without changing their stored sprint tags.
      const untaggedAdvisory = buildUntaggedSessionAdvisory(client, 'mission-link');

      // s106-m03: every figure above read the full rows; the answer carries previews and a page.
      const request = pageRequest(params.page, undefined, RETRO_PAGE_SIZE);
      const longest = Math.max(
        missions.length,
        sessions.length,
        decisions.length,
        learnings.length
      );
      const facts = pageFacts(
        request,
        Math.min(request.pageSize, Math.max(0, longest - request.offset)),
        longest
      );
      const focus = sprint.focus === null ? null : previewText(sprint.focus);

      return createSuccess<SprintRetroResult>(
        {
          sprint: {
            id: sprint.id,
            title: sprint.title,
            focus: focus?.preview ?? null,
            focusTruncated: focus?.truncated ?? false,
            focusFullLength: focus?.fullLength ?? 0,
            status: sprint.status,
            startDate: sprint.start_date,
            endDate: sprint.end_date,
          },
          missions: onPage(missions, request).map((mission) => {
            const notes = mission.notes === null ? null : previewText(mission.notes);
            return {
              ...mission,
              notes: notes?.preview ?? null,
              notesTruncated: notes?.truncated ?? false,
              notesFullLength: notes?.fullLength ?? 0,
            };
          }),
          sessions: onPage(sessions, request),
          decisions: onPage(decisions, request).map((decision) => {
            const { preview, truncated, fullLength } = previewText(decision.text);
            return { ...decision, text: preview, truncated, fullLength };
          }),
          learnings: onPage(learnings, request).map((learning) => {
            const { preview, truncated, fullLength } = previewText(learning.content);
            return { ...learning, content: preview, truncated, fullLength };
          }),
          kpis,
          carryForwards: carryForwards.map((item) => {
            const { preview, truncated, fullLength } = previewText(item.description);
            return { ...item, description: preview, truncated, fullLength };
          }),
          commitSummary,
          page: facts.page,
          hasMore: facts.hasMore,
          nextPage: facts.nextPage,
          nextPageCall: nextPageCall(facts.nextPage, 'rbook_sprint', {
            action: 'retro',
            sprintId: params.sprintId,
            projectRoot: params.projectRoot,
          }),
        },
        [
          ...(untaggedAdvisory ? [untaggedAdvisory] : []),
          ...spinOutHistoryLines(
            visibility,
            missions.map((mission) => mission.id)
          ),
        ]
      );
    },
    { projectRoot: params.projectRoot }
  );
}

function getMissions(client: RbookDatabaseClient, sprintId: string): RetroMissionSummary[] {
  const result = client.getMany<{
    id: string;
    name: string;
    status: string;
    notes: string | null;
    started_at: string | null;
    completed_at: string | null;
  }>(
    `SELECT id, name, status, notes, started_at, completed_at
     FROM missions WHERE sprint_id = ?
     ORDER BY rowid ASC`,
    [sprintId]
  );

  if (!result.success || !result.data) return [];

  return result.data.map((m) => {
    let cycleTimeDays: number | null = null;
    if (m.started_at && m.completed_at) {
      const start = storedTimeMs(m.started_at);
      const end = storedTimeMs(m.completed_at);
      cycleTimeDays = Math.round(((end - start) / (1000 * 60 * 60 * 24)) * 100) / 100;
    }

    return {
      id: m.id,
      name: m.name,
      status: m.status,
      notes: m.notes,
      notesTruncated: false,
      notesFullLength: m.notes?.length ?? 0,
      startedAt: m.started_at,
      completedAt: m.completed_at,
      cycleTimeDays,
    };
  });
}

function getDecisions(client: RbookDatabaseClient, sprintId: string): RetroDecisionSummary[] {
  const result = client.getMany<{
    id: number;
    decision_text: string;
    category: string | null;
    status: string;
  }>(
    `SELECT id, decision_text, category, status
     FROM strategic_decisions
     WHERE sprint_id = ?
     ORDER BY julianday(created_at) ASC, id ASC`,
    [sprintId]
  );

  if (!result.success || !result.data) return [];

  return result.data.map((d) => ({
    id: d.id,
    text: d.decision_text,
    truncated: false,
    fullLength: d.decision_text.length,
    category: d.category,
    status: d.status,
  }));
}

function getLearnings(client: RbookDatabaseClient, sprintId: string): RetroLearningSummary[] {
  // Check if learnings table exists
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'`
  );
  if (!tableCheck.success || !tableCheck.data) return [];

  const result = client.getMany<{
    id: number;
    content: string;
    category: string | null;
  }>(
    `SELECT id, content, category
     FROM learnings
     WHERE sprint_id = ?
     ORDER BY julianday(created_at) ASC, id ASC`,
    [sprintId]
  );

  if (!result.success || !result.data) return [];

  return result.data.map((l) => ({
    id: l.id,
    content: l.content,
    truncated: false,
    fullLength: l.content.length,
    category: l.category,
  }));
}

function getSessions(
  client: RbookDatabaseClient,
  sprintId: string
): RbookToolResult<RetroSessionSummary[]> {
  const failure = (message: string): RbookToolResult<RetroSessionSummary[]> =>
    createError({
      code: 'DB_QUERY_FAILED',
      message: `Could not read sprint sessions: ${message}`,
      suggestion:
        'Check the sessions, missions and session_missions tables, then retry the retrospective.',
    });
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='session_missions'`
  );
  if (!tableCheck.success)
    return failure(tableCheck.error?.message ?? 'junction table lookup failed');
  const hasJunctionTable = !!tableCheck.data;
  const result = client.getMany<{
    id: string;
    type: string;
    title: string;
    status: string;
  }>(
    `SELECT s.id, s.type, s.title, s.status FROM sessions s WHERE s.sprint_id = ?
     ${
       hasJunctionTable
         ? `OR EXISTS (SELECT 1 FROM session_missions sm JOIN missions m ON m.id = sm.mission_id
       WHERE sm.session_id = s.id AND m.sprint_id = ?)`
         : ''
     }
     ORDER BY julianday(s.started_at) ASC, s.id ASC`,
    hasJunctionTable ? [sprintId, sprintId] : [sprintId]
  );
  if (!result.success) return failure(result.error?.message ?? 'session lookup failed');
  const sessions: RetroSessionSummary[] = [];
  for (const session of result.data ?? []) {
    let linkedMissionIds: string[] = [];
    if (hasJunctionTable) {
      const links = client.getMany<{ mission_id: string }>(
        `SELECT sm.mission_id FROM session_missions sm JOIN missions m ON m.id = sm.mission_id
         WHERE sm.session_id = ? AND m.sprint_id = ? ORDER BY sm.mission_id`,
        [session.id, sprintId]
      );
      if (!links.success) return failure(links.error?.message ?? 'session links lookup failed');
      linkedMissionIds = (links.data ?? []).map((link) => link.mission_id);
    }
    sessions.push({ ...session, linkedMissionIds });
  }
  return createSuccess(sessions);
}

function onPage<T>(rows: readonly T[], request: PageRequest): T[] {
  return rows.slice(request.offset, request.offset + request.pageSize);
}

/**
 * Generate a compact git commit summary in the established format.
 */
function generateCommitSummary(
  sprint: { id: string; title: string; status: string | null },
  missions: RetroMissionSummary[],
  kpis: RetroKPIs,
  decisionCount: number,
  carryForwards: RetroCarryForward[]
): string {
  const completedCount = missions.filter(
    (m) => normalizeMissionStatus(m.status) === 'Completed'
  ).length;
  const totalCount = missions.length;
  const statusTag = sprint.status === 'Completed' ? 'Complete' : (sprint.status ?? 'In Progress');

  const lines: string[] = [];

  // Header
  lines.push(
    `${sprint.id.replace('sprint-', 'Sprint ')}: ${sprint.title} — ${statusTag} (${completedCount}/${totalCount})`
  );

  // Mission table
  lines.push('Mission\tName\tKey Deliverables');
  for (const m of missions) {
    const deliverables = extractDeliverables(m.notes);
    lines.push(`${m.id}\t${m.name}\t${deliverables}`);
  }

  // Stats line
  const statParts: string[] = [];
  if (decisionCount > 0) statParts.push(`${decisionCount} decisions captured`);
  if (kpis.totalLearnings > 0) statParts.push(`${kpis.totalLearnings} learnings`);
  if (kpis.avgCycleTimeDays !== null) {
    statParts.push(`avg cycle time: ${kpis.avgCycleTimeDays}d`);
  }

  if (statParts.length > 0) {
    lines.push(statParts.join('. ') + '.');
  }

  // Carry-forwards
  if (carryForwards.length > 0) {
    // s106-m03: each carry-forward as its preview; mission show reads a blocked mission's notes.
    lines.push(
      `Carry-forwards: ${carryForwards.map((cf) => previewText(cf.description).preview).join('; ')}`
    );
  }

  return lines.join('\n');
}

/**
 * Extract a compact deliverables summary from mission notes.
 * Takes the first sentence or line, truncated to 120 chars.
 */
function extractDeliverables(notes: string | null): string {
  if (!notes) return '—';

  // Take first meaningful line
  const lines = notes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return '—';

  const first = lines[0];
  return first.length > 120 ? first.slice(0, 117) + '...' : first;
}

/**
 * Format retro result for LLM readability.
 */
export function formatSprintRetroForLLM(result: RbookToolResult<SprintRetroResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to generate sprint retrospective',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header
  lines.push('📊 **Sprint Retrospective**');
  lines.push('');
  lines.push(`**${data.sprint.id}**: ${data.sprint.title} (${data.sprint.status ?? 'unknown'})`);
  if (data.sprint.focus) {
    lines.push(`Focus: ${data.sprint.focus}`);
  }

  // KPIs
  lines.push('');
  lines.push('**KPIs**');
  lines.push(
    `  Completion: ${data.kpis.completedMissions}/${data.kpis.totalMissions} (${data.kpis.completionRate}%)`
  );
  if (data.kpis.parkedMissions > 0) {
    lines.push(`  Parked (Deferred/Dropped, outside the rate above): ${data.kpis.parkedMissions}`);
  }
  if (data.kpis.blockedMissions > 0) {
    lines.push(`  Blocked: ${data.kpis.blockedMissions}`);
  }
  if (data.kpis.avgCycleTimeDays !== null) {
    lines.push(`  Avg cycle time: ${data.kpis.avgCycleTimeDays} days`);
  }
  lines.push(
    `  Decisions: ${data.kpis.totalDecisions} | Learnings: ${data.kpis.totalLearnings} | Sessions: ${data.kpis.totalSessions}${data.kpis.linkedSessions > 0 ? ` (${data.kpis.linkedSessions} mission-linked)` : ''}`
  );

  // s106-m03: every row of each list on the page; the totals count the whole sprint.
  const pageOf = (totalCount: number) => ({
    page: data.page,
    pageSize: RETRO_PAGE_SIZE,
    totalCount,
  });
  const headed = (label: string, totalCount: number, returned: number, noun: string): string => {
    const shown = shownLine(pageOf(totalCount), returned, noun);
    return `**${label}: ${shown[0].toLowerCase()}${shown.slice(1)}**`;
  };

  // Missions
  lines.push('');
  lines.push(
    headed(
      'Missions',
      data.kpis.totalMissions + data.kpis.parkedMissions,
      data.missions.length,
      'missions'
    )
  );
  for (const m of data.missions) {
    const icon =
      normalizeMissionStatus(m.status) === 'Completed' ? '✓' : m.status === 'Blocked' ? '✗' : '○';
    const cycle = m.cycleTimeDays !== null ? ` (${m.cycleTimeDays}d)` : '';
    lines.push(`  ${icon} ${m.id}: ${m.name}${cycle}`);
    if (m.notes) {
      const short = m.notes.length > 150 ? m.notes.slice(0, 147) + '...' : m.notes;
      lines.push(`    ${short}`);
    }
  }

  // Sessions with mission linkage
  if (data.sessions.length > 0) {
    const linked = data.sessions.filter((s) => s.linkedMissionIds.length > 0);
    if (linked.length > 0) {
      lines.push('');
      lines.push(
        `**Sessions with Mission Links (${linked.length} on this page; ${data.kpis.linkedSessions} of ${data.kpis.totalSessions} sessions in all)**`
      );
      for (const s of linked) {
        lines.push(`  ${s.id}: ${s.title} [${s.type}] -> ${s.linkedMissionIds.join(', ')}`);
      }
    }
  }

  if (data.kpis.totalDecisions > 0) {
    lines.push('');
    lines.push(headed('Decisions', data.kpis.totalDecisions, data.decisions.length, 'decisions'));
    for (const d of data.decisions) {
      const cat = d.category ? ` [${d.category}]` : '';
      const text = d.text.length > 120 ? d.text.slice(0, 117) + '...' : d.text;
      lines.push(`  #${d.id}${cat}: ${text}`);
    }
    const cut = data.decisions.find((d) => d.truncated);
    if (cut)
      lines.push(
        `  Previews are cut at ${PREVIEW_MAX_CHARS} characters; read one whole with rbook_decisions(action="show", decisionId=${cut.id}).`
      );
  }

  if (data.kpis.totalLearnings > 0) {
    lines.push('');
    lines.push(headed('Learnings', data.kpis.totalLearnings, data.learnings.length, 'learnings'));
    for (const l of data.learnings) {
      const cat = l.category ? ` [${l.category}]` : '';
      const text = l.content.length > 120 ? l.content.slice(0, 117) + '...' : l.content;
      lines.push(`  • #${l.id}${cat} ${text}`);
    }
    const cut = data.learnings.find((l) => l.truncated);
    if (cut)
      lines.push(
        `  Previews are cut at ${PREVIEW_MAX_CHARS} characters; read one whole with rbook_learnings(action="show", learningId=${cut.id}).`
      );
  }

  // Carry-forwards
  if (data.carryForwards.length > 0) {
    lines.push('');
    lines.push(`**Carry-Forwards (${data.carryForwards.length})**`);
    for (const cf of data.carryForwards) {
      lines.push(`  → ${cf.description}`);
    }
  }

  // Commit summary
  lines.push('');
  lines.push('**Git Commit Summary**');
  lines.push('```');
  lines.push(data.commitSummary);
  lines.push('```');

  const cutMissionId =
    data.missions.find((m) => m.notesTruncated)?.id ??
    data.carryForwards.find((cf) => cf.truncated && cf.missionId)?.missionId;
  if (cutMissionId)
    lines.push(
      `Mission notes are previews of at most ${PREVIEW_MAX_CHARS} characters; read one whole with ${callText('rbook_mission', { action: 'show', missionId: cutMissionId })}.`
    );
  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);

  appendWarnings(lines, result);

  return lines.join('\n');
}

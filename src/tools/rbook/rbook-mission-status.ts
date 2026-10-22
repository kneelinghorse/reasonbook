/**
 * rbook_mission_status Tool
 *
 * MCP tool for showing the active work queue from the Reasonbook database.
 * Provides a quick view of current/queued/in-progress missions to understand
 * what to work on next.
 *
 * Priority order:
 * 1. In Progress missions (actively being worked on)
 * 2. Current missions (selected but not started)
 * 3. Queued missions (limited, upcoming work)
 *
 * Optionally shows blocked missions separately for visibility.
 *
 * @module tools/rbook/rbook-mission-status
 */

import { z } from 'zod';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult, Mission, MissionStatus, Sprint } from './types';
import { createError, createSuccess } from './errors';
import { resolveCurrentSprintId } from './current-sprint';
import { getProjectId } from './genesis-columns';
import { frameInlineIfForeign, isForeignProject } from '../../intelligence/provenance-frame';
import { activeMissionsAcrossProjects } from '../../intelligence/cross-store-queries';
import type { CrossStoreError, CrossStoreQueryResult } from '../../intelligence/cross-store-query';
import type { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { appendWarnings } from './format-warnings';
import { sprintIdOrderSql } from './sprint-ordering';
import { firstReady, orderByRequires } from './work-queue-order';

/**
 * Mission item with sprint context for the status view.
 */
export interface StatusMissionItem {
  /** Mission ID (e.g., "s12-m07") */
  id: string;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Mission objective */
  objective: string | null;

  /** Success criteria (parsed from JSON) */
  successCriteria: string[] | null;

  /** Deliverables (parsed from JSON) */
  deliverables: string[] | null;

  /** Notes about the mission */
  notes: string | null;

  /** Sprint context */
  sprint: SprintContext | null;

  /** s84-m03: the mission's own project_id (guarded read). Foreign → name/objective framed. */
  projectId?: string | null;

  /**
   * s97-m13: a queued mission's Requires targets that are not Completed; absent when it waits on
   * none (work-queue-order.ts).
   */
  waitsOn?: string[];
}

/**
 * Sprint context for a mission.
 */
export interface SprintContext {
  /** Sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Sprint focus area */
  focus: string | null;

  /** Sprint status */
  status: string | null;

  /** Total missions in sprint */
  totalMissions: number | null;

  /** Completed missions in sprint */
  completedMissions: number | null;

  /** s84-m03: the sprint's own project_id (guarded read). Foreign → title/focus framed. */
  projectId?: string | null;
}

/**
 * Result type for rbook_mission_status.
 */
export interface RbookMissionStatusResult {
  /** Active sprint (the sprint currently being worked on) */
  activeSprint: SprintContext | null;

  /** Missions currently in progress (highest priority) */
  inProgress: StatusMissionItem[];

  /** Missions marked as current (selected, not started) */
  current: StatusMissionItem[];

  /** Queued missions (upcoming work, limited) */
  queued: StatusMissionItem[];

  /** Blocked missions (if includeBlocked was true) */
  blocked: StatusMissionItem[] | null;

  /** Summary of work queue state */
  summary: {
    /** Total active items (in_progress + current) */
    activeCount: number;

    /** Number of queued items */
    queuedCount: number;

    /** Number of blocked items (if included) */
    blockedCount: number | null;

    /** Recommendation for what to do next */
    nextAction: string;
  };

  /** s84-m03: the querying store's own project_id. Work-queue rows whose projectId differs
   *  are foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for rbook_mission_status tool.
 */
export const rbookMissionStatusSchema = z.object({
  /** Whether to include blocked missions separately */
  includeBlocked: z
    .boolean()
    .optional()
    .describe('Include blocked missions in a separate section (default: false)'),

  /** Maximum number of queued missions to return */
  queuedLimit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum queued missions to show (1-50, default: 5)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionStatusParams = z.infer<typeof rbookMissionStatusSchema>;

/**
 * MCP Tool Definition for rbook_mission_status.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionStatusToolDefinition = {
  name: 'rbook_mission_status',
  description:
    'Show the active work queue from the Reasonbook database. ' +
    'Returns missions in priority order: In Progress first, then Current, then Queued. ' +
    'Each mission includes its sprint context. ' +
    'Optionally includes blocked missions in a separate section. ' +
    'Use this to quickly understand what to work on next.',
  inputSchema: {
    type: 'object',
    properties: {
      includeBlocked: {
        type: 'boolean',
        default: false,
        description: 'Include blocked missions in a separate section (default: false)',
      },
      queuedLimit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 5,
        description: 'Maximum queued missions to show (1-50, default: 5)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_mission_status tool.
 *
 * Retrieves the active work queue from the Reasonbook database, organized
 * by priority (in_progress > current > queued). Includes sprint context
 * for each mission to help agents understand the work context.
 *
 * @param params - Tool parameters (includeBlocked, queuedLimit, projectRoot)
 * @returns RbookToolResult with status view or actionable error
 */
export async function rbookMissionStatus(
  params: RbookMissionStatusParams = {}
): Promise<RbookToolResult<RbookMissionStatusResult>> {
  const includeBlocked = params.includeBlocked ?? false;
  const queuedLimit = params.queuedLimit ?? 5;

  return withClient(
    (client) => {
      // Fetch sprints for context lookup
      const sprintsResult = client.getMany<Sprint>('SELECT * FROM sprints');
      if (!sprintsResult.success) {
        return createError<RbookMissionStatusResult>(
          sprintsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to fetch sprints' }
        );
      }
      const sprintsMap = new Map((sprintsResult.data ?? []).map((s) => [s.id, s]));

      // Identify the active sprint for queue scoping
      const activeSprintInfo = findActiveSprint(client, sprintsMap);
      const activeSprint = activeSprintInfo ? sprintToContext(activeSprintInfo.sprint) : null;

      // Fetch In Progress missions (no limit - show all active work)
      const inProgressResult = client.getMany<Mission>(
        `SELECT * FROM missions WHERE status = 'In Progress' ORDER BY ${sprintIdOrderSql('sprint_id', 'DESC')}, id ASC`
      );
      if (!inProgressResult.success) {
        return createError<RbookMissionStatusResult>(
          inProgressResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to fetch in-progress missions',
          }
        );
      }

      // Fetch Current missions (selected but not started)
      const currentResult = client.getMany<Mission>(
        `SELECT * FROM missions WHERE status = 'Current' ORDER BY ${sprintIdOrderSql('sprint_id', 'DESC')}, id ASC`
      );
      if (!currentResult.success) {
        return createError<RbookMissionStatusResult>(
          currentResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to fetch current missions',
          }
        );
      }

      // Fetch Queued missions - scoped to active sprint when identified
      let queuedMissions: Mission[] = [];
      if (activeSprintInfo && activeSprintInfo.isComplete) {
        const queuedResult = client.getMany<Mission>(
          "SELECT * FROM missions WHERE status = 'Queued' AND sprint_id IS NULL ORDER BY id ASC"
        );
        if (!queuedResult.success)
          return createError<RbookMissionStatusResult>({
            code: queuedResult.error?.code ?? 'DB_QUERY_FAILED',
            message: queuedResult.error?.message ?? 'Failed to list unscheduled missions',
            suggestion: 'Restore read access to the missions table and retry mission status.',
          });
        queuedMissions = queuedResult.data ?? [];
      } else if (activeSprintInfo) {
        // Scope queued to active sprint only
        const queuedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Queued' AND (sprint_id = ? OR sprint_id IS NULL) ORDER BY id ASC`,
          [activeSprintInfo.sprint.id]
        );
        if (!queuedResult.success) {
          return createError<RbookMissionStatusResult>(
            queuedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch queued missions',
            }
          );
        }
        queuedMissions = queuedResult.data ?? [];
      } else {
        // No active sprint - show all queued as fallback
        const queuedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Queued' ORDER BY ${sprintIdOrderSql('sprint_id', 'DESC')}, id ASC`
        );
        if (!queuedResult.success) {
          return createError<RbookMissionStatusResult>(
            queuedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch queued missions',
            }
          );
        }
        queuedMissions = queuedResult.data ?? [];
      }

      // Fetch Blocked missions if requested
      let blockedMissions: StatusMissionItem[] | null = null;
      if (includeBlocked) {
        const blockedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Blocked' ORDER BY ${sprintIdOrderSql('sprint_id', 'DESC')}, id ASC`
        );
        if (!blockedResult.success) {
          return createError<RbookMissionStatusResult>(
            blockedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch blocked missions',
            }
          );
        }
        blockedMissions = (blockedResult.data ?? []).map((m) =>
          parseMissionWithContext(m, sprintsMap)
        );
      }

      // Parse missions with context
      const inProgress = (inProgressResult.data ?? []).map((m) =>
        parseMissionWithContext(m, sprintsMap)
      );
      const current = (currentResult.data ?? []).map((m) => parseMissionWithContext(m, sprintsMap));
      // s97-m13 (#662): the whole queue in Requires order, then the limit; the next action reads
      // the whole of it, so a ready mission past the limit is still the one named.
      const ordered = orderByRequires(client, queuedMissions);
      const queue = ordered.missions.map((m) => ({
        ...parseMissionWithContext(m, sprintsMap),
        ...(m.waitsOn ? { waitsOn: m.waitsOn } : {}),
      }));
      const queued = queue.slice(0, queuedLimit);

      // Calculate summary
      const activeCount = inProgress.length + current.length;
      const queuedCount = queued.length;
      const blockedCount = blockedMissions?.length ?? null;

      // Determine next action recommendation
      const nextAction = determineNextAction(
        inProgress,
        current,
        queue,
        blockedMissions,
        activeSprintInfo,
        getProjectId(client)
      );

      return createSuccess(
        {
          activeSprint,
          inProgress,
          current,
          queued,
          blocked: blockedMissions,
          summary: {
            activeCount,
            queuedCount,
            blockedCount,
            nextAction,
          },
          localProjectId: getProjectId(client),
        },
        ordered.warning ? [ordered.warning] : undefined
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Parse a mission record with sprint context.
 */
function parseMissionWithContext(
  mission: Mission,
  sprintsMap: Map<string, Sprint>
): StatusMissionItem {
  const sprint = mission.sprint_id ? sprintsMap.get(mission.sprint_id) : null;

  return {
    id: mission.id,
    name: mission.name,
    status: mission.status,
    objective: mission.objective,
    successCriteria: parseJsonArray(mission.success_criteria),
    deliverables: parseJsonArray(mission.deliverables),
    notes: mission.notes,
    // s84-m03: guarded project_id read (SELECT * → present when the column exists, null on
    // an ancient store). Sprint carries its OWN project_id (a mission can link a foreign sprint).
    projectId: (mission as unknown as Record<string, string | null>).project_id ?? null,
    sprint: sprint
      ? {
          id: sprint.id,
          title: sprint.title,
          // The active sprint carries its focus once; preserve the published nested field.
          focus: null,
          status: sprint.status,
          totalMissions: sprint.total_missions,
          completedMissions: sprint.completed_missions,
          projectId: (sprint as unknown as Record<string, string | null>).project_id ?? null,
        }
      : null,
  };
}

/**
 * Safely parse a JSON array string.
 */
function parseJsonArray(jsonString: string | null): string[] | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a Sprint record to SprintContext format.
 */
function sprintToContext(sprint: Sprint): SprintContext {
  return {
    id: sprint.id,
    title: sprint.title,
    focus: sprint.focus,
    status: sprint.status,
    totalMissions: sprint.total_missions,
    completedMissions: sprint.completed_missions,
    projectId: (sprint as unknown as Record<string, string | null>).project_id ?? null,
  };
}

/**
 * Active sprint detection result.
 */
interface ActiveSprintInfo {
  /** The sprint record */
  sprint: Sprint;
  /** Whether the sprint has no remaining work (all completed/blocked) */
  isComplete: boolean;
}

/**
 * Find the active sprint by examining mission states.
 *
 * s77-m02: identity is delegated to the canonical resolveCurrentSprintId so this
 * surface names the SAME current sprint as onboard / review / session-start (was
 * a divergent 3-step picker whose `start_date ASC` Step 2 disagreed with onboard's
 * `DESC` — the #853 split). `isComplete` stays a LOCAL computation: the resolved
 * sprint has missions and none of them are still open.
 */
function findActiveSprint(
  client: RbookDatabaseClient,
  sprintsMap: Map<string, Sprint>
): ActiveSprintInfo | null {
  const sprintId = resolveCurrentSprintId(client);
  if (!sprintId) {
    return null;
  }
  const sprint = sprintsMap.get(sprintId);
  if (!sprint) {
    return null;
  }
  return { sprint, isComplete: isSprintComplete(client, sprintId) };
}

/**
 * A sprint is "complete" for queue-scoping when it has at least one mission and
 * none are still open (In Progress / Current / Queued / Blocked). A sprint with no
 * missions yet is not complete (there is nothing done).
 */
function isSprintComplete(client: RbookDatabaseClient, sprintId: string): boolean {
  const hasMissions = client.getOne<{ one: number }>(
    `SELECT 1 AS one FROM missions WHERE sprint_id = ? LIMIT 1`,
    [sprintId]
  );
  if (!hasMissions.success || !hasMissions.data) {
    return false;
  }
  const openMission = client.getOne<{ one: number }>(
    `SELECT 1 AS one FROM missions
      WHERE sprint_id = ?
        AND status IN ('In Progress', 'Current', 'Queued', 'Blocked')
      LIMIT 1`,
    [sprintId]
  );
  return !(openMission.success && openMission.data);
}

/**
 * Determine the recommended next action based on queue state.
 */
function determineNextAction(
  inProgress: StatusMissionItem[],
  current: StatusMissionItem[],
  queued: StatusMissionItem[],
  blocked: StatusMissionItem[] | null,
  activeSprintInfo: ActiveSprintInfo | null,
  local: string | null
): string {
  // If there's work in progress, continue it
  if (inProgress.length > 0) {
    if (inProgress.length === 1) {
      return `Continue working on ${inProgress[0].id}: ${inProgress[0].name}`;
    }
    return `${inProgress.length} missions in progress. Continue with ${inProgress[0].id} or review parallelism.`;
  }

  // If there's a current mission, start it
  if (current.length > 0) {
    return `Start the current mission: ${current[0].id}: ${current[0].name}`;
  }

  // If there are queued missions, promote the first whose Requires targets are complete (s97-m13).
  // The mission named need not be the queue's first, where the review fences a foreign name
  // (s84-m03), so a mission pulled in from another project is named by its id alone.
  if (queued.length > 0) {
    const foreign = (m: StatusMissionItem): boolean => isForeignProject(m.projectId, local);
    const ready = firstReady(queued);
    if (ready)
      return `No active mission. Promote and start ${ready.id}${foreign(ready) ? '' : `: ${ready.name}`}`;
    const first = queued[0];
    return `No active mission. No queued mission is ready: ${first.id}${foreign(first) ? '' : ` (${first.name})`} waits on ${first.waitsOn?.join(', ')}.`;
  }

  // Sprint completion: active sprint has no remaining work
  if (activeSprintInfo?.isComplete) {
    return `Sprint ${activeSprintInfo.sprint.id} complete. Sprint review recommended before starting next sprint.`;
  }

  // If blocked missions exist and nothing else is available
  if (blocked && blocked.length > 0) {
    return `All missions blocked (${blocked.length}). Resolve blockers before continuing.`;
  }

  // Queue is empty
  return 'No missions in queue. Add new missions to continue work.';
}

/**
/**
 * One active mission in the cross-store portfolio view (s79-m05), carrying its
 * source `projectId`. Deliberately flat — this is the §5.4 named query, not the
 * single-store work-queue shape of {@link RbookMissionStatusResult}.
 */
export interface PortfolioMissionItem {
  id: string;
  name: string;
  status: string;
  projectId: string;
}

/**
 * Cross-store active-missions envelope (s79-m05). The metadata shape is IDENTICAL
 * to `rbook_decisions(acrossProjects)` (ADR §5.5 transparent-upgrade contract); only
 * the domain payload key differs (`missions`, not `decisions`).
 */
export interface RbookMissionPortfolioResult {
  missions: PortfolioMissionItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  acrossProjects: true;
  errors: CrossStoreError[];
  crossStoreMetadata: CrossStoreQueryResult['metadata'];

  /** s84-m03 (FORK-1=B): the ambient local store's project_id. A portfolio row whose
   *  projectId differs is FOREIGN and its name is framed untrusted; the local project's own
   *  rows stay bare. Null when the ambient store can't be resolved → every row is foreign
   *  (fence-more, never fence-less). The `[proj:X]` tag is metadata, not a trust boundary. */
  localProjectId?: string | null;
}

/**
 * s84-m03 (§4-minor) — resolve the ambient local store's project_id for the portfolio
 * foreign-check. Opens the ambient store (cwd/registry default) via the synchronous
 * withClient and reads getProjectId; returns null on ANY failure so the render fences
 * every row rather than mis-labeling a foreign row as local. Never throws.
 */
async function resolveAmbientLocalProjectId(projectRoot?: string): Promise<string | null> {
  try {
    // s92-m01: the dispatcher resolves the caller's project (explicit root, MCP roots, cwd) and
    // passes it here; only a direct caller with no root falls back to the cwd-based resolver.
    const res = await withClient(
      (client) => createSuccess(getProjectId(client)),
      projectRoot ? { projectRoot } : {}
    );
    return res.success ? (res.data ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * s79-m05 — `rbook_mission(status, acrossProjects=true)`. Active missions (In
 * Progress/Current) merged across the portfolio via the graph-backed
 * {@link activeMissionsAcrossProjects} (§5.4 query b). Discovers stores through the
 * project-graph registry; per-store failures are isolated on `errors`. The optional
 * `registry` seam is for deterministic tests (not exposed on the tool schema).
 */
export async function missionStatusAcrossProjects(
  opts: { limit?: number; projectRoot?: string } = {},
  // s86-m03 — internal, NON-schema seam, moved out of parameter 0 onto the rbook-review.ts:295
  // precedent (the same move applied to rbookLearningsListAcrossProjects in this mission): an
  // injectable ProjectGraphRegistry for deterministic tests of the cross-store fan-out. NOT
  // exposed on the tool inputSchema — it must never reach the MCP boundary. Sitting in
  // parameter 0 made it indistinguishable from a caller-facing param the router drops.
  internalOpts: { registry?: ProjectGraphRegistry } = {}
): Promise<RbookToolResult<RbookMissionPortfolioResult>> {
  const pageSize = opts.limit ?? 50;
  const fanout = await activeMissionsAcrossProjects({
    limit: pageSize,
    registry: internalOpts.registry,
  });

  const missions: PortfolioMissionItem[] = fanout.results.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    projectId: row.project_id,
  }));

  return createSuccess<RbookMissionPortfolioResult>({
    missions,
    totalCount: missions.length,
    page: 1,
    pageSize,
    hasMore: fanout.metadata.truncated,
    acrossProjects: true,
    errors: fanout.errors,
    crossStoreMetadata: fanout.metadata,
    localProjectId: await resolveAmbientLocalProjectId(opts.projectRoot),
  });
}

/**
 * Format the cross-store active-missions portfolio result for LLM readability.
 */
export function formatMissionPortfolioForLLM(
  result: RbookToolResult<RbookMissionPortfolioResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to retrieve portfolio missions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = ['🌐 **Active Missions (portfolio)**', ''];
  const meta = data.crossStoreMetadata;
  lines.push(
    `${data.missions.length} active mission(s) across ${meta.storesQueried} store(s)` +
      (meta.storesFailed > 0 ? ` — ${meta.storesFailed} unreachable` : '')
  );
  lines.push('');
  if (data.missions.length === 0) {
    lines.push('No active missions across the portfolio.');
  } else {
    for (const m of data.missions) {
      // s84-m03: fence a FOREIGN portfolio mission's name; the local project's own rows
      // stay bare. The [proj:X] tag is metadata (always shown), not a trust boundary.
      const name = frameInlineIfForeign(m.name, m.projectId, data.localProjectId);
      lines.push(`  📋 [${m.status}] ${m.id} — ${name}  [proj:${m.projectId}]`);
    }
  }
  if (data.errors.length > 0) {
    lines.push('');
    lines.push('⚠️  Per-store errors:');
    for (const e of data.errors) lines.push(`  - ${e.projectId || e.storePath}: ${e.error}`);
  }
  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * Format mission status result for LLM readability.
 *
 * @param result - Mission status result
 * @returns Human-readable summary
 */
export function formatMissionStatusForLLM(
  result: RbookToolResult<RbookMissionStatusResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Failed to get mission status',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];
  // s84-m03: a foreign (pull-merged) work-queue row is untrusted DATA — frame its
  // name/objective, and the sprint title/focus against the SPRINT's own project_id.
  // A local/NULL-project row renders byte-identical to 2.3.0.
  const local = data.localProjectId;

  // Header with summary
  lines.push('**Work Queue Status**');
  lines.push('');
  if (data.activeSprint) {
    const asTitle = frameInlineIfForeign(
      data.activeSprint.title,
      data.activeSprint.projectId,
      local
    );
    lines.push(`**Sprint**: ${data.activeSprint.id} - ${asTitle}`);
    if (data.activeSprint.focus) {
      lines.push(
        `  Focus: ${frameInlineIfForeign(data.activeSprint.focus, data.activeSprint.projectId, local)}`
      );
    }
    lines.push('');
  }
  lines.push(
    `Active: ${data.summary.activeCount} | Queued: ${data.summary.queuedCount}${data.summary.blockedCount !== null ? ` | Blocked: ${data.summary.blockedCount}` : ''}`
  );
  lines.push('');

  // In Progress section
  if (data.inProgress.length > 0) {
    lines.push('**In Progress:**');
    for (const m of data.inProgress) {
      lines.push(`  ${m.id}: ${frameInlineIfForeign(m.name, m.projectId, local)}`);
      if (m.objective) {
        lines.push(`    -> ${frameInlineIfForeign(truncate(m.objective, 70), m.projectId, local)}`);
      }
      if (m.sprint) {
        lines.push(
          `    [${m.sprint.id}: ${frameInlineIfForeign(m.sprint.title, m.sprint.projectId, local)}]`
        );
      }
    }
    lines.push('');
  }

  // Current section
  if (data.current.length > 0) {
    lines.push('**Current (Ready to Start):**');
    for (const m of data.current) {
      lines.push(`  ${m.id}: ${frameInlineIfForeign(m.name, m.projectId, local)}`);
      if (m.objective) {
        lines.push(`    -> ${frameInlineIfForeign(truncate(m.objective, 70), m.projectId, local)}`);
      }
      if (m.sprint) {
        lines.push(
          `    [${m.sprint.id}: ${frameInlineIfForeign(m.sprint.title, m.sprint.projectId, local)}]`
        );
      }
    }
    lines.push('');
  }

  // Queued section
  if (data.queued.length > 0) {
    lines.push('**Queued (Upcoming):**');
    for (const m of data.queued) {
      lines.push(`  ${m.id}: ${frameInlineIfForeign(m.name, m.projectId, local)}`);
      if (m.waitsOn?.length) lines.push(`    waits on ${m.waitsOn.join(', ')}`);
      if (m.sprint) {
        lines.push(`    [${m.sprint.id}]`);
      }
    }
    lines.push('');
  }

  // Blocked section (if included)
  if (data.blocked && data.blocked.length > 0) {
    lines.push('**Blocked:**');
    for (const m of data.blocked) {
      lines.push(`  ${m.id}: ${frameInlineIfForeign(m.name, m.projectId, local)}`);
      if (m.notes) {
        lines.push(`    Reason: ${truncate(m.notes, 60)}`);
      }
    }
    lines.push('');
  }

  // Next action recommendation
  lines.push('---');
  lines.push(`**Next:** ${data.summary.nextAction}`);

  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

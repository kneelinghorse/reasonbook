/**
 * rbook_context_view Tool
 *
 * MCP tool for rendering aggregated context from Reasonbook database.
 * Returns master_context and project_context merged for AI consumption.
 * Provides actionable errors when contexts are missing or corrupt.
 *
 * @module tools/rbook/rbook-context-view
 */

import { z } from 'zod';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult, Context } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import {
  buildContextSizeWarning,
  calculateContextSizeMetrics,
  resolveContextSizeSettings,
  type ContextSizeMetrics,
} from './context-retention';
import { readStaleness, sprintCountsOnClockSql, stalenessAdvisory } from './staleness-detection';
import { migrateBlobForRead } from './blob-migrations';
import { getProjectId } from './genesis-columns';
import { frameForeignText, provenanceTag } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';
import { storedTimeMs } from './stored-time';

/**
 * Parsed context content with type-safe structure.
 */
export interface ParsedContext {
  /** Original context ID from database */
  id: string;

  /** Source path (e.g., 'context/MASTER_CONTEXT.json') */
  sourcePath: string;

  /** Parsed JSON content */
  content: Record<string, unknown>;

  /** Last update timestamp */
  updatedAt: string | null;

  /** Current size metrics for this context content */
  size?: ContextSizeMetrics;
}

/**
 * Result of context view operation.
 */
export interface RbookContextViewResult {
  /** Master context (project history & strategic memory) - null in sizeOnly mode */
  masterContext: ParsedContext | null;

  /** Project context (current session state) - null in sizeOnly mode */
  projectContext: ParsedContext | null;

  /** Combined view of both contexts for quick reference */
  aggregated: {
    /** Active mission from project_context */
    activeMission: string | null;

    /** Session count from project_context */
    sessionCount: number | null;

    /** Active decisions, newest first, from strategic_decisions */
    decisions: string[];

    /** Constraints from master_context */
    constraints: string[];

    /** Active learnings, newest first, from the learnings table */
    learnings: string[];

    /** Working memory next steps from project_context */
    nextSteps: string[];
  };

  /** Per-context and aggregate size information */
  contextSizes?: {
    masterContext: ContextSizeMetrics | null;
    projectContext: ContextSizeMetrics | null;
    totalSizeKb: number;
    totalSizeBytes: number;
  };

  /** Staleness counts for decisions and learnings */
  staleness?: {
    staleDecisions: number;
    staleLearnings: number;
    threshold: number;
  };

  /** Health metrics computed from structured tables */
  healthMetrics?: {
    activeDecisionCount: number;
    activeLearningCount: number;
    staleDecisionCount: number;
    staleLearningCount: number;
    totalContextSizeKb: number;
    lastSnapshotAge: string | null;
    recentSprintCount: number;
  };

  /** Total contexts found */
  contextCount: number;

  /** View mode used for this response */
  mode?: 'full' | 'sizeOnly' | 'compact';

  /** Compact digest (only present when compact=true) */
  compact?: {
    activeMission: string | null;
    activeSprint: string | null;
    recentDecisions: string[];
    activeConstraints: string[];
    recentLearnings: string[];
    pendingNextSteps: string[];
  };
}

/**
 * Input parameters schema for rbook_context_view tool.
 */
export const rbookContextViewSchema = z.object({
  /** Optional: filter to specific context type */
  contextType: z
    .enum(['master_context', 'project_context'])
    .optional()
    .describe('Filter to specific context type. If omitted, returns both contexts merged.'),

  /** Optional: return only size metrics without content */
  sizeOnly: z
    .boolean()
    .optional()
    .describe('Return only size metrics without content. Lightweight monitoring check.'),

  /** Optional: return compact summary digest instead of full content */
  compact: z
    .boolean()
    .optional()
    .describe(
      'Return summary digest (last 5 decisions, constraints, learnings, next_steps) instead of full content.'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookContextViewParams = z.infer<typeof rbookContextViewSchema>;

/**
 * MCP Tool Definition for rbook_context_view.
 */
export const rbookContextViewToolDefinition = {
  name: 'rbook_context_view',
  description:
    'Render aggregated context from Reasonbook database. Returns master_context (project history, decisions, constraints) and project_context (current session state and next steps) merged. Use this to understand project state before starting work.',
  inputSchema: {
    type: 'object',
    properties: {
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context'],
        description: 'Filter to specific context type. If omitted, returns both contexts merged.',
      },
      sizeOnly: {
        type: 'boolean',
        description: 'Return only size metrics without content. Lightweight monitoring check.',
      },
      compact: {
        type: 'boolean',
        description:
          'Return summary digest (last 5 decisions, constraints, learnings, next_steps) instead of full content.',
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
 * Execute the rbook_context_view tool.
 *
 * Retrieves and aggregates context data from the Reasonbook database,
 * providing a unified view of project state for AI agents.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with context data or actionable error
 */
export async function rbookContextView(
  params: RbookContextViewParams = {}
): Promise<RbookToolResult<RbookContextViewResult>> {
  // Mutual exclusion validation
  if (params.sizeOnly && params.compact) {
    return createError<RbookContextViewResult>({
      code: 'INVALID_PARAMETER',
      message: 'sizeOnly and compact are mutually exclusive. Use one or the other.',
      suggestion: 'Set sizeOnly=true for size metrics only, or compact=true for a summary digest.',
    });
  }

  return withClient(
    (client) => {
      const warnings: string[] = [];
      let masterContext: ParsedContext | null = null;
      let projectContext: ParsedContext | null = null;

      // Get master_context if not filtered to project_context only
      if (!params.contextType || params.contextType === 'master_context') {
        const masterResult = getContextById(client, 'master_context');
        if (masterResult) {
          masterContext = masterResult;
        }
      }

      // Get project_context if not filtered to master_context only
      if (!params.contextType || params.contextType === 'project_context') {
        const projectResult = getContextById(client, 'project_context');
        if (projectResult) {
          projectContext = projectResult;
        }
      }

      // If filtering and nothing found, return error
      if (params.contextType && !masterContext && !projectContext) {
        return createError<RbookContextViewResult>(RbookErrors.contextNotFound(params.contextType));
      }

      const masterSize = masterContext?.size ?? null;
      const projectSize = projectContext?.size ?? null;
      const totalSizeKb = (masterSize?.sizeKb ?? 0) + (projectSize?.sizeKb ?? 0);
      const totalSizeBytes = (masterSize?.sizeBytes ?? 0) + (projectSize?.sizeBytes ?? 0);

      const masterWarning = masterSize
        ? buildContextSizeWarning('master_context', masterSize)
        : null;
      const projectWarning = projectSize
        ? buildContextSizeWarning('project_context', projectSize)
        : null;
      if (masterWarning) {
        warnings.push(masterWarning);
      }
      if (projectWarning) {
        warnings.push(projectWarning);
      }

      const contextCount = (masterContext ? 1 : 0) + (projectContext ? 1 : 0);
      const contextSizes = {
        masterContext: masterSize,
        projectContext: projectSize,
        totalSizeKb,
        totalSizeBytes,
      };

      // s93-m11: staleness is computed when read and never written (Q10, decision #1182), so the
      // view counts it the same way under every role. A failed count rides the warnings rather
      // than reading as a clean zero.
      const stalenessRead = readStaleness(client);
      warnings.push(...stalenessRead.warnings);
      const staleness = {
        staleDecisions: stalenessRead.storedStaleDecisions,
        staleLearnings: stalenessRead.storedStaleLearnings,
        threshold: stalenessRead.threshold,
      };
      const stalenessLine = stalenessAdvisory(stalenessRead);
      if (stalenessLine) warnings.push(stalenessLine);

      // Compute health metrics from structured tables
      const healthMetrics = computeHealthMetrics(client, staleness, totalSizeKb);

      // sizeOnly mode: return only size metrics, no content
      if (params.sizeOnly) {
        return createSuccess<RbookContextViewResult>(
          {
            masterContext: null,
            projectContext: null,
            aggregated: {
              activeMission: null,
              sessionCount: null,
              decisions: [],
              constraints: [],
              learnings: [],
              nextSteps: [],
            },
            contextSizes,
            staleness,
            healthMetrics,
            contextCount,
            mode: 'sizeOnly',
          },
          warnings
        );
      }

      // compact mode: return summary digest with limited entries
      if (params.compact) {
        const aggregated = buildAggregatedView(masterContext, projectContext, client);

        // Get active sprint info
        let activeSprint: string | null = null;
        const sprintResult = client.getOne<{ id: string; title: string }>(
          "SELECT id, title FROM sprints WHERE status IN ('Active', 'In Progress') LIMIT 1",
          []
        );
        if (sprintResult.success && sprintResult.data) {
          activeSprint = `${sprintResult.data.id}: ${sprintResult.data.title}`;
        }

        return createSuccess<RbookContextViewResult>(
          {
            masterContext: null,
            projectContext: null,
            aggregated: {
              activeMission: aggregated.activeMission,
              sessionCount: aggregated.sessionCount,
              decisions: aggregated.decisions.slice(0, 5),
              constraints: aggregated.constraints,
              learnings: aggregated.learnings.slice(0, 5),
              nextSteps: aggregated.nextSteps,
            },
            contextSizes,
            staleness,
            healthMetrics,
            contextCount,
            mode: 'compact',
            compact: {
              activeMission: aggregated.activeMission,
              activeSprint,
              recentDecisions: aggregated.decisions.slice(0, 5),
              activeConstraints: aggregated.constraints,
              recentLearnings: aggregated.learnings.slice(0, 5),
              pendingNextSteps: aggregated.nextSteps,
            },
          },
          warnings
        );
      }

      // Full mode (default)
      const aggregated = buildAggregatedView(masterContext, projectContext, client);

      return createSuccess<RbookContextViewResult>(
        {
          masterContext,
          projectContext,
          aggregated,
          contextSizes,
          staleness,
          healthMetrics,
          contextCount,
          mode: 'full',
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Get a context by ID from the database.
 *
 * Applies any pending blob migrations in memory before returning content; the stored blob is
 * migrated at the store's first write (s93-m11). See blob-migrations.ts.
 */
function getContextById(client: RbookDatabaseClient, contextId: string): ParsedContext | null {
  const result = client.getOne<Context>(
    'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
    [contextId]
  );

  if (!result.success || !result.data) {
    return null;
  }

  const ctx = result.data;
  let parsedContent: Record<string, unknown> = {};

  try {
    parsedContent = JSON.parse(ctx.content);
  } catch {
    // Return empty object if parse fails
    parsedContent = {};
  }

  // s93-m11: a pending blob migration is applied in memory only. The view is a read and never
  // writes the record (decision #1182); the stored blob migrates at the store's first write
  // (first-write-maintenance.ts). Every migration is a pure function, so this is the shape that
  // will be stored.
  const migratedContent = migrateBlobForRead(client, contextId, parsedContent);
  const migrated = migratedContent !== parsedContent;
  parsedContent = migratedContent;

  // Use post-migration content for size calculation when blob was pruned
  const contentForSize = migrated ? JSON.stringify(parsedContent) : ctx.content;

  const sizeSettings = resolveContextSizeSettings(parsedContent);
  const size = calculateContextSizeMetrics(contentForSize, sizeSettings);

  return {
    id: ctx.id,
    sourcePath: ctx.source_path,
    content: parsedContent,
    updatedAt: ctx.updated_at,
    size,
  };
}

/**
 * Build aggregated view from structured tables and the context JSON.
 *
 * Source of each field (s95-m09 corrected this list: decisions and learnings have no JSON
 * fallback; their master_context copies stopped being written in Sprint 51):
 * - decisions: strategic_decisions table (active rows)
 * - learnings: learnings table (active rows)
 * - constraints: master_context JSON blob (low-volume, no dedicated table)
 * - activeMission, sessionCount, nextSteps: project_context JSON blob
 */
/** True when `table` has `column` — s83-m06 guard so project_id SELECTs never throw
 *  on ancient stores that predate the s69-m03 genesis columns. */
function tableHasColumn(client: RbookDatabaseClient, table: string, column: string): boolean {
  const res = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
  return res.success && !!res.data?.some((c) => c.name === column);
}

/** Wrap `text` in the untrusted provenance fence when the row is FOREIGN (its
 *  project_id differs from the local project, or the local id is unknown). Mirrors
 *  the ratified LIST predicate; local rows pass through bare. */
function frameIfForeign(
  text: string,
  rowProjectId: string | null,
  localProjectId: string | null
): string {
  const isForeign =
    rowProjectId != null && (localProjectId == null || rowProjectId !== localProjectId);
  // s87-m04: through the SHARED tag constructor. This site built its own `proj:${…}` string, so
  // it would otherwise have kept naming a project that does not exist after the two constructors
  // in provenance-frame.ts stopped. The FENCE is untouched — only what the tag says.
  return isForeign ? frameForeignText(text, provenanceTag(rowProjectId)) : text;
}

function buildAggregatedView(
  masterContext: ParsedContext | null,
  projectContext: ParsedContext | null,
  client?: RbookDatabaseClient
): RbookContextViewResult['aggregated'] {
  const masterContent = masterContext?.content ?? {};
  const projectContent = projectContext?.content ?? {};

  // Extract from project_context
  const activeMission = extractString(projectContent, 'active_mission');
  const sessionCount = extractNumber(projectContent, 'session_count');

  // Extract working memory next steps
  const workingMemory = extractObject(projectContent, 'working_memory');
  const nextSteps = extractStringArray(workingMemory, 'next_steps');

  // s83-m06 (review): after a rbook_db pull the active decisions/learnings can include
  // pull-merged FOREIGN rows (project_id != local). Frame those inside the untrusted
  // fence at build time so BOTH the full and compact renders (compact slices this same
  // array) treat them as data, not instructions. Local rows pass through bare.
  const localProjectId = client ? getProjectId(client) : null;

  // Pull decisions from structured table (decisions_made no longer stored in blob — Sprint 51)
  let decisions: string[] = [];
  if (client) {
    const decProjExpr = tableHasColumn(client, 'strategic_decisions', 'project_id')
      ? 'project_id'
      : 'NULL';
    const structuredDecisions = client.getMany<{
      decision_text: string;
      project_id: string | null;
    }>(
      `SELECT decision_text, ${decProjExpr} AS project_id FROM strategic_decisions WHERE status = 'active' ORDER BY julianday(created_at) DESC`,
      []
    );
    if (structuredDecisions.success && structuredDecisions.data) {
      decisions = structuredDecisions.data.map((row) =>
        frameIfForeign(row.decision_text, row.project_id, localProjectId)
      );
    }
  }

  // Constraints remain in context JSON (low-volume, no dedicated table)
  const constraints =
    extractStringArray(masterContent, 'constraints') ||
    extractStringArray(masterContent, 'quality_standards') ||
    [];

  // Pull learnings from structured table (learnings no longer stored in blob — Sprint 51)
  let learnings: string[] = [];
  if (client) {
    const learnProjExpr = tableHasColumn(client, 'learnings', 'project_id') ? 'project_id' : 'NULL';
    const structuredLearnings = client.getMany<{ content: string; project_id: string | null }>(
      `SELECT content, ${learnProjExpr} AS project_id FROM learnings WHERE status = 'active' ORDER BY julianday(created_at) DESC`,
      []
    );
    if (structuredLearnings.success && structuredLearnings.data) {
      learnings = structuredLearnings.data.map((row) =>
        frameIfForeign(row.content, row.project_id, localProjectId)
      );
    }
  }

  return {
    activeMission,
    sessionCount,
    decisions,
    constraints,
    learnings,
    nextSteps,
  };
}

/**
 * Compute health metrics from structured tables.
 */
function computeHealthMetrics(
  client: RbookDatabaseClient,
  staleness: { staleDecisions: number; staleLearnings: number },
  totalSizeKb: number
): RbookContextViewResult['healthMetrics'] {
  // Active counts
  const activeDecisions = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'active'",
    []
  );
  const activeLearnings = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM learnings WHERE status = 'active'",
    []
  );

  // Last snapshot age
  const lastSnapshot = client.getOne<{ created_at: string }>(
    'SELECT created_at FROM context_snapshots ORDER BY julianday(created_at) DESC LIMIT 1',
    []
  );
  let lastSnapshotAge: string | null = null;
  if (lastSnapshot.success && lastSnapshot.data?.created_at) {
    const snapshotDate = new Date(storedTimeMs(lastSnapshot.data.created_at));
    const now = new Date();
    const hoursAgo = Math.round((now.getTime() - snapshotDate.getTime()) / (1000 * 60 * 60));
    if (hoursAgo < 24) {
      lastSnapshotAge = `${hoursAgo}h ago`;
    } else {
      const daysAgo = Math.round(hoursAgo / 24);
      lastSnapshotAge = `${daysAgo}d ago`;
    }
  }

  // Recent sprint count. s93-m11: the sprints that have happened (Completed and the open one,
  // case-insensitively); a Planned sprint has not happened yet.
  const recentSprints = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sprints WHERE ${sprintCountsOnClockSql('status')}`,
    []
  );

  return {
    activeDecisionCount: activeDecisions.success ? (activeDecisions.data?.count ?? 0) : 0,
    activeLearningCount: activeLearnings.success ? (activeLearnings.data?.count ?? 0) : 0,
    staleDecisionCount: staleness.staleDecisions,
    staleLearningCount: staleness.staleLearnings,
    totalContextSizeKb: totalSizeKb,
    lastSnapshotAge,
    recentSprintCount: recentSprints.success ? (recentSprints.data?.count ?? 0) : 0,
  };
}

/**
 * Safely extract a string from an object.
 */
function extractString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

/**
 * Safely extract a number from an object.
 */
function extractNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (typeof value === 'number') {
    return value;
  }
  return null;
}

/**
 * Safely extract an object from an object.
 */
function extractObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Safely extract a string array from an object.
 */
function extractStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/**
 * Format context view result for LLM readability.
 *
 * @param result - Context view result
 * @returns Human-readable summary
 */
export function formatContextViewForLLM(result: RbookToolResult<RbookContextViewResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to retrieve context',
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

  // sizeOnly mode - minimal output
  if (data.mode === 'sizeOnly') {
    lines.push('📏 **Reasonbook Context Size Report**');
    lines.push('');
    if (data.contextSizes) {
      if (data.contextSizes.masterContext) {
        const mc = data.contextSizes.masterContext;
        lines.push(
          `Master Context: ${mc.sizeKb.toFixed(2)}KB (${mc.usagePercent.toFixed(1)}% of ${mc.limitKb}KB limit)`
        );
      }
      if (data.contextSizes.projectContext) {
        const pc = data.contextSizes.projectContext;
        lines.push(
          `Project Context: ${pc.sizeKb.toFixed(2)}KB (${pc.usagePercent.toFixed(1)}% of ${pc.limitKb}KB limit)`
        );
      }
      lines.push('');
      lines.push(
        `Combined: ${data.contextSizes.totalSizeKb.toFixed(2)}KB (${data.contextSizes.totalSizeBytes} bytes)`
      );
    }
    lines.push(`Contexts found: ${data.contextCount}`);

    // s86-m02b: this formatter has THREE terminal returns (sizeOnly / compact / full) and the
    // s86-m02 sweep — which asserts PRESENCE, not reachability — landed appendWarnings only in
    // this one, so compact and full rendered nothing. Each branch now renders the channel, and
    // because every branch returns, exactly one call runs per invocation.
    appendWarnings(lines, result);

    return lines.join('\n');
  }

  // compact mode - summary digest
  if (data.mode === 'compact' && data.compact) {
    lines.push('📋 **Reasonbook Context Digest** (compact)');
    lines.push('');

    if (data.compact.activeMission) {
      lines.push(`**Active Mission**: ${data.compact.activeMission}`);
    }
    if (data.compact.activeSprint) {
      lines.push(`**Active Sprint**: ${data.compact.activeSprint}`);
    }

    if (data.compact.recentDecisions.length > 0) {
      lines.push('');
      lines.push('**Recent Decisions**:');
      data.compact.recentDecisions.forEach((d) => lines.push(`  • ${d}`));
    }

    if (data.compact.activeConstraints.length > 0) {
      lines.push('');
      lines.push('**Constraints**:');
      data.compact.activeConstraints.forEach((c) => lines.push(`  • ${c}`));
    }

    if (data.compact.recentLearnings.length > 0) {
      lines.push('');
      lines.push('**Recent Learnings**:');
      data.compact.recentLearnings.forEach((l) => lines.push(`  • ${l}`));
    }

    if (data.compact.pendingNextSteps.length > 0) {
      lines.push('');
      lines.push('**Next Steps**:');
      data.compact.pendingNextSteps.forEach((s) => lines.push(`  • ${s}`));
    }

    if (data.contextSizes) {
      lines.push('');
      lines.push(
        `Context size: ${data.contextSizes.totalSizeKb.toFixed(2)}KB (${data.contextSizes.totalSizeBytes} bytes)`
      );
    }

    appendWarnings(lines, result);

    return lines.join('\n');
  }

  // Full mode (default)
  lines.push('📋 **Reasonbook Context View**');
  lines.push('');

  // Aggregated quick view
  const agg = data.aggregated;

  if (agg.activeMission) {
    lines.push(`**Active Mission**: ${agg.activeMission}`);
  }

  if (agg.sessionCount !== null) {
    lines.push(`**Session Count**: ${agg.sessionCount}`);
  }

  // Decisions
  if (agg.decisions.length > 0) {
    lines.push('');
    lines.push('**Decisions Made**:');
    agg.decisions.slice(0, 5).forEach((d) => {
      lines.push(`  • ${d}`);
    });
    if (agg.decisions.length > 5) {
      lines.push(`  ... and ${agg.decisions.length - 5} more`);
    }
  }

  // Constraints
  if (agg.constraints.length > 0) {
    lines.push('');
    lines.push('**Constraints**:');
    agg.constraints.slice(0, 5).forEach((c) => {
      lines.push(`  • ${c}`);
    });
    if (agg.constraints.length > 5) {
      lines.push(`  ... and ${agg.constraints.length - 5} more`);
    }
  }

  // Next steps
  if (agg.nextSteps.length > 0) {
    lines.push('');
    lines.push('**Next Steps**:');
    agg.nextSteps.forEach((s) => {
      lines.push(`  • ${s}`);
    });
  }

  // Context details
  lines.push('');
  lines.push('---');
  lines.push('');

  if (data.masterContext) {
    lines.push('**Master Context** (the strategic record)');
    lines.push(`  Source: ${data.masterContext.sourcePath}`);
    lines.push(`  Updated: ${data.masterContext.updatedAt ?? 'Never'}`);
    if (data.masterContext.size) {
      lines.push(
        `  Size: ${data.masterContext.size.sizeKb.toFixed(2)}KB (${data.masterContext.size.usagePercent.toFixed(1)}% of limit)`
      );
    }
    lines.push('');
  }

  if (data.projectContext) {
    lines.push('**Project Context** (session state)');
    lines.push(`  Source: ${data.projectContext.sourcePath}`);
    lines.push(`  Updated: ${data.projectContext.updatedAt ?? 'Never'}`);
    if (data.projectContext.size) {
      lines.push(
        `  Size: ${data.projectContext.size.sizeKb.toFixed(2)}KB (${data.projectContext.size.usagePercent.toFixed(1)}% of limit)`
      );
    }
    lines.push('');
  }

  if (data.contextSizes) {
    lines.push(
      `Combined context size: ${data.contextSizes.totalSizeKb.toFixed(2)}KB (${data.contextSizes.totalSizeBytes} bytes)`
    );
    lines.push('');
  }
  lines.push(`Total contexts: ${data.contextCount}`);

  appendWarnings(lines, result);

  return lines.join('\n');
}

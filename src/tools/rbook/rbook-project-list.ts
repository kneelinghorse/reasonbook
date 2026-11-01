// ABOUTME: Lists active registered projects with their stored identity and address.
// ABOUTME: Raw readonly reads disclose unavailable identities without seeding or repairing stores.
/**
 * rbook_project_list Tool
 *
 * MCP tool for listing registered Reasonbook projects.
 * Returns project summaries with status indicators.
 *
 * @module tools/rbook/rbook-project-list
 */

import { recordPathsUnlessMoving } from '../../intelligence/legacy-compat';
import * as fs from 'fs';
import { z } from 'zod';
import { readStoredProjectAddress } from '../../intelligence/project-address';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Project summary for list output.
 */
export interface ProjectListItem {
  /** Stored identity; null when the store could not be read. */
  id: string | null;
  address: string | null;
  identityError?: string;
  /** Project path */
  projectRoot: string;

  /** Display name */
  name: string;

  /** Whether this is the default project */
  isDefault: boolean;

  /** s92-m01 — whether resolution may use this default (false for an unconfirmed pre-3.2.0 one) */
  defaultApplied: boolean;

  /** Whether the Reasonbook database exists on disk */
  dbExists: boolean;

  /** Registration timestamp */
  registeredAt: string;

  /** Last access timestamp */
  lastAccessedAt: string;
}

/**
 * Summary statistics for projects.
 */
export interface ProjectListSummary {
  /** Total number of projects */
  total: number;
}

/**
 * Result type for rbook_project_list.
 */
export interface ProjectListResult {
  /** List of registered projects */
  projects: ProjectListItem[];

  /** Number of projects with missing databases */
  missingCount: number;

  /** Summary statistics */
  summary: ProjectListSummary;

  /** Path to the registry file */
  registryPath: string;
}

/**
 * Input parameters schema for rbook_project_list tool.
 */
export const rbookProjectListSchema = z.object({});

export type RbookProjectListParams = z.infer<typeof rbookProjectListSchema>;

/**
 * MCP Tool Definition for rbook_project_list.
 */
export const rbookProjectListToolDefinition = {
  name: 'rbook_project_list',
  description:
    'List all registered Reasonbook projects. ' +
    'Returns project paths, names, and default status. ' +
    'Use rbook_project(action="validate") to check project health.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_project_list tool.
 *
 * @param _params - Tool parameters (unused)
 * @returns RbookToolResult with project list or error
 */
export async function rbookProjectList(
  _params: RbookProjectListParams
): Promise<RbookToolResult<ProjectListResult>> {
  try {
    // s79-m03 — the project-graph registry is the sole discovery read source.
    const graph = await ProjectGraphRegistry.create();
    const rows = graph.list();
    const defaultStatus = graph.getDefaultStatus();
    const defaultId = defaultStatus.entry?.project_id;

    const warnings: string[] = [];
    const items: ProjectListItem[] = rows.map((row) => {
      const stored = readStoredProjectAddress(row.store_path);
      if (!stored.identity)
        warnings.push(`Identity unavailable for '${row.store_path}': ${stored.error}`);
      return {
        id: stored.identity?.id ?? null,
        address: stored.identity?.address ?? null,
        ...(!stored.identity ? { identityError: stored.error } : {}),
        projectRoot: row.store_path,
        name: row.name ?? row.store_path,
        isDefault: row.project_id === defaultId,
        defaultApplied: row.project_id === defaultId && defaultStatus.applied,
        // s108-m05: a record mid-move still exists; it is being renamed.
        dbExists: ((paths) => !paths || fs.existsSync(paths.dbPath))(
          recordPathsUnlessMoving(row.store_path)
        ),
        registeredAt: new Date(row.registered_at).toISOString(),
        lastAccessedAt: new Date(row.last_seen_at).toISOString(),
      };
    });

    const missingCount = items.filter((p) => !p.dbExists).length;

    return createSuccess(
      {
        projects: items,
        missingCount,
        summary: {
          total: items.length,
        },
        registryPath: graph.path,
      },
      warnings.length ? warnings : undefined
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to list projects: ${message}`,
      suggestion: 'Check registry file permissions',
    });
  }
}

/**
 * Format project list result for LLM readability.
 *
 * @param result - Project list result
 * @returns Human-readable summary
 */
export function formatProjectListForLLM(result: RbookToolResult<ProjectListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list projects', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  if (data.projects.length === 0) {
    lines.push('📋 No projects registered');
    lines.push('');
    lines.push('Use rbook_project(action="register") to add a project.');
  } else {
    const header =
      data.missingCount > 0
        ? `📋 Registered Projects (${data.summary.total}, ${data.missingCount} missing)`
        : `📋 Registered Projects (${data.summary.total})`;
    lines.push(header);
    lines.push('');

    for (const project of data.projects) {
      const defaultMarker = project.isDefault
        ? project.defaultApplied
          ? ' (default)'
          : ' (default, not applied — re-register with setAsDefault=true)'
        : '';
      const missingMarker = project.dbExists ? '' : ' [MISSING]';
      lines.push(`   ${project.name}${defaultMarker}${missingMarker}`);
      lines.push(
        `   ${project.identityError ? 'identity unavailable' : `${project.id}: ${project.address ?? 'local-only'}`}`
      );
      lines.push(`   └─ ${project.projectRoot}`);
      lines.push('');
    }

    if (data.missingCount > 0) {
      lines.push('Tip: Run rbook_project(action="prune") to remove missing entries.');
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

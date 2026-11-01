/**
 * rbook_project_validate Tool
 *
 * MCP tool for validating all registered Reasonbook projects.
 * Checks that project directories and Reasonbook databases still exist.
 *
 * @module tools/rbook/rbook-project-validate
 */

import { recordPathsUnlessMoving } from '../../intelligence/legacy-compat';
import * as fs from 'fs';
import { z } from 'zod';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Validation result for a single project.
 */
export interface ProjectValidationItem {
  /** Project path */
  projectRoot: string;

  /** Project display name */
  name: string;

  /**
   * Validation status. s92-m01: `ephemeral` = the store exists but lies under an ephemeral
   * location (OS temp dir, /tmp, /private/tmp, RBOOK_EPHEMERAL_PATHS); prune archives it.
   */
  status: 'active' | 'stale' | 'missing' | 'ephemeral';

  /** Human-readable status message */
  message: string;
}

/**
 * Summary statistics for validation.
 */
export interface ValidationSummary {
  /** Total projects validated */
  total: number;

  /** Number of active (healthy) projects */
  active: number;

  /** Number of stale projects (DB missing/invalid) */
  stale: number;

  /** Number of missing projects (directory gone) */
  missing: number;

  /** s92-m01 — number of projects whose store lies under an ephemeral location */
  ephemeral: number;
}

/**
 * Result type for rbook_project_validate.
 */
export interface ProjectValidateResult {
  /** Validation results for each project */
  validations: ProjectValidationItem[];

  /** Summary statistics */
  summary: ValidationSummary;
}

/**
 * Input parameters schema for rbook_project_validate tool.
 */
export const rbookProjectValidateSchema = z.object({
  /** Whether to automatically prune stale/missing entries */
  prune: z
    .boolean()
    .optional()
    .describe('Automatically remove stale and missing projects from registry'),
});

export type RbookProjectValidateParams = z.infer<typeof rbookProjectValidateSchema>;

/**
 * MCP Tool Definition for rbook_project_validate.
 */
export const rbookProjectValidateToolDefinition = {
  name: 'rbook_project_validate',
  description:
    'Validate all registered Reasonbook projects. ' +
    'Checks that project directories exist and contain Reasonbook databases. ' +
    'Reports active, stale, and missing projects. ' +
    'Optionally prune invalid entries with prune=true.',
  inputSchema: {
    type: 'object',
    properties: {
      prune: {
        type: 'boolean',
        description: 'Automatically remove stale and missing projects from registry',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_project_validate tool.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with validation results or error
 */
export async function rbookProjectValidate(
  params: RbookProjectValidateParams
): Promise<RbookToolResult<ProjectValidateResult>> {
  const { prune = false } = params;

  try {
    // s79-m03 — validate the project-graph registry's active projects (the sole
    // discovery source): missing = project dir gone, stale = dir present but the
    // Reasonbook db is gone, else active.
    const graph = await ProjectGraphRegistry.create();
    const items: ProjectValidationItem[] = graph.list().map((row) => {
      const dirExists = fs.existsSync(row.store_path);
      // s108-m05: a record mid-move still exists; it is being renamed.
      const paths = recordPathsUnlessMoving(row.store_path);
      const dbExists = !paths || fs.existsSync(paths.dbPath);
      const status: ProjectValidationItem['status'] = !dirExists
        ? 'missing'
        : !dbExists
          ? 'stale'
          : graph.isEphemeral(row.store_path)
            ? 'ephemeral'
            : 'active';
      const message = !paths
        ? `Project's record is moving, or its move needs recovery: ${row.store_path}`
        : status === 'missing'
          ? `Project directory does not exist: ${row.store_path}`
          : status === 'stale'
            ? `Reasonbook database no longer exists at: ${row.store_path}`
            : status === 'ephemeral'
              ? `Store is in an ephemeral location: ${row.store_path}`
              : `Project is active: ${row.name ?? row.store_path}`;
      return { projectRoot: row.store_path, name: row.name ?? row.store_path, status, message };
    });

    const summary: ValidationSummary = {
      total: items.length,
      active: items.filter((v) => v.status === 'active').length,
      stale: items.filter((v) => v.status === 'stale').length,
      missing: items.filter((v) => v.status === 'missing').length,
      ephemeral: items.filter((v) => v.status === 'ephemeral').length,
    };

    // Optionally prune invalid entries — archive stale/missing rows in the graph.
    // s80-m02: the graph is the single source — no JSON mirror to re-derive.
    if (prune && (summary.stale > 0 || summary.missing > 0)) {
      graph.pruneMissingStores();
    }
    // s92-m01: ephemeral rows are archived even though their store still exists (feedback #41).
    if (prune && summary.ephemeral > 0) {
      graph.pruneEphemeralStores();
    }

    return createSuccess({
      validations: items,
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to validate projects: ${message}`,
      suggestion: 'Check registry file permissions',
    });
  }
}

/**
 * Format project validate result for LLM readability.
 *
 * @param result - Project validate result
 * @returns Human-readable summary
 */
export function formatProjectValidateForLLM(
  result: RbookToolResult<ProjectValidateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to validate projects',
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
  const { summary } = data;
  const lines: string[] = [];

  if (summary.total === 0) {
    lines.push('📋 No projects to validate');
    lines.push('');
    lines.push('Use rbook_project(action="register") to add a project.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  // Summary header
  const statusIcon =
    summary.stale === 0 && summary.missing === 0 && summary.ephemeral === 0
      ? '✓'
      : summary.active === 0
        ? '❌'
        : '⚠️';
  lines.push(`${statusIcon} Validation Complete`);
  lines.push('');
  lines.push(
    `   Active: ${summary.active}  |  Stale: ${summary.stale}  |  Missing: ${summary.missing}  |  Ephemeral: ${summary.ephemeral}`
  );
  lines.push('');

  // Group by status
  const active = data.validations.filter((v) => v.status === 'active');
  const stale = data.validations.filter((v) => v.status === 'stale');
  const missing = data.validations.filter((v) => v.status === 'missing');
  const ephemeral = data.validations.filter((v) => v.status === 'ephemeral');

  if (active.length > 0) {
    lines.push('Active Projects:');
    for (const v of active) {
      lines.push(`   ✓ ${v.name}`);
    }
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push('Stale Projects (Reasonbook database missing):');
    for (const v of stale) {
      lines.push(`   ⚠️ ${v.name}`);
      lines.push(`      ${v.projectRoot}`);
    }
    lines.push('');
  }

  if (missing.length > 0) {
    lines.push('Missing Projects (directory not found):');
    for (const v of missing) {
      lines.push(`   ❌ ${v.name}`);
      lines.push(`      ${v.projectRoot}`);
    }
    lines.push('');
  }

  if (ephemeral.length > 0) {
    lines.push('Ephemeral Projects (scratch locations; prune archives them):');
    for (const v of ephemeral) {
      lines.push(`   ⏳ ${v.name}`);
      lines.push(`      ${v.projectRoot}`);
    }
    lines.push('');
  }

  if (stale.length > 0 || missing.length > 0 || ephemeral.length > 0) {
    lines.push('Tip: Use rbook_project(action="validate", prune=true) to remove invalid entries.');
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

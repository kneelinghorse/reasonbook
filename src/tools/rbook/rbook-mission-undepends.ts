/**
 * rbook_mission_undepends Tool
 *
 * MCP tool for removing mission dependencies from the Reasonbook database.
 * Validates that the dependency exists before deletion.
 *
 * @module tools/rbook/rbook-mission-undepends
 */

import { withClientValidated } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import { appendWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { MISSION_DEPENDENCY_DISCLOSURE } from './rbook-mission-depends';
import { recordedExecute } from './record-changes';

/**
 * Result type for dependency removal.
 */
export interface MissionUndependsResult {
  /** The dependent mission ID */
  fromId: string;

  /** The dependency mission ID */
  toId: string;

  /** When the dependency was removed */
  removedAt: string;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters for dependency removal.
 */
export interface RbookMissionUndependsParams {
  fromId: string;
  toId: string;
  projectRoot?: string;
}

/**
 * Remove a dependency relationship between two missions.
 */
export async function rbookMissionUndepends(
  params: RbookMissionUndependsParams
): Promise<RbookToolResult<MissionUndependsResult>> {
  const { fromId, toId } = params;

  if (!fromId || fromId.trim() === '') {
    return createError({
      code: RBOOK_ERROR_CODES.MISSING_PARAMETER,
      message: 'fromId is required',
    });
  }

  if (!toId || toId.trim() === '') {
    return createError({ code: RBOOK_ERROR_CODES.MISSING_PARAMETER, message: 'toId is required' });
  }

  return withClientValidated(
    (client) => {
      const warnings: string[] = [];

      // Verify the dependency exists
      const existing = client.getOne<{ from_id: string; to_id: string; type: string }>(
        'SELECT from_id, to_id, type FROM mission_dependencies WHERE from_id = ? AND to_id = ?',
        [fromId.trim(), toId.trim()]
      );

      if (!existing.success) {
        return createError<MissionUndependsResult>(
          existing.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check dependency' }
        );
      }

      if (!existing.data) {
        return createError<MissionUndependsResult>({
          code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
          message: `No dependency found from '${fromId}' to '${toId}'`,
          suggestion:
            'Check the fromId and toId values. Use rbook_mission(action="show") to see existing dependencies.',
        });
      }

      // Delete the dependency
      const deleteResult = recordedExecute(
        client,
        'DELETE FROM mission_dependencies WHERE from_id = ? AND to_id = ?',
        [fromId.trim(), toId.trim()]
      );

      if (!deleteResult.success) {
        return createError<MissionUndependsResult>(
          deleteResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to remove dependency' }
        );
      }

      const now = new Date().toISOString();

      // Log removal event
      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'dependency', ?, ?, ?)`,
        [
          now,
          fromId.trim(),
          'dependency_removed',
          `Removed ${existing.data.type} dependency: ${fromId} -> ${toId}`,
          JSON.stringify({
            tool: 'rbook_mission_undepends',
            fromId: fromId.trim(),
            toId: toId.trim(),
            type: existing.data.type,
          }),
        ]
      );

      checkWrite(eventResult, warnings, 'mission dependency remove event logging');

      return createSuccess<MissionUndependsResult>(
        {
          fromId: fromId.trim(),
          toId: toId.trim(),
          removedAt: now,
          message: `Removed ${existing.data.type} dependency: '${fromId.trim()}' -> '${toId.trim()}'. ${MISSION_DEPENDENCY_DISCLOSURE}`,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format dependency removal result for LLM readability.
 */
export function formatMissionUndependsForLLM(
  result: RbookToolResult<MissionUndependsResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Failed to remove mission dependency',
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
  const lines = [
    'Dependency removed',
    '',
    `From: ${data.fromId}`,
    `To: ${data.toId}`,
    '',
    data.message,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}

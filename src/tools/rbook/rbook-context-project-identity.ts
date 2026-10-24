// ABOUTME: Handlers for rbook_context(contextType="project_identity") — view and update actions.
// ABOUTME: Validates protected identity updates before wrapping the core writes in standard results.

import { formatToolFailure } from './format-failure';
import { withClient, withClientValidated } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import {
  getProjectIdentity,
  applyProjectIdentityFieldUpdate,
  ensureProjectIdentityRow,
  type ProjectIdentityData,
} from './project-identity';
import { appendWarnings } from './format-warnings';
import { storedTimeMs } from './stored-time';
import { recordedChange } from './record-changes';
import { isMembersCopy } from './record-membership';
import { COPY_KEYS, readCopyKey } from './replica-copy-keys';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProjectIdentityViewResult {
  projectIdentity: ProjectIdentityData;
  seeded: boolean;
  /**
   * s93-m11 — whether the identity shown is the stored row. False on a read of a project with no
   * row yet: a read never seeds one, so the identity is derived in memory.
   */
  stored: boolean;
  /**
   * s100-m01: on a member's copy, the address it joined through the dashboard by; its identity's
   * own address is never set, so it registers and sends as nothing.
   */
  joinedAddress?: string;
}

export interface ProjectIdentityUpdateResult {
  fieldsUpdated: string[];
  projectIdentity: ProjectIdentityData;
  message: string;
}

// ─── Params ─────────────────────────────────────────────────────────────────

export interface ProjectIdentityViewParams {
  projectRoot?: string;
}

export interface ProjectIdentityUpdateParams {
  fieldUpdates?: Array<{ path: string; value: unknown }>;
  projectRoot?: string;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * View the project_identity context row.
 * Auto-seeds the row if it doesn't exist yet, on a call that may write. A read seeds nothing and
 * shows the identity derived in memory, with `stored: false` (s93-m11, decision #1182).
 */
export async function rbookContextViewProjectIdentity(
  params: ProjectIdentityViewParams
): Promise<RbookToolResult<ProjectIdentityViewResult>> {
  return withClient(
    (client) => {
      const migration = ensureProjectIdentityRow(client);
      const identity = getProjectIdentity(client);

      if (!identity) {
        return createError<ProjectIdentityViewResult>({
          code: RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND,
          message: 'project_identity context row could not be created or read.',
          suggestion: 'Check database connectivity and ensure the contexts table exists.',
        });
      }

      // s86-m02b: a FAILED seed INSERT sets `alreadyCurrent` exactly the way a genuinely-present
      // row does, so `seeded` counts the row this call inserted rather than reading that flag. The
      // migration's warnings channel carries the DB error onto the envelope (rendered by
      // appendWarnings below). s93-m11: a read inserts nothing and reports the seed as deferred.
      const joinedAddress = isMembersCopy(client)
        ? readCopyKey(client, COPY_KEYS.joinedAddress)
        : null;
      return createSuccess<ProjectIdentityViewResult>(
        {
          projectIdentity: identity,
          seeded: migration.rowsUpdated > 0,
          stored: migration.deferred === undefined,
          ...(joinedAddress ? { joinedAddress } : {}),
        },
        migration.warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Update fields in the project_identity context row.
 * Accepts fieldUpdates using dot notation (top-level or type_fields.key).
 */
export async function rbookContextUpdateProjectIdentity(
  params: ProjectIdentityUpdateParams
): Promise<RbookToolResult<ProjectIdentityUpdateResult>> {
  const fieldUpdates = params.fieldUpdates ?? [];
  const invalidIdentity = fieldUpdates.find((update) => {
    const field = typeof update.path === 'string' ? update.path.split('.')[0] : undefined;
    return (
      (field === 'project_name' || field === 'project_id') &&
      (update.path !== field ||
        typeof update.value !== 'string' ||
        update.value.trim().length === 0)
    );
  });
  if (invalidIdentity) {
    const field = invalidIdentity.path.split('.')[0];
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      field: invalidIdentity.path,
      providedValue: invalidIdentity.value,
      message: `The project's ${field} must be updated as a non-empty string.`,
      suggestion: `Provide a non-empty string at path "${field}", or omit that fieldUpdates entry to keep its current value.`,
    });
  }
  return withClientValidated(
    (client) => {
      if (fieldUpdates.length === 0) {
        return createError<ProjectIdentityUpdateResult>({
          code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
          message: 'project_identity update requires fieldUpdates.',
          suggestion:
            'Provide fieldUpdates with dot-notation paths like "description", "domain", "objectives", "type_fields.stack".',
        });
      }

      const updatedPaths: string[] = [];

      for (const update of fieldUpdates) {
        // s96-m03: on a shared record each field update is recorded with its change.
        const written = recordedChange(client, () =>
          applyProjectIdentityFieldUpdate(client, update.path, update.value)
        );
        if (!written.success) return createError<ProjectIdentityUpdateResult>(written.error!);
        const result = written.data!;
        if (!result.success) {
          return createError<ProjectIdentityUpdateResult>({
            code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
            message: result.message ?? `Failed to update field "${update.path}"`,
            suggestion: 'Use top-level field names or "type_fields.fieldName" notation.',
          });
        }
        updatedPaths.push(update.path);
      }

      const identity = getProjectIdentity(client);
      if (!identity) {
        return createError<ProjectIdentityUpdateResult>({
          code: RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND,
          message: 'Could not read project_identity after update.',
          suggestion: 'Check database connectivity.',
        });
      }

      return createSuccess<ProjectIdentityUpdateResult>({
        fieldsUpdated: updatedPaths,
        projectIdentity: identity,
        message: `Updated ${updatedPaths.length} field(s) in project_identity.`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Formatters ─────────────────────────────────────────────────────────────

export function formatProjectIdentityViewForLLM(
  result: RbookToolResult<ProjectIdentityViewResult>
): string {
  if (!result.success || !result.data) {
    return formatToolFailure('❌ Failed to view project_identity', result.error);
  }

  const { projectIdentity, seeded, stored, joinedAddress } = result.data;
  const lines: string[] = [];

  if (seeded) {
    lines.push('ℹ️ project_identity row was created automatically (seeded from existing context).');
    lines.push('');
  } else if (stored === false) {
    lines.push(
      'ℹ️ No project_identity row is stored yet. This is the identity derived from the master ' +
        "context and metadata; the project's next Reasonbook write stores it."
    );
    lines.push('');
  }

  lines.push(`# Project Identity — ${projectIdentity.project_name || '(unnamed)'}`);
  lines.push('');
  lines.push(
    `**Address:** ${projectIdentity.rbook_address || (joinedAddress ? `(not set on this copy, a member's copy joined from ${joinedAddress})` : '(not set)')}`
  );
  lines.push(`**Platform:** ${projectIdentity.platform}`);
  lines.push(`**Domain:** ${projectIdentity.domain || '(not set)'}`);
  lines.push(`**Type:** ${projectIdentity.project_type} | **Tier:** ${projectIdentity.tier}`);
  lines.push(`**Status:** ${projectIdentity.status}`);
  lines.push(`**Version:** ${projectIdentity.identity_contract_version}`);
  lines.push('');

  if (projectIdentity.description) {
    lines.push(`**Description:**`);
    lines.push(projectIdentity.description);
    lines.push('');
  }

  if (projectIdentity.objectives.length > 0) {
    lines.push(`**Objectives (${projectIdentity.objectives.length}):**`);
    projectIdentity.objectives.forEach((o) => lines.push(`  - ${o}`));
    lines.push('');
  }

  if (projectIdentity.related_projects.length > 0) {
    lines.push(`**Related Projects:**`);
    projectIdentity.related_projects.forEach((rp) =>
      lines.push(`  - ${rp.name} (${rp.address}) — ${rp.relationship}`)
    );
    lines.push('');
  }

  if (projectIdentity.foundational_docs.length > 0) {
    lines.push(`**Foundational Docs:**`);
    projectIdentity.foundational_docs.forEach((d) => lines.push(`  - ${d.title}: ${d.path}`));
    lines.push('');
  }

  if (projectIdentity.tracelab_refs.length > 0) {
    lines.push(`**TraceLab Refs:**`);
    projectIdentity.tracelab_refs.forEach((ref) =>
      lines.push(`  - [${ref.type}:${ref.id}] ${ref.label}`)
    );
    lines.push('');
  }

  const typeFieldKeys = Object.keys(projectIdentity.type_fields ?? {});
  if (typeFieldKeys.length > 0) {
    lines.push(`**Type Fields (${projectIdentity.project_type}):**`);
    typeFieldKeys.forEach((k) => {
      const v = projectIdentity.type_fields[k];
      const display = Array.isArray(v) ? v.join(', ') : String(v);
      lines.push(`  - ${k}: ${display}`);
    });
    lines.push('');
  }

  lines.push(
    `*Updated: ${projectIdentity.updated_at ? new Date(storedTimeMs(projectIdentity.updated_at)).toLocaleString() : 'unknown'}*`
  );

  appendWarnings(lines, result);

  return lines.join('\n');
}

export function formatProjectIdentityUpdateForLLM(
  result: RbookToolResult<ProjectIdentityUpdateResult>
): string {
  if (!result.success || !result.data) {
    return formatToolFailure('❌ Failed to update project_identity', result.error);
  }

  const { fieldsUpdated, message } = result.data;
  const lines = [`✓ ${message}`, ''];

  if (fieldsUpdated.length > 0) {
    lines.push('**Fields updated:**');
    fieldsUpdated.forEach((f) => lines.push(`  - ${f}`));
  }

  // Sprint 72 m03 (#790): render folded-in collab-sync warnings so a superseded
  // project_identity push surfaces its restore hint to the operator.
  appendWarnings(lines, result);

  return lines.join('\n');
}

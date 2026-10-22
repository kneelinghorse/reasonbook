/**
 * rbook_project update action handler
 *
 * Updates project metadata fields. Currently supports project_type.
 *
 * @module tools/rbook/rbook-project-update
 */

import { formatToolFailure } from './format-failure';
import * as path from 'path';

import { withClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { appendWarnings, appendWriteFailures } from './format-warnings';
import { patchProjectIdentity } from './project-identity';
import {
  AMBIENT_METADATA_KEY,
  asRulesAmbient,
  describeRbookLineRefresh,
  levelOfTier,
  refreshRbookLine,
} from './rules-files';
import { checkWrite, type WriteFailure } from './write-guard';
import { readmeNote, resolveSeedPath, writeLevelFiles } from './level-files';
import { recordedChange, recordedExecute } from './record-changes';
import { isReplicaRefusal } from './replica-identity';

const VALID_PROJECT_TYPES = ['general', 'managed', 'build'] as const;
export type ProjectType = (typeof VALID_PROJECT_TYPES)[number];

export interface RbookProjectUpdateParams {
  projectRoot?: string;
  projectType?: string;
}

export interface ProjectUpdateResult {
  updated: Record<string, string>;
  /**
   * s95-m06: the files the new level gets that the project did not have (relative to rbook/). Moving
   * up writes them; moving down removes nothing. Absent when none were written. A rbook/README.md
   * Reasonbook wrote for the old level and nobody edited is replaced, and a warning says so.
   */
  filesWritten?: string[];
  /**
   * s86-m02b — DB errors from the metadata write. ABSENT, not empty, on the clean path: a
   * successful update's answer shape is unchanged from 2.5.0, so the field's presence is itself
   * the signal that something was rejected.
   */
  writeFailures?: WriteFailure[];
}

export async function rbookProjectUpdate(
  params: RbookProjectUpdateParams
): Promise<RbookToolResult<ProjectUpdateResult>> {
  if (!params.projectType) {
    return createError<ProjectUpdateResult>(RbookErrors.missingParameter('projectType'));
  }

  if (!(VALID_PROJECT_TYPES as readonly string[]).includes(params.projectType)) {
    return createError<ProjectUpdateResult>(
      RbookErrors.invalidParameter('projectType', params.projectType, [...VALID_PROJECT_TYPES])
    );
  }

  return withClient(
    (client) => {
      const updated: Record<string, string> = {};
      const filesWritten: string[] = [];
      const writeFailures: WriteFailure[] = [];
      // `<root>/rbook/db/rbook.sqlite` → `<root>`.
      const root = path.dirname(path.dirname(path.dirname(client.path)));

      // s96-m03: project_type is a recorded identity key, so a shared record records its change.
      const result = recordedExecute(
        client,
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        ['project_type', params.projectType!]
      );
      // s96-m12: a member's copy refuses it (ADR s96 §7), and the answer is that refusal.
      if (isReplicaRefusal(result.error)) return createError<ProjectUpdateResult>(result.error!);
      // s86-m02b: `updated` is the answer's claim about what the store now holds. It may only
      // name project_type when the statement actually ran.
      const warnings: string[] = [];
      if (checkWrite(result, { failures: writeFailures }, 'metadata.project_type')) {
        updated['project_type'] = params.projectType!;
        // s93-m12: the identity row names the tier too, so its view says what the project is.
        checkWrite(
          recordedChange(client, () =>
            patchProjectIdentity(client, { tier: params.projectType! }, warnings)
          ),
          warnings,
          'project_identity.tier'
        );
        // s93-m12: the agents file's one Reasonbook line names the level, so it follows the change, and
        // the answer says so, or says what it left (a line edited by hand, a read-only file).
        // The hooks' setting comes from the store too, so the line says all of what the project is.
        const ambient = client.getOne<{ value: string }>(
          'SELECT value FROM metadata WHERE key = ?',
          [AMBIENT_METADATA_KEY]
        );
        const note = describeRbookLineRefresh(
          refreshRbookLine(root, {
            level: levelOfTier(params.projectType),
            ambient: asRulesAmbient(ambient.success ? ambient.data?.value : undefined),
          })
        );
        if (note) warnings.push(note);
        // s95-m06: moving up adds the new level's missing files; nothing is removed, and only a
        // README Reasonbook wrote for the old level is replaced. The level has already changed, so a
        // failure here is said, never thrown past the change it follows (the build critic).
        const seedPath = resolveSeedPath();
        if (seedPath) {
          const created = { directories: [] as string[], files: [] as string[] };
          try {
            const readme = readmeNote(
              writeLevelFiles(root, params.projectType!, seedPath, created)
            );
            if (readme) warnings.push(readme);
          } catch (error) {
            warnings.push(
              `The level changed, but its files could not all be written (${error instanceof Error ? error.message : String(error)}). ` +
                (created.files.length > 0
                  ? `The ${created.files.length} written before that are listed with the files the new level adds. `
                  : '') +
                'Once the rbook/ folder is writable, run this update again: it writes only the files still missing.'
            );
          }
          filesWritten.push(...created.files);
        } else {
          warnings.push(
            'The seed folder was not found, so no files for the new level were written. Reinstall the package, then run this update again.'
          );
        }
      }

      return createSuccess<ProjectUpdateResult>(
        {
          updated,
          ...(filesWritten.length > 0 ? { filesWritten } : {}),
          ...(writeFailures.length > 0 ? { writeFailures } : {}),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatProjectUpdateForLLM(result: RbookToolResult<ProjectUpdateResult>): string {
  if (!result.success) {
    return formatToolFailure('Failed to update project', result.error);
  }

  const entries = Object.entries(result.data?.updated ?? {});
  // s86-m02b: the empty case can now mean "the write was rejected", so it must not return early
  // past the write-failure section — that is exactly the answer that would assert nothing happened
  // without saying why.
  const lines =
    entries.length === 0 ? ['No fields were updated.'] : ['Project metadata updated:', ''];
  for (const [key, value] of entries) {
    lines.push(`  ${key}: ${value}`);
  }
  const written = result.data?.filesWritten ?? [];
  if (written.length > 0) {
    lines.push('', `Files the new level adds (${written.length}):`);
    for (const file of written) lines.push(`  rbook/${file}`);
  }
  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

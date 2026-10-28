// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Selects the directory edition before configuration or credentials can be read.
// ABOUTME: Shared refusal policy keeps hidden operations closed for MCP and direct CLI callers.

import type { RbookToolError } from './tools/rbook/types';
import { getSetting } from './intelligence/legacy-compat';

export function isDirectoryEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = getSetting('RBOOK_EDITION', env);
  if (value === undefined || value === 'full') return false;
  if (value === 'directory') return true;
  throw new Error('Unknown RBOOK_EDITION. Use full or directory, or unset it for the full plugin.');
}

export function directoryEditionError(): RbookToolError {
  return {
    code: 'DIRECTORY_EDITION_UNAVAILABLE',
    message: 'This operation is unavailable in the local directory edition.',
    suggestion:
      'Use the full plugin for sharing, dashboard access, messages, drafts and cross-project records.',
  };
}

export const DIRECTORY_HIDDEN_TOOLS = ['rbook_auth', 'rbook_message'] as const;
export const DIRECTORY_REMOVED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  rbook_project: ['share', 'invite', 'join', 'members', 'remove', 'sync', 'move', 'sweep'],
  rbook_db: [
    'backfill',
    'purge',
    'conflicts',
    'settle',
    'pull',
    'clone',
    'reconcile',
    'identify_orphans',
  ],
  rbook_sprint: ['carry_forward'],
};

/** Before project resolution: even a refused call must not inspect a draft or another record. */
export function directoryCallError(name: string, args: unknown): RbookToolError | null {
  if (!isDirectoryEdition()) return null;
  const fields = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (
    (DIRECTORY_HIDDEN_TOOLS as readonly string[]).includes(name) ||
    DIRECTORY_REMOVED_ACTIONS[name]?.includes(String(fields.action)) ||
    fields.acrossProjects !== undefined ||
    fields.fromDraft !== undefined
  )
    return directoryEditionError();
  return null;
}

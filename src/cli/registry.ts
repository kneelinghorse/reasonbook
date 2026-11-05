// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preview or change one registered folder's archive state without opening its project record.
// ABOUTME: Existing registry methods preserve rows; ordinary project write-opens can restore them later.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { oneLine, parseArgs, type CliIo } from './core';
import { resolveConfigDirectory } from '../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import type { RbookToolResult } from '../tools/rbook/types';

interface RegistryResult {
  readonly action: 'archive' | 'restore';
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly message: string;
}

export async function runRegistry(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  let result: RbookToolResult<RegistryResult>;
  try {
    const seen = new Set<string>();
    for (const arg of argv.filter((value) => value.startsWith('--'))) {
      const flag = arg.slice(2).split('=')[0];
      if (!['project-root', 'apply', 'format'].includes(flag))
        throw new Error(`Unknown option --${oneLine(flag, 80)}.`);
      if (seen.has(flag)) throw new Error(`Repeated --${flag}; supply it once.`);
      seen.add(flag);
    }
    const action = positional[0];
    if (positional.length !== 1 || (action !== 'archive' && action !== 'restore'))
      throw new Error('Choose registry archive or registry restore.');
    const root = flags['project-root'];
    if (!root?.trim() || root === 'true')
      throw new Error('--project-root requires a registered project folder.');
    if (flags.format !== undefined && !['text', 'json'].includes(flags.format))
      throw new Error('--format must be text or json.');
    if (flags.apply !== undefined && flags.apply !== 'true')
      throw new Error('--apply is a boolean flag.');
    const apply = flags.apply === 'true';
    if (apply && isReadOnlyAgentSession(io.env))
      throw new Error('The review agent role is read-only; omit --apply to preview.');

    const configDir = resolveConfigDirectory(io.env, io.env.HOME ?? os.homedir());
    if (!fs.existsSync(path.join(configDir, 'project-graph.sqlite')))
      throw new Error('No project registry exists in the selected configuration folder.');
    // create() also initializes schema and imports legacy rows. This command uses an existing
    // registry only; preview changes no rows, schema or backfill markers.
    const registry = ProjectGraphRegistry.getInstance({ configDir });
    const projectId = registry.getByStorePath(path.resolve(io.cwd, root));
    const row = projectId ? registry.get(projectId) : undefined;
    if (!row)
      throw new Error('That folder has no registered project; use its registered --project-root.');
    const changed = apply
      ? action === 'archive'
        ? registry.archive(row.project_id)
        : registry.unarchive(row.project_id)
      : false;
    const label = oneLine(row.name, 80);
    const state = action === 'archive' ? 'archived' : 'active';
    const message = apply
      ? changed
        ? `${action === 'archive' ? 'Archived' : 'Restored'} ${label} in the registry.`
        : `No registry rows changed; ${label} is already ${state}.`
      : `Preview: ${action} ${label} in the registry. No registry rows changed; run with --apply to write.`;
    result = {
      success: true,
      data: {
        action,
        dryRun: !apply,
        changed,
        projectId: row.project_id,
        projectRoot: row.store_path,
        message: `${message} The project's next write-open restores it.`,
      },
    };
  } catch (error) {
    result = {
      success: false,
      error: {
        code: 'REGISTRY_REFUSED',
        message: oneLine(error instanceof Error ? error.message : String(error)),
        suggestion:
          'Check the registered folder and configuration, then use reasonbook registry archive|restore --project-root <root>; omit --apply to preview.',
      },
    };
  }
  if (flags.format === 'json') io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.success) io.stdout(`${result.data!.message}\n`);
  else io.stderr(`reasonbook registry: ${result.error!.message} ${result.error!.suggestion}`);
  return result.success ? 0 : 1;
}

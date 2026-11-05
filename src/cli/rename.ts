// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rename an owned project's dashboard and local identity, with a read-only preview by default.
// ABOUTME: A remote-first write converges on retry; every claimed lease ends with a real upload outcome.

import path from 'path';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import { renamePreflight } from './rename-preflight';
import { localRenamed, writeRenameLocal } from './rename-local';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { withUploadLease } from '../tools/rbook/dashboard-upload';
import { attemptDashboardUpload } from '../tools/rbook/dashboard-upload-attempt';
import type { RbookToolResult } from '../tools/rbook/types';

interface RenameResult {
  readonly dryRun: boolean;
  readonly message: string;
  readonly name: string;
  readonly slug: string;
  readonly address: string;
}

export async function runRename(argv: readonly string[], io: CliIo): Promise<number> {
  let remoteChanged = false;
  let localChanged = false;
  let retry = 'reasonbook rename --name <name> --slug <slug> --apply';
  let result: RbookToolResult<RenameResult>;
  try {
    const { flags } = parseArgs(argv);
    const seen = new Set<string>();
    for (const arg of argv.filter((value) => value.startsWith('--'))) {
      const flag = arg.slice(2).split('=')[0];
      if (seen.has(flag)) throw new Error(`Repeated --${flag}; supply it once.`);
      seen.add(flag);
    }
    for (const key of ['name', 'slug'])
      if (!flags[key] || flags[key] === 'true') throw new Error(`--${key} requires a value.`);
    if (flags['project-root'] === 'true') throw new Error('--project-root requires a directory.');
    if (flags.apply !== undefined && flags.apply !== 'true')
      throw new Error('--apply is a boolean flag.');
    const name = flags.name,
      slug = flags.slug;
    const resolution = resolveCliProject({
      env: io.env,
      cwd: io.cwd,
      projectRootArg: flags['project-root']
        ? path.resolve(io.cwd, flags['project-root'])
        : undefined,
    });
    if (resolution.kind !== 'store')
      throw new Error('No Reasonbook store was found; select its folder with --project-root.');
    const { projectRoot: root, dbPath } = resolution;
    retry = `reasonbook rename --name ${JSON.stringify(name)} --slug ${JSON.stringify(slug)} --project-root ${JSON.stringify(root)} --apply`;
    const plan = await renamePreflight(root, dbPath, name, slug, io.env);
    const already =
      plan.remote.name === name &&
      plan.remote.slug === slug &&
      plan.registryName === name &&
      !plan.uploadPending &&
      localRenamed(plan.local, name, slug, plan.address);
    let message = already
      ? 'Already renamed; nothing changed.'
      : 'Preview: rename the dashboard name and slug, local identity and registry, then upload. Run with --apply while no other session is working in this project.';
    if (flags.apply === 'true' && !already) {
      const patched = await plan.client.renameProject(plan.remote.id, name, slug);
      if (!patched.success) {
        const state = patched.error?.currentState;
        const status = state && typeof state === 'object' ? state.httpStatus : undefined;
        if ([400, 401, 403, 404, 409].includes(status as number))
          throw new Error(patched.error?.message ?? 'The dashboard refused the rename.');
        const reread = await plan.client.listOwnedProjects();
        const found = reread.data?.projects.find((project) => project.id === plan.remote.id);
        if (!reread.success || found?.slug !== slug || found.name !== name)
          throw new Error(
            'The dashboard rename outcome is unknown; no local identity or upload state changed. Re-run the same command to converge.'
          );
      }
      remoteChanged = true;
      let localError: unknown;
      const upload = await withUploadLease(root, true, async () => {
        try {
          await writeRenameLocal(dbPath, plan.local, name, slug, plan.address);
          const registry = await ProjectGraphRegistry.create();
          registry.register({ project_id: plan.local.metadata.project_id, store_path: root, name });
          localChanged = true;
        } catch (error) {
          localError = error;
        }
        // A local failure still reports the real send's result to the lease, never fabricated success.
        return (await attemptDashboardUpload(root, true)).outcome;
      });
      if (localError) throw localError;
      if (!upload?.success)
        throw new Error(
          `The confirming upload did not finish successfully: ${upload?.error ?? 'the upload lease could not be claimed'}.`
        );
      message = 'Renamed the dashboard, local identity and registry; the upload succeeded.';
    }
    result = {
      success: true,
      data: { dryRun: flags.apply !== 'true', message, name, slug, address: plan.address },
      warnings: plan.warnings,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = {
      success: false,
      error: {
        code: 'RENAME_REFUSED',
        message: `${remoteChanged ? (localChanged ? 'The dashboard and local store are renamed. ' : 'The dashboard is renamed, but the local rename did not finish. ') : ''}${detail}`,
        suggestion: `Resolve the reported cause, then re-run ${retry}.`,
      },
    };
  }
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.success ? 0 : 1;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Explicit migration previews the rename and applies only the requested local changes.
// ABOUTME: The CLI skips telemetry; a dry run changes no record or config (SQLite may add -wal/-shm).
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { RbookToolResult } from '../tools/rbook/types';
import { LEGACY, resolveRecordPaths, resolveConfigDirectory } from '../intelligence/legacy-compat';
import { parseArgs, type CliIo } from './core';
import { applyDocumentEdits, planDocumentEdits } from './migrate-docs';
import {
  assertModernClients,
  assertNoOpenFiles,
  assertNoRecordProcesses,
  assertProjectServerVersion,
  modernClientProblems,
  recordProcessProblems,
} from './migrate-guard';
import {
  mayHaveSynced,
  moveRecord,
  recoverMigration,
  PENDING,
  writeMigrationState,
} from './migrate-store';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { migrateConfig } from './migrate-config';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';

export interface MigrationOptions {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly apply?: boolean;
  readonly docsOnly?: boolean;
  /** Process-list seam for isolated tests; the CLI never disables this check. */
  readonly checkProcesses?: boolean;
}
export interface MigrationResult {
  readonly dryRun: boolean;
  readonly moved: boolean;
  readonly changed: string[];
  readonly left: string[];
  readonly backup?: string;
  /**
   * s108-m05, a dry run only: what the apply's checks would refuse now, from the project's server
   * entries, the clients' configuration, runtimes from before 4.0 and the record's open files.
   */
  readonly blocked?: string[];
}

/** A check's refusal as a line of the dry run's list, or none. */
function wouldRefuse(check: () => void): string[] {
  try {
    check();
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Only a pre-existing registration is touched; migration never adds another project. */
async function finishRegistration(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const config = resolveConfigDirectory(env, env.HOME ?? os.homedir());
  const registryPath = path.join(config, 'project-graph.sqlite');
  if (fs.existsSync(registryPath)) {
    const registry = new Database(registryPath, { fileMustExist: true });
    try {
      // s108-m05: every row naming this folder, by any spelling of it (E5 F12).
      const rows = registry.prepare('SELECT DISTINCT store_path FROM projects').all() as Array<{
        store_path: string;
      }>;
      const seen = registry.prepare(
        'UPDATE projects SET last_seen_at = ?, archived_at = NULL WHERE store_path = ?'
      );
      const now = Date.now();
      for (const { store_path: stored } of rows)
        if (ProjectGraphRegistry.isSameFolder(stored, root)) seen.run(now, stored);
    } finally {
      registry.close();
    }
  }
  const { dbPath } = resolveRecordPaths(root);
  const db = new Database(dbPath, { fileMustExist: true, readonly: true });
  let metadata: Record<string, string | null> = {};
  try {
    // s108-m05: a store with no metadata table names no dashboard project, so its move finishes.
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'")
      .get();
    const rows = table
      ? (db
          .prepare(
            "SELECT key, value FROM metadata WHERE key IN ('dashboard_project_id', 'dashboard_slug', 'dashboard_registered')"
          )
          .all() as Array<{ key: string; value: string | null }>)
      : [];
    metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
  if (!metadata.dashboard_project_id && metadata.dashboard_registered !== 'true') return;
  const { DashboardClient } = await import('../tools/rbook/dashboard-client');
  const resolved = await DashboardClient.fromEnvForProject(root);
  if (!resolved.success || !resolved.data)
    throw new Error(
      `Dashboard path update remains pending: ${resolved.error?.message ?? 'client unavailable'}`
    );
  const projects = await resolved.data.client.getMyProjects();
  if (!projects.success || !projects.data)
    throw new Error(
      `Dashboard path update remains pending: cannot verify incumbent: ${projects.error?.message ?? 'directory unavailable'}`
    );
  const incumbent = projects.data.projects.find(
    (project) => project.id === metadata.dashboard_project_id
  );
  if (
    !incumbent ||
    incumbent.isOwner !== true ||
    !metadata.dashboard_slug ||
    incumbent.slug !== metadata.dashboard_slug
  )
    throw new Error(
      'Dashboard path update remains pending: the stored incumbent id, slug and ownership could not be confirmed. No dashboard project was changed or created.'
    );
  const result = await resolved.data.client.updateLocalProjectPath(incumbent.id, dbPath);
  if (!result.success)
    throw new Error(
      `Dashboard path update remains pending: ${result.error?.message ?? 'path update failed'}`
    );
}

export async function migrateProject(
  options: MigrationOptions
): Promise<RbookToolResult<MigrationResult>> {
  const root = path.resolve(options.projectRoot);
  let moved = false;
  let backup: string | undefined;
  let release: (() => void) | undefined;
  try {
    if (options.apply) release = acquireMigrationExclusion(root);
    if (
      options.apply &&
      !options.docsOnly &&
      (fs.existsSync(path.join(root, '.rbook-migration.json')) ||
        fs.existsSync(path.join(root, '.rbook-migration.lock')))
    ) {
      assertModernClients(options.env.HOME ?? os.homedir());
      if (options.checkProcesses !== false) assertNoRecordProcesses('pre-guard');
      recoverMigration(root, true);
    }
    const paths = resolveRecordPaths(root);
    const old = path.join(root, LEGACY.recordDirectory);
    if (!options.docsOnly && fs.existsSync(old) && fs.existsSync(path.join(root, 'rbook')))
      throw new Error(
        'Refusing migration because both record folders exist; inspect them before retrying.'
      );
    if (!fs.existsSync(paths.dbPath))
      throw new Error(
        `No record database exists at ${paths.dbPath}; choose the project root with --project.`
      );
    const willMove = !options.docsOnly && paths.legacy;
    const configDirectory = resolveConfigDirectory(options.env, options.env.HOME ?? os.homedir());
    const planned = planDocumentEdits(
      root,
      paths.directory,
      willMove || !paths.legacy,
      configDirectory
    );
    if (!options.apply) {
      const home = options.env.HOME ?? os.homedir();
      const blocked = [
        ...wouldRefuse(() => assertProjectServerVersion(root, willMove)),
        ...(willMove
          ? [
              ...modernClientProblems(home).map((problem) => problem.message),
              ...(options.checkProcesses !== false
                ? recordProcessProblems(mayHaveSynced(paths.dbPath) ? 'shared' : 'pre-guard').map(
                    (problem) => problem.message
                  )
                : []),
              ...wouldRefuse(() => assertNoOpenFiles(old)),
            ]
          : []),
      ];
      return {
        success: true,
        data: {
          dryRun: true,
          moved: false,
          changed: [
            ...(willMove ? [`${old} -> ${path.join(root, 'rbook')}`] : []),
            ...planned.edits.map((edit) => edit.file),
          ],
          left: planned.left,
          blocked,
        },
      };
    }
    assertProjectServerVersion(root, willMove);
    if (willMove) {
      assertModernClients(options.env.HOME ?? os.homedir());
      ({ backup } = moveRecord(root, options.checkProcesses !== false));
      moved = true;
    }
    // Re-plan against the committed directory, including retries after follow-up failures.
    const finalPaths = resolveRecordPaths(root);
    const documents = planDocumentEdits(
      root,
      finalPaths.directory,
      !finalPaths.legacy,
      configDirectory
    );
    const changed = applyDocumentEdits(documents.edits);
    if (!options.docsOnly && (moved || fs.existsSync(path.join(root, PENDING)))) {
      await finishRegistration(root, options.env);
      fs.rmSync(path.join(root, PENDING), { force: true });
    }
    return {
      success: true,
      data: { dryRun: false, moved, changed, left: documents.left, ...(backup ? { backup } : {}) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (moved) writeMigrationState(path.join(root, PENDING), { backup, remaining: message });
    return {
      success: false,
      error: {
        code: 'MIGRATION_REFUSED',
        message,
        suggestion: moved
          ? `The new store is intact. Retry reasonbook migrate --apply --project ${JSON.stringify(root)} to finish the recorded follow-ups.`
          : 'Use Reasonbook 4.x in every client, close clients holding this record, and retry reasonbook migrate --apply; --docs-only updates instructions without moving the store.',
      },
    };
  } finally {
    release?.();
  }
}

export async function runMigrate(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { flags, positional } = parseArgs(argv);
    const allowed = new Set(['apply', 'docs-only', 'config', 'project', 'project-root']);
    const seen = new Set<string>();
    for (const arg of argv.filter((value) => value.startsWith('--'))) {
      const flag = arg.slice(2).split('=')[0];
      if (!allowed.has(flag) || seen.has(flag)) throw new Error(`Unknown or repeated --${flag}.`);
      seen.add(flag);
    }
    if (positional.length)
      throw new Error('Unexpected positional arguments; name a project with --project <root>.');
    for (const name of ['apply', 'docs-only', 'config'])
      if (flags[name] !== undefined && flags[name] !== 'true')
        throw new Error(`--${name} is a boolean flag.`);
    if (flags.project && flags['project-root'])
      throw new Error('Use only one of --project and --project-root.');
    const project = flags.project ?? flags['project-root'];
    if (project === 'true') throw new Error('--project requires a directory.');
    if (flags.config && (flags['docs-only'] || project))
      throw new Error(
        '--config migrates only the shared config; do not combine it with --docs-only or --project.'
      );
    const result = flags.config
      ? await migrateConfig(io.env, flags.apply === 'true')
      : await migrateProject({
          projectRoot: path.resolve(io.cwd, project ?? '.'),
          env: io.env,
          apply: flags.apply === 'true',
          docsOnly: flags['docs-only'] === 'true',
        });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 1;
  } catch (error) {
    io.stderr(`reasonbook migrate: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

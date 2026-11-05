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
  readPending,
  recoverMigration,
  PENDING,
  writePending,
} from './migrate-store';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { migrateConfig } from './migrate-config';
import { exposureRefusal, planIgnores, shown, writeTwins, type IgnorePlan } from './migrate-ignore';
import { dryBackstop } from './migrate-dry-run';
import { recordMoveInIndex } from './migrate-index';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { finishDashboardPath, type PathStep } from './migrate-dashboard-path';

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
   * s110-m02 (#944): the follow-ups a committed move has not finished, as the marker lists them, when
   * one is the dashboard path update; the answer is still a success, since the record moved.
   */
  readonly pending?: readonly string[];
  /**
   * s108-m05, a dry run only: what the apply's checks would refuse now, from the project's server
   * entries, the clients' configuration, runtimes from before 4.0 and the record's open files.
   * s109-m01: and git's: a submodule or ignore source in the folder, files the move would expose.
   */
  readonly blocked?: string[];
  /** s109-m01, a dry run only: each rbook/ twin the move would add, as "<file>: <line>". */
  readonly twins?: string[];
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

/**
 * Only a pre-existing registration is touched; migration never adds another project. s110-m02
 * (#944): the dashboard path step's outcome is returned, and only a registry error throws.
 */
async function finishRegistration(root: string, env: NodeJS.ProcessEnv): Promise<PathStep> {
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
            "SELECT key, value FROM metadata WHERE key IN ('dashboard_project_id', 'dashboard_slug', 'dashboard_registered', 'owner', 'dashboard_username')"
          )
          .all() as Array<{ key: string; value: string | null }>)
      : [];
    metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
  const { DashboardClient } = await import('../tools/rbook/dashboard-client');
  const text = (key: string): string | null => metadata[key]?.trim() || null;
  return finishDashboardPath(
    {
      root,
      dbPath,
      projectId: text('dashboard_project_id'),
      registered: metadata.dashboard_registered === 'true',
      slug: text('dashboard_slug'),
      owner: text('owner') ?? text('dashboard_username'),
      retry: `retry reasonbook migrate --apply --project ${JSON.stringify(root)}`,
    },
    (projectRoot) => DashboardClient.fromEnvForProject(projectRoot)
  );
}

export async function migrateProject(
  options: MigrationOptions
): Promise<RbookToolResult<MigrationResult>> {
  const root = path.resolve(options.projectRoot);
  let moved = false;
  let following = false;
  let backup: string | undefined;
  let release: (() => void) | undefined;
  const left: string[] = [];
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
      const notes: string[] = [];
      const info: string[] = [];
      recoverMigration(root, true, notes, info);
      // s109-m01: a store recovery left in rollback-journal mode would move as one, so the retry
      // waits until a client has put it back; a committed move only reports it.
      if (notes.length && resolveRecordPaths(root).legacy)
        throw new Error(
          `${[...notes, ...info].join(' ')} Recovery released the migration guard; retry the move once that program ends. Nothing was moved.`
        );
      // A backup recovery found moves with the folder, where migrate's lines ignore it, so it is
      // named only when the retry refuses and the record stays where it was.
      left.push(...notes);
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
      // s109-m01: git's refusals and the backstop, read without a write.
      let ignores: IgnorePlan | undefined;
      const gitBlocked = willMove
        ? wouldRefuse(() => {
            ignores = planIgnores(root, options.env);
            const exposed = dryBackstop(root, ignores);
            if (exposed.length) throw new Error(exposureRefusal(exposed));
          })
        : [];
      const twins = (ignores?.chain ?? []).flatMap((link) =>
        link.added.map((line) => `${link.file}: ${shown(line)}`)
      );
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
              ...wouldRefuse(() => assertNoOpenFiles(old, undefined, { refuseSlowWarnings: true })),
              ...gitBlocked,
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
            ...(ignores?.chain ?? []).filter((link) => link.added.length).map((link) => link.file),
            ...planned.edits.map((edit) => edit.file),
          ],
          left: [...(ignores?.left ?? []), ...planned.left],
          blocked,
          ...(willMove ? { twins } : {}),
        },
      };
    }
    assertProjectServerVersion(root, willMove);
    if (willMove) {
      assertModernClients(options.env.HOME ?? os.homedir());
      const record = moveRecord(root, options.checkProcesses !== false, options.env);
      backup = record.backup;
      left.push(...record.left);
      moved = true;
    }
    following = !options.docsOnly && (moved || fs.existsSync(path.join(root, PENDING)));
    const folder = readPending(root)?.folder ?? LEGACY.recordDirectory;
    // A retry writes the twins too, comparing before it writes: a move an older release made left
    // the root's rules naming the old folder, and its index blob alone would hold them (build critic
    // B, round 1, note 6). The move itself wrote them before its rename.
    // A twin step that cannot run waits with the index step, and documents and registration still
    // run (settled item 9; round-2 verifier B).
    let twinsWaiting: string | undefined;
    if (following && !moved) {
      try {
        const retry = planIgnores(root, options.env, { folder });
        writeTwins(retry);
        for (const link of retry.chain)
          if (link.added.length)
            left.push(`${link.file}: migrate added ${link.added.map(shown).join(', ')}.`);
      } catch (error) {
        twinsWaiting = (error as Error).message;
        left.push(
          `migrate could not give the .gitignore files above the record the rbook/ twins of their rules naming ${folder}/ (${twinsWaiting}); a later reasonbook migrate --apply writes them. Until then, do not commit with git add -A or git commit -a: either would commit files under rbook/ that those rules ignore under ${folder}/.`
        );
      }
    }
    // s109-m01: git's index first, so no ordinary commit drops a moved file while a later follow-up
    // waits; a retry runs it whenever the marker exists, whatever its text says.
    const index = following
      ? recordMoveInIndex(root, options.env, folder, moved)
      : { done: true, pending: [], left: [] };
    left.push(...index.left);
    // Re-plan against the committed directory, including retries after follow-up failures.
    const finalPaths = resolveRecordPaths(root);
    const documents = planDocumentEdits(
      root,
      finalPaths.directory,
      !finalPaths.legacy,
      configDirectory
    );
    const changed = applyDocumentEdits(documents.edits);
    let unfinished: string[] = [];
    if (following) {
      // s110-m02 (#944): the path step answers its outcome; only a registry error throws.
      const pathStep = await finishRegistration(root, options.env);
      if (pathStep.status !== 'done') left.push(pathStep.left);
      left.push(...pathStep.notes);
      const pathWaiting = pathStep.status === 'pending' ? pathStep.left : undefined;
      unfinished = [
        ...(twinsWaiting ? ['the ignore rules'] : []),
        ...(index.done ? [] : ['the git index']),
        ...(pathWaiting ? ['the dashboard path update'] : []),
      ];
      // The marker goes only once every follow-up is done, and then names exactly those left.
      if (!unfinished.length) fs.rmSync(path.join(root, PENDING), { force: true });
      else
        writePending(root, {
          remaining: [
            ...(twinsWaiting ? [`the ignore rules: ${twinsWaiting}`] : []),
            ...(index.done ? [] : [`the git index: ${index.pending.join('; ')}`]),
            ...(pathWaiting ? [`the dashboard path update: ${pathWaiting}`] : []),
          ].join('; '),
          steps: unfinished,
        });
    }
    return {
      success: true,
      data: {
        dryRun: false,
        moved,
        changed,
        left: [...left, ...documents.left],
        ...(unfinished.includes('the dashboard path update') ? { pending: unfinished } : {}),
        ...(backup ? { backup } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The marker keeps what the move recorded, the old folder's spelling among it, and a retry that
    // fails keeps the backup an earlier run recorded (s110-m02, #944).
    if (moved || following)
      writePending(root, { ...(backup ? { backup } : {}), remaining: message });
    return {
      success: false,
      error: {
        code: 'MIGRATION_REFUSED',
        message,
        suggestion:
          moved || following
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

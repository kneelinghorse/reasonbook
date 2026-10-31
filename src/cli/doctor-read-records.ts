// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's record readers: the config folder, the registry and each project's record.
// ABOUTME: The registry opens read-only and never waits; a project is read with existence checks and its own files.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  modernClientProblems,
  projectServerPins,
  type ClientProblem,
  type ServerPinProblem,
} from './migrate-guard';
import {
  fail,
  isObject,
  mcpjsonSwitches,
  permissionNames,
  readJson,
  servers,
  type McpjsonSwitches,
  type PermissionSource,
  type Read,
  type ServerEntry,
} from './doctor-read';
import {
  getSetting,
  LEGACY,
  resolveConfigDirectory,
  resolveRecordPaths,
  settingNames,
} from '../intelligence/legacy-compat';
import {
  DEFAULT_CONFIRMED_META_KEY,
  DEFAULT_PROJECT_META_KEY,
} from '../intelligence/project-graph-registry';

export interface RegistryRow {
  readonly projectId: string;
  readonly storePath: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface RegistrySnapshot {
  readonly rows: readonly RegistryRow[];
  readonly defaultId: string | null;
  readonly confirmedId: string | null;
}

/** One registry file opened read-only, never created and never waited on: a busy one is unread. */
export function readRegistry(file: string): Read<RegistrySnapshot> {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    const rows = (
      db.prepare('SELECT project_id, store_path, name, archived_at FROM projects').all() as Array<{
        project_id: string;
        store_path: string;
        name: string;
        archived_at: number | null;
      }>
    ).map((row) => ({
      projectId: row.project_id,
      storePath: row.store_path,
      name: row.name,
      archived: row.archived_at !== null,
    }));
    const meta = new Map(
      (
        db
          .prepare('SELECT key, value FROM registry_meta WHERE key IN (?, ?)')
          .all(DEFAULT_PROJECT_META_KEY, DEFAULT_CONFIRMED_META_KEY) as Array<{
          key: string;
          value: string;
        }>
      ).map((row) => [row.key, row.value])
    );
    return {
      ok: true,
      value: {
        rows,
        defaultId: meta.get(DEFAULT_PROJECT_META_KEY) ?? null,
        confirmedId: meta.get(DEFAULT_CONFIRMED_META_KEY) ?? null,
      },
    };
  } catch (error) {
    return fail(`${file}: ${(error as Error).message}`);
  } finally {
    db?.close();
  }
}

function listNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/** Whether the plugin's server starts, by the plugin launcher's own reading of config.json. */
export interface PluginServer {
  readonly state: 'on' | 'off' | 'refuses';
  readonly file: string;
  readonly reason?: string;
}

export interface ConfigState {
  /** RBOOK_CONFIG_DIR (or its legacy name) as a folder, when it names one. */
  readonly explicit: string | null;
  /** The setting is present but empty: Reasonbook then uses the folder each client starts in. */
  readonly emptySetting: boolean;
  /** The variable that holds the setting, RBOOK_CONFIG_DIR or its legacy name, when one does. */
  readonly settingName: string | null;
  /** The folder Reasonbook would use, or why it refuses (an interrupted config move). */
  readonly resolved: Read<string>;
  readonly current: string;
  readonly legacy: string;
  readonly registries: ReadonlyArray<{
    readonly file: string;
    readonly read: Read<RegistrySnapshot>;
  }>;
  readonly pluginServer: Read<PluginServer>;
  /** The names in the new folder when it exists, since migrate refuses while both folders do. */
  readonly currentEntries: readonly string[] | null;
}

export function readConfig(env: NodeJS.ProcessEnv, home: string): ConfigState {
  // Read as Reasonbook reads it: the current name first, and an empty value still counts as set.
  const setting = getSetting('RBOOK_CONFIG_DIR', env);
  const emptySetting = setting === '';
  // The name that holds it, in getSetting's order, so the finding names what to change.
  const settingName =
    settingNames('RBOOK_CONFIG_DIR').find((name) => env[name] !== undefined) ?? null;
  const explicit = setting ? path.resolve(setting) : null;
  const current = path.join(home, '.config', 'rbook');
  const legacy = path.join(home, '.config', LEGACY.configDirectory);
  let resolved: Read<string>;
  if (emptySetting)
    resolved = fail(`${settingName} is set but empty, so each client uses the folder it starts in`);
  else
    try {
      resolved = { ok: true, value: resolveConfigDirectory(env, home, { quiet: true }) };
    } catch (error) {
      resolved = fail((error as Error).message);
    }
  const folders = [...new Set([explicit, current, legacy])].filter(
    (folder): folder is string => folder !== null
  );
  const registries = folders
    .map((folder) => path.join(folder, 'project-graph.sqlite'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, read: readRegistry(file) }));
  let pluginServer: Read<PluginServer> = fail(
    resolved.ok ? '' : `the config folder is unknown: ${resolved.reason}`
  );
  if (resolved.ok) {
    // The launcher's rules (plugins/reasonbook/hooks/run.mjs): a missing file is on; a file it
    // cannot read or parse, or a pluginServer other than on or off, stops the plugin's server.
    const file = path.join(resolved.value, 'config.json');
    const read = readJson(file);
    const value = read.ok ? read.value : null;
    const state: PluginServer = !read.ok
      ? read.missing
        ? { state: 'on', file }
        : { state: 'refuses', file, reason: read.reason }
      : !isObject(value)
        ? { state: 'refuses', file, reason: `${file} is not a JSON object` }
        : value.pluginServer === undefined || value.pluginServer === 'on'
          ? { state: 'on', file }
          : value.pluginServer === 'off'
            ? { state: 'off', file }
            : {
                state: 'refuses',
                file,
                reason: `${file} sets pluginServer to neither "on" nor "off"`,
              };
    pluginServer = { ok: true, value: state };
  }
  return {
    explicit,
    emptySetting,
    settingName,
    resolved,
    current,
    legacy,
    registries,
    pluginServer,
    currentEntries: fs.existsSync(current) ? listNames(current) : null,
  };
}

export interface ProjectState {
  readonly root: string;
  readonly exists: boolean;
  readonly layout: 'rbook' | 'legacy' | 'both' | 'none';
  readonly journal: boolean;
  readonly lock: boolean;
  readonly pending: boolean;
  /** The old pins migrate would refuse in this project's .mcp.json, as it would move it. */
  readonly serverPins: readonly ServerPinProblem[];
  /** This project's .mcp.json Reasonbook servers, with the names each one runs under. */
  readonly servers: readonly ServerEntry[];
  /** Its settings files' approvals of those servers. */
  readonly mcpjson: readonly McpjsonSwitches[];
  readonly permissions: readonly PermissionSource[];
  /** Why a file here, or a server entry's shape, could not be read, so its checks did not run. */
  readonly unread: readonly string[];
}

export function readProject(root: string): ProjectState {
  const exists = fs.existsSync(root);
  const current = fs.existsSync(path.join(root, 'rbook'));
  const old = fs.existsSync(path.join(root, LEGACY.recordDirectory));
  // Both folders refuse a move; otherwise a layout is its record file, as migrate finds it.
  const layout =
    current && old
      ? 'both'
      : current
        ? fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))
          ? 'rbook'
          : 'none'
        : old && fs.existsSync(path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile))
          ? 'legacy'
          : 'none';
  const unread: string[] = [];
  // Parsed once, by the reader that never echoes a parser message, then judged by migrate's rules,
  // with the old package refused as migrate refuses it in a record that will move.
  const mcp = readJson(path.join(root, '.mcp.json'));
  if (!mcp.ok && !mcp.missing) unread.push(mcp.reason);
  const journal = fs.existsSync(path.join(root, '.rbook-migration.json'));
  const lock = fs.existsSync(path.join(root, '.rbook-migration.lock'));
  // An interrupted move will move again, so its pins are judged as migrate judges a moving record.
  const pins = mcp.ok
    ? projectServerPins(root, mcp.value, layout === 'legacy' || journal || lock)
    : [];
  unread.push(...pins.filter((pin) => pin.kind === 'shape').map((pin) => pin.message));
  const permissions: PermissionSource[] = [];
  const mcpjson: McpjsonSwitches[] = [];
  for (const relative of ['.claude/settings.json', '.claude/settings.local.json']) {
    const file = path.join(root, relative);
    const read = readJson(file);
    if (read.ok) {
      permissions.push({ file, names: permissionNames(read.value) });
      mcpjson.push(mcpjsonSwitches(read.value));
    } else if (!read.missing) unread.push(read.reason);
  }
  return {
    root,
    exists,
    layout,
    journal,
    lock,
    pending: fs.existsSync(path.join(root, '.rbook-migration-pending.json')),
    serverPins: pins.filter((pin) => pin.kind !== 'shape'),
    servers: mcp.ok && isObject(mcp.value) ? servers(mcp.value.mcpServers) : [],
    mcpjson,
    permissions,
    unread,
  };
}

/** What migrate's client guard refuses: before a record moves, and before the config folder does. */
export function readClientProblems(home: string): {
  readonly moving: readonly ClientProblem[];
  readonly configMove: readonly ClientProblem[];
} {
  const moving = modernClientProblems(home, false);
  const configMove = modernClientProblems(home, true).filter(
    (problem) => !moving.some((found) => found.message === problem.message)
  );
  return { moving, configMove };
}

/** The project whose record sits at or above `start`, as `resolveRecordPaths` would find it. */
export function findProjectRoot(start: string): string | null {
  let at = path.resolve(start);
  for (;;) {
    if (['rbook', LEGACY.recordDirectory].some((name) => fs.existsSync(path.join(at, name, 'db'))))
      return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/** Whether a registered root still holds a store; a migration in progress reads as present. */
export function storeExists(root: string): boolean {
  try {
    return fs.existsSync(resolveRecordPaths(root).dbPath);
  } catch {
    return true;
  }
}

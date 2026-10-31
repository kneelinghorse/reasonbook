// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's client readers: global installs, Claude Code's plugins, servers and permissions.
// ABOUTME: Read-only by construction: every path comes from the injected environment, and nothing is run.

import * as fs from 'fs';
import * as path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';

/** A file's value, or why it is absent or could not be read. */
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

export const fail = (reason: string, missing = false): Read<never> => ({
  ok: false,
  missing,
  reason,
});
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Why a file could not be read, by its error code only: an exception's own message can quote the
 * file's text, and these files hold credentials (s107-m03 critic, round 1).
 */
export function readText(file: string): Read<string> {
  try {
    return { ok: true, value: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(
      `${file} could not be read (${code ?? 'unknown error'})`,
      code === 'ENOENT' || code === 'ENOTDIR'
    );
  }
}

/** A JSON file's value. A parse failure is named without the parser's message, which quotes text. */
export function readJson(file: string): Read<unknown> {
  const text = readText(file);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    return fail(`${file} is not valid JSON`);
  }
}

export interface GlobalInstall {
  readonly command: string;
  readonly packageName: string | null;
  readonly version: string | null;
}

/** The first `command` on PATH, followed through its link to the package it runs; nothing is run. */
export function findGlobal(env: NodeJS.ProcessEnv, command: string): GlobalInstall | null {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const file = path.join(directory, command);
    if (!fs.existsSync(file)) continue;
    let parent: string;
    try {
      parent = path.dirname(fs.realpathSync(file));
    } catch {
      return { command, packageName: null, version: null };
    }
    for (let depth = 0; depth < 5; depth++) {
      const manifest = readJson(path.join(parent, 'package.json'));
      if (manifest.ok && isObject(manifest.value) && typeof manifest.value.name === 'string')
        return {
          command,
          packageName: manifest.value.name,
          version: typeof manifest.value.version === 'string' ? manifest.value.version : null,
        };
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return { command, packageName: null, version: null };
  }
  return null;
}

/** A manual MCP entry that runs Reasonbook: its name, command and package spec, and nothing else. */
export interface ServerEntry {
  readonly name: string;
  readonly command: string | null;
  readonly spec: string | null;
}

const SERVER_NAMES = new Set(['reasonbook', 'rbook', LEGACY.command, LEGACY.recordDirectory]);
const packageSpec = (value: string): string | null =>
  /@aquex\/(?:reasonbook|cmos-mcp)(?:@[0-9A-Za-z.+-]+)?/.exec(value)?.[0] ?? null;

/** An absolute dist/ entry whose package.json names Reasonbook, as `a local build of <name> <v>`. */
function localBuild(args: readonly string[]): string | null {
  const entry = args.find((arg) => /(?:^|[\\/])dist[\\/](?:index|bin|cli)\.js$/.test(arg));
  if (!entry || !path.isAbsolute(entry)) return null;
  const manifest = readJson(path.join(path.dirname(entry), '..', 'package.json'));
  if (!manifest.ok || !isObject(manifest.value)) return null;
  const { name, version } = manifest.value;
  if (name !== '@aquex/reasonbook' && name !== LEGACY.packageName) return null;
  return `a local build of ${name}${typeof version === 'string' ? ` ${version}` : ''}`;
}

/**
 * Only the command's first word and the package-shaped arguments are read: an entry's env,
 * headers, url and every other argument, or the rest of a command line, can hold a credential.
 */
export function reasonbookServer(name: string, entry: unknown): ServerEntry | null {
  if (!isObject(entry)) return null;
  const command = typeof entry.command === 'string' ? entry.command : null;
  // The program a shell would run: past any leading NAME=value assignment, and only a plain name,
  // so no credential written at the start of a command line is printed (s107-m03 round 4).
  // The program is printed only when the field is one plain word, as an MCP entry writes it; a
  // command line is never parsed, since an assignment, quote, substitution or expansion in it can
  // hold a credential (s107-m03 rounds 4 to 6).
  const program =
    command !== null && /^[A-Za-z0-9_./@+-]+$/.test(command.trim())
      ? path.basename(command.trim())
      : null;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  // A global install runs as its own command, under any entry name (README, getting-started).
  const global =
    program === 'reasonbook'
      ? 'the reasonbook command'
      : program === LEGACY.command
        ? `${LEGACY.packageName} (the ${LEGACY.command} command)`
        : null;
  const spec =
    [command ?? '', ...args].map(packageSpec).find((found) => found !== null) ??
    localBuild(args) ??
    global;
  if (spec === null && !SERVER_NAMES.has(name)) return null;
  return { name, command: program, spec };
}

export function servers(table: unknown): ServerEntry[] {
  if (!isObject(table)) return [];
  return Object.entries(table)
    .map(([name, entry]) => reasonbookServer(name, entry))
    .filter((entry): entry is ServerEntry => entry !== null);
}

export interface PluginRecord {
  readonly name: string;
  readonly scope: string | null;
  readonly version: string | null;
  /** The project a project- or local-scope install belongs to (probed in a scratch HOME). */
  readonly projectPath: string | null;
  /**
   * enabledPlugins for it where it runs: the user settings for a user install; for a project or
   * local one, that project's settings.local.json, then its settings.json, then the user's.
   * Null when none names it.
   */
  readonly enabled: boolean | null;
}

/** Permission names in one file that `toolNameSuffix` reads as Reasonbook tools. */
export interface PermissionSource {
  readonly file: string;
  readonly names: readonly string[];
}

export function permissionNames(value: unknown): string[] {
  if (!isObject(value)) return [];
  const permissions = isObject(value.permissions) ? value.permissions : {};
  return ['allow', 'ask', 'deny']
    .flatMap((key) => (Array.isArray(permissions[key]) ? permissions[key] : []))
    .filter((name): name is string => typeof name === 'string');
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Claude Code's approvals of a project's .mcp.json servers, from one settings source. */
export interface McpjsonSwitches {
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
  readonly all: boolean;
}

/** The documented keys, which ~/.claude.json's projects and any settings file can hold. */
export const mcpjsonSwitches = (value: unknown): McpjsonSwitches => ({
  enabled: isObject(value) ? strings(value.enabledMcpjsonServers) : [],
  disabled: isObject(value) ? strings(value.disabledMcpjsonServers) : [],
  all: isObject(value) && value.enableAllProjectMcpServers === true,
});

/** Claude Code's per-project server switches in ~/.claude.json, as this Mac's file holds them. */
export interface ProjectSwitches {
  /** User and local servers turned off in this project (/mcp). */
  readonly disabled: readonly string[];
  readonly mcpjson: McpjsonSwitches;
}

export interface ClaudeState {
  readonly installed: Read<PluginRecord[]>;
  readonly enabled: Read<Record<string, boolean>>;
  /** The user settings' .mcp.json approvals, which apply in every project. */
  readonly mcpjson: McpjsonSwitches;
  readonly userServers: Read<ServerEntry[]>;
  /** Local-scope Reasonbook servers by project, without the ones turned off there. */
  readonly localServers: Read<Record<string, ServerEntry[]>>;
  readonly switches: Readonly<Record<string, ProjectSwitches>>;
  readonly permissions: readonly PermissionSource[];
  /** Why a file holding saved permissions could not be read, so its names were not checked. */
  readonly unread: readonly string[];
}

export const PLUGIN_NAME = /^(?:reasonbook|cmos)(?:-chat)?@/;

const enabledIn = (settings: unknown, name: string): boolean | null => {
  const enabled =
    isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  return typeof enabled[name] === 'boolean' ? enabled[name] : null;
};

function pluginRecords(value: unknown, user: unknown): PluginRecord[] {
  const plugins = isObject(value) && isObject(value.plugins) ? value.plugins : {};
  return Object.entries(plugins)
    .filter(([name]) => PLUGIN_NAME.test(name))
    .flatMap(([name, entries]) =>
      (Array.isArray(entries) ? entries : []).filter(isObject).map((entry) => {
        let version = typeof entry.version === 'string' ? entry.version : null;
        if (version === null && typeof entry.installPath === 'string') {
          const manifest = readJson(path.join(entry.installPath, '.claude-plugin/plugin.json'));
          if (manifest.ok && isObject(manifest.value) && typeof manifest.value.version === 'string')
            version = manifest.value.version;
        }
        const scope = typeof entry.scope === 'string' ? entry.scope : null;
        const projectPath = typeof entry.projectPath === 'string' ? entry.projectPath : null;
        const own =
          projectPath && scope !== 'user'
            ? ['settings.local.json', 'settings.json'].map((file) => {
                const read = readJson(path.join(projectPath, '.claude', file));
                return enabledIn(read.ok ? read.value : {}, name);
              })
            : [];
        return {
          name,
          scope,
          version,
          projectPath,
          enabled: [...own, enabledIn(user, name)].find((on) => on !== null) ?? null,
        };
      })
    );
}

export function readClaude(home: string): ClaudeState {
  const record = readJson(path.join(home, '.claude/plugins/installed_plugins.json'));
  const settings = readJson(path.join(home, '.claude/settings.json'));
  const enabledPlugins =
    settings.ok && isObject(settings.value) && isObject(settings.value.enabledPlugins)
      ? settings.value.enabledPlugins
      : {};
  const config = readJson(path.join(home, '.claude.json'));
  const projects =
    config.ok && isObject(config.value) && isObject(config.value.projects)
      ? config.value.projects
      : {};
  const switches: Record<string, ProjectSwitches> = {};
  for (const [root, project] of Object.entries(projects))
    if (isObject(project))
      switches[root] = {
        disabled: strings(project.disabledMcpServers),
        mcpjson: mcpjsonSwitches(project),
      };
  const permissions: PermissionSource[] = [];
  if (settings.ok)
    permissions.push({
      file: path.join(home, '.claude/settings.json'),
      names: permissionNames(settings.value),
    });
  if (config.ok && isObject(config.value))
    permissions.push({
      file: path.join(home, '.claude.json'),
      names: [
        ...strings(config.value.allowedTools),
        ...Object.values(projects).flatMap((project) =>
          isObject(project) ? strings(project.allowedTools) : []
        ),
      ],
    });
  const local: Record<string, ServerEntry[]> = {};
  for (const [root, project] of Object.entries(projects)) {
    const off = new Set(switches[root]?.disabled ?? []);
    const found = servers(isObject(project) ? project.mcpServers : {}).filter(
      (entry) => !off.has(entry.name)
    );
    if (found.length) local[root] = found;
  }
  const unread = [settings, config].flatMap((read) =>
    !read.ok && !read.missing ? [read.reason] : []
  );
  return {
    installed: record.ok
      ? { ok: true, value: pluginRecords(record.value, settings.ok ? settings.value : {}) }
      : record,
    enabled: settings.ok
      ? {
          ok: true,
          value: Object.fromEntries(
            Object.entries(enabledPlugins).filter(([, on]) => typeof on === 'boolean') as Array<
              [string, boolean]
            >
          ),
        }
      : settings,
    mcpjson: mcpjsonSwitches(settings.ok ? settings.value : {}),
    userServers: config.ok
      ? { ok: true, value: servers(isObject(config.value) ? config.value.mcpServers : {}) }
      : config,
    localServers: config.ok ? { ok: true, value: local } : config,
    switches,
    permissions,
    unread,
  };
}

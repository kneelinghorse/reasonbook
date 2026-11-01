// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A move refuses pre-4.0 runtimes, legacy clients and open files, and never stops a session.
// ABOUTME: Client configuration and OS handle inspection fail closed when their state is unreadable.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { LEGACY } from '../intelligence/legacy-compat';

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot inspect ${file}: ${(error as Error).message}`);
  }
}

/**
 * Only migration calls this: no path or process argument is interpreted by a shell. s108-m05: a
 * move's last check passes the mover's own pid, whose held connection keeps the record locked.
 */
export function assertNoOpenFiles(directory: string, ownPid?: number): void {
  const inspected = spawnSync('lsof', ['-nP', '-Fpcn', '+D', directory], { encoding: 'utf8' });
  if (
    inspected.error ||
    (inspected.status !== 0 && inspected.status !== 1) ||
    inspected.stderr.trim()
  )
    throw new Error(
      `Cannot establish that no other process has files in ${directory} open; lsof must be available and able to inspect every open file.`
    );
  const holders = [...new Set([...inspected.stdout.matchAll(/^p(\d+)$/gm)].map((m) => m[1]))];
  const others = holders.filter((id) => Number(id) !== ownPid);
  // Output that names no process is no proof that nothing holds the record.
  if (others.length || (inspected.stdout.trim() && !holders.length))
    throw new Error(
      `Files in ${directory} are open by process ${others.join(', ') || 'unknown'}. Close those clients before migrating; no process was stopped.`
    );
}

function oldPackage(value: string): boolean {
  if (value.includes(LEGACY.packageName)) return true;
  return /@aquex\/reasonbook@[0-3](?:\.|\b)/.test(value);
}

export function assertProjectServerVersion(projectRoot: string, moving = false): void {
  const file = path.join(projectRoot, '.mcp.json');
  const source = read(file);
  if (!source) return;
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch {
    // Never the parser's message: it quotes the file's text.
    throw new Error(`${file} is not valid JSON; fix it before applying migration.`);
  }
  const [problem] = projectServerPins(projectRoot, config, moving);
  if (problem) throw new Error(problem.message);
}

export interface ServerPinProblem {
  readonly message: string;
  /**
   * shape: the entry is not an object or its args not a list, so nothing about its version could
   * be read; legacy-package: a record that will move still names the old package; local-build: a
   * pre-4.x or unknown local build; old-pin: a package pinned below 4.x.
   */
  readonly kind: 'shape' | 'legacy-package' | 'local-build' | 'old-pin';
}

/**
 * s107-m03: the `.mcp.json` server pins migrate refuses, for an already parsed file; never
 * throws, so reasonbook doctor can list them all. A server entry that is not an object, or whose
 * args is not a list, is a shape problem, as it was a crash before.
 */
export function projectServerPins(
  projectRoot: string,
  config: unknown,
  moving = false
): ServerPinProblem[] {
  const file = path.join(projectRoot, '.mcp.json');
  const problem = (kind: ServerPinProblem['kind'], message: string) => ({ message, kind });
  const servers =
    config && typeof config === 'object' ? (config as { mcpServers?: unknown }).mcpServers : null;
  // A missing, listed or scalar mcpServers names no server, as migrate has always read it.
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const problems: ServerPinProblem[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      problems.push(problem('shape', `${file} server ${name} is not an object.`));
      continue;
    }
    const settings = server as { args?: unknown };
    if (settings.args !== undefined && !Array.isArray(settings.args)) {
      problems.push(problem('shape', `${file} server ${name} has args that are not a list.`));
      continue;
    }
    const serialized = JSON.stringify(server);
    if (moving && serialized.includes(LEGACY.packageName))
      problems.push(
        problem(
          'legacy-package',
          `${file} server ${name} still names the legacy package. Run reasonbook migrate --apply --docs-only, configure Reasonbook 4.x, then move the record.`
        )
      );
    const entry = (settings.args ?? []).find(
      (arg): arg is string =>
        typeof arg === 'string' && /(?:^|\/)dist\/(?:index|bin|cli)\.js$/.test(arg)
    );
    if (entry && (name === LEGACY.command || name === 'rbook' || name === 'reasonbook')) {
      let version: unknown;
      try {
        const manifest = read(path.resolve(projectRoot, path.dirname(entry), '../package.json'));
        version = manifest ? (JSON.parse(manifest) as { version?: unknown }).version : undefined;
      } catch {
        version = undefined;
      }
      if (typeof version !== 'string' || !/^(?:[4-9]|\d{2,})\./.test(version))
        problems.push(
          problem(
            'local-build',
            `${file} server ${name} runs a pre-4.x or unknown local build. Rebuild or configure Reasonbook 4.x before applying migration.`
          )
        );
    }
    // An unpinned old package can be rewritten; an explicit old version must be upgraded first.
    if (
      new RegExp(
        `${LEGACY.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@[0-3](?:\\.|\\b)`
      ).test(serialized) ||
      /@aquex\/reasonbook@[0-3](?:\.|\b)/.test(serialized)
    )
      problems.push(
        problem(
          'old-pin',
          `${file} server ${name} is pinned to a pre-4.x package; update it to Reasonbook 4.x before applying migration.`
        )
      );
  }
  return problems;
}

export interface ClientProblem {
  /** unreadable: the guard could not read or parse the file, which refuses as surely. */
  readonly kind:
    | 'unreadable'
    | 'plugin-version'
    | 'enabled-legacy'
    | 'codex-legacy'
    | 'config-build';
  readonly file: string;
  readonly message: string;
  /** config-build matched an old build's dist/ path, beside the old package's name or not. */
  readonly distBuild?: boolean;
}

const LEGACY_PLUGIN = new RegExp(`^${LEGACY.recordDirectory}(?:-chat)?@`);

/**
 * s107-m03: every reason assertModernClients refuses, in its order, without throwing, so
 * reasonbook doctor can list them before it offers a move. A file that cannot be read or parsed
 * is named without the parser's message, which quotes the file's text.
 */
export function modernClientProblems(home: string, configMove = false): ClientProblem[] {
  const problems: ClientProblem[] = [];
  const load = (file: string): string | null => {
    try {
      return read(file);
    } catch (error) {
      problems.push({ kind: 'unreadable', file, message: (error as Error).message });
      return null;
    }
  };
  const parse = (file: string, source: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(source);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      problems.push({
        kind: 'unreadable',
        file,
        message: `${file} is not valid JSON; fix it before moving folders.`,
      });
      return {};
    }
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const installed = path.join(home, '.claude/plugins/installed_plugins.json');
  const source = load(installed);
  if (source) {
    for (const [name, entries] of Object.entries(record(parse(installed, source).plugins))) {
      if (!new RegExp(`^(?:${LEGACY.recordDirectory}|reasonbook)(?:-chat)?@`).test(name)) continue;
      for (const entry of Array.isArray(entries) ? entries.map(record) : [{}]) {
        let version = typeof entry.version === 'string' ? entry.version : undefined;
        if (!version && typeof entry.installPath === 'string') {
          const file = path.join(entry.installPath, '.claude-plugin/plugin.json');
          const manifest = load(file);
          if (manifest) {
            const found = parse(file, manifest).version;
            version = typeof found === 'string' ? found : undefined;
          }
        }
        if (!version || !/^(?:[4-9]|\d{2,})\./.test(version))
          problems.push({
            kind: 'plugin-version',
            file: installed,
            message: `${installed}: plugin ${name} is ${version ?? 'of unknown version'}; install Reasonbook 4.x before moving folders.`,
          });
      }
    }
  }
  for (const relative of ['.claude/settings.json', '.codex/config.toml']) {
    const file = path.join(home, relative);
    const contents = load(file);
    if (!contents) continue;
    if (relative.endsWith('.json')) {
      const enabled = record(parse(file, contents).enabledPlugins);
      if (Object.entries(enabled).some(([name, on]) => on && LEGACY_PLUGIN.test(name)))
        problems.push({
          kind: 'enabled-legacy',
          file,
          message: `${file} enables the legacy plugin; replace it with Reasonbook 4.x before moving folders.`,
        });
    } else if (
      new RegExp(`\\[plugins\\.["']?${LEGACY.recordDirectory}(?:-chat)?[@"']`).test(contents) ||
      oldPackage(contents)
    ) {
      problems.push({
        kind: 'codex-legacy',
        file,
        message: `${file} configures a legacy plugin or package; replace it with Reasonbook 4.x before moving folders.`,
      });
    }
  }
  if (configMove) {
    for (const relative of [
      '.claude.json',
      'Library/Application Support/Claude/claude_desktop_config.json',
      'Library/Application Support/Code/User/settings.json',
      'Library/Application Support/Cursor/User/settings.json',
      '.cursor/mcp.json',
      '.codex/config.toml',
    ]) {
      const file = path.join(home, relative);
      const contents = load(file);
      if (contents && (oldPackage(contents) || contents.includes(`${LEGACY.command}/dist/`)))
        problems.push({
          kind: 'config-build',
          file,
          ...(contents.includes(`${LEGACY.command}/dist/`) ? { distBuild: true } : {}),
          message: `${file} still configures a legacy build; remove it before moving the shared config folder.`,
        });
    }
  }
  return problems;
}

/** Inspect installed/enabled plugin records; unknown matching versions refuse a folder move. */
export function assertModernClients(home: string, configMove = false): void {
  const [problem] = modernClientProblems(home, configMove);
  if (problem) throw new Error(problem.message);
}

/**
 * s108-m05: who a move waits for. A record's move ('pre-guard') waits only for a runtime from before
 * 4.0.0, which can open the record without the in-project check every 4.x release makes before each
 * open; the held lock covers a handle opened mid-move. The shared config's move ('every') waits for
 * every runtime, since each holds the registry open for its life (E5 F4, F11). Decision #1330's
 * cached-path race is the one the held lock closes. A record that may ever have synced ('shared')
 * waits for every runtime too: a 4.1 to 4.9 server that syncs it ends at its next sync during the
 * move (round 2), and keeps syncing a record it once saw shared (round 3).
 */
export type RuntimeScope = 'pre-guard' | 'shared' | 'every';

export interface RuntimeProblem {
  /** Absent when the process list itself could not be read. */
  readonly pid?: number;
  readonly message: string;
}

const ENTRY =
  /(?:^|\/)(?:dist\/(?:index|bin|cli)\.js|(?:server|hooks)\/(?:run|install-worker|installing-server|disabled-server)\.mjs)$/;
const MODERN = /^(?:[4-9]|\d{2,})\./;

type Manifest =
  | {
      readonly file: string;
      readonly reasonbook: boolean;
      readonly legacy: boolean;
      readonly version: unknown;
    }
  | { readonly unreadable: string };

const PLUGIN_NAMES = [
  'reasonbook',
  'reasonbook-chat',
  LEGACY.recordDirectory,
  `${LEGACY.recordDirectory}-chat`,
];
const LEGACY_PLUGIN_NAMES = [LEGACY.recordDirectory, `${LEGACY.recordDirectory}-chat`];

/** The first manifest at or above a runtime's file, package before plugin, as the walk has read it. */
function runtimeManifest(file: string): Manifest | null {
  let directory = path.dirname(file);
  for (let depth = 0; depth < 5 && path.isAbsolute(directory); depth++) {
    for (const [relative, names, legacy, ownOnly] of [
      ['package.json', ['@aquex/reasonbook', LEGACY.packageName], [LEGACY.packageName], false],
      ['.claude-plugin/plugin.json', PLUGIN_NAMES, LEGACY_PLUGIN_NAMES, false],
      // s108-m05: the chat plugin kept its manifest at its root before 4.7.0 (round 1). Read there, a
      // manifest identifies only a Reasonbook plugin; another product's leaves the walk going.
      ['plugin.json', PLUGIN_NAMES, LEGACY_PLUGIN_NAMES, true],
    ] as const) {
      const manifest = path.join(directory, relative);
      let text: string | null;
      try {
        text = read(manifest);
      } catch {
        if (ownOnly) continue;
        return { unreadable: `${manifest} could not be read` };
      }
      if (text === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (ownOnly) continue;
        // Never the parser's message: it quotes the file's text.
        return { unreadable: `${manifest} is not valid JSON` };
      }
      const { name, version } = (parsed && typeof parsed === 'object' ? parsed : {}) as {
        name?: unknown;
        version?: unknown;
      };
      const reasonbook = (names as readonly unknown[]).includes(name);
      if (ownOnly && !reasonbook) continue;
      return {
        file: manifest,
        reasonbook,
        legacy: (legacy as readonly unknown[]).includes(name),
        version,
      };
    }
    directory = path.dirname(directory);
  }
  return null;
}

/**
 * The entry point on a command line. ps joins a process's arguments with spaces, so a path holding
 * one comes back in pieces; the pieces before it are joined back while that names a file (round 1).
 */
function entryOf(words: readonly string[]): string | undefined {
  const at = words.findIndex((part) => ENTRY.test(part));
  if (at < 0) return undefined;
  if (path.isAbsolute(words[at])) return words[at];
  for (let start = at - 1; start > 0; start--) {
    const joined = words.slice(start, at + 1).join(' ');
    if (path.isAbsolute(joined)) return fs.existsSync(joined) ? joined : words[at];
  }
  return words[at];
}

/** The global command is a link to the package's bin, so its manifest is read where it points. */
function commandTarget(words: readonly string[]): string | undefined {
  const command = words.find(
    (word) => path.isAbsolute(word) && path.basename(word) === 'reasonbook'
  );
  if (!command) return undefined;
  try {
    return fs.realpathSync.native(command);
  } catch {
    return command;
  }
}

/** Every Reasonbook runtime a move in this scope waits for, without throwing, so a dry run lists them. */
export function recordProcessProblems(scope: RuntimeScope = 'every'): RuntimeProblem[] {
  const processes = spawnSync('ps', ['-ww', '-axo', 'pid=,args='], { encoding: 'utf8' });
  if (processes.error || processes.status !== 0)
    return [{ message: 'Cannot inspect running clients; a move requires process inspection.' }];
  const problems: RuntimeProblem[] = [];
  for (const line of processes.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const pid = Number(match[1]);
    // ps joins arguments with single spaces, so each space is one boundary (round 2).
    const words = match[2].split(' ');
    const executable = path.basename(words[0]);
    if (!/^(?:node|nodejs|reasonbook|npx)$/.test(executable) && executable !== LEGACY.command)
      continue;
    const named =
      executable === 'reasonbook' ||
      words.some(
        (word) => path.basename(word) === 'reasonbook' || word.startsWith('@aquex/reasonbook')
      );
    const legacyName =
      executable === LEGACY.command ||
      words.some(
        (word) => path.basename(word) === LEGACY.command || word.startsWith(LEGACY.packageName)
      );
    const entry = entryOf(words);
    const file = entry ?? commandTarget(words);
    const found = file ? runtimeManifest(file) : null;
    // A Reasonbook manifest says what runs; the names on a command line say so only without one.
    const identified = found && !('unreadable' in found) && found.reasonbook ? found : undefined;
    // An unresolved supported entry point cannot prove that its cached path is safe.
    const unresolved = entry !== undefined && (!found || 'unreadable' in found);
    if (!identified && !named && !legacyName && !unresolved) continue;
    if (scope === 'every') {
      problems.push({
        pid,
        message: `Process ${pid} is a live or unidentified record runtime. Exit that client before offline migration; no process was stopped.`,
      });
      continue;
    }
    if (scope === 'shared') {
      problems.push({
        pid,
        message: `Process ${pid} is a live or unidentified record runtime, and this record's store has had a sync peer, or could not be read to tell: a Reasonbook 4.1 to 4.9 server that syncs it ends at its next sync during a move, so such a record moves only while no Reasonbook runtime runs. Exit that client before moving the record; no process was stopped.`,
      });
      continue;
    }
    const remedy =
      'Exit that client, or update it to Reasonbook 4.x, before moving the record; no process was stopped.';
    const before = (why: string) => ({
      pid,
      message: `Process ${pid} runs a Reasonbook runtime from before 4.0 (${why}), which can open the record without checking for a move. ${remedy}`,
    });
    const why = !found
      ? file
        ? `no manifest above ${file}`
        : 'no manifest on its command line'
      : 'unreadable' in found
        ? found.unreadable
        : `${found.file} names another program`;
    if (identified) {
      const { version } = identified;
      if (typeof version !== 'string')
        problems.push({
          pid,
          message: `Process ${pid} runs Reasonbook, but its version cannot be read (no version in ${identified.file}), so it may predate 4.0's check for a move. ${remedy}`,
        });
      else if (!MODERN.test(version)) problems.push(before(`version ${version}`));
      else if (identified.legacy) problems.push(before(`the legacy ${LEGACY.command} runtime`));
      // Otherwise it is 4.0.0 or later and checks for a move before every open, so it may run on.
      // Without a Reasonbook manifest, only what its command line names is known (round 2).
    } else if (legacyName)
      problems.push({
        pid,
        message: `Process ${pid} names ${LEGACY.command} on its command line and no Reasonbook manifest says what it runs (${why}), so it may be a runtime from before 4.0. ${remedy}`,
      });
    else if (words.some((word) => /@aquex\/reasonbook@[0-3](?:\.|\b)/.test(word)))
      problems.push({
        pid,
        message: `Process ${pid} names a Reasonbook release from before 4.0 on its command line, which can open the record without checking for a move. ${remedy}`,
      });
    else if (named)
      problems.push({
        pid,
        message: `Process ${pid} names Reasonbook on its command line, but no manifest gives its version (${why}), so it may predate 4.0's check for a move. ${remedy}`,
      });
    else
      problems.push({
        pid,
        message: `Process ${pid} runs a program at a Reasonbook entry point that cannot be identified (${why}), so it may be a runtime from before 4.0. Exit it before moving the record; no process was stopped.`,
      });
  }
  return problems;
}

/** Refuses the first runtime recordProcessProblems names; 'every' unless a record's move narrows it. */
export function assertNoRecordProcesses(scope: RuntimeScope = 'every'): void {
  const [problem] = recordProcessProblems(scope);
  if (problem) throw new Error(problem.message);
}

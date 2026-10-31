// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Offline migration refuses legacy clients and open files rather than stopping other sessions.
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

/** Only migration calls this: no path or process argument is interpreted by a shell. */
export function assertNoOpenFiles(directory: string): void {
  const inspected = spawnSync('lsof', ['-nP', '-Fpcn', '+D', directory], { encoding: 'utf8' });
  if (
    inspected.error ||
    (inspected.status !== 0 && inspected.status !== 1) ||
    inspected.stderr.trim()
  )
    throw new Error(
      `Cannot establish offline quiescence for ${directory}; lsof must be available and able to inspect every open file.`
    );
  if (inspected.stdout.trim()) {
    const ids = [...inspected.stdout.matchAll(/^p(\d+)$/gm)].map((m) => m[1]);
    throw new Error(
      `Files in ${directory} are open by process ${[...new Set(ids)].join(', ')}. Close those clients before migrating; no process was stopped.`
    );
  }
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

/** A cached path can reopen after lsof; cutover requires every record runtime to be offline. */
export function assertNoRecordProcesses(): void {
  const processes = spawnSync('ps', ['-ww', '-axo', 'pid=,args='], { encoding: 'utf8' });
  if (processes.error || processes.status !== 0)
    throw new Error(
      'Cannot inspect running clients; offline migration requires process inspection.'
    );
  for (const line of processes.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const words = match[2].split(/\s+/);
    const executable = path.basename(words[0]);
    if (!/^(?:node|nodejs|reasonbook|npx)$/.test(executable) && executable !== LEGACY.command)
      continue;
    const entry = words.find((part) =>
      /(?:^|\/)(?:dist\/(?:index|bin|cli)\.js|(?:server|hooks)\/(?:run|install-worker|installing-server|disabled-server)\.mjs)$/.test(
        part
      )
    );
    let relevant =
      executable === 'reasonbook' ||
      executable === LEGACY.command ||
      words.some(
        (word) =>
          path.basename(word) === LEGACY.command ||
          path.basename(word) === 'reasonbook' ||
          word.startsWith(LEGACY.packageName) ||
          word.startsWith('@aquex/reasonbook')
      );
    if (entry) {
      let directory = path.dirname(entry);
      let identified = false;
      for (let depth = 0; depth < 5 && path.isAbsolute(directory); depth++) {
        const manifest = read(path.join(directory, 'package.json'));
        if (manifest) {
          const pkg = JSON.parse(manifest) as { name?: string };
          relevant ||= pkg.name === LEGACY.packageName || pkg.name === '@aquex/reasonbook';
          identified = true;
          break;
        }
        const plugin = read(path.join(directory, '.claude-plugin/plugin.json'));
        if (plugin) {
          const name = (JSON.parse(plugin) as { name?: string }).name;
          relevant ||=
            name === 'reasonbook' ||
            name === 'reasonbook-chat' ||
            name === LEGACY.recordDirectory ||
            name === `${LEGACY.recordDirectory}-chat`;
          identified = true;
          break;
        }
        directory = path.dirname(directory);
      }
      // An unresolved supported entry point cannot prove that its cached path is safe.
      if (!identified) relevant = true;
    }
    if (relevant)
      throw new Error(
        `Process ${match[1]} is a live or unidentified record runtime. Exit that client before offline migration; no process was stopped.`
      );
  }
}

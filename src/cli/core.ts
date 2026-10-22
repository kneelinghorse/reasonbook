// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — what every CLI verb shares: I/O, flags, the hook output contract, project resolution,
// ABOUTME: the ambient switch and the fail-open log. Node built-ins and better-sqlite3 only; hooks load it.

import { getSetting, resolveRecordPaths } from '../intelligence/legacy-compat';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { oneLine } from '../utils/one-line';

export { oneLine };

import {
  findEnclosingStore,
  isContextlessDirectory,
  storeAt,
} from '../intelligence/resolution-policy';
import { runtimeDir } from '../tools/rbook/harness-session';
import { safeDestination } from '../tools/rbook/local-telemetry';
import { AMBIENT_METADATA_KEY } from '../tools/rbook/rules-files';
import { writeHookOutput } from './hook-output';
import { nativeHookInput, type HookFormat, type HookHarness } from './hook-adapters';

/** Where a verb reads and writes; the real process for the bin, a stub for tests. */
export interface CliIo {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /**
   * When the process started (ms since the epoch). A hook's deadline counts from here, so module
   * loading is inside the budget. A stub for tests leaves it out, and the clock starts at the call.
   */
  readonly startedAtMs?: number;
  /** The whole of stdin, or '' when there is none to read (a terminal). */
  readStdin(): Promise<string>;
  stdout(text: string): void;
  /** Actual bounded hook writes must finish before a runtime delivery receipt commits. */
  hookStdout?(text: string, deadlineAtMs: number): void;
  /** One line; the hook contract allows at most one per run. */
  stderr(line: string): void;
}

/** The process's own I/O. Stdin is read only when it is not a terminal. */
export function processIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    startedAtMs: performance.timeOrigin,
    readStdin: () =>
      new Promise<string>((resolve, reject) => {
        if (process.stdin.isTTY) {
          resolve('');
          return;
        }
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
      }),
    stdout: (text) => {
      process.stdout.write(text);
    },
    hookStdout: writeHookOutput,
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** `--name value` and `--name=value` flags, and the positional words before or between them. */
export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      flags[arg.slice(2)] = 'true';
    }
  }
  return { positional, flags };
}

/**
 * Cut injected text to a cap at a line boundary, saying where. Deterministic, so an unchanged
 * record injects the same bytes every time.
 */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = `\n[cut at ${cap} characters]`;
  const room = cap - marker.length;
  const window = text.slice(0, room);
  const lastBreak = window.lastIndexOf('\n');
  const cut = lastBreak > room * 0.5 ? window.slice(0, lastBreak) : window;
  return `${cut.trimEnd()}${marker}`;
}

/** The hook events the CLI answers, as the verb names them. */
export const HOOK_EVENTS = [
  'session-start',
  'prompt',
  'stop',
  'pre-compact',
  'session-end',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Claude Code's name for each event, as `hookSpecificOutput.hookEventName` carries it. */
export const CLAUDE_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
  stop: 'Stop',
  'pre-compact': 'PreCompact',
  'session-end': 'SessionEnd',
};

/**
 * Per-verb deadlines (design doc m01 fork 6). Past its deadline a verb prints nothing. The prompt
 * and stop budgets are why those verbs load only better-sqlite3 and their own module.
 */
export const HOOK_DEADLINES_MS: Readonly<Record<HookEvent, number>> = {
  'session-start': 3000,
  prompt: 800,
  stop: 500,
  'pre-compact': 1000,
  'session-end': 1000,
};

/** Caps on injected text (fork 5). Stop, PreCompact and SessionEnd never inject. */
export const HOOK_CAPS: Readonly<Partial<Record<HookEvent, number>>> = {
  'session-start': 6000,
  prompt: 1500,
};

/** The fields of a hook's stdin the verbs read. Anything else is ignored. */
export interface HookInput {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly source?: string;
  readonly reason?: string;
  readonly prompt?: string;
  readonly prompt_id?: string;
  /** Stop: the reply that just ended (observed in Claude Code 2.1.292, not documented). */
  readonly last_assistant_message?: string;
  readonly transcript_path?: string;
}

/** Thrown for stdin that is not a JSON object; the hook answers with one stderr line. */
export class HookInputError extends Error {}

export function parseHookInput(raw: string, harness: HookHarness = 'claude'): HookInput {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HookInputError('the hook input on stdin is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookInputError('the hook input on stdin is not a JSON object');
  }
  const record = nativeHookInput(parsed as Record<string, unknown>, harness);
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  return {
    session_id: text('session_id'),
    cwd: text('cwd'),
    source: text('source'),
    reason: text('reason'),
    prompt: text('prompt'),
    prompt_id: text('prompt_id'),
    last_assistant_message: text('last_assistant_message'),
    transcript_path: text('transcript_path'),
  };
}

/** Render a hook's injected text: Claude Code's JSON (the default) or the text alone. */
export function renderHookOutput(event: HookEvent, context: string, format: HookFormat): string {
  const capped = capText(context, HOOK_CAPS[event] ?? context.length);
  if (format === 'text') return `${capped}\n`;
  if (format === 'cursor') return `${JSON.stringify({ additional_context: capped })}\n`;
  if (format === 'copilot') return `${JSON.stringify({ additionalContext: capped })}\n`;
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: CLAUDE_EVENT_NAMES[event], additionalContext: capped },
  })}\n`;
}

/** Where a CLI call's project is: a store, a missing one, or none (and whether contextless). */
export type CliResolution =
  | {
      readonly kind: 'store';
      readonly projectRoot: string;
      readonly dbPath: string;
      readonly source: 'explicit' | 'cwd';
    }
  | { readonly kind: 'none'; readonly workingDir: string; readonly contextless: boolean }
  | { readonly kind: 'explicit-missing'; readonly dir: string }
  /**
   * A Reasonbook layout (`rbook/db/`) whose database file is gone. The MCP path refuses it by name (the
   * client's dbNotFound), so the CLI never treats it as a folder without Reasonbook: no init offer, which
   * would create an empty store where the real one is missing (the m01 build critic, B3).
   */
  | { readonly kind: 'store-missing'; readonly projectRoot: string; readonly dbPath: string };

/**
 * The CLI's resolution (fork 3): `--project-root` is explicit and final; otherwise the working
 * directory is CLAUDE_PROJECT_DIR, then the hook's stdin `cwd`, then the process's own, walked up
 * as the MCP path walks it (resolution-policy.ts). Never a registry default: a contextless call
 * resolves to nothing, and a hook stays silent.
 */
export function resolveCliProject(options: {
  readonly projectRootArg?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinCwd?: string;
  readonly cwd: string;
  readonly homeDir?: string;
}): CliResolution {
  const homeDir = options.homeDir ?? os.homedir();
  const withDb = (root: string): string => resolveRecordPaths(root).dbPath;
  if (options.projectRootArg) {
    const dir = path.resolve(options.projectRootArg);
    const store = storeAt(dir);
    if (!store) return { kind: 'explicit-missing', dir };
    return store.hasDatabase
      ? { kind: 'store', projectRoot: store.root, dbPath: withDb(store.root), source: 'explicit' }
      : { kind: 'store-missing', projectRoot: store.root, dbPath: withDb(store.root) };
  }
  const workingDir = path.resolve(
    options.env.CLAUDE_PROJECT_DIR || options.stdinCwd || options.cwd
  );
  const enclosing = findEnclosingStore(workingDir, { homeDir });
  if (enclosing) {
    return enclosing.hasDatabase
      ? {
          kind: 'store',
          projectRoot: enclosing.root,
          dbPath: withDb(enclosing.root),
          source: 'cwd',
        }
      : { kind: 'store-missing', projectRoot: enclosing.root, dbPath: withDb(enclosing.root) };
  }
  return {
    kind: 'none',
    workingDir,
    contextless: isContextlessDirectory(workingDir, { homeDir }),
  };
}

/** The folder a resolution is about: the project root, or the folder the walk started from. */
export function resolutionDir(resolution: CliResolution): string {
  switch (resolution.kind) {
    case 'store':
    case 'store-missing':
      return resolution.projectRoot;
    case 'none':
      return resolution.workingDir;
    case 'explicit-missing':
      return resolution.dir;
  }
}

/** A store a verb needed and could not use: missing, locked or unreadable. Hooks log it as `store`. */
export class CliStoreError extends Error {}

/**
 * The store a hook verb works on: the resolved one, null when the folder has no Reasonbook layout at all,
 * or a {@link CliStoreError} when the caller named a folder without one or the database is gone.
 */
export function hookStore(
  resolution: CliResolution
): Extract<CliResolution, { kind: 'store' }> | null {
  switch (resolution.kind) {
    case 'store':
      return resolution;
    case 'none':
      return null;
    case 'explicit-missing':
      throw new CliStoreError(`no Reasonbook project at ${resolution.dir}`);
    case 'store-missing':
      throw new CliStoreError(`the Reasonbook store is missing: ${resolution.dbPath}`);
  }
}

/**
 * Fail fast on a store another process holds: one read under the process busy timeout, before a
 * verb runs many statements that would each wait it out (a held store took 2 s of a 3 s budget and
 * reported nothing; the m01 build critic, B3). Throws {@link CliStoreError}.
 */
export function assertStoreReadable(dbPath: string, busyTimeoutMs: number): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliStoreError(
      /busy|locked/i.test(message)
        ? 'the Reasonbook store is locked by another process'
        : `the Reasonbook store cannot be read: ${message}`
    );
  } finally {
    db?.close();
  }
}

/** How present Reasonbook is in a project's sessions (#1183). */
export type AmbientMode = 'on' | 'off' | 'digest-off';
export const AMBIENT_MODES: readonly AmbientMode[] = ['on', 'off', 'digest-off'];
/** The metadata key the project's setting is stored under (rules-files.ts, which init reads too). */
export { AMBIENT_METADATA_KEY };

function asAmbient(value: string | undefined | null): AmbientMode | null {
  const v = value?.trim().toLowerCase();
  return v === 'on' || v === 'off' || v === 'digest-off' ? v : null;
}

/**
 * The ambient mode for a store: RBOOK_AMBIENT for this session, else the project's stored setting,
 * else on. Read-only; a store that cannot be read counts as on.
 */
export function readAmbient(dbPath: string, env: NodeJS.ProcessEnv): AmbientMode {
  const fromEnv = asAmbient(getSetting('RBOOK_AMBIENT', env));
  if (fromEnv) return fromEnv;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 200');
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(AMBIENT_METADATA_KEY) as
      | { value: string }
      | undefined;
    return asAmbient(row?.value) ?? 'on';
  } catch {
    return 'on';
  } finally {
    db?.close();
  }
}

/** At most this many bytes of fail-open records are kept; older ones are dropped. */
const FAIL_OPEN_LOG_BYTES = 64 * 1024;

/**
 * Record that a hook verb answered with nothing because it ran out of time or failed. Causes
 * only: never a prompt, a path or record content. s93-m04 folds this into the telemetry file.
 * Best effort; never throws.
 */
export function recordFailOpen(env: NodeJS.ProcessEnv, verb: string, cause: string): void {
  let fd: number | undefined;
  try {
    const file = path.join(runtimeDir(env), 'fail-open.jsonl');
    if (!safeDestination(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!safeDestination(file)) return;
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    if (stat.size > FAIL_OPEN_LOG_BYTES) fs.ftruncateSync(fd, 0);
    fs.writeSync(
      fd,
      `${JSON.stringify({ ts: new Date().toISOString(), verb, cause: oneLine(cause, 120) })}\n`
    );
  } catch {
    // A log that cannot be written must not turn a silent hook into a failing one.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Best-effort log. */
      }
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — the reasonbook CLI: hook verbs for harness hooks, and the read and write verbs adapters
// ABOUTME: and people call. Each verb loads only its own module; hooks exit 0 and print nothing past deadline.

import { getSetting } from './intelligence/legacy-compat';
import {
  CliStoreError,
  capText,
  HOOK_CAPS,
  HOOK_DEADLINES_MS,
  HOOK_EVENTS,
  HookInputError,
  oneLine,
  parseArgs,
  parseHookInput,
  processIo,
  readAmbient,
  recordFailOpen,
  renderHookOutput,
  resolveCliProject,
  type AmbientMode,
  type CliIo,
  type CliResolution,
  type HookEvent,
  type HookInput,
} from './cli/core';
import { processBusyTimeout, setProcessBusyTimeout } from './tools/rbook/sqlite-busy';
import { CliTelemetry, observeRenderedContext } from './cli/telemetry';
import { harnessProcessEpoch } from './cli/harness-epoch';
import {
  beginHookReceipt,
  electHookSource,
  hookRuntimeIdentity,
  type HookReceipt,
} from './cli/hook-runtime';
import type { RenderedContext } from './tools/rbook/rendered-context';
import { hookFormat, hookHarness, type HookHarness } from './cli/hook-adapters';
import { captureToolCall, unwrapCapturedToolCallError } from './tools/rbook/tool-call-context';

/**
 * THE CONTRACT (design doc s93-m01, forks 5 and 6):
 * - A hook verb exits 0, always, and writes at most one stderr line: whatever else writes to stderr
 *   while it runs (a library's own log line) is held back and only the first line is kept. Past its
 *   deadline, counted from process start, it prints nothing and records a fail-open. A locked
 *   store, a missing one and bad JSON on stdin each record one too, with one stderr line.
 * - `--format claude` (the hook default) prints Claude Code's hook JSON with
 *   `hookSpecificOutput.additionalContext`; `--format text` prints the text alone.
 * - Stop, PreCompact and SessionEnd never print: Claude Code charges a turn for Stop output and
 *   discards SessionEnd's.
 * - Hook verbs never run reconcile or the first-write upkeep; those belong to the MCP server.
 * - With the project's ambient switch off (or RBOOK_AMBIENT=off), every hook verb exits silently.
 */

/** What a hook verb is handed. */
export interface HookVerbContext {
  readonly event: HookEvent;
  readonly input: HookInput;
  readonly io: CliIo;
  readonly resolution: CliResolution;
  /** The project's ambient mode; null when the call resolved no store. */
  readonly ambient: AmbientMode | null;
  readonly harness?: HookHarness;
  readonly deadlineAtMs?: number;
}

/** A prepared delivery keeps its runtime transaction across stdout and awaits any final commit. */
export interface HookDelivery {
  deliver(emit: (context: RenderedContext | string) => string): void | Promise<void>;
}

/** A hook verb: the text to inject, or null for none. */
export interface HookVerb {
  run(ctx: HookVerbContext): Promise<string | HookDelivery | null>;
}

/** Each hook verb's module, loaded only when that verb runs. */
const HOOK_VERBS: Readonly<Record<HookEvent, () => Promise<HookVerb>>> = {
  'session-start': () => import('./cli/session-start'),
  prompt: () => import('./cli/prompt'),
  stop: () => import('./cli/stop'),
  'pre-compact': () => import('./cli/pre-compact'),
  'session-end': () => import('./cli/session-end'),
};

/** The events whose output Claude Code would charge for or discard: they never print. */
const SILENT_EVENTS: ReadonlySet<HookEvent> = new Set(['stop', 'pre-compact', 'session-end']);

const EXPIRED = Symbol('expired');
const SUPPRESSED = Symbol('suppressed');

/**
 * How long a hook's SQLite statement waits on another writer. The wait is synchronous, so the
 * deadline timer cannot interrupt it; a short wait keeps a held store inside the budget.
 */
export const HOOK_BUSY_TIMEOUT_MS = 250;

/** Hold every stderr write made while `run` is pending; returns the lines it held. */
function holdStderr(): { release(): string[] } {
  const held: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    held.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
    callback?.();
    return true;
  }) as typeof process.stderr.write;
  return {
    release: () => {
      process.stderr.write = original;
      return held
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '');
    },
  };
}

/**
 * Run one hook verb under its deadline. Exits 0 in every case; at most one stderr line.
 */
export async function runHook(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if (flags.harness && flags.harness !== 'claude') {
    // Also isolate rejected native events: their failure telemetry must not route to
    // a parent Claude process's project or mutate its session link.
    const env = { ...io.env };
    delete env.CLAUDE_PID;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PROJECT_DIR;
    io = { ...io, env };
  }
  const event = positional[0] as HookEvent | undefined;
  let telemetry: CliTelemetry | undefined;
  const delivery: { receipt: HookReceipt | null } = { receipt: null };
  let suppressed = false;
  let finished = false;
  if (!event || !(HOOK_EVENTS as readonly string[]).includes(event)) {
    // A mistyped event is a configuration error, not a hook run: exit 1 says so (never 2, which
    // would block a prompt), where 0 would hide it.
    io.stderr(`reasonbook hook: name an event: ${HOOK_EVENTS.join(', ')}.`);
    new CliTelemetry(io, event ?? 'unknown', argv, true).finish(1);
    return 1;
  }
  const deadline = HOOK_DEADLINES_MS[event];
  const started = io.startedAtMs ?? Date.now();
  const previousBusyTimeout = processBusyTimeout();
  setProcessBusyTimeout(HOOK_BUSY_TIMEOUT_MS);
  const stderr = holdStderr();
  let ownLine: string | null = null;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, deadline - (Date.now() - started)));
  });
  const work = (async (): Promise<string | HookDelivery | null | typeof SUPPRESSED> => {
    const harness = hookHarness(flags.harness, event);
    const parsed = parseHookInput(await io.readStdin(), harness);
    const projectDir =
      harness === 'cursor'
        ? io.env.CURSOR_PROJECT_DIR
        : harness === 'devin'
          ? io.env.DEVIN_PROJECT_DIR
          : undefined;
    const input = { ...parsed, cwd: parsed.cwd ?? projectDir };
    if (finished || Date.now() >= started + deadline) throw new Error('hook deadline exceeded');
    const key = hookRuntimeIdentity(input, io.env);
    const epoch = flags['hook-source'] ? harnessProcessEpoch(io.env, started + deadline) : null;
    if (Date.now() >= started + deadline) throw new Error('hook deadline exceeded');
    if (!electHookSource(key, flags['hook-source'], epoch, io.env)) {
      suppressed = true;
      return SUPPRESSED;
    }
    delivery.receipt = beginHookReceipt(key, event, input.prompt_id, io.env);
    if (delivery.receipt?.duplicate) {
      suppressed = true;
      return SUPPRESSED;
    }
    // Election and committed turn receipts precede every telemetry, verb and output effect.
    telemetry = new CliTelemetry(io, event, argv, true);
    const resolution = resolveCliProject({
      projectRootArg: flags['project-root'],
      env: io.env,
      stdinCwd: input.cwd,
      cwd: io.cwd,
    });
    telemetry.resolve(resolution);
    if (telemetry.prompt(input))
      ownLine = 'reasonbook hook prompt: rules in force could not be read for telemetry.';
    let ambient: AmbientMode | null = null;
    if (resolution.kind === 'store') {
      ambient = readAmbient(resolution.dbPath, io.env);
      telemetry.patch({ ambient });
      if (ambient === 'off') return null;
    } else if ((getSetting('RBOOK_AMBIENT', io.env) ?? '').trim().toLowerCase() === 'off') {
      telemetry.patch({ ambient: 'off' });
      return null;
    }
    const verb = await HOOK_VERBS[event]();
    if (finished || Date.now() >= started + deadline) throw new Error('hook deadline exceeded');
    const ctx = {
      event,
      input,
      io,
      resolution,
      ambient,
      harness,
      deadlineAtMs: started + deadline,
    };
    return event === 'session-start' || event === 'prompt'
      ? (await captureToolCall('read', () => verb.run(ctx))).value
      : verb.run(ctx);
  })();
  // Work abandoned at the deadline may still be running: it keeps the short busy timeout until
  // it settles (the bin exits first anyway).
  const restore = (): void => setProcessBusyTimeout(previousBusyTimeout);
  work.then(restore, restore);

  try {
    const result = await Promise.race([work, expired]);
    if (result === SUPPRESSED) return 0;
    // Synchronous work can finish past the deadline before the timer gets to run: the clock, not
    // the race, decides.
    if (result === EXPIRED || Date.now() - started > deadline) {
      recordFailOpen(io.env, `hook ${event}`, 'deadline');
      telemetry ??= new CliTelemetry(io, event, argv, true);
      telemetry.patch({ failOpen: 'deadline' });
      return 0;
    }
    if (result && !SILENT_EVENTS.has(event)) {
      const emit = (text: string): string => {
        if (Date.now() >= started + deadline) throw new Error('hook delivery deadline exceeded');
        const capped = capText(text, HOOK_CAPS[event] ?? text.length);
        const output = renderHookOutput(
          event,
          capped,
          hookFormat(hookHarness(flags.harness, event), flags.format === 'text')
        );
        if (io.hookStdout) io.hookStdout(output, started + deadline);
        else io.stdout(output);
        telemetry?.injected(capped);
        return capped;
      };
      if (typeof result === 'string') emit(result);
      else
        await captureToolCall('read', async () =>
          result.deliver((context) => {
            if (typeof context === 'string') return emit(context);
            observeRenderedContext(io, context);
            return emit(context.text);
          })
        );
    }
    delivery.receipt?.commit();
  } catch (caught) {
    const error = unwrapCapturedToolCallError(caught);
    const reason = error instanceof Error ? error.message : String(error);
    const failOpen =
      Date.now() >= started + deadline
        ? 'deadline'
        : error instanceof HookInputError
          ? 'input'
          : error instanceof CliStoreError
            ? 'store'
            : 'error';
    recordFailOpen(io.env, `hook ${event}`, failOpen);
    telemetry ??= new CliTelemetry(io, event, argv, true);
    telemetry.patch({ failOpen });
    ownLine = oneLine(`reasonbook hook ${event}: ${reason}`);
  } finally {
    finished = true;
    clearTimeout(timer);
    delivery.receipt?.rollback();
    telemetry?.finish(0);
    const stray = stderr.release();
    const line =
      ownLine ?? (stray.length > 0 ? oneLine(`reasonbook hook ${event}: ${stray[0]}`) : null);
    if (line && !suppressed) io.stderr(line);
  }
  return 0;
}

/**
 * Run a CLI command line (everything after `reasonbook`). Returns the exit code. An unknown verb is a
 * usage error with exit 1, never 2: a mistyped hook command lands here, and Claude Code treats exit
 * 2 from a UserPromptSubmit hook as blocking the prompt.
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  const [verb, ...rest] = argv;
  const { USAGE, firstUnknownOption } = await import('./cli/usage');
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(USAGE);
    return 0;
  }
  const unknown = firstUnknownOption(verb ?? '', rest);
  if (unknown) {
    io.stderr(
      `reasonbook ${oneLine(verb ?? '')}: unknown option ${oneLine(unknown)}. Use reasonbook ${oneLine(verb ?? '')} --help for usage.`
    );
    return 1;
  }
  if (verb === 'hook') return runHook(rest, io);
  if (verb === 'migrate') return (await import('./cli/migrate')).runMigrate(rest, io);
  if (verb === 'spin-out') return (await import('./cli/spin-out')).runSpinOut(rest, io);
  const telemetry = new CliTelemetry(io, verb ?? 'unknown', rest);
  let code = 1;
  try {
    code = await dispatchCli(verb, rest, io);
    if (verb === 'init' && code === 0) {
      telemetry.resolve(
        resolveCliProject({
          projectRootArg: parseArgs(rest).flags['project-root'] ?? io.cwd,
          env: io.env,
          cwd: io.cwd,
        })
      );
    }
    return code;
  } catch (error) {
    telemetry.patch({ refused: 'CLI_ERROR' });
    throw error;
  } finally {
    telemetry.finish(code);
  }
}

async function dispatchCli(
  verb: string | undefined,
  rest: readonly string[],
  io: CliIo
): Promise<number> {
  switch (verb) {
    case 'feedback':
      return (await import('./cli/feedback')).runFeedback(rest, io);
    case 'stats':
      return (await import('./cli/stats')).runStats(rest, io);
    case 'config':
      return (await import('./cli/config')).runConfig(rest, io);
    case 'repair':
      return (await import('./cli/repair')).runRepair(rest, io);
    case 'sync':
      return (await import('./cli/sync')).runSync(rest, io);
    case 'join':
      return (await import('./cli/sync')).runJoin(rest, io);
    case 'copy':
      return (await import('./cli/sync')).runCopy(rest, io);
    case 'handover':
      return (await import('./cli/sync-moves')).runHandover(rest, io);
    case 'recover':
      return (await import('./cli/sync-moves')).runRecover(rest, io);
    case 'share':
      return (await import('./cli/dashboard')).runShare(rest, io);
    case 'move':
      return (await import('./cli/dashboard')).runMove(rest, io);
    case 'import':
      return (await import('./cli/import')).runImport(rest, io);
    case 'drafts':
      return (await import('./cli/drafts')).runDrafts(rest, io);
    case 'signals':
      return (await import('./cli/signals')).runSignals(rest, io);
    case 'brief':
      return (await import('./cli/brief')).runBrief(rest, io);
    case 'review':
    case 'relevant':
    case 'decisions':
    case 'capture':
    case 'session':
    case 'ambient':
    case 'init':
    case 'profile':
      return (await import('./cli/commands')).runCommand(verb, rest, io);
    default:
      if (verb !== undefined) io.stderr(`reasonbook: unknown verb "${verb}".`);
      io.stderr((await import('./cli/usage')).USAGE.trimEnd());
      return 1;
  }
}

/**
 * The bin's entry for a CLI verb: run it, let stdout drain, and exit with its code even if a
 * deadline left work behind (a hook never outlives its budget by waiting on it).
 */
export function main(argv: readonly string[]): void {
  void runCli(argv)
    .catch((error: unknown) => {
      process.stderr.write(
        `${oneLine(`reasonbook: ${error instanceof Error ? error.message : String(error)}`)}\n`
      );
      return argv[0] === 'hook' ? 0 : 1;
    })
    .then((code) => {
      process.stdout.write('', () => process.exit(code));
    });
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s105 — scratch-package options: a record of every MCP observation and a per-client pause point
// ABOUTME: before the identity lookup. Fixed at transpile time; shipped modules never carry them.
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { targetForStore, type TelemetryTarget } from '../../src/tools/rbook/local-telemetry';

/**
 * Fixed when the scratch package is transpiled, so its children need no new environment. With none
 * set, the package is P57's byte for byte (telemetry-observation.test.ts proves it).
 */
export interface TelemetryInstrumentation {
  /** Absolute directory receiving one JSON line per MCP observation, in `<pid>.jsonl`. */
  readonly records?: string;
  /** Honor the pause point that a file in the fixture's config directory arms for one client. */
  readonly pause?: boolean;
  /** How long an armed client waits for its release before going on (default 30 s). */
  readonly pauseCapMs?: number;
}

/** The decision table's busy code: SQLITE_BUSY, or any code beginning SQLITE_BUSY_. */
export function isBusyCode(code: unknown): boolean {
  return typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'));
}

const describeCode = `
function s105Code(error: unknown): { code: string | null; name: string | null } {
  const value = error as { code?: unknown; name?: unknown } | null;
  return {
    code: typeof value?.code === 'string' ? value.code : null,
    name: typeof value?.name === 'string' ? value.name : null,
  };
}
`;

const localInstruments = `
// s105 scratch instruments; never in shipped modules.
let s105LookupError: unknown = null;
let s105Append: Record<string, unknown> | null = null;
${describeCode}
function s105Noted(phase: string, error: unknown, extra: object): void {
  if (s105Append && phase !== 'targetForStore')
    Object.assign(s105Append, { outcome: phase }, s105Code(error), extra);
}
/** The observation's identity lookup, exactly as the call site makes it, with its outcome and time. */
export function s105IdentityLookup(dbPath: string, budgetMs: number) {
  s105LookupError = null;
  const started = performance.now();
  const target = targetForStore(dbPath, budgetMs);
  const lookup = {
    outcome: target ? 'ok' : 'failed',
    ...s105Code(s105LookupError),
    elapsedMs: performance.now() - started,
    projectId: target ? target.projectId : null,
    budgetMs,
  };
  return { target, lookup };
}
export function s105AppendBegin(): void {
  s105Append = { outcome: 'not-attempted' };
}
export function s105AppendTake(): Record<string, unknown> | null {
  const taken = s105Append;
  s105Append = null;
  return taken;
}
`;

const callInstruments = (records: string, pause: boolean, capMs: number) => `
// s105 scratch instruments; never in shipped modules.
const S105_RECORDS = ${JSON.stringify(records)};
const S105_PAUSE = ${pause};
const S105_PAUSE_CAP_MS = ${capMs};
let s105Sequence = 0;
${describeCode}
function s105Telemetry(): any {
  return require('./local-telemetry');
}
// Called outside the finally's own try, so it must not throw: a throw there replaces the result.
function s105Open(client: string | null, callStartedAt: string): Record<string, any> {
  try {
    s105Sequence += 1;
    return {
      pid: process.pid,
      sequence: s105Sequence,
      client,
      callStartedAt,
      observationStartedAt: new Date().toISOString(),
      lookup: { outcome: 'skipped' },
      observation: { outcome: 'completed' },
    };
  } catch {
    return { client, recordFault: 'open' };
  }
}
function s105Pause(record: Record<string, any>): void {
  if (!S105_PAUSE || typeof record.client !== 'string') return;
  const fs = require('fs');
  const base = path.join(record.config, 's105-pause', encodeURIComponent(record.client));
  try {
    fs.renameSync(base + '.arm', base + '.paused');
  } catch {
    return; // Not armed for this client; an arm pauses one observation only.
  }
  const started = Date.now();
  let released = fs.existsSync(base + '.release');
  while (!released && Date.now() - started < S105_PAUSE_CAP_MS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    released = fs.existsSync(base + '.release');
  }
  record.pause = { released, markerAt: new Date().toISOString() };
  // Immediately before the lookup, so a holder can time the rest of its hold from here.
  fs.writeFileSync(base + '.marker', String(process.pid));
}
function s105Lookup(record: Record<string, any>, dbPath: string, budgetMs: number): TelemetryTarget | null {
  s105Pause(record);
  const found = s105Telemetry().s105IdentityLookup(dbPath, budgetMs);
  record.lookup = found.lookup;
  return found.target;
}
function s105Write(record: Record<string, any>): void {
  try {
    const fs = require('fs');
    record.observationEndedAt = new Date().toISOString();
    fs.mkdirSync(S105_RECORDS, { recursive: true });
    fs.appendFileSync(path.join(S105_RECORDS, process.pid + '.jsonl'), JSON.stringify(record) + '\\n');
  } catch (error) {
    telemetryDiagnostic('s105-record', error, record.client);
  }
}
`;

function replaceOnce(relative: string, source: string, before: string, after: string): string {
  const found = source.split(before).length - 1;
  if (found !== 1)
    throw new Error(
      `Telemetry instrumentation drift in ${relative}: expected 1, found ${found}: ${before}`
    );
  return source.split(before).join(after);
}

/** Apply the options to P57's instrumented output; without options it is returned unchanged. */
export function instrumentObservation(
  relative: string,
  source: string,
  options: TelemetryInstrumentation
): string {
  // s105-m03 retired arm B with the repair it stood for; a stale caller must fail, not run arm A twice.
  if ('armB' in options)
    throw new Error('Arm B is retired: since s105-m03 the committed lookup carries the candidate');
  const { records, pause = false, pauseCapMs = 30_000 } = options;
  if (records === undefined && !pause) return source;
  if (records === undefined || !path.isAbsolute(records))
    throw new Error('Observation instruments need an absolute records directory');
  if (!Number.isInteger(pauseCapMs) || pauseCapMs < 0)
    throw new Error('pauseCapMs must be a non-negative integer');
  const replace = (before: string, after: string): void => {
    source = replaceOnce(relative, source, before, after);
  };
  if (relative.endsWith('/local-telemetry.ts')) {
    replace(
      "  } catch (diagnosticError) {\n    telemetryDiagnostic('targetForStore', diagnosticError);\n    return null;",
      "  } catch (diagnosticError) {\n    s105LookupError = diagnosticError;\n    telemetryDiagnostic('targetForStore', diagnosticError);\n    return null;"
    );
    replace(
      '    const diagnosticWritten = fs.writeSync(fd, diagnosticLine);\n',
      "    const diagnosticWritten = fs.writeSync(fd, diagnosticLine);\n    if (s105Append) Object.assign(s105Append, { outcome: 'written', bytes: diagnosticWritten, expectedBytes: Buffer.byteLength(diagnosticLine) });\n"
    );
    replace(
      'extra: object = {}): void {\n  try {',
      'extra: object = {}): void {\n  s105Noted(phase, error, extra);\n  try {'
    );
    return source + localInstruments;
  }
  replace(
    '    } finally {\n      try {\n        const params =',
    '    } finally {\n      const s105Record = s105Open(observation.client, ts);\n      try {\n        const params ='
  );
  replace(
    '        const target: TelemetryTarget = (root\n          ? targetForStore(resolveRecordPaths(root).dbPath, processBusyTimeout() ?? 5000)\n',
    '        s105Record.root = root ?? null;\n        s105Record.config = rbookConfigDir(env);\n        const target: TelemetryTarget = (root\n          ? s105Lookup(s105Record, resolveRecordPaths(root).dbPath, processBusyTimeout() ?? 5000)\n'
  );
  replace(
    '        } catch {\n          // The row is still recorded; only who made the call is unknown.\n',
    "        } catch (ownerError) {\n          s105Record.ownerLookup = { outcome: 'threw', ...s105Code(ownerError) };\n          // The row is still recorded; only who made the call is unknown.\n"
  );
  replace(
    '        const payload = result?.structuredContent;\n',
    '        s105Record.bucket = { projectId: target.projectId, key: s105Telemetry().telemetryKey(target) };\n        const payload = result?.structuredContent;\n'
  );
  replace(
    '        const error = structured?.error as { code?: string } | undefined;\n',
    '        const error = structured?.error as { code?: string } | undefined;\n        s105Record.ok = ok;\n        s105Telemetry().s105AppendBegin();\n'
  );
  replace(
    "          env\n        );\n      } catch (diagnosticError) {\n        telemetryDiagnostic('telemetry-call', diagnosticError, observation.client);\n        // Best-effort instrumentation must never break an otherwise valid call.\n      }\n",
    "          env\n        );\n        s105Record.append = s105Telemetry().s105AppendTake();\n      } catch (diagnosticError) {\n        s105Record.observation = { outcome: 'threw', ...s105Code(diagnosticError) };\n        s105Record.append = s105Telemetry().s105AppendTake() ?? { outcome: 'not-attempted' };\n        telemetryDiagnostic('telemetry-call', diagnosticError, observation.client);\n        // Best-effort instrumentation must never break an otherwise valid call.\n      }\n      s105Write(s105Record);\n"
  );
  return source + callInstruments(records, pause, pauseCapMs);
}

/** Every observation record under `dir`, in pid file then write order. */
export function readObservationRecords(dir: string): Array<Record<string, any>> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>)
    );
}

export interface PauseFiles {
  readonly arm: string;
  readonly paused: string;
  readonly release: string;
  readonly marker: string;
}

/** The pause point's files for one client: arm, paused (the arm, consumed), release and marker. */
export function pauseFiles(config: string, client: string): PauseFiles {
  const base = path.join(config, 's105-pause', encodeURIComponent(client));
  return {
    arm: `${base}.arm`,
    paused: `${base}.paused`,
    release: `${base}.release`,
    marker: `${base}.marker`,
  };
}

/** Arm the pause for the next observation by `client` in this fixture. */
export function armPause(config: string, client: string): PauseFiles {
  const files = pauseFiles(config, client);
  fs.mkdirSync(path.dirname(files.arm), { recursive: true });
  fs.writeFileSync(files.arm, '');
  return files;
}

export function releasePause(files: PauseFiles): void {
  fs.writeFileSync(files.release, '');
}

/** Wait for a file to appear, at most `capMs`; resolves whether it did. */
export async function waitForFile(file: string, capMs = 30_000): Promise<boolean> {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started >= capMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/** Leaf 9: the test-side reader's own identity lookup at the default 100 ms budget, as m02's campaign read. */
export function timedTargetForStore(dbPath: string): {
  readonly target: TelemetryTarget | null;
  readonly reader: { readonly outcome: 'ok' | 'failed'; readonly elapsedMs: number };
} {
  const started = performance.now();
  const target = targetForStore(dbPath);
  return {
    target,
    reader: { outcome: target ? 'ok' : 'failed', elapsedMs: performance.now() - started },
  };
}

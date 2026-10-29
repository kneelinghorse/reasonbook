// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retains failure evidence and instruments only scratch-transpiled telemetry modules.
// ABOUTME: Leaves production code, caller outcomes and successful fixture cleanup unchanged.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { ChildProcess } from 'child_process';
import { readTelemetryReport, targetForStore } from '../../src/tools/rbook/local-telemetry';
import {
  instrumentObservation,
  type TelemetryInstrumentation,
} from './telemetry-observation-records';

const diagnostic = `
function telemetryDiagnostic(phase: string, error: unknown, client: unknown = null, extra: object = {}): void {
  try {
    const value = error as { code?: unknown; name?: unknown } | null;
    process.stderr.write('TELEMETRY_DIAGNOSTIC ' + JSON.stringify({
      phase, pid: process.pid,
      code: typeof value?.code === 'string' ? value.code : null,
      name: typeof value?.name === 'string' ? value.name : null,
      client: typeof client === 'string' ? client : null, ...extra,
    }) + '\\n');
  } catch { /* Diagnostic output cannot change the observed operation. */ }
}
`;

/** Exact counted replacements fail loudly if the production boundaries change. */
export function instrumentTelemetrySource(
  relative: string,
  source: string,
  options: TelemetryInstrumentation = {}
): string {
  const normalized = relative.replace(/\\/g, '/');
  if (!['tools/rbook/local-telemetry.ts', 'tools/rbook/telemetry-call.ts'].includes(normalized))
    return source;
  const replace = (before: string, after: string, count = 1): void => {
    const found = source.split(before).length - 1;
    if (found !== count)
      throw new Error(
        `Telemetry instrumentation drift in ${relative}: expected ${count}, found ${found}: ${before}`
      );
    source = source.split(before).join(after);
  };
  if (normalized.endsWith('/telemetry-call.ts')) {
    replace(
      '      } catch {\n        // Best-effort instrumentation must never break an otherwise valid call.',
      "      } catch (diagnosticError) {\n        telemetryDiagnostic('telemetry-call', diagnosticError, observation.client);\n        // Best-effort instrumentation must never break an otherwise valid call."
    );
  } else {
    replace(
      '  } catch {\n    return null;\n  } finally {',
      "  } catch (diagnosticError) {\n    telemetryDiagnostic('targetForStore', diagnosticError);\n    return null;\n  } finally {"
    );
    replace(
      '  let fd: number | undefined;\n  try {\n    const safe = serializable(record);',
      "  let fd: number | undefined;\n  let diagnosticPhase = 'append-prepare';\n  try {\n    const safe = serializable(record);"
    );
    replace(
      '    if (!safe) return;',
      "    if (!safe) { telemetryDiagnostic('serialization', null, record?.client); return; }"
    );
    replace(
      '    if (!safeDestination(dir, target)) return;\n    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });\n    if (!safeDestination(dir, target)) return;',
      "    if (!safeDestination(dir, target)) { telemetryDiagnostic('safeDestination-before', null, record.client); return; }\n    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });\n    if (!safeDestination(dir, target)) { telemetryDiagnostic('safeDestination-after', null, record.client); return; }"
    );
    replace(
      '    fd = fs.openSync(\n',
      "    diagnosticPhase = 'append-open';\n    fd = fs.openSync(\n"
    );
    replace(
      '    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) return;',
      "    diagnosticPhase = 'append-file';\n    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) { telemetryDiagnostic('file-rejection', null, record.client); return; }"
    );
    replace(
      '    fs.writeSync(fd, `${JSON.stringify(safe)}\\n`);\n    enforceRetention(dir);',
      "    diagnosticPhase = 'append-write';\n    const diagnosticLine = `${JSON.stringify(safe)}\\n`;\n    const diagnosticWritten = fs.writeSync(fd, diagnosticLine);\n    if (diagnosticWritten !== Buffer.byteLength(diagnosticLine)) telemetryDiagnostic('append-short-write', null, record.client, { writtenBytes: diagnosticWritten, expectedBytes: Buffer.byteLength(diagnosticLine) });\n    diagnosticPhase = 'append-retention';\n    enforceRetention(dir);"
    );
    replace(
      '  } catch {\n    // Telemetry never fails the call that writes it.',
      '  } catch (diagnosticError) {\n    telemetryDiagnostic(diagnosticPhase, diagnosticError, record?.client);\n    // Telemetry never fails the call that writes it.'
    );
  }
  return instrumentObservation(normalized, source + diagnostic, options);
}

/**
 * s105-m01: the scratch package tests/server-dual-era.test.ts builds in beforeAll, with options, so a
 * research run's children are that test's children. Returns the server's path.
 */
export function writeScratchPackage(
  repo: string,
  output: string,
  options: TelemetryInstrumentation = {}
): string {
  const compile = (relative: string): void => {
    const source = path.join(repo, 'src', relative);
    if (fs.statSync(source).isDirectory()) {
      for (const name of fs.readdirSync(source)) compile(path.join(relative, name));
    } else if (source.endsWith('.ts') && !source.endsWith('.d.ts')) {
      const target = path.join(output, 'dist', relative.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        ts.transpileModule(
          instrumentTelemetrySource(relative, fs.readFileSync(source, 'utf8'), options),
          {
            fileName: source,
            compilerOptions: {
              target: ts.ScriptTarget.ES2020,
              module: ts.ModuleKind.CommonJS,
              esModuleInterop: true,
            },
          }
        ).outputText
      );
    }
  };
  fs.mkdirSync(output, { recursive: true });
  compile('');
  for (const name of ['node_modules', 'rbook-seed', 'plugins']) {
    fs.symlinkSync(path.join(repo, name), path.join(output, name), 'dir');
  }
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(output, 'package.json'));
  return path.join(output, 'dist', 'index.js');
}

interface OwnedChild {
  readonly child: { pid?: number };
  readonly stderr: string;
  close: () => Promise<unknown>;
}
interface EvidenceDetails {
  readonly fixtureRoot: string;
  readonly config: string;
  readonly dbPath: string;
  readonly responses: unknown;
  readonly children: OwnedChild[];
  retain: () => void;
}
function describe(error: unknown): { name: string | null; code: string | null; message: string } {
  const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  return {
    name: typeof value?.name === 'string' ? value.name : null,
    code: typeof value?.code === 'string' ? value.code : null,
    message: typeof value?.message === 'string' ? value.message : String(error),
  };
}

/** Collect all raw buckets; links and multiply linked files are evidence, never read targets. */
function rawTelemetry(config: string): object {
  const entries: Array<Record<string, unknown>> = [];
  const root = path.join(config, 'telemetry');
  const visit = (file: string, relative: string): void => {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'symlink' });
        return;
      }
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        for (const name of fs.readdirSync(file).sort())
          visit(path.join(file, name), path.join(relative, name));
      } else if (file.endsWith('.jsonl')) {
        let fd: number | undefined;
        try {
          fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.nlink !== 1)
            throw new Error('Not a singly linked regular file');
          entries.push({ path: relative, kind: 'file', raw: fs.readFileSync(fd, 'utf8') });
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    } catch (error) {
      entries.push({ path: relative, kind: 'error', error: describe(error) });
    }
  };
  try {
    if (fs.lstatSync(config).isSymbolicLink())
      return { entries: [{ path: '.', kind: 'symlink', location: 'config' }] };
  } catch (error) {
    return { entries, error: describe(error) };
  }
  visit(root, '.');
  return { entries };
}

/** Observe stdio close as well as exit, without changing the fixture's owned-child shutdown. */
async function closeOwned(owned: OwnedChild): Promise<unknown[]> {
  const errors: unknown[] = [];
  const child = owned.child as ChildProcess;
  let timer: NodeJS.Timeout | undefined;
  let listener: (() => void) | undefined;
  const streamsClosed = child.stdout?.closed && child.stderr?.closed;
  const drained =
    typeof child.once === 'function' && !streamsClosed
      ? new Promise<void>((resolve) => {
          listener = resolve;
          child.once('close', listener);
          timer = setTimeout(() => {
            errors.push(
              describe(new Error('Owned child stdio close was not observed within 7 seconds'))
            );
            resolve();
          }, 7000);
        })
      : Promise.resolve();
  try {
    try {
      await owned.close();
    } catch (error) {
      errors.push(describe(error));
    }
    await drained;
  } finally {
    if (timer) clearTimeout(timer);
    if (listener) child.removeListener('close', listener);
  }
  return errors;
}

/** A failed assertion remains the failure even if retaining its diagnostic receipt also fails. */
export async function withTelemetryFailureEvidence<T>(
  operation: () => Promise<T>,
  details: EvidenceDetails
): Promise<T> {
  try {
    return await operation();
  } catch (original) {
    const captureErrors: unknown[] = [];
    const capture = <V>(phase: string, action: () => V): V | null => {
      try {
        return action();
      } catch (error) {
        captureErrors.push({ phase, ...describe(error) });
        return null;
      }
    };
    capture('retain', details.retain);
    const cleanup = await Promise.allSettled(details.children.map(closeOwned));
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [describe(result.reason)]
    );
    const env = { RBOOK_CONFIG_DIR: details.config };
    const projectTarget = capture('targetForStore', () => targetForStore(details.dbPath));
    const receipt = {
      fixtureRoot: details.fixtureRoot,
      config: details.config,
      dbPath: details.dbPath,
      assertion: describe(original),
      responses: details.responses,
      children: details.children.map((owned) => ({
        pid: owned.child.pid ?? null,
        stderr: owned.stderr,
      })),
      cleanupErrors,
      projectTarget,
      projectReport:
        projectTarget === null
          ? null
          : capture('projectReport', () => readTelemetryReport(projectTarget, env)),
      unattributedReport: capture('unattributedReport', () =>
        readTelemetryReport(
          {
            projectId: 'unattributed',
            dbPath: path.join(details.config, 'unattributed.sqlite'),
          },
          env
        )
      ),
      raw: capture('raw', () => rawTelemetry(details.config)),
      captureErrors,
    };
    const file = path.join(details.fixtureRoot, 'telemetry-failure.json');
    capture('writeReceipt', () => fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`));
    capture('logReceipt', () =>
      console.error(`Telemetry failure evidence: ${file}\n${JSON.stringify(receipt, null, 2)}`)
    );
    throw original;
  }
}

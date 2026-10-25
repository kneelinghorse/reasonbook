// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Captures bounded evidence from the detached-install fixture before its cleanup.
// ABOUTME: Keeps separate startup and publication hang guards with nonmasking cleanup.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { spawn } from 'node:child_process';

// Keep evidence local and bounded; detached worker/npm stdio is intentionally unavailable.
export function watchFixture(server: ReturnType<typeof spawn>, root: string, installRoot: string) {
  const started = Date.now();
  const output = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
  let installing = false;
  let spawnError: string | null = null;
  let stdinError: string | null = null;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  for (const stream of ['stdout', 'stderr'] as const)
    server[stream]!.on('data', (chunk) => {
      const text = output[stream] + String(chunk);
      output[`${stream}Truncated`] ||= text.length > 4096;
      output[stream] = text.slice(-4096);
      installing ||= stream === 'stdout' && text.includes('rbook-installing');
    });
  server.on('error', (error) => {
    spawnError = String(error);
  });
  server.stdin!.on('error', (error) => {
    stdinError = String(error);
  });
  server.on('exit', (code, reason) => {
    exitCode = code;
    signal = reason;
  });
  const safely = (read: () => unknown): unknown => {
    try {
      return read();
    } catch (error) {
      return { readError: String(error) };
    }
  };
  const file = (name: string, json = false) =>
    safely(() => {
      if (!fs.existsSync(name)) return { exists: false };
      const fd = fs.openSync(name, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const bytes = Buffer.alloc(Math.min(size, 4096));
        const length = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        const text = bytes.subarray(0, length).toString('utf8');
        return {
          exists: true,
          bytes: size,
          truncated: size > 4096,
          text,
          ...(json ? { parsed: safely(() => JSON.parse(text)) } : {}),
        };
      } finally {
        fs.closeSync(fd);
      }
    });
  let phase = 'spawn';
  let phaseStarted = started;
  let components: Record<string, boolean> = {};
  let firstObservedMs: Record<string, number> = {};
  const snapshot = () =>
    JSON.stringify(
      {
        phase,
        elapsedMs: Date.now() - started,
        phaseElapsedMs: Date.now() - phaseStarted,
        components,
        firstObservedMs,
        pid: server.pid ?? null,
        spawnError,
        stdinError,
        exitCode: exitCode ?? server.exitCode,
        signal: signal ?? server.signalCode,
        ...output,
        files: {
          calls: file(path.join(root, 'calls')),
          release: file(path.join(root, 'npm-release')),
          ready: file(path.join(installRoot, '.rbook-ready.json'), true),
          lock: file(installRoot + '.lock', true),
          candidates: safely(() => {
            const parent = path.dirname(installRoot);
            const names = fs.existsSync(parent)
              ? fs
                  .readdirSync(parent)
                  .filter((name) => name.startsWith(path.basename(installRoot) + '.tmp-'))
              : [];
            return { names: names.slice(0, 8), truncated: names.length > 8 };
          }),
          pointer: file(path.join(path.dirname(installRoot), 'runtime/plugin-install.json'), true),
        },
      },
      null,
      2
    );
  return {
    hasInstalling: () => installing,
    snapshot,
    waitFor: async (
      nextPhase: 'startup' | 'publication',
      read: () => Record<string, boolean>
    ): Promise<void> => {
      phase = nextPhase;
      phaseStarted = Date.now();
      firstObservedMs = {};
      const poll = async (deadline: number) => {
        for (;;) {
          components = read();
          for (const [name, present] of Object.entries(components))
            if (present && firstObservedMs[name] === undefined)
              firstObservedMs[name] = Date.now() - phaseStarted;
          if (Object.values(components).every(Boolean)) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      // s102-m12: prescribed load reached healthy startup at 10,983 ms, then passed every
      // install-once/detached-survival assertion. Publication retains its own 10-second guard.
      const budget = phase === 'startup' ? 30000 : 10000;
      if (await poll(phaseStarted + budget)) return;
      throw new Error(`${phase} readiness timed out (budget ${budget} ms)\n${snapshot()}`);
    },
  };
}
// Cleanup may add evidence but must never replace an already captured assertion failure.
export function cleanupFixture(
  server: ReturnType<typeof spawn> | undefined,
  root: string,
  installRoot: string,
  primary?: Error
) {
  const errors: string[] = [];
  try {
    if (server?.exitCode === null) server.kill('SIGKILL');
    if (fs.existsSync(installRoot + '.lock')) {
      const owner = JSON.parse(fs.readFileSync(installRoot + '.lock', 'utf8'));
      try {
        process.kill(owner.pid, 'SIGKILL');
      } catch {
        /* This isolated worker already exited. */
      }
    }
  } catch (error) {
    errors.push(String(error));
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(String(error));
  }
  if (errors.length) {
    const message = `Detached fixture cleanup failed: ${errors.join('; ')}`;
    if (!primary) throw new Error(message);
    console.error(message);
  }
}

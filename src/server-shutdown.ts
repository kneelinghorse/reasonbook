// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bounds upload draining before releasing this process's leases and closing its resources.
// ABOUTME: Signals shorten a stdin grace period and a second signal ends it immediately.

import type { EventEmitter } from 'events';

interface ShutdownCallbacks {
  readonly stop: () => void;
  readonly drain: () => Promise<void>;
  readonly interrupt: () => void;
  readonly cleanup: () => void;
  readonly close: () => Promise<void>;
  readonly exit: () => void;
  readonly report: (error: unknown) => void;
}

export interface ShutdownBounds {
  readonly endMs: number;
  readonly signalMs: number;
}

export function createServerShutdown(
  callbacks: ShutdownCallbacks,
  bounds: ShutdownBounds = { endMs: 20_000, signalMs: 1_500 }
): (reason: string) => Promise<void> {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadline = Infinity;
  let signals = 0;
  let forced = false;
  let finalizing = false;
  let endDrain!: () => void;

  function shorten(milliseconds: number): void {
    const next = Date.now() + milliseconds;
    if (next >= deadline) return;
    deadline = next;
    clearTimeout(timer);
    timer = setTimeout(() => endDrain(), milliseconds);
  }

  async function run(): Promise<void> {
    callbacks.stop();
    const expired = new Promise<void>((resolve) => (endDrain = resolve));
    shorten(signals ? bounds.signalMs : bounds.endMs);
    try {
      await Promise.race([callbacks.drain(), expired]);
    } catch (error) {
      callbacks.report(error);
    } finally {
      clearTimeout(timer);
    }
    finalizing = true;
    // Both are synchronous: no accepted upload can regain a claim between release and cleanup.
    for (const action of [callbacks.interrupt, callbacks.cleanup]) {
      try {
        action();
      } catch (error) {
        callbacks.report(error);
      }
    }
    if (!forced) {
      try {
        await callbacks.close();
      } catch (error) {
        callbacks.report(error);
      }
    }
    callbacks.exit();
  }

  return (reason) => {
    if (reason === 'SIGTERM' || reason === 'SIGINT') signals++;
    if (!running) running = run();
    else if (signals >= 2) {
      forced = true;
      endDrain();
      if (finalizing) callbacks.exit();
    } else if (signals) shorten(bounds.signalMs);
    return running;
  };
}

const stderrGuard = Symbol.for('reasonbook.stderr-pipe-guard');

/** A host may close stderr before stdin; an EPIPE must not bypass lease release. */
export function installStderrPipeGuard(stderr: EventEmitter = process.stderr): void {
  const guarded = stderr as EventEmitter & { [stderrGuard]?: boolean };
  if (guarded[stderrGuard]) return;
  guarded[stderrGuard] = true;
  stderr.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s105-m01 — starts the lock-holding child and reports when it holds the store and when it lets go.
// ABOUTME: Owns exactly one child process; stop() ends that child alone, never anything found by pattern.
import { spawn } from 'child_process';
import * as path from 'path';

export interface HoldRecord {
  /** Tries the holder needed before no other connection had the store open. */
  readonly attempts: number;
  readonly freeWaitMs: number;
  readonly heldAt: string;
  readonly marker: string | null;
  /** Whether the marker appeared within the marker wait; null when no marker was asked for. */
  readonly sawMarker: boolean | null;
  readonly markerSeenAt: string | null;
  readonly afterMarkerMs: number;
  readonly releasedAt: string | null;
}

export interface StoreHold {
  readonly pid: number | undefined;
  /** Resolves when another connection first refuses the holder; never, if the store was free. */
  readonly waiting: Promise<void>;
  /** Resolves once the store is held; rejects if the holder could not take it. */
  readonly held: Promise<HoldRecord>;
  /** Resolves once the hold has ended, with the holder's whole record. */
  readonly released: Promise<HoldRecord>;
  stop: () => Promise<void>;
}

export interface HoldOptions {
  /** The file whose appearance starts the final part of the hold; without it the hold starts there. */
  readonly marker?: string;
  /** How long to keep holding after the marker appears (or after the hold starts, without one). */
  readonly afterMarkerMs: number;
  /** How long to wait for other connections to close before giving up (default 30 s). */
  readonly freeWaitMs?: number;
  /** How long to wait for the marker before going on without it (default 30 s). */
  readonly markerWaitMs?: number;
}

/** Hold `dbPath` exclusively in a separate process, against readers too, as fork 1 requires. */
export function holdStore(dbPath: string, options: HoldOptions): StoreHold {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, 'store-lock-holder-child.js'),
      JSON.stringify({
        dbPath,
        marker: options.marker ?? null,
        afterMarkerMs: options.afterMarkerMs,
        freeWaitMs: options.freeWaitMs ?? 30_000,
        markerWaitMs: options.markerWaitMs ?? 30_000,
      }),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const message = (type: 'waiting' | 'held' | 'released'): Promise<HoldRecord> =>
    new Promise((resolve, reject) => {
      const onMessage = (value: { type: string; record?: HoldRecord; [key: string]: unknown }) => {
        if (value.type === type) {
          done();
          resolve(value.record as HoldRecord);
        } else if (value.type === 'error') {
          done();
          reject(
            new Error(`Store holder failed to ${value.phase}: ${value.code} ${value.message}`)
          );
        }
      };
      const onExit = (code: number | null, signal: string | null) => {
        done();
        reject(new Error(`Store holder exited (${code ?? signal}) before '${type}': ${stderr}`));
      };
      const done = () => {
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  const waiting = message('waiting').then(() => undefined);
  const held = message('held');
  const released = message('released');
  // A caller that awaits only some of them must not leave the others as unhandled rejections.
  for (const promise of [waiting, held, released]) promise.catch(() => undefined);
  return {
    pid: child.pid,
    waiting,
    held,
    released,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

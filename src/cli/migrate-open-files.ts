// SPDX-License-Identifier: Apache-2.0
// ABOUTME: migrate's open-file check: lsof over the record folder, whose stderr may hold only warnings that it
// ABOUTME: could not reach another file system (s109-m01, #917); anything else, or the record's own device, refuses.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface LsofWarning {
  /** The mount lsof could not stat, as it printed it. */
  readonly mount: string;
}

export type LsofStderr =
  | { readonly ok: true; readonly warnings: readonly LsofWarning[] }
  | { readonly ok: false; readonly line: string };

/** A device number as lsof's "assuming dev=" line and a stat compare it: 32 bits, unsigned. */
export const deviceKey = (dev: bigint): bigint => BigInt.asUintN(32, dev);

/**
 * stderr may hold only warnings, each from one "lsof: WARNING" line to the next: a "can't stat()
 * <type> file system <mount>" line, "Output information may be incomplete.", and at most one
 * 'assuming "dev=<hex>" from mount table' line, which pairs only with its own warning. A warning
 * passes only for a device other than the record's (recordDevices). On macOS one without its device
 * line refuses, since every warning on record has one and a path prefix would pass the record's own
 * device through /System/Volumes/Data; elsewhere a mount containing the record refuses (the Linux
 * format is UNVERIFIED, E1). The refusal quotes the line it refused: the first not accepted, or
 * the warning about the record's own device (build critic A, note 9).
 */
export function readLsofStderr(
  stderr: string,
  recordDevices: readonly bigint[],
  recordPath: string,
  platform: NodeJS.Platform = process.platform
): LsofStderr {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return { ok: true, warnings: [] };
  const refuse = (line: string) => ({ ok: false as const, line: line.trim() });
  const warnings: Array<{ mount: string; head: string; dev?: bigint }> = [];
  for (const line of lines) {
    const head = /^lsof: WARNING: can't stat\(\) \S+ file system (.+?)\s*$/.exec(line);
    if (head) {
      warnings.push({ mount: head[1], head: line });
      continue;
    }
    const current = warnings[warnings.length - 1];
    const text = line.trim();
    if (!current || /^lsof:/.test(text)) return refuse(line);
    if (text === 'Output information may be incomplete.') continue;
    const device = /^assuming "dev=([0-9a-fA-F]+)" from mount table$/.exec(text);
    if (!device || current.dev !== undefined) return refuse(line);
    current.dev = deviceKey(BigInt(`0x${device[1]}`));
  }
  const own = recordDevices.map(deviceKey);
  for (const { mount, head, dev } of warnings) {
    if (dev !== undefined) {
      if (own.includes(dev)) return refuse(head);
    } else if (
      platform === 'darwin' ||
      recordPath === mount ||
      recordPath.startsWith(mount.endsWith('/') ? mount : `${mount}/`)
    )
      return refuse(head);
  }
  return { ok: true, warnings: warnings.map(({ mount }) => ({ mount })) };
}

/** s109-m01 (#917): a first check slower than this, with a warning, would stall under the lock. */
const SLOW_LSOF_MS = 3_000;

/** The devices that hold a record folder and its store's folder, as lsof's warnings name them. */
function devicesOf(directory: string): bigint[] {
  return [directory, path.join(directory, 'db')].flatMap((folder) => {
    const stat = fs.statSync(folder, { bigint: true, throwIfNoEntry: false });
    return stat ? [stat.dev] : [];
  });
}

/**
 * Only migration calls this: no path or process argument is interpreted by a shell. s108-m05: a
 * move's last check passes the mover's own pid, whose held connection keeps the record locked.
 * s109-m01 (#917): a warning that lsof could not reach another device no longer refuses (any stderr
 * did in 4.10.0); refuseSlowWarnings makes a slow first check with one refuse before the lock.
 */
export function assertNoOpenFiles(
  directory: string,
  ownPid?: number,
  options: { readonly refuseSlowWarnings?: boolean } = {}
): void {
  const started = Date.now();
  const inspected = spawnSync('lsof', ['-nP', '-Fpcn', '+D', directory], { encoding: 'utf8' });
  const elapsed = Date.now() - started;
  const cannot = `Cannot establish that no other process has files in ${directory} open`;
  if (inspected.error || (inspected.status !== 0 && inspected.status !== 1))
    throw new Error(`${cannot}; lsof must be available and able to inspect every open file.`);
  let real = directory;
  try {
    real = fs.realpathSync.native(directory);
  } catch {
    // lsof has said what it could not read, or will; the spelling given is compared as it is.
  }
  const stderr = readLsofStderr(inspected.stderr ?? '', devicesOf(directory), real);
  if (!stderr.ok)
    throw new Error(
      `${cannot}: lsof said ${JSON.stringify(stderr.line)}. lsof must be able to inspect every file system that holds the record.`
    );
  if (options.refuseSlowWarnings && stderr.warnings.length && elapsed > SLOW_LSOF_MS)
    throw new Error(
      `lsof took ${(elapsed / 1000).toFixed(1)} s, warning that it could not reach ${stderr.warnings
        .map((warning) => warning.mount)
        .join(
          ', '
        )}; the check after the move takes its lock would stall as long while clients wait. Reconnect or unmount it, then retry; nothing was moved.`
    );
  const holders = [...new Set([...inspected.stdout.matchAll(/^p(\d+)$/gm)].map((m) => m[1]))];
  const others = holders.filter((id) => Number(id) !== ownPid);
  // Output that names no process is no proof that nothing holds the record.
  if (others.length || (inspected.stdout.trim() && !holders.length))
    throw new Error(
      `Files in ${directory} are open by process ${others.join(', ') || 'unknown'}. Close those clients before migrating; no process was stopped.`
    );
}

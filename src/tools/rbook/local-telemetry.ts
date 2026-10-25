// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m04 — local telemetry: one append-only JSONL file per project and month under the config dir,
// ABOUTME: outside every repository and store, never uploaded. Ids and counts only, never text.

import {
  isRecordToolName,
  isRecordDirectoryName,
  resolveRecordPaths,
} from '../../intelligence/legacy-compat';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { rbookConfigDir } from './harness-session';
import { storedTimeMs } from './stored-time';
import { storeProjectId, type StoreTarget } from './store-key';

/**
 * WHERE (design doc s93-m04, fork 1): `<configDir>/telemetry/<h>/<YYYY-MM>.jsonl`, where `<h>`
 * hashes the project id together with the store's path. A free-text name or a merged
 * `unknown-project` can never form a path, and a scratch copy of a store never writes into the real
 * project's file. Under the user's config directory, never in a repository: not committed, not
 * uploaded (checkpoint sync reads only `rbook.sqlite`), not packed.
 *
 * WHAT (fork 3): no prompt text and no record content, ever. Ids are typed (`d:` decision, `l:`
 * learning, `c:` constraint, `n:` next step) and capped at {@link TELEMETRY_ID_CAP} per field.
 *
 * WRITES (fork 2): once per MCP tool call and once per CLI verb, best-effort: an append never fails
 * the call that makes it, and a write error is swallowed.
 *
 * RETENTION (fork 5): the {@link TELEMETRY_MONTHS_KEPT} newest monthly files per project; an older
 * one is deleted on every append, including backdated writes.
 */

export const TELEMETRY_ID_CAP = 100;
export const TELEMETRY_MONTHS_KEPT = 3;

export type TelemetrySurface = 'mcp' | 'hook' | 'cli';

export interface TelemetryRecord {
  readonly ts: string;
  /** The harness session hash, else the server's pid key; null for a CLI verb with neither. */
  readonly session: string | null;
  readonly surface: TelemetrySurface;
  /** The MCP client (`name/version`) or the harness a hook ran for; null when unknown. */
  readonly client: string | null;
  /** The MCP tool, or the CLI verb (`hook prompt`, `review`). */
  readonly tool: string;
  readonly action: string | null;
  /** read or write, as the server classifies the action; null for a verb with no class. */
  readonly mode: 'read' | 'write' | null;
  readonly ok: boolean;
  /** The refusal's error code, or null. */
  readonly refused: string | null;
  /** Why a hook gave up (deadline, store, input, error), or null. */
  readonly failOpen: string | null;
  /** The project's ambient mode when a hook ran; null elsewhere. */
  readonly ambient: 'on' | 'digest-off' | 'off' | null;
  readonly idsReturned?: readonly string[];
  readonly idsInjected?: readonly string[];
  readonly idsCited?: readonly string[];
  readonly charsInjected?: number;
  /** Session-start cause only; absent on legacy records or an unknown harness source. */
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact';
  readonly digestHash?: string;
  readonly procedurePatternIds?: readonly string[];
  readonly ceremony?: string | null;
  readonly restatedRuleIds?: readonly string[];
  /** Rules could not be queried, so an empty match is not a measured zero. */
  readonly ruleReadFailed?: boolean;
  /** s93-m06, Stop: trailing "Would record" lines read, drafts created and replaced, lines elsewhere. */
  readonly draftLines?: number;
  readonly draftsCreated?: number;
  readonly draftsReplaced?: number;
  readonly draftLinesElsewhere?: number;
  /** s93-m06, prompt: drafts offered with this message, and how the message reads. */
  readonly draftsOffered?: number;
  readonly draftReply?: 'approval' | 'decline' | 'question' | 'other';
}

const DRAFT_COUNTS = [
  'draftLines',
  'draftsCreated',
  'draftsReplaced',
  'draftLinesElsewhere',
  'draftsOffered',
] as const;

/** The store a record belongs to. */
export type TelemetryTarget = StoreTarget;

export function telemetryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(rbookConfigDir(env), 'telemetry');
}

/** `<h>`: the project id and the store's real path, hashed. */
export function telemetryKey(target: TelemetryTarget): string {
  let dbPath = path.resolve(target.dbPath);
  try {
    dbPath = fs.realpathSync.native(dbPath);
  } catch {
    // A store that does not exist yet keeps its resolved path.
  }
  return createHash('sha256').update(`${target.projectId}\0${dbPath}`).digest('hex').slice(0, 16);
}

export function telemetryDir(
  target: TelemetryTarget,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(telemetryRoot(env), telemetryKey(target));
}

/** `YYYY-MM.jsonl`, the UTC month of `when`. */
export function monthFile(when: Date): string {
  return `${when.toISOString().slice(0, 7)}.jsonl`;
}

/** Typed numeric ids, de-duplicated in order and capped. */
export function capIds(ids: Iterable<string>): string[] {
  const kept = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && /^[dlcn]:\d{1,16}$/.test(id)) kept.add(id);
    if (kept.size === TELEMETRY_ID_CAP) break;
  }
  return [...kept];
}

/** Read only the existing identity; telemetry must never migrate, repair or create a store. */
export function targetForStore(dbPath: string): TelemetryTarget | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
    const query = db.prepare('SELECT value FROM metadata WHERE key = ?');
    const projectId = storeProjectId(
      (key) => (query.get(key) as { value: unknown } | undefined)?.value
    );
    return { projectId, dbPath };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* Telemetry never fails its caller. */
    }
  }
}

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;
const TOKEN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{16}(?:[a-f0-9]{48})?$/;
const bounded = (value: unknown, pattern: RegExp): string | null =>
  typeof value === 'string' && value.length <= 160 && pattern.test(value) ? value : null;

/** An explicit serialization boundary: no extra property or arbitrary content survives. */
function serializable(value: unknown): TelemetryRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.ts !== 'string' ||
    !Number.isFinite(storedTimeMs(v.ts)) ||
    !['mcp', 'hook', 'cli'].includes(v.surface as string) ||
    typeof v.ok !== 'boolean' ||
    typeof v.tool !== 'string' ||
    ![null, 'read', 'write'].includes(v.mode as string | null) ||
    ![null, 'on', 'digest-off', 'off'].includes(v.ambient as string | null) ||
    !['session', 'client', 'action', 'refused', 'failOpen'].every(
      (key) => v[key] === null || typeof v[key] === 'string'
    )
  )
    return null;
  const client =
    v.client === null
      ? null
      : (bounded(v.client, /^[a-zA-Z0-9][a-zA-Z0-9._@+/:~-]{0,99}$/) ??
        `hash:${createHash('sha256')
          .update(v.client as string)
          .digest('hex')
          .slice(0, 16)}`);
  const array = (key: string): string[] => capIds(Array.isArray(v[key]) ? v[key] : []);
  return {
    ts: new Date(storedTimeMs(v.ts)).toISOString(),
    session: bounded(
      v.session,
      /^(?:[a-f0-9]{16}|ext:[a-f0-9]{16}|pid:[a-f0-9]{1,64}:\d{1,12}:\d{1,18})$/
    ),
    surface: v.surface as TelemetrySurface,
    client,
    tool:
      (typeof v.tool === 'string' && isRecordToolName(v.tool)
        ? v.tool
        : bounded(v.tool, /^[a-z][a-z-]{0,31}(?: [a-z][a-z-]{0,31})?$/)) ?? 'unknown',
    action: bounded(v.action, TOKEN),
    mode: v.mode as TelemetryRecord['mode'],
    ok: v.ok,
    refused: bounded(v.refused, /^[A-Z][A-Z0-9_]{0,79}$/),
    failOpen: bounded(v.failOpen, /^(?:deadline|store|input|error)$/),
    ambient: v.ambient as TelemetryRecord['ambient'],
    ...(Array.isArray(v.idsReturned) ? { idsReturned: array('idsReturned') } : {}),
    ...(Array.isArray(v.idsInjected) ? { idsInjected: array('idsInjected') } : {}),
    ...(Array.isArray(v.idsCited) ? { idsCited: array('idsCited') } : {}),
    ...(Array.isArray(v.restatedRuleIds)
      ? {
          restatedRuleIds: capIds(
            v.restatedRuleIds.filter((id) => typeof id === 'string' && /^[cl]:/.test(id))
          ),
        }
      : {}),
    ...(Array.isArray(v.procedurePatternIds)
      ? {
          procedurePatternIds: [
            ...new Set(
              v.procedurePatternIds.filter(
                (id) => typeof id === 'string' && /^P(?:0[1-9]|1[0-3])$/.test(id)
              )
            ),
          ].slice(0, TELEMETRY_ID_CAP),
        }
      : {}),
    ...(typeof v.charsInjected === 'number' &&
    Number.isSafeInteger(v.charsInjected) &&
    v.charsInjected >= 0
      ? { charsInjected: v.charsInjected }
      : {}),
    ...(bounded(v.digestHash, HASH) ? { digestHash: v.digestHash as string } : {}),
    ...(v.tool === 'hook session-start' &&
    ['startup', 'resume', 'clear', 'compact'].includes(v.source as string)
      ? { source: v.source as TelemetryRecord['source'] }
      : {}),
    ...(v.ceremony !== undefined
      ? { ceremony: bounded(v.ceremony, /^(?:C0[1-3]|\/[a-z0-9][\w-]{0,31}(?::[\w-]{1,31})?)$/i) }
      : {}),
    ...(typeof v.ruleReadFailed === 'boolean' ? { ruleReadFailed: v.ruleReadFailed } : {}),
    ...Object.fromEntries(
      DRAFT_COUNTS.filter(
        (key) =>
          typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && (v[key] as number) >= 0
      ).map((key) => [key, v[key] as number])
    ),
    ...(['approval', 'decline', 'question', 'other'].includes(v.draftReply as string)
      ? { draftReply: v.draftReply as TelemetryRecord['draftReply'] }
      : {}),
  };
}

/** Resolve links in the existing prefix even when the destination has not been created. */
function canonical(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}

function inside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Config overrides and symlinks must not move external runtime/measurement files into a checkout. */
export function safeDestination(dir: string, target?: TelemetryTarget): boolean {
  const real = canonical(path.resolve(dir));
  const dbDir = target ? path.dirname(canonical(path.resolve(target.dbPath))) : null;
  if (
    dbDir !== null &&
    path.basename(dbDir) === 'db' &&
    isRecordDirectoryName(path.basename(path.dirname(dbDir))) &&
    inside(real, path.dirname(path.dirname(dbDir)))
  )
    return false;
  for (let parent = real; ; parent = path.dirname(parent)) {
    if (
      fs.existsSync(path.join(parent, '.git')) ||
      fs.existsSync(resolveRecordPaths(parent).dbPath)
    )
      return false;
    if (parent === path.dirname(parent)) return true;
  }
}

/** Keep only the newest monthly files on every append, including existing and backdated months. */
function enforceRetention(dir: string): void {
  const months = fs
    .readdirSync(dir)
    .filter((name) => MONTH.test(name))
    .sort();
  for (const old of months.slice(0, Math.max(0, months.length - TELEMETRY_MONTHS_KEPT))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
}

/** Append one record. Best-effort: never throws and never appends through a linked monthly file. */
export function appendTelemetry(
  record: TelemetryRecord,
  target: TelemetryTarget,
  env: NodeJS.ProcessEnv = process.env
): void {
  let fd: number | undefined;
  try {
    const safe = serializable(record);
    if (!safe) return;
    const dir = telemetryDir(target, env);
    if (!safeDestination(dir, target)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!safeDestination(dir, target)) return;
    const file = path.join(dir, monthFile(new Date(storedTimeMs(safe.ts))));
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) return;
    fs.writeSync(fd, `${JSON.stringify(safe)}\n`);
    enforceRetention(dir);
  } catch {
    // Telemetry never fails the call that writes it.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Best-effort close. */
      }
    }
  }
}

export interface TelemetryReadReport {
  readonly records: TelemetryRecord[];
  readonly warnings: string[];
  /** Monthly entries found, including corrupt or unreadable files. */
  readonly files: number;
  /** At least one valid record or a readable empty monthly file, never a missing source. */
  readonly available: boolean;
}

/** Validated reads with missing/corrupt/unreadable sources distinguished from measured zeroes. */
export function readTelemetryReport(
  target: TelemetryTarget,
  env: NodeJS.ProcessEnv = process.env
): TelemetryReadReport {
  const records: TelemetryRecord[] = [];
  const warnings: string[] = [];
  let months: string[];
  const dir = telemetryDir(target, env);
  try {
    if (!safeDestination(dir, target))
      return { records, warnings: ['telemetry unsafe destination'], files: 0, available: false };
    months = fs
      .readdirSync(dir)
      .filter((name) => MONTH.test(name))
      .sort();
  } catch (error) {
    const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    return { records, warnings: [`telemetry ${kind}`], files: 0, available: false };
  }
  let corrupt = 0;
  let unreadable = 0;
  let empty = false;
  for (const month of months) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(dir, month), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) throw new Error('unreadable');
      const lines = fs
        .readFileSync(fd, 'utf8')
        .split('\n')
        .filter((line) => line.trim());
      if (lines.length === 0) empty = true;
      for (const line of lines) {
        try {
          const record = serializable(JSON.parse(line));
          if (record) records.push(record);
          else corrupt += 1;
        } catch {
          corrupt += 1;
        }
      }
    } catch {
      unreadable += 1;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Best-effort close. */
        }
      }
    }
  }
  if (months.length === 0) warnings.push('telemetry missing monthly files');
  if (corrupt) warnings.push(`telemetry corrupt: ${corrupt} invalid JSON or schema lines`);
  if (unreadable) warnings.push(`telemetry unreadable: ${unreadable} monthly files`);
  return { records, warnings, files: months.length, available: records.length > 0 || empty };
}

/** Compatibility convenience: diagnostics-aware callers should use readTelemetryReport. */
export function readTelemetry(
  target: TelemetryTarget,
  env: NodeJS.ProcessEnv = process.env
): TelemetryRecord[] {
  return readTelemetryReport(target, env).records;
}

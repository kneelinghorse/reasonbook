// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Whether a change that arrived from another copy is one Reasonbook could have written (s97-m09, design §R1):
// ABOUTME: its columns typed, its value and base JSON, a known kind and entity, a valid author and its own project.

import { breaksNameRule } from './author-name';
import { PROTOCOL_VERSION } from './record-changes';
import { PROJECT_ENTITY, RECORDED_TABLES } from './record-columns';
import { knownChangeKind } from './record-guards';
import { MEMBER_ENTITY } from './record-membership';
import { REPLICA_ENTITY, TXN_ENTITY, type LoggedChange } from './record-standing';

/** The entities a change may name: the shared tables, the project, a transaction, a replica, a member. */
export const CHANGE_ENTITIES: ReadonlySet<string> = new Set([
  ...RECORDED_TABLES,
  PROJECT_ENTITY,
  TXN_ENTITY,
  REPLICA_ENTITY,
  MEMBER_ENTITY,
]);

const TEXT = ['change_id', 'txn_id', 'project_id', 'replica_id', 'hlc', 'kind', 'entity'] as const;
const OPTIONAL_TEXT = [
  'author_name',
  'author_user_id',
  'entity_id',
  'field',
  'value',
  'base',
] as const;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** The hybrid clock's reading, as every copy writes it: 13 digits of milliseconds and a 6-digit count. */
const HLC = /^\d{13}-\d{6}$/;
/**
 * No machine's clock reads past this, so a reading beyond it is forged or broken. A copy whose clock
 * once ran days or years ahead keeps such readings until real time passes them, so the bound is far
 * off (s97-m09 critics, round 2): it keeps a reading's milliseconds within their 13 digits.
 */
export const LATEST_READING_MS = Date.UTC(2200, 0, 1);

/** Why a hybrid clock reading is not one any copy writes, or null. */
export function readingProblem(hlc: string): string | null {
  if (!HLC.test(hlc)) return `clock reading ${hlc} is not one`;
  if (Number(hlc.slice(0, 13)) >= LATEST_READING_MS)
    return `clock reading ${hlc} is past the year 2200, which no clock reads`;
  return null;
}

/**
 * How far past the referee's own clock a reading it takes in may run (s97-m09 critics, round 3).
 * Every copy takes the latest reading it receives as its clock, so one reading just short of
 * LATEST_READING_MS would carry every copy past it. A week lets a machine whose clock ran days ahead
 * sync, and is as far as one member can move the record's clocks.
 */
export const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** When a reading says it was made, as a person reads it. */
export function readingTime(hlc: string): string {
  return new Date(Number(hlc.slice(0, 13))).toISOString();
}

/**
 * Whether a well-formed reading runs past what intake takes in, so it waits until it does not: more
 * than MAX_AHEAD_MS past `nowMs`, and past `held`, the reading the referee's own clock holds (s100-m01).
 * A clock never moves back, so a referee whose host clock once ran ahead keeps that reading, and the
 * copies that took it write at it: they count up within its millisecond and are never refused for it.
 * A reading at the last count of the referee's millisecond moves it on by one, since the referee's
 * next write carries into the next millisecond: one millisecond a delivery, which real time outruns.
 */
export function runsAhead(hlc: string, nowMs: number, held: string | null = null): boolean {
  const heldMs = held === null || readingProblem(held) ? 0 : Number(held.slice(0, 13));
  return Number(hlc.slice(0, 13)) > Math.max(nowMs + MAX_AHEAD_MS, heldMs);
}

/**
 * Whether JSON text names one key twice in an object. JavaScript reads the last such key and
 * SQLite's json_extract the first, so a value naming one twice reads two ways (s97-m09 critics).
 * Called only on text that parses.
 */
export function repeatsKey(text: string): boolean {
  const objects: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = objects[objects.length - 1];
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(at, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      at = end;
    } else if (char === '{') {
      objects.push(new Set());
      expectKey = true;
    } else if (char === '[') objects.push(null);
    else if (char === '}' || char === ']') objects.pop();
    else if (char === ',') expectKey = Boolean(objects[objects.length - 1]);
  }
  return false;
}
const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

function parses(text: string): { readonly ok: boolean; readonly value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Why a change is not one Reasonbook could have written, or null. It checks shape only: whether
 * the change may be applied, and by whom, is the caller's (the referee's per-call rules) and the
 * judge's. A protocol newer than this copy's is not malformed; protocolTooNew says so.
 */
export function changeProblem(change: unknown, projectId: string): string | null {
  if (!change || typeof change !== 'object' || Array.isArray(change))
    return 'a change is not an object';
  const row = change as Record<string, unknown>;
  const name = isText(row.change_id) ? `change ${row.change_id}` : 'a change';
  for (const column of TEXT)
    if (!isText(row[column])) return `${name} has no ${column}, or it is not text`;
  for (const column of OPTIONAL_TEXT)
    if (row[column] !== null && row[column] !== undefined && typeof row[column] !== 'string')
      return `${name}'s ${column} is not text`;
  if (!isWhole(row.replica_seq)) return `${name}'s replica_seq is not a whole number from 1`;
  if (!isWhole(row.protocol_version))
    return `${name}'s protocol_version is not a whole number from 1`;
  if (row.project_id !== projectId)
    return `${name} belongs to project ${String(row.project_id)}, not ${projectId}`;
  if (!knownChangeKind(row.kind as string))
    return `${name} has an unknown kind ${String(row.kind)}`;
  if (!CHANGE_ENTITIES.has(row.entity as string))
    return `${name} names an unknown entity ${String(row.entity)}`;
  const reading = readingProblem(row.hlc as string);
  if (reading) return `${name}'s ${reading}`;
  if (typeof row.value === 'string' && !parses(row.value).ok) return `${name}'s value is not JSON`;
  if (typeof row.value === 'string' && repeatsKey(row.value))
    return `${name}'s value names one key twice, which reads two ways`;
  if (typeof row.base === 'string') {
    const base = parses(row.base);
    if (!base.ok || !Array.isArray(base.value) || !base.value.every(isText))
      return `${name}'s base is not a JSON list of change ids`;
  }
  const logged = {
    ...row,
    author_name: row.author_name ?? null,
    value: row.value ?? null,
  } as LoggedChange;
  if (breaksNameRule(logged)) return `${name} carries an author name no copy of Reasonbook records`;
  return null;
}

/** The first change written in a record protocol newer than this copy's, or null (fact 28). */
export function protocolTooNew(changes: readonly LoggedChange[]): LoggedChange | null {
  return changes.find((change) => change.protocol_version > PROTOCOL_VERSION) ?? null;
}

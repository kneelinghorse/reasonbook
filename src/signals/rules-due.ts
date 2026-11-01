// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m03 — the work_due signal: open next steps whose date has come and Deferred missions whose
// ABOUTME: current date has come, with the soonest date still ahead, so a stored report can show it later.

import { BARE_DATE, bareDateSql } from '../tools/rbook/next-step-dates';
import type { SignalEntry } from './report';
import { columnsOf, timeOf } from './store-read';
import { oldestOf, unavailable, type RecordsContext } from './rules-records';

/**
 * A Deferred mission's date, when it still belongs to the mission's current deferral: defer stores
 * checkAfter with checkAfterDeferredAt, and a later deferral (a re-defer, or an update to Deferred)
 * writes a new deferredAt, so a stale date never counts (the sprint-108 design, settled item 3).
 */
export function missionDueDay(domainFields: unknown): string | null {
  if (typeof domainFields !== 'string') return null;
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(domainFields);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const day = fields.checkAfter;
  if (typeof day !== 'string' || !BARE_DATE.test(day)) return null;
  if (
    fields.checkAfterDeferredAt === undefined ||
    fields.checkAfterDeferredAt !== fields.deferredAt
  )
    return null;
  return day;
}

export function workDue(ctx: RecordsContext): SignalEntry {
  const steps = columnsOf(ctx.db, 'next_steps');
  const missions = columnsOf(ctx.db, 'missions');
  const stepsReadable = steps.has('status') && steps.has('resolved_at');
  const missionsReadable = missions.has('status') && missions.has('domain_fields');
  if (!stepsReadable && !missionsReadable)
    return unavailable(
      'work_due',
      'no next steps with resolved_at and no missions with domain_fields'
    );
  const due: Array<{ at: number; key: string }> = [];
  let nextDue = Infinity;
  const consider = (at: number, key: string) => {
    if (!Number.isFinite(at)) return;
    if (at <= ctx.nowMs) due.push({ at, key });
    else nextDue = Math.min(nextDue, at);
  };
  if (stepsReadable) {
    const rows = ctx.db
      .prepare(
        `SELECT id, resolved_at FROM next_steps WHERE status IN ('pending', 'carried') AND ${bareDateSql('resolved_at')}`
      )
      .all() as Array<{ id: number; resolved_at: string }>;
    for (const row of rows) consider(timeOf(row.resolved_at), `n:${row.id}`);
  }
  if (missionsReadable) {
    const rows = ctx.db
      .prepare("SELECT id, domain_fields FROM missions WHERE status = 'Deferred'")
      .all() as Array<{ id: string; domain_fields: unknown }>;
    for (const row of rows) {
      const day = missionDueDay(row.domain_fields);
      if (day) consider(timeOf(day), String(row.id));
    }
  }
  // Due longest first, then by id.
  due.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    kind: 'work_due',
    available: true,
    count: due.length,
    ids: due.slice(0, ctx.maxIds).map((row) => row.key),
    ...oldestOf(due.map((row) => row.at)),
    ...(Number.isFinite(nextDue) ? { nextDueAt: new Date(nextDue).toISOString() } : {}),
    ...(!stepsReadable
      ? { reason: 'no next steps with resolved_at: Deferred missions only' }
      : !missionsReadable
        ? { reason: 'no missions with domain_fields: next steps only' }
        : {}),
  };
}

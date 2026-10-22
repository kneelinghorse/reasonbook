// ABOUTME: Implements the rbook_project sweep action — read-only cross-instance aggregation.
// ABOUTME: Queries all registered Reasonbook instances via SQLite and returns open missions/sessions.

import { formatToolFailure } from './format-failure';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { RbookToolResult } from './types';
import { appendWarnings } from './format-warnings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepItem {
  readonly instance_id: string;
  readonly path: string;
  readonly item_type: 'mission' | 'session';
  readonly id: string;
  readonly summary: string;
  readonly status: string;
  readonly sprint_id: string | null;
}

export interface SweepGroup {
  readonly instance_id: string;
  readonly path: string;
  readonly items: SweepItem[];
}

export interface SweepResult {
  readonly items: SweepItem[];
  readonly groups: SweepGroup[];
  readonly warnings: string[];
  readonly instances_scanned: number;
  readonly instances_skipped: number;
}

export interface SweepParams {
  /** Restrict to these registry names only */
  readonly instances?: string[];
  /** Restrict to these mission/session statuses */
  readonly statusFilter?: string[];
  /** Restrict to 'mission' or 'session' */
  readonly itemType?: 'mission' | 'session';
}

// ---------------------------------------------------------------------------
// Status ordering: lower index = higher priority
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<string, number> = {
  Blocked: 0,
  'In Progress': 1,
  Current: 2,
  Queued: 3,
};

const OPEN_MISSION_STATUSES = ['Queued', 'Current', 'In Progress', 'Blocked'];

function statusRank(status: string): number {
  return STATUS_ORDER[status] ?? 99;
}

// ---------------------------------------------------------------------------
// Per-instance SQLite queries (read-only)
// ---------------------------------------------------------------------------

interface MissionRow {
  id: string;
  name: string;
  status: string;
  sprint_id: string | null;
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
  sprint_id: string | null;
}

function queryOpenMissions(dbPath: string, statusFilter?: string[]): MissionRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const statuses = statusFilter
      ? OPEN_MISSION_STATUSES.filter((s) => statusFilter.includes(s))
      : OPEN_MISSION_STATUSES;
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, name, status, sprint_id FROM missions WHERE status IN (${placeholders})`)
      .all(...statuses) as MissionRow[];
    return rows;
  } finally {
    db.close();
  }
}

function queryActiveSessions(dbPath: string): SessionRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // s92-m03: explicit sessions only; an implicit session is a process's bookkeeping, not open
    // work. The column is checked first because this read never migrates another project's store.
    const columns = db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{ name: string }>;
    const explicitOnly = columns.some((c) => c.name === 'implicit') ? 'AND implicit = 0' : '';
    const rows = db
      .prepare(
        `SELECT id, title, status, sprint_id FROM sessions WHERE status = 'active' ${explicitOnly}`
      )
      .all() as SessionRow[];
    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main sweep function
// ---------------------------------------------------------------------------

export async function rbookProjectSweep(
  params: SweepParams,
  registryOverride?: ProjectGraphRegistry
): Promise<RbookToolResult<SweepResult>> {
  // s79-m02 — enumerate discoverable stores from the write-authoritative
  // project-graph registry (map store_path → projectRoot) rather than the derived
  // JSON, so "across my projects" has one discovery source.
  const registry = registryOverride ?? (await ProjectGraphRegistry.create());
  const allProjects = registry.list().map((r) => ({ projectRoot: r.store_path, name: r.name }));

  const targetProjects = params.instances
    ? allProjects.filter((p) => {
        const registryName = p.name ?? path.basename(p.projectRoot);
        return params.instances!.includes(registryName);
      })
    : allProjects;

  const allItems: SweepItem[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const project of targetProjects) {
    const instanceId = project.name ?? path.basename(project.projectRoot);
    const dbPath = resolveRecordPaths(project.projectRoot).dbPath;

    if (!fs.existsSync(dbPath)) {
      warnings.push(`${instanceId} (${project.projectRoot}): ${dbPath} not found — skipped`);
      skipped++;
      continue;
    }

    try {
      if (!params.itemType || params.itemType === 'mission') {
        const missions = queryOpenMissions(dbPath, params.statusFilter);
        for (const m of missions) {
          allItems.push({
            instance_id: instanceId,
            path: project.projectRoot,
            item_type: 'mission',
            id: m.id,
            summary: m.name,
            status: m.status,
            sprint_id: m.sprint_id,
          });
        }
      }

      if (!params.itemType || params.itemType === 'session') {
        // statusFilter doesn't apply to sessions (only one open status: active)
        const sessions = queryActiveSessions(dbPath);
        for (const s of sessions) {
          allItems.push({
            instance_id: instanceId,
            path: project.projectRoot,
            item_type: 'session',
            id: s.id,
            summary: s.title,
            status: s.status,
            sprint_id: s.sprint_id,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${instanceId}: error reading database — ${message}`);
      skipped++;
    }
  }

  // Sort within each instance group: Blocked → In Progress → Current → Queued
  const groupMap = new Map<string, SweepItem[]>();
  for (const item of allItems) {
    if (!groupMap.has(item.instance_id)) {
      groupMap.set(item.instance_id, []);
    }
    groupMap.get(item.instance_id)!.push(item);
  }

  for (const items of groupMap.values()) {
    items.sort((a, b) => statusRank(a.status) - statusRank(b.status));
  }

  const groups: SweepGroup[] = Array.from(groupMap.entries()).map(([instance_id, items]) => ({
    instance_id,
    path: items[0]!.path,
    items,
  }));

  // Flat list in group order, sorted within groups
  const sortedItems = groups.flatMap((g) => g.items);

  return {
    success: true,
    data: {
      items: sortedItems,
      groups,
      warnings,
      instances_scanned: targetProjects.length - skipped,
      instances_skipped: skipped,
    },
  };
}

export function formatProjectSweepForLLM(result: RbookToolResult<SweepResult>): string {
  if (!result.success || !result.data) {
    return formatToolFailure('❌ Sweep failed', result.error, 'unknown error');
  }

  const { items, groups, warnings, instances_scanned, instances_skipped } = result.data;

  const lines: string[] = [];
  lines.push(`🔍 Sweep complete — ${instances_scanned} instance(s) scanned`);
  if (instances_skipped > 0) lines.push(`⚠️  ${instances_skipped} instance(s) skipped`);
  lines.push('');

  if (items.length === 0) {
    lines.push('✅ No open items across registered instances.');
  } else {
    for (const group of groups) {
      lines.push(`## ${group.instance_id}`);
      for (const item of group.items) {
        const tag = item.item_type === 'session' ? '🗂' : '📋';
        const sprint = item.sprint_id ? ` [${item.sprint_id}]` : '';
        lines.push(`  ${tag} [${item.status}] ${item.id} — ${item.summary}${sprint}`);
      }
      lines.push('');
    }
  }

  if (warnings.length > 0) {
    lines.push('⚠️  Warnings:');
    for (const w of warnings) lines.push(`  - ${w}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

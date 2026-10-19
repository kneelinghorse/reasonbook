// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m13 (#662) — the work queue follows Requires edges: queued missions in dependency order
// ABOUTME: (ties keep the order given), and the next one to name is the first whose Requires targets are complete.

import type { RbookDatabaseClient } from './client';

/**
 * WHY (next step #662, the sprint-96 review). Every surface that lists queued missions or names the
 * next one read them in id order, never `mission_dependencies`, so a mission whose prerequisites
 * were still open could be named as the one to start. A Requires edge goes from the mission that
 * requires to the mission required (`rbook_mission(action="depends")`).
 *
 * THE ORDER: a queued mission comes after every queued mission it requires; among missions free to
 * come next, the order the caller gave wins (id, or sprint then id). A cycle of Requires edges cannot
 * be ordered, so its missions follow in the given order.
 *
 * READY: a queued mission is ready when every mission it requires is Completed. `waitsOn` names the
 * ones that are not. Named holes: an edge whose target no longer exists does not hold a mission back
 * (nothing could ever complete it), and Blocks and Enables edges are not read.
 */

export interface Ordered {
  /** The missions this one requires that are not Completed. Absent when it waits on none. */
  readonly waitsOn?: string[];
}

/**
 * Order `queued` by its Requires edges and mark what each waits on. When the edges cannot be read,
 * the order given is kept and `warning` says so; a store with no dependency table has no edges.
 */
export function orderByRequires<T extends { readonly id: string }>(
  client: RbookDatabaseClient,
  queued: readonly T[]
): { readonly missions: Array<T & Ordered>; readonly warning?: string } {
  if (queued.length === 0) return { missions: [] };
  const table = client.getOne<{ one: number }>(
    "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'mission_dependencies'",
    []
  );
  if (table.success && !table.data) return { missions: [...queued] };
  const edges = client.getMany<{ fromId: string; toId: string; status: string | null }>(
    `SELECT d.from_id AS fromId, d.to_id AS toId, m.status AS status
       FROM mission_dependencies d LEFT JOIN missions m ON m.id = d.to_id
      WHERE UPPER(d.type) = 'REQUIRES' AND d.from_id IN (${queued.map(() => '?').join(', ')})`,
    queued.map((mission) => mission.id)
  );
  if (!table.success || !edges.success)
    return {
      missions: [...queued],
      warning: `The work queue's Requires edges could not be read (${(table.error ?? edges.error)?.message ?? 'unknown error'}), so queued missions are listed without them.`,
    };

  const ids = new Set(queued.map((mission) => mission.id));
  const requires = new Map<string, string[]>();
  const waits = new Map<string, string[]>();
  for (const edge of edges.data ?? []) {
    if (ids.has(edge.toId))
      requires.set(edge.fromId, [...(requires.get(edge.fromId) ?? []), edge.toId]);
    if (edge.status !== null && edge.status.toUpperCase() !== 'COMPLETED')
      waits.set(edge.fromId, [...(waits.get(edge.fromId) ?? []), edge.toId]);
  }

  // Kahn's order, always taking the earliest mission (in the order given) that requires no unplaced one.
  const placed = new Set<string>();
  const order: T[] = [];
  while (order.length < queued.length) {
    const next =
      queued.find(
        (mission) =>
          !placed.has(mission.id) &&
          (requires.get(mission.id) ?? []).every((target) => placed.has(target))
      ) ?? queued.find((mission) => !placed.has(mission.id))!; // a cycle: the given order
    placed.add(next.id);
    order.push(next);
  }
  return {
    missions: order.map((mission) => {
      const on = waits.get(mission.id);
      return on ? { ...mission, waitsOn: [...new Set(on)].sort() } : { ...mission };
    }),
  };
}

/** The first mission that waits on nothing, in queue order. */
export function firstReady<T extends Ordered>(queued: readonly T[]): T | undefined {
  return queued.find((mission) => !mission.waitsOn?.length);
}

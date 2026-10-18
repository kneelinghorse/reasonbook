// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m02 one-time repair: re-date Completed sprints whose end_date is a planned date later
// ABOUTME: than their recorded close, so the next-step lease counts real closes. Itemizes what it cannot.

import type { RbookDatabaseClient } from './client';
import { checkWrite, countWrite } from './write-guard';
import { storedTimeMs } from './stored-time';
import { isSharedStore } from './replica-identity';

/**
 * WHY. Before 3.2.0 `rbook_sprint(complete)` wrote `end_date = COALESCE(end_date, ?)`, so a sprint
 * planned to end on 10-08 but closed on 10-02 kept 10-08. The lease counts a close by end_date, so
 * every row carried between 10-02 and 10-08 counted that sprint as a close it survived. Measured on
 * a TraceLab copy: 9 Completed sprints carry such a date (42–47, 49, 55, 65); this repo has 1
 * (sprint-54).
 *
 * THE ANCHOR is the recorded close, in this order:
 *   1. the latest `session_events` row with action='sprint_complete' and mission=<sprint> — written
 *      at every close since the event log existed (70 of 82 sprints here, all 9 TraceLab ones);
 *   2. else the latest `sprint_complete:<sprint>` context snapshot's created_at — rarer, because
 *      that snapshot is deduped on content hash (none of the 9).
 * A sprint with neither is left as it is and itemized as UNANCHORED: nothing on disk says when it
 * closed, so no date is invented for it.
 *
 * ONLY LATER DATES MOVE. A Completed sprint whose end_date is null, unparseable, or not later than
 * its anchor is untouched — so a correctly dated store sees no lease change at all.
 *
 * ONE-TIME, MARKER-GATED: `metadata.sprint_end_date_repair_v1` records when it ran. Callers run it
 * inside the close transaction, so a close that refuses or rolls back also rolls back the repair
 * and its marker, and the next close retries it.
 */

export const END_DATE_REPAIR_MARKER = 'sprint_end_date_repair_v1';

export interface RepairedSprintEndDate {
  sprintId: string;
  /** The end_date before the repair: a planned date later than the close. */
  from: string;
  /** The recorded close it was set to. */
  to: string;
  anchor: 'session_event' | 'snapshot';
}

export interface UnanchoredSprint {
  sprintId: string;
  /** Its end_date, left as found (null when none was ever recorded). */
  endDate: string | null;
}

export interface SprintEndDateRepair {
  repaired: RepairedSprintEndDate[];
  /** Completed sprints with no recorded close to anchor on — left unrepaired, by name. */
  unanchored: UnanchoredSprint[];
  /** Writes the repair attempted and the database rejected; the marker is not set when non-empty. */
  failures: string[];
}

interface AnchorRow {
  id: string;
  end_date: string | null;
  event_ts: string | null;
  snapshot_at: string | null;
}

/** SQLite's CURRENT_TIMESTAMP spelling (`YYYY-MM-DD HH:MM:SS`, UTC) → ISO-8601 with `Z`. */
export function normalizeCloseTimestamp(value: string): string {
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value.trim());
  return sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : value.trim();
}

/** Whether the repair has already run on this store. */
export function endDateRepairHasRun(client: RbookDatabaseClient): boolean {
  const marker = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    END_DATE_REPAIR_MARKER,
  ]);
  return marker.success && marker.data !== undefined;
}

/**
 * Run the repair once. Returns null when the marker says it already ran (or the anchor read
 * failed, which leaves the marker unset so a later close retries); otherwise the itemized receipt.
 */
export function repairCompletedSprintEndDates(
  client: RbookDatabaseClient,
  ranAt: string = new Date().toISOString()
): SprintEndDateRepair | null {
  // s96-m03 (ADR s96 §6): a shared record skips the repair, which rewrites recorded end dates.
  if (isSharedStore(client) || endDateRepairHasRun(client)) return null;

  const rows = client.getMany<AnchorRow>(
    // s93-m11: the latest anchor by time (julianday), returned as stored, so the end_date the
    // repair writes keeps its anchor's own spelling.
    `SELECT s.id AS id, s.end_date AS end_date,
            (SELECT e.ts FROM session_events e
              WHERE e.action = 'sprint_complete' AND e.mission = s.id
                AND julianday(e.ts) IS NOT NULL
              ORDER BY julianday(e.ts) DESC LIMIT 1) AS event_ts,
            (SELECT c.created_at FROM context_snapshots c
              WHERE c.source = 'sprint_complete:' || s.id
                AND julianday(c.created_at) IS NOT NULL
              ORDER BY julianday(c.created_at) DESC LIMIT 1) AS snapshot_at
       FROM sprints s
      WHERE s.status = 'Completed'
      ORDER BY s.id ASC`,
    []
  );
  if (!rows.success || !rows.data) return null;

  const repair: SprintEndDateRepair = { repaired: [], unanchored: [], failures: [] };
  for (const row of rows.data) {
    const anchorKind = row.event_ts ? 'session_event' : row.snapshot_at ? 'snapshot' : null;
    const anchorRaw = row.event_ts ?? row.snapshot_at;
    if (!anchorKind || !anchorRaw) {
      repair.unanchored.push({ sprintId: row.id, endDate: row.end_date });
      continue;
    }
    const anchor = normalizeCloseTimestamp(anchorRaw);
    const endMs = storedTimeMs(row.end_date);
    const anchorMs = storedTimeMs(anchor);
    if (Number.isNaN(endMs) || Number.isNaN(anchorMs) || endMs <= anchorMs) continue;

    const changed = countWrite(
      client.execute('UPDATE sprints SET end_date = ? WHERE id = ?', [anchor, row.id]),
      repair.failures,
      `sprints.end_date repair for '${row.id}'`
    );
    if (changed > 0) {
      repair.repaired.push({
        sprintId: row.id,
        from: row.end_date as string,
        to: anchor,
        anchor: anchorKind,
      });
    }
  }

  // Leave the marker unset after a failed write so a later close retries the whole repair.
  if (repair.failures.length === 0) {
    checkWrite(
      client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
        END_DATE_REPAIR_MARKER,
        ranAt,
      ]),
      repair.failures,
      `metadata.${END_DATE_REPAIR_MARKER}`
    );
  }
  return repair;
}

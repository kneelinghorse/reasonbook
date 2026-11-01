// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m04 — the nullable agent_feedback columns a shipped fix and a new row record: fixed_in, fix_rule and
// ABOUTME: reasonbook_version, added on the first write that needs them; two processes adding them at once both end with them.

import type { RbookDatabaseClient } from './client';
import { checkWrite } from './write-guard';

/**
 * The columns, in the order they are added. agent_feedback stays out of every exchange
 * (record-dashboard-share.ts STAYS_LOCAL), so no other copy's guard reads them, and the dashboard,
 * which receives the table only inside a whole-store upload, reads none of its columns.
 */
export const AGENT_FEEDBACK_FIX_COLUMNS = ['fixed_in', 'fix_rule', 'reasonbook_version'] as const;

/**
 * Add whichever of the columns the table lacks. Only writers call this: a read never changes the
 * store. A column another process added between the read and the ALTER is the same end state.
 */
export function ensureAgentFeedbackFixColumns(client: RbookDatabaseClient): {
  warnings: string[];
  /** Which of the columns the table has afterwards. */
  present: ReadonlySet<string>;
} {
  const warnings: string[] = [];
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(agent_feedback)');
  if (!columns.success) {
    warnings.push(
      `Could not read agent_feedback's columns (${columns.error?.message ?? 'the query failed'}).`
    );
    return { warnings, present: new Set() };
  }
  const have = new Set((columns.data ?? []).map((column) => column.name));
  const present = new Set<string>();
  for (const column of AGENT_FEEDBACK_FIX_COLUMNS) {
    if (have.has(column)) {
      present.add(column);
      continue;
    }
    const added = client.execute(`ALTER TABLE agent_feedback ADD COLUMN ${column} TEXT`, []);
    if (added.success || /duplicate column name/i.test(added.error?.message ?? '')) {
      present.add(column);
      continue;
    }
    checkWrite(added, warnings, `ALTER TABLE agent_feedback ADD COLUMN ${column}`);
  }
  return { warnings, present };
}

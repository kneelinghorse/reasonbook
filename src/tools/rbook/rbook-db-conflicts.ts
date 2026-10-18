// SPDX-License-Identifier: Apache-2.0
// ABOUTME: rbook_db conflicts and settle (s96-m12, ADR s96 §5): list each field that holds values from copies that had
// ABOUTME: not seen each other, with its candidates, and keep one of them; a settle syncs like any other change.

import { withClient } from './client';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';
import { carriedRefusal } from './replica-identity';
import { crossRecordFindings, type CheckFinding } from './record-checks';
import { openConflicts, settleField, type OpenConflict } from './record-settle';
import type { RbookToolResult } from './types';

export interface RbookDbConflictsResult {
  readonly conflicts: readonly OpenConflict[];
  readonly count: number;
  /** States across records that no one field names, such as two open sprints (ADR s96 §5). */
  readonly checks: readonly CheckFinding[];
  readonly message: string;
}

export interface RbookDbSettleResult {
  readonly table: string;
  readonly recordId: string | null;
  readonly field: string;
  readonly value: unknown;
  /** How many values the settle named as seen. */
  readonly candidates: number;
  readonly message: string;
}

export async function rbookDbConflicts(params: {
  projectRoot?: string;
}): Promise<RbookToolResult<RbookDbConflictsResult>> {
  return withClient(
    (client) => {
      const conflicts = openConflicts(client);
      const checks = crossRecordFindings(client);
      const states = checks.length
        ? ` ${checks.length} state(s) across records need a person: ${checks.map((check) => check.detail).join(' ')}`
        : '';
      return createSuccess({
        conflicts,
        count: conflicts.length,
        checks,
        message: `${
          conflicts.length
            ? `${conflicts.length} field(s) hold values from copies that had not seen each other.`
            : 'No field is in conflict.'
        }${states}`,
      });
    },
    { projectRoot: params.projectRoot, readonly: true }
  );
}

export async function rbookDbSettle(params: {
  table?: string;
  recordId?: string;
  field?: string;
  value?: unknown;
  projectRoot?: string;
}): Promise<RbookToolResult<RbookDbSettleResult>> {
  const missing = (['table', 'field'] as const).filter((name) => !params[name]);
  // A value of null is one to keep; only a value left out is missing.
  if (missing.length || params.value === undefined)
    return createError({
      code: 'MISSING_PARAMETER',
      message: `rbook_db settle needs table, field and value${missing.length ? `; missing ${missing.join(', ')}` : '; missing value'}.`,
      suggestion:
        'List what is in conflict with rbook_db(action="conflicts"), then pass that table, recordId and field with the value to keep.',
    });
  return withClient(
    (client) => {
      try {
        const settled = settleField(client, {
          table: params.table!,
          recordId: params.recordId ?? null,
          field: params.field!,
          value: params.value,
        });
        return createSuccess({
          table: settled.table,
          recordId: settled.recordId,
          field: settled.field,
          value: params.value,
          candidates: settled.candidates.length,
          message: `Settled ${settled.table}${settled.recordId ? ` ${settled.recordId}` : ''}'s ${settled.field}, naming its ${settled.candidates.length} values as seen.`,
        });
      } catch (error) {
        const refused = carriedRefusal(error);
        if (refused) return createError<RbookDbSettleResult>(refused);
        throw error;
      }
    },
    { projectRoot: params.projectRoot }
  );
}

const shownValue = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'null');

function failure(title: string, result: RbookToolResult<unknown>): string {
  const lines = [title, '', `Error: ${result.error?.message ?? 'Unknown error'}`];
  if (result.error?.suggestion) lines.push('', `Suggestion: ${result.error.suggestion}`);
  if (result.error?.validValues?.length)
    lines.push('', `Valid values: ${result.error.validValues.join(', ')}`);
  appendWarnings(lines, result);
  return lines.join('\n');
}

/** Each field in conflict with every candidate, and each state across records, for the reader. */
export function formatConflictsForLLM(result: RbookToolResult<RbookDbConflictsResult>): string {
  if (!result.success || !result.data) return failure('❌ Conflicts could not be listed', result);
  const { conflicts, checks } = result.data;
  const lines = [
    `**Conflicts**: ${conflicts.length ? `${conflicts.length} field(s) hold values from copies that had not seen each other` : 'no field is in conflict'}`,
  ];
  for (const conflict of conflicts) {
    const name = conflict.recordId
      ? `${conflict.table} ${conflict.recordId}`
      : 'the project identity';
    lines.push(
      `  - ${name}'s ${conflict.field}: reads show ${shownValue(conflict.provisional)}${conflict.ownerOnly ? "; only the owner's copy settles it" : ''}`
    );
    for (const candidate of conflict.candidates)
      lines.push(
        `      ${shownValue(candidate.value)}${candidate.author ? ` (${candidate.author})` : ''}`
      );
  }
  if (checks.length) {
    lines.push('', `**States across records**: ${checks.length} need a person`);
    for (const check of checks) lines.push(`  - ${check.detail}`);
  }
  if (conflicts.length)
    lines.push('', 'Keep one value with rbook_db(action="settle", table, recordId, field, value).');
  appendWarnings(lines, result);
  return lines.join('\n');
}

export function formatSettleForLLM(result: RbookToolResult<RbookDbSettleResult>): string {
  if (!result.success || !result.data) return failure('❌ Settle refused', result);
  const lines = [`✓ ${result.data.message}`];
  appendWarnings(lines, result);
  return lines.join('\n');
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Decide correction, retry and revert outcomes while holding the decision writer's lock.
// ABOUTME: Guard successor updates so correction history is never redirected or made cyclic.

import type { RbookDatabaseClient } from './client';
import { storedDecisionFields, type DecisionFieldsParams } from './decision-fields';
import { changedDecisionFields, findExistingDecisionId } from './decision-write';
import { createError, createSuccess } from './errors';
import { recordedExecute } from './record-changes';
import { requireRecordLinks } from './record-link-write';
import type { RbookToolResult } from './types';
import { checkWrite, type WriteSink } from './write-guard';

interface DecisionState extends Record<string, unknown> {
  id: number;
  status: string;
  superseded_by: number | null;
}

export interface SupersededEcho {
  id: number;
  previousStatus: string;
  newStatus: 'superseded';
}

interface CorrectionPlan {
  existingId?: number;
  successorId?: number;
  targets: DecisionState[];
}

function readDecision(client: RbookDatabaseClient, id: number): DecisionState | undefined {
  const row = client.getOne<DecisionState>('SELECT * FROM strategic_decisions WHERE id = ?', [id]);
  if (!row.success) throw new Error(row.error?.message ?? 'Could not read decision state.');
  return row.data;
}

function refusal(id: number, message: string, successor?: number | null): RbookToolResult<never> {
  return createError({
    code: 'INVALID_PARAMETER',
    field: 'supersedes',
    providedValue: id,
    message,
    currentState: { decisionId: id, supersededBy: successor ?? null },
    suggestion:
      'Read the current decisions with rbook_decisions(action="list") and correct the current successor; nothing was written.',
  });
}

/** Must run inside the same immediate transaction as the INSERT and successor UPDATEs. */
export function prepareDecisionCorrection(
  client: RbookDatabaseClient,
  content: string,
  authorSessionId: string | null,
  fields: DecisionFieldsParams,
  supersedes: readonly number[],
  warnings: string[]
): RbookToolResult<CorrectionPlan> {
  if (!client.inWriteTransaction) throw new Error('Decision correction requires a write lock.');
  let existingId = findExistingDecisionId(
    client,
    content,
    authorSessionId,
    fields,
    supersedes.length === 0
  );
  const targets: DecisionState[] = [];
  for (const id of supersedes) {
    const target = readDecision(client, id);
    if (!target) return refusal(id, `supersedes names decision #${id}, which does not exist`);
    targets.push(target);
  }
  let successorId: number | undefined;
  if (existingId !== undefined) {
    const existing = readDecision(client, existingId)!;
    const changed = changedDecisionFields(existing, storedDecisionFields(fields));
    if (changed.length)
      warnings.push(
        `Decision #${existingId} already exists; changed fields ${changed.join(', ')} were not written. Record a superseding decision to change its reasoning or mode.`
      );
    if (targets.some((row) => row.id === existingId))
      return refusal(existingId, `Decision #${existingId} cannot supersede itself`);

    if (existing.status === 'superseded' && targets.some((row) => row.superseded_by === null)) {
      // A revert is a fresh occurrence of an older choice, never resurrection of its old row.
      existingId = undefined;
    } else if (
      existing.status !== 'active' &&
      targets.length > 0 &&
      !targets.every((row) => row.superseded_by === existingId)
    ) {
      return refusal(
        existing.id,
        `Decision #${existing.id} is no longer active`,
        existing.superseded_by
      );
    }

    if (existingId !== undefined) {
      const seen = new Set<number>([existingId]);
      let next = existing.superseded_by;
      while (next !== null) {
        if (seen.has(next))
          return refusal(existingId, `Decision #${existingId} has a cyclic successor chain`, next);
        if (targets.some((row) => row.id === next))
          return refusal(
            next,
            `Decision #${next} is in decision #${existingId}'s successor chain`,
            next
          );
        seen.add(next);
        successorId = next;
        const successor = readDecision(client, next);
        if (!successor) throw new Error(`Decision #${next} in the successor chain is missing.`);
        next = successor.superseded_by;
      }
    }
  }
  for (const target of targets) {
    if (target.superseded_by !== null && target.superseded_by !== existingId)
      return refusal(
        target.id,
        `Decision #${target.id} already points to successor #${target.superseded_by}; history cannot be redirected`,
        target.superseded_by
      );
  }
  return createSuccess({ existingId, successorId, targets });
}

/** Both inserted and reused decisions use this guarded writer; receipts contain actual changes. */
export function applyDecisionCorrection(
  client: RbookDatabaseClient,
  decisionId: number,
  targets: readonly DecisionState[],
  writeSink: WriteSink
): SupersededEcho[] {
  const changed: SupersededEcho[] = [];
  for (const target of targets) {
    if (target.superseded_by === decisionId && target.status === 'superseded') continue;
    const updated = recordedExecute(
      client,
      `UPDATE strategic_decisions SET status = 'superseded', superseded_by = ?
       WHERE id = ? AND (superseded_by IS NULL OR superseded_by = ?)`,
      [decisionId, target.id, decisionId]
    );
    if (
      !checkWrite(updated, writeSink, `strategic_decisions.supersede#${target.id}`) ||
      updated.data?.changes !== 1
    )
      throw new Error(
        `Decision #${target.id} could not be superseded; the transaction was rolled back.`
      );
    requireRecordLinks(client, 'decision', target.id);
    changed.push({ id: target.id, previousStatus: target.status, newStatus: 'superseded' });
  }
  return changed;
}

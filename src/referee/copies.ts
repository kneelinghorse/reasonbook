// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What the referee hands out and how it upgrades (s97-m09, design §R1): a member's first copy and the page
// ABOUTME: importer's snapshot, each a fresh store with only the shared record, and the engine's migrations on the store.

import { createError, createSuccess } from '../tools/rbook/errors';
import { buildFreshCopy, type FreshCopy } from '../tools/rbook/record-fresh-copy';
import { repairRecordGuards } from '../tools/rbook/record-changes';
import { mergeContext } from '../tools/rbook/record-standing';
import { guardRefusal } from '../tools/rbook/replica-check';
import { sharingSchemaBehind } from '../tools/rbook/schema-migrations';
import { prepareForSharing } from '../tools/rbook/sharing-preconditions';
import { REPLICA_ERROR_CODES } from '../tools/rbook/replica-identity';
import { attachWarnings } from '../tools/rbook/format-warnings';
import type { RbookToolResult } from '../tools/rbook/types';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import { withReferee, type RefereeLocation, type RefereeOutcome } from './open';

function copyOut(location: RefereeLocation, destPath: string): Promise<RefereeOutcome<FreshCopy>> {
  return withReferee(location, async ({ client, joining }) => {
    // Only the record's authority hands out copies: one made mid-move would hold the move unconfirmed,
    // and its member's writes would never reach the referee (critics, round 2).
    const ctx = joining ? null : mergeContext(client);
    if (!ctx || ctx.ownReplica !== ctx.authority || ctx.pending)
      return refuse<FreshCopy>({
        code: REFEREE_ERROR_CODES.NOT_READY,
        message:
          "This project's referee has not taken over the record yet, so it hands out no copy.",
        suggestion: "Finish the handover in from the owner's copy first.",
      });
    if (typeof destPath !== 'string' || !destPath)
      return refuse<FreshCopy>({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message: 'A copy needs a file to be written to.',
        suggestion: 'Pass destPath.',
      });
    const built = await buildFreshCopy(location.storePath, destPath);
    return createSuccess(built, [...built.warnings]);
  });
}

/** A member's first copy (D5): a fresh store holding the shared record as the referee holds it, ready to join. */
export function makeFirstCopy(
  location: RefereeLocation,
  destPath: string
): Promise<RefereeOutcome<FreshCopy>> {
  return copyOut(location, destPath);
}

/** The input to the dashboard's page importer (D7): the same fresh store, made after each accepted exchange. */
export function exportSnapshot(
  location: RefereeLocation,
  destPath: string
): Promise<RefereeOutcome<FreshCopy>> {
  return copyOut(location, destPath);
}

/**
 * Run the engine's migrations on the referee store (D1: at each deploy): the sharing schema brought to
 * this version's shape, and the guards rebuilt when this version records other columns.
 */
export function migrate(
  location: RefereeLocation
): Promise<RefereeOutcome<{ readonly schema: string | null; readonly guardsRebuilt: boolean }>> {
  return withReferee(
    location,
    ({ client }) => {
      // The migrations that bring the store to this version say what they did on the answer.
      const warnings: string[] = [];
      const result = ((): RbookToolResult<{
        readonly schema: string | null;
        readonly guardsRebuilt: boolean;
      }> => {
        const behind = sharingSchemaBehind(client);
        if (behind) {
          const readiness = prepareForSharing(client);
          warnings.push(...readiness.warnings);
          if (!readiness.ready)
            return refuse({
              code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
              message: `The referee store cannot be brought to this version: ${readiness.problems.join(' ')}`,
              suggestion: 'Mark the project as needing recovery.',
            });
        }
        const broken = guardRefusal(client);
        if (broken && broken.code !== REPLICA_ERROR_CODES.GUARD_BROKEN) return createError(broken);
        if (broken) {
          const repaired = client.writeTransaction(() => repairRecordGuards(client));
          if (!repaired.success) return createError(repaired.error!);
        }
        return createSuccess({ schema: behind, guardsRebuilt: Boolean(broken) });
      })();
      return attachWarnings(result, warnings);
    },
    { repairing: true }
  );
}

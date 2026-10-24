// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Translate hosted-store repair remedies into actions the calling member can take.
// ABOUTME: Peer answers retain their codes and diagnostics; host-only library calls keep their original remedies.
import type { RbookToolResult } from '../tools/rbook/types';
import { REPLICA_ERROR_CODES } from '../tools/rbook/replica-identity';
import { REFEREE_ERROR_CODES } from './codes';

/** These refusals are authored for the peer's caller, rather than for the host's store operator. */
const MEMBER_CODES: ReadonlySet<string> = new Set([
  REFEREE_ERROR_CODES.NOT_A_MEMBER,
  REFEREE_ERROR_CODES.REMOVED,
  REFEREE_ERROR_CODES.METHOD_REFUSED,
  REFEREE_ERROR_CODES.FORGED_REPLICA,
  REFEREE_ERROR_CODES.OWNER_ONLY,
  REFEREE_ERROR_CODES.FORGED_RENUMBER,
  REFEREE_ERROR_CODES.MALFORMED,
  REFEREE_ERROR_CODES.PROTOCOL_NEWER,
  REFEREE_ERROR_CODES.READS_OLD_PROTOCOL,
  REFEREE_ERROR_CODES.CLOCK_AHEAD,
  REFEREE_ERROR_CODES.NAME_TAKEN,
]);

const HOST_REMEDIES: ReadonlyMap<string, string> = new Map([
  [
    REPLICA_ERROR_CODES.COPY_TOO_OLD,
    "Upgrade this owner's copy to Reasonbook 4.5.0 or later, then retry reasonbook move --to owner. The dashboard still holds authority and the set-aside cuts.",
  ],
  [
    REFEREE_ERROR_CODES.NEEDS_RECOVERY,
    "Keep your local copy. Ask the project's owner to open its page on the dashboard and contact the dashboard operator about recovery; sync again after recovery is complete.",
  ],
  [
    REFEREE_ERROR_CODES.MIGRATE_NEEDED,
    "Ask the dashboard operator to upgrade and migrate this project's hosted record, then sync again. Your local copy keeps its changes.",
  ],
  [
    REFEREE_ERROR_CODES.FAILED,
    'Retry syncing in a few minutes. If it still fails, contact the dashboard operator with this error code and message.',
  ],
  [
    REFEREE_ERROR_CODES.HEAD_REQUIRED,
    "Retry syncing. If it still fails, ask the dashboard operator to check the project's recorded stream head.",
  ],
  [
    REFEREE_ERROR_CODES.NOT_READY,
    "Ask the project's owner to check its handover state on the dashboard, then sync and retry the action.",
  ],
]);

/** Apply once after withReferee, including its early refusals and any error a step returned or threw. */
export function memberAnswer<T>(result: RbookToolResult<T>): RbookToolResult<T> {
  if (result.success || !result.error || MEMBER_CODES.has(result.error.code)) return result;
  return {
    ...result,
    error: {
      ...result.error,
      suggestion:
        HOST_REMEDIES.get(result.error.code) ??
        "Sync again; if the refusal remains, send this error code and message to the project's owner or the dashboard operator so they can resolve it.",
    },
  };
}

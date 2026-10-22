// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The dashboard's owner administration API sets aside one copy using the referee's own call observation.
// ABOUTME: Recent calls require explicit confirmation; peer dispatch never exposes this operation.
import { setAsideReplica, type SetAsideReport } from '../tools/rbook/record-set-aside';
import { ReplicaRefusal } from '../tools/rbook/replica-identity';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import { withReferee, type RefereeLocation, type RefereeOutcome } from './open';

export type HostedSetAsideReport = SetAsideReport & { readonly lastCallAt: string | null };
export type { SetAsideReport };

/** The host authorizes its owner before calling, as for remove/setRole; caller reports never set last_call_at. */
export function setAside(
  location: RefereeLocation,
  input: { readonly replicaId: string; readonly confirmGone?: boolean }
): Promise<RefereeOutcome<HostedSetAsideReport>> {
  return withReferee(location, ({ client, joining }) => {
    if (joining)
      return refuse({
        code: REFEREE_ERROR_CODES.NOT_READY,
        message: 'The referee has not joined this record yet.',
        suggestion: 'Finish the handover before setting aside a copy.',
      });
    if (input?.confirmGone !== undefined && typeof input.confirmGone !== 'boolean')
      return refuse({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message: 'confirmGone must be a boolean.',
        suggestion: 'Review the copy and pass confirmGone: true only if it is gone.',
      });
    return client.writeTransaction(() => {
      const preview = setAsideReplica(client, { replicaId: input?.replicaId, dryRun: true });
      if (!preview.success || !preview.data) throw new ReplicaRefusal(preview.error!);
      const observation = client.getOne<{ last_call_at: string | null }>(
        'SELECT last_call_at FROM referee_copies WHERE replica_id = ?',
        [input.replicaId]
      );
      if (!observation.success)
        throw new Error(
          observation.error?.message ?? "The referee could not read this copy's last call."
        );
      const lastCallAt = observation.data?.last_call_at ?? null;
      const last = lastCallAt === null ? null : storedTimeMs(lastCallAt);
      if (last !== null && !Number.isFinite(last))
        throw new ReplicaRefusal({
          code: REFEREE_ERROR_CODES.FAILED,
          message: 'The referee has an unreadable last-call observation for this copy.',
          suggestion:
            'Ask the host to repair the observed last-call value, then review this copy again.',
        });
      if (last !== null && Date.now() - last < 7 * 86400000 && input.confirmGone !== true)
        throw new ReplicaRefusal({
          code: REFEREE_ERROR_CODES.METHOD_REFUSED,
          message: `${preview.data.memberName}'s copy called the referee at ${lastCallAt}, within the last seven days, so it was not set aside.`,
          suggestion:
            'Check that this is the copy that is gone, then confirm with confirmGone: true.',
        });
      const applied = setAsideReplica(client, { replicaId: input.replicaId, dryRun: false });
      if (!applied.success || !applied.data) throw new ReplicaRefusal(applied.error!);
      return { ...applied.data, lastCallAt };
    });
  });
}

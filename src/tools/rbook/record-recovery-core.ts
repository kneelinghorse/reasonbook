// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The shared recovery write step takes complete collected logs into a new replica and authority term.
// ABOUTME: Direct and hosted recovery validate their own trust inputs before this step records cuts and rejudges.
import { monotonicFactory } from 'ulid';
import type { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { applyRemote, replicaMarks } from './record-apply';
import type { AuthorityValue } from './record-authority';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { judgeUnjudged } from './record-judge';
import { recomputeEntities } from './record-recompute';
import { mergeContext, REPLICA_ENTITY, type LoggedChange } from './record-standing';
import type { Opener } from './record-sync';
import { underApplyToken } from './record-token';
import { reidentifyReplica, replicaWriteRefusal } from './replica-check';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import type { RbookToolResult } from './types';

const mintReplicaId = monotonicFactory();

export interface RecoveryCoreInput {
  readonly previous: string;
  readonly block: number;
  readonly ownerName: string | null;
  readonly members: readonly string[];
  readonly cuts: (client: RbookDatabaseClient) => Readonly<Record<string, number>>;
  /** Hosted recovery's externally verified authority prefix; direct recovery adopts its whole prefix. */
  readonly cut?: number;
  /** Only the hosted caller supplies owner-confirmed membership, before any transaction is judged. */
  readonly beforeJudge?: (client: RbookDatabaseClient) => void;
  /** A hosted cut can invalidate an old verdict or materialized row already present in its base. */
  readonly recomputeAll?: boolean;
}

export interface RecoveryCoreReport {
  readonly value: AuthorityValue;
  readonly collected: number;
  readonly judged: number;
}

export async function recoverAuthorityCore(
  self: Opener,
  collectedFrom: readonly (readonly LoggedChange[])[],
  input: RecoveryCoreInput,
  registry: ProjectGraphRegistry
): Promise<RbookToolResult<RecoveryCoreReport>> {
  const replicaId = mintReplicaId();
  const made = await self((client) => {
    return client.writeTransaction(() => {
      reidentifyReplica(
        client,
        { block: input.block, authorityReceived: null, replicaId },
        registry
      );
      if (input.ownerName) writeCopyKey(client, COPY_KEYS.author, input.ownerName);
      return replicaWriteRefusal(client);
    });
  });
  if (!made.success) return createError(made.error!);
  if (made.data) return createError(made.data);
  let collected = 0;
  for (const changes of collectedFrom) {
    const applied = await self((client) => applyRemote(client, changes, { judge: false }));
    if (!applied.success || !applied.data) return createError(applied.error!);
    collected += applied.data.stored;
  }
  const recorded = await self((client) => {
    return client.writeTransaction(() => {
      const ctx = mergeContext(client);
      const available = ctx.prefixes.get(input.previous) ?? 0;
      const cut = input.cut ?? available;
      if (!Number.isSafeInteger(cut) || cut < 0 || cut > available)
        throw new Error('The verified recovery cut is outside the collected prefix.');
      const cuts = input.cuts(client);
      const value: AuthorityValue = {
        epoch: ctx.epoch + 1,
        authority: ctx.ownReplica,
        previous: input.previous,
        move: 'recovery',
        block: input.block,
        cut,
        ...(Object.keys(cuts).length ? { dropped: cuts } : {}),
        members: input.members,
      };
      recordOwnChanges(
        client,
        [
          {
            kind: 'authority',
            entity: REPLICA_ENTITY,
            entityId: ctx.ownReplica,
            field: null,
            value: canonicalJson(value),
          },
        ],
        {
          recoveryContext: {
            ...ctx,
            terms: ctx.terms.map((term) =>
              term.replicaId === input.previous ? { ...term, cut: Math.min(term.cut, cut) } : term
            ),
          },
        }
      );
      return underApplyToken(client, () => {
        input.beforeJudge?.(client);
        const judged = judgeUnjudged(client);
        const changed = client.getMany<{ txn_id: string }>(
          input.recomputeAll
            ? 'SELECT DISTINCT txn_id FROM record_changes'
            : 'SELECT DISTINCT txn_id FROM record_changes WHERE replica_id IN (SELECT value FROM json_each(?))',
          input.recomputeAll ? [] : [JSON.stringify(Object.keys(cuts))]
        );
        if (!changed.success)
          throw new Error(changed.error?.message ?? 'Recovery transactions could not be read.');
        recomputeEntities(
          client,
          mergeContext(client),
          new Set([...judged, ...(changed.data ?? []).map((row) => row.txn_id)]),
          new Set()
        );
        return { value, judged: judged.length };
      });
    });
  });
  if (!recorded.success || !recorded.data) return createError(recorded.error!);
  return createSuccess({ ...recorded.data, collected });
}

/** A copy's cut is its gap-free collected prefix; an absent copy starts at zero. */
export function recoveryCuts(
  client: RbookDatabaseClient,
  copies: readonly string[]
): Record<string, number> {
  const marks = replicaMarks(client);
  return Object.fromEntries(copies.map((replica) => [replica, marks[replica] ?? 0]));
}

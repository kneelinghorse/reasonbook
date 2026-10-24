// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bind a reader report to this record and an admitted copy's current or historical term.
// ABOUTME: A removed historical member may report an upgrade without receiving changes or claiming its move arrived.
import type { RbookDatabaseClient } from './client';
import { copyReport } from './record-copy-report';
import { authorityValue } from './record-authority';
import { setAsideCut } from './record-member-cuts';
import type { Hello } from './record-exchange-types';
import { mergeContext } from './record-standing';
import { recordedProjectId } from './replica-identity';

export function boundHello(
  client: RbookDatabaseClient,
  near:
    | Pick<Hello, 'projectId' | 'replicaId' | 'authority' | 'epoch' | 'reads' | 'libraryVersion'>
    | undefined
) {
  if (!near || near.projectId !== recordedProjectId(client)) return null;
  const ctx = mergeContext(client);
  const unseen = ctx.unseen.get(near.replicaId);
  const member = ctx.members.get(near.replicaId) ?? unseen;
  if (!member || near.replicaId === ctx.ownReplica) return null;
  const current = near.epoch === ctx.epoch && near.authority === ctx.authority;
  const historical =
    near.epoch < ctx.epoch &&
    ctx.terms.some((term) => term.epoch === near.epoch && term.replicaId === near.authority);
  if (!current && !historical) return null;
  const formerOwner =
    historical &&
    ctx.terms.some((term) => term.epoch === near.epoch && term.replicaId === near.replicaId);
  const permanent =
    setAsideCut(ctx, near.replicaId) !== undefined ||
    ctx.terms.some(
      (term) =>
        (term.replicaId === near.replicaId && term.ended === 'recovery') ||
        (term.change &&
          Object.prototype.hasOwnProperty.call(
            authorityValue(term.change).dropped ?? {},
            near.replicaId
          ))
    );
  return {
    current,
    // Removal may prevent learning the current epoch. Its validated reader report still proves
    // an upgrade for re-invitation; it grants no delivery, role, identity or arrival claim.
    reportable: current || (historical && !unseen && member.role === 'removed' && !permanent),
    report: copyReport(near),
    // A proved unseen join may report its reader for re-invitation, never receive ordinary streams.
    blocked:
      Boolean(unseen) || member.role === 'removed' || (member.cut !== undefined && !formerOwner),
  };
}

/** Read capacity for a historical catch-up only; this never establishes a current report. */
export function historicalCatchUpReport(
  client: RbookDatabaseClient,
  near: Parameters<typeof boundHello>[1]
) {
  if (
    !near ||
    near.projectId !== recordedProjectId(client) ||
    typeof near.replicaId !== 'string' ||
    !near.replicaId.trim()
  )
    return null;
  const ctx = mergeContext(client);
  if (
    ctx.ownReplica !== ctx.authority ||
    near.replicaId === ctx.ownReplica ||
    !(near.epoch < ctx.epoch) ||
    !ctx.terms.some((term) => term.epoch === near.epoch && term.replicaId === near.authority)
  )
    return null;
  const member = ctx.members.get(near.replicaId) ?? ctx.unseen.get(near.replicaId);
  const formerOwner = near.replicaId === near.authority;
  if (member?.role === 'removed' || (member?.cut !== undefined && !formerOwner)) return null;
  return copyReport(near);
}

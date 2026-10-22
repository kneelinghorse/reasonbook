// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reconcile carried record members against authenticated host grants after a re-share.
// ABOUTME: Wait until the referee holds authority and refuse peer work when reconciliation fails.
import path from 'path';
import type { Caller, RefereeOutcome } from '../../src/referee';
import type { Hello } from '../../src/tools/rbook/record-exchange';
import type { HostState, RefereeEngine, RefereeServerConfig } from './referee-server-state';

/** Called inside the host's project queue, before the incoming peer call can judge a write. */
export async function reconcileCarriedMembers(
  host: HostState,
  engine: RefereeEngine,
  config: RefereeServerConfig,
  id: string,
  caller: Caller
): Promise<RefereeOutcome<unknown> | null> {
  const project = host.state.get(id)!;
  const revoked = project.members.filter(
    (member) =>
      member.role !== 'removed' &&
      member.accountId !== config.projects[id].ownerAccountId &&
      !project.grants.has(member.accountId)
  );
  if (!revoked.length) return null;
  const checked = await engine.peer(host.locate(id), 'hello', {}, caller);
  if (checked.head) host.rememberHead(project, checked.head);
  if (!checked.result.success) return checked;
  const hello = checked.result.data as Partial<Hello> | undefined;
  if (
    !hello ||
    typeof hello.replicaId !== 'string' ||
    !hello.replicaId ||
    typeof hello.authority !== 'string' ||
    !hello.authority ||
    !(
      hello.pending === null ||
      (typeof hello.pending === 'object' && !Array.isArray(hello.pending))
    )
  )
    return {
      result: {
        success: false,
        error: {
          code: engine.REFEREE_ERROR_CODES.FAILED,
          message:
            'The referee did not report its authority, so carried membership was not reconciled.',
          suggestion:
            'Retry after checking the installed referee engine; no peer request was served.',
        },
      },
      head: checked.head,
    };
  // The outgoing owner is still the authority during hand-in, and again during a move back.
  if (hello.replicaId !== hello.authority || hello.pending !== null) return null;
  for (const member of revoked) {
    const removed = await engine.remove(host.locate(id), { accountId: member.accountId });
    if (removed.head) host.rememberHead(project, removed.head);
    if (!removed.result.success) return removed;
    project.members = project.members.map((known) =>
      known.memberId === member.memberId ? { ...known, role: 'removed' } : known
    );
  }
  host.save();
  return null;
}

/** Archive only the referee whose successful final exchange proved the move back finished. */
export async function archiveMovedBack(
  host: HostState,
  engine: RefereeEngine,
  config: RefereeServerConfig,
  id: string,
  outcome: RefereeOutcome<unknown>
): Promise<void> {
  const archived = await host.serialized(id, () =>
    engine.archiveReferee(
      host.locate(id),
      path.join(config.root, 'archive', id, `${Date.now()}.sqlite`)
    )
  );
  if (!archived.result.success) return;
  const project = host.state.get(id)!;
  if (outcome.head && !project.formerRefereeReplicaIds.includes(outcome.head.replicaId))
    project.formerRefereeReplicaIds.push(outcome.head.replicaId);
  project.shared = false;
  project.head = null;
  project.needsRecovery = null;
  host.save();
}

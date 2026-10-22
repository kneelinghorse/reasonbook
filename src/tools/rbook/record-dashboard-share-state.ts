// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Dashboard sharing's local preflight and pending-answer state keep resumed shares bound to their project.
// ABOUTME: Retained referee provenance admits former dashboard members while direct and unproved members refuse.

import { getSetting } from '../../intelligence/legacy-compat';
import { RBOOK_CHECKPOINT_SYNC_ENV } from './checkpoint-backfill';
import type { RbookDatabaseClient } from './client';
import { resolveDashboardBaseUrl } from './dashboard-client';
import { formerDashboardReferees } from './record-dashboard-history';
import type { JoinAnswer } from './record-join';
import { namedCopies, ownersOtherCopies } from './record-owner-copies';
import { membersOutsideRefereeTerms } from './record-referee-members';
import { isRecordedStore } from './record-recording';
import { mergeContext } from './record-standing';
import { refereeingDashboard } from './record-wire';
import { COPY_KEYS } from './replica-copy-keys';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError } from './types';

/** The join answer this copy gave the referee, kept until the referee applies it (#1494). */
export interface PendingShare {
  readonly projectId: string;
  readonly refereeReplica: string;
  readonly answer: JoinAnswer;
}

export function pendingOf(client: RbookDatabaseClient): PendingShare | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    COPY_KEYS.dashboardShare,
  ]);
  try {
    return row.data?.value ? (JSON.parse(row.data.value) as PendingShare) : null;
  } catch {
    return null;
  }
}

/** An answer kept for a referee that has held the record already, as before a move back: spent. */
export function spent(client: RbookDatabaseClient, pending: PendingShare): boolean {
  return (
    isRecordedStore(client) &&
    !refereeingDashboard(client) &&
    mergeContext(client).terms.some((term) => term.replicaId === pending.refereeReplica)
  );
}

/** Why this copy cannot be shared through the dashboard, or null; and the project id it is routed by. */
export function shareProblem(
  client: RbookDatabaseClient,
  projectId: string | undefined,
  pending: PendingShare | null,
  uploadsNothing: 'off' | 'signed-out' | null
): RbookToolError | { readonly projectId: string } {
  const known =
    projectId ??
    client.getOne<{ value: string }>(
      "SELECT value FROM metadata WHERE key = 'dashboard_project_id'"
    ).data?.value;
  if (isRecordedStore(client)) {
    if (refereeingDashboard(client)) {
      // A share that stopped after its handover, its answer still kept, is finished by sharing
      // again: this copy is the owner's member copy by then (critics, round 1).
      if (pending) return { projectId: pending.projectId };
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: 'This project is shared through the dashboard already.',
        suggestion: 'Sync it: reasonbook sync.',
      };
    }
    const ctx = mergeContext(client);
    const former = known
      ? formerDashboardReferees(client, {
          kind: 'dashboard',
          url: new URL(resolveDashboardBaseUrl()).origin,
          projectId: known,
        })
      : [];
    const others = membersOutsideRefereeTerms(client, former);
    if (others.length)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `This project is shared directly with ${others.map((member) => member.name).join(', ')}, whose admission is not proved to belong to this dashboard's former referee, so nothing was shared.`,
        suggestion:
          'Keep sharing directly. If an older client erased the dashboard route history, restore a copy that retains it; otherwise explicitly remove those direct members before sharing (their copies keep what they hold).',
      };
    // s100-m01: the owner's other copies would be left unable to sync, with what they hold.
    const copies = ownersOtherCopies(client).filter(
      (copy) => copy.replicaId !== pending?.refereeReplica
    );
    if (copies.length)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `This project is also kept in ${namedCopies(copies)}, and a share through the dashboard would leave ${copies.length === 1 ? 'it' : 'each'} unable to sync, so nothing was shared.`,
        suggestion: `Sharing through the dashboard does not take your other copies along yet. Keep sharing it directly while those copies are in use. If a copy is gone, preview setting it aside on the authority owner's copy: reasonbook set-aside --replica ${copies[0].replicaId}. Only after the person decides it is gone, repeat with --yes; then share again.`,
      };
    if (ctx.ownReplica !== ctx.authority)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: "Only the owner's copy shares the project, and this copy is a member's.",
        suggestion: "Share it from the owner's copy.",
      };
  }
  if (!known) return notUploaded(uploadsNothing);
  return { projectId: known };
}

/** Why a project the dashboard does not hold yet is not there, and the step that puts it there. */
function notUploaded(uploadsNothing: 'off' | 'signed-out' | null): RbookToolError {
  const close =
    'rbook_session(action="start", type="custom", title="Share through the dashboard"), then rbook_session(action="complete", summary="Uploaded to share it")';
  // s100-m02 (the s97 review's finding 7): a close uploads nothing signed out or with uploads off,
  // so prescribing one alone left the next share refused the same way.
  if (uploadsNothing === 'signed-out')
    return {
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This project is not on the dashboard yet, and this machine is not signed in to it, so nothing has uploaded it there.',
      suggestion: `Sign in on this machine first: rbook_auth(action="login_init"), then rbook_auth(action="login_complete"). An explicit session close then uploads it: ${close}; share again once that upload is done, a few seconds later.`,
    };
  if (uploadsNothing === 'off')
    return {
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `This project is not on the dashboard yet, and uploads are off on this machine (${RBOOK_CHECKPOINT_SYNC_ENV}=${getSetting(RBOOK_CHECKPOINT_SYNC_ENV)}), so nothing puts it there.`,
      suggestion: `A project is shared through the dashboard only once it has been uploaded there, and turning uploads on is the person's setting to decide on, not an agent's. With ${RBOOK_CHECKPOINT_SYNC_ENV} unset where Reasonbook runs, an explicit session close on this machine, signed in, uploads it: ${close}; then share again.`,
    };
  return {
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: 'This project is not on the dashboard yet, so it has no address there.',
    suggestion: `An explicit session close uploads it there: ${close}, on this machine signed in; share again once that upload is done, a few seconds later.`,
  };
}

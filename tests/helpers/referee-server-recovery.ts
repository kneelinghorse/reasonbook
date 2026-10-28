// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Host the reference recovery routes, keeping uploads immutable and confirmation owner-only.
// ABOUTME: Keep transport identity and record identity distinct while using the stateless library API.
import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import type { RecoveryPlanInput, RbookToolResult } from '../../src/referee';
import { json } from './referee-server-http';
import {
  moveLostStore,
  type HostState,
  type RefereeEngine,
  type RefereeServerConfig,
} from './referee-server-state';

interface Route {
  readonly area: string;
  readonly rest: string;
  readonly method: string;
  readonly url: URL;
  readonly projectId: string;
  readonly account: string;
  readonly owner: boolean;
  readonly incoming: Buffer;
  readonly parsed: Record<string, unknown>;
  readonly response: http.ServerResponse;
}
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
export function recoveryOffer(
  host: HostState,
  engine: RefereeEngine,
  projectId: string
): RbookToolResult<never> | null {
  const attempt = host.state.get(projectId)!.recovery;
  if (attempt?.state === 'cancelled')
    return {
      success: false,
      error: {
        code: engine.REFEREE_ERROR_CODES.NEEDS_RECOVERY,
        message: 'The owner cancelled this recovery attempt.',
        suggestion:
          'Keep writing locally. The owner can deliberately start a new recovery attempt on the dashboard.',
        currentState: {
          recoveryId: attempt.recoveryId,
          state: 'cancelled',
          projectId,
          lostHead: attempt.lostHead,
        },
      },
    };
  return attempt?.state === 'collecting'
    ? engine.recoveringAnswer({
        recoveryId: attempt.recoveryId,
        projectId,
        lostHead: attempt.lostHead,
      })
    : null;
}

export async function recoveryRoute(
  route: Route,
  host: HostState,
  engine: RefereeEngine,
  config: RefereeServerConfig
): Promise<boolean> {
  const { area, rest, method, projectId, owner, account, response } = route;
  if (!(rest === 'recovery' || rest.startsWith('recovery/'))) return false;
  const project = host.state.get(projectId)!;
  const answer = (result: RbookToolResult<unknown>) =>
    json(response, engine.refereeStatus(result), result);
  const bad = (message: string, code = 'REFEREE_MALFORMED') =>
    answer({
      success: false,
      error: {
        code,
        message,
        suggestion: 'Read the current recovery plan and retry the named attempt.',
      },
    });
  const location = () => ({ ...host.locate(projectId), projectId: project.recordProjectId! });
  const snapshot = () => {
    const file = path.join(config.root, 'snapshots', projectId, `${randomUUID()}.sqlite`);
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(host.storeOf(projectId), { readonly: true, fileMustExist: true });
    try {
      db.prepare('VACUUM INTO ?').run(file);
    } finally {
      db.close();
    }
    return { file, takenAt: new Date().toISOString() };
  };
  await host.serialize(projectId, async () => {
    if (area === 'test') {
      if (!owner || method !== 'POST')
        return bad('This control belongs to the owner.', 'REFEREE_NOT_A_MEMBER');
      if (rest === 'recovery/snapshot') {
        if (project.recovery?.state === 'collecting') return bad('The referee is recovering.');
        const saved = snapshot();
        project.snapshots.push(saved);
        host.save();
        return answer({ success: true, data: { ...saved, head: project.head } });
      }
      if (rest === 'recovery/lose') {
        const file = moveLostStore(config.root, projectId, host.storeOf(projectId));
        return answer({ success: true, data: { file, head: project.head } });
      }
      return bad('No such recovery control.');
    }
    if (area !== 'relay') return bad('No such recovery route.');
    let attempt = project.recovery;
    if (!attempt) return bad('This project has no recovery attempt.', 'REFEREE_NOT_READY');
    const requestedId =
      method === 'POST' && rest === 'recovery/confirm'
        ? route.parsed.recoveryId
        : route.url.searchParams.get('recoveryId');
    if (method !== 'GET' && requestedId !== attempt.recoveryId)
      return bad('That recovery attempt is no longer current.', 'REFEREE_NOT_READY');
    if (rest === 'recovery/copy' && method === 'POST') {
      if (attempt.state === 'cancelled' && owner) {
        const next = host.beginRecovery(projectId);
        if (!next)
          return bad(
            'Membership is unconfirmed after a possibly committed recovery. The host must reconcile the published referee and refresh its census before starting another attempt.',
            'REFEREE_NOT_READY'
          );
        attempt = next;
      }
      if (attempt.state !== 'collecting')
        return bad('That recovery is not collecting copies.', 'REFEREE_NOT_READY');
      const replicaId = route.url.searchParams.get('replicaId');
      if (!replicaId) return bad('Name the uploading copy replicaId.');
      const prior = attempt.uploads.find((upload) => upload.receipt.replicaId === replicaId);
      if (prior) {
        if (prior.accountId !== account)
          return bad('That accepted copy belongs to another account.', 'REFEREE_NOT_A_MEMBER');
        return answer({ success: true, data: { ...prior.receipt, alreadyReceived: true } });
      }
      const file = path.join(
        config.root,
        'referee-recovery',
        projectId,
        attempt.recoveryId,
        `${randomUUID()}.sqlite`
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, route.incoming);
      let accepted = false;
      try {
        const intake = await engine.recoveryIntake(location(), {
          file,
          caller: { accountId: account, replicaId },
          lostHead: attempt.lostHead,
        });
        if (!intake.result.success || !intake.result.data) return answer(intake.result);
        // The host's authenticated member/account binding is independent of uploaded bytes.
        if (
          !attempt.members.some(
            (member) =>
              member.accountId === account && member.memberId === intake.result.data!.memberId
          )
        )
          return bad('The upload does not belong to this account.', 'REFEREE_NOT_A_MEMBER');
        const receipt = {
          ...intake.result.data,
          recoveryId: attempt.recoveryId,
          projectId,
          sha256: createHash('sha256').update(route.incoming).digest('hex'),
          alreadyReceived: false as const,
        };
        attempt.uploads.push({ file, accountId: account, receipt });
        host.save();
        accepted = true;
        return answer({ success: true, data: receipt });
      } finally {
        if (!accepted) rmSync(file, { force: true });
      }
    }
    if (rest === 'recovery' && method === 'DELETE') {
      if (!owner) return bad('Only the owner cancels recovery.', 'REFEREE_NOT_A_MEMBER');
      if (attempt.state === 'hosted')
        return bad('Recovery has already finished.', 'REFEREE_NOT_READY');
      attempt.state = 'cancelled';
      host.save();
      return answer({
        success: true,
        data: { recoveryId: attempt.recoveryId, projectId, state: attempt.state },
      });
    }
    if (rest === 'recovery' && method === 'GET' && attempt.state !== 'collecting')
      return answer({
        success: true,
        data: {
          recoveryId: attempt.recoveryId,
          projectId,
          state: attempt.state,
          lostHead: attempt.lostHead,
        },
      });
    if (attempt.state !== 'collecting')
      return bad('Recovery is not collecting.', 'REFEREE_NOT_READY');
    let dropMembers: string[] | null = [],
      dropCopies: string[] | null = [];
    try {
      if (method === 'GET') {
        dropMembers = strings(JSON.parse(route.url.searchParams.get('dropMembers') ?? '[]'));
        dropCopies = strings(JSON.parse(route.url.searchParams.get('dropCopies') ?? '[]'));
      } else {
        dropMembers = strings(route.parsed.dropMembers ?? []);
        dropCopies = strings(route.parsed.dropCopies ?? []);
      }
    } catch {
      return bad('Drop selections must be arrays of ids.');
    }
    if (!dropMembers || !dropCopies) return bad('Drop selections must be arrays of ids.');
    if (!owner && (dropMembers.length || dropCopies.length))
      return bad('Only the owner chooses drops.', 'REFEREE_NOT_A_MEMBER');
    const input: RecoveryPlanInput = {
      lostHead: attempt.lostHead,
      recordedHeads: attempt.recordedHeads,
      ownerAccountId: config.projects[projectId].ownerAccountId,
      members: attempt.members,
      uploads: attempt.uploads.map((upload) => ({
        file: upload.file,
        caller: { accountId: upload.accountId, replicaId: upload.receipt.replicaId },
      })),
      snapshots: project.snapshots,
      dropMembers,
      dropCopies,
    };
    if (rest === 'recovery' && method === 'GET') {
      const planned = await engine.recoveryPlan(location(), input);
      if (!planned.result.success || !planned.result.data) return answer(planned.result);
      const plan = planned.result.data;
      return answer({
        success: true,
        data: {
          recoveryId: attempt.recoveryId,
          projectId,
          state: attempt.state,
          lostHead: attempt.lostHead,
          plan: owner ? plan : { ready: plan.ready, waitingCount: plan.waiting.length },
        },
      });
    }
    if (rest === 'recovery/confirm' && method === 'POST') {
      if (!owner) return bad('Only the owner confirms recovery.', 'REFEREE_NOT_A_MEMBER');
      const confirmedTailMembershipIds = strings(route.parsed.confirmedTailMembershipIds);
      if (typeof route.parsed.confirmedPlanHash !== 'string' || !confirmedTailMembershipIds)
        return bad('Confirm the plan hash and selected tail membership ids.');
      // Finalization can keep a census member removed. A lost result must not validate the old census.
      const wasInvalid = project.membersInvalid;
      project.membersInvalid = true;
      host.save();
      const finalized = await engine.finalizeRecovery(location(), {
        ...input,
        confirmedPlanHash: route.parsed.confirmedPlanHash,
        confirmedTailMembershipIds,
      });
      if (!finalized.result.success || !finalized.result.data || !finalized.head) {
        // The library's validation refusal precedes publication; an internal failure may not.
        if (finalized.result.error?.code === engine.REFEREE_ERROR_CODES.UPLOAD_REFUSED) {
          project.membersInvalid = wasInvalid;
          host.save();
        }
        return answer(finalized.result);
      }
      host.rememberHead(project, finalized.head);
      // This host authenticated the lost referee; a later re-share must retain its admissions.
      if (!project.formerRefereeReplicaIds.includes(attempt.lostHead.replicaId))
        project.formerRefereeReplicaIds.push(attempt.lostHead.replicaId);
      project.members = [...finalized.result.data.members];
      project.grants.clear();
      for (const member of project.members) {
        project.known.add(member.accountId);
        if (member.role !== 'removed') project.grants.set(member.accountId, member.role);
      }
      // Older authorities remain evidence on disk, but cannot anchor a later authority's loss.
      project.snapshots = [snapshot()];
      project.needsRecovery = null;
      attempt.state = 'hosted';
      project.shared = true;
      project.membersInvalid = false;
      host.save();
      return answer({
        ...finalized.result,
        data: {
          ...finalized.result.data,
          recoveryId: attempt.recoveryId,
          projectId,
          state: attempt.state,
        },
      });
    }
    return bad('No such recovery route.');
  });
  return true;
}

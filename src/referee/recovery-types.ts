// SPDX-License-Identifier: Apache-2.0
// ABOUTME: File-backed hosted recovery inputs distinguish host-authenticated accounts from uploaded record claims.
// ABOUTME: The plan exposes trust cuts, missing copies and conflicts before an owner confirms a new referee.
import type { LoggedChange } from '../tools/rbook/record-standing';
import type { Caller } from './peer';
import type { StreamHead } from './open';

export interface RecoveryLocation {
  readonly storePath: string;
  readonly configDir: string;
  /** The recorded project_id, which need not equal the dashboard's route id. */
  readonly projectId: string;
}
export interface RecoveryMember {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly accountId: string;
}
export interface RecoveryUpload {
  readonly file: string;
  readonly caller: Caller;
}
export interface RecoverySnapshot {
  readonly file: string;
  readonly takenAt: string;
}
export interface RecoveryIntakeInput extends RecoveryUpload {
  readonly lostHead: StreamHead;
}
export interface RecoveryIntake {
  readonly replicaId: string;
  readonly memberId: string;
  readonly marks: Readonly<Record<string, number>>;
  readonly lostPrefix: number;
  readonly lostHash: string | null;
}
export interface RecoveryPlanInput {
  readonly lostHead: StreamHead;
  readonly recordedHeads: readonly StreamHead[];
  readonly ownerAccountId: string;
  readonly members: readonly RecoveryMember[];
  readonly uploads: readonly RecoveryUpload[];
  readonly snapshots?: readonly RecoverySnapshot[];
  /** Member ids, never the owner id. */
  readonly dropMembers?: readonly string[];
  /** Replica ids, including the owner's other lost copies. */
  readonly dropCopies?: readonly string[];
}
export interface FinalizeRecoveryInput extends RecoveryPlanInput {
  readonly confirmedPlanHash: string;
  readonly confirmedTailMembershipIds: readonly string[];
}
export interface RecoverySource {
  readonly file: string;
  readonly accountId: string | null;
}
export interface RecoveryClash {
  readonly replicaId: string;
  readonly seq: number;
  readonly left: RecoverySource;
  readonly right: RecoverySource;
}
export interface RecoveryPlan {
  readonly planHash: string;
  readonly base: { readonly file: string; readonly kind: 'snapshot' | 'upload' };
  readonly members: ReadonlyArray<
    RecoveryMember & {
      readonly copies: ReadonlyArray<{
        readonly replicaId: string;
        readonly in: boolean;
        readonly dropped: boolean;
      }>;
    }
  >;
  readonly waiting: readonly string[];
  readonly clashes: readonly RecoveryClash[];
  readonly adoptedPrefix: number;
  readonly loss: { readonly count: number; readonly lowerBound: true; readonly summary: string };
  readonly thirdPartyStreams: ReadonlyArray<
    RecoverySource & {
      readonly replicaId: string;
      readonly memberId: string | null;
      readonly fromSeq: number;
      readonly toSeq: number;
    }
  >;
  readonly tailMembership: readonly LoggedChange[];
  readonly ready: boolean;
}

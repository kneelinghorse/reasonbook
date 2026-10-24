// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Public exchange report shapes shared by wire, bundle and local copy callers.
// ABOUTME: Type-only dependencies keep these interfaces separate from merge execution.
import type { CopyReport } from './record-copy-report';
import type { ChangeRecipient, ChangeSelection } from './record-since';
import type { ApplyReport } from './record-apply';
import type { LoggedChange } from './record-standing';
import type { Successor, SuccessorReason, SuccessorTaken } from './record-successor';
import type { RbookToolResult } from './types';

/** What each side says about itself before anything moves. */
export interface Hello extends CopyReport {
  readonly protocol: number;
  /** s97-m10 (design §Versions): the record protocol this copy writes; a 4.1.0 copy says none, and writes 1. */
  readonly recordProtocol?: number;
  readonly projectId: string;
  readonly replicaId: string;
  readonly block: number;
  readonly authority: string;
  readonly marks: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, number>>;
  /** The replicas this copy's record shows as removed (ADR s96 §8): they receive nothing new. */
  readonly removed: readonly string[];
  /** s96-m13 (ADR s96 §8): the epoch this copy applies, and a move it holds unconfirmed. */
  readonly epoch: number;
  readonly pending: {
    readonly epoch: number;
    readonly authority: string;
    readonly changeId: string;
  } | null;
  /** Actual competing moves held by this copy; older peers may omit this evidence. */
  readonly forks?: readonly {
    readonly epoch: number;
    readonly authority: string;
    readonly changeId: string;
  }[];
  /** When each replica was admitted, by the hybrid clock: of two in one block, the later renumbers. */
  readonly admitted: Readonly<Record<string, string>>;
  /** Replicas cut but not removed, such as a dropped copy or a replaced owner copy: they re-identify. */
  readonly cuts: Readonly<Record<string, number>>;
  /** Replicas whose join no recovery saw. */
  readonly unseen: readonly string[];
  /** The replicas this copy counts as members, the authority included. */
  readonly members: readonly string[];
  /** This copy's own copy check, when it refuses this copy's writes. */
  readonly refusal: string | null;
  /** That check's own remedy, so another copy can quote it (s96-m13 critics, round 4). */
  readonly remedy?: string | null;
}

/** One side of an exchange, in this process or at the far end of a channel. */
export interface Peer {
  /** How a person knows this copy, for the answer: a path, or a host and path. */
  readonly name: string;
  hello(): Promise<Hello>;
  /** A validated direct hello is an observed call; carried headers are not. */
  observeHello?(near: Hello): Promise<void>;
  chains(at: Readonly<Record<string, number>>): Promise<Record<string, string | null>>;
  changesSince(
    marks: Readonly<Record<string, number>>,
    recipient?: ChangeRecipient
  ): Promise<LoggedChange[]>;
  /** Local authority only: retain delivery diagnostics without adding fields to the wire. */
  changesSinceReport?(
    marks: Readonly<Record<string, number>>,
    recipient: ChangeRecipient
  ): Promise<ChangeSelection>;
  /** Apply what arrived; a catch-up between epochs applies without judging. */
  apply(
    changes: readonly LoggedChange[],
    options?: { readonly judge?: boolean; readonly catchUp?: boolean }
  ): Promise<RbookToolResult<ApplyReport>>;
  /** On the authority: admit a copy's successor (ADR s96 §9), or itself at a fresh block. */
  admitSuccessor(input: {
    readonly replicaId: string;
    readonly sameId?: boolean;
  }): Promise<RbookToolResult<Successor>>;
  reblockSelf(): Promise<RbookToolResult<{ readonly block: number; readonly renumbered: number }>>;
  /** On the copy: take the successor the authority admitted. */
  takeSuccessor(input: {
    readonly successor: Successor;
    readonly reason: SuccessorReason;
    readonly authorityReceived: number | null;
    readonly divergesFrom?: number;
    readonly cut?: number;
  }): Promise<RbookToolResult<SuccessorTaken>>;
  /** Record, on this copy, an exchange the other copy's checks stopped, so its review shows it. */
  failed(input: { readonly replicaId: string; readonly error: string }): Promise<void>;
}

export interface ExchangeReport {
  /** The member's changes the owner's copy received, and how many it judged. */
  readonly sent: number;
  readonly judged: number;
  /** The owner's stream the member received, verdicts included. */
  readonly received: number;
  readonly conflicts: number;
  readonly findings: number;
  /** The owner's stream up to the mark both copies hold, as both hash it (ADR §7's digest). */
  readonly digest: { readonly mark: number; readonly hash: string | null };
  readonly applied: { readonly authority: ApplyReport | null; readonly member: ApplyReport | null };
  /**
   * The member was removed, or is no member: its changes went in, quarantined past its cut or
   * refused, and nothing came back (ADR s96 §8).
   */
  readonly removed: boolean;
  /**
   * s97-m14: which side's member the owner's copy lists as removed, when one is: this copy, or the
   * one it exchanged with. Absent for a copy that is no member at all, whose changes are refused.
   */
  readonly removedCopy?: 'local' | 'remote';
  /** Each side's identity and marks after the exchange: what each records of the other. */
  readonly local: { readonly replicaId: string; readonly marks: Readonly<Record<string, number>> };
  readonly remote: { readonly replicaId: string; readonly marks: Readonly<Record<string, number>> };
  /** s96-m13: the copy behind an epoch received the move, and waits for its operator to confirm it. */
  readonly caughtUp?: {
    readonly copy: 'local' | 'remote';
    readonly epoch: number;
    readonly authority: string;
    /** s97-m10: the copy behind confirmed the move itself, as the dashboard's referee does. */
    readonly confirmed?: boolean;
  };
  /** s96-m13: the member took a new identity or block, and what its review now says. */
  readonly reidentified?: SuccessorTaken;
  /** s96-m13: each replica that renumbered into a fresh block after a block clash. */
  readonly reblocked?: ReadonlyArray<{ readonly replicaId: string; readonly block: number }>;
}

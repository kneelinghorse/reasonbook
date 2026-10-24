// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The signals report's contract (rbook.signals/1): nine signals of what needs a person in one store, with their
// ABOUTME: counts, ranked row ids and rules, the window's new rows and new feedback by kind. Additive changes keep the schema.

import type { FeedbackKind } from './feedback-kinds';

export const SIGNALS_SCHEMA = 'rbook.signals/1';
export const SIGNALS_LIBRARY_NAME = '@aquex/reasonbook/signals';

/** The nine signals, in the order every report lists them. */
export const SIGNAL_KINDS = [
  'drafts_pending',
  'next_steps_lapsing',
  'reviews_due',
  'superseded_cited',
  'missions_blocked',
  'feedback_open',
  'quiet_days',
  'constraints_expiring',
  'shared_conflicts',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Row ids a signal reports, at most. */
export const SIGNAL_MAX_IDS = 20;

/** The window's default length in days. */
export const SIGNALS_DEFAULT_WINDOW_DAYS = 7;

export interface ReadSignalsOptions {
  /** The instant every rule is applied at; the report's computedAt is this instant. */
  readonly now: Date | number | string;
  /** Row ids each signal reports, 0 to 20 (default 20). */
  readonly maxIds?: number;
  /** The window's length in days (default 7). */
  readonly windowDays?: number;
  /**
   * The machine's drafts folder (`<configDir>/runtime/drafts`). With it a draft also expires
   * after three session starts; without it drafts expire by age only, and the rule says so.
   */
  readonly draftRuntimeDir?: string;
}

/**
 * One signal. An unavailable one has `count: null` and a `reason`: a missing table or column is
 * never a zero. `failed` marks one whose rule could not be read on this store (the store itself,
 * or a damaged table), as against one whose input the store's layout does not have.
 */
export interface SignalEntry {
  readonly kind: SignalKind;
  readonly available: boolean;
  readonly count: number | null;
  readonly failed?: true;
  /** Up to maxIds row ids, in the order the signal ranks them: `P12`, `n:7`, `d:3`, `l:4`, … */
  readonly ids: readonly string[];
  /** Why the signal is unavailable, or what limits it. */
  readonly reason?: string;
  /** Rows the rule applies to whose time could not be read, counted apart and not in `count`. */
  readonly undated?: number;
  /** next_steps_lapsing: the rows the next close drops unless they are carried. */
  readonly lapseDue?: number;
  /**
   * s97-m03: when the oldest row the signal counts began to need a person (a draft's creation, a
   * lease's anchor, a block's start, a conflict's detection), so a brief can list oldest first;
   * absent when no counted row has a readable time.
   */
  readonly oldestAt?: string;
  /** s97-m03, reviews_due in a full report: rows due at now that were not due at the window's start. */
  readonly becameDue?: number;
  /** missions_blocked: blocked missions, all counted, whose blocking time is not recorded. */
  readonly sinceUnknown?: number;
  /** feedback_open: the open friction rows by kind, and the open rows no kind claims. */
  readonly byKind?: Readonly<Record<FeedbackKind, number>>;
  readonly unclassified?: number;
  /** shared_conflicts: whether a peer has said this copy's member was removed. */
  readonly removed?: boolean;
}

/** New rows in the window; null where the table or its time column is absent, never a zero. */
export interface WindowCounts {
  readonly decisions: number | null;
  readonly learnings: number | null;
  readonly missionsCompleted: number | null;
  readonly sprintsClosed: number | null;
}

export interface FeedbackKindsReport {
  readonly available: boolean;
  /** New feedback rows in the window by kind, every kind present; null when unavailable. */
  readonly counts: Readonly<Record<FeedbackKind, number>> | null;
  readonly unclassified: number | null;
  readonly reason?: string;
}

export interface SignalsReport {
  readonly schema: typeof SIGNALS_SCHEMA;
  readonly library: { readonly name: typeof SIGNALS_LIBRARY_NAME; readonly version: string };
  /** Equals the `now` passed in. */
  readonly computedAt: string;
  readonly project: { readonly id: string; readonly name: string | null };
  /** Each signal's rule, and the window's and the feedback kinds', as published sentences. */
  readonly rules: Readonly<Record<SignalKind | 'window' | 'feedbackKinds', string>>;
  readonly signals: readonly SignalEntry[];
  /** `reason` says why every count is null when the window could not be read at all. */
  readonly window: {
    readonly days: number;
    readonly counts: WindowCounts;
    readonly reason?: string;
  };
  readonly feedbackKinds: FeedbackKindsReport;
  /**
   * Present only on a report of a store that could not be opened or read at all, with the reason:
   * every signal is then unavailable and failed. The caller may supply a known project identity;
   * otherwise its id is unknown-project and its name is null.
   */
  readonly unreadable?: string;
}

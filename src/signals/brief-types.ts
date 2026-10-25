// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Structured weekly-brief contracts retain raw identities and omission counts.
// ABOUTME: The pure renderer and CLI share these additive report types.
import type { SignalsReport } from './report';
import type { BriefReportCaveat } from './brief-text';

export interface BriefOptions {
  /** The instant the brief is for; stored reports may have an earlier computedAt. */
  readonly now: Date | number | string;
  /** The window the reports counted, in days (default 7). */
  readonly windowDays?: number;
}

export type BriefSectionId =
  | 'needs_a_decision'
  | 'stuck'
  | 'gone_quiet'
  | 'drifting'
  | 'friction'
  | 'what_moved';

export interface BriefItem {
  /** The project the line is about, or null for a friction kind's line. */
  readonly projectId: string | null;
  /** One line, without its leading "- ". */
  readonly text: string;
  /** The row ids the line names. */
  readonly ids: readonly string[];
}

export interface BriefSection {
  readonly id: BriefSectionId;
  readonly title: string;
  /** How the section chooses and orders its items, in words. */
  readonly rule: string;
  /** The items listed, at most {@link BRIEF_SECTION_ITEMS}. */
  readonly items: readonly BriefItem[];
  /** Items past the cap, said as "and N more". */
  readonly more: number;
}

export interface Brief {
  readonly from: string;
  readonly to: string;
  readonly windowDays: number;
  /** Reports read, and those whose store could not be read at all. */
  readonly projects: number;
  readonly unreadable: readonly string[];
  readonly unreadableProjects?: readonly SignalsReport['project'][];
  /** Drafts dropped because their whole report is older than the seven-day expiry. */
  readonly droppedDrafts?: number;
  /** Projects that had a signal fail; their other signals are in the sections. */
  readonly partly: readonly string[];
  /** Reports whose age or counted window differs; raw provenance remains available in JSON. */
  readonly reportCaveats: readonly BriefReportCaveat[];
  readonly sections: readonly BriefSection[];
}

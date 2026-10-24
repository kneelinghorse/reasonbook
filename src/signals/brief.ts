// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The weekly brief from signals reports: six ranked, capped sections, every listed row named by its id, the same
// ABOUTME: bytes for the same reports and now on any machine. buildBrief gives the sections; renderBrief, the markdown.

import { storedTimeMs } from '../tools/rbook/stored-time';
import { FEEDBACK_KINDS, type FeedbackKind } from './feedback-kinds';
import type { SignalEntry, SignalKind, SignalsReport } from './report';
import { QUIET_SILENT_DAYS } from './rules-activity';
import {
  BRIEF_MAX_LINES,
  BRIEF_SECTION_ITEMS,
  renderBriefText,
  plain,
  projectLabel,
  reportCaveats,
  type BriefReportCaveat,
} from './brief-text';

export { BRIEF_MAX_LINES, BRIEF_SECTION_ITEMS };
export type { BriefReportCaveat };

/**
 * WHY NOTHING HERE READS THE MACHINE. A host can render this brief from its stored reports and
 * `reasonbook brief` from this machine's, and the two must give the same bytes. So the
 * renderer reads no clock (the time comes in as `now`), no time zone (dates are ISO in UTC), no
 * locale (no localeCompare, no toLocaleString) and no environment.
 */

/** Row ids a line names for one signal before "…". */
export const BRIEF_LINE_IDS = 3;
const DAY_MS = 86_400_000;

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
  /** Projects that had a signal fail; their other signals are in the sections. */
  readonly partly: readonly string[];
  /** Reports whose age or counted window differs; raw provenance remains available in JSON. */
  readonly reportCaveats: readonly BriefReportCaveat[];
  readonly sections: readonly BriefSection[];
}

function nowMsOf(now: BriefOptions['now']): number {
  // Stored-time parsing, not Date.parse: a zone-less SQLite spelling is UTC on every machine.
  const value =
    now instanceof Date ? now.getTime() : typeof now === 'number' ? now : storedTimeMs(now);
  if (!Number.isFinite(value)) throw new RangeError('renderBrief: now must be a valid time');
  return value;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const byId = (a: { projectId: string | null }, b: { projectId: string | null }): number =>
  (a.projectId ?? '') < (b.projectId ?? '')
    ? -1
    : (a.projectId ?? '') > (b.projectId ?? '')
      ? 1
      : 0;

function entry(report: SignalsReport, kind: SignalKind): SignalEntry | undefined {
  const found = report.signals.find((signal) => signal.kind === kind);
  return found && found.available && (found.count ?? 0) > 0 ? found : undefined;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** A signal's count and the first of its ids, as one clause. */
function clause(signal: SignalEntry, one: string, many: string): { text: string; ids: string[] } {
  const ids = signal.ids.slice(0, BRIEF_LINE_IDS);
  const more = (signal.count ?? 0) > ids.length ? ', …' : '';
  return {
    text: `${plural(signal.count ?? 0, one, many)}${ids.length ? ` (${ids.map((id) => plain(id, 100)).join(', ')}${more})` : ''}`,
    ids: [...ids],
  };
}

/** An item's time; one with none, or none readable, ranks after every dated item. */
function timeOf(iso: string | undefined): number {
  const value = iso === undefined ? NaN : storedTimeMs(iso);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

interface Ranked {
  readonly projectId: string | null;
  readonly rank: readonly number[];
  readonly item: BriefItem;
}

function section(
  id: BriefSectionId,
  title: string,
  rule: string,
  ranked: readonly Ranked[]
): BriefSection {
  const ordered = [...ranked].sort((a, b) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const diff = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
      if (diff) return diff;
    }
    return byId(a, b);
  });
  return {
    id,
    title,
    rule,
    items: ordered.slice(0, BRIEF_SECTION_ITEMS).map((row) => row.item),
    more: Math.max(0, ordered.length - BRIEF_SECTION_ITEMS),
  };
}

function needsADecision(reports: readonly SignalsReport[]): Ranked[] {
  const out: Ranked[] = [];
  for (const report of reports) {
    const drafts = entry(report, 'drafts_pending');
    const conflicts = entry(report, 'shared_conflicts');
    if (!drafts && !conflicts) continue;
    const parts = [
      ...(drafts ? [clause(drafts, 'draft', 'drafts')] : []),
      ...(conflicts ? [clause(conflicts, 'unsettled conflict', 'unsettled conflicts')] : []),
    ];
    const oldest = Math.min(timeOf(drafts?.oldestAt), timeOf(conflicts?.oldestAt));
    out.push({
      projectId: report.project.id,
      rank: [oldest],
      item: {
        projectId: report.project.id,
        text: `${projectLabel(report)}: ${parts.map((part) => part.text).join('; ')}${
          Number.isFinite(oldest) ? `, oldest ${day(oldest)}` : ''
        }`,
        ids: parts.flatMap((part) => part.ids),
      },
    });
  }
  return out;
}

function stuck(reports: readonly SignalsReport[]): Ranked[] {
  const out: Ranked[] = [];
  for (const report of reports) {
    const blocked = entry(report, 'missions_blocked');
    const lapsing = entry(report, 'next_steps_lapsing');
    if (!blocked && !lapsing) continue;
    const parts = [
      ...(blocked ? [clause(blocked, 'blocked mission', 'blocked missions')] : []),
      ...(lapsing
        ? [clause(lapsing, 'next step about to lapse', 'next steps about to lapse')]
        : []),
    ];
    const due = lapsing?.lapseDue ? `, ${lapsing.lapseDue} at the next close` : '';
    const oldest = Math.min(timeOf(blocked?.oldestAt), timeOf(lapsing?.oldestAt));
    out.push({
      projectId: report.project.id,
      rank: [oldest],
      item: {
        projectId: report.project.id,
        text: `${projectLabel(report)}: ${parts.map((part) => part.text).join('; ')}${due}${
          Number.isFinite(oldest) ? `, oldest ${day(oldest)}` : ''
        }`,
        ids: parts.flatMap((part) => part.ids),
      },
    });
  }
  return out;
}

function goneQuiet(reports: readonly SignalsReport[], now: number): Ranked[] {
  const out: Ranked[] = [];
  for (const report of reports) {
    const quiet = report.signals.find((signal) => signal.kind === 'quiet_days');
    if (!quiet?.available || quiet.count === null) continue;
    const computed = storedTimeMs(report.computedAt);
    // The report retains whole quiet days only: add whole elapsed days, not an invented remainder.
    const sinceUpload = Number.isFinite(computed)
      ? Math.max(0, Math.floor((now - computed) / DAY_MS))
      : 0;
    const days = quiet.count + sinceUpload;
    if (days < QUIET_SILENT_DAYS) continue;
    out.push({
      projectId: report.project.id,
      rank: [-days],
      item: {
        projectId: report.project.id,
        text: `${projectLabel(report)}: ${plural(days, 'day', 'days')} without a new row${
          sinceUpload ? `, ${sinceUpload} of them since its last upload` : ''
        }`,
        ids: [],
      },
    });
  }
  return out;
}

function drifting(reports: readonly SignalsReport[]): Ranked[] {
  const out: Ranked[] = [];
  for (const report of reports) {
    const reviews = entry(report, 'reviews_due');
    const cited = entry(report, 'superseded_cited');
    if (!reviews && !cited) continue;
    const parts: Array<{ text: string; ids: string[] }> = [];
    if (reviews) {
      const part = clause(reviews, 'record due for review', 'records due for review');
      const came = reviews.becameDue ? `, ${reviews.becameDue} new this window` : '';
      parts.push({ text: `${part.text}${came}`, ids: part.ids });
    }
    if (cited)
      parts.push(
        clause(cited, 'row citing a replaced decision', 'rows citing a replaced decision')
      );
    out.push({
      projectId: report.project.id,
      rank: [-(reviews?.becameDue ?? 0), -(reviews?.count ?? 0), -(cited?.count ?? 0)],
      item: {
        projectId: report.project.id,
        text: `${projectLabel(report)}: ${parts.map((part) => part.text).join('; ')}`,
        ids: parts.flatMap((part) => part.ids),
      },
    });
  }
  return out;
}

function friction(reports: readonly SignalsReport[]): Ranked[] {
  const out: Ranked[] = [];
  for (const kind of [...FEEDBACK_KINDS.map((entry) => entry.kind), 'unclassified'] as const) {
    const by = reports
      .map((report) => ({
        report,
        n:
          kind === 'unclassified'
            ? (report.feedbackKinds.unclassified ?? 0)
            : (report.feedbackKinds.counts?.[kind as FeedbackKind] ?? 0),
      }))
      .filter((row) => row.n > 0)
      .sort((a, b) => b.n - a.n || byIdOf(a.report.project.id, b.report.project.id));
    const total = by.reduce((sum, row) => sum + row.n, 0);
    if (!total) continue;
    const shown = by.slice(0, BRIEF_LINE_IDS).map((row) => `${projectLabel(row.report)} ${row.n}`);
    const more = by.length > shown.length ? `, ${by.length - shown.length} more` : '';
    out.push({
      projectId: null,
      rank: [-total],
      item: {
        projectId: null,
        text: `${kind}: ${plural(total, 'new row', 'new rows')} (${shown.join(', ')}${more})`,
        ids: [],
      },
    });
  }
  return out;
}

function byIdOf(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function whatMoved(reports: readonly SignalsReport[]): Ranked[] {
  const out: Ranked[] = [];
  for (const report of reports) {
    const counts = report.window.counts;
    const parts = [
      [counts.decisions, 'decision', 'decisions'],
      [counts.learnings, 'learning', 'learnings'],
      [counts.missionsCompleted, 'mission completed', 'missions completed'],
      [counts.sprintsClosed, 'sprint closed', 'sprints closed'],
    ] as const;
    const said = parts.filter(([n]) => (n ?? 0) > 0);
    if (!said.length) continue;
    const total = said.reduce((sum, [n]) => sum + (n ?? 0), 0);
    out.push({
      projectId: report.project.id,
      rank: [-total],
      item: {
        projectId: report.project.id,
        text: `${projectLabel(report)}: ${said.map(([n, one, many]) => plural(n ?? 0, one, many)).join(', ')}`,
        ids: [],
      },
    });
  }
  return out;
}

/** The brief as data: the same sections, items and rules {@link renderBrief} prints. */
export function buildBrief(reports: readonly SignalsReport[], options: BriefOptions): Brief {
  const nowMs = nowMsOf(options.now);
  const windowDays = options.windowDays ?? 7;
  if (!Number.isFinite(windowDays) || windowDays <= 0)
    throw new RangeError('renderBrief: windowDays must be a positive number of days');
  const readable = reports.filter((report) => !report.unreadable);
  const unreadable = reports
    .filter((report) => report.unreadable)
    .map((report) => report.project.id)
    .sort(byIdOf);
  const partly = readable
    .filter((report) => report.signals.some((signal) => signal.failed))
    .map((report) => report.project.id)
    .sort(byIdOf);
  return {
    from: day(nowMs - windowDays * DAY_MS),
    to: day(nowMs),
    windowDays,
    projects: reports.length,
    unreadable,
    partly,
    reportCaveats: reportCaveats(reports, nowMs, windowDays),
    sections: [
      section(
        'needs_a_decision',
        'Needs a decision',
        'drafts awaiting a decision and unsettled conflicts on a shared copy, the project whose oldest such item is oldest first',
        needsADecision(readable)
      ),
      section(
        'stuck',
        'Stuck',
        'blocked missions and next steps about to lapse, the project whose oldest such item is oldest first',
        stuck(readable)
      ),
      section(
        'gone_quiet',
        'Gone quiet',
        `projects with no new row for ${QUIET_SILENT_DAYS} days or more, adding whole elapsed days since readable report times, the quietest first`,
        goneQuiet(readable, nowMs)
      ),
      section(
        'drifting',
        'Drifting',
        'records due for review, with those that became due in the window, and rows citing a replaced decision, by the most new this window, then the most due, then the most citing',
        drifting(readable)
      ),
      section(
        'friction',
        'Friction',
        'new agent feedback in each report’s window by kind, including unclassified, the kind with the most new rows first',
        friction(readable)
      ),
      section(
        'what_moved',
        'What moved',
        "the window's new decisions and learnings, missions completed and sprints closed, the project with the most first",
        whatMoved(readable)
      ),
    ],
  };
}

/**
 * The weekly brief as markdown, at most {@link BRIEF_MAX_LINES} lines: the same bytes for the same
 * reports, `now` and window on any machine.
 */
export function renderBrief(reports: readonly SignalsReport[], options: BriefOptions): string {
  return renderBriefText(buildBrief(reports, options));
}

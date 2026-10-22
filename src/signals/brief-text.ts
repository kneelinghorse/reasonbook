// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pure bounded Markdown values and report-age disclosures for the weekly brief.
// ABOUTME: Presentation never rewrites structured ids, report timestamps or counted windows.

import { oneLine } from '../utils/one-line';
import { compareStoredTimes, storedTimeMs } from '../tools/rbook/stored-time';
import type { SignalsReport } from './report';
import type { Brief } from './brief';

/** Items a section lists before "and N more" (settled item 12). */
export const BRIEF_SECTION_ITEMS = 5;
/** The brief’s longest length in lines (settled item 12). */
export const BRIEF_MAX_LINES = 60;

/** A displayed name or id, with Markdown and GFM automatic links made inert. */
export function plain(text: string, max = 40): string {
  return (
    oneLine(text, max)
      .replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1')
      // GFM bare links require an uninterrupted http(s) scheme, www. domain or email address.
      .replace(/(https?:|www\.)/gi, '$1\u200b')
      .replace(/@/g, '@\u200b')
  );
}

export function projectLabel(report: Pick<SignalsReport, 'project'>): string {
  const { id, name } = report.project;
  return name && name !== id ? `${plain(name)} (${plain(id)})` : plain(id);
}

export interface BriefReportCaveat {
  readonly projectId: string;
  readonly projectName: string | null;
  readonly computedAt: string;
  /** Negative means the report is from after the brief's now; null means unreadable. */
  readonly ageMs: number | null;
  readonly windowDays: number;
}

export function reportCaveats(
  reports: readonly SignalsReport[],
  now: number,
  days: number
): BriefReportCaveat[] {
  return reports
    .flatMap((report) => {
      const computed = storedTimeMs(report.computedAt);
      const ageMs = Number.isFinite(computed) ? now - computed : null;
      return ageMs === 0 && report.window.days === days
        ? []
        : [
            {
              projectId: report.project.id,
              projectName: report.project.name,
              computedAt: report.computedAt,
              ageMs,
              windowDays: report.window.days,
            },
          ];
    })
    .sort((a, b) => {
      const order =
        (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
        compareStoredTimes(a.computedAt, b.computedAt) ||
        a.windowDays - b.windowDays;
      if (order) return order;
      // Equal instants (or two unreadable times) still retain distinct raw provenance. Break only
      // those ties by label/spelling, including null versus empty names, without locale ordering.
      const left = JSON.stringify([a.projectName, a.computedAt]);
      const right = JSON.stringify([b.projectName, b.computedAt]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function age(ms: number): string {
  for (const [size, unit] of [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ] as const) {
    if (ms >= size) {
      const n = Math.floor(ms / size);
      return `${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return 'less than 1 second';
}

export function caveatText(caveat: BriefReportCaveat, days: number): string {
  const label = projectLabel({ project: { id: caveat.projectId, name: caveat.projectName } });
  const time =
    caveat.ageMs === null
      ? 'report time unreadable'
      : caveat.ageMs > 0
        ? `report ${age(caveat.ageMs)} old`
        : caveat.ageMs < 0
          ? `report time ${age(-caveat.ageMs)} ahead of this brief`
          : 'report current';
  return `${label}: ${time}${caveat.windowDays !== days ? `; ${caveat.windowDays}-day window (brief: ${days} days)` : ''}.`;
}

/** Render the bounded presentation; structured fields retain the full evidence. */
export function renderBriefText(brief: Brief): string {
  const lines = [
    `# Weekly brief, ${brief.from} to ${brief.to}`,
    '',
    `${`${brief.projects} ${brief.projects === 1 ? 'project' : 'projects'}`}` +
      (brief.unreadable.length
        ? `; ${brief.unreadable.length} could not be read (${brief.unreadable.map((id) => plain(id)).join(', ')})`
        : '') +
      (brief.partly.length
        ? `; ${brief.partly.length} had a signal that could not be read (${brief.partly.map((id) => plain(id)).join(', ')})`
        : '') +
      '.',
  ];
  if (brief.reportCaveats.length) {
    lines.push('', 'Report ages and windows:');
    for (const caveat of brief.reportCaveats.slice(0, BRIEF_SECTION_ITEMS))
      lines.push(`- ${caveatText(caveat, brief.windowDays)}`);
    if (brief.reportCaveats.length > BRIEF_SECTION_ITEMS)
      lines.push(
        `- and ${brief.reportCaveats.length - BRIEF_SECTION_ITEMS} more report caveats; see the structured brief.`
      );
  }
  for (const part of brief.sections) {
    lines.push('', `## ${part.title}`);
    if (!part.items.length) lines.push('- Nothing.');
    for (const item of part.items) lines.push(`- ${item.text}`);
    if (part.more) lines.push(`- and ${part.more} more`);
  }
  if (lines.length > BRIEF_MAX_LINES)
    lines.splice(
      BRIEF_MAX_LINES - 1,
      lines.length,
      '- Brief cut at the line limit; see the structured brief.'
    );
  return `${lines.join('\n')}\n`;
}

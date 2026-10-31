// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m05 (#879): how a named session read prints its summary and captures, whole or a page at a time.
// ABOUTME: A one-page read prints exactly what s93-m11 printed; the pager costs each entry by these lines.

import { frameInlineIfForeign, frameTextIfForeign } from '../../intelligence/provenance-frame';
import type { SessionListCapture, SessionListItem } from './rbook-session-list';

/** A capture's lines as a named read prints them (s93-m11's wording, with a part's place). */
export function captureLines(
  capture: SessionListCapture,
  projectId: string | null | undefined,
  localProjectId: string | null | undefined
): string[] {
  const when = capture.timestamp ? ` ${capture.timestamp}` : '';
  const mission = capture.missionId ? ` {${capture.missionId}}` : '';
  const part = capture.parts ? ` (part ${capture.part} of ${capture.parts})` : '';
  const lines = [
    `   - [${capture.category}]${when}${mission}${part}`,
    frameTextIfForeign(capture.content, projectId, localProjectId),
  ];
  if (capture.context)
    lines.push(`     Context: ${frameTextIfForeign(capture.context, projectId, localProjectId)}`);
  if (capture.expiresAt) lines.push(`     Expires: ${capture.expiresAt}`);
  return lines;
}

/** The summary's lines where a page reads it: whole, or one part. */
export function summaryLines(
  summary: string,
  projectId: string | null | undefined,
  localProjectId: string | null | undefined,
  part?: { part: number; parts: number }
): string[] {
  return [
    part ? `   Summary (part ${part.part} of ${part.parts}):` : '   Summary:',
    frameTextIfForeign(summary, projectId, localProjectId),
  ];
}

/** The summary on a page that does not read it: the plain list's preview line. */
export function previewLine(
  summary: string,
  projectId: string | null | undefined,
  localProjectId: string | null | undefined
): string {
  const short = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
  return `   Summary: ${frameInlineIfForeign(short, projectId, localProjectId)}`;
}

/**
 * A named read's lines below the session's header: its summary (whole, a part, or the preview)
 * and its captures. A one-page read prints exactly what s93-m11 printed.
 */
export function namedReadLines(
  session: SessionListItem,
  localProjectId: string | null | undefined,
  paging?: {
    readonly page: number;
    readonly pageCount: number;
    readonly shown?: { first: number; last: number };
  }
): string[] {
  const lines: string[] = [];
  const captures = (session.captures ?? []) as SessionListCapture[];
  if (session.summary) {
    // A page that does not read a long summary carries it cut, as summaryTruncated says.
    if (paging && session.summaryTruncated)
      lines.push(previewLine(session.summary, session.projectId, localProjectId));
    else
      lines.push(
        ...summaryLines(
          session.summary,
          session.projectId,
          localProjectId,
          session.summaryParts
            ? { part: session.summaryPart ?? 1, parts: session.summaryParts }
            : undefined
        )
      );
  }
  const count = (n: number) => `${n} capture${n === 1 ? '' : 's'}`;
  if (paging && paging.page > paging.pageCount) {
    lines.push(
      '',
      `   No page ${paging.page}: this session has ${paging.pageCount} page${paging.pageCount === 1 ? '' : 's'} and ${count(session.captureCount)}.`
    );
    return lines;
  }
  if (captures.length > 0) {
    lines.push('');
    lines.push(
      paging?.shown
        ? `   Captures ${paging.shown.first}–${paging.shown.last} of ${session.captureCount}:`
        : `   Captures (${captures.length}):`
    );
    for (const capture of captures)
      lines.push(...captureLines(capture, session.projectId, localProjectId));
  }
  return lines;
}

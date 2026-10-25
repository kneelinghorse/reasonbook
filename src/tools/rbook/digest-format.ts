// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Format bounded digest rows while retaining whole provenance boundaries and typed spans.
// ABOUTME: Share heading, sentence and section accounting across the digest's work and record sections.
import { frameInlineIfForeign, isForeignProject } from '../../intelligence/provenance-frame';
import type { DigestRow } from './digest-v2';
import type { RenderedContext } from './rendered-context';

/** Cut only the body, before framing it; never split a provenance boundary or typed ID. */
export function cut(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Published label rule: capitals, digits and punctuation ending in colon, em dash or period. */
export function digestHeadline(text: string): string {
  let value = text.replace(/\s+/g, ' ').trim();
  const label = /^[\p{Lu}\d\p{P}\p{Zs}]*?[:—.](?:\s+|$)/u;
  while (label.test(value)) value = value.replace(label, '').trim();
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(value)?.[0] ?? value;
  return cut(sentence, 140);
}

export type Line = { text: string; id?: string };
export type Section = { text: string; items: RenderedContext['items'] };

export function section(lines: readonly Line[]): Section {
  const items: Array<{ typedId: string; start: number; end: number }> = [];
  let text = '';
  for (const line of lines) {
    if (text) text += '\n';
    const start = text.length;
    text += line.text;
    if (line.id) items.push({ typedId: line.id, start, end: text.length });
  }
  return { text, items };
}

export function rowLine(row: DigestRow, cap: number, local: string | null): Line | null {
  const prefix = `  • ${row.id}${row.date ? ` ${row.date}` : ''}${row.author ? ` (${cut(row.author, 24)})` : ''} `;
  const overhead = frameInlineIfForeign('', row.projectId, local).length;
  const room = Math.min(row.id.startsWith('n:') ? 72 : 140, cap - prefix.length - overhead);
  if (room < 16) return null;
  const headline = digestHeadline(row.text) || '[no sentence; read in full]';
  const text = prefix + frameInlineIfForeign(cut(headline, room), row.projectId, local);
  return {
    text,
    ...(!isForeignProject(row.projectId, local) && /^[dlcn]:[1-9]\d*$/.test(row.id)
      ? { id: row.id }
      : {}),
  };
}

export function rowsSection(
  title: string,
  rows: readonly DigestRow[],
  cap: number,
  max: number,
  local: string | null,
  total = rows.length,
  week = false
): Section | null {
  if (!rows.length) return null;
  const selected = rows.slice(0, max);
  const heading = (shown: number): string =>
    `${title}:${total > shown ? ` (${shown} of ${total}${week ? ' this week' : ''})` : ''}`;
  // Reserve the longest count heading before sharing space equally across complete rows.
  const headingRoom = heading(0).length + String(selected.length).length;
  const perRow = Math.floor((cap - headingRoom - selected.length) / selected.length);
  const lines = selected
    .map((row) => rowLine(row, perRow, local))
    .filter((line): line is Line => !!line);
  if (!lines.length) return section([{ text: `${heading(0)}\nRead these records in full.` }]);
  return section([{ text: heading(lines.length) }, ...lines]);
}

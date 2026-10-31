// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m05 (#879): a named session read in pages, its captures in stored order and then its summary, under the cap.
// ABOUTME: Laid out from values completion cannot change; an entry larger than a page splits into parts that join back exactly.

import { ANSWER_CHAR_CAP, nextPageCall } from './answer-page';
import { previewText } from './text-preview';
import { captureLines, previewLine, summaryLines } from './session-read-render';
import type {
  RbookSessionListResult,
  SessionListCapture,
  SessionListItem,
} from './rbook-session-list';

/**
 * What a page's entries may not use: the answer's frame and every per-call part of it (the Project
 * line, the project root and session id in each Next page call, page facts, notices and warnings),
 * so the layout never depends on them and a page already read stays put. A dispatch test tunes it
 * against a 200-character project root and a foreign session (session-read-pages.test.ts).
 */
export const PAGE_RESERVE = 4_000;

/** A capture on a page: whole, or one part of one too large for a page (SessionListCapture's part fields). */
export type PagedCapture = SessionListCapture;

interface PageEntry {
  /** The capture's place in stored order, or -1 for the summary. */
  readonly index: number;
  /** The summary or its part, or the capture's content or a slice of it ('' on a context part). */
  readonly text: string;
  /** A capture part's context slice; null when this part carries none. Absent on a whole entry. */
  readonly context?: string | null;
  readonly part?: number;
  readonly parts?: number;
}

/** The entries one page holds: captures or parts of one, then the summary or a part of it. */
export type SessionPage = readonly PageEntry[];

/**
 * The longest prefix of `text` that `fits`, cut only between whole code points; a code point that
 * alone does not fit is still taken, so a caller always advances. The search gallops out from one
 * code unit, so its probes cost about what the slice it finds does and a split stays linear in the
 * text (s107-m05 critic, round 2: a 4,000,000-character capture took 11 s a page call).
 */
export function firstSlice(text: string, fits: (slice: string) => boolean): string {
  let low = 0;
  let high = text.length;
  for (let probe = 1; probe < text.length; probe *= 2) {
    if (!fits(text.slice(0, probe))) {
      high = probe - 1;
      break;
    }
    low = probe;
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  let cut = low;
  if (cut > 0 && cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1;
  if (cut === 0) cut = /[\uD800-\uDBFF]/.test(text[0]) && text.length > 1 ? 2 : 1;
  return text.slice(0, cut);
}

/** The parts of `text` in order, each the longest prefix of the rest that `fits` (firstSlice). */
export function splitText(text: string, fits: (slice: string) => boolean): string[] {
  const parts: string[] = [];
  for (let rest = text; rest.length > 0; ) {
    const next = firstSlice(rest, fits);
    parts.push(next);
    rest = rest.slice(next.length);
  }
  return parts;
}

const cost = (value: unknown): number => JSON.stringify(value).length;
/** Wide enough for any page's numbers, so a part's cost never depends on how many parts follow. */
const WIDE = { part: 999, parts: 999, fullLength: 99_999_999 };
/**
 * Completion's values at their widest. Captures land only while a session is active and its
 * completion sets status, completedAt and the summary together, so a layout from these keeps every
 * capture page where a reader left it (s107-m05 critic, round 1).
 */
const WIDEST = {
  status: 'completed',
  completedAt: '0000-00-00T00:00:00.000Z',
  captureCount: 999_999,
};
/**
 * What every page pays for the summary it carries when it does not read it: a preview trimmed to
 * fit, charged whether or not a summary exists yet, so the summary's arrival moves no page.
 */
const PREVIEW_ALLOWANCE = 1_200;
/**
 * Below this much room for an entry's text in an empty page, its own fields (the session's, a
 * capture's, or the fence label a foreign session's text is framed with) are too long to page it.
 */
export const ENTRY_FLOOR = 2_000;
/**
 * The local project id an entry's cost is framed against: none, so a session with a project id
 * is costed framed whatever this store calls itself, and its identity changing between two reads
 * moves no page (s107-m05 critic, round 2).
 */
const COSTED_AS_FOREIGN = null;

/** What a page that does not read the summary pays to carry `text`: its fields and its lines. */
function previewCharge(
  text: string,
  projectId: string | null | undefined,
  localProjectId: string | null | undefined
): number {
  return (
    cost({ summary: text, summaryTruncated: true, summaryFullLength: WIDE.fullLength }) +
    Math.max(
      cost(previewLine(text, projectId, localProjectId)),
      cost(summaryLines(text, projectId, localProjectId).join('\n'))
    )
  );
}

/**
 * What every page reserves for the carried summary: PREVIEW_ALLOWANCE for its text beside the
 * frame a session with this project id prints around it, costed framed so identity moves nothing
 * (s107-m05 critic, round 3: a 3,860-character foreign id put 20 of 22 pages over the cap).
 */
function previewReserve(projectId: string | null | undefined): number {
  return PREVIEW_ALLOWANCE + previewCharge('', projectId, COSTED_AS_FOREIGN);
}

/** The summary as a page that does not read it carries it: whole when short, else a trimmed preview. */
function carriedSummary(
  summary: string,
  projectId: string | null | undefined,
  localProjectId: string | null | undefined
): { summary: string; truncated: boolean } {
  const limit = previewReserve(projectId);
  const charge = (text: string): number => previewCharge(text, projectId, localProjectId);
  if (charge(summary) <= limit) return { summary, truncated: false };
  // previewText folds whitespace too, so a preview that differs from the stored text is carried
  // as cut even when it is no shorter (s107-m05 critic, round 1); a blank one is carried empty.
  const preview = previewText(summary).preview;
  return {
    summary: preview ? firstSlice(preview, (slice) => charge(slice) <= limit) : '',
    truncated: true,
  };
}

/**
 * The session's pages, packed greedily under ANSWER_CHAR_CAP less PAGE_RESERVE from values neither
 * completion nor the store's identity can change: the captures in stored order, then the summary,
 * each entry costing its structured copy plus its rendered text. A session that fits whole is one
 * page. Null when an entry's own fields leave less than ENTRY_FLOOR for its text, which cannot be
 * paged without parts too small to read.
 */
export function packSessionPages(input: {
  readonly session: Omit<SessionListItem, 'captures'>;
  readonly captures: readonly SessionListCapture[];
  /** The caller's pageSize: at most this many captures, or parts of one, a page. */
  readonly maxCaptures?: number;
}): SessionPage[] | null {
  const { session, captures } = input;
  const { projectId } = session;
  // The session's own fields, counted twice for their text copy.
  const base = 2 * cost({ ...session, ...WIDEST, summary: null }) + 300;
  const summaryCost = (text: string, part: boolean): number =>
    cost(text) +
    (part ? cost(WIDE) : 0) +
    cost(summaryLines(text, projectId, COSTED_AS_FOREIGN, part ? WIDE : undefined).join('\n'));
  const captureCost = (capture: SessionListCapture): number =>
    cost(capture) + 1 + cost(captureLines(capture, projectId, COSTED_AS_FOREIGN).join('\n'));
  const partOf = (index: number, text: string, context: string | null): SessionListCapture => {
    const { context: _whole, ...fields } = captures[index];
    return { ...fields, content: text, ...(context !== null ? { context } : {}), ...WIDE };
  };
  const all: PageEntry[] = [
    ...captures.map((capture, index) => ({ index, text: capture.content })),
    ...(session.summary ? [{ index: -1, text: session.summary }] : []),
  ];
  // Whole when it fits: one page, answered as before (s107-m05 critic, round 2).
  const wholeCost =
    base +
    captures.reduce((sum, capture) => sum + captureCost(capture), 0) +
    (session.summary ? summaryCost(session.summary, false) : 0);
  if (
    wholeCost <= ANSWER_CHAR_CAP - PAGE_RESERVE &&
    (input.maxCaptures === undefined || captures.length <= input.maxCaptures)
  )
    return all.length ? [all] : [];
  const budget = ANSWER_CHAR_CAP - PAGE_RESERVE - base - previewReserve(projectId);
  const tooLong =
    budget - ENTRY_FLOOR <
    Math.max(
      0,
      // A context part prints its own fence beside its content's (s107-m05 critic, round 3).
      ...captures.map((capture, index) =>
        captureCost(partOf(index, '', capture.context ? 'x' : null))
      ),
      session.summary ? summaryCost('', true) : 0
    );
  if (tooLong) return null;

  const pages: SessionPage[] = [];
  let current: PageEntry[] = [];
  let used = 0;
  let shown = 0;
  const close = (): void => {
    if (current.length) pages.push(current);
    current = [];
    used = 0;
    shown = 0;
  };
  const add = (entry: PageEntry, entryUse: number): void => {
    current.push(entry);
    used += entryUse;
    if (entry.index >= 0) shown += 1;
  };
  /** Each part starts a page; the last shares its page with what follows. */
  const addParts = (entries: PageEntry[], costOf: (entry: PageEntry) => number): void =>
    entries.forEach((entry, k) => {
      if (k > 0) close();
      add(entry, costOf(entry));
    });
  const fitsPage = (use: number): boolean => use <= budget;

  captures.forEach((capture, index) => {
    const whole = captureCost(capture);
    const capped = input.maxCaptures !== undefined && shown >= input.maxCaptures;
    if (!capped && whole <= budget - used) return add({ index, text: capture.content }, whole);
    close();
    if (whole <= budget) return add({ index, text: capture.content }, whole);
    // Larger than a page: the content in parts, its context riding whole on the first when it
    // fits beside a slice, else in parts of its own after the content's. Only the first part
    // makes room for a context it carries.
    const context = capture.context ?? null;
    const contextFirst =
      context !== null &&
      captureCost(partOf(index, 'x'.repeat(ENTRY_FLOOR / 4), context)) <= budget;
    const first = contextFirst
      ? firstSlice(capture.content, (slice) => fitsPage(captureCost(partOf(index, slice, context))))
      : '';
    const content = [
      ...(contextFirst ? [first] : []),
      ...splitText(capture.content.slice(first.length), (slice) =>
        fitsPage(captureCost(partOf(index, slice, null)))
      ),
    ];
    const contextParts =
      context === null || contextFirst
        ? []
        : splitText(context, (slice) => fitsPage(captureCost(partOf(index, '', slice))));
    const total = content.length + contextParts.length;
    const entries: PageEntry[] = [
      ...content.map((text, k) => ({
        index,
        text,
        context: k === 0 && contextFirst ? context : null,
        part: k + 1,
        parts: total,
      })),
      ...contextParts.map((slice, k) => ({
        index,
        text: '',
        context: slice,
        part: content.length + k + 1,
        parts: total,
      })),
    ];
    addParts(entries, (entry) => captureCost(partOf(index, entry.text, entry.context ?? null)));
  });
  const summary = session.summary;
  if (summary) {
    const whole = summaryCost(summary, false);
    if (whole <= budget - used) add({ index: -1, text: summary }, whole);
    else {
      close();
      if (whole <= budget) add({ index: -1, text: summary }, whole);
      else {
        const texts = splitText(summary, (slice) => fitsPage(summaryCost(slice, true)));
        addParts(
          texts.map((text, k) => ({ index: -1, text, part: k + 1, parts: texts.length })),
          (entry) => summaryCost(entry.text, true)
        );
      }
    }
  }
  close();
  return pages;
}

/** The session item a page shows: the summary whole or as a part where read, else as carried. */
export function pageItem(
  session: Omit<SessionListItem, 'captures'>,
  captures: readonly SessionListCapture[],
  page: SessionPage | undefined,
  localProjectId: string | null | undefined
): SessionListItem & { captures: PagedCapture[] } {
  const read = page?.find((entry) => entry.index < 0);
  const summary = session.summary;
  const carried =
    summary && !read ? carriedSummary(summary, session.projectId, localProjectId) : null;
  const summaryFields = read?.parts
    ? {
        summary: read.text,
        summaryPart: read.part,
        summaryParts: read.parts,
        summaryFullLength: (summary ?? '').length,
      }
    : carried?.truncated
      ? {
          summary: carried.summary,
          summaryTruncated: true,
          summaryFullLength: (summary ?? '').length,
        }
      : { summary };
  const { summary: _whole, summaryTruncated: _t, summaryFullLength: _f, ...rest } = session;
  return {
    ...rest,
    // The readable captures: a stored entry fullCaptures skips is not counted as one to read.
    captureCount: captures.length,
    ...summaryFields,
    captures: (page ?? [])
      .filter((entry) => entry.index >= 0)
      .map((entry) => {
        const stored = captures[entry.index];
        if (!entry.parts) return { ...stored };
        const { context: _context, ...fields } = stored;
        return {
          ...fields,
          content: entry.text,
          ...(entry.context !== null && entry.context !== undefined
            ? { context: entry.context }
            : {}),
          part: entry.part,
          parts: entry.parts,
          fullLength: stored.content.length,
        };
      }),
  } as SessionListItem & { captures: PagedCapture[] };
}

/** Where a page's captures sit in stored order, 1-based, or undefined when it holds none. */
export function capturesShown(
  page: SessionPage | undefined
): { first: number; last: number } | undefined {
  const indexes = (page ?? []).filter((entry) => entry.index >= 0).map((entry) => entry.index + 1);
  return indexes.length ? { first: indexes[0], last: indexes[indexes.length - 1] } : undefined;
}

/**
 * One page of a named read, or no result when the session fits on one page and page 1 is asked
 * for, so the caller answers exactly as before. A session whose own fields are too long to page is
 * answered whole too, with a warning; past the last page the session comes with no captures.
 */
export function pagedSessionRead(input: {
  readonly item: SessionListItem;
  readonly page: number;
  readonly pageSize: number;
  readonly maxCaptures: number | undefined;
  readonly totalCount: number;
  readonly filters: RbookSessionListResult['filters'];
  readonly localProjectId: string | null | undefined;
  readonly callArgs: Readonly<Record<string, unknown>>;
}): { readonly result: RbookSessionListResult | null; readonly warning?: string } {
  const { captures = [], ...session } = input.item;
  const packed = packSessionPages({ session, captures, maxCaptures: input.maxCaptures });
  const warning =
    packed === null
      ? `Session ${session.id} has a field, its own or a capture's, too long to page it, so it is answered whole.`
      : undefined;
  const pages = packed ?? [];
  if ((packed === null || pages.length <= 1) && input.page === 1)
    return { result: null, ...(warning ? { warning } : {}) };
  const pageCount = packed === null ? 1 : Math.max(1, pages.length);
  const shown = capturesShown(pages[input.page - 1]);
  const following = input.page < pageCount ? input.page + 1 : null;
  return {
    result: {
      sessions: [pageItem(session, captures, pages[input.page - 1], input.localProjectId)],
      totalCount: input.totalCount,
      page: input.page,
      pageSize: input.pageSize,
      hasMore: following !== null,
      nextPage: following,
      nextPageCall: nextPageCall(following, 'rbook_session', input.callArgs),
      pageCount,
      ...(shown ? { capturesShown: shown } : {}),
      filters: input.filters,
      localProjectId: input.localProjectId,
    },
    ...(warning ? { warning } : {}),
  };
}

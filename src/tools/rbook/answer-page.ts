// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m03 — one page of a capped answer: which rows it holds, its stated total, its next page.
// ABOUTME: An answer whose default passed 20,000 characters returns fewer rows per page, never fewer fields.

/**
 * s106-m03 (design settled item 5). A list, search or report answer whose default ran past 20,000
 * characters of serialized result returns a page instead: fewer rows, each with every field, the
 * total for its filter, and the call that reads the next page. Long text keeps the s92-m08 preview
 * (text-preview.ts), only where a show action expands it.
 */
export const ANSWER_CHAR_CAP = 20_000;

/**
 * A list the reader acts on (resolve, archive, complete) loses each row it changes, and the rows
 * after it move up a page, so a Next page call made after acting skips them (the s106-m03 critic's
 * finding). Those lists carry this note, in the text and the structured copy, while a page follows.
 */
export const REREAD_AFTER_ACTING =
  'A row you change so it leaves this list moves the later rows up: after acting on rows of this page, read it again before making the Next page call.';

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

export function pageRequest(
  page: number | undefined,
  pageSize: number | undefined,
  defaultPageSize: number
): PageRequest {
  const at = page ?? 1;
  const size = pageSize ?? defaultPageSize;
  return { page: at, pageSize: size, offset: (at - 1) * size };
}

export interface PageFacts {
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly hasMore: boolean;
  /** The next page's number, or null on the last page. */
  readonly nextPage: number | null;
}

export function pageFacts(request: PageRequest, returned: number, totalCount: number): PageFacts {
  const hasMore = request.offset + returned < totalCount;
  return {
    page: request.page,
    pageSize: request.pageSize,
    totalCount,
    hasMore,
    nextPage: hasMore ? request.page + 1 : null,
  };
}

/** "Showing 21–40 of 260 entries"; "0 of 0 entries" when none match; past the last page, says so. */
export function shownLine(
  facts: Pick<PageFacts, 'page' | 'pageSize' | 'totalCount'>,
  returned: number,
  noun: string
): string {
  const first = (facts.page - 1) * facts.pageSize + 1;
  if (returned > 0)
    return `Showing ${first}–${first + returned - 1} of ${facts.totalCount} ${noun}`;
  return facts.page === 1
    ? `0 of ${facts.totalCount} ${noun}`
    : `No ${noun} on page ${facts.page}; ${facts.totalCount} in all`;
}

/**
 * A value quoted as JSON, with backticks and line separators escaped too, so a crafted project
 * root cannot open a code fence or a line in the answer text, as the answer's Project line already
 * guards (inertProjectRoot, src/index.ts). The quoted text still decodes to the same value.
 */
function quoted(value: unknown): string {
  return JSON.stringify(value).replace(
    /[`\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** A call as an agent would write it; undefined arguments are left out. */
export function callText(tool: string, args: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'number' || typeof value === 'boolean' ? String(value) : quoted(value)}`
    );
  return `${tool}(${parts.join(', ')})`;
}

/** The call that reads the next page, repeating the caller's filters, or null on the last page. */
export function nextPageCall(
  nextPage: number | null,
  tool: string,
  args: Readonly<Record<string, unknown>>
): string | null {
  return nextPage === null ? null : callText(tool, { ...args, page: nextPage });
}

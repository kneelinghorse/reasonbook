// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m05 (#879): a named session read pages its summary and captures under the 20,000-character answer cap.
// ABOUTME: Following each Next page call reassembles the stored captures exactly; a one-page session answers as at c5b8f823.

import * as fs from 'fs';
import * as path from 'path';
import { splitText } from '../../../src/tools/rbook/session-read-pages';
import { parseCall } from '../../helpers/parse-call';
import {
  appendCapture,
  completeSession,
  dispatch,
  normalized,
  onePageStore,
  readSession,
  SESSION,
  sessionStore,
  setStoreIdentity,
  type CallResult,
  type SessionStore,
  type StoredCapture,
} from '../../helpers/session-read-fixture';

/** The answer cap s106-m03 set (answer-page.ts ANSWER_CHAR_CAP), counted on the whole result. */
const CAP = 20_000;
/** The whole one-page answer as c5b8f823 gave it, root and times replaced (the exact string). */
const GOLDEN = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'session-one-page.c5b8f823.json'), 'utf8')
  ) as { answer: string }
).answer;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Capture = { -readonly [K in keyof StoredCapture]: StoredCapture[K] } & {
  part?: number;
  parts?: number;
  fullLength?: number;
};
type Data = {
  sessions: Array<{
    id: string;
    summary: string | null;
    summaryParts?: number;
    summaryTruncated?: boolean;
    summaryFullLength?: number;
    captureCount: number;
    captures?: Capture[];
  }>;
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  nextPageCall: string | null;
  pageCount?: number;
  capturesShown?: { first: number; last: number };
  totalCount: number;
};

const data = (result: CallResult): Data => (result.structuredContent as { data: Data }).data;
const text = (result: CallResult): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

/** Dense with what costs most to serialize: quotes, newlines, backslashes, backticks, emoji. */
function dense(length: number): string {
  const unit = 'a"\n🧪\\b`🧪';
  let out = '';
  while (out.length < length) out += unit;
  // End on a whole code point.
  return /[\uD800-\uDBFF]$/.test(out.slice(0, length))
    ? out.slice(0, length + 1)
    : out.slice(0, length);
}

function bigCaptures(): StoredCapture[] {
  const base = Date.now() - 600_000;
  return Array.from({ length: 70 }, (_, i) => ({
    category: i % 3 === 0 ? 'learning' : 'next-step',
    content:
      i === 35
        ? dense(30_000)
        : `Capture ${i}: "quoted", a\nnewline and 🧪 ` + 'x'.repeat(200 + ((i * 37) % 900)),
    timestamp: new Date(base + i * 1_000).toISOString(),
    ...(i % 5 === 0 ? { context: `Context ${i}, with "quotes" and\na newline.` } : {}),
    ...(i % 7 === 0 ? { missionId: `s9-m${i}` } : {}),
  }));
}

const SUMMARY = `The summary, "quoted" and\nlong: ${'s'.repeat(9_000)}`.slice(0, 9_000);

/** Every page from the first, by each answer's own Next page call. */
async function follow(first: CallResult, between?: () => void): Promise<CallResult[]> {
  const pages = [first];
  between?.();
  for (
    let next = data(first).nextPageCall;
    next;
    next = data(pages[pages.length - 1]).nextPageCall
  ) {
    const call = parseCall(next);
    pages.push(await dispatch(call.tool, Object.fromEntries(call.args)));
    expect(pages.length).toBeLessThan(200);
  }
  return pages;
}

/** The captures the pages hold, with each split capture's parts joined back. */
function reassemble(pages: readonly CallResult[]): StoredCapture[] {
  const out: Capture[] = [];
  for (const page of pages)
    for (const capture of data(page).sessions[0].captures ?? []) {
      if (capture.part !== undefined && capture.part > 1) {
        const last = out[out.length - 1];
        expect(last.parts).toBe(capture.parts);
        last.content += capture.content;
        // A context too large to ride on the first part follows in parts of its own.
        if (capture.context !== undefined) last.context = (last.context ?? '') + capture.context;
        continue;
      }
      out.push({ ...capture });
    }
  return out.map(({ part: _p, parts: _ps, fullLength, ...capture }) => {
    if (fullLength !== undefined) expect(capture.content).toHaveLength(fullLength);
    return capture;
  });
}

const stored = (captures: readonly StoredCapture[]): StoredCapture[] =>
  captures.map((capture) => ({ ...capture }));

let store: SessionStore | undefined;
afterEach(() => {
  store?.cleanup();
  store = undefined;
});

describe('a named session read in pages (s107-m05, #879)', () => {
  it('a session that fits on one page answers byte-identically to c5b8f823', async () => {
    store = onePageStore();
    const result = await readSession({ sessionId: SESSION, projectRoot: store.root });
    expect(normalized(result, store)).toBe(GOLDEN);
  });

  it.each([
    ['a local session', {}],
    ['a foreign session', { foreignProject: 'another-project' }],
    ['a 200-character project root', { rootLength: 200 }],
  ])(
    '%s: every page is under the cap, and the pages reassemble the stored captures',
    async (_name, variant) => {
      const captures = bigCaptures();
      store = sessionStore({ summary: SUMMARY, captures, ...variant });
      if ('rootLength' in variant) expect(store.root).toHaveLength(200);
      const pages = await follow(
        await readSession({ sessionId: SESSION, projectRoot: store.root })
      );
      expect(pages.length).toBeGreaterThan(2);
      const count = data(pages[0]).pageCount;
      pages.forEach((page, i) => {
        expect(JSON.stringify(page).length).toBeLessThan(CAP);
        expect(data(page)).toMatchObject({ page: i + 1, pageCount: count, totalCount: 1 });
        expect(data(page).sessions[0].captureCount).toBe(70);
        // Every fence a foreign page opens, it closes: parts were cut before framing.
        const shown = text(page);
        expect(shown.split('[UNTRUSTED DATA').length).toBe(
          shown.split('[END UNTRUSTED DATA]').length
        );
        for (const capture of data(page).sessions[0].captures ?? [])
          expect(LONE_SURROGATE.test(capture.content)).toBe(false);
      });
      expect(count).toBe(pages.length);
      expect(reassemble(pages)).toEqual(stored(captures));
      // The summary is read last, after every capture, whole or in parts that join back; every
      // other page carries it cut, so its arrival at completion moves no capture page.
      const summaries = pages.map((page) => data(page).sessions[0]);
      const first = summaries.findIndex((session) => !session.summaryTruncated);
      expect(first).toBeGreaterThan(0);
      expect(
        summaries
          .slice(first)
          .map((session) => session.summary)
          .join('')
      ).toBe(SUMMARY);
      for (const carried of summaries.slice(0, first))
        expect(carried).toMatchObject({
          summaryTruncated: true,
          summaryFullLength: SUMMARY.length,
        });
      // The split capture says which part each page holds, and the text says the page.
      const split = pages.flatMap((page) =>
        (data(page).sessions[0].captures ?? []).filter((capture) => capture.parts !== undefined)
      );
      expect(split.length).toBeGreaterThan(1);
      expect(split.every((part) => part.fullLength === 30_000)).toBe(true);
      expect(text(pages[1])).toContain(`*Page 2 of ${count}.*`);
    }
  );

  it('a capture appended between pages is neither skipped nor repeated', async () => {
    const captures = bigCaptures();
    store = sessionStore({ summary: SUMMARY, captures });
    const extra = {
      category: 'learning',
      content: 'Appended while the reader was on page one.',
      timestamp: new Date().toISOString(),
    };
    const dbPath = store.dbPath;
    const pages = await follow(
      await readSession({ sessionId: SESSION, projectRoot: store.root }),
      () => appendCapture(dbPath, extra)
    );
    expect(reassemble(pages)).toEqual([...stored(captures), extra]);
  });

  it('pageSize caps the captures a page holds, and the Next page call keeps it', async () => {
    const captures = bigCaptures();
    store = sessionStore({ summary: SUMMARY, captures });
    const pages = await follow(
      await readSession({ sessionId: SESSION, pageSize: 5, projectRoot: store.root })
    );
    for (const page of pages) {
      expect((data(page).sessions[0].captures ?? []).length).toBeLessThanOrEqual(5);
      if (data(page).nextPageCall) expect(data(page).nextPageCall).toContain('pageSize=5');
    }
    expect(reassemble(pages)).toEqual(stored(captures));
  });

  it('past the last page, the answer says so, with the totals', async () => {
    store = sessionStore({ summary: SUMMARY, captures: bigCaptures() });
    const first = await readSession({ sessionId: SESSION, projectRoot: store.root });
    const past = (data(first).pageCount ?? 0) + 1;
    const result = await readSession({ sessionId: SESSION, page: past, projectRoot: store.root });
    expect(data(result)).toMatchObject({ hasMore: false, nextPage: null, nextPageCall: null });
    expect(data(result).sessions[0].captures).toEqual([]);
    expect(text(result)).toContain(
      `No page ${past}: this session has ${past - 1} pages and 70 captures.`
    );
  });
});

describe('splitText (s107-m05)', () => {
  it('cuts where the slice fits, never inside a surrogate pair, and the parts join back exactly', () => {
    const value = 'ab🧪cd🧪';
    const parts = splitText(value, (slice) => slice.length <= 3);
    expect(parts).toEqual(['ab', '🧪c', 'd🧪']);
    expect(parts.join('')).toBe(value);
    for (const part of parts) expect(LONE_SURROGATE.test(part)).toBe(false);
  });

  it('still advances by a whole code point when even one does not fit', () => {
    expect(splitText('🧪x', () => false)).toEqual(['🧪', 'x']);
  });
});

describe('a named read in pages, by the round-1 critic (s107-m05)', () => {
  it('a session completed while it is read moves no page: no capture is read twice or rejoined wrong', async () => {
    const base = Date.now() - 300_000;
    const captures = Array.from({ length: 14 }, (_, i) => ({
      category: 'learning',
      content: i === 5 ? dense(12_039) : `Active capture ${i}: ${'y'.repeat(900)}`,
      timestamp: new Date(base + i * 1_000).toISOString(),
    }));
    // Captures land only while a session is active; completion sets its summary afterwards.
    store = sessionStore({ summary: null, captures, active: true });
    const first = await readSession({ sessionId: SESSION, projectRoot: store.root });
    const call = parseCall(data(first).nextPageCall as string);
    const second = await dispatch(call.tool, Object.fromEntries(call.args));
    const summary = `Done: ${'z'.repeat(5_000)}`;
    completeSession(store.dbPath, summary);
    // Page 2 read again after completion holds exactly what it held before.
    const again = await dispatch(call.tool, Object.fromEntries(call.args));
    expect(data(again).sessions[0].captures).toEqual(data(second).sessions[0].captures);
    const rest = await follow(second);
    expect(reassemble([first, ...rest])).toEqual(stored(captures));
    expect(data(rest[rest.length - 1]).sessions[0].summary).toBe(summary);
  });

  it('a context larger than a page is split too, so every page stays under the cap', async () => {
    const captures = [
      {
        category: 'learning',
        content: 'The capture whose context is a log.',
        timestamp: new Date().toISOString(),
        context: 'log line\n'.repeat(2_800),
      },
      ...bigCaptures().slice(0, 3),
    ];
    store = sessionStore({ summary: 'Short.', captures });
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThan(CAP);
    expect(reassemble(pages)).toEqual(stored(captures));
  });

  it('a session whose own fields leave no room to page is answered whole, and says so', async () => {
    store = sessionStore({
      summary: 'Short.',
      captures: bigCaptures().slice(0, 3),
      agent: 'a'.repeat(9_806),
    });
    const result = await readSession({ sessionId: SESSION, projectRoot: store.root });
    expect(data(result).pageCount).toBeUndefined();
    expect(data(result).sessions[0].captures).toHaveLength(3);
    expect((result.structuredContent as { warnings?: string[] }).warnings).toEqual([
      expect.stringContaining("has a field, its own or a capture's, too long to page it"),
    ]);
  });

  it('a summary that is mostly whitespace is carried cut, so later pages stay under the cap', async () => {
    store = sessionStore({
      summary: `Start ${'\n'.repeat(12_000)} end.`,
      captures: bigCaptures().filter((_, i) => i !== 35),
    });
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThan(CAP);
  });

  it('counts the readable captures, and a summary in parts carries its full length', async () => {
    const summary = `A long summary, ${'w'.repeat(30_000)}`;
    store = sessionStore({ summary, captures: bigCaptures(), malformed: [{ content: 7 }, 'bad'] });
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    for (const page of pages) expect(data(page).sessions[0].captureCount).toBe(70);
    const parts = pages
      .map((page) => data(page).sessions[0])
      .filter((session) => session.summaryParts !== undefined);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((session) => session.summaryFullLength === summary.length)).toBe(true);
    expect(parts.map((session) => session.summary).join('')).toBe(summary);
    const past = await readSession({
      sessionId: SESSION,
      page: pages.length + 1,
      projectRoot: store.root,
    });
    expect(text(past)).toContain(`this session has ${pages.length} pages and 70 captures.`);
  });
});

describe('a named read in pages, by the round-2 critic (s107-m05)', () => {
  const now = (): string => new Date().toISOString();
  const warnings = (result: CallResult): string[] =>
    (result.structuredContent as { warnings?: string[] }).warnings ?? [];

  it('a session that fits on one page is answered as before, with no warning, however long its fields', async () => {
    store = sessionStore({
      summary: 'Short.',
      captures: [{ category: 'learning', content: 'c'.repeat(50), timestamp: now() }],
      agent: 'a'.repeat(6_606),
    });
    const result = await readSession({ sessionId: SESSION, projectRoot: store.root });
    expect(data(result).pageCount).toBeUndefined();
    expect(warnings(result)).toEqual([]);
  });

  it.each([
    [
      'a capture whose mission id is 10,500 characters',
      {
        captures: [
          { category: 'context', content: 'c'.repeat(100), missionId: 'M'.repeat(10_500) },
        ],
      },
    ],
    [
      'a 2,000-character capture whose mission id is 7,000 characters',
      { captures: [{ category: 'context', content: dense(2_000), missionId: 'M'.repeat(7_000) }] },
    ],
    [
      'a foreign session whose project id is 5,000 characters',
      {
        foreignProject: 'p'.repeat(5_000),
        captures: [0, 1, 2].map((i) => ({ category: 'learning', content: `${i}`.repeat(40) })),
      },
    ],
  ])('%s is answered whole and says so, never in parts of a character', async (_name, variant) => {
    const captures = variant.captures.map((capture) => ({ ...capture, timestamp: now() }));
    store = sessionStore({ summary: 'Short.', ...variant, captures });
    const result = await readSession({ sessionId: SESSION, projectRoot: store.root });
    expect(data(result).pageCount).toBeUndefined();
    expect(data(result).sessions[0].captures).toEqual(stored(captures));
    expect(warnings(result)).toEqual([expect.stringContaining('so it is answered whole')]);
  });

  it("the store's identity changing between reads moves no page", async () => {
    // Stamped with this store's own id, so it reads unframed until the store's identity changes.
    store = sessionStore({
      summary: SUMMARY,
      captures: bigCaptures(),
      foreignProject: 'session-pages',
    });
    const first = await readSession({ sessionId: SESSION, projectRoot: store.root });
    const call = parseCall(data(first).nextPageCall as string);
    const second = await dispatch(call.tool, Object.fromEntries(call.args));
    setStoreIdentity(store.dbPath, 'renamed-project');
    const again = await dispatch(call.tool, Object.fromEntries(call.args));
    expect(text(second)).not.toContain('[UNTRUSTED DATA');
    expect(text(again)).toContain('[UNTRUSTED DATA');
    expect(data(again).pageCount).toBe(data(second).pageCount);
    expect(data(again).sessions[0].captures).toEqual(data(second).sessions[0].captures);
  });

  it('a session read in pages with one capture says "1 capture"', async () => {
    store = sessionStore({
      summary: 'Short.',
      captures: [{ category: 'learning', content: dense(30_000), timestamp: now() }],
    });
    const first = await readSession({ sessionId: SESSION, projectRoot: store.root });
    expect(data(first).pageCount).toBeGreaterThan(1);
    expect(text(first)).toContain('(1 capture)');
  });

  it('an empty context on a capture read in parts is kept', async () => {
    const captures = [
      { category: 'learning', content: dense(30_000), timestamp: now(), context: '' },
    ];
    store = sessionStore({ summary: 'Short.', captures });
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    expect(pages.length).toBeGreaterThan(1);
    expect(reassemble(pages)).toEqual(stored(captures));
  });

  it('a whitespace-only summary too long to carry whole is carried as an empty preview', async () => {
    store = sessionStore({ summary: '\n'.repeat(12_000), captures: bigCaptures() });
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    const carried = pages.map((page) => data(page).sessions[0]).filter((s) => s.summaryTruncated);
    expect(carried.length).toBeGreaterThan(0);
    for (const session of carried) expect(session.summary).toBe('');
  });

  it('a context riding on the first part costs at most one page, not a share of every part', async () => {
    const content = 'x'.repeat(30_000);
    const read = async (context?: string): Promise<CallResult[]> => {
      const captures = [
        { category: 'learning', content, timestamp: now(), ...(context ? { context } : {}) },
      ];
      store?.cleanup();
      store = sessionStore({ summary: 'Short.', captures });
      const pages = await follow(
        await readSession({ sessionId: SESSION, projectRoot: store.root })
      );
      expect(reassemble(pages)).toEqual(stored(captures));
      return pages;
    };
    const plain = (await read()).length;
    expect((await read('c'.repeat(6_000))).length).toBeLessThanOrEqual(plain + 1);
  });
});

describe('a named read in pages, by the round-3 critic (s107-m05)', () => {
  const now = (): string => new Date().toISOString();
  /** Every page under the cap, or the session answered whole with the warning that says why. */
  const pagedOrWhole = (pages: readonly CallResult[]): void => {
    if (data(pages[0]).pageCount === undefined) {
      expect(pages).toHaveLength(1);
      // A store with no recorded identity says so in a warning of its own.
      expect((pages[0].structuredContent as { warnings?: string[] }).warnings).toContainEqual(
        expect.stringContaining('so it is answered whole')
      );
      return;
    }
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThan(CAP);
  };

  // A context part prints its own fence beside its content's, so its floor counts both: before
  // round 3 a 3,400-character foreign id cut a 3,000-character context into one-character parts.
  it.each([3_400, 3_750])(
    'a foreign context beside a %i-character project id is never read a character a page',
    async (length) => {
      const captures = [
        { category: 'learning', content: 'Content of fifty characters, more or less........' },
        { category: 'learning', content: 'Second.', context: 'k'.repeat(3_000) },
      ].map((capture) => ({ ...capture, timestamp: now() }));
      store = sessionStore({
        summary: 'A short summary.',
        captures,
        foreignProject: 'p'.repeat(length),
      });
      const pages = await follow(
        await readSession({ sessionId: SESSION, projectRoot: store.root })
      );
      expect(pages.length).toBeLessThan(20);
      pagedOrWhole(pages);
      expect(reassemble(pages)).toEqual(stored(captures));
    }
  );

  // The carried preview's frame is reserved beside its allowance: the critic's stack put 20 of 22
  // pages over the cap, and a shorter foreign id still pages under it.
  it.each([
    ['a 3,860-character foreign id, a 480-character root and no recorded identity', 3_860],
    ['a 2,500-character foreign id, a 480-character root and no recorded identity', 2_500],
  ])("%s: the carried summary's frame keeps every page under the cap", async (_name, length) => {
    const base = Date.now() - 600_000;
    const captures = Array.from({ length: 20 }, (_, i) => ({
      category: 'learning',
      content: `Filler ${i} ` + 'f'.repeat(900),
      timestamp: new Date(base + i * 1_000).toISOString(),
    }));
    store = sessionStore({
      summary: 'A summary that is long enough to be carried as a preview. ' + 'w '.repeat(600),
      captures,
      foreignProject: 'p'.repeat(length),
      rootLength: 480,
    });
    setStoreIdentity(store.dbPath, null);
    const pages = await follow(await readSession({ sessionId: SESSION, projectRoot: store.root }));
    pagedOrWhole(pages);
    if (length === 2_500) expect(data(pages[0]).pageCount).toBeGreaterThan(1);
    expect(reassemble(pages)).toEqual(stored(captures));
  });
});

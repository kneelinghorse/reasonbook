// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m03 — the answers every registered store's largest case put past the cap: next steps,
// ABOUTME: constraints, the session list and the work queue page or preview, state totals, name the rest.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { formatContextForLLM, rbookContext } from '../../../src/tools/rbook/rbook-context';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import {
  formatMissionStatusForLLM,
  rbookMissionStatus,
} from '../../../src/tools/rbook/rbook-mission-status';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';
import { REREAD_AFTER_ACTING } from '../../../src/tools/rbook/answer-page';
import { rbookContextView } from '../../../src/tools/rbook/rbook-context-view';
import { rbookFeedback } from '../../../src/tools/rbook/rbook-feedback';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import type { NextStepsResult } from '../../../src/tools/rbook/rbook-next-steps';
import type { ConstraintsResult } from '../../../src/tools/rbook/rbook-constraints';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s106m03-pages-'));
  dbPath = seedRbookDb(root, { projectName: 'pages' });
  RbookDetector.resetInstance();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Rows a second apart, oldest first, so the list's order is ascending id. */
function seed(table: 'next_steps' | 'constraints', count: number, sameInstant = false): number[] {
  const db = new Database(dbPath);
  try {
    const status = table === 'next_steps' ? 'pending' : 'active';
    const insert = db.prepare(
      `INSERT INTO ${table} (content, status, created_at) VALUES (?, ?, ?)`
    );
    const start = Date.now() - 400 * 86_400_000;
    const ids: number[] = [];
    for (let i = 0; i < count; i++)
      ids.push(
        Number(
          insert.run(
            `${table} row ${i + 1}`,
            status,
            new Date(sameInstant ? start : start + i * 1000).toISOString()
          ).lastInsertRowid
        )
      );
    return ids;
  } finally {
    db.close();
  }
}

async function call(params: Record<string, unknown>) {
  RbookDetector.resetInstance();
  return rbookContext({ projectRoot: root, ...params } as never);
}

describe('next-steps list pages (s106-m03)', () => {
  it('returns 15 open rows by default, states the total and names the next page', async () => {
    // A registered store with 207 open next steps answered 155,898 characters in one list.
    seed('next_steps', 25);
    const result = (await call({ action: 'next_steps' })) as RbookToolResult<NextStepsResult>;
    expect(result.data?.items).toHaveLength(15);
    expect(result.data).toMatchObject({ totalCount: 25, page: 1, hasMore: true, nextPage: 2 });
    const text = formatContextForLLM('next_steps', result as never);
    expect(text).toContain('Showing 1–15 of 25 next steps');
    expect(text).toContain(
      `Next page: rbook_context(action="next_steps", nextStepAction="list", projectRoot=${JSON.stringify(root)}, page=2).`
    );
  });

  it('reaches every row once, oldest first, through the pages, with the filters repeated', async () => {
    const ids = seed('next_steps', 7, true);
    const seen: number[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = (await call({
        action: 'next_steps',
        nextStepAction: 'list',
        nextStepStatus: 'pending',
        pageSize: 3,
        page,
      })) as RbookToolResult<NextStepsResult>;
      seen.push(...result.data!.items!.map((item) => item.id));
      page = result.data!.nextPage ?? null;
      if (page !== null)
        expect(formatContextForLLM('next_steps', result as never)).toContain(
          `Next page: rbook_context(action="next_steps", nextStepAction="list", nextStepStatus="pending", pageSize=3, projectRoot=${JSON.stringify(root)}, page=${page}).`
        );
    }
    // Rows made in the same instant still come in id order, so no page repeats or skips one.
    expect(seen).toEqual(ids);
  });

  it('still shows every named row: show is not paged', async () => {
    const ids = seed('next_steps', 25);
    const result = (await call({
      action: 'next_steps',
      nextStepAction: 'show',
      nextStepIds: ids,
    })) as RbookToolResult<NextStepsResult>;
    expect(result.data?.items).toHaveLength(25);
    expect(result.data?.nextPage).toBeUndefined();
  });
});

describe('constraints list and review pages (s106-m03)', () => {
  it('lists 4 constraints a page, with the total and the next page', async () => {
    // A registered store's 14 active constraints answered 32,493 characters, each in full.
    seed('constraints', 10);
    const result = (await call({ action: 'constraints' })) as RbookToolResult<ConstraintsResult>;
    expect(result.data?.items).toHaveLength(4);
    expect(result.data).toMatchObject({ totalCount: 10, page: 1, hasMore: true, nextPage: 2 });
    const text = formatContextForLLM('constraints', result as never);
    expect(text).toContain('Showing 1–4 of 10 constraints');
    expect(text).toContain(
      `Next page: rbook_context(action="constraints", projectRoot=${JSON.stringify(root)}, page=2).`
    );
    const last = (await call({
      action: 'constraints',
      page: 3,
    })) as RbookToolResult<ConstraintsResult>;
    expect(last.data?.items).toHaveLength(2);
    expect(last.data).toMatchObject({ hasMore: false, nextPage: null });
  });

  it('reviews 6 flagged constraints a page, most stale first, every one reached once', async () => {
    // A registered store's review answered 22,944 characters for 16 flagged constraints.
    const ids = seed('constraints', 13);
    const seen: number[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = (await call({
        action: 'constraints',
        constraintAction: 'review',
        page,
      })) as RbookToolResult<ConstraintsResult>;
      expect(result.data).toMatchObject({ totalCount: 13 });
      seen.push(...result.data!.reviewItems!.map((item) => item.id));
      page = result.data!.nextPage ?? null;
      if (page !== null)
        expect(formatContextForLLM('constraints', result as never)).toContain(
          `Next page: rbook_context(action="constraints", constraintAction="review", projectRoot=${JSON.stringify(root)}, page=${page}).`
        );
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(seen).size).toBe(13);
  });
});

describe('session list and work queue (s106-m03)', () => {
  it('lists 15 sessions a page by default', async () => {
    // 20 rows were 20,787 characters on a registered store.
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, status) VALUES (?, 'review', ?, ?, 'completed')`
    );
    for (let i = 0; i < 17; i++)
      insert.run(`PS-${i}`, `Session ${i}`, new Date(Date.now() - i * 60_000).toISOString());
    db.close();
    RbookDetector.resetInstance();
    const result = (await rbookSession({ action: 'list', projectRoot: root } as never)) as {
      data?: { sessions: unknown[]; pageSize: number; hasMore: boolean; totalCount: number };
    };
    expect(result.data).toMatchObject({ pageSize: 15, hasMore: true });
    expect(result.data?.sessions).toHaveLength(15);
    expect(result.data!.totalCount).toBeGreaterThanOrEqual(17);
  });

  it('previews the active sprint focus in the work queue and names sprint show', async () => {
    // A registered store's 9,296-character focus put its work queue at 23,183 characters.
    const long = 'focus '.repeat(200).trim();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO sprints (id, title, focus, status) VALUES ('sprint-9', 'Nine', ?, 'Active')`
    ).run(long);
    db.close();
    RbookDetector.resetInstance();
    const result = await rbookMissionStatus({ projectRoot: root });
    expect(result.data?.activeSprint).toMatchObject({
      id: 'sprint-9',
      focusTruncated: true,
      focusFullLength: long.length,
    });
    expect(result.data!.activeSprint!.focus!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(formatMissionStatusForLLM(result)).toContain(
      'rbook_sprint(action="show", sprintId="sprint-9") reads it whole'
    );
  });
});

describe('acting on a page (critic rounds 1 and 2)', () => {
  /**
   * Act on the even-numbered rows of each page and leave the odd ones, re-reading a page after
   * acting when `reread` is set. Acting on a property of the row, not its place on the page, fills
   * page 1 with rows left alone, so the walk must make Next page calls to reach the rest.
   */
  async function walk(
    read: (
      page: number
    ) => Promise<{ ids: number[]; nextPage: number | null; note?: string | null }>,
    act: (ids: number[]) => Promise<void>,
    reread: boolean
  ): Promise<{ seen: Set<number>; lastPage: number }> {
    const seen = new Set<number>();
    const handled = new Set<number>();
    let page = 1;
    for (let calls = 0; calls < 60; calls++) {
      const { ids, nextPage } = await read(page);
      ids.forEach((id) => seen.add(id));
      const fresh = ids.filter((id) => !handled.has(id));
      fresh.forEach((id) => handled.add(id));
      const acted = fresh.filter((id) => id % 2 === 0);
      if (acted.length > 0) await act(acted);
      if (reread && acted.length > 0) continue;
      if (nextPage === null) break;
      page = nextPage;
    }
    return { seen, lastPage: page };
  }

  it('next steps: paging on after completing rows skips some; re-reading reaches all', async () => {
    const readNext = async (page: number) => {
      const r = (await call({
        action: 'next_steps',
        pageSize: 3,
        page,
      })) as RbookToolResult<NextStepsResult>;
      return {
        ids: r.data!.items!.map((item) => item.id),
        nextPage: r.data!.nextPage ?? null,
        note: r.data!.pageNote,
      };
    };
    const complete = async (ids: number[]) => {
      await call({ action: 'next_steps', nextStepAction: 'complete', nextStepIds: ids });
    };
    const first = seed('next_steps', 12);
    expect((await readNext(1)).note).toBe(REREAD_AFTER_ACTING);
    const { seen: skipped } = await walk(readNext, complete, false);
    expect(first.some((id) => !skipped.has(id))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s106m03-pages-'));
    dbPath = seedRbookDb(root, { projectName: 'pages' });
    const ids = seed('next_steps', 12);
    const { seen: reached, lastPage } = await walk(readNext, complete, true);
    expect(ids.filter((id) => !reached.has(id))).toEqual([]);
    // Non-vacuity: the rows past page 1 were reached through Next page calls.
    expect(lastPage).toBeGreaterThanOrEqual(2);
  });

  it('constraints: paging on after archiving rows skips some; re-reading reaches all', async () => {
    const readList = async (page: number) => {
      const r = (await call({
        action: 'constraints',
        pageSize: 3,
        page,
      })) as RbookToolResult<ConstraintsResult>;
      return {
        ids: r.data!.items!.map((item) => item.id),
        nextPage: r.data!.nextPage ?? null,
        note: r.data!.pageNote,
      };
    };
    const archive = async (ids: number[]) => {
      await call({ action: 'constraints', constraintAction: 'archive', constraintIds: ids });
    };
    const first = seed('constraints', 10);
    expect((await readList(1)).note).toBe(REREAD_AFTER_ACTING);
    const { seen: skipped } = await walk(readList, archive, false);
    expect(first.some((id) => !skipped.has(id))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s106m03-pages-'));
    dbPath = seedRbookDb(root, { projectName: 'pages' });
    const ids = seed('constraints', 10);
    const { seen: reached, lastPage } = await walk(readList, archive, true);
    expect(ids.filter((id) => !reached.has(id))).toEqual([]);
    expect(lastPage).toBeGreaterThanOrEqual(2);
  });

  it('the session list names its next page in the structured copy', async () => {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, status) VALUES (?, 'review', ?, ?, 'completed')`
    );
    for (let i = 0; i < 17; i++)
      insert.run(`PS-${i}`, `Session ${i}`, new Date(Date.now() - i * 60_000).toISOString());
    db.close();
    RbookDetector.resetInstance();
    const result = (await rbookSession({ action: 'list', projectRoot: root } as never)) as {
      data?: { nextPage: number | null; nextPageCall: string | null };
    };
    expect(result.data).toMatchObject({
      nextPage: 2,
      nextPageCall: `rbook_session(action="list", projectRoot=${JSON.stringify(root)}, page=2)`,
    });
  });
});

describe('what each page says and repeats (critic round 3)', () => {
  it('puts the re-read note in both copies of every page that has a next page, and not on the last', async () => {
    seed('next_steps', 7);
    seed('constraints', 7);
    for (const action of ['next_steps', 'constraints'] as const) {
      let page: number | null = 1;
      let pages = 0;
      while (page !== null) {
        const result = (await call({ action, pageSize: 3, page })) as RbookToolResult<
          NextStepsResult | ConstraintsResult
        >;
        const text = formatContextForLLM(action, result as never);
        const next = result.data!.nextPage ?? null;
        expect({
          action,
          page,
          structured: result.data!.pageNote ?? null,
          text: text.includes(REREAD_AFTER_ACTING),
        }).toEqual({
          action,
          page,
          structured: next === null ? null : REREAD_AFTER_ACTING,
          text: next !== null,
        });
        pages += 1;
        page = next;
      }
      expect(pages).toBe(3);
    }
  });

  it('repeats the session list filters and page size in its next-page call, reaching every row once', async () => {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, status) VALUES (?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 5; i++)
      insert.run(
        `PS-R${i}`,
        'review',
        `Review ${i}`,
        new Date(Date.now() - i * 60_000).toISOString(),
        'completed'
      );
    insert.run('PS-P0', 'planning', 'Planning', new Date().toISOString(), 'completed');
    db.close();
    RbookDetector.resetInstance();
    const seen: string[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = (await rbookSession({
        action: 'list',
        status: 'completed',
        type: 'review',
        pageSize: 2,
        page,
        projectRoot: root,
      } as never)) as {
        data?: {
          sessions: Array<{ id: string }>;
          nextPage: number | null;
          nextPageCall: string | null;
        };
      };
      seen.push(...result.data!.sessions.map((session) => session.id));
      if (result.data!.nextPage !== null)
        expect(result.data!.nextPageCall).toBe(
          `rbook_session(action="list", status="completed", type="review", pageSize=2, projectRoot=${JSON.stringify(root)}, page=${result.data!.nextPage})`
        );
      page = result.data!.nextPage;
    }
    expect(seen).toEqual(['PS-R0', 'PS-R1', 'PS-R2', 'PS-R3', 'PS-R4']);
  });

  it('repeats the digest page size and context type in its next-page call', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('master_context', 'm.json', ?, ?)`
    ).run(JSON.stringify({ constraints: ['a', 'b', 'c'] }), new Date().toISOString());
    db.close();
    RbookDetector.resetInstance();
    const result = await rbookContextView({
      contextType: 'master_context',
      pageSize: 2,
      projectRoot: root,
    });
    expect(result.data?.compact?.nextPageCall).toBe(
      `rbook_context(action="view", contextType="master_context", pageSize=2, projectRoot=${JSON.stringify(root)}, page=2)`
    );
  });

  it('refuses a feedback page whose count cannot be read, instead of ending the pages early', async () => {
    await rbookFeedback({ action: 'list', projectRoot: root });
    const getOne = RbookDatabaseClient.prototype.getOne;
    const spy = jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
      this: RbookDatabaseClient,
      sql: string,
      params?: unknown[]
    ) {
      if (sql.includes('COUNT(*) as count FROM agent_feedback'))
        return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'count failed' } };
      return getOne.call(this, sql, params) as never;
    } as never);
    try {
      const result = await rbookFeedback({ action: 'list', projectRoot: root });
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'DB_QUERY_FAILED',
        message: 'Failed to count agent feedback',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

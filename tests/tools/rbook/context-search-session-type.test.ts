// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m05 (#887): context search accepts searchTypes "session" but never searched it, so it now says so.
// ABOUTME: Through the router: the warning names rbook_session(action="search", ...); other types answer as before.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { callText } from '../../../src/tools/rbook/answer-page';
import { dispatch, type CallResult } from '../../helpers/session-read-fixture';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s107m05-types-')));
  const db = new Database(seedRbookDb(root, { projectName: 'types' }));
  try {
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, status, created_at) VALUES (?, 'active', ?)`
    ).run('Keep the zebra crossing painted every spring.', new Date().toISOString());
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

type Answer = {
  success: boolean;
  data?: { results: Array<{ type: string; id: number | string }>; count: number };
  warnings?: string[];
};

const search = async (searchTypes: string[]): Promise<CallResult> =>
  dispatch('rbook_context', { action: 'search', query: 'zebra', searchTypes, projectRoot: root });
const answer = (result: CallResult): Answer => result.structuredContent as Answer;
const text = (result: CallResult): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;
const sessionSearch = () =>
  callText('rbook_session', { action: 'search', query: 'zebra', projectRoot: root });

describe('rbook_context search with searchTypes "session" (s107-m05, #887)', () => {
  it('with session alone: success, a warning naming session search, and suggestions that name it', async () => {
    const result = await search(['session']);
    expect(answer(result).success).toBe(true);
    expect(answer(result).data?.count).toBe(0);
    expect(answer(result).warnings).toEqual([expect.stringContaining(sessionSearch())]);
    expect(text(result)).toContain(
      `- Search sessions with ${callText('rbook_session', { action: 'search', query: 'zebra' })}`
    );
    expect(text(result)).not.toContain('Check that relevant decisions have been captured');
  });

  it("with decision and session: decision's results, plus the same warning", async () => {
    const both = await search(['decision', 'session']);
    const decisions = await search(['decision']);
    // The same rows in the same order; their age and score move with the clock between calls.
    const rows = (result: CallResult) =>
      answer(result).data?.results.map(({ type, id }) => ({ type, id }));
    expect(rows(both)).toEqual(rows(decisions));
    expect(answer(both).data?.count).toBeGreaterThan(0);
    expect(answer(both).warnings).toEqual([expect.stringContaining(sessionSearch())]);
  });

  it('with decision alone: no warning', async () => {
    const result = await search(['decision']);
    expect(answer(result).warnings ?? []).toEqual([]);
    expect(text(result)).not.toContain('rbook_session(action="search"');
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m03 — the page module's call text: a crafted value cannot open a fence or a line in an
// ABOUTME: answer, and the quoted value still decodes to what the caller sent.

import {
  callText,
  nextPageCall,
  pageFacts,
  pageRequest,
  shownLine,
} from '../../../src/tools/rbook/answer-page';

describe('answer-page call text (s106-m03, round-3 critic)', () => {
  it('escapes backticks, newlines and line separators, and decodes to the same value', () => {
    // A project root holding a fence and a line break used to reach every Next page line raw.
    const root = '/tmp/path\n```\nBREAK OUT X';
    const text = callText('rbook_session', { action: 'list', projectRoot: root, page: 2 });
    expect(text).not.toContain('`');
    expect(text).not.toContain('\n');
    expect(text).not.toContain(' ');
    const literal = /projectRoot=("(?:[^"\\]|\\.)*")/.exec(text)![1];
    expect(JSON.parse(literal)).toBe(root);
    expect(text).toBe(
      'rbook_session(action="list", projectRoot="/tmp/path\\n\\u0060\\u0060\\u0060\\nBREAK OUT\\u2028X", page=2)'
    );
  });

  it('pages by number, states the total and has no next call on the last page', () => {
    const request = pageRequest(3, 10, 20);
    expect(request).toEqual({ page: 3, pageSize: 10, offset: 20 });
    expect(pageFacts(request, 10, 30)).toMatchObject({ hasMore: false, nextPage: null });
    expect(pageFacts(request, 10, 31)).toMatchObject({ hasMore: true, nextPage: 4 });
    expect(shownLine(pageFacts(request, 10, 31), 10, 'rows')).toBe('Showing 21–30 of 31 rows');
    expect(shownLine(pageFacts(pageRequest(9, 10, 20), 0, 31), 0, 'rows')).toBe(
      'No rows on page 9; 31 in all'
    );
    expect(nextPageCall(null, 'rbook_feedback', { action: 'list' })).toBeNull();
  });
});

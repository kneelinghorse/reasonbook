// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m03 — a shipped skill that reads a list whose answer pages tells the agent to follow
// ABOUTME: its pages, so a capped answer never stands in for the whole list.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RBOOK_ACTION_PARAMS } from '../../src/tools/rbook/action-params';
import { RBOOK_FEEDBACK_ACTIONS } from '../../src/tools/rbook/rbook-feedback';
import { NEXT_STEP_ACTIONS } from '../../src/tools/rbook/rbook-next-steps';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The design's universe (s106-m03, settled item 5): the files `git grep -lE
 * 'action="list"|nextStepAction="list"' -- plugins` returns, nine at m03's start, derived here at
 * run time so a skill added later is held to the same rule. A call pages when its action publishes
 * `page` (the applicability contract), and every paged answer ends with a `Next page:` call.
 */
function skillFiles(): string[] {
  return execFileSync('git', ['ls-files', 'plugins'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((rel) =>
      /action="list"|nextStepAction="list"/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    );
}

/**
 * Each `rbook_<tool>(… action="<action>" …)` call in a file, with the sub-action it names
 * (`nextStepAction`, `constraintAction`), which defaults to list.
 */
function calls(text: string): Array<{ tool: string; action: string; sub: string }> {
  const found: Array<{ tool: string; action: string; sub: string }> = [];
  for (const match of text.matchAll(/\b(rbook_\w+)\(([^)]*)\)/g)) {
    const action = /(?:^|[\s,])action="(\w+)"/.exec(match[2])?.[1];
    const sub = /(?:nextStepAction|constraintAction)="(\w+)"/.exec(match[2])?.[1] ?? 'list';
    if (action) found.push({ tool: match[1], action, sub });
  }
  return found;
}

/** A call pages when its action publishes `page` and it reads a list, not a write sub-action. */
const pages = (tool: string, action: string, sub = 'list'): boolean =>
  (RBOOK_ACTION_PARAMS[tool]?.[action]?.includes('page') ?? false) &&
  ['list', 'review'].includes(sub);

/** The two instructions a paged list needs, matched separately so neither can stand in for both. */
const FOLLOWS = /until\s+an\s+answer\s+names\s+none/;
const REREADS = /read\s+it\s+again\s+before\s+its\s+`?Next\s+page`?\s+call/;

/**
 * Whether a skill also acts on a paged list it reads: it names one of that list's write actions,
 * taken from the published action enums, so acting moves its later rows up a page.
 */
const WRITES: Readonly<Record<string, RegExp>> = {
  'rbook_feedback list': new RegExp(
    RBOOK_FEEDBACK_ACTIONS.filter((a) => a !== 'list')
      .map((a) => `\`${a}\`|action="${a}"`)
      .join('|')
  ),
  'rbook_context next_steps': new RegExp(
    NEXT_STEP_ACTIONS.filter((a) => a !== 'list' && a !== 'show')
      .map((a) => `nextStepAction="${a}"`)
      .join('|')
  ),
};

describe('shipped skills follow the pages of a paged list (s106-m03)', () => {
  const files = skillFiles();

  it('finds the design’s universe of list-reading skills', () => {
    // Nine at m03's start, in both plugins; a later skill joins without editing this test.
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.some((rel) => rel.startsWith('plugins/reasonbook-chat/'))).toBe(true);
    expect(files.some((rel) => rel.startsWith('plugins/reasonbook/'))).toBe(true);
  });

  it('every skill that calls a paged action tells the agent to follow Next page', () => {
    const paged: string[] = [];
    const acting: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const call of calls(text).filter((c) => pages(c.tool, c.action, c.sub))) {
        paged.push(`${rel} ${call.tool} ${call.action}`);
        // The chat plugin forbids backticked commands, so the words are matched bare.
        const acts = WRITES[`${call.tool} ${call.action}`]?.test(text) ?? false;
        expect({
          rel,
          call,
          follows: FOLLOWS.test(text),
          rereads: !acts || REREADS.test(text),
        }).toEqual({ rel, call, follows: true, rereads: true });
        if (acts) acting.push(rel);
      }
    }
    // Non-vacuity: the feedback skill reads rbook_feedback list, and three skills the next-steps
    // list, all of which page.
    expect(paged).toEqual(
      expect.arrayContaining([
        'plugins/reasonbook/skills/feedback/SKILL.md rbook_feedback list',
        'plugins/reasonbook/skills/close-out/SKILL.md rbook_context next_steps',
        'plugins/reasonbook/skills/plan/SKILL.md rbook_context next_steps',
        'plugins/reasonbook-chat/skills/next-up/SKILL.md rbook_context next_steps',
      ])
    );
    // And the two that act on what they read are held to the re-read instruction too.
    expect([...new Set(acting)].sort()).toEqual([
      'plugins/reasonbook/skills/close-out/SKILL.md',
      'plugins/reasonbook/skills/feedback/SKILL.md',
    ]);
  });

  it('reads the project list whole, and a write sub-action needs no pages', () => {
    // rbook_project list returns every registered project; its answer is not capped.
    expect(pages('rbook_project', 'list')).toBe(false);
    expect(pages('rbook_context', 'next_steps', 'list')).toBe(true);
    expect(pages('rbook_context', 'next_steps', 'carry')).toBe(false);
    expect(pages('rbook_feedback', 'list')).toBe(true);
  });
});

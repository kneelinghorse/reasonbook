// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A restated numeric setting can approve just the timely standing proposal the user saw.
// ABOUTME: Legacy transcripts and retained words cannot turn an arbitrary draft into that proposal.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import { restatesStandingSetting } from '../../../src/tools/rbook/draft-question';
import { namesApprovedDraft } from '../../../src/tools/rbook/draft-evaluation';
import {
  bindWindow,
  EXCERPT_TTL_MS,
  openDraftRuntime,
  readExcerpt,
} from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import type { DraftRow } from '../../../src/tools/rbook/proposals';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const setting = '12. Review budget: 5 review rounds.';
const line = 'Would record (rule): ' + setting;
const words = 'yes, sounds good approved. 5 review rounds.';
const session = 'review-preferences';
let dir: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let now: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-standing-'));
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(dir, 'config') };
  dbPath = seedRbookDb(path.join(dir, 'project'));
  now = Date.now();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stop(reply: string | undefined, at = now, transcriptPath?: string) {
  onStop({
    dbPath,
    rawSessionId: session,
    reply,
    transcriptPath,
    env,
    now: at,
    deadlineAtMs: Date.now() + 20000,
  });
}
function prompt(message: string) {
  return prepareOffer({
    dbPath,
    rawSessionId: session,
    message,
    env,
    now,
    deadlineAtMs: Date.now() + 20000,
  });
}
function excerpt(id = 1) {
  const rt = openDraftRuntime(dbPath, env, { readonly: true })!;
  try {
    return readExcerpt(rt, harnessSessionHash(session), id, now);
  } finally {
    rt.close();
  }
}

it.each([
  ['a legacy proposal', false, words],
  ['several affirmative phrases', false, 'Okay. Yes—approved. 5\u00a0review rounds!'],
  ['a uniquely re-asked current question', true, 'OK.  5   REVIEW rounds!'],
  ['the complete raw length limit', false, 'yes.'.padEnd(44) + '5 review rounds.'],
])('retains the complete affirmative setting from %s', (_label, ordinary, answer) => {
  stop(line);
  if (ordinary) stop(setting + '\n\nShould I make this a standing rule?');
  expect(prompt(answer as string).reply).toBe('approval');
  expect(excerpt()).toMatchObject({
    reply: 'approval',
    message: answer,
    late: false,
    windowSize: 1,
  });
});

it.each([
  'yes',
  'record it',
  'as drafted',
  'yes. 5 rounds.',
  'yes. 4 review rounds.',
  'yes. 05 review rounds.',
  'yes. 5 review rounds?',
  'yes. 5 review rounds. Also record the budget.',
  'yes, if ready. 5 review rounds.',
  'yes. 5 review rounds if ready.',
  '"yes". 5 review rounds.',
  '“yes”. 5 review rounds.',
  "'yes'. 5 review rounds.",
  'yes. "5 review rounds."',
  '> yes. 5 review rounds.',
  '`yes`. 5 review rounds.',
  '*yes*. 5 review rounds.',
  '    yes. 5 review rounds.',
  'yes.\n5 review rounds.',
  'yes.\v5 review rounds.',
  'yes. 5 review rounds.\f',
  'yes.\u20285 review rounds.',
  'yes? 5 review rounds.',
  'why did you ask again?',
  'yes.' + ' '.repeat(1100) + '5 review rounds.',
  'yes.'.padEnd(45) + '5 review rounds.',
])('leaves the proposed setting pending after %j', (answer) => {
  stop(line);
  expect(prompt(answer).reply).not.toBe('approval');
  expect(excerpt()?.reply).not.toBe('approval');
});

it.each([
  ['a decision', 'Would record: ' + setting],
  ['a conditional subject', 'Would record (rule): If the budget allows: 5 review rounds.'],
  ['two settings', line + '\nWould record (profile): 8. Meeting budget: 5 review rounds.'],
  ['an additional decision', line + '\nWould record: Keep the log in a shared folder.'],
  ['two colons', 'Would record (rule): 12. Budget: Reviews: 5 review rounds.'],
])('refuses a shorthand binding to %s', (_label, reply) => {
  stop(reply);
  expect(prompt(words).reply).not.toBe('approval');
  expect(excerpt()?.reply).not.toBe('approval');
});

it.each(['carried', 'late', 'unshown', 'old Stop array', 'transcript only', 'identifier only'])(
  'a %s standing setting needs another showing',
  (reason) => {
    stop(line, reason === 'late' ? now - EXCERPT_TTL_MS : now);
    if (reason === 'carried') stop('The unrelated build has finished.');
    if (reason === 'unshown') prompt('I am checking the figures.');
    if (reason === 'identifier only') stop('The review budget in draft P1 covers 5 review rounds.');
    if (reason === 'old Stop array') {
      const rt = openDraftRuntime(dbPath, env)!;
      try {
        rt.db.prepare("UPDATE shown SET draft_ids = '[1]'").run();
      } finally {
        rt.close();
      }
    }
    if (reason === 'transcript only') {
      const transcript = path.join(dir, 'earlier.jsonl');
      fs.writeFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: line }] },
        }) + '\n'
      );
      stop(undefined, now, transcript);
    }
    expect(prompt(words).reply).not.toBe('approval');
    expect(excerpt()?.reply).not.toBe('approval');
  }
);

it('an older stored approval supplies no evidence that the standing draft was the sole timely showing', () => {
  stop(line);
  const rt = openDraftRuntime(dbPath, env)!;
  try {
    bindWindow(rt, harnessSessionHash(session), [1], words, 'approval', now);
  } finally {
    rt.close();
  }
  expect(namesApprovedDraft(excerpt(), { kind: 'rule', text: setting } as DraftRow)).toBe(false);
});

it('asking for the same setting again retires its earlier shorthand approval', () => {
  stop(line);
  expect(prompt(words).reply).toBe('approval');
  stop(line);
  expect(excerpt()).toBeNull();
});

it('requires clarification when the same reply names a decision and restates a different standing setting', () => {
  stop('Would record: sounds good approved. 5 review rounds.');
  prompt('I am considering the alternatives.');
  stop(line);
  expect(prompt(words).reply).not.toBe('approval');
  expect(excerpt(1)?.reply).not.toBe('approval');
  expect(excerpt(2)?.reply).not.toBe('approval');
});

it.each([
  '1 review pass',
  '2 critic rounds',
  '3 attempts',
  '1 retry',
  '4 retries',
  '2 hours',
  '1 minute',
])('accepts the complete recognized unit in %s', (value) => {
  stop('Would record (constraint): Test budget: ' + value + '.');
  expect(prompt('Okay. ' + value + '.').reply).toBe('approval');
});
it.each([
  '5 widgets',
  '5 rounds pending',
  '5 tentative rounds',
  '2 minutes plus slack',
  '1 review pass maximum',
])('requires a verbatim choice for the unrecognized setting %s', (value) => {
  stop('Would record (constraint): Test budget: ' + value + '.');
  expect(prompt('Okay. ' + value + '.').reply).not.toBe('approval');
  expect(excerpt()?.reply).not.toBe('approval');
});

it.each([
  'Plan critics',
  'Review budget',
  'Critic rounds',
  'Review rounds',
  'Review passes',
  'Test budget',
  'Meeting budget',
  'Stop checks',
  'Retry limit',
  'Retry delay',
  'Timeout',
  'Retention period',
])('accepts a whole documented label with and without a list number: %s', (label) => {
  for (const prefix of ['', '4. ', '4) '])
    expect(
      restatesStandingSetting('yes. 5 rounds.', {
        kind: 'rule',
        text: prefix + label + ': 5 rounds.',
      })
    ).toBe(true);
});

it.each([
  'Review budget (pending approval)',
  'Review budget subject to signoff',
  'Provisional review budget',
  'Review budget for now',
  'Temporary timeout',
  'Retry delay or retention period',
  'Review budget…',
  '4. Review budget again',
  '4. 8. Review budget',
  'Review budgets',
  'Unpublished label',
])('rechecks an old shorthand receipt against the entire label %s', (label) => {
  const old = {
    message: 'yes. 5 rounds.',
    reply: 'approval',
    windowSize: 1,
    at: now,
    late: false,
    standingSetting: true,
  } as const;
  expect(
    namesApprovedDraft(old, { kind: 'profile', text: label + ': 5 rounds.' } as DraftRow)
  ).toBe(false);
});

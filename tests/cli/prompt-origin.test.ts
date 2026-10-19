// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m12 — the prompt-origin predicate (decision #1511): a harness's own prompt is known by its opening, or by
// ABOUTME: the call that scheduled it when it has none, as a scheduled wakeup has none; the operator's stays theirs.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { harnessPrompt } from '../../src/cli/prompt-origin';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-prompt-origin-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A transcript holding these entries, one JSON line each, as Claude Code writes them. */
function transcript(...entries: object[]): string {
  const file = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

const user = (text: string, extra: object = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  ...extra,
});

it('knows a harness prompt by its opening, with or without a transcript', () => {
  expect(harnessPrompt('<task-notification>\n<task-id>b1</task-id>\n</task-notification>')).toBe(
    '<task-notification>'
  );
  expect(
    harnessPrompt(
      'Another Claude session sent a message: <cross-session-message>hi</cross-session-message>'
    )
  ).toBe('Another Claude session sent a message:');
  expect(harnessPrompt('  <environment_context>\n</environment_context>')).toBe(
    '<environment_context>'
  );
});

it('knows a scheduled wakeup, which has no opening, by the call that scheduled it', () => {
  const wakeup = 'Check the full-suite log and the critics; continue the build.';
  // Without the transcript it reads as the operator's: a named false negative.
  expect(harnessPrompt(wakeup)).toBeNull();
  const scheduled = transcript(user('approved', { origin: { kind: 'human' } }), {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'ScheduleWakeup',
          input: { delaySeconds: 1200, prompt: wakeup, reason: 'watching CI' },
        },
      ],
    },
  });
  expect(harnessPrompt(wakeup, scheduled)).toBe('scheduled');
  // The operator's own words are no scheduled prompt, however the transcript reads.
  expect(harnessPrompt('approved', scheduled)).toBeNull();
});

it("knows an SDK host's polled event by its shape", () => {
  expect(harnessPrompt('<event kind="notice" at="2026-10-19T06:00:00Z">approved</event>')).toBe(
    '<event kind="'
  );
  expect(harnessPrompt('notice\n2026-10-19T06:00:00Z\napproved')).toBe('event');
});

it("keeps the operator's message theirs, whatever entries the transcript holds", () => {
  // The hook runs before the prompt is written, so older entries say nothing about this one.
  const file = transcript(
    user('approved', { origin: { kind: 'task-notification' } }),
    user('go ahead', { isMeta: true, promptSource: 'system' })
  );
  expect(harnessPrompt('approved', file)).toBeNull();
  expect(harnessPrompt('go ahead', file)).toBeNull();
  // A transcript that cannot be read leaves the text alone to decide.
  expect(harnessPrompt('approved', path.join(tmp, 'missing.jsonl'))).toBeNull();
  // Codex's question-UI answer is the operator's own.
  expect(
    harnessPrompt('<send_user_message_question_reply>[]</send_user_message_question_reply>')
  ).toBeNull();
});

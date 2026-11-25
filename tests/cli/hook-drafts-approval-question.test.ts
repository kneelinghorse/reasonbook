// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives discussions, questions and named decision approvals through the real hook path.
// ABOUTME: Drafts remain pending until the conversation supplies evidence for a single choice.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import { type CliIo } from '../../src/cli/core';
import { onSessionStart, onStop, prepareOffer } from '../../src/cli/drafts-hook';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { openDraftRuntime, readExcerpt } from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { rbookDecisions } from '../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let projectRoot: string;
let dbPath: string;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(async () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m03-hooks-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'approvals' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
  context = await buildMissionProtocolContext();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedStartId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedStartId;
  if (savedConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Room a loaded machine cannot spend (s100-m02; see tests/cli/hook-drafts.test.ts). */
const HOOK_ROOM_MS = 20_000;

async function hook(event: string, stdin: Record<string, unknown>): Promise<string> {
  let stdout = '';
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    startedAtMs: Date.now() + HOOK_ROOM_MS,
    readStdin: async () => JSON.stringify({ session_id: 's-one', cwd: projectRoot, ...stdin }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  };
  await runCli(['hook', event], io);
  setExternalSessionOwner(null);
  return stdout ? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string) : '';
}

const start = () => hook('session-start', { source: 'startup' });
const stop = (reply: string) => hook('stop', { last_assistant_message: reply });
const say = (prompt: string) => hook('prompt', { prompt, prompt_id: `${Math.random()}` });

const SPRINT =
  'The next sprint hardens migrate, settles answered drafts and releases the next minor version, because loose ends cost the operator time.';
const SETTLE =
  'An agent may settle a pending draft by naming the recorded decision that answered it, so no session asks an answered question again.';
const DRAFT = 'Store project decisions as one JSON file per decision, because diffs stay readable.';
const proposing = (...lines: string[]) =>
  `Here is the plan.\n\n${lines.map((line) => `Would record: ${line}`).join('\n')}`;

/** #52's shape, in other words: an approval of both drafts, and a question about renaming the project. */
const RENAME_ASIDE =
  "yes, this looks good. And I'm good with the agent settling a pending draft by naming the recorded decision it answered already.\n\n" +
  "I'm also wondering if its time to update our folder name and our project name and slug? The dashboard needs to do this as well.";

function row<T>(sql: string, ...params: unknown[]): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

const recorded = (draft: string) =>
  row<{ approval_mode: string; approval_words: string }>(
    'SELECT approval_mode, approval_words FROM strategic_decisions WHERE approval_draft = ?',
    draft
  );

function excerpt(draftId: number, session = 's-one') {
  const runtime = openDraftRuntime(dbPath, process.env, { readonly: true });
  try {
    return readExcerpt(runtime!, harnessSessionHash(session), draftId, Date.now());
  } finally {
    runtime?.close();
  }
}

async function dispatch(fromDraft: string) {
  setExternalSessionOwner('s-one');
  try {
    return await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'record', fromDraft, projectRoot },
      context
    );
  } finally {
    setExternalSessionOwner(null);
  }
}

describe('an approval that asks only about something else (#52)', () => {
  it('keeps a multi-draft discussion open until the operator names a choice', async () => {
    await start();
    await stop(proposing(SPRINT, SETTLE));
    const offer = await say(RENAME_ASIDE);
    expect(offer).toContain('Leave P1, P2 pending');
    expect(offer).not.toContain('rbook_decisions(action="record"');
    expect(excerpt(1)).toMatchObject({ reply: 'other', message: RENAME_ASIDE });
    for (const draft of ['P1', 'P2']) {
      expect((await dispatch(draft)).isError).toBe(true);
      expect(recorded(draft)).toBeUndefined();
    }
    await say(`I approve this decision: ${SETTLE}`);
    expect((await dispatch('P2')).isError).not.toBe(true);
    expect(recorded('P2')).toEqual({
      approval_mode: 'approved',
      approval_words: `I approve this decision: ${SETTLE}`,
    });
    expect(recorded('P1')).toBeUndefined();
  });

  it('a constraint still needs a plain approval, and the refusal says the message was not one', async () => {
    await start();
    await stop(
      'Proposed.\n\nWould record (constraint): Keep every hook inside its time budget, because the harness waits on it.'
    );
    const offer = await say(
      'yes, looks good.\n\nAlso, can we rename the project folder sometime soon?'
    );
    expect(offer).toContain('name the choice');
    // With no decision bound, the instruction offers no record (verifier B, round 2).
    expect(offer).not.toContain('Only if this message approves');
    setExternalSessionOwner('s-one');
    const result = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(recorded('P1')).toBeUndefined();
  });
});

describe('a question about the drafts gets the conditional instruction (settled item 7)', () => {
  it('answers the question without treating the accompanying yes as consent', async () => {
    await start();
    await stop(proposing(DRAFT));
    const offer = await say('yes, but why one file per decision?');
    expect(excerpt(1)).toMatchObject({ reply: 'question' });
    expect(offer).toContain('Answer the question.');
    expect(offer).toContain('Leave P1 pending');
    expect(offer).not.toContain('rbook_decisions(action="record"');
    expect((await dispatch('P1')).isError).toBe(true);
  });

  it('an approval that amends the draft gets a revised line, not a record of the words it amends', async () => {
    // Round 3 (I1): "clearly approves" let "yes, but weekly" record the draft's "monthly".
    await start();
    await stop(
      proposing('Deploy the dashboard monthly because the release notes line up with it.')
    );
    const offer = await say('yes, but weekly. When is the CI bill due?');
    expect(excerpt(1)).toMatchObject({ reply: 'question' });
    expect(offer).toContain('propose the revised wording');
    expect(offer).not.toContain('rbook_decisions(action="record"');
  });

  it('names a constraint’s plain-approval rule there too', async () => {
    await start();
    await stop(
      'Proposed.\n\nWould record (constraint): Keep every hook inside its time budget, because the harness waits on it.'
    );
    const offer = await say('yes, but why that budget?');
    expect(offer).toContain('Answer the question.');
    // With no decision bound, nothing could be recorded agent-judged, so the instruction offers none.
    expect(offer).not.toContain('Only if it approves');
    expect(offer).toContain('Leave P1 pending');
    expect(offer).toContain('name the choice');
  });

  it('a question is judged against the drafts the message answers', async () => {
    await start();
    await stop(proposing(DRAFT));
    await say('yes.\n\nAlso, could P1 wait until the dashboard deploy finishes?');
    expect(excerpt(1)).toMatchObject({ reply: 'question' });
  });
});

describe('the offer stays whole where it matters (critic B, round 1; verifier B, round 2)', () => {
  it('past 1,000 characters the bound offers go compact, and each keeps its own note', async () => {
    const long = (topic: string) =>
      `Keep ${topic} ${'with every reason spelled out at length for the reviewers '.repeat(5)}`.trim();
    await start();
    await stop(
      `Three calls.\n\nWould record: ${long('the export command')}\nWould record: ${long('the import command')}\nWould record (constraint): ${long('every hook inside its budget')}`
    );
    const offer = await say('let me think about these');
    expect(offer.length).toBeLessThanOrEqual(1_000);
    expect(offer.startsWith('Leave P1, P2, P3 pending')).toBe(true);
    for (const label of ['P1 (decision)', 'P2 (decision)', 'P3 (constraint)'])
      expect(offer.toLowerCase()).toContain(`draft ${label.toLowerCase()}:`);
    expect(offer).toContain('It is recorded as a constraint, and only on the operator’s approval.');
    // Nothing was cut at the limit: the last offer ends with its own note.
    expect(offer.endsWith('…')).toBe(false);
  });
});

describe('a compact offer keeps the draft’s evidence and outside-content notes (round 3, T3)', () => {
  it('two long drafts naming a page, after outside content', async () => {
    const long = (topic: string, page: string) =>
      `Keep ${topic} as https://x.test/${page} describes ${'with every reason spelled out at length for the reviewers '.repeat(5)}`.trim();
    await start();
    await stop(
      `Two calls.\n\nWould record: ${long('the export command', 'export')}\nWould record: ${long('the import command', 'import')}`
    );
    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE proposals SET outside_content = 1').run();
    } finally {
      db.close();
    }
    const offer = await say('let me think about these');
    expect(offer).toMatch(/draft P1 \(decision\):/i);
    expect(offer).toContain('It names https://x.test/export.');
    expect(offer).toContain('It names https://x.test/import.');
    expect(offer.match(/This session read outside content/g)).toHaveLength(2);
  });
});

describe('the failure cases (the design, m03)', () => {
  it('a "?" only in a URL binds as other', async () => {
    await start();
    await stop(proposing(DRAFT));
    await say('yes — the notes are at https://example.com/notes?v=2');
    expect(excerpt(1)).toMatchObject({ reply: 'other' });
  });

  it('a late discussion remains outside the recording window', async () => {
    const SESSION = 'late-conversation';
    const now = Date.now();
    const shownAt = now - 3 * 60 * 60 * 1000;
    expect(onSessionStart(dbPath, SESSION, 'startup', process.env, shownAt - 1000)).toBe(true);
    onStop({
      dbPath,
      rawSessionId: SESSION,
      reply: proposing(SPRINT, SETTLE),
      env: process.env,
      deadlineAtMs: Date.now() + 60_000,
      now: shownAt,
    });
    const offer = prepareOffer({
      dbPath,
      rawSessionId: SESSION,
      message: RENAME_ASIDE,
      env: process.env,
      deadlineAtMs: Date.now() + 60_000,
      now,
    });
    offer.commit();
    expect(offer.reply).toBe('other');
    expect(excerpt(1, SESSION)).toMatchObject({ reply: 'other', late: true });
    setExternalSessionOwner(SESSION);
    const result = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(recorded('P1')).toBeUndefined();
  });

  it('a draft carried past a harness turn still binds only as other', async () => {
    await start();
    await stop(proposing(DRAFT));
    await say(
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>'
    );
    await stop('The background test run passed. Shall I delete the scratch branch now?');
    const offer = await say('yes.\n\nAlso, can we rename the project folder sometime soon?');
    expect(offer).toMatch(/P1 \(decision\) was shown before your last reply/);
    expect(excerpt(1)).toMatchObject({ reply: 'other' });
  });

  it('leaves the draft pending when the recording client cannot link the operator’s words', async () => {
    await start();
    await stop(proposing(DRAFT));
    // No harness session is linked to this server, so no hook's words bind.
    const answer = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'record', fromDraft: 'P1', projectRoot },
      context
    );
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).toContain('APPROVAL_REQUIRED');
    expect(recorded('P1')).toBeUndefined();
  });
});

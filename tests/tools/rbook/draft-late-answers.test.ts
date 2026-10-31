// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Late answers bind only the same live conversation's shown drafts, without claiming plain approval.
// ABOUTME: Real stores and runtime files prove declines outlive transient words and cannot be recorded later.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { onSessionEnd, onSessionStart, onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { openDraftRuntime, openWindow, readExcerpt } from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { profilePath } from '../../../src/tools/rbook/operator-profile';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const HOUR = 60 * 60 * 1000;
const SESSION = 'late-answer-conversation';
const CONTENT = 'Keep the scratch store in SQLite WAL mode so concurrent readers can continue.';
let tmp: string;
let projectRoot: string;
let dbPath: string;
let now: number;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.RBOOK_AGENT_ROLE;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-late-answers-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  dbPath = seedRbookDb(projectRoot, { projectName: 'late-answers' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
  setExternalSessionOwner(null);
  now = Date.now();
});

afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  process.env = savedEnv;
  RbookDetector.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function propose(kind = 'decision', content = CONTENT): void {
  const shownAt = now - 3 * HOUR;
  expect(onSessionStart(dbPath, SESSION, 'startup', process.env, shownAt - 1000)).toBe(true);
  const result = onStop({
    dbPath,
    rawSessionId: SESSION,
    reply: `Proposed.\n\nWould record${kind === 'decision' ? '' : ` (${kind})`}: ${content}`,
    env: process.env,
    deadlineAtMs: Date.now() + 60_000,
    now: shownAt,
  });
  expect(result.created).toBe(1);
}

function answer(message: string, session = SESSION, at = now) {
  const result = prepareOffer({
    dbPath,
    rawSessionId: session,
    message,
    env: process.env,
    deadlineAtMs: Date.now() + 60_000,
    now: at,
  });
  result.commit();
  return result;
}

function query<T>(sql: string, ...params: unknown[]): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

const proposal = () =>
  query<{ outcome: string; record_id: string | null; approval_mode: string | null }>(
    'SELECT outcome, record_id, approval_mode FROM proposals WHERE id = 1'
  );

function runtimeState(at = now, session = SESSION) {
  const runtime = openDraftRuntime(dbPath, process.env, { readonly: true });
  expect(runtime).not.toBeNull();
  try {
    return {
      excerpt: readExcerpt(runtime!, harnessSessionHash(session), 1, at),
      window: openWindow(runtime!, harnessSessionHash(session), at),
    };
  } finally {
    runtime?.close();
  }
}

async function record(fromDraft = true, session: string | null = SESSION, content = CONTENT) {
  setExternalSessionOwner(session);
  try {
    return await rbookDecisions({
      action: 'record',
      content,
      projectRoot,
      ...(fromDraft ? { fromDraft: 'P1' } : { mode: 'autonomous' as const }),
    });
  } finally {
    setExternalSessionOwner(null);
  }
}

function destinations() {
  return {
    decisions: query('SELECT COUNT(*) AS n FROM strategic_decisions'),
    constraints: query('SELECT COUNT(*) AS n FROM constraints'),
    learnings: query('SELECT COUNT(*) AS n FROM learnings'),
    profile: fs.existsSync(profilePath(process.env))
      ? fs.readFileSync(profilePath(process.env), 'utf8')
      : null,
  };
}

describe('a three-hour answer to the same live conversation', () => {
  it('records a late yes as agent-judged, retaining the actual words but opening no direct-record window', async () => {
    propose();
    expect(answer('yes').reply).toBe('other');
    expect(runtimeState()).toMatchObject({
      excerpt: { message: 'yes', reply: 'other' },
      window: [],
    });
    const result = await record();
    expect(result.success).toBe(true);
    expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'agent-judged' });
    expect(
      query(
        'SELECT approval_mode, approval_words FROM strategic_decisions WHERE decision_text = ?',
        CONTENT
      )
    ).toEqual({ approval_mode: 'agent-judged', approval_words: 'yes' });
  });

  it('keeps the late approval downgrade through the actual MCP dispatch boundary', async () => {
    propose();
    answer('yes');
    const context = await buildMissionProtocolContext();
    setExternalSessionOwner(SESSION);
    const response = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'record', content: CONTENT, fromDraft: 'P1', projectRoot },
      context
    );
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'agent-judged' });
    expect(
      query(
        'SELECT approval_mode, approval_draft, approval_words FROM strategic_decisions WHERE decision_text = ?',
        CONTENT
      )
    ).toEqual({ approval_mode: 'agent-judged', approval_draft: 'P1', approval_words: 'yes' });
  });

  // s106-m02 (#870): fromDraft alone takes the draft's own words, so a late yes is judged exactly as
  // a verbatim restatement is, through the real dispatch; a later kind still needs a plain yes on time.
  it.each([
    ['restated', { content: CONTENT }],
    ['fromDraft alone', {}],
  ])('records a late yes %s as agent-judged through the dispatch', async (_form, extra) => {
    propose();
    answer('yes');
    const context = await buildMissionProtocolContext();
    setExternalSessionOwner(SESSION);
    const response = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'record', fromDraft: 'P1', projectRoot, ...extra },
      context
    );
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(
      query(
        'SELECT approval_mode, approval_draft, approval_words FROM strategic_decisions WHERE decision_text = ?',
        CONTENT
      )
    ).toEqual({ approval_mode: 'agent-judged', approval_draft: 'P1', approval_words: 'yes' });
  });

  it.each([
    ['restated', CONTENT],
    ['fromDraft alone', undefined],
  ])('refuses a constraint after a late yes, %s', async (_form, content) => {
    propose('constraint');
    answer('yes');
    const before = destinations();
    setExternalSessionOwner(SESSION);
    try {
      const result = await rbookDecisions({
        action: 'record',
        fromDraft: 'P1',
        projectRoot,
        ...(content ? { content } : {}),
      });
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    } finally {
      setExternalSessionOwner(null);
    }
    expect(destinations()).toEqual(before);
  });

  it('does not let a direct record silently settle the late-answer draft', async () => {
    propose();
    answer('yes');
    expect(runtimeState().excerpt).toMatchObject({ reply: 'other' });
    expect((await record(false)).success).toBe(true);
    expect(proposal()).toEqual({ outcome: 'pending', record_id: null, approval_mode: null });
  });

  it.each([
    ['session-linked', SESSION, false, false],
    ['sessionless', null, false, false],
    ['session-linked after the excerpt expires', SESSION, true, false],
    ['sessionless after the excerpt expires', null, true, false],
    ['session-linked after SessionEnd', SESSION, false, true],
    ['sessionless after SessionEnd', null, false, true],
  ] as const)(
    'a late no blocks fromDraft %s through durable outcome',
    async (_label, session, elapsed, ended) => {
      propose();
      expect(answer('no').reply).toBe('decline');
      expect(proposal()).toEqual({ outcome: 'declined', record_id: null, approval_mode: null });
      expect(runtimeState()).toMatchObject({ excerpt: { reply: 'decline' }, window: [] });
      if (elapsed) {
        jest.spyOn(Date, 'now').mockReturnValue(now + 2 * HOUR + 1);
        expect(runtimeState(Date.now()).excerpt).toBeNull();
      }
      if (ended) {
        expect(onSessionEnd(dbPath, SESSION, process.env)).toBe(true);
        expect(runtimeState().excerpt).toBeNull();
      }
      const before = destinations();
      const result = await record(true, session);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DRAFT_NOT_PENDING');
      expect(destinations()).toEqual(before);
    }
  );

  it('never offers a durably declined draft again, even after a new session starts', async () => {
    propose();
    answer('no');
    expect(proposal().outcome).toBe('declined');
    expect(answer('what next?').text).not.toContain('P1');
    expect(onSessionStart(dbPath, 'next-conversation', 'startup', process.env, now + 1)).toBe(true);
    expect(answer('what next?', 'next-conversation', now + 2).text).not.toContain('P1');
    expect((await record(false)).success).toBe(true);
    expect(proposal()).toEqual({ outcome: 'declined', record_id: null, approval_mode: null });
  });

  it.each(['constraint', 'rule', 'profile'])(
    'refuses a late %s approval without writing any destination',
    async (kind) => {
      propose(kind);
      answer('yes');
      expect(runtimeState().excerpt).toMatchObject({ reply: 'other' });
      const before = destinations();
      const result = await record();
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
      expect(destinations()).toEqual(before);
      expect(proposal().outcome).toBe('pending');
    }
  );

  it('keeps the shown draft through compaction and another store starting at three hours', async () => {
    propose();
    expect(onSessionStart(dbPath, SESSION, 'compact', process.env, now - 2)).toBe(true);
    const otherRoot = path.join(tmp, 'other-project');
    const otherDb = seedRbookDb(otherRoot, { projectName: 'other-project' });
    reidentifyRbookTestStore(otherRoot);
    expect(onSessionStart(otherDb, 'other-store-session', 'startup', process.env, now - 1)).toBe(
      true
    );
    expect(answer('yes').reply).toBe('other');
    expect((await record()).success).toBe(true);
    expect(proposal().approval_mode).toBe('agent-judged');
  });
});

describe('a long-lived shown set is not approval from another turn or conversation', () => {
  it.each(['resume', 'ended', 'another-session'])('does not bind after %s', async (boundary) => {
    propose();
    let session = SESSION;
    if (boundary === 'resume')
      expect(onSessionStart(dbPath, SESSION, 'resume', process.env, now - 1)).toBe(true);
    if (boundary === 'ended') expect(onSessionEnd(dbPath, SESSION, process.env)).toBe(true);
    if (boundary === 'another-session') session = 'another-conversation';
    expect(answer('yes', session).reply).toBeNull();
    expect(runtimeState(now, session).excerpt).toBeNull();
    const before = destinations();
    expect((await record(true, session)).error?.code).toBe('APPROVAL_REQUIRED');
    expect(destinations()).toEqual(before);
    expect(proposal().outcome).toBe('pending');
  });

  it.each(['harness marker', 'scheduled prompt'])(
    'does not bind a %s at three hours',
    async (origin) => {
      propose();
      const message =
        origin === 'harness marker' ? '<task-notification>yes</task-notification>' : 'yes';
      const transcript = path.join(tmp, 'session.jsonl');
      fs.writeFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'ScheduleWakeup',
                input: { prompt: 'yes', delaySeconds: 1 },
              },
            ],
          },
        }) + '\n'
      );
      await runCli(['hook', 'prompt'], {
        cwd: projectRoot,
        env: process.env,
        // Transpilation is fixture setup, not the hook deadline under test.
        startedAtMs: Date.now() + 20_000,
        readStdin: async () =>
          JSON.stringify({
            session_id: SESSION,
            cwd: projectRoot,
            prompt: message,
            transcript_path: transcript,
          }),
        stdout: () => {},
        stderr: () => {},
      });
      setExternalSessionOwner(null);
      expect(runtimeState().excerpt).toBeNull();
      expect((await record()).error?.code).toBe('APPROVAL_REQUIRED');
      expect(proposal().outcome).toBe('pending');
      // The next human message still answers the proposal, but cannot become plain approval.
      expect(answer('yes').reply).toBe('other');
      expect((await record()).success).toBe(true);
      expect(proposal().approval_mode).toBe('agent-judged');
    }
  );
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the approval moment through the hook CLI: Stop stores drafts silently, the next messages
// ABOUTME: offer and bind them, and a draft nobody answers is never offered past its lease.

/**
 * What a harness does, simulated as tests/cli/hook-cli.test.ts does: each hook is a CLI run with
 * the harness's stdin. The operator's experience is the contract (#1186): the agent ends a proposal
 * with one "Would record:" line, the operator's next "approved" binds to it, a question keeps it
 * open, "no" declines it, and nothing reappears forever.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import { HOOK_DEADLINES_MS, type CliIo } from '../../src/cli/core';
import { onStop } from '../../src/cli/drafts-hook';
import { transcriptKey } from '../../src/cli/transcript-scan';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { rbookDecisions } from '../../src/tools/rbook/rbook-decisions';
import {
  openDraftRuntime,
  readExcerpt,
  readScans,
  startsSince,
  takeShown,
} from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import * as proposals from '../../src/tools/rbook/proposals';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { currentToolCallActionMode } from '../../src/tools/rbook/tool-call-context';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

const HARNESS_PID = process.pid;
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m06-hooks-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'drafts' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedStartId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedStartId;
  if (savedConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string[];
}

/**
 * s100-m02: room a hook's deadline cannot run out of on a loaded machine. A hook's deadline counts
 * from `startedAtMs`, and in process its verb's first import is a transpile, so under two concurrent
 * suites a stop, prompt or session-end hook ran out of its budget and stored, said or forgot nothing.
 * These tests check the drafts; the last test of the first group checks that the stop hook's own
 * budget still holds, and tests/cli/hook-deadline.test.ts the deadline itself.
 */
const HOOK_ROOM_MS = 20_000;

async function hook(
  event: string,
  stdin: unknown,
  env: Record<string, string> = {},
  startedAtMs = Date.now() + HOOK_ROOM_MS
): Promise<Ran> {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PID: String(HARNESS_PID), ...env },
    cwd: projectRoot,
    startedAtMs,
    readStdin: async () => (typeof stdin === 'string' ? stdin : JSON.stringify(stdin)),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  const code = await runCli(['hook', event], io);
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}

const context = (ran: Ran): string =>
  ran.stdout ? (JSON.parse(ran.stdout).hookSpecificOutput.additionalContext as string) : '';

const PROPOSAL =
  'I would keep one JSON file per decision: readable diffs, no database to ship.\n\n' +
  'Would record: Store project decisions as one JSON file per decision, because diffs stay readable.';

const start = (session: string, source = 'startup') =>
  hook('session-start', { session_id: session, cwd: projectRoot, source });
const stop = (session: string, reply: string, extra: Record<string, unknown> = {}) =>
  hook('stop', { session_id: session, cwd: projectRoot, last_assistant_message: reply, ...extra });
const prompt = (session: string, text: string) =>
  hook('prompt', {
    session_id: session,
    cwd: projectRoot,
    prompt: text,
    prompt_id: `${Math.random()}`,
  });

function drafts(): Array<{
  id: number;
  text: string;
  outcome: string;
  replaced_by: number | null;
  source_session: string | null;
  outside_content: number | null;
  offered_at: string | null;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM proposals ORDER BY id').all() as ReturnType<typeof drafts>;
  } finally {
    db.close();
  }
}

describe('Stop stores the proposal and says nothing', () => {
  it("keeps the stop hook's own budget: a stop that starts with it spent stores nothing (s100-m02)", async () => {
    // The helper widens every hook's budget so load cannot spend it. The budget still binds a stop
    // that starts past it: it stores no draft and prints only its one line, so it never holds the
    // harness up.
    await start('s-one');
    const late = await hook(
      'stop',
      { session_id: 's-one', cwd: projectRoot, last_assistant_message: PROPOSAL },
      {},
      Date.now() - HOOK_DEADLINES_MS.stop
    );
    expect(late).toEqual({
      code: 0,
      stdout: '',
      stderr: ['reasonbook hook stop: hook deadline exceeded'],
    });
    expect(drafts()).toEqual([]);
    // Given its room, the same stop stores the draft.
    await stop('s-one', PROPOSAL);
    expect(drafts()).toHaveLength(1);
  });

  it('turns the trailing line into a pending draft keyed by the hashed session', async () => {
    await start('s-one');
    const ran = await stop('s-one', PROPOSAL);
    expect(ran).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(drafts()).toEqual([
      expect.objectContaining({
        id: 1,
        text: 'Store project decisions as one JSON file per decision, because diffs stay readable.',
        outcome: 'pending',
        source_session: harnessSessionHash('s-one'),
      }),
    ]);
    expect(JSON.stringify(drafts())).not.toContain('s-one');
  });

  it('keeps the draft when another process commits between its read and its write (s96-m11)', async () => {
    // The write reads the pending drafts first. In a deferred transaction, a commit by another
    // process in between made SQLite refuse the insert at once (SQLITE_BUSY_SNAPSHOT), and the
    // hook fails open, so that turn's drafts were lost. The draft write takes the lock at BEGIN.
    await start('s-one');
    await stop('s-one', PROPOSAL);
    // A store in use is in WAL mode, where a reader never holds a writer off; the seed is not.
    const wal = new Database(dbPath);
    wal.pragma('journal_mode = WAL');
    wal.close();
    const other = new Database(dbPath, { timeout: 100 });
    const real = proposals.pendingDrafts;
    const read = jest.spyOn(proposals, 'pendingDrafts').mockImplementation((run) => {
      const rows = real(run);
      try {
        other.prepare("INSERT INTO metadata (key, value) VALUES ('s96-m11-other', '1')").run();
      } catch {
        // Held off by the draft write's lock: the case the immediate transaction is for.
      }
      return rows;
    });
    try {
      const outcome = onStop({
        dbPath,
        rawSessionId: 's-one',
        reply: PROPOSAL.replace(/JSON/g, 'YAML'),
        env: process.env,
        deadlineAtMs: Date.now() + 10_000,
      });
      expect(outcome.created).toBe(1);
    } finally {
      read.mockRestore();
      other.close();
    }
    expect(drafts()).toHaveLength(2);
  });

  it('binds a draft the reply names while another process holds the store, since that writes nothing', async () => {
    // s96-m11 build critic, round 2: only a reply with draft lines takes the write lock, so a reply
    // that names a pending draft is never held off by another writer, and its draft still binds.
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const wal = new Database(dbPath);
    wal.pragma('journal_mode = WAL');
    wal.close();
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
      onStop({
        dbPath,
        rawSessionId: 's-one',
        reply: 'Shall I go ahead with draft P1, one JSON file per decision for project decisions?',
        env: process.env,
        deadlineAtMs: Date.now() + 10_000,
      });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    const runtime = openDraftRuntime(dbPath, process.env)!;
    try {
      expect(takeShown(runtime, harnessSessionHash('s-one'), Date.now())).toEqual([1]);
    } finally {
      runtime.close();
    }
  });

  it('never writes stdout, whatever it is handed', async () => {
    const inputs: unknown[] = [
      '',
      'not json',
      '[1,2]',
      {},
      { session_id: 's-x' },
      { session_id: 's-x', cwd: projectRoot, last_assistant_message: 42 },
      {
        session_id: 's-x',
        cwd: projectRoot,
        last_assistant_message: `x\nWould record: ${'y '.repeat(50_000)}`,
      },
      { session_id: 's-x', cwd: path.join(tmp, 'nowhere'), last_assistant_message: PROPOSAL },
      { session_id: 's-x', cwd: projectRoot, transcript_path: path.join(tmp, 'missing.jsonl') },
    ];
    for (const input of inputs) {
      const ran = await hook('stop', input);
      expect([input, ran.code, ran.stdout]).toEqual([input, 0, '']);
      expect(ran.stderr.length).toBeLessThanOrEqual(1);
    }
  });

  it('never writes stdout for a store another process holds, and fails open in one line', async () => {
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(${JSON.stringify(dbPath)});d.exec('BEGIN EXCLUSIVE');process.stdout.write('held\\n');setTimeout(()=>{},10000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    try {
      const ran = await stop('s-held', PROPOSAL);
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(0);
      expect(ran.stderr).toHaveLength(1);
    } finally {
      holder.kill();
    }
  });

  it('reads the reply from the transcript when Stop carries no last message', async () => {
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'which storage?' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: PROPOSAL }] },
        }),
      ].join('\n') + '\n'
    );
    await hook('stop', { session_id: 's-t', cwd: projectRoot, transcript_path: transcript });
    expect(drafts()).toHaveLength(1);
  });

  it('ignores a mention in the middle of a reply', async () => {
    await stop(
      's-one',
      'The convention looks like\nWould record: Store decisions as JSON files because they diff.\nand that is all.'
    );
    expect(drafts()).toEqual([]);
  });

  it('creates the table on a store that has never had one', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE proposals');
    db.close();
    await stop('s-one', PROPOSAL);
    expect(drafts()).toHaveLength(1);
  });

  it('stays silent and stores nothing when the project switched Reasonbook off', async () => {
    await hook(
      'stop',
      { session_id: 's-one', cwd: projectRoot, last_assistant_message: PROPOSAL },
      { RBOOK_AMBIENT: 'off' }
    );
    expect(drafts()).toEqual([]);
  });
});

describe('the offer rides on the operator’s next messages', () => {
  it('classifies the delivered offer stamp as a write despite the surrounding read hook', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const modes: Array<ReturnType<typeof currentToolCallActionMode>> = [];
    const markOffered = proposals.markOffered;
    const stamp = jest.spyOn(proposals, 'markOffered').mockImplementation((...args) => {
      modes.push(currentToolCallActionMode());
      markOffered(...args);
    });
    try {
      expect(context(await prompt('s-one', 'approved'))).toContain('Reasonbook draft P1');
      expect(modes).toEqual(['write']);
      expect(drafts()[0].offered_at).not.toBeNull();
    } finally {
      stamp.mockRestore();
    }
  });

  it('offers in full once, compactly twice more, then not again in that start', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const first = context(await prompt('s-one', 'Let us also look at the export command next'));
    expect(first).toContain(
      'Reasonbook draft P1 (decision), which your last reply put to the operator'
    );
    expect(first).toContain('fromDraft="P1"');
    expect(context(await prompt('s-one', 'Now the import command, same idea'))).toContain(
      'Still pending: P1'
    );
    expect(context(await prompt('s-one', 'And the help text for both commands'))).toContain(
      'Still pending: P1'
    );
    expect(context(await prompt('s-one', 'Finally tidy the README section'))).not.toContain('P1');
    expect(drafts()[0].offered_at).not.toBeNull();
    expect(drafts()[0].outcome).toBe('pending');
  });

  it('tells the agent a plain approval is one, and keeps the operator’s words outside the store', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const offer = context(await prompt('s-one', 'approved'));
    expect(offer).toContain('plain approval of P1: record it now');
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
    try {
      expect(readExcerpt(runtime, harnessSessionHash('s-one'), 1, Date.now())).toMatchObject({
        message: 'approved',
        reply: 'approval',
        windowSize: 1,
      });
    } finally {
      runtime.close();
    }
    const store = fs.readFileSync(dbPath);
    expect(store.includes(Buffer.from('approved\u0000'))).toBe(false);
  });

  it('declines on a plain decline, and the draft never comes back', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    expect(context(await prompt('s-one', 'no thanks'))).toContain('declined P1');
    expect(drafts()[0].outcome).toBe('declined');
    expect(context(await prompt('s-one', 'ok, what next then?'))).not.toContain('P1');
  });

  it('keeps it pending through a question, and a revised line replaces it with a fresh window', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    expect(context(await prompt('s-one', 'hmm, what about merge conflicts?'))).toContain(
      'asks about P1'
    );
    expect(drafts()[0].outcome).toBe('pending');
    await stop(
      's-one',
      'Conflicts stay rare with one file each.\nWould record: Store project decisions as one JSON file per decision, named by id, because diffs stay readable and conflicts rare.'
    );
    const [old, revised] = drafts();
    expect(old).toMatchObject({ outcome: 'replaced', replaced_by: revised.id });
    expect(revised.outcome).toBe('pending');
    expect(context(await prompt('s-one', 'approved'))).toContain(
      `Reasonbook draft P${revised.id} (decision), which your last reply put to the operator`
    );
  });

  it('leaves the pending draft alone when the next line proposes something else', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'and the cache?');
    await stop(
      's-one',
      'For the cache:\nWould record: Keep the HTTP cache under the user config directory, never in the repo.'
    );
    expect(drafts().map((row) => row.outcome)).toEqual(['pending', 'pending']);
  });
});

describe('the operator answers only what the reply before showed (plan critic B1)', () => {
  const words = (session: string, id = 1) => {
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true });
    try {
      return runtime ? readExcerpt(runtime, harnessSessionHash(session), id, Date.now()) : null;
    } finally {
      runtime?.close();
    }
  };

  it('a later session’s first "proceed" binds nothing until the agent names the draft', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await start('s-next');
    const first = context(await prompt('s-next', 'proceed'));
    expect(first).not.toContain('plain approval');
    expect(words('s-next')).toBeNull();
    await stop(
      's-next',
      'Before the parser: draft P1 still awaits your call (store decisions as JSON files).'
    );
    const answer = context(await prompt('s-next', 'approved'));
    expect(answer).toContain('plain approval of P1: record it now');
    expect(words('s-next')).toMatchObject({ message: 'approved', reply: 'approval' });
  });

  it('a "no" to an unrelated question two messages later declines nothing', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'let us do the parser first');
    await stop('s-one', 'Parser done. Should I also add the --strict flag?');
    expect(context(await prompt('s-one', 'no'))).not.toContain('declined');
    expect(drafts()[0].outcome).toBe('pending');
  });

  it('a decline supersedes earlier approval words even when the main store cannot persist it', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'approved');
    expect(words('s-one')?.reply).toBe('approval');
    await stop('s-one', PROPOSAL);
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    let ran: Ran;
    try {
      ran = await prompt('s-one', 'no');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(ran!.code).toBe(0);
    expect(ran!.stderr.join(' ')).toContain('drafts unavailable');
    expect(drafts()[0].outcome).toBe('pending');
    const excerpt = words('s-one');
    setExternalSessionOwner('s-one');
    let recorded: Awaited<ReturnType<typeof rbookDecisions>>;
    try {
      recorded = await rbookDecisions({
        action: 'record',
        projectRoot,
        fromDraft: 'P1',
        content: drafts()[0].text,
      });
    } finally {
      setExternalSessionOwner(null);
    }
    expect({
      excerpt: excerpt?.reply,
      success: recorded!.success,
      code: recorded!.error?.code,
    }).toEqual({
      excerpt: 'decline',
      success: false,
      code: 'DRAFT_NOT_PENDING',
    });
    expect(drafts()[0].outcome).toBe('pending');
  });

  const incidentalMentions = [
    ['unrelated prose', 'Now the draft P1 fix itself. Should I update the parser?'],
    [
      'same-subject priority prose',
      'P1: Store project decisions as one JSON file per decision; fix readability first.',
    ],
    ['inline code', '`draft P1` Store project decisions as one JSON file per decision.'],
    [
      'double-backtick inline code',
      '``draft P1 Store project decisions as one JSON file per decision.``',
    ],
    [
      'fenced code',
      '```text\ndraft P1 Store project decisions as one JSON file per decision.\n```',
    ],
    ['URL', 'Store project decisions as one JSON file per decision: draft https://example.com/P1'],
    [
      'file path',
      'Store project decisions as one JSON file per decision: draft rbook/planning/P1.md',
    ],
    ['file name', 'Store project decisions as one JSON file per decision: draft P1.md'],
    [
      'link target',
      'Store project decisions as one JSON file per decision: draft [details](rbook/planning/P1.md)',
    ],
  ];
  it.each(
    incidentalMentions.flatMap(([where, reply]) =>
      ['ok', 'no'].map((answer) => ({ where, reply, answer }))
    )
  )('an id in $where never binds "$answer" to an unseen draft', async ({ reply, answer }) => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await start('s-next');
    await stop('s-next', reply);
    const offered = context(await prompt('s-next', answer));
    expect(offered).not.toContain('plain approval');
    expect(offered).not.toContain('declined');
    expect(words('s-next')).toBeNull();
    expect(drafts()[0].outcome).toBe('pending');
  });

  it('a prose id that restates the subject lets the operator decline that draft', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await start('s-next');
    await stop(
      's-next',
      'Proposal P1 still awaits your call: store project decisions as JSON files.'
    );
    expect(context(await prompt('s-next', 'no'))).toContain('declined P1');
    expect(drafts()[0].outcome).toBe('declined');
  });

  it('a repeated line shows the same draft again, without a new row, and the next approval binds', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'hmm, what about merge conflicts?');
    await stop('s-one', `Rare with one file each.\n\n${PROPOSAL.split('\n\n')[1]}`);
    expect(drafts()).toHaveLength(1);
    expect(context(await prompt('s-one', 'approved'))).toContain('plain approval');
    expect(words('s-one')).toMatchObject({ reply: 'approval', windowSize: 1 });
  });

  it('an amendment that flips the key term replaces the one draft it answers (plan critic B3)', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'yes, but in SQLite so I can query across fields');
    await stop(
      's-one',
      'Understood.\nWould record: Store project decisions in one SQLite database, because the operator wants to query across fields.'
    );
    const [old, amended] = drafts();
    expect(old).toMatchObject({ outcome: 'replaced', replaced_by: amended.id });
    expect(amended.outcome).toBe('pending');
  });

  it('under the review role nothing is stored, bound or declined', async () => {
    await start('s-one');
    await hook(
      'stop',
      { session_id: 's-one', cwd: projectRoot, last_assistant_message: PROPOSAL },
      { RBOOK_AGENT_ROLE: 'review' }
    );
    expect(drafts()).toEqual([]);
    await stop('s-one', PROPOSAL);
    const ran = await hook(
      'prompt',
      { session_id: 's-one', cwd: projectRoot, prompt: 'no', prompt_id: 'x' },
      { RBOOK_AGENT_ROLE: 'review' }
    );
    expect(context(ran)).not.toContain('declined');
    expect(drafts()[0].outcome).toBe('pending');
  });
});

describe('sessions', () => {
  it('a session that was already running never sees it; one started later does, compactly, and in its digest', async () => {
    await start('s-concurrent');
    await start('s-one');
    await stop('s-one', PROPOSAL);
    expect(context(await prompt('s-concurrent', 'continue with the parser'))).not.toContain('P1');
    const digest = context(await start('s-later'));
    expect(digest).toContain('Pending drafts');
    expect(digest).toContain('P1');
    expect(context(await prompt('s-later', 'continue with the parser'))).toContain(
      'From an earlier session, awaiting the operator: P1'
    );
  });

  it('expires once three sessions have started since, and leaves the digest', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await start('s-2');
    await start('s-3');
    const digest = context(await start('s-4'));
    expect(digest).not.toContain('P1');
    expect(context(await prompt('s-4', 'continue with the parser'))).not.toContain('P1');
    expect(drafts()[0].outcome).toBe('pending');
  });

  it('a compact is not a session start', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await start('s-one', 'compact');
    await start('s-one', 'compact');
    await start('s-one', 'compact');
    expect(context(await prompt('s-one', 'continue with the parser'))).toContain('P1');
  });

  it('review-role starts cannot spend the operator’s three-start draft lease', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    for (const session of ['review-1', 'review-2', 'review-3']) {
      await hook(
        'session-start',
        { session_id: session, cwd: projectRoot, source: 'startup' },
        { RBOOK_AGENT_ROLE: 'review' }
      );
    }
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
    try {
      expect(startsSince(runtime, 0)).toBe(0);
    } finally {
      runtime.close();
    }
    expect(context(await prompt('s-one', 'approved'))).toContain('plain approval of P1');
  });

  it('forgets the operator’s words when the session ends', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'approved');
    await hook('session-end', { session_id: 's-one', cwd: projectRoot, reason: 'other' });
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
    try {
      expect(readExcerpt(runtime, harnessSessionHash('s-one'), 1, Date.now())).toBeNull();
    } finally {
      runtime.close();
    }
  });
});

describe('outside content', () => {
  it.each([
    { priorOutside: 0, grows: true, expected: null },
    { priorOutside: 0, grows: false, expected: 0 },
    { priorOutside: 1, grows: true, expected: 1 },
  ])(
    'a skipped scan preserves evidence but never calls unread growth none: %j',
    async ({ priorOutside, grows, expected }) => {
      const transcript = path.join(tmp, 'budget.jsonl');
      fs.writeFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: priorOutside
              ? [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }]
              : [{ type: 'text', text: 'No outside content read.' }],
          },
        }) + '\n'
      );
      await stop('s-one', PROPOSAL, { transcript_path: transcript });
      expect(drafts()[0].outside_content).toBe(priorOutside);
      const scannedBytes = fs.statSync(transcript).size;
      if (grows)
        fs.appendFileSync(
          transcript,
          JSON.stringify({ type: 'user', message: { content: 'new words' } }) + '\n'
        );
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        // Stop still has time to save the draft, but the reserved close margin excludes the scan.
        expect(
          onStop({
            dbPath,
            rawSessionId: 's-one',
            reply: PROPOSAL.replace(/JSON/g, 'YAML'),
            transcriptPath: transcript,
            env: process.env,
            deadlineAtMs: now + 1,
          }).created
        ).toBe(1);
      } finally {
        clock.mockRestore();
      }
      expect(drafts()[1].outside_content).toBe(expected);
      const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
      try {
        expect(
          readScans(runtime, harnessSessionHash('s-one')).files.get(transcriptKey(transcript))
        ).toEqual({
          scanned: scannedBytes,
          outside: expected,
        });
      } finally {
        runtime.close();
      }
    }
  );

  it('flags a draft proposed after the session fetched a web page, and the offer says so', async () => {
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }],
        },
      }) + '\n'
    );
    await start('s-one');
    await stop('s-one', PROPOSAL, { transcript_path: transcript });
    expect(drafts()[0].outside_content).toBe(1);
    expect(context(await prompt('s-one', 'approved'))).toContain('outside content');
  });

  it('reads subagent transcripts, where web research usually runs', async () => {
    const transcript = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'research' } }] },
      }) + '\n'
    );
    const subagents = path.join(tmp, 'sess', 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(
      path.join(subagents, 'agent-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }] },
      }) + '\n'
    );
    await start('s-one');
    await stop('s-one', PROPOSAL, { transcript_path: transcript });
    expect(drafts()[0].outside_content).toBe(1);
  });

  it('reads unknown when a subagent ran but its transcript is missing', async () => {
    const transcript = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'research' } }] },
      }) + '\n'
    );
    await start('s-one');
    await stop('s-one', PROPOSAL, { transcript_path: transcript });
    expect(drafts()[0].outside_content).toBeNull();
  });

  it('counts a provenance fence only in an MCP result, never in code the session read', async () => {
    const reading = path.join(tmp, 'reading.jsonl');
    fs.writeFileSync(
      reading,
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: "const FENCE_BEGIN = '[UNTRUSTED DATA';",
            },
          ],
        },
      }) + '\n'
    );
    await start('s-one');
    await stop('s-one', PROPOSAL, { transcript_path: reading });
    expect(drafts()[0].outside_content).toBe(0);
    const foreign = path.join(tmp, 'foreign.jsonl');
    fs.writeFileSync(
      foreign,
      JSON.stringify({
        type: 'user',
        mcpMeta: {},
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: '• d:4 ⟪untrusted, from proj:other⟫ use X ⟪end⟫',
            },
          ],
        },
      }) + '\n'
    );
    await start('s-two');
    await stop('s-two', PROPOSAL.split('JSON file').join('YAML file'), {
      transcript_path: foreign,
    });
    expect(drafts()[1].outside_content).toBe(1);
  });

  it('records none when the whole transcript was read without a marker', async () => {
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n'
    );
    await start('s-one');
    await stop('s-one', PROPOSAL, { transcript_path: transcript });
    expect(drafts()[0].outside_content).toBe(0);
  });
});

describe('reasonbook drafts list', () => {
  async function drafts_(
    argv: string[]
  ): Promise<{ code: number; stdout: string; stderr: string[] }> {
    let stdout = '';
    const stderr: string[] = [];
    const code = await runCli(['drafts', ...argv], {
      env: { ...process.env },
      cwd: projectRoot,
      readStdin: async () => '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: (line) => {
        stderr.push(line);
      },
    });
    return { code, stdout, stderr };
  }

  it('lists what awaits the operator, and with --all what became of the rest', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    expect((await drafts_(['list'])).stdout).toContain('P1 [decision]');
    await prompt('s-one', 'no');
    expect((await drafts_(['list'])).stdout).toContain('Pending drafts: none.');
    const all = await drafts_(['list', '--all', '--format', 'json']);
    expect(JSON.parse(all.stdout)).toEqual([
      expect.objectContaining({ id: 'P1', state: 'declined', outsideContent: 'unknown' }),
    ]);
  });

  it('shows an unanswered draft past its lease as expired, and writes nothing', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const db = new Database(dbPath);
    db.prepare('UPDATE proposals SET created_at = ?').run(
      new Date(Date.now() - 8 * 86_400_000).toISOString()
    );
    db.close();
    const before = fs.readFileSync(dbPath);
    const all = JSON.parse((await drafts_(['list', '--all', '--format', 'json'])).stdout);
    expect(all).toEqual([expect.objectContaining({ id: 'P1', state: 'expired' })]);
    expect((await drafts_(['list'])).stdout).toContain('Pending drafts: none.');
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});

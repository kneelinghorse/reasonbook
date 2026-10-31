// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — recording a draft the operator answered: the record says how the approval was known, and
// ABOUTME: nothing is recorded that the operator did not see, did not answer, declined, or that says something else.

/**
 * The hooks run as in tests/cli/hook-drafts.test.ts (in process, through runCli). The MCP server's
 * link to a harness session is stood in for by setExternalSessionOwner: a server linked to the
 * conversation writes as `ext:<hash>` (session-owner.ts), exactly what the harness link gives it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { recordDraftOfKind } from '../../../src/tools/rbook/draft-approval';
import {
  getDraft,
  markAnswered,
  PROPOSALS_TABLE_SQL,
  rawRunner,
} from '../../../src/tools/rbook/proposals';
import { bindWindow, openDraftRuntime } from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { profilePath } from '../../../src/tools/rbook/operator-profile';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m06-approval-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'approval' });
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

/**
 * s100-m02: room a hook's deadline cannot run out of on a loaded machine. A hook's deadline counts
 * from `startedAtMs`, and in process its verb's first import is a transpile, so under two concurrent
 * suites the stop hook's 500 ms went before its draft was stored and the record that followed was
 * refused. These tests check the drafts; tests/cli/hook-drafts.test.ts checks that the stop hook's own
 * budget still holds, and tests/cli/hook-deadline.test.ts the deadline itself.
 */
const HOOK_ROOM_MS = 20_000;

async function hook(event: string, stdin: unknown): Promise<string> {
  let stdout = '';
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    startedAtMs: Date.now() + HOOK_ROOM_MS,
    readStdin: async () => JSON.stringify(stdin),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  };
  await runCli(['hook', event], io);
  setExternalSessionOwner(null);
  return stdout;
}

const DRAFT = 'Store project decisions as one JSON file per decision, because diffs stay readable.';
const reply = (...lines: string[]) =>
  `Here is my recommendation.\n\n${lines.map((line) => `Would record: ${line}`).join('\n')}`;

const start = (session: string) =>
  hook('session-start', { session_id: session, cwd: projectRoot, source: 'startup' });
const stop = (session: string, text: string) =>
  hook('stop', { session_id: session, cwd: projectRoot, last_assistant_message: text });
const say = (session: string, prompt: string) =>
  hook('prompt', { session_id: session, cwd: projectRoot, prompt, prompt_id: `${Math.random()}` });

/** Propose one draft in s-one and answer it with the operator's message. */
async function proposeAndAnswer(answer: string, text = reply(DRAFT)): Promise<void> {
  await start('s-one');
  await stop('s-one', text);
  await say('s-one', answer);
}

/** The recording server, linked to a harness session (or to none). */
async function record(
  args: Record<string, unknown>,
  session: string | null = 's-one'
): Promise<Awaited<ReturnType<typeof rbookDecisions>>> {
  setExternalSessionOwner(session);
  try {
    return await rbookDecisions({ action: 'record', projectRoot, ...args } as never);
  } finally {
    setExternalSessionOwner(null);
  }
}

function row<T>(sql: string, ...params: unknown[]): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

const decision = (id: number) =>
  row<{
    approval_mode: string | null;
    approval_draft: string | null;
    approval_words: string | null;
  }>(
    'SELECT approval_mode, approval_draft, approval_words FROM strategic_decisions WHERE id = ?',
    id
  );
const proposal = (id = 1) =>
  row<{ outcome: string; record_id: string | null; approval_mode: string | null }>(
    'SELECT outcome, record_id, approval_mode FROM proposals WHERE id = ?',
    id
  );

const idOf = (result: Awaited<ReturnType<typeof record>>): number =>
  (result.data as { decisionId: number }).decisionId;

/** A refused approval must leave every possible record destination untouched. */
function recordState(): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    const profile = profilePath(process.env);
    return {
      decisions: db.prepare('SELECT * FROM strategic_decisions ORDER BY id').all(),
      constraints: db.prepare('SELECT * FROM constraints ORDER BY id').all(),
      learnings: db.prepare('SELECT * FROM learnings ORDER BY id').all(),
      profile: fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null,
    };
  } finally {
    db.close();
  }
}

describe('how the approval is known', () => {
  it('keeps an approved draft exempt from the direct-record headline budget', async () => {
    const content = 'Keep the approved detailed choice. ' + 'reason '.repeat(95);
    expect(content.length).toBeGreaterThan(600);
    await proposeAndAnswer('approved', reply(content));
    const result = await record({ content, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ') ?? '').not.toContain('budget 600');
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it('approved: a plain approval of this draft alone, in this session; the row keeps the words', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toEqual({
      approval_mode: 'approved',
      approval_draft: 'P1',
      approval_words: 'approved',
    });
    expect(proposal()).toEqual({
      outcome: 'approved',
      record_id: `d:${idOf(result)}`,
      approval_mode: 'approved',
    });
  });

  it.each([
    [
      'two added subject words',
      'Store project decisions as one JSON file per decision, because reviewable diffs stay readable locally.',
      'agent-judged',
    ],
    [
      'three added subject words',
      'Store project decisions as one JSON file per decision, because reviewable diffs stay readable locally offline.',
      'agent-judged',
    ],
    [
      'two dropped subject words and one reworded word',
      'Store decisions as one JSON file per decision, because diffs stay legible.',
      'agent-judged',
    ],
    [
      'the three-word reason omitted',
      'Store project decisions as one JSON file per decision.',
      'agent-judged',
    ],
    [
      'an expanded policy on the same subject',
      `${DRAFT} Require schema validation, chronological filenames, signed reviews and encrypted backups for every saved decision.`,
      'agent-judged',
    ],
  ])(
    'plain approval with %s preserves the claimed approval scope',
    async (_description, content, mode) => {
      await proposeAndAnswer('approved');
      const result = await record({ content, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      expect(decision(idOf(result))).toEqual({
        approval_mode: mode,
        approval_draft: 'P1',
        approval_words: 'approved',
      });
      expect(
        row<{ decision_text: string }>(
          'SELECT decision_text FROM strategic_decisions WHERE id = ?',
          idOf(result)
        ).decision_text
      ).toBe(content);
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: mode });
    }
  );

  it('approved tolerates whitespace changes without guessing at meaning', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT.replace(/ /g, '  '), fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it.each([
    [
      'Do not deploy the service before the security review is complete.',
      'Deploy the service before the security review is complete.',
    ],
    [
      'Deploy the service after the security review is complete.',
      'Deploy the service before the security review is complete.',
    ],
    [
      'Limit the monthly hosting budget to 100 dollars.',
      'Limit the monthly hosting budget to 900 dollars.',
    ],
    ['Alice approves requests from Bob.', 'Bob approves requests from Alice.'],
    [DRAFT, DRAFT.replace('JSON', 'YAML')],
  ])('changed wording cannot borrow plain approval: %s', async (drafted, content) => {
    await proposeAndAnswer('approved', reply(drafted));
    const result = await record({ content, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'agent-judged',
      approval_words: 'approved',
    });
  });

  it('agent-judged: nuance, with the nuance folded in and the words attached', async () => {
    await proposeAndAnswer('yes, but name each file by its decision id');
    const result = await record({
      content:
        'Store project decisions as one JSON file per decision, named by id, because diffs stay readable.',
      fromDraft: 'P1',
    });
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'agent-judged',
      approval_words: 'yes, but name each file by its decision id',
    });
  });

  it('agent-judged: a plain approval over several drafts at once', async () => {
    await proposeAndAnswer(
      'approved',
      reply(DRAFT, 'Keep the decision folder under rbook/decisions, never at the repository root.')
    );
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('agent-judged');
  });

  it('a message that does not approve never reads approved', async () => {
    await proposeAndAnswer('let us look at the export command first');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('agent-judged');
  });

  it('agent-attested: a hookless server can record a decision with no operator excerpt', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    const result = await record({ content: DRAFT, fromDraft: 'P1' }, null);
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toEqual({
      approval_mode: 'agent-attested',
      approval_draft: 'P1',
      approval_words: null,
    });
  });

  it('refuses words kept for another conversation rather than attesting to its approval', async () => {
    await proposeAndAnswer('approved');
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' }, 's-other');
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('refuses expired approval words rather than downgrading to agent-attested', async () => {
    await proposeAndAnswer('approved');
    const runtime = openDraftRuntime(dbPath, process.env)!;
    runtime.db.prepare('UPDATE excerpts SET at = at - ?').run(3 * 60 * 60 * 1000);
    runtime.close();
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('a hooked server refuses an unanswered draft and leaves it pending', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(result.error?.suggestion).toContain('after the operator approves');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('goes end to end through the MCP dispatcher', async () => {
    await proposeAndAnswer('approved');
    setExternalSessionOwner('s-one');
    try {
      const answer = await executeMissionProtocolTool(
        'rbook_decisions',
        { action: 'record', content: DRAFT, fromDraft: 'P1', projectRoot },
        context
      );
      expect(answer.isError).not.toBe(true);
      expect(JSON.stringify(answer)).toContain('From draft');
    } finally {
      setExternalSessionOwner(null);
    }
    expect(
      row<{ approval_mode: string }>(
        "SELECT approval_mode FROM strategic_decisions WHERE approval_draft = 'P1'"
      ).approval_mode
    ).toBe('approved');
  });
});

describe('what is never recorded', () => {
  it('refuses an id that is not a draft id, and one with no draft', async () => {
    await proposeAndAnswer('approved');
    expect((await record({ content: DRAFT, fromDraft: 'D1' })).error?.code).toBe(
      'INVALID_PARAMETER'
    );
    expect((await record({ content: DRAFT, fromDraft: 'P99' })).error?.code).toBe(
      'DRAFT_NOT_FOUND'
    );
  });

  it('refuses content about something else: the approval covers only what the draft said', async () => {
    await proposeAndAnswer('approved');
    const result = await record({
      content: 'Adopt Postgres for the analytics store, because the team already runs it.',
      fromDraft: 'P1',
    });
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(proposal().outcome).toBe('pending');
  });

  it('refuses a declined draft, a replaced one (naming its revision) and an expired one', async () => {
    await proposeAndAnswer('no');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe(
      'DRAFT_NOT_PENDING'
    );

    await stop(
      's-one',
      reply('Keep the cache under the user config directory, never in the repository.')
    );
    await say('s-one', 'hmm, what about a shared cache?');
    await stop('s-one', reply('Keep the cache under a shared directory every user can read.'));
    const replaced = await record({
      content: 'Keep the cache under the user config directory.',
      fromDraft: 'P2',
    });
    expect(replaced.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(replaced.error?.suggestion).toContain('P3');

    const db = new Database(dbPath);
    db.prepare('UPDATE proposals SET created_at = ? WHERE id = 3').run(
      new Date(Date.now() - 8 * 86_400_000).toISOString()
    );
    db.close();
    const expired = await record({
      content: 'Keep the cache under a shared directory.',
      fromDraft: 'P3',
    });
    expect(expired.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(expired.error?.message).toContain('expired');
  });

  it('records a draft once: a second record, or a racing one, is refused', async () => {
    await proposeAndAnswer('approved');
    const [a, b] = await Promise.all([
      record({ content: DRAFT, fromDraft: 'P1' }),
      record({ content: `${DRAFT} Confirmed.`, fromDraft: 'P1' }),
    ]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.success)?.error?.code).toBe('DRAFT_NOT_PENDING');
    expect([a, b].find((r) => !r.success)?.error?.suggestion).toContain(
      `--project-root '${projectRoot}'`
    );
    expect(
      row<{ n: number }>(
        "SELECT COUNT(*) AS n FROM strategic_decisions WHERE approval_draft = 'P1'"
      ).n
    ).toBe(1);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe(
      'DRAFT_NOT_PENDING'
    );
  });

  it('refuses a decline the hook could not write to the store', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    // The operator's "no" reached the runtime, but the store write of the decline did not happen.
    const runtime = openDraftRuntime(dbPath, process.env)!;
    bindWindow(runtime, harnessSessionHash('s-one'), [1], 'no', 'decline', Date.now());
    runtime.close();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(result.error?.message).toContain('declined');
  });

  it('marks a draft answered, not approved, when this exact decision was already recorded directly', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    // Recorded before the operator answered (no window is open), so P1 stays pending.
    const direct = await record({ content: DRAFT });
    expect(proposal().outcome).toBe('pending');
    await say('s-one', 'approved');
    const again = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(idOf(again)).toBe(idOf(direct));
    expect((again.data as { approval?: unknown }).approval).toBeUndefined();
    expect(proposal()).toMatchObject({ outcome: 'answered', record_id: `d:${idOf(direct)}` });
    // The row keeps no approval it never had.
    expect(decision(idOf(direct)).approval_mode).toBeNull();
  });
});

describe('constraints, rules and profile lines', () => {
  const kinds = [
    ['constraint', 'Never push to main without a green CI run on the branch.'],
    ['rule', 'Run the full suite before every commit that touches the hook CLI.'],
    ['profile', 'Ask before running any command that spends money on an API.'],
  ] as const;

  for (const [kind, text] of kinds) {
    it(`writes a ${kind} on the operator's approval, as that kind`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const result = await record({ content: text, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      const recorded = (result.data as { recorded: { typedId: string } }).recorded;
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'approved' });
      if (kind === 'constraint') {
        expect(recorded.typedId).toMatch(/^c:\d+$/);
        expect(
          row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
        ).toBe(1);
      } else if (kind === 'rule') {
        expect(recorded.typedId).toMatch(/^l:\d+$/);
        expect(
          row<{ evergreen: number }>('SELECT evergreen FROM learnings WHERE content = ?', text)
            .evergreen
        ).toBe(1);
      } else {
        expect(fs.readFileSync(profilePath(process.env), 'utf8')).toContain(text);
      }
      expect(proposal().record_id).toBe(recorded.typedId);
    });

    it(`writes the approved ${kind} draft text and warns when submitted content adds a policy`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const content = `${text} Exempt emergency deployments and delegate future approvals automatically.`;
      const result = await record({ content, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        `The ${kind} was written as drafted (P1); the content passed differs and was not used. Propose a revised line to change it.`
      );
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'approved' });
      if (kind === 'profile') {
        expect(fs.readFileSync(profilePath(process.env), 'utf8').trim()).toBe(text);
      } else {
        const table = kind === 'constraint' ? 'constraints' : 'learnings';
        const recorded = (result.data as { recorded: { id: number } }).recorded;
        expect(
          row<{ content: string }>(`SELECT content FROM ${table} WHERE id = ?`, recorded.id)
        ).toEqual({ content: text });
        expect(
          row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE content = ?`, content).n
        ).toBe(0);
      }
    });

    it.each([
      ['a question', 'Why should this apply to every session?'],
      ['nuance', 'yes, but exempt emergency deployments'],
    ])(`never writes a ${kind} after %s`, async (_description, answer) => {
      fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
      fs.writeFileSync(profilePath(process.env), 'Keep replies concise.\n');
      await proposeAndAnswer(answer, `Proposed.\n\nWould record (${kind}): ${text}`);
      const before = recordState();
      const result = await record({ content: text, fromDraft: 'P1' });
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
      expect(result.error?.suggestion).toContain(`Would record (${kind}):`);
      expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
      expect(recordState()).toEqual(before);
    });

    it(`never writes a ${kind} as agent-attested`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const result = await record({ content: text, fromDraft: 'P1' }, null);
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
      expect(proposal().outcome).toBe('pending');
      expect(
        row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
      ).toBe(0);
      expect(fs.existsSync(profilePath(process.env))).toBe(false);
    });
  }

  it('claims a constraint draft once when two records race', async () => {
    const text = 'Never push to main without a green CI run on the branch.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${text}`);
    const results = await Promise.all([
      record({ content: text, fromDraft: 'P1' }),
      record({ content: text, fromDraft: 'P1' }),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)?.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(
      row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
    ).toBe(1);
  });

  it('a constraint claim lost after evaluation points its remedy at the evaluated store', async () => {
    const text = 'Never push to main without a green CI run on the branch.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${text}`);
    const db = new Database(dbPath, { readonly: true });
    const draft = getDraft(rawRunner(db), 1)!;
    db.close();
    expect((await record({ content: text, fromDraft: 'P1' })).success).toBe(true);
    // Reproduce the interleaving after both callers evaluated the pending draft but only one
    // can claim it. A whole-router Promise.all may instead hit the earlier already-answered arm.
    const refused = await recordDraftOfKind(
      { content: text, projectRoot },
      {
        draft,
        label: 'P1',
        mode: 'approved',
        words: 'approved',
        coverage: 1,
      }
    );
    expect(refused.error?.message).toContain('answered by another call first');
    expect(refused.error?.suggestion).toContain(`--project-root '${projectRoot}'`);
  });

  it('releases the claim when an approved profile line cannot be written', async () => {
    fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
    fs.writeFileSync(profilePath(process.env), `${'x'.repeat(1080)}\n`);
    const text = 'Ask before running any command that spends money on an API.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (profile): ${text}`);
    const result = await record({ content: text, fromDraft: 'P1' });
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(result.error?.message).toContain('stays pending');
    expect(proposal()).toMatchObject({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(fs.readFileSync(profilePath(process.env), 'utf8')).not.toContain(text);
  });

  it('does not append a profile line twice', async () => {
    const text = 'Ask before running any command that spends money on an API.';
    fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
    fs.writeFileSync(profilePath(process.env), `${text}\n`);
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (profile): ${text}`);
    const result = await record({ content: text, fromDraft: 'P1' });
    expect(
      (result.data as { recorded: { materialization: string } }).recorded.materialization
    ).toBe('existing');
    expect(fs.readFileSync(profilePath(process.env), 'utf8')).toBe(`${text}\n`);
  });
});

describe('a record without fromDraft while the operator’s message is open on drafts', () => {
  it('answers the drafts it covers', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT });
    expect((result.data as { answeredDrafts?: string[] }).answeredDrafts).toEqual(['P1']);
    expect(proposal().outcome).toBe('answered');
  });

  it('leaves an unrelated draft pending, and names it', async () => {
    await proposeAndAnswer('ok and also the parser');
    const result = await record({
      content: 'Parse dates with the platform parser, never a regex.',
    });
    expect((result.data as { stillPendingDrafts?: string[] }).stillPendingDrafts).toEqual(['P1']);
    expect(proposal().outcome).toBe('pending');
  });

  it('touches nothing once the turn has ended', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', 'Done with that.');
    await record({ content: DRAFT });
    expect(proposal().outcome).toBe('pending');
  });
});

describe('approval provenance (s97-m12, learning #481)', () => {
  // The prompts a harness sends on its own, as Claude Code's transcripts record them (s97-m12 evidence).
  const TASK_DONE =
    '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';
  const PEER =
    'Another Claude session sent a message: <cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="other-session">approved</cross-session-message>';
  // This exact harness notice was observed stored as approval words before the human's yes.
  const BROWSER_DISCONNECTED =
    '[Browser disconnected: The browser connection has been closed. Browser tools are no longer available.]';
  const REVISED =
    'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly.';

  it("binds nothing from a harness's own message, and keeps the shown drafts for the operator's next one", async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    // A background task finishes, and another session writes "approved", before the operator answers.
    await say('s-one', TASK_DONE);
    await say('s-one', PEER);
    await say('s-one', BROWSER_DISCONNECTED);
    // The turn the harness opened ends, showing no draft of its own.
    await stop('s-one', 'The background test run passed.');
    const early = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(early.success).toBe(false);
    expect(proposal().outcome).toBe('pending');
    // The operator's own message still finds P1, shown before the latest reply: their words are
    // attached, and the record reads agent-judged, since the message answers that reply.
    await say('s-one', 'approved');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'agent-judged',
      approval_words: 'approved',
    });
  });

  it('stores the human yes after a browser-disconnection notice, never the notice as approval', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    await say('s-one', BROWSER_DISCONNECTED);
    const early = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(early.success).toBe(false);
    expect(early.error?.code).toBe('APPROVAL_REQUIRED');
    expect(proposal().outcome).toBe('pending');
    expect(row<{ n: number }>('SELECT COUNT(*) AS n FROM strategic_decisions')?.n).toBe(0);
    await say('s-one', 'yes');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'approved',
      approval_words: 'yes',
    });
  });

  it("a yes or no to the harness turn's own question settles no draft shown before it", async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    await say('s-one', TASK_DONE);
    await stop('s-one', 'The background test run passed. Shall I delete the scratch branch now?');
    const offer = await say('s-one', 'no');
    expect(offer).not.toMatch(/declined P1/);
    expect(offer).toMatch(/P1 \(decision\) was shown before your last reply/);
    expect(proposal(1).outcome).toBe('pending');
  });

  it('recording the revision of an approved draft settles that draft', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'approved');
    const result = await record({ content: REVISED, fromDraft: 'P2' });
    expect(result.success).toBe(true);
    expect(proposal(1).outcome).toBe('replaced');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
  });

  it("a refusal under an approval names the revision's newest form", async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    // The operator asks about P2, and the next reply revises it again.
    await say('s-one', 'how would merging work?');
    await stop(
      's-one',
      reply(
        'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly with a three-way merge.'
      )
    );
    expect(proposal(2).outcome).toBe('replaced');
    const refused = await record({ content: REVISED, fromDraft: 'P1' });
    expect(refused.error?.suggestion).toMatch(/or record P3 once the operator answers it/);
  });

  it('recording the end of a revision chain settles every approved draft before it', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop(
      's-one',
      reply(
        'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly with a three-way merge.'
      )
    );
    await say('s-one', 'approved');
    const result = await record({
      content:
        'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly with a three-way merge.',
      fromDraft: 'P3',
    });
    expect(result.success).toBe(true);
    // P1, approved before the chain began, is settled: the same choice is never recorded twice.
    expect(proposal(1).outcome).toBe('replaced');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
  });

  it('recording the revision of an approved constraint settles the constraint it revised', async () => {
    const first = 'Never push to main without a green CI run on the branch.';
    const second = 'Never push to main without a green CI run on the branch and a reviewed diff.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${first}`);
    await stop('s-one', `Refined.\n\nWould record (constraint): ${second}`);
    await say('s-one', 'approved');
    expect((await record({ content: second, fromDraft: 'P2' })).success).toBe(true);
    expect(proposal(1).outcome).toBe('replaced');
    expect((await record({ content: first, fromDraft: 'P1' })).success).toBe(false);
  });

  it('a draft carried past a harness turn is not retired by an unrelated line', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    await say('s-one', TASK_DONE);
    await stop('s-one', 'The background test run passed. Shall I delete the scratch branch now?');
    await say('s-one', 'yes, delete it');
    await stop(
      's-one',
      reply('Store project learnings as one Markdown file per learning, for the review digest.')
    );
    expect(proposal(1).outcome).toBe('pending');
  });

  it('a sibling line in the approval turn does not take an approved draft to its own words', async () => {
    await proposeAndAnswer('approved');
    await stop(
      's-one',
      reply('Store project learnings as one Markdown file per learning, for the review digest.')
    );
    // P1 is not linked: its record with nuance folded in still records, as the hook invites.
    const result = await record({
      content: `${DRAFT} Keep each file under 4 KB.`,
      fromDraft: 'P1',
    });
    expect(result.success).toBe(true);
    expect(
      row<{ replaced_by: number | null }>('SELECT replaced_by FROM proposals WHERE id = 1')
        .replaced_by
    ).toBeNull();
  });

  it('a revision retires the draft it revises, though the message before it bound none', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    await say('s-one', 'let me think about it');
    await stop('s-one', 'Take your time.');
    // This message answers a turn that showed no draft, so it binds nothing.
    await say('s-one', 'ok, go on');
    await stop('s-one', reply(REVISED));
    expect(
      row<{ outcome: string; replaced_by: number | null }>(
        'SELECT outcome, replaced_by FROM proposals WHERE id = 1'
      )
    ).toEqual({ outcome: 'replaced', replaced_by: 2 });
  });

  it('an approval stays with what was approved: a later revision does not replace that draft', async () => {
    await proposeAndAnswer('approved');
    // The agent proposes a refinement in the same turn it was told "approved".
    await stop('s-one', reply(REVISED));
    expect(proposal(1).outcome).toBe('pending');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it("that approval records only the approved words: a declined revision's text is refused under it", async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    // The operator declines the revision; its text must not ride on the earlier approval.
    await say('s-one', 'no');
    expect(proposal(2).outcome).toBe('declined');
    const refused = await record({ content: REVISED, fromDraft: 'P1' });
    expect(refused.error?.message).toMatch(/revised by P2 after the operator approved it/);
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it('with no window, a line stating one part of a longer draft does not retire the rest of it', async () => {
    const twoPart =
      'Store project decisions as one JSON file per decision because diffs stay readable, and shrink the tracked store by emptying old automatic context copies before release.';
    await start('s-one');
    await stop('s-one', reply(twoPart));
    await say('s-one', 'let me think about it');
    await stop('s-one', 'Take your time.');
    await say('s-one', 'ok, go on');
    // Only the first part is proposed again: the store shrink must not be retired with it.
    await stop('s-one', reply(DRAFT));
    expect(proposal(1).outcome).toBe('pending');
  });

  it('a record from a draft that holds only part of it says what it leaves out', async () => {
    const twoPart =
      'Store project decisions as one JSON file per decision because diffs stay readable, and shrink the tracked store by emptying old automatic context copies before release.';
    await proposeAndAnswer('yes, the first part for now', reply(twoPart));
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/holds \d+% of draft P1's subject/);
  });

  it('a direct record answers a draft only when it covers what the draft proposed', async () => {
    const longer =
      'Store project decisions as one JSON file per decision because diffs stay readable, and shrink the tracked store by emptying old automatic context copies before release.';
    await proposeAndAnswer('ok', reply(longer));
    // The record covers the first proposal only: the draft stays pending, and the answer names it.
    const result = await record({ content: DRAFT });
    expect((result.data as { stillPendingDrafts?: string[] }).stillPendingDrafts).toEqual(['P1']);
    expect(proposal().outcome).toBe('pending');
  });
});

describe('the approval chain settles through declined, answered and recorded drafts (s100-m02)', () => {
  // The s97 review's finding 15 (its repros/approval-chain): one choice was recorded twice when a
  // revision of an approved draft was declined and the draft revised again, or when the approved
  // draft was recorded in its own words before its revision was.
  const REVISED =
    'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly.';
  const AGAIN =
    'Store project decisions as one JSON file per decision, because diffs stay readable and each file stays under four kilobytes.';
  const MERGE =
    'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly with a three-way merge.';
  const LONG =
    'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly through a three-way merge driver configured per repository for every contributor.';
  const FOLLOW_ON =
    'Configure a three-way merge driver for the JSON decision files in .gitattributes, so concurrent edits merge.';
  const decisions = () => row<{ n: number }>('SELECT count(*) AS n FROM strategic_decisions').n;

  it('a declined revision does not break the chain: recording the next one settles the approved draft', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'no');
    await stop('s-one', reply(AGAIN));
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P3' })).success).toBe(true);
    expect(proposal(1).outcome).toBe('replaced');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('the approved draft recorded in its own words first settles its revision, which is never recorded too', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    const first = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(first.success).toBe(true);
    expect(proposal(2)).toEqual({
      outcome: 'answered',
      record_id: `d:${idOf(first)}`,
      approval_mode: null,
    });
    await say('s-one', 'approved');
    const again = await record({ content: REVISED, fromDraft: 'P2' });
    expect(again.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(decisions()).toBe(1);
  });

  it('a record that answers a draft settles the revisions after it too, and a cycle of links still ends', () => {
    // Driven at the table, as the review's repro did: a direct record answers a draft whose
    // revisions are still pending only when the operator's open message covers it.
    const db = new Database(':memory:');
    try {
      const run = rawRunner(db);
      run.exec(PROPOSALS_TABLE_SQL);
      // Each later draft states the first's subject, as a revision does; the gate below needs it.
      for (const text of [DRAFT, REVISED, MERGE, 'an unrelated draft'])
        db.prepare(
          "INSERT INTO proposals (text, created_at) VALUES (?, '2026-10-19T00:00:00Z')"
        ).run(text);
      // 1 is revised by 2, and 2 by 3; 4 names itself, a cycle no hook writes.
      db.exec(
        'UPDATE proposals SET replaced_by = 2 WHERE id = 1; UPDATE proposals SET replaced_by = 3 WHERE id = 2; UPDATE proposals SET replaced_by = 4 WHERE id = 4;'
      );
      expect(markAnswered(run, [1], 'd:7', '2026-10-20T00:00:00Z')).toBe(1);
      expect(markAnswered(run, [4], 'd:8', '2026-10-20T00:00:00Z')).toBe(1);
      expect(db.prepare('SELECT id, outcome, record_id FROM proposals ORDER BY id').all()).toEqual([
        { id: 1, outcome: 'answered', record_id: 'd:7' },
        { id: 2, outcome: 'answered', record_id: 'd:7' },
        { id: 3, outcome: 'answered', record_id: 'd:7' },
        { id: 4, outcome: 'answered', record_id: 'd:8' },
      ]);
    } finally {
      db.close();
    }
  });

  // The verification round's matrix (s100-m02, round 2): the chain held one link per draft, so a
  // decline further down, or a revision matched to an older approved draft than the one holding
  // its link, left the new line out of the chain.
  it('a decline two links down does not break the chain either', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop('s-one', reply(MERGE));
    await say('s-one', 'no');
    await stop('s-one', reply(AGAIN));
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P4' })).success).toBe(true);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('a revision matched to the oldest approved draft joins the chain at its newest one', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'approved');
    await stop('s-one', reply(MERGE));
    await say('s-one', 'no');
    await stop('s-one', reply(AGAIN));
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P4' })).success).toBe(true);
    expect((await record({ content: REVISED, fromDraft: 'P2' })).success).toBe(false);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('two revisions of one approved draft are one chain: recording the later settles both before it', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(LONG));
    await say('s-one', 'approved');
    await stop('s-one', reply(AGAIN));
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P3' })).success).toBe(true);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
    expect((await record({ content: LONG, fromDraft: 'P2' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('a follow-on line is its own choice: recording the draft before it leaves it recordable', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    // Linked as a revision at the window's floor, though it states little of the decision's subject.
    await stop('s-one', `Git merges line by line.\n\nWould record: ${FOLLOW_ON}`);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(true);
    expect(proposal(3).outcome).toBe('pending');
    await say('s-one', 'approved');
    expect((await record({ content: FOLLOW_ON, fromDraft: 'P3' })).success).toBe(true);
    expect(decisions()).toBe(2);
  });

  it('a follow-on line recorded first leaves the earlier approved choice recordable', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop('s-one', `Git merges line by line.\n\nWould record: ${FOLLOW_ON}`);
    await say('s-one', 'approved');
    expect((await record({ content: FOLLOW_ON, fromDraft: 'P3' })).success).toBe(true);
    expect(proposal(1).outcome).toBe('pending');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(true);
    expect(decisions()).toBe(2);
  });

  it('a refusal names where the chain stands: its end recorded, or its revision declined', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop('s-one', reply(MERGE));
    await say('s-one', 'approved');
    const end = await record({ content: MERGE, fromDraft: 'P3' });
    expect(end.success).toBe(true);
    const settled = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(settled.error?.message).toContain(
      `was replaced by its revision P3, recorded as d:${idOf(end)}`
    );
    // Not "record the revision instead": it is recorded already.
    expect(settled.error?.suggestion).not.toMatch(/Record the revision instead/);
    expect(settled.error?.suggestion).not.toMatch(/Propose the choice again/);
  });

  it('a refusal under an approval offers no revision the operator declined', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'no');
    const refused = await record({ content: REVISED, fromDraft: 'P1' });
    expect(refused.error?.message).toMatch(/revised by P2 after the operator approved it/);
    expect(refused.error?.suggestion).toBe(
      'Send fromDraft without content to record P1 exactly as the operator approved it.'
    );
  });

  // Verification round 2: the walk to the chain's newest pending draft passed a follow-on line, a
  // different choice linked at the window's floor, and hung the next revision on it.
  it('a revision after a follow-on line joins the approved chain, not the follow-on: both choices record', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop('s-one', `Git merges line by line.\n\nWould record: ${FOLLOW_ON}`);
    await say('s-one', 'would that work on Windows?');
    await stop('s-one', reply(AGAIN));
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P4' })).success).toBe(true);
    expect(proposal(3).outcome).toBe('pending');
    await say('s-one', 'approved');
    expect((await record({ content: FOLLOW_ON, fromDraft: 'P3' })).success).toBe(true);
    expect(decisions()).toBe(2);
  });

  it('a draft the operator never approved is retired by the revision that joins its chain', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'let me think about it');
    await stop('s-one', 'Take your time.');
    await say('s-one', 'ok, go on');
    await stop('s-one', reply(AGAIN));
    // P2 was shown and never approved: the revision replaces it, as any unapproved draft a line
    // revises, instead of leaving it "revised after its approval".
    expect(
      row<{ outcome: string; replaced_by: number | null }>(
        'SELECT outcome, replaced_by FROM proposals WHERE id = 2'
      )
    ).toEqual({ outcome: 'replaced', replaced_by: 3 });
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P3' })).success).toBe(true);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('a refusal says a recorded choice is recorded, and offers no revision that expired', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'how would merging work?');
    await stop('s-one', reply(MERGE));
    await say('s-one', 'approved');
    const end = await record({ content: MERGE, fromDraft: 'P3' });
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.suggestion).toBe(
      `Nothing to record from this draft: its choice is recorded as d:${idOf(end)}.`
    );
  });

  it('a replaced draft whose revision expired is not told to record that revision', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    await say('s-one', 'let me think about it');
    await stop('s-one', 'Take your time.');
    await say('s-one', 'ok, go on');
    await stop('s-one', reply(REVISED));
    expect(proposal(1).outcome).toBe('replaced');
    // Three later session starts expire P2 unanswered.
    for (const later of ['s-two', 's-three', 's-four']) await start(later);
    const refused = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(refused.error?.message).toContain('was replaced by its revision P2, which expired');
    expect(refused.error?.suggestion).not.toMatch(/Record the revision instead/);
  });

  // Verification round 3: settling forward measured each later draft against the recorded one and
  // those before it only, so a middle revision that drifted from the first's words stopped the walk
  // short of a later restatement of it, while the linking walk carries every draft it passes.
  it('a middle revision that drifted does not hide a later restatement from the approved draft recorded first', async () => {
    const withDriver = `${DRAFT.slice(0, -1)}, and register a three-way merge driver per repository for concurrent edits.`;
    const drifted =
      'Store each project decision as one JSON file, and register a three-way merge driver per repository for concurrent edits.';
    await proposeAndAnswer('approved');
    await stop('s-one', reply(withDriver));
    await say('s-one', 'does the merge driver need setup on every clone?');
    await stop('s-one', reply(drifted));
    await say('s-one', 'how big can a file get?');
    await stop('s-one', reply(AGAIN));
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).success).toBe(true);
    await say('s-one', 'approved');
    expect((await record({ content: AGAIN, fromDraft: 'P4' })).success).toBe(false);
    expect(decisions()).toBe(1);
  });

  it('holds for every kind of line: a constraint revised past a declined revision', async () => {
    const first = 'Never push to main without a green CI run on the branch.';
    const declined = 'Never push to main without a green CI run on the branch and a reviewed diff.';
    const next =
      'Never push to main without a green CI run on the branch, signed with the release key.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${first}`);
    await stop('s-one', `Refined.\n\nWould record (constraint): ${declined}`);
    await say('s-one', 'no');
    await stop('s-one', `Refined again.\n\nWould record (constraint): ${next}`);
    await say('s-one', 'approved');
    expect((await record({ content: next, fromDraft: 'P3' })).success).toBe(true);
    expect(proposal(1).outcome).toBe('replaced');
    expect((await record({ content: first, fromDraft: 'P1' })).success).toBe(false);
  });
});

describe('stores from before this mission', () => {
  it('without a proposals table: fromDraft finds no draft, and a plain record still works', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE proposals');
    db.close();
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe('DRAFT_NOT_FOUND');
    expect((await record({ content: DRAFT })).success).toBe(true);
  });

  it('without the approval columns: the record adds them and the row carries its mode', async () => {
    const db = new Database(dbPath);
    for (const column of ['approval_mode', 'approval_draft', 'approval_words'])
      db.exec(`ALTER TABLE strategic_decisions DROP COLUMN ${column}`);
    db.close();
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });
});

// s106-m02 (#870, design settled item 1). Agents told "Record the approved draft alone" sent
// fromDraft without content and were refused for missing content (learning #598). The handler now
// takes the draft's own text before sanitizing it, so every later check sees what a verbatim
// restatement gives, and each refusal on this path names a resend that succeeds when followed.
describe('fromDraft alone records the draft in its own words (s106-m02)', () => {
  const OTHER = 'Keep the decision folder under rbook/decisions, never at the repository root.';
  const REVISED =
    'Store project decisions as one JSON file per decision, because diffs stay readable and merge cleanly.';

  /** What a record leaves behind, so the two ways of recording can be compared whole. */
  function outcome(result: Awaited<ReturnType<typeof record>>): unknown {
    if (!result.success) return { refused: result.error?.code, proposal: proposal() };
    const id = idOf(result);
    return {
      decision: decision(id),
      text: row<{ decision_text: string }>(
        'SELECT decision_text FROM strategic_decisions WHERE id = ?',
        id
      ).decision_text,
      proposal: proposal(),
    };
  }

  const cases: Array<[string, () => Promise<void>, string | null, unknown]> = [
    [
      'a plain approval of this draft alone',
      () => proposeAndAnswer('approved'),
      's-one',
      { mode: 'approved', words: 'approved' },
    ],
    [
      'one plain approval over several drafts',
      () => proposeAndAnswer('approved', reply(DRAFT, OTHER)),
      's-one',
      { mode: 'agent-judged', words: 'approved' },
    ],
    [
      'a reply that does not approve',
      () => proposeAndAnswer('let us look at the export command first'),
      's-one',
      { mode: 'agent-judged', words: 'let us look at the export command first' },
    ],
    [
      'no harness session',
      async () => {
        await start('s-one');
        await stop('s-one', reply(DRAFT));
      },
      null,
      { mode: 'agent-attested', words: null },
    ],
    [
      'a harness session with no answer',
      async () => {
        await start('s-one');
        await stop('s-one', reply(DRAFT));
      },
      's-one',
      { refused: 'APPROVAL_REQUIRED' },
    ],
    [
      "another conversation's answer",
      () => proposeAndAnswer('approved'),
      's-other',
      { refused: 'APPROVAL_REQUIRED' },
    ],
  ];

  it.each(
    cases.flatMap(([name, setup, session, expected]) =>
      (['with the draft restated', 'with fromDraft alone'] as const).map(
        (form) => [name, form, setup, session, expected] as const
      )
    )
  )('%s, recorded %s, gives the same record', async (_name, form, setup, session, expected) => {
    await setup();
    const before = recordState();
    const result = await record(
      form === 'with fromDraft alone' ? { fromDraft: 'P1' } : { content: DRAFT, fromDraft: 'P1' },
      session
    );
    const want = expected as { refused?: string; mode?: string; words?: string | null };
    if (want.refused) {
      expect(outcome(result)).toEqual({
        refused: want.refused,
        proposal: { outcome: 'pending', approval_mode: null, record_id: null },
      });
      expect(recordState()).toEqual(before);
      return;
    }
    expect(outcome(result)).toEqual({
      decision: { approval_mode: want.mode, approval_draft: 'P1', approval_words: want.words },
      text: DRAFT,
      proposal: {
        outcome: 'approved',
        record_id: `d:${idOf(result)}`,
        approval_mode: want.mode,
      },
    });
  });

  it('treats blank content as omitted', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ fromDraft: 'P1', content: '   ' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it('the added-fields refusal names a resend that records when followed literally', async () => {
    await proposeAndAnswer('approved');
    const refused = await record({ fromDraft: 'P1', context: 'Because diffs stay readable.' });
    expect(refused.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'context' });
    expect(refused.error?.suggestion).toMatch(
      /without context, alternatives, consequences, deciders and mode: fromDraft without content/
    );
    expect(refused.error?.suggestion).toMatch(/supersedes/);
    // Exactly the resend it names: the added field dropped, fromDraft without content.
    const result = await record({ fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it('a draft revised after a plain approval records in its own words, without a refusal', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    const result = await record({ fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(outcome(result)).toMatchObject({ decision: { approval_mode: 'approved' }, text: DRAFT });
  });

  it("the revised draft's refusal names fromDraft without content, and that resend records", async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', reply(REVISED));
    await say('s-one', 'no');
    const refused = await record({ content: REVISED, fromDraft: 'P1' });
    expect(refused.error?.message).toMatch(/revised by P2 after the operator approved it/);
    expect(refused.error?.suggestion).toMatch(/fromDraft without content/);
    const result = await record({ fromDraft: 'P1' });
    expect(outcome(result)).toMatchObject({ decision: { approval_mode: 'approved' }, text: DRAFT });
  });

  it('the coverage refusal names fromDraft without content, and that resend records', async () => {
    await proposeAndAnswer('approved');
    const refused = await record({
      content: 'Adopt Postgres for the analytics store, because the team already runs it.',
      fromDraft: 'P1',
    });
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
    expect(refused.error?.suggestion).toMatch(/fromDraft without content/);
    const result = await record({ fromDraft: 'P1' });
    expect(outcome(result)).toMatchObject({ decision: { approval_mode: 'approved' }, text: DRAFT });
  });

  it.each([
    ['an id that is not a draft id', 'D1', 'INVALID_PARAMETER'],
    ['an id with no draft', 'P99', 'DRAFT_NOT_FOUND'],
  ])(
    'fromDraft alone with %s is refused for the id, and its "without fromDraft" names the content',
    async (_case, fromDraft, code) => {
      await proposeAndAnswer('approved');
      const refused = await record({ fromDraft });
      expect(refused.error?.code).toBe(code);
      expect(refused.error?.suggestion).toMatch(
        /without fromDraft, with the decision's text as content/
      );
      // Followed as written: no fromDraft, the decision's text as content.
      expect((await record({ content: DRAFT })).success).toBe(true);
    }
  );

  // A draft whose own text holds a tool-call tag outside backticks is cut by the content sanitizer
  // however it is sent, so no resend in its own words can pass. Whatever content the caller sent,
  // its refusal must say why rather than name a resend that is refused again (round-2 critic).
  const TAGGED = 'Strip stray <parameter> tags from imported notes before recording them.';
  it.each([
    ['restated', { content: TAGGED }],
    ['fromDraft alone', {}],
    [
      'other content',
      { content: 'Adopt Postgres for the analytics store, because the team runs it.' },
    ],
  ])(
    'a draft whose own text the sanitizer cuts is refused with the reason, %s',
    async (_form, extra) => {
      await proposeAndAnswer('approved', reply(TAGGED));
      const refused = await record({ fromDraft: 'P1', ...extra });
      expect(refused.error?.code).toBe('INVALID_PARAMETER');
      expect(refused.error?.suggestion).toMatch(/quotes the tag in backticks/);
      expect(refused.error?.suggestion).not.toMatch(/fromDraft without content/);
      expect(proposal().outcome).toBe('pending');
    }
  );

  it('a revised draft whose own text the sanitizer cuts is refused with the reason', async () => {
    await proposeAndAnswer('approved', reply(TAGGED));
    const revision = `${TAGGED.slice(0, -1)}, and log each one.`;
    await stop('s-one', reply(revision));
    await say('s-one', 'no');
    // The tag in backticks, which the sanitizer keeps: different content from the cut words.
    const refused = await record({
      fromDraft: 'P1',
      content: TAGGED.replace('<parameter>', '`<parameter>`'),
    });
    expect(refused.error?.message).toMatch(/revised by P2 after the operator approved it/);
    expect(refused.error?.suggestion).toMatch(/quotes the tag in backticks/);
    expect(refused.error?.suggestion).not.toMatch(/fromDraft without content/);
  });

  it("names the draft's own kind in the line it asks for again", async () => {
    // The tag comes early, so the cut copy keeps too little of the draft to pass.
    const tagged = 'Keep <parameter> tags out of imported notes, quoting any that must stay.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${tagged}`);
    const refused = await record({ fromDraft: 'P1' });
    expect(refused.error?.suggestion).toMatch(/revised Would record \(constraint\) line/);
  });

  // s107-m02 (#876): with the tag late in the line, the cut copy still states most of the draft, so
  // it passed every check and was written cut short under "written as drafted" (a decision,
  // constraint or rule) or written with the raw tag (a profile line). Each is refused before
  // anything is written, and the line proposed again with the tag in a code span records whole.
  const TAG = ['<', 'parameter', '>'].join('');
  it.each([
    ['decision', 'Strip stray markup from imported notes before recording them, such as'],
    ['constraint', 'Never record imported notes that still hold stray markup, such as'],
    ['rule', 'Strip stray markup from imported notes before they are recorded, such as'],
    ['profile', 'Ask before recording imported notes that still hold stray markup, such as'],
  ])(
    'a %s draft a late tag cuts short is refused, and records whole once the tag is quoted',
    async (kind, words) => {
      const label = kind === 'decision' ? 'Would record' : `Would record (${kind})`;
      const late = `${words} ${TAG} tags.`;
      const quoted = `${words} \`${TAG}\` tags.`;
      await proposeAndAnswer('approved', `Proposed.\n\n${label}: ${late}`);
      const untouched = recordState();
      for (const extra of [{}, { content: late }]) {
        const refused = await record({ fromDraft: 'P1', ...extra });
        expect(refused.error?.code).toBe('INVALID_PARAMETER');
        expect(refused.error?.suggestion).toMatch(/quotes the tag in backticks/);
      }
      expect(proposal().outcome).toBe('pending');
      expect(recordState()).toEqual(untouched);

      await stop('s-one', `Revised.\n\n${label}: ${quoted}`);
      await say('s-one', 'approved');
      const recorded = await record({ fromDraft: 'P2' });
      expect(recorded.success).toBe(true);
      if (kind === 'decision')
        expect(
          row<{ decision_text: string }>(
            'SELECT decision_text FROM strategic_decisions WHERE id = ?',
            idOf(recorded)
          ).decision_text
        ).toBe(quoted);
      else if (kind === 'profile')
        expect(fs.readFileSync(profilePath(process.env), 'utf8').split('\n')).toContain(quoted);
      else
        expect(
          row<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${kind === 'constraint' ? 'constraints' : 'learnings'} WHERE content = ?`,
            quoted
          ).n
        ).toBe(1);
    }
  );

  it('a decision a late tag cuts short, sent with other content, names the quoted line, not a resend', async () => {
    const late = `Strip stray markup from imported notes before recording them, such as ${TAG} tags.`;
    await proposeAndAnswer('approved', reply(late));
    const refused = await record({
      fromDraft: 'P1',
      content: 'Adopt Postgres for the analytics store, because the team runs it.',
    });
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
    expect(refused.error?.suggestion).toMatch(/quotes the tag in backticks/);
    expect(refused.error?.suggestion).not.toMatch(/fromDraft without content/);
  });

  it.each([
    ['constraint', 'Never push to main without a green CI run on the branch.'],
    ['rule', 'Run the full suite before every commit that touches the hook CLI.'],
    ['profile', 'Ask before running any command that spends money on an API.'],
  ])('a %s draft recorded by fromDraft alone writes its own text', async (kind, text) => {
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
    const result = await record({ fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(result.warnings ?? []).not.toContainEqual(expect.stringMatching(/differs/));
    expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'approved' });
    if (kind === 'profile')
      expect(fs.readFileSync(profilePath(process.env), 'utf8').trim()).toBe(text);
    else {
      const table = kind === 'constraint' ? 'constraints' : 'learnings';
      expect(
        row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE content = ?`, text).n
      ).toBe(1);
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises guidance for privately settling answered drafts and asking the operator one choice.
// ABOUTME: Follows that question through the Claude hooks into a recorded decision in a disposable store.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import { onStop } from '../../../src/cli/drafts-hook';
import { hookRuntimeIdentity, hookRuntimePath } from '../../../src/cli/hook-runtime';
import * as hookStore from '../../../src/cli/drafts-hook-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  EXCERPT_TTL_MS,
  openDraftRuntime,
  peekShown,
  readExcerpt,
} from '../../../src/tools/rbook/draft-runtime';
import { DRAFTS_ASK } from '../../../src/tools/rbook/digest-v2';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const OLD_QUESTION = 'Should I record this decision?';
const QUESTION = 'Reply “I approve this decision:” followed by the full choice. ' + OLD_QUESTION;
const FULL_TEXT =
  'Store project decisions as one JSON file per decision, because diffs stay readable.';
const ASK = `${FULL_TEXT}\n\n${QUESTION}`;
const NAMED = `I approve this decision: ${FULL_TEXT}`;

function decisionRows() {
  const db = new Database(path.join(projectRoot, 'rbook/db/rbook.sqlite'), { readonly: true });
  try {
    return db
      .prepare('SELECT decision_text, approval_mode, approval_words FROM strategic_decisions')
      .all();
  } finally {
    db.close();
  }
}

let tmp: string;
let projectRoot: string;
const savedConfig = process.env.RBOOK_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-teach-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  seedRbookDb(projectRoot, { projectName: 'teach' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hook(event: string, fields: Record<string, unknown>): Promise<string> {
  let stdout = '';
  await runCli(['hook', event], {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ session_id: 's-teach', cwd: projectRoot, ...fields }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  setExternalSessionOwner(null);
  return stdout ? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string) : '';
}

const PROPOSAL = `Proposed.\n\nWould record: ${FULL_TEXT}`;

describe('answered decisions are connected privately and open choices are asked in ordinary words', () => {
  it('the reminder of a pending decision draft', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: PROPOSAL });
    await hook('prompt', { prompt: 'Let us look at the export command', prompt_id: 'a' });
    const reminder = await hook('prompt', { prompt: 'Now the import command', prompt_id: 'b' });
    expect(reminder).toContain('Still pending: P1');
    expect(reminder).toContain('drafts settle --draft P1 --decision N --project-root DIR');
    expect(reminder).toContain(QUESTION);
    expect(reminder).not.toContain('Settled:');
  });

  it('the digest’s ask', () => {
    expect(DRAFTS_ASK).toContain('drafts settle --draft');
    expect(DRAFTS_ASK).toContain(QUESTION);
    expect(DRAFTS_ASK).not.toContain('Settled:');
  });

  it('the approval-required suggestion for a decision draft nobody answered here', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: PROPOSAL });
    setExternalSessionOwner('s-teach');
    const result = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    const suggestion = result.error?.suggestion ?? '';
    expect(suggestion).toContain('drafts settle --draft P1 --decision N --project-root DIR');
    expect(suggestion).toContain(QUESTION);
    expect(suggestion).not.toContain('Settled:');
    // Within error-bounds.ts's limit, so no layer cuts it to a preview.
    expect(JSON.stringify(suggestion).length).toBeLessThanOrEqual(512);
  });

  it('offers normal recording after an open decision stays unbound', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', {
      last_assistant_message: 'Would record: Put the sample in `report.csv` for reviewers.',
    });
    await hook('prompt', { prompt: 'Let us look at the export command', prompt_id: 'first' });
    const reminder = await hook('prompt', { prompt: 'And the import command', prompt_id: 'next' });
    expect(reminder).toMatch(/named choice.{0,24}without fromDraft/i);
    setExternalSessionOwner('other-hooked-session');
    const result = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(result.error?.suggestion).toMatch(/without fromDraft/i);
  });

  it('the record-decision skill', () => {
    const skill = fs.readFileSync(
      path.join(__dirname, '../../../plugins/reasonbook/skills/record-decision/SKILL.md'),
      'utf8'
    );
    expect(skill).toContain('drafts settle --draft');
    expect(skill).toContain(QUESTION);
    expect(skill).toMatch(/shell|CLI is unavailable/);
    expect(skill).not.toMatch(/name it to the operator.*draft P<n>/);
    expect(skill).toMatch(/`settled`,\s+which is a draft's mode and never a decision's/);
  });
});

async function awaitingChoice() {
  await hook('session-start', { session_id: 'origin', source: 'startup' });
  await hook('stop', { session_id: 'origin', last_assistant_message: PROPOSAL });
  return hook('session-start', { source: 'startup' });
}

async function answer(message = 'yes') {
  await hook('prompt', { prompt: message, prompt_id: message === 'yes' ? 'bare' : 'named' });
  setExternalSessionOwner('s-teach');
  return rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
}

describe('the question Claude actually showed', () => {
  it.each([QUESTION, OLD_QUESTION])(
    'requires a named choice even in one uninterrupted Claude chat (%s)',
    async (question) => {
      expect(await awaitingChoice()).toContain(QUESTION);
      await hook('stop', { last_assistant_message: `${FULL_TEXT}\n\n${question}` });
      expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
      expect(decisionRows()).toEqual([]);
      expect((await answer(NAMED)).success).toBe(true);
      expect(decisionRows()).toEqual([
        { decision_text: FULL_TEXT, approval_mode: 'approved', approval_words: NAMED },
      ]);
    }
  );

  it('shows an ordinary identifier unchanged', async () => {
    const choice = 'Use import_report to list the reviewer comments.';
    await hook('session-start', { session_id: 'origin', source: 'startup' });
    await hook('stop', { session_id: 'origin', last_assistant_message: `Would record: ${choice}` });
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: `${choice}\n\n${QUESTION}` });
    const runtime = openDraftRuntime(path.join(projectRoot, 'rbook/db/rbook.sqlite'), process.env, {
      readonly: true,
    })!;
    try {
      expect(peekShown(runtime, harnessSessionHash('s-teach'), Date.now())).toEqual([1]);
    } finally {
      runtime.close();
    }
  });

  it('leaves a later discussion unrelated when the previous hook could not acquire its turn receipt', async () => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: ASK, prompt_id: 'question' });
    const key = hookRuntimeIdentity({ session_id: 's-teach', cwd: projectRoot }, process.env)!;
    const receipt = new Database(hookRuntimePath(key, process.env));
    try {
      receipt.exec('BEGIN IMMEDIATE');
      await hook('prompt', { prompt: 'Compare the file layouts.', prompt_id: 'compare' });
    } finally {
      receipt.close();
    }
    await hook('prompt', { prompt: 'List the sample filenames.', prompt_id: 'filenames' });
    const runtime = openDraftRuntime(path.join(projectRoot, 'rbook/db/rbook.sqlite'), process.env, {
      readonly: true,
    })!;
    try {
      expect(readExcerpt(runtime, harnessSessionHash('s-teach'), 1, Date.now())).toBeNull();
      expect(decisionRows()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('requires a freshly shown choice after a discussion during a config outage', async () => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: ASK, prompt_id: 'before-recovery' });
    const config = process.env.RBOOK_CONFIG_DIR!;
    const offline = path.join(tmp, 'offline-config');
    fs.renameSync(config, offline);
    fs.writeFileSync(config, 'configuration unavailable');
    try {
      await hook('prompt', { prompt: 'List the file formats.', prompt_id: 'list-formats' });
    } finally {
      fs.unlinkSync(config);
      fs.renameSync(offline, config);
    }
    await hook('prompt', { prompt: 'Explain the format.', prompt_id: 'explain-format' });
    const runtime = openDraftRuntime(path.join(projectRoot, 'rbook/db/rbook.sqlite'), process.env, {
      readonly: true,
    })!;
    try {
      expect(readExcerpt(runtime, harnessSessionHash('s-teach'), 1, Date.now())).toBeNull();
    } finally {
      runtime.close();
    }
    expect(decisionRows()).toEqual([]);
    await hook('stop', { last_assistant_message: ASK, prompt_id: 'fresh-choice' });
    expect((await answer(NAMED)).success).toBe(true);
    expect(decisionRows()).toEqual([
      { decision_text: FULL_TEXT, approval_mode: 'approved', approval_words: NAMED },
    ]);
  });

  it('retires the previous ordinary question before attempting the next project read', async () => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: ASK });
    const dbPath = path.join(projectRoot, 'rbook/db/rbook.sqlite');
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
    const session = harnessSessionHash('s-teach');
    const beforeReads: number[][] = [];
    const stopRead = jest.spyOn(hookStore, 'openStore').mockImplementation(() => {
      beforeReads.push(peekShown(runtime, session, Date.now()));
      throw new Error('project read unavailable');
    });
    try {
      expect(peekShown(runtime, session, Date.now())).toEqual([1]);
      expect(() =>
        onStop({
          dbPath,
          rawSessionId: 's-teach',
          reply: PROPOSAL,
          env: process.env,
          deadlineAtMs: Date.now() + 20000,
        })
      ).toThrow('project read unavailable');
      expect(beforeReads).toEqual([[]]);
    } finally {
      stopRead.mockRestore();
      runtime.close();
    }
  });

  it('replaces an older showing of the same draft and keeps unrelated legacy showings', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', {
      last_assistant_message: `${PROPOSAL}\nWould record: Use a separate import index for faster reads.`,
    });
    await hook('stop', { last_assistant_message: ASK });
    const runtime = openDraftRuntime(path.join(projectRoot, 'rbook/db/rbook.sqlite'), process.env, {
      readonly: true,
    })!;
    const session = harnessSessionHash('s-teach');
    try {
      expect(peekShown(runtime, session, Date.now())).toEqual([1]);
      expect(
        runtime.db
          .prepare('SELECT draft_id FROM kept WHERE session = ? ORDER BY draft_id')
          .pluck()
          .all(session)
      ).toEqual([2]);
    } finally {
      runtime.close();
    }
  });

  it.each([
    ['reported example', `For example:\n${ASK}`],
    [
      'quoted',
      ASK.split('\n')
        .map((line) => '> ' + line)
        .join('\n'),
    ],
    ['fenced', '```\n' + ASK + '\n```'],
    ['different choice', ASK.replace('JSON', 'YAML')],
    ['another question', ASK + '\nShould I also publish it?'],
    ['different kind', ASK.replace('decision?', 'constraint?')],
  ])('leaves a %s unbound', async (_name, example) => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: example });
    expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
    expect(decisionRows()).toEqual([]);
  });

  it.each([
    ['a quoted statement', '"Store the export in one file."'],
    ['a Markdown code span', '`Store the export in one file.`'],
    ['an indented quote', '> Store the export in one file.'],
  ])('does not bind %s even when it matches stored bytes', async (_label, statement) => {
    await hook('session-start', { session_id: 'origin', source: 'startup' });
    await hook('stop', {
      session_id: 'origin',
      last_assistant_message: `Would record: ${statement}`,
    });
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: `${statement}\n\n${QUESTION}` });
    expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
    expect(decisionRows()).toEqual([]);
  });

  it('does not authorize even an agent-judged record using a late yes to an ordinary question', async () => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: ASK });
    const runtime = openDraftRuntime(path.join(projectRoot, 'rbook/db/rbook.sqlite'), process.env)!;
    try {
      runtime.db.prepare('UPDATE shown SET at = at - ?').run(EXCERPT_TTL_MS + 1000);
    } finally {
      runtime.close();
    }
    expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
    expect(decisionRows()).toEqual([]);
  });

  it('refuses identical pending candidates rather than choosing one', async () => {
    await awaitingChoice();
    const db = new Database(path.join(projectRoot, 'rbook/db/rbook.sqlite'));
    try {
      db.exec(
        'INSERT INTO proposals(text, kind, source_session, created_at) SELECT text, kind, source_session, created_at FROM proposals WHERE id=1'
      );
    } finally {
      db.close();
    }
    await hook('stop', { last_assistant_message: ASK });
    expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
    expect(decisionRows()).toEqual([]);
  });

  it.each([
    ['a labelled proposal', PROPOSAL],
    [
      'an older explicitly named draft',
      'Before we move on, should we record draft P1 to store decisions as JSON files?',
    ],
  ])(
    'a newer user turn also cuts off %s in the Claude transcript fallback',
    async (_label, old) => {
      await awaitingChoice();
      const transcript = path.join(tmp, 'stale.jsonl');
      fs.writeFileSync(
        transcript,
        [
          { type: 'assistant', message: { content: [{ type: 'text', text: old }] } },
          { type: 'user', message: { content: 'Where is the export?' } },
          {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n')
      );
      await hook('stop', { transcript_path: transcript });
      expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
      expect(decisionRows()).toEqual([]);
    }
  );

  it('never reuses an earlier question after a user and tool-only turn', async () => {
    await awaitingChoice();
    await hook('stop', { last_assistant_message: ASK });
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: ASK }] } },
        { type: 'user', message: { content: 'Check the file first.' } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    );
    await hook('stop', { transcript_path: transcript });
    expect((await answer()).error?.code).toBe('APPROVAL_REQUIRED');
    expect(decisionRows()).toEqual([]);
  });
});

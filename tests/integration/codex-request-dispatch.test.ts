// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Codex metadata names the call's project and conversation at the registered MCP boundary.
// ABOUTME: Real stores prove isolation, hookless fallback, and approval binding without global owner overrides.

import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runCli } from '../../src/cli';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { evaluateDraft } from '../../src/tools/rbook/draft-evaluation';
import { profilePath } from '../../src/tools/rbook/operator-profile';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  hasHookSession,
  openDraftRuntime,
  readExcerpt,
  recordSessionStart,
  sessionStartedAt,
} from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { closeOwnImplicitSessions } from '../../src/tools/rbook/implicit-session-lifecycle';
import { processSessionOwner, setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

type Result = {
  isError?: boolean;
  structuredContent: {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string; suggestion?: string };
  };
  content: Array<{ type: string; text?: string }>;
};
type Call = (request: { params: Record<string, unknown> }) => Promise<Result>;
let call: Call;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let temp: string;
let project: string;
let other: string;
let dbPath: string;
const saved = {
  config: process.env.RBOOK_CONFIG_DIR,
  sync: process.env.RBOOK_CHECKPOINT_SYNC,
  session: process.env.CLAUDE_CODE_SESSION_ID,
};
const DRAFT = 'Keep the project record in SQLite because every agent needs the same decisions.';

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s95-codex-'));
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  delete process.env.CLAUDE_CODE_SESSION_ID;
  project = path.join(temp, 'project');
  other = path.join(temp, 'other');
  dbPath = seedRbookDb(project, {
    projectName: 'codex-project',
    dashboardProjectId: '11111111-1111-4111-8111-111111111111',
    rbookAddress: 'rbook://operator/codex-project',
  });
  seedRbookDb(other, { projectName: 'other-project' });
  reidentifyRbookTestStore(project);
  reidentifyRbookTestStore(other);
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  jest.spyOn(process, 'cwd').mockReturnValue(other);
  registerToolHandlers(context, {
    setRequestHandler: (method: string, handler: Call) => {
      if (method === 'tools/call') call = handler;
    },
    setNotificationHandler: () => {},
    getClientCapabilities: () => ({}),
    getClientVersion: () => ({ name: 'codex-test', version: '1' }),
  } as unknown as Server);
});
afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  for (const [key, value] of [
    ['RBOOK_CONFIG_DIR', saved.config],
    ['RBOOK_CHECKPOINT_SYNC', saved.sync],
    ['CLAUDE_CODE_SESSION_ID', saved.session],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

function meta(folder = project, sessionId = 'codex-one'): Record<string, unknown> {
  return {
    'x-codex-turn-metadata': {},
    sessionId,
    'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(folder).href },
  };
}
function invoke(name: string, args: Record<string, unknown> = {}, metadata?: unknown) {
  return call({ params: { name, arguments: args, ...(metadata ? { _meta: metadata } : {}) } });
}
function rows<T>(sql: string, root = project): T[] {
  const db = new Database(path.join(root, 'rbook/db/rbook.sqlite'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}
async function hook(
  event: string,
  session: string,
  fields: Record<string, unknown> = {},
  harness: 'codex' | 'claude' = 'codex'
) {
  await runCli(['hook', event, '--harness', harness], {
    env: { ...process.env, ...(harness === 'claude' ? { CLAUDE_PID: String(process.ppid) } : {}) },
    cwd: project,
    // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ session_id: session, cwd: project, ...fields }),
    stdout: () => {},
    stderr: () => {},
  });
  setExternalSessionOwner(null);
}
async function offer(session: string) {
  await hook('session-start', session, { source: 'startup' });
  await hook('stop', session, { last_assistant_message: `Would record: ${DRAFT}` });
}

it('uses the enclosing client folder instead of the server cwd and stamps it as named', async () => {
  const folder = path.join(project, 'src');
  fs.mkdirSync(folder);
  const result = await invoke('rbook_mission', { action: 'list' }, meta(folder));
  expect(result.structuredContent).toMatchObject({
    success: true,
    data: { projectRoot: project, resolvedBy: 'client-cwd' },
  });
  expect(result.content.map((part) => part.text).join('\n')).toContain(project);
});

it('keeps explicit selection final even with unusable Codex metadata', async () => {
  const metadata = meta();
  delete metadata['codex/sandbox-state-meta'];
  const result = await invoke('rbook_mission', { action: 'list', projectRoot: other }, metadata);
  expect(result.structuredContent.data).toMatchObject({
    projectRoot: other,
    resolvedBy: 'explicit',
  });
});

it('does not borrow the server project when the client folder has no store', async () => {
  const folder = path.join(temp, 'empty');
  fs.mkdirSync(folder);
  const result = await invoke('rbook_mission', { action: 'list' }, meta(folder));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain(folder);
});

it.each([undefined, 'https://example.test/project', 'file://remote/project', 'file:///bad%ZZ'])(
  'refuses invalid client folder %p without server-cwd fallback or an unscoped inbox',
  async (sandboxCwd) => {
    const metadata = { ...meta(), 'codex/sandbox-state-meta': { sandboxCwd } };
    for (const name of ['rbook_mission', 'rbook_message']) {
      const result = await invoke(name, { action: 'list' }, metadata);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('projectRoot');
    }
  }
);

it.each([undefined, '', '   ', 7])('refuses unusable session identity %p', async (sessionId) => {
  const result = await invoke('rbook_mission', { action: 'list' }, { ...meta(), sessionId });
  expect(result.isError).toBe(true);
});

it('does not suppress Codex refusal when an optional resolver serves auth or portfolio reads', async () => {
  const metadata = { ...meta(), 'codex/sandbox-state-meta': {} };
  for (const [name, args] of [
    ['rbook_auth', { action: 'list' }],
    ['rbook_mission', { action: 'status', acrossProjects: true }],
  ] as const) {
    const result = await invoke(name, args, metadata);
    expect(result.structuredContent.error?.code).toBe('CODEX_CONTEXT_REQUIRED');
  }
});

it('keeps clients without Codex metadata on the existing cwd route', async () => {
  const result = await invoke('rbook_mission', { action: 'list' });
  expect(result.structuredContent.data).toMatchObject({ projectRoot: other, resolvedBy: 'cwd' });
});

it('whoami resolves the client folder through both strict and relaxed paths', async () => {
  const result = await invoke('rbook_message', { action: 'whoami' }, meta());
  expect(result.structuredContent.success).toBe(true);
  expect(result.structuredContent.data).toMatchObject({
    projectRoot: project,
    resolvedBy: 'client-cwd',
  });
});

it('sends with the client folder identity rather than the plugin server identity', async () => {
  const client = new DashboardClient({ baseUrl: 'http://127.0.0.1', apiKey: 'test' });
  const factory = jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'user-scoped' },
  } as never);
  jest.spyOn(client, 'resolveAddress').mockResolvedValue({ success: true, data: {} } as never);
  jest
    .spyOn(client, 'listDirectory')
    .mockResolvedValue({ success: true, data: { projects: [] } } as never);
  const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
    success: true,
    data: { messageId: 'receipt', status: 'pending' },
  } as never);
  const result = await invoke(
    'rbook_message',
    {
      action: 'send',
      targetAddress: 'rbook://operator/target',
      type: 'intel_alert',
      summary: 'Test',
    },
    meta()
  );
  expect(result.structuredContent.success).toBe(true);
  expect(factory).toHaveBeenCalledWith(project);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      senderProjectId: '11111111-1111-4111-8111-111111111111',
      senderAddress: 'rbook://operator/codex-project',
    })
  );
  expect(result.structuredContent.data).toMatchObject({
    projectRoot: project,
    resolvedBy: 'client-cwd',
  });
});

it('binds independent simultaneous requests to the hook state in their own store', async () => {
  for (const [root, session] of [
    [project, 'one'],
    [other, 'two'],
  ] as const) {
    const runtime = openDraftRuntime(path.join(root, 'rbook/db/rbook.sqlite'))!;
    recordSessionStart(runtime, harnessSessionHash(session), Date.now());
    runtime.close();
  }
  const results = await Promise.all([
    invoke('rbook_decisions', { action: 'record', content: DRAFT }, meta(project, 'one')),
    invoke('rbook_decisions', { action: 'record', content: DRAFT }, meta(other, 'two')),
  ]);
  expect(results.map((result) => result.structuredContent.success)).toEqual([true, true]);
  for (const [root, session] of [
    [project, 'one'],
    [other, 'two'],
  ] as const) {
    expect(
      rows<{ owner_key: string }>('SELECT owner_key FROM sessions WHERE implicit = 1', root)
    ).toEqual([expect.objectContaining({ owner_key: `ext:${harnessSessionHash(session)}` })]);
  }
});

it('keeps an explicitly different store on the pid owner, even when it has that session hash', async () => {
  const runtime = openDraftRuntime(path.join(other, 'rbook/db/rbook.sqlite'))!;
  recordSessionStart(runtime, harnessSessionHash('codex-one'), Date.now());
  runtime.close();
  const result = await invoke(
    'rbook_decisions',
    { action: 'record', content: DRAFT, projectRoot: other },
    meta()
  );
  expect(result.structuredContent.success).toBe(true);
  expect(
    rows<{ owner_key: string }>('SELECT owner_key FROM sessions WHERE implicit = 1', other)
  ).toEqual([expect.objectContaining({ owner_key: processSessionOwner().key })]);
});

it('requires a session-bound choice for a Codex draft and closes the pid session of a direct record', async () => {
  await offer('another-hook-session');
  const result = await invoke(
    'rbook_decisions',
    { action: 'record', content: DRAFT, fromDraft: 'P1' },
    meta()
  );
  expect(result.structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
  expect(rows('SELECT outcome FROM proposals WHERE id = 1')).toEqual([{ outcome: 'pending' }]);
  const direct = await invoke('rbook_decisions', { action: 'record', content: DRAFT }, meta());
  expect(direct.structuredContent.success).toBe(true);
  expect(rows('SELECT approval_mode, approval_draft FROM strategic_decisions')).toEqual([
    { approval_mode: null, approval_draft: null },
  ]);
  expect(rows<{ owner_key: string }>('SELECT owner_key FROM sessions WHERE implicit = 1')).toEqual([
    expect.objectContaining({ owner_key: processSessionOwner().key }),
  ]);
  await closeOwnImplicitSessions();
  expect(rows<{ status: string }>('SELECT status FROM sessions WHERE implicit = 1')).toEqual([
    { status: 'completed' },
  ]);
});

it('requires fresh evidence when a Codex conversation loses its local approval runtime', async () => {
  await offer('codex-one');
  await hook('prompt', 'codex-one', { prompt: `I approve this decision: ${DRAFT}` });
  const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
  const runtimeFile = runtime.path;
  runtime.close();
  fs.renameSync(runtimeFile, runtimeFile + '.unavailable');
  const result = await invoke('rbook_decisions', { action: 'record', fromDraft: 'P1' }, meta());
  expect(result.structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
  expect(rows('SELECT outcome FROM proposals WHERE id = 1')).toEqual([{ outcome: 'pending' }]);
});

describe.each(['claude', 'codex'] as const)('%s standing-setting restatement', (harness) => {
  const text = '12. Plan critics: 5 rounds.';
  const words = 'yes, sounds good approved. 5 rounds.';
  const line = `Would record (profile): ${text}`;
  const session = harness + '-setting';
  const send = (event: string, fields: Record<string, unknown>) =>
    hook(event, session, fields, harness);
  const record = (fromDraft: string) =>
    invoke(
      'rbook_decisions',
      { action: 'record', projectRoot: project, fromDraft },
      harness === 'codex' ? meta(project, session) : undefined
    );

  async function expectShorthandRefused(ids: readonly number[], proposed: string, answer: string) {
    const records = () =>
      rows('SELECT id,text,outcome,record_id,approval_mode FROM proposals ORDER BY id');
    const pending = ids.map((id) => ({
      id,
      text: proposed,
      outcome: 'pending',
      record_id: null,
      approval_mode: null,
    }));
    expect(records()).toEqual(pending);
    await send('prompt', { prompt: answer, prompt_id: 'shorthand', turn_id: 'shorthand' });
    for (const id of ids)
      expect((await record('P' + id)).structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
    expect(records()).toEqual(pending);
    expect(fs.existsSync(profilePath(process.env))).toBe(false);
  }

  it.each([
    ['formatting example', 'Here is the formatting example.\n\n' + line],
    ['competing question', 'Should I also restore the old limit?\n\n' + line],
    ['condition', 'Apply this only after the review finishes.\n\n' + line],
  ])('requires a full named choice after a %s', async (_why, reply) => {
    const proposed = reply.slice(
      reply.indexOf('Would record (profile): ') + 'Would record (profile): '.length
    );
    const value = proposed.slice(proposed.lastIndexOf(':') + 1).trim();
    await send('session-start', { source: 'startup' });
    await send('stop', { last_assistant_message: reply });
    await expectShorthandRefused([1], proposed, 'yes, sounds good approved. ' + value);
    await send('prompt', {
      prompt: `I approve this profile: ${proposed}`,
      prompt_id: 'whole',
      turn_id: 'whole',
    });
    expect((await record('P1')).structuredContent.success).toBe(true);
    expect(fs.readFileSync(profilePath(process.env), 'utf8')).toBe(proposed + '\n');
  });

  describe.each(['standalone proposal', 'exact approval question'])('%s', (showing) => {
    async function show(proposed: string) {
      await send('session-start', { source: 'startup' });
      await send('stop', { last_assistant_message: `Would record (profile): ${proposed}` });
      if (showing === 'exact approval question')
        await send('stop', {
          last_assistant_message: proposed + '\n\nShould I add this to your operator profile?',
        });
    }

    it.each([
      '12. Review budget (pending approval): 5 rounds.',
      '12. Review budget subject to signoff: 5 rounds.',
      '12. Review budget: 5 rounds pending approval.',
      '12. Review budget: 5 rounds subject to signoff.',
      'Provisional review budget: 5 rounds.',
      'Release train: 5 rounds.',
    ])('requires the entire choice for %s', async (proposed) => {
      await show(proposed);
      const value = proposed.slice(proposed.lastIndexOf(':') + 1).trim();
      await expectShorthandRefused([1], proposed, 'yes, sounds good approved. ' + value);
      await send('prompt', {
        prompt: `I approve this profile: ${proposed}`,
        prompt_id: 'whole',
        turn_id: 'whole',
      });
      expect((await record('P1')).structuredContent.success).toBe(true);
      expect(fs.readFileSync(profilePath(process.env), 'utf8')).toBe(proposed + '\n');
    });

    it.each(['Review budget: 2 review passes.', '3. Retry delay: 10 seconds.'])(
      'accepts the complete setting for %s',
      async (proposed) => {
        await show(proposed);
        const answer = 'yes. ' + proposed.slice(proposed.lastIndexOf(':') + 1).trim();
        await send('prompt', { prompt: answer, prompt_id: 'setting', turn_id: 'setting' });
        expect((await record('P1')).structuredContent).toMatchObject({
          success: true,
          data: { approval: { kind: 'profile', mode: 'approved', words: answer } },
        });
        expect(fs.readFileSync(profilePath(process.env), 'utf8')).toBe(proposed + '\n');
      }
    );
  });

  it.each(['before', 'after'])(
    'refuses the shorthand if a second identical draft exists %s the showing',
    async (timing) => {
      await send('session-start', { source: 'startup' });
      if (timing === 'before')
        await hook(
          'stop',
          'initial-author',
          { last_assistant_message: line + '\n' + line },
          harness
        );
      await send('stop', { last_assistant_message: line });
      if (timing === 'after') {
        const db = new Database(dbPath);
        try {
          db.prepare(
            'INSERT INTO proposals(kind,text,source_session,created_at) SELECT kind,text,source_session,created_at FROM proposals WHERE id=1'
          ).run();
        } finally {
          db.close();
        }
      }
      await expectShorthandRefused([1, 2], text, words);
    }
  );
  it.each(['profile', 'rule', 'constraint'] as const)(
    'records only the shown %s and retains its exact approval',
    async (kind) => {
      const adjacent = '11. Ask before an outside action.';
      const file = profilePath(process.env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, adjacent + '\n');
      await hook(
        'stop',
        'other-author',
        { last_assistant_message: 'Would record (profile): 13. Stop checks: 5 rounds.' },
        harness
      );
      await send('session-start', { source: 'startup' });
      await send('stop', { last_assistant_message: `Would record (${kind}): ${text}` });
      await send('prompt', { prompt: words, prompt_id: 'setting', turn_id: 'setting' });
      const before = rows('SELECT * FROM proposals ORDER BY id');
      const reader = (await RbookDatabaseClient.create({ dbPath, readonly: true })).data!;
      setExternalSessionOwner(session);
      try {
        expect(evaluateDraft(reader, 'P2', text, process.env, Date.now())).toMatchObject({
          ok: true,
          value: { draft: { kind, text }, words, mode: 'approved' },
        });
      } finally {
        reader.close();
        setExternalSessionOwner(null);
      }
      expect(rows('SELECT * FROM proposals ORDER BY id')).toEqual(before);
      expect(fs.readFileSync(file, 'utf8')).toBe(adjacent + '\n');
      expect((await record('P1')).structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
      // Restating a setting authorizes its standing destination. Writing a separate
      // decision with similar words cannot consume that permission or resolve its draft.
      const separate = await invoke(
        'rbook_decisions',
        { action: 'record', projectRoot: project, content: text },
        harness === 'codex' ? meta(project, session) : undefined
      );
      expect(separate.structuredContent.success).toBe(true);
      expect(rows('SELECT outcome FROM proposals WHERE id=2')).toEqual([{ outcome: 'pending' }]);
      const result = (await record('P2')).structuredContent;
      expect(result).toMatchObject({
        success: true,
        data: { approval: { kind, draft: 'P2', words, mode: 'approved' }, recorded: { kind } },
      });
      expect((await record('P2')).structuredContent.error?.code).toBe('DRAFT_NOT_PENDING');
      expect(rows('SELECT * FROM proposals WHERE id=1')).toEqual([before[0]]);
      expect(rows('SELECT text,outcome,approval_mode FROM proposals WHERE id=2')).toEqual([
        { text, outcome: 'approved', approval_mode: 'approved' },
      ]);
      if (kind === 'profile')
        expect(fs.readFileSync(file, 'utf8')).toBe(adjacent + '\n' + text + '\n');
      else {
        expect(fs.readFileSync(file, 'utf8')).toBe(adjacent + '\n');
        const table = kind === 'rule' ? 'learnings' : 'constraints';
        expect(
          rows<{ content: string }>(`SELECT content FROM ${table}`).filter(
            (row) => row.content === text
          )
        ).toHaveLength(1);
      }
    }
  );
});

describe.each(['claude', 'codex'] as const)('%s verbatim decision approval', (harness) => {
  const files = 'Save the export to `weekly  report.csv`';
  const url = 'Fetch reports from https://reports.example.test/export?format=weekly';
  it.each([
    ['filename', files, [files.replace('  ', ' '), files + '.']],
    ['URL', url, [url.replace('weekly', 'daily'), url + '.']],
  ] as const)('preserves the %s and requires the exact choice', async (_kind, choice, altered) => {
    const session = `${harness}-verbatim`;
    const send = (event: string, fields: Record<string, unknown>) =>
      hook(event, session, fields, harness);
    const record = () =>
      invoke(
        'rbook_decisions',
        { action: 'record', projectRoot: project, fromDraft: 'P1' },
        harness === 'codex' ? meta(project, session) : undefined
      );
    const draft = () => rows('SELECT text, outcome, approval_mode, record_id FROM proposals');
    const pending = [{ text: choice, outcome: 'pending', approval_mode: null, record_id: null }];
    await send('session-start', { source: 'startup' });
    await send('stop', { last_assistant_message: `Would record: ${choice}` });
    expect(draft()).toEqual(pending);
    await send('stop', {
      last_assistant_message: `${choice}\n\nReply “I approve this decision:” followed by the full choice. Should I record this decision?`,
    });
    const named = (text: string) => `I approve this decision: ${text}`;
    for (const [index, prompt] of ['yes', ...altered.map(named)].entries()) {
      await send('prompt', { prompt, prompt_id: String(index), turn_id: String(index) });
      const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
      try {
        expect(readExcerpt(runtime, harnessSessionHash(session), 1, Date.now())?.reply).not.toBe(
          'approval'
        );
      } finally {
        runtime.close();
      }
      expect((await record()).structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
      expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
      expect(draft()).toEqual(pending);
    }
    await send('prompt', { prompt: named(choice), prompt_id: 'exact', turn_id: 'exact' });
    expect((await record()).structuredContent.success).toBe(true);
    expect(
      rows('SELECT decision_text, approval_mode, approval_words FROM strategic_decisions')
    ).toEqual([
      { decision_text: choice, approval_mode: 'approved', approval_words: named(choice) },
    ]);
    expect(draft()).toEqual([
      { text: choice, outcome: 'approved', approval_mode: 'approved', record_id: 'd:1' },
    ]);
  });
});

it('binds hook-stored operator approval once, without a global owner override', async () => {
  await offer('codex-one');
  const named = `I approve this decision: ${DRAFT}`;
  await hook('prompt', 'codex-one', { prompt: named });
  const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
  expect(sessionStartedAt(runtime, harnessSessionHash('codex-one'))).toBeNull();
  expect(hasHookSession(runtime, harnessSessionHash('codex-one'))).toBe(true);
  runtime.close();
  const args = { action: 'record', content: DRAFT, fromDraft: 'P1' };
  const result = await invoke('rbook_decisions', args, meta());
  expect(result.structuredContent.success).toBe(true);
  expect(
    rows<{ approval_mode: string; approval_words: string }>(
      "SELECT approval_mode, approval_words FROM strategic_decisions WHERE approval_draft = 'P1'"
    )
  ).toEqual([{ approval_mode: 'approved', approval_words: named }]);
  expect((await invoke('rbook_decisions', args, meta())).isError).toBe(true);
  await hook('session-end', 'codex-one');
  const ended = openDraftRuntime(dbPath, process.env, { readonly: true })!;
  expect(hasHookSession(ended, harnessSessionHash('codex-one'))).toBe(false);
  ended.close();
  const afterEnd = await invoke(
    'rbook_decisions',
    {
      action: 'record',
      content: 'Use a different record after the conversation ended.',
    },
    meta()
  );
  expect(afterEnd.structuredContent.success).toBe(true);
  expect(
    rows<{ owner_key: string; status: string }>(
      'SELECT owner_key, status FROM sessions WHERE implicit = 1'
    )
  ).toEqual(
    expect.arrayContaining([
      { owner_key: `ext:${harnessSessionHash('codex-one')}`, status: 'completed' },
      { owner_key: processSessionOwner().key, status: 'active' },
    ])
  );
});

it('retains a known Codex conversation after its last showing is consumed without approval', async () => {
  // A startup before the first draft intentionally leaves the start counter untouched.
  await offer('codex-one');
  await hook('stop', 'codex-one', {
    last_assistant_message: `${DRAFT}\n\nShould I record this decision?`,
  });
  await hook('prompt', 'codex-one', { prompt: 'yes' });
  const runtime = openDraftRuntime(dbPath, process.env, { readonly: true })!;
  try {
    const session = harnessSessionHash('codex-one');
    expect(sessionStartedAt(runtime, session)).toBeNull();
    expect(hasHookSession(runtime, session)).toBe(true);
  } finally {
    runtime.close();
  }
  const args = { action: 'record', fromDraft: 'P1' };
  expect((await invoke('rbook_decisions', args, meta())).structuredContent.error?.code).toBe(
    'APPROVAL_REQUIRED'
  );
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
  await hook('session-end', 'codex-one');
  const ended = openDraftRuntime(dbPath, process.env, { readonly: true })!;
  try {
    expect(hasHookSession(ended, harnessSessionHash('codex-one'))).toBe(false);
  } finally {
    ended.close();
  }
});

it('requires Codex to name the choice, including in the same uninterrupted conversation', async () => {
  const ask = `${DRAFT}\n\nShould I record this decision?`;
  await offer('origin');
  await hook('session-start', 'codex-one', { source: 'startup' });
  await hook('session-start', 'codex-other', { source: 'startup' });
  await hook('stop', 'codex-one', { last_assistant_message: ask });
  await hook('prompt', 'codex-other', { prompt: 'yes', turn_id: 'different-conversation' });
  const args = { action: 'record', fromDraft: 'P1' };
  expect(
    (await invoke('rbook_decisions', args, meta(project, 'codex-other'))).structuredContent.error
      ?.code
  ).toBe('APPROVAL_REQUIRED');

  const transcript = path.join(temp, 'rollout.jsonl');
  fs.writeFileSync(
    transcript,
    [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: ask }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What files changed?' }],
        },
      },
      { type: 'response_item', payload: { type: 'function_call', name: 'read_file' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
  );
  await hook('stop', 'codex-one', { transcript_path: transcript, turn_id: 'tool-only' });
  await hook('prompt', 'codex-one', { prompt: 'yes', turn_id: 'after-tool-only' });
  expect((await invoke('rbook_decisions', args, meta())).structuredContent.error?.code).toBe(
    'APPROVAL_REQUIRED'
  );
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);

  await hook('stop', 'codex-one', { last_assistant_message: ask, turn_id: 'visible-question' });
  await hook('prompt', 'codex-one', { prompt: 'yes', turn_id: 'answer' });
  expect((await invoke('rbook_decisions', args, meta())).structuredContent.error?.code).toBe(
    'APPROVAL_REQUIRED'
  );
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
  const named = `I approve this decision: ${DRAFT}`;
  await hook('prompt', 'codex-one', { prompt: named, turn_id: 'named-choice' });
  expect((await invoke('rbook_decisions', args, meta())).structuredContent.success).toBe(true);
  expect(
    rows('SELECT decision_text, approval_mode, approval_words FROM strategic_decisions')
  ).toEqual([{ decision_text: DRAFT, approval_mode: 'approved', approval_words: named }]);
});

it('keeps the Codex remedy for a decision draft whose text opens with control characters (s109-m02)', async () => {
  // Each control character is six characters in JSON; the suggestion quotes them as spaces, so it
  // stays within error-bounds.ts's limit and is never cut to a preview (the budget verifier, B1).
  const text = `${'\u0001'.repeat(9)}aaaaaaaaaaa Keep the project record in SQLite because every agent needs the same decisions.`;
  await hook('session-start', 'codex-one', { source: 'startup' });
  await hook('stop', 'codex-one', { last_assistant_message: `Would record: ${text}` });
  await hook('session-end', 'codex-one');
  await hook('session-start', 'codex-one', { source: 'resume' });
  await hook('prompt', 'codex-one', { prompt: 'yes' });
  const refused = await invoke('rbook_decisions', { action: 'record', fromDraft: 'P1' }, meta());
  const suggestion = refused.structuredContent.error?.suggestion ?? '';
  expect(refused.structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
  expect(suggestion).not.toContain('[truncated');
  expect(suggestion).toContain('drafts settle --draft P1 --decision N --project-root DIR');
  expect(suggestion).toContain('I approve this decision:');
  expect(suggestion).toContain('Should I record this decision?');
  expect(suggestion).toContain('one Codex conversation running');
  expect(JSON.stringify(suggestion).length).toBeLessThanOrEqual(512);
  // A full proposal is needed for a question; this remedy points to the source even for long text.
  expect(suggestion).toContain('full text with drafts list');
  expect(suggestion).toContain('Keep the project record');
});

it('names a live-conversation remedy after exec ends the approval window, and binds after reproposing there', async () => {
  await offer('codex-one');
  await hook('session-end', 'codex-one');
  await hook('session-start', 'codex-one', { source: 'resume' });
  await hook('prompt', 'codex-one', { prompt: 'yes' });
  const args = { action: 'record', content: DRAFT, fromDraft: 'P1' };
  const refused = await invoke('rbook_decisions', args, meta());
  expect(refused.structuredContent.error?.code).toBe('APPROVAL_REQUIRED');
  expect(refused.structuredContent.error?.suggestion).toContain('one Codex conversation running');
  expect(refused.structuredContent.error?.suggestion).toContain('codex exec resume');
  expect(rows('SELECT id FROM strategic_decisions')).toEqual([]);
  // Re-propose and answer without another SessionEnd/SessionStart between them.
  await hook('stop', 'codex-one', { last_assistant_message: `Would record: ${DRAFT}` });
  const named = `I approve this decision: ${DRAFT}`;
  await hook('prompt', 'codex-one', { prompt: named });
  expect((await invoke('rbook_decisions', args, meta())).structuredContent.success).toBe(true);
  expect(rows('SELECT approval_mode, approval_words FROM strategic_decisions')).toEqual([
    { approval_mode: 'approved', approval_words: named },
  ]);
});

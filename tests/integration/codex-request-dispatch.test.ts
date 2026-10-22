// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Codex metadata names the call's project and conversation at the registered MCP boundary.
// ABOUTME: Real stores prove isolation, hookless fallback, and approval binding without global owner overrides.

import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runCli } from '../../src/cli';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  hasHookSession,
  openDraftRuntime,
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
async function hook(event: string, session: string, fields: Record<string, unknown> = {}) {
  await runCli(['hook', event, '--harness', 'codex'], {
    env: { ...process.env },
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

it('records hookless fromDraft as agent-attested and closes its pid session on server exit', async () => {
  await offer('another-hook-session');
  const result = await invoke(
    'rbook_decisions',
    { action: 'record', content: DRAFT, fromDraft: 'P1' },
    meta()
  );
  expect(result.structuredContent.success).toBe(true);
  expect(
    rows<{ approval_mode: string }>(
      "SELECT approval_mode FROM strategic_decisions WHERE approval_draft = 'P1'"
    )
  ).toEqual([{ approval_mode: 'agent-attested' }]);
  expect(rows<{ owner_key: string }>('SELECT owner_key FROM sessions WHERE implicit = 1')).toEqual([
    expect.objectContaining({ owner_key: processSessionOwner().key }),
  ]);
  await closeOwnImplicitSessions();
  expect(rows<{ status: string }>('SELECT status FROM sessions WHERE implicit = 1')).toEqual([
    { status: 'completed' },
  ]);
});

it('binds hook-stored operator approval once, without a global owner override', async () => {
  await offer('codex-one');
  await hook('prompt', 'codex-one', { prompt: 'approved' });
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
  ).toEqual([{ approval_mode: 'approved', approval_words: 'approved' }]);
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

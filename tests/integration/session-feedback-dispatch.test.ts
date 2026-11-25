// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises session feedback and its filing suggestion through the published MCP handlers.
// ABOUTME: Reads the disposable project's rows to detect lost reports and unintended session writes.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { textOf, type ToolResult } from '../e2e/stdio-harness';
import { seedRbookDb } from '../helpers/seedRbookDb';

const canary = 'private-feedback-sample';
const oversized = canary.padEnd(2001, 'x');
const remedyCall =
  /\b(rbook_agent_onboard)\(\s*(projectRoot)\s*=[^,]+,\s*(agentFeedback)\s*=[^)]+\)/;

describe.each(['full', 'directory'])('%s edition session feedback over MCP', (edition) => {
  let temp: string;
  let root: string;
  let db: Database.Database;
  let client: Client;
  let server: Server;
  let sessionId: string;
  const saved = {
    RBOOK_EDITION: process.env.RBOOK_EDITION,
    RBOOK_CHECKPOINT_SYNC: process.env.RBOOK_CHECKPOINT_SYNC,
    RBOOK_CONFIG_DIR: process.env.RBOOK_CONFIG_DIR,
  };

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({
      name,
      arguments: { projectRoot: root, ...args },
    })) as ToolResult;
  }

  function feedbackRows() {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_feedback'")
      .get();
    return exists
      ? db.prepare('SELECT id, body, tool_name FROM agent_feedback ORDER BY id').all()
      : [];
  }

  function sessionRows() {
    // Transport telemetry has its own lifecycle. Compare every session (including its captures)
    // and every session audit event, so an extra start or partial capture is visible.
    return {
      sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      events: db.prepare('SELECT * FROM session_events ORDER BY id').all(),
    };
  }

  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-feedback-dispatch-'));
    root = path.join(temp, 'project');
    process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
    process.env.RBOOK_CHECKPOINT_SYNC = 'off';
    process.env.RBOOK_EDITION = edition;
    db = new Database(seedRbookDb(root, { projectName: 'feedback-project' }), { readonly: true });
    ProjectGraphRegistry.resetInstance();
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    server = new Server({ name: 'rbook', version: '1' }, { capabilities: { tools: {} } });
    registerToolHandlers(await buildMissionProtocolContext(), server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'session-feedback-client', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  async function openSession() {
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'Keep this session open',
    });
    expect(started.structuredContent?.success).toBe(true);
    sessionId = (started.structuredContent?.data as { sessionId: string }).sessionId;
    expect(sessionId).toEqual(expect.any(String));
  }

  afterEach(async () => {
    await client?.close();
    await server?.close();
    db?.close();
    jest.restoreAllMocks();
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('refuses a start that would otherwise create the first session', async () => {
    const before = sessionRows();
    expect(before.sessions).toEqual([]);
    const refused = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'Must stay unopened',
      agentFeedback: canary,
    });
    expect(sessionRows()).toEqual(before);
    expect(feedbackRows()).toEqual([]);
    expect(refused.structuredContent?.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'agentFeedback',
    });
  });

  it.each(['list', 'start', 'capture', 'search'])(
    '%s refuses a report without touching the session and the suggested call files it once',
    async (action) => {
      await openSession();
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toEqual(expect.arrayContaining(['rbook_session', 'rbook_agent_onboard']));
      expect(listed.includes('rbook_message')).toBe(edition === 'full');
      const byAction: Record<string, Record<string, unknown>> = {
        list: {},
        start: { type: 'custom', title: 'Must not open another session' },
        capture: { sessionId, category: 'context', content: 'Must not append this capture' },
        search: { query: 'session' },
      };
      const sessionsBefore = sessionRows();
      const feedbackBefore = feedbackRows();
      const refused = await call('rbook_session', {
        action,
        ...byAction[action],
        agentFeedback: canary,
      });
      expect({ sessions: sessionRows(), feedback: feedbackRows() }).toEqual({
        sessions: sessionsBefore,
        feedback: feedbackBefore,
      });
      expect(refused.isError).toBe(true);
      const error = refused.structuredContent?.error;
      expect(error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'agentFeedback' });
      expect(error?.message).toContain(action);
      expect(JSON.stringify(refused.structuredContent)).not.toContain(canary);
      expect(textOf(refused)).not.toContain(canary);
      expect(textOf(refused)).toMatch(remedyCall);
      const match = remedyCall.exec(error?.suggestion ?? '');
      expect(match).not.toBeNull();
      const [, tool, rootParam, feedbackParam] = match!;
      const filed = await call(tool, { [rootParam]: root, [feedbackParam]: canary });
      expect(filed.structuredContent?.success).toBe(true);
      const data = filed.structuredContent?.data as { feedbackId: number; projectRoot: string };
      expect(data).toMatchObject({ projectRoot: root, feedbackId: expect.any(Number) });
      expect(feedbackRows()).toEqual([
        ...feedbackBefore,
        { id: data.feedbackId, body: canary, tool_name: 'rbook_agent_onboard' },
      ]);
      expect(sessionRows()).toEqual(sessionsBefore);
    }
  );

  it.each([
    ['nested object', { nested: { note: canary } }, /string/i],
    ['2,001 characters', oversized, /2000/],
  ] as const)(
    'retains the validation reason for %s without echoing the input',
    async (_label, agentFeedback, expected) => {
      await openSession();
      const before = { sessions: sessionRows(), feedback: feedbackRows() };
      for (const action of ['list', 'start', 'capture', 'search', 'complete']) {
        const result = await call('rbook_session', { action, agentFeedback });
        const error = result.structuredContent?.error;
        expect(result.isError).toBe(true);
        expect(error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'agentFeedback' });
        expect([error?.message, error?.suggestion].join(' ')).toMatch(expected);
        expect(textOf(result)).toMatch(expected);
        expect(JSON.stringify(result.structuredContent)).not.toContain(canary);
        expect(textOf(result)).not.toContain(canary);
        if (action !== 'complete') {
          expect(error?.suggestion).toMatch(remedyCall);
          expect(textOf(result)).toMatch(remedyCall);
        }
      }
      expect({ sessions: sessionRows(), feedback: feedbackRows() }).toEqual(before);
    }
  );

  it.each([
    ['omitted', {}],
    ['null', { agentFeedback: null }],
    ['blank', { agentFeedback: '   ' }],
  ] as const)('completes with %s feedback and files no report', async (_label, feedback) => {
    await openSession();
    const completed = await call('rbook_session', {
      action: 'complete',
      sessionId,
      summary: 'Closed without filing feedback.',
      ...feedback,
    });
    expect(completed.structuredContent?.success).toBe(true);
    expect(completed.structuredContent?.data).not.toHaveProperty('feedbackId');
    expect(feedbackRows()).toEqual([]);
    expect(db.prepare('SELECT status FROM sessions WHERE id=?').pluck().get(sessionId)).toBe(
      'completed'
    );
  });

  it('keeps optional values absent and priority on the action, then files feedback once on completion', async () => {
    await openSession();
    const before = sessionRows();
    for (const args of [{}, { agentFeedback: null }, { agentFeedback: '   ' }]) {
      const result = await call('rbook_session', { action: 'list', ...args });
      expect(result.structuredContent?.success).toBe(true);
    }
    const unknown = await call('rbook_session', {
      action: 'invalid-action',
      agentFeedback: { note: canary },
    });
    expect(unknown.structuredContent?.error).toMatchObject({
      code: 'INVALID_ACTION',
      field: 'action',
    });
    expect(textOf(unknown)).not.toContain(canary);
    expect(sessionRows()).toEqual(before);
    expect(feedbackRows()).toEqual([]);
    const completed = await call('rbook_session', {
      action: 'complete',
      sessionId,
      summary: 'Finished the session with a feedback report.',
      agentFeedback: canary,
    });
    expect(completed.structuredContent?.success).toBe(true);
    const { feedbackId } = completed.structuredContent?.data as { feedbackId: number };
    expect(feedbackId).toEqual(expect.any(Number));
    expect(feedbackRows()).toEqual([{ id: feedbackId, body: canary, tool_name: 'rbook_session' }]);
    expect(db.prepare('SELECT status FROM sessions WHERE id=?').pluck().get(sessionId)).toBe(
      'completed'
    );
  });
});

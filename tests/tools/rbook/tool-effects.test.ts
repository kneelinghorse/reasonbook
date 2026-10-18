// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks published tool hints against effects that callers can actually trigger.
// ABOUTME: Separates action-owned store preservation from common MCP telemetry and expiration.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult, Server } from '@modelcontextprotocol/server';
import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  getToolDefinitions,
  registerToolHandlers,
} from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { READ_ONLY_ACTIONS, READ_ONLY_TOOLS } from '../../../src/tools/rbook/action-taxonomy';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  ensureAgentFeedbackTable,
  ensureDecisionsFts5,
  ensureLearningsTable,
  ensureSprintSummaryView,
  ensureVectorStorage,
} from '../../../src/tools/rbook/schema-migrations';
import {
  COMMON_WIRE_EFFECTS,
  deriveEffectAnnotations,
  TOOL_EFFECTS,
  toolEffectMetadata,
} from '../../../src/tools/rbook/tool-effects';
import {
  monthFile,
  readTelemetry,
  targetForStore,
  telemetryDir,
  TELEMETRY_MONTHS_KEPT,
} from '../../../src/tools/rbook/local-telemetry';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const rows = Object.entries(TOOL_EFFECTS).flatMap(([tool, definition]) =>
  Object.entries(definition.actions).map(([action, entry]) => ({
    key: `${tool}:${action}`,
    tool,
    action,
    ...entry,
  }))
);
const noEffects = rows.filter((row) => row.effects.length === 1 && row.effects[0] === 'none');

describe('MCP effect annotations', () => {
  it.each(getToolDefinitions().map((tool) => tool.name))(
    '%s discloses common telemetry writes and expiration instead of promising safe retries',
    (name) => {
      const tool = getToolDefinitions().find((definition) => definition.name === name)!;
      expect(tool).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            // s96-m13: rbook_project's join and sync write a copy on another machine, over SSH.
            openWorldHint:
              name === 'rbook_message' || name === 'rbook_sprint' || name === 'rbook_project',
          },
        })
      );
    }
  );

  it('covers exactly every published action and action-less tool, so new actions cannot escape', () => {
    const published = getToolDefinitions().flatMap((tool) => {
      const actions = (tool.inputSchema.properties?.action as { enum?: string[] })?.enum ?? [''];
      return actions.map((action) => `${tool.name}:${action}`);
    });
    expect(rows.map((row) => row.key).sort()).toEqual(published.sort());
    expect(() => toolEffectMetadata('rbook_unclassified')).toThrow('No effects table');
  });

  it('preserves the distinct read-access contract and derives every published hint', () => {
    const securityReads = [
      ...[...READ_ONLY_TOOLS].map((tool) => `${tool}:`),
      ...Object.entries(READ_ONLY_ACTIONS).flatMap(([tool, actions]) =>
        actions.map((action) => `${tool}:${action}`)
      ),
    ];
    expect(
      rows
        .filter((row) => row.mode === 'read')
        .map((row) => row.key)
        .sort()
    ).toEqual(securityReads.sort());
    for (const tool of getToolDefinitions()) {
      expect(tool.title?.trim()).toBeTruthy();
      expect(tool.annotations).toEqual(
        deriveEffectAnnotations(Object.values(TOOL_EFFECTS[tool.name].actions))
      );
    }
  });

  it('does not mistake reversibility, local-only writes or bounded hosting for read-only', () => {
    const hints = (effects: (typeof COMMON_WIRE_EFFECTS)[number][]) =>
      deriveEffectAnnotations([{ mode: 'write', effects }], []);
    expect(hints(['none'])).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const effect of ['overwrite', 'delete', 'access-revocation', 'message'] as const)
      expect(hints([effect]).destructiveHint).toBe(true);
    expect(hints(['dashboard-write'])).toMatchObject({ readOnlyHint: false, openWorldHint: false });
    expect(hints(['bookkeeping'])).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(hints(['message']).openWorldHint).toBe(true);
  });
});

/**
 * Scope: each `none` row, through direct dispatch, with these successful arguments on a seeded
 * current schema. Hashes include committed WAL pages in the store and registry. This excludes
 * the outer MCP telemetry wrapper and disables upload scheduling; the real registered boundary
 * is exercised separately below. It does not cover every argument, legacy migrations, remote
 * server writes or paths outside these two databases. reads-never-write.test.ts covers legacy
 * read migrations and traces writes that restore the same bytes; code review audits effect truth.
 */
const READ_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  'rbook_status:': {},
  'rbook_context:view': {},
  'rbook_context:history': {},
  'rbook_context:search': { query: 'storage' },
  'rbook_db:health': {},
  // s96-m12: a solo store lists no conflicts, and the read leaves it unchanged.
  'rbook_db:conflicts': {},
  'rbook_decisions:list': {},
  'rbook_decisions:search': { query: 'storage' },
  'rbook_decisions:show': { decisionId: 1 },
  'rbook_decisions:review': {},
  'rbook_feedback:list': {},
  'rbook_learnings:list': {},
  'rbook_learnings:search': { query: 'storage' },
  'rbook_learnings:show': { learningId: 1 },
  'rbook_mission:list': {},
  'rbook_mission:show': { missionId: 'effects-m01' },
  'rbook_mission:status': {},
  'rbook_project:list': {},
  'rbook_project:members': {},
  'rbook_session:list': {},
  'rbook_session:search': { query: 'storage' },
  'rbook_sprint:list': {},
  'rbook_sprint:show': { sprintId: 'sprint-1' },
  'rbook_auth:list': {},
  'rbook_message:list': {},
  'rbook_message:directory': {},
  'rbook_message:whoami': {},
};

it('has a preservation witness for every no-effect row, without a vacuous empty census', () => {
  expect(noEffects.length).toBeGreaterThan(0);
  expect(noEffects.map((row) => row.key).sort()).toEqual(Object.keys(READ_ARGS).sort());
});

describe('store witnesses and the registered MCP boundary', () => {
  let directory: string, projectRoot: string, dbPath: string, graphPath: string;
  let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
  let dashboard: http.Server;
  let requests: string[];
  let savedEnv: NodeJS.ProcessEnv;
  const sql = <T>(query: string, params: unknown[] = []): T => {
    const db = new Database(dbPath);
    try {
      return db.prepare(query).get(...params) as T;
    } finally {
      db.close();
    }
  };
  const run = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    executeMissionProtocolTool(tool, { ...args, projectRoot }, context);
  const hash = async (file: string): Promise<string> => {
    const witness = path.join(directory, `witness-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      await db.backup(witness);
    } finally {
      db.close();
    }
    return createHash('sha256').update(fs.readFileSync(witness)).digest('hex');
  };

  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-effects-'));
    projectRoot = path.join(directory, 'project');
    process.env.RBOOK_CONFIG_DIR = path.join(directory, 'config');
    process.env.RBOOK_PROJECT_ROOT = projectRoot;
    process.env.RBOOK_CHECKPOINT_SYNC = 'off';
    delete process.env.RBOOK_AGENT_ROLE;
    RbookDetector.resetInstance();
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    dbPath = seedRbookDb(projectRoot, {
      projectId: 'effects',
      owner: 'tester',
      rbookAddress: 'rbook://tester/effects',
      dashboardProjectId: '11111111-1111-4111-8111-111111111111',
    });
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT INTO sprints(id,title,status) VALUES('sprint-1','Storage','Active')").run();
    db.prepare(
      "INSERT INTO missions(id,sprint_id,name,status,objective) VALUES('effects-m01','sprint-1','Storage mission','Queued','Original objective')"
    ).run();
    db.prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at,sprint_id) VALUES(1,'Use storage transactions',?,'sprint-1')"
    ).run(now);
    db.prepare(
      "INSERT INTO learnings(id,content,created_at,sprint_id) VALUES(1,'Storage keeps context',?,'sprint-1')"
    ).run(now);
    db.prepare("UPDATE contexts SET content = ? WHERE id = 'master_context'").run(
      JSON.stringify({ context_notes: ['Original context'] })
    );
    db.close();
    const prepared = await RbookDatabaseClient.create({ dbPath, registerProject: false });
    expect(prepared.success).toBe(true);
    const client = prepared.data!;
    for (const migrate of [
      ensureAgentFeedbackTable,
      ensureLearningsTable,
      ensureDecisionsFts5,
      ensureVectorStorage,
      ensureSprintSummaryView,
    ])
      migrate(client);
    client.close();
    const graph = await ProjectGraphRegistry.create();
    graph.register({ project_id: 'effects', store_path: projectRoot, name: 'Effects' });
    graphPath = path.join(process.env.RBOOK_CONFIG_DIR!, 'project-graph.sqlite');
    requests = [];
    dashboard = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('Content-Type', 'application/json');
      const endpoint = request.url?.split('?')[0];
      const payloads: Record<string, unknown> = {
        '/api/keys': { keys: [] },
        '/api/messages': { messages: [], totalCount: 0, unreadCount: 0 },
        '/api/projects/directory/public': { projects: [], totalCount: 0 },
        '/api/projects/me': { projects: [] },
      };
      if (endpoint && endpoint in payloads) response.end(JSON.stringify(payloads[endpoint]));
      else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Unsupported fixture route' }));
      }
    });
    await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
    process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_effects_loopback';
    context = await buildMissionProtocolContext();
  });

  afterEach(async () => {
    if (dashboard) await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    CredentialStore.resetInstance();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(noEffects)('$key preserves prepared store and registry bytes', async (row) => {
    const before = await Promise.all([hash(dbPath), hash(graphPath)]);
    const result = await run(row.tool, {
      ...READ_ARGS[row.key],
      ...(row.action ? { action: row.action } : {}),
    });
    expect(result.structuredContent).toMatchObject({ success: true });
    expect(await Promise.all([hash(dbPath), hash(graphPath)])).toEqual(before);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  });

  it('mission field replacement really loses its prior value and requires a destructive action hint', async () => {
    const result = await run('rbook_mission', {
      action: 'update',
      missionId: 'effects-m01',
      fields: { objective: 'Replacement objective' },
    });
    expect(result.structuredContent).toMatchObject({ success: true });
    expect(
      sql<{ objective: string }>("SELECT objective FROM missions WHERE id = 'effects-m01'")
        .objective
    ).toBe('Replacement objective');
    expect(
      deriveEffectAnnotations([TOOL_EFFECTS.rbook_mission.actions.update], []).destructiveHint
    ).toBe(true);
  });

  it('manual context replacement keeps a post-write snapshot, not the overwritten value', async () => {
    const result = await run('rbook_context', {
      action: 'update',
      mode: 'manual',
      contextType: 'master_context',
      fieldUpdates: [{ path: 'context_notes', value: ['Replacement context'] }],
    });
    expect(result.structuredContent).toMatchObject({ success: true });
    const stored = sql<{ content: string }>(
      "SELECT content FROM contexts WHERE id = 'master_context'"
    );
    expect(JSON.parse(stored.content).context_notes).toEqual(['Replacement context']);
    expect(
      sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM context_snapshots WHERE content LIKE '%Original context%'"
      ).n
    ).toBe(0);
    expect(
      deriveEffectAnnotations([TOOL_EFFECTS.rbook_context.actions.update], []).destructiveHint
    ).toBe(true);
  });

  it('re-init replaces explicit identity fields and therefore advertises overwrite', async () => {
    const result = await run('rbook_project', { action: 'init', projectName: 'Replacement name' });
    expect(result.structuredContent).toMatchObject({ success: true });
    expect(
      sql<{ value: string }>("SELECT value FROM metadata WHERE key = 'project_name'").value
    ).toBe('Replacement name');
    expect(
      deriveEffectAnnotations([TOOL_EFFECTS.rbook_project.actions.init], []).destructiveHint
    ).toBe(true);
  });

  it('unregister hard-deletes registry history instead of archiving it', async () => {
    const result = await run('rbook_project', { action: 'unregister' });
    expect(result.structuredContent).toMatchObject({ success: true });
    expect((await ProjectGraphRegistry.create()).get('effects')).toBeUndefined();
    expect(
      deriveEffectAnnotations([TOOL_EFFECTS.rbook_project.actions.unregister], []).destructiveHint
    ).toBe(true);
  });

  it('a real registered read appends on every call and expires old telemetry months', async () => {
    const target = targetForStore(dbPath)!;
    const logDir = telemetryDir(target);
    fs.mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const oldMonths = Array.from({ length: TELEMETRY_MONTHS_KEPT }, (_, index) =>
      monthFile(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index - 1, 1)))
    );
    for (const month of oldMonths) fs.writeFileSync(path.join(logDir, month), 'expired fixture\n');
    const handlers = new Map<string, (request: unknown) => Promise<CallToolResult>>();
    const server = {
      setNotificationHandler: () => {},
      setRequestHandler: (method: string, handler: (request: unknown) => Promise<CallToolResult>) =>
        handlers.set(method, handler),
      getClientCapabilities: () => ({}),
    } as unknown as Server;
    registerToolHandlers(context, server);
    const before = await Promise.all([hash(dbPath), hash(graphPath)]);
    for (let index = 0; index < 2; index++) {
      const result = await handlers.get('tools/call')!({
        params: { name: 'rbook_mission', arguments: { action: 'list', projectRoot } },
      });
      expect(result.structuredContent).toMatchObject({ success: true });
    }
    expect(await Promise.all([hash(dbPath), hash(graphPath)])).toEqual(before);
    expect(readTelemetry(target)).toHaveLength(2);
    expect(fs.existsSync(path.join(logDir, oldMonths[oldMonths.length - 1]))).toBe(false);
    expect(fs.readdirSync(logDir)).toHaveLength(TELEMETRY_MONTHS_KEPT);
    expect(deriveEffectAnnotations([TOOL_EFFECTS.rbook_mission.actions.list])).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

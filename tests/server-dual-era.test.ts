// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises both MCP eras against actual application children and temporary compiler output.
// ABOUTME: Proves roots, cache hints, client identity, shared-store reads, and EOF/signal shutdown.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import Database from 'better-sqlite3';
import { seedRbookDb } from './helpers/seedRbookDb';
import { RawStdioServer } from './helpers/raw-stdio-server';
import { readTelemetry, targetForStore } from '../src/tools/rbook/local-telemetry';
import { ProjectGraphRegistry } from '../src/intelligence/project-graph-registry';
import { pathToFileURL } from 'url';

const repo = path.resolve(__dirname, '..');
const modern = (name: string) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name, version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
let directory: string;
let serverPath: string;
let project: string;
let other: string;
let config: string;
let cwd: string;
const children: RawStdioServer[] = [];

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-dual-era-'));
  const output = path.join(directory, 'package');
  fs.mkdirSync(output);
  // Transpile the actual source, without instrumentation or a real-dist write. Type checking
  // remains a separate required gate, so this protocol test does not run the compiler twice.
  const compile = (relative: string): void => {
    const source = path.join(repo, 'src', relative);
    if (fs.statSync(source).isDirectory()) {
      for (const name of fs.readdirSync(source)) compile(path.join(relative, name));
    } else if (source.endsWith('.ts') && !source.endsWith('.d.ts')) {
      const target = path.join(output, 'dist', relative.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        ts.transpileModule(fs.readFileSync(source, 'utf8'), {
          fileName: source,
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
          },
        }).outputText
      );
    }
  };
  compile('');
  for (const name of ['node_modules', 'rbook-seed', 'plugins']) {
    fs.symlinkSync(path.join(repo, name), path.join(output, name), 'dir');
  }
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(output, 'package.json'));
  serverPath = path.join(output, 'dist', 'index.js');
}, 60000);

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(directory, 'case-'));
  project = path.join(root, 'project');
  other = path.join(root, 'other');
  config = path.join(root, 'config');
  cwd = path.join(root, 'neutral-cwd');
  fs.mkdirSync(cwd);
  for (const [root, id] of [
    [project, 'first'],
    [other, 'second'],
  ]) {
    const database = new Database(seedRbookDb(root, { projectId: id, projectName: id }));
    // Match the application's connection mode before taking the no-write witness: changing
    // journal mode itself changes SQLite's header even when no application row is written.
    database.pragma('journal_mode = WAL');
    database.close();
  }
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.close()));
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function start(workingDir = cwd, args: string[] = []): RawStdioServer {
  const child = new RawStdioServer(
    serverPath,
    workingDir,
    {
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      HOME: directory,
      RBOOK_CONFIG_DIR: config,
      RBOOK_CHECKPOINT_SYNC: 'off',
      RBOOK_AGENT_ROLE: 'review',
    },
    args,
    // s102-m13: the fixture's old 10 s RPC watchdog expired during loaded startup.
    // Protocol behavior is asserted below; this is not a product latency promise.
    30_000
  );
  children.push(child);
  return child;
}

function snapshot(databasePath: string): Buffer {
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    // serialize includes committed WAL pages; main-file bytes alone can hide a write.
    return database.serialize();
  } finally {
    database.close();
  }
}

async function legacy(child: RawStdioServer): Promise<void> {
  const result = await child.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: 'legacy-native', version: '1' },
  });
  expect(result.protocolVersion).toBe('2025-11-25');
  child.notify('notifications/initialized');
}

it('advertises Codex metadata and carries its folder through an actual MCP process', async () => {
  const child = start(other);
  const initialized = await child.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codex', version: 'test' },
  });
  expect(initialized.capabilities.experimental).toMatchObject({ 'codex/sandbox-state-meta': {} });
  child.notify('notifications/initialized');
  const result = await child.request('tools/call', {
    name: 'rbook_review',
    arguments: {},
    _meta: {
      'x-codex-turn-metadata': {},
      sessionId: 'codex-protocol-session',
      'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(project).href },
    },
  });
  expect(result.structuredContent).toMatchObject({
    success: true,
    data: { projectRoot: project, resolvedBy: 'client-cwd' },
  });
  expect(child.rootsCalls).toBe(0);
});

it('opens with a modern tool call, preserves request identity, and caches tools without changing order', async () => {
  const child = start();
  const called = await child.request('tools/call', {
    name: 'rbook_review',
    arguments: { projectRoot: project },
    _meta: modern('direct-modern'),
  });
  expect(called.structuredContent.success).toBe(true);
  expect(called.structuredContent.data.projectRoot).toBe(project);
  const listing = await child.request('tools/list', { _meta: modern('direct-modern') });
  expect(listing).toMatchObject({ ttlMs: 60000, cacheScope: 'private' });
  expect(listing.tools).toHaveLength(15);
  const old = start();
  await legacy(old);
  const oldListing = await old.request('tools/list');
  expect(oldListing.ttlMs).toBeUndefined();
  expect(oldListing.cacheScope).toBeUndefined();
  expect(listing.tools.map((tool: { name: string }) => tool.name)).toEqual(
    oldListing.tools.map((tool: { name: string }) => tool.name)
  );
  expect(child.rootsCalls).toBe(0);
  const records = readTelemetry(targetForStore(path.join(project, 'rbook/db/rbook.sqlite'))!, {
    RBOOK_CONFIG_DIR: config,
  });
  expect(records).toEqual([expect.objectContaining({ client: 'direct-modern/1', ok: true })]);
  expect(await child.close()).toBe(0);
});

it('keeps legacy roots cached until list_changed and discovers before falling back to a fresh legacy server', async () => {
  const child = start();
  const discovery = await child.request('server/discover', { _meta: modern('probe') });
  expect(discovery).toBeDefined();
  await legacy(child);
  child.roots = [project];
  const review = () => child.request('tools/call', { name: 'rbook_review', arguments: {} });
  expect((await review()).structuredContent.data.projectRoot).toBe(project);
  expect((await review()).structuredContent.data.projectRoot).toBe(project);
  expect(child.rootsCalls).toBe(1);
  child.roots = [other];
  child.notify('notifications/roots/list_changed');
  expect((await review()).structuredContent.data.projectRoot).toBe(other);
  expect(child.rootsCalls).toBe(2);
  expect(await child.close('SIGTERM')).toBe(0);
});

it.each([null, ''])(
  'resolves legacy projectRoot=%p through advertised roots at the real dispatcher',
  async (root) => {
    const child = start();
    await legacy(child);
    child.roots = [project];
    const result = await child.request('tools/call', {
      name: 'rbook_review',
      arguments: { projectRoot: root },
    });
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.data.projectRoot).toBe(project);
    expect(child.rootsCalls).toBe(1);
  }
);

it.each(['cwd', 'server-project-root', 'registry-default'] as const)(
  'resolves a modern omitted root through the actual %s fallback without asking hanging roots',
  async (source) => {
    if (source === 'registry-default') {
      ProjectGraphRegistry.resetInstance();
      const registry = await ProjectGraphRegistry.create({ configDir: config });
      try {
        registry.register({ project_id: 'first', store_path: project, name: 'first' });
        expect(registry.setDefault('first', { confirmed: true })).toBe(true);
      } finally {
        ProjectGraphRegistry.resetInstance();
      }
    }
    // HOME is contextless, so only the named fallback can succeed; cwd uses a real project.
    const child = start(
      source === 'cwd' ? project : directory,
      source === 'server-project-root' ? ['--project-root', project] : []
    );
    child.roots = [other];
    child.answerRoots = false;
    const result = await child.request('tools/call', {
      name: 'rbook_review',
      arguments: {},
      _meta: {
        ...modern(`fallback-${source}`),
        'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true } },
      },
    });
    expect(result.structuredContent.success).toBe(true);
    expect(fs.realpathSync(result.structuredContent.data.projectRoot)).toBe(
      fs.realpathSync(project)
    );
    expect(child.rootsCalls).toBe(0);
  }
);

it('serves two simultaneous application processes against one store without SQLite errors or identity leakage', async () => {
  const first = start();
  const second = start();
  expect(first.child.pid).not.toBe(second.child.pid);
  const dbPath = path.join(project, 'rbook/db/rbook.sqlite');
  const before = snapshot(dbPath);
  const results = await Promise.all(
    [first, second].map((child, index) =>
      child.request('tools/call', {
        name: 'rbook_review',
        arguments: { projectRoot: project },
        _meta: modern(`parallel-${index}`),
      })
    )
  );
  // s98-m08 (#660 item 6): match each whole answer, so a refusal prints its code and message.
  for (const result of results) expect(result.structuredContent).toMatchObject({ success: true });
  expect(snapshot(dbPath)).toEqual(before);
  snapshot(path.join(config, 'project-graph.sqlite'));
  expect([first.rootsCalls, second.rootsCalls]).toEqual([0, 0]);
  expect(
    readTelemetry(targetForStore(dbPath)!, { RBOOK_CONFIG_DIR: config })
      .map((row) => row.client)
      .sort()
  ).toEqual(['parallel-0/1', 'parallel-1/1']);
  expect(`${first.stderr}${second.stderr}`).not.toMatch(/SQLITE_BUSY|SQLITE_MISUSE/);
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: MCP init gives unnamed stores their folder name while preserving established identity.
// ABOUTME: Real stores cover first init, old empty/NULL names, explicit names, and MCP dispatch.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeMissionProtocolTool } from '../../../src/index';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';
import { share } from '../../helpers/replica-fixture';

let temp: string;
let root: string;
let dbPath: string;
const saved = {
  config: process.env.RBOOK_CONFIG_DIR,
  sync: process.env.RBOOK_CHECKPOINT_SYNC,
};

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-default-name-')));
  root = path.join(temp, 'folder-name');
  fs.mkdirSync(root);
  dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});

afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  fs.rmSync(temp, { recursive: true, force: true });
});

function readIdentity(): {
  id: string;
  name: string | null | undefined;
  masterName: string | null;
  identityName?: string | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const meta = db.prepare('SELECT value FROM metadata WHERE key = ?').pluck();
    const context = db.prepare('SELECT content FROM contexts WHERE id = ?').pluck();
    const identity = context.get('project_identity') as string | undefined;
    return {
      id: meta.get('project_id') as string,
      name: meta.get('project_name') as string | null | undefined,
      masterName: JSON.parse(context.get('master_context') as string).project_identity.name,
      ...(identity ? { identityName: JSON.parse(identity).project_name } : {}),
    };
  } finally {
    db.close();
  }
}

/** The identity state 4.5.0 MCP init leaves, with a nullable foreign-store variant. */
function oldUnnamedStore(name: string | null): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    if (name === null) db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    db.exec(RBOOK_SCHEMA);
    const metadata = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
    metadata.run('project_id', 'stable-old-project');
    metadata.run('project_name', name);
    metadata.run('project_type', 'general');
    const insert = db.prepare(
      'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    insert.run(
      'master_context',
      'rbook/context/master_context.json',
      JSON.stringify({ project_identity: { name, status: 'active_development' } }),
      now
    );
    insert.run(
      'project_identity',
      'rbook/context/project_identity.json',
      JSON.stringify({ project_name: name, tier: 'general' }),
      now
    );
  } finally {
    db.close();
  }
}

it.each([undefined, ''])(
  'stores the folder name when first init receives projectName=%p, without a sync setting',
  async (projectName) => {
    expect(process.env.RBOOK_CHECKPOINT_SYNC).toBeUndefined();
    const result = await rbookProjectInit({ projectRoot: `${root}/`, projectName });
    expect(result.success).toBe(true);
    expect(result.data?.projectName).toBe('folder-name');
    expect(readIdentity()).toEqual({
      id: result.data?.projectId,
      name: 'folder-name',
      masterName: 'folder-name',
    });
    const graph = await ProjectGraphRegistry.create();
    expect(graph.get(result.data!.projectId)?.name).toBe('folder-name');
  }
);

it.each(['Chosen name', '  Chosen name  ', '   '])(
  'preserves the existing explicit-name contract for %p',
  async (projectName) => {
    const result = await rbookProjectInit({ projectRoot: root, projectName });
    expect(result.success).toBe(true);
    expect(result.data?.projectName).toBe(projectName);
    expect(readIdentity()).toEqual({
      id: result.data?.projectId,
      name: projectName,
      masterName: projectName,
    });
  }
);

it.each(['', '   ', '\t\n', null])(
  'fills an old unnamed store (%p) without replacing its id or leaving stale context names',
  async (name) => {
    oldUnnamedStore(name);
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      isNewProject: false,
      projectId: 'stable-old-project',
      projectName: 'folder-name',
    });
    expect(readIdentity()).toEqual({
      id: 'stable-old-project',
      name: 'folder-name',
      masterName: 'folder-name',
      identityName: 'folder-name',
    });
  }
);

it.each([undefined, ''])(
  'keeps an existing name and id when re-init receives projectName=%p',
  async (projectName) => {
    const first = await rbookProjectInit({
      projectRoot: root,
      projectName: 'Established name',
      projectId: 'established-id',
    });
    expect(first.success).toBe(true);
    const before = readIdentity();
    const result = await rbookProjectInit({ projectRoot: root, projectName });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      projectId: 'established-id',
      projectName: 'Established name',
    });
    expect(readIdentity()).toEqual(before);
  }
);

it('keeps a same-identity registry name instead of substituting the folder name', async () => {
  oldUnnamedStore('');
  const graph = await ProjectGraphRegistry.create();
  graph.register({
    project_id: 'stable-old-project',
    store_path: root,
    name: 'Registered name',
  });
  const result = await rbookProjectInit({ projectRoot: root });
  expect(result.success).toBe(true);
  expect(readIdentity()).toEqual({
    id: 'stable-old-project',
    name: 'Registered name',
    masterName: 'Registered name',
    identityName: 'Registered name',
  });
});

it('persists the default through the published MCP project init dispatcher', async () => {
  const answer = await executeMissionProtocolTool(
    'rbook_project',
    { action: 'init', projectRoot: root },
    {} as never
  );
  expect(answer.isError).not.toBe(true);
  expect(answer.content.map((part) => ('text' in part ? part.text : '')).join('\n')).toContain(
    'folder-name'
  );
  expect(readIdentity()).toMatchObject({ name: 'folder-name', masterName: 'folder-name' });
});

it.each(['', undefined])(
  'does not implicitly rename a shared copy whose stored name is %p',
  async (name) => {
    expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
    const onboard = await executeMissionProtocolTool(
      'rbook_agent_onboard',
      { projectRoot: root },
      {} as never
    );
    expect(onboard.isError).not.toBe(true);
    const db = new Database(dbPath);
    try {
      if (name === undefined) db.prepare("DELETE FROM metadata WHERE key = 'project_name'").run();
      else db.prepare("UPDATE metadata SET value = ? WHERE key = 'project_name'").run(name);
    } finally {
      db.close();
    }
    await share(root, 0);
    const before = readIdentity();
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(readIdentity()).toEqual(before);
  }
);

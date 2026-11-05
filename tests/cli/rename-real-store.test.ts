// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real-store backups prove rename preserves every identity field outside its named write set.
// ABOUTME: Sources open read-only; the registry, credentials, writes and dashboard all stay in the fixture.

import { afterEach, expect, it } from '@jest/globals';
import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { LEGACY, normalizeAddressScheme } from '../../src/intelligence/legacy-compat';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { __resetDashboardUploadScheduler } from '../../src/tools/rbook/dashboard-upload-scheduler';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { renameFixture, type RenameFixture } from '../helpers/rename-fixture';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'Rename must preserve the real project identity and metadata on a temporary SQLite backup.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

interface Snapshot {
  metadata: Record<string, string>;
  contexts: Record<string, { source_path: string; content: Record<string, unknown> }>;
}

let fixture: RenameFixture | undefined;

afterEach(async () => {
  await __resetDashboardUploadScheduler();
  await fixture?.close();
  fixture = undefined;
});

/** The counting rule is all metadata and the two identity contexts, excluding updated_at. */
function snapshot(f: RenameFixture): Snapshot {
  return f.query((db) => {
    const metadata = Object.fromEntries(
      (
        db.prepare('SELECT key,value FROM metadata ORDER BY key').all() as Array<{
          key: string;
          value: string;
        }>
      ).map(({ key, value }) => [key, value])
    );
    const rows = db
      .prepare(
        "SELECT id,source_path,content FROM contexts WHERE id IN ('project_identity','master_context') ORDER BY id"
      )
      .all() as Array<{ id: string; source_path: string; content: string }>;
    const contexts = Object.fromEntries(
      rows.map((row) => {
        const content = JSON.parse(row.content) as Record<string, unknown>;
        delete content.updated_at;
        return [row.id, { source_path: row.source_path, content }];
      })
    );
    return { metadata, contexts };
  });
}

/** Keep the source's ids and content; only the scratch registry and loopback listing follow it. */
async function copyIntoFixture(sourcePath: string, listedName?: string): Promise<RenameFixture> {
  fixture = await renameFixture();
  const f = fixture;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(f.file + suffix, { force: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(f.file);
  } finally {
    source.close();
  }
  const { metadata } = snapshot(f);
  for (const key of [
    'project_id',
    'project_name',
    'dashboard_project_id',
    'dashboard_slug',
    'owner',
  ])
    expect(metadata[key]).toEqual(expect.any(String));
  f.graph.unregister('rename-local');
  f.graph.register({
    project_id: metadata.project_id,
    name: metadata.project_name,
    store_path: f.root,
  });
  Object.assign(f.remote, {
    id: metadata.dashboard_project_id,
    name: listedName ?? metadata.project_name,
    slug: metadata.dashboard_slug,
    username: metadata.owner,
    localDbPath: f.file,
  });
  RbookDetector.resetInstance();
  return f;
}

PRIVATE.describe('s110-m03 rename on read-only backups of real stores', () => {
  it('changes exactly the named metadata and context fields and preserves every project id', async () => {
    const f = await copyIntoFixture(PRIVATE.paths.liveDb);
    const before = snapshot(f);
    const identity = before.contexts.project_identity.content;
    const oldAddress = normalizeAddressScheme(identity[LEGACY.identityAddressKey] as string);
    const address = `rbook://${before.metadata.owner}/after`;
    expect(oldAddress).not.toBe(address);
    expect(before.metadata.project_name).not.toBe('After');

    const result = await f.run(['--apply']);
    expect(result.code).toBe(0);
    expect(result.result.success).toBe(true);
    expect(result.result.data.message).toContain('upload succeeded');

    const after = snapshot(f);
    const expected = JSON.parse(JSON.stringify(before)) as Snapshot;
    const previous: string[] = before.metadata.previous_rbook_addresses
      ? JSON.parse(before.metadata.previous_rbook_addresses)
      : [];
    expected.metadata = {
      ...before.metadata,
      project_name: 'After',
      dashboard_slug: 'after',
      dashboard_project_name: 'After',
      previous_rbook_addresses: JSON.stringify(
        [...new Set([...previous, oldAddress])].filter((value) => value !== address)
      ),
    };
    expected.contexts.project_identity.content = {
      ...identity,
      project_name: 'After',
      [LEGACY.identityAddressKey]: `${LEGACY.addressScheme}${before.metadata.owner}/after`,
    };
    const master = expected.contexts.master_context.content;
    master.project_identity = {
      ...(master.project_identity as Record<string, unknown>),
      name: 'After',
    };
    expect(after).toEqual(expected);
    expect(after.metadata.project_id).toBe(before.metadata.project_id);
    expect(after.metadata.dashboard_project_id).toBe(before.metadata.dashboard_project_id);
    expect(after.contexts.project_identity.content.project_id).toBe(identity.project_id);
    expect(f.graph.get(before.metadata.project_id)).toMatchObject({
      name: 'After',
      store_path: f.root,
    });
    expect(f.graph.readUploadState(before.metadata.project_id)).toMatchObject({
      lastOutcome: 'success',
      firstOwedAt: null,
    });
    expect(f.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(
      f.requests.filter((request) => request.url === '/api/sync/sqlite-backfill')
    ).toHaveLength(1);
    expect(f.remote.id).toBe(before.metadata.dashboard_project_id);
  });

  it('the first rename creates its metadata keys and dispatcher reads follow the new address and stored slug', async () => {
    const f = await copyIntoFixture(PRIVATE.paths.liveDb);
    f.metadata('dashboard_project_name', null);
    f.metadata('previous_rbook_addresses', null);
    const before = snapshot(f);
    expect(before.metadata.dashboard_project_name).toBeUndefined();
    expect(before.metadata.previous_rbook_addresses).toBeUndefined();
    const oldAddress = normalizeAddressScheme(
      before.contexts.project_identity.content[LEGACY.identityAddressKey] as string
    );
    const address = `rbook://${before.metadata.owner}/after`;
    type Answer = {
      structuredContent: {
        success: boolean;
        error?: { code: string; message: string; suggestion?: string };
      };
    };
    type Call = (request: { params: Record<string, unknown> }) => Promise<Answer>;
    let call: Call | undefined;
    registerToolHandlers(await buildMissionProtocolContext(), {
      setRequestHandler: (method: string, handler: Call) => {
        if (method === 'tools/call') call = handler;
      },
      setNotificationHandler: () => {},
      getClientCapabilities: () => ({}),
      getClientVersion: () => ({ name: 'rename-real-store', version: '1' }),
    } as unknown as Server);
    const invoke = (name: string, projectRoot: string, args: Record<string, unknown> = {}) =>
      call!({ params: { name, arguments: { ...args, projectRoot } } });
    const readers: Array<[string, Record<string, unknown>]> = [
      ['rbook_status', {}],
      ['rbook_agent_onboard', {}],
      ['rbook_db', { action: 'reconcile' }],
      ['rbook_db', { action: 'identify_orphans' }],
      ['rbook_db', { action: 'purge', confirm: true }],
    ];
    const readAt = async (at: string, slug: string) => {
      for (const [tool, args] of readers) {
        const start = f.requests.length;
        const result = await invoke(tool, at, args);
        if (!result.structuredContent.success)
          throw new Error(
            `${tool} ${JSON.stringify(args)}: ${JSON.stringify(result.structuredContent.error)}`
          );
        expect(result.structuredContent).toMatchObject({ success: true });
        const asked = f.requests.slice(start).flatMap((request) => {
          const url = new URL(request.url, f.base);
          if (url.pathname === '/api/sync/status') return [url.searchParams.get('projectSlug')];
          const state = /^\/api\/sync\/projects\/([^/]+)\/state$/.exec(url.pathname);
          if (state) return [decodeURIComponent(state[1])];
          if (url.pathname === '/api/sync/purge')
            return [(JSON.parse(request.body) as { projectSlug: string }).projectSlug];
          return [];
        });
        expect(asked.length).toBeGreaterThan(0);
        expect(new Set(asked)).toEqual(new Set([slug]));
      }
    };
    await readAt(oldAddress, before.metadata.dashboard_slug);
    expect((await f.run(['--apply'])).code).toBe(0);
    const after = snapshot(f);
    expect(after.metadata.dashboard_project_name).toBe('After');
    expect(JSON.parse(after.metadata.previous_rbook_addresses)).toContain(oldAddress);
    const refused = await invoke('rbook_status', oldAddress);
    expect(refused.structuredContent.success).toBe(false);
    expect(refused.structuredContent.error?.code).toBe('PROJECT_ADDRESS_UNRESOLVABLE');
    expect(refused.structuredContent.error?.message).toContain(address);
    await readAt(address, 'after');
  });

  for (const [folder, listedName] of [
    ['cmos-dashboard', 'cmos-dashboard'],
    ['Aquex-mcp', 'Aquex-mcp'],
  ]) {
    const sourcePath = path.resolve(__dirname, '../../..', folder, 'rbook/db/rbook.sqlite');
    const available = fs.existsSync(sourcePath);
    if (!available)
      process.stderr.write(
        `[private fixture] SKIP rename preview for ${folder}: no store at ${sourcePath}.\n`
      );
    (available ? it : it.skip)(
      `${folder}'s different listed name is a warning and its preview writes nothing`,
      async () => {
        const f = await copyIntoFixture(sourcePath, listedName);
        const before = snapshot(f);
        expect(before.metadata.project_name).not.toBe(listedName);
        const registered = f.registry((db) =>
          db.prepare('SELECT * FROM projects ORDER BY project_id').all()
        );
        const result = await f.run();
        expect(result.code).toBe(0);
        expect(result.result.data.dryRun).toBe(true);
        expect(result.result.warnings).toContainEqual(
          expect.stringContaining(
            `The dashboard name is "${listedName}"; the local name is "${before.metadata.project_name}"`
          )
        );
        expect(snapshot(f)).toEqual(before);
        expect(
          f.registry((db) => db.prepare('SELECT * FROM projects ORDER BY project_id').all())
        ).toEqual(registered);
        expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
      }
    );
  }
});

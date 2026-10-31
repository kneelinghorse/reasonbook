// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Populated scratch stores prove the directory boundary without relying on missing data.
// ABOUTME: Startup, Codex telemetry and full-mode controls expose attempted reads and network calls.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { __test__, executeMissionProtocolTool } from '../../../src/index';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { PROPOSALS_TABLE_SQL, insertDraft, rawRunner } from '../../../src/tools/rbook/proposals';
import * as runtime from '../../../src/tools/rbook/draft-runtime';
import * as profile from '../../../src/tools/rbook/operator-profile';
import * as harness from '../../../src/tools/rbook/harness-session';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { withCodexRequest } from '../../../src/codex-request-context';
import { withMcpTelemetry } from '../../../src/tools/rbook/telemetry-call';
import { readTelemetry, targetForStore } from '../../../src/tools/rbook/local-telemetry';
import { currentSessionOwner } from '../../../src/tools/rbook/session-owner';

const sourceRoot = path.resolve(__dirname, '../../..');
let root: string;
let project: string;
let config: string;
let dbPath: string;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  saved = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-directory-runtime-'));
  config = path.join(root, 'config');
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  process.env.RBOOK_EDITION = 'directory';
  process.env.RBOOK_CONFIG_DIR = config;
  process.env.HOME = root;
  expect((await rbookProjectInit({ projectRoot: project })).success).toBe(true);
  dbPath = path.join(project, 'rbook/db/rbook.sqlite');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, 'profile.md'),
    'Synthetic profile never returned by the directory edition.'
  );
  const db = new Database(dbPath);
  db.exec(PROPOSALS_TABLE_SQL);
  insertDraft(rawRunner(db), {
    text: 'Synthetic pending choice',
    kind: 'decision',
    sourceSession: null,
    assistantExcerpt: 'Synthetic conversation excerpt',
    evidence: [],
    outsideContent: 0,
    createdAt: new Date().toISOString(),
  });
  db.close();
});
afterEach(() => {
  jest.restoreAllMocks();
  __test__.resetContextBuilder();
  __test__.resetStartupAttributionSelfTestRunner();
  __test__.resetStartupProjectKeyRecoveryRunner();
  __test__.resetStartupCredentialCheckRunner();
  __test__.resetStartupBundledEnvCheckRunner();
  CredentialStore.resetInstance();
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

it('leaves populated profile and pending-draft readers available only in full mode', async () => {
  const drafts = jest.spyOn(runtime, 'openDraftRuntime');
  const profiles = jest.spyOn(profile, 'readProfile');
  const local = await readDigestV2(project);
  expect(local.profile).toBeNull();
  expect(local.drafts).toEqual([]);
  expect(drafts.mock.calls.length).toBe(0);
  expect(profiles.mock.calls.length).toBe(0);
  delete process.env.RBOOK_EDITION;
  const full = await readDigestV2(project);
  expect(full.profile?.text).toContain('Synthetic profile');
  expect(full.drafts?.map((row) => row.text)).toEqual(['Synthetic pending choice']);
  expect(drafts.mock.calls.length).toBeGreaterThan(0);
  expect(profiles.mock.calls.length).toBeGreaterThan(0);
});

it('avoids both Codex approval-runtime and inherited harness probes, with a full positive control', () => {
  const drafts = jest.spyOn(runtime, 'openDraftRuntime');
  const links = jest.spyOn(harness, 'linkedHarness');
  const meta = {
    'x-codex-turn-metadata': {},
    sessionId: 'synthetic-codex',
    'codex/sandbox-state-meta': { sandboxCwd: 'file://' + project },
  };
  withCodexRequest(meta, () => currentSessionOwner(dbPath));
  currentSessionOwner(dbPath);
  expect(drafts.mock.calls.length).toBe(0);
  expect(links.mock.calls.length).toBe(0);
  delete process.env.RBOOK_EDITION;
  withCodexRequest(meta, () => currentSessionOwner(dbPath));
  expect(drafts.mock.calls.length).toBe(1);
});

it('keeps successful and refused Codex MCP telemetry to permitted fields, never conversation prose', async () => {
  const drafts = jest.spyOn(runtime, 'openDraftRuntime');
  const db = new Database(dbPath);
  const count = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get() as { n: number }).n;
  const before = count();
  const meta = {
    'x-codex-turn-metadata': {},
    sessionId: 'synthetic-codex',
    'codex/sandbox-state-meta': { sandboxCwd: 'file://' + project },
  };
  const canary = 'UNIQUE_DIRECTORY_TELEMETRY_PROSE_CANARY';
  try {
    for (const fromDraft of [undefined, 'P1']) {
      const args = {
        action: 'record',
        content: canary,
        projectRoot: project,
        ...(fromDraft ? { fromDraft } : {}),
      };
      const result = await withCodexRequest(meta, () =>
        withMcpTelemetry(
          { name: 'rbook_decisions', args, mode: 'write', client: 'codex/fixture' },
          () => executeMissionProtocolTool('rbook_decisions', args, {} as never)
        )
      );
      expect(result.isError === true).toBe(Boolean(fromDraft));
    }
    const records = readTelemetry(targetForStore(dbPath)!);
    expect(records.map((row) => row.ok)).toEqual([true, false]);
    const allowed = [
      'ts',
      'session',
      'surface',
      'client',
      'tool',
      'action',
      'mode',
      'ok',
      'refused',
      'failOpen',
      'ambient',
      'idsReturned',
      'idsCited',
      // s106-m01: the lookup's time, and on a refusal a published name or a marker, never text.
      'lookupMs',
      'refusedField',
    ];
    for (const record of records)
      expect(Object.keys(record).filter((key) => !allowed.includes(key))).toEqual([]);
    // The directory edition's refusal of fromDraft names no field.
    expect(records.map((row) => row.refusedField)).toEqual([null, 'unspecified']);
    expect(JSON.stringify(records)).not.toContain(canary);
    expect(JSON.stringify(records)).not.toContain('Synthetic conversation');
    expect(count()).toBe(before);
    expect(drafts.mock.calls.length).toBe(0);
  } finally {
    db.close();
  }
});

it('skips startup key recovery and credential checks with saved/environment keys and a missing project key', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(500);
    res.end('must not be reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const now = new Date().toISOString();
  const store = await CredentialStore.create({ configDir: config });
  await store.upsertUserScopedKey('synthetic-key', {
    key: 'synthetic-saved-key',
    label: 'fixture',
    issuedAt: now,
    lastUsedAt: now,
  });
  expect(await store.getProjectKey(project)).toBeUndefined();
  process.env.RBOOK_DASHBOARD_API_KEY = 'synthetic-environment-key';
  process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentials = jest.spyOn(CredentialStore, 'create');
  const recovery = jest.fn(async () => {
    throw new Error('forbidden recovery');
  });
  const check = jest.fn(async () => {
    throw new Error('forbidden credential check');
  });
  const bundled = jest.fn(() => {
    throw new Error('forbidden dotenv probe');
  });
  __test__.setContextBuilder(
    async () =>
      ({ defaultModel: 'claude', rbookDetected: true, rbookDatabasePath: dbPath }) as never
  );
  __test__.setStartupAttributionSelfTestRunner(
    async () => ({ projectRoot: project, source: 'explicit' }) as never
  );
  __test__.setStartupProjectKeyRecoveryRunner(recovery);
  __test__.setStartupCredentialCheckRunner(check);
  __test__.setStartupBundledEnvCheckRunner(bundled);
  try {
    await __test__.initializeServer();
    for (const name of ['rbook_status', 'rbook_review', 'rbook_agent_onboard']) {
      const result = await executeMissionProtocolTool(name, { projectRoot: project }, {} as never);
      expect(result.isError).not.toBe(true);
    }
    expect(
      recovery.mock.calls.length +
        check.mock.calls.length +
        bundled.mock.calls.length +
        credentials.mock.calls.length
    ).toBe(0);
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['directory', 'typo', 'full'])(
  'selects %s before dotenv; dotenv cannot change the launch mode',
  (mode) => {
    const dotenv = path.join(project, '.env');
    fs.writeFileSync(dotenv, 'RBOOK_EDITION=directory\nDIRECTORY_FIXTURE_SETTING=loaded\n');
    const code = `const fs=require('fs');let reads=0;const original=fs.readFileSync;fs.readFileSync=function(file,...rest){if(String(file)===${JSON.stringify(dotenv)})reads++;return original.call(this,file,...rest)};try{require(${JSON.stringify(path.join(sourceRoot, 'src/index.ts'))});console.log(JSON.stringify({reads,mode:process.env.RBOOK_EDITION,setting:process.env.DIRECTORY_FIXTURE_SETTING??null}));}catch(error){console.log(JSON.stringify({reads,error:error.message}));process.exitCode=1;}`;
    const child = spawnSync(
      process.execPath,
      ['-r', path.join(sourceRoot, 'tests/helpers/ts-register.js'), '-e', code],
      {
        cwd: sourceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          RBOOK_CONFIG_DIR: config,
          RBOOK_PROJECT_ROOT: project,
          RBOOK_EDITION: mode,
          RBOOK_CHECKPOINT_SYNC: 'off',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    const result = JSON.parse(child.stdout.trim());
    if (mode === 'typo') {
      expect(child.status).toBe(1);
      expect(result).toMatchObject({ reads: 0, error: expect.stringContaining('RBOOK_EDITION') });
    } else {
      expect(child.status).toBe(0);
      expect(result).toEqual({
        reads: mode === 'full' ? 1 : 0,
        mode,
        setting: mode === 'full' ? 'loaded' : null,
      });
    }
  }
);

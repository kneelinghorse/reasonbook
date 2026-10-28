// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises retained local workflows against real stores while forbidden transports are armed.
// ABOUTME: Proves background jobs do not even schedule and model caches cannot override directory mode.
import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import { executeMissionProtocolTool } from '../../../src/index';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { TokenCounter } from '../../../src/intelligence/token-counters';
import {
  __test__ as tokenizer,
  getClaudeTokenizerInstance,
} from '../../../src/intelligence/tokenizer-bootstrap';
import { sshPeer } from '../../../src/tools/rbook/record-ssh';
import { launchSync } from '../../../src/tools/rbook/record-sync-trigger';
import {
  observeDashboardUploadProject,
  markDashboardUploadOwed,
  __resetDashboardUploadScheduler,
} from '../../../src/tools/rbook/dashboard-upload-scheduler';
import {
  triggerCheckpointBackfill,
  whyCloseUploadsNothing,
} from '../../../src/tools/rbook/checkpoint-backfill';

let root: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-directory-ops-'));
  process.env.RBOOK_EDITION = 'directory';
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  process.env.HOME = root;
});
afterEach(async () => {
  jest.restoreAllMocks();
  tokenizer.reset();
  (TokenCounter as unknown as { claudeTokenizerCache: unknown }).claudeTokenizerCache = null;
  await __resetDashboardUploadScheduler();
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}, projectRoot = root) {
  const result = await executeMissionProtocolTool(name, { ...args, projectRoot }, {} as never);
  const body = result.structuredContent as {
    success: boolean;
    data: Record<string, any>;
    error?: unknown;
  };
  expect(body).toMatchObject({ success: true });
  return body.data;
}

it('keeps local lifecycle, recall, registry, backup and restore useful without network or memory rules', async () => {
  const credentials = jest.spyOn(CredentialStore, 'create');
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('directory network attempt'));
  await call('rbook_project', { action: 'init', projectName: 'Directory fixture' });
  await call('rbook_project', { action: 'register', name: 'Directory fixture' });
  await call('rbook_project', { action: 'list' });
  await call('rbook_project', { action: 'validate' });
  await call('rbook_sprint', { action: 'add', sprintId: 'local-sprint', title: 'Local work' });
  await call('rbook_mission', {
    action: 'add',
    missionId: 'local-task',
    sprintId: 'local-sprint',
    name: 'Keep a local record',
    status: 'Current',
  });
  await call('rbook_mission_transition', { action: 'start', missionId: 'local-task' });
  await call('rbook_decisions', {
    action: 'record',
    content: 'Use a paper catalog for offline reading.',
    missionId: 'local-task',
  });
  const found = await call('rbook_decisions', { action: 'search', query: 'paper catalog' });
  expect(JSON.stringify(found)).toContain('paper catalog');
  await call('rbook_session', {
    action: 'capture',
    category: 'next-step',
    content: 'Catalog the first book.',
    missionId: 'local-task',
  });
  await call('rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    missionId: 'local-task',
  });
  await call('rbook_context', { action: 'next_steps', nextStepAction: 'list' });
  await call('rbook_session', {
    action: 'capture',
    category: 'learning',
    content: 'Local records remain useful offline.',
  });
  await call('rbook_learnings', { action: 'list' });
  await call('rbook_mission_transition', {
    action: 'complete',
    missionId: 'local-task',
    notes: 'Local evidence checked.',
  });
  await call('rbook_db', { action: 'health' });
  const snapshot = await call('rbook_db', { action: 'snapshot' });
  expect(snapshot.createdSnapshot?.id).toEqual(expect.any(String));
  await call('rbook_db', { action: 'snapshot', listOnly: true });
  await call('rbook_db', { action: 'prune_snapshots' });
  await call('rbook_db', {
    action: 'restore',
    snapshotId: snapshot.createdSnapshot.id,
    confirm: true,
  });
  expect(credentials.mock.calls.length).toBe(0);
  expect(fetch.mock.calls.length).toBe(0);
  expect(fs.readdirSync(path.join(root, 'rbook'))).toEqual(['db']);
});

it('does not start a timer, inspect credentials or launch an SSH/sync child despite enabled switches', async () => {
  process.env.RBOOK_CHECKPOINT_SYNC = 'on';
  process.env.RBOOK_SHARED_SYNC = 'on';
  process.env.RBOOK_DASHBOARD_API_KEY = 'synthetic-enabled-key';
  const credentials = jest.spyOn(CredentialStore, 'create');
  const interval = jest.spyOn(globalThis, 'setInterval');
  const spawn = jest.spyOn(childProcess, 'spawn');
  await observeDashboardUploadProject(root);
  await markDashboardUploadOwed(root);
  await triggerCheckpointBackfill({ projectRoot: root, force: true });
  expect(await whyCloseUploadsNothing()).toBe('off');
  expect(launchSync(root)).toBe(false);
  await expect(sshPeer({} as never)).rejects.toThrow(/full plugin/);
  expect(credentials.mock.calls.length + interval.mock.calls.length + spawn.mock.calls.length).toBe(
    0
  );
});

it('skips loading and using a cached tokenizer, while the full-mode control still uses it', async () => {
  const encode = jest.fn(async () => ({ input_ids: { data: { length: 777 } } }));
  const loader = jest.fn(async () => ({ AutoTokenizer: { from_pretrained: async () => encode } }));
  tokenizer.setModuleLoaders({ claude: loader });
  expect(await getClaudeTokenizerInstance()).toBeNull();
  expect(loader).not.toHaveBeenCalled();
  process.env.RBOOK_EDITION = 'full';
  expect((await new TokenCounter().count('The saved project record', 'claude')).count).toBe(777);
  expect(encode).toHaveBeenCalledTimes(1);
  process.env.RBOOK_EDITION = 'directory';
  expect(await getClaudeTokenizerInstance()).toBeNull();
  expect((await new TokenCounter().count('The saved project record', 'claude')).count).not.toBe(
    777
  );
  expect(encode).toHaveBeenCalledTimes(1);
});

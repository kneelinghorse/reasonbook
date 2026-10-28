// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves useful local reads and writes without consulting conversation or credential stores.
// ABOUTME: Records attempted forbidden accesses even when production code catches their exceptions.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookProject } from '../../../src/tools/rbook/rbook-project';
import { rbookStatus, formatStatusForLLM } from '../../../src/tools/rbook/rbook-status';
import { rbookReviewPresentation } from '../../../src/tools/rbook/review-presentation';
import { rbookDecisionsRecord } from '../../../src/tools/rbook/rbook-decisions-record';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import * as runtime from '../../../src/tools/rbook/draft-runtime';
import * as profile from '../../../src/tools/rbook/operator-profile';
import { currentSessionOwner } from '../../../src/tools/rbook/session-owner';
import { withCodexRequest } from '../../../src/codex-request-context';
import { sharedSyncEnabled } from '../../../src/tools/rbook/record-sync-trigger';
import { getEmbedder, setEmbedderForTesting } from '../../../src/intelligence/embedding-pipeline';
import { runCli } from '../../../src/cli';
import { userAuthorForWrite } from '../../../src/tools/rbook/author-name';
import { writeUserAuthor } from '../../../src/intelligence/user-author';

describe('directory local data', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-directory-data-'));
    process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
    process.env.RBOOK_EDITION = 'directory';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    setEmbedderForTesting(null);
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function memoryFence(): string[] {
    const attempted: string[] = [];
    for (const method of [
      'readFileSync',
      'existsSync',
      'statSync',
      'lstatSync',
      'readdirSync',
      'openSync',
      'accessSync',
    ] as const) {
      const original = fs[method];
      // Node's overloaded filesystem signatures differ; the wrapper preserves its original call.
      jest.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        const file = String(args[0]);
        if (/(?:^|[\\/])(?:agents\.md|claude\.md|\.claude)(?:$|[\\/])/i.test(file)) {
          attempted.push(file);
          throw new Error('Forbidden memory access');
        }
        return Reflect.apply(original, fs, args);
      }) as never);
    }
    return attempted;
  }

  it('initializes and changes level using the store alone without even probing memory files', async () => {
    const attempted = memoryFence();
    const init = await rbookProjectInit({ projectRoot: root, projectName: 'Directory fixture' });
    expect(init.success).toBe(true);
    const update = await rbookProject({
      action: 'update',
      projectRoot: root,
      projectType: 'build',
    });
    expect(update.success).toBe(true);
    expect(attempted).toEqual([]);
    jest.restoreAllMocks();
    expect(fs.readdirSync(path.join(root, 'rbook'))).toEqual(['db']);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('returns local status and a populated review without credentials, profile or draft runtime access', async () => {
    expect(
      (await rbookProjectInit({ projectRoot: root, projectName: 'Directory fixture' })).success
    ).toBe(true);
    const credentials = jest.spyOn(CredentialStore, 'create');
    const drafts = jest.spyOn(runtime, 'openDraftRuntime');
    const profiles = jest.spyOn(profile, 'readProfile');
    const status = await rbookStatus({ projectRoot: root });
    expect(status.success).toBe(true);
    expect(status.data).toMatchObject({ edition: 'directory', local_health: 'ok' });
    for (const key of ['dashboard_url', 'auth_tier', 'shared_sync', 'last_synced_at'])
      expect(status.data).not.toHaveProperty(key);
    expect(formatStatusForLLM(status)).toContain('directory');
    const review = await rbookReviewPresentation({ projectRoot: root });
    expect(review.result.success).toBe(true);
    expect(review.text).toContain('Directory fixture');
    expect(review.result.data?.portfolio).toBeNull();
    expect(credentials.mock.calls.length).toBe(0);
    expect(drafts.mock.calls.length).toBe(0);
    expect(profiles.mock.calls.length).toBe(0);
  });

  it('records a requested decision without trying to settle or answer any draft', async () => {
    expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
    const drafts = jest.spyOn(runtime, 'openDraftRuntime');
    const recorded = await rbookDecisionsRecord({
      projectRoot: root,
      content: 'Keep the project local.',
      context: 'The user requested this decision.',
    });
    expect(recorded.success).toBe(true);
    expect(recorded.data?.decisionId).toBeGreaterThan(0);
    expect((recorded.warnings ?? []).filter((warning) => /embedding|model/i.test(warning))).toEqual(
      []
    );
    expect(drafts.mock.calls.length).toBe(0);
  });

  it('never consults dashboard credentials for init, writes or config author, preserving the local name', async () => {
    writeUserAuthor('Local author');
    const attempted: string[] = [];
    const read = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (/(credentials|dashboard-identity)\.json$/.test(String(file))) {
        attempted.push(String(file));
        return String(file).endsWith('/credentials.json')
          ? JSON.stringify({ projectKeys: { [root]: { key: 'synthetic-key' } } })
          : '{}';
      }
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof read);
    expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
    expect(
      (await rbookDecisionsRecord({ projectRoot: root, content: 'User requested this.' })).success
    ).toBe(true);
    const output: string[] = [];
    expect(
      await runCli(['config', 'author'], {
        env: process.env,
        cwd: root,
        readStdin: async () => '',
        stdout: (line) => output.push(line),
        stderr: jest.fn(),
      })
    ).toBe(0);
    expect(output.join('')).toContain('Records written here carry the author Local author');
    expect(userAuthorForWrite(root)).toEqual({
      name: 'Local author',
      userId: null,
      source: 'user',
    });
    expect(attempted).toEqual([]);
    process.env.RBOOK_EDITION = 'full';
    userAuthorForWrite(root);
    expect(attempted).toEqual([
      path.join(root, 'config/credentials.json'),
      path.join(root, 'config/dashboard-identity.json'),
    ]);
  });

  it('uses a process owner under Codex without opening the approval runtime', async () => {
    expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
    const drafts = jest.spyOn(runtime, 'openDraftRuntime');
    withCodexRequest(
      {
        'x-codex-turn-metadata': {},
        sessionId: 'synthetic-codex',
        'codex/sandbox-state-meta': { sandboxCwd: 'file://' + root },
      },
      () => {
        expect(currentSessionOwner(path.join(root, 'rbook/db/rbook.sqlite')).kind).toBe('process');
      }
    );
    expect(drafts.mock.calls.length).toBe(0);
  });

  it('never enables background shared sync even when the ordinary switch is on', () => {
    process.env.RBOOK_SHARED_SYNC = 'on';
    expect(sharedSyncEnabled()).toBe(false);
  });

  it('disables semantic loading before an injected or cached embedder can run', async () => {
    const embed = jest.fn(async () => new Float32Array(384));
    setEmbedderForTesting(embed);
    await expect(getEmbedder()).rejects.toThrow(/directory edition/);
    expect(embed).not.toHaveBeenCalled();
  });
});

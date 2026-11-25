// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves Codex approval binding against a temporary backup of a real project store.
// ABOUTME: The explicit source is opened read-only; every hook, record and registry write uses the copy.

import { resolveRecordPaths } from '../../src/intelligence/legacy-compat';
import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runCli } from '../../src/cli';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore } from '../helpers/seedRbookDb';

it('a real-store copy binds the hook approval to the Codex request once', async () => {
  const sourceRoot = process.env.RBOOK_CODEX_REAL_STORE_ROOT;
  if (!sourceRoot) throw new Error('Set RBOOK_CODEX_REAL_STORE_ROOT to an existing real project.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-codex-real-'));
  const root = path.join(temp, 'copy');
  const destination = path.join(root, 'rbook/db/rbook.sqlite');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const source = new Database(resolveRecordPaths(sourceRoot).dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(
      (source.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n
    ).toBeGreaterThan(0);
    await source.backup(destination);
  } finally {
    source.close();
  }
  const prior = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  try {
    reidentifyRbookTestStore(root, `codex-fire-${path.basename(temp)}`);
    const copy = new Database(destination);
    copy.prepare("UPDATE sessions SET status = 'completed' WHERE status = 'active'").run();
    copy.close();
    const session = 'codex-real-store-fire';
    const content = `Keep Codex approval evidence in its enclosing store for fire ${path.basename(temp)}.`;
    const hook = async (event: string, fields: Record<string, unknown>) => {
      await runCli(['hook', event, '--harness', 'codex'], {
        env: { ...process.env },
        cwd: root,
        readStdin: async () => JSON.stringify({ session_id: session, cwd: root, ...fields }),
        stdout: () => {},
        stderr: () => {},
      });
      setExternalSessionOwner(null);
    };
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: `Would record: ${content}` });
    await hook('prompt', { prompt: `I approve this decision: ${content}` });
    const read = new Database(destination, { readonly: true });
    let draft: number;
    try {
      draft = (
        read.prepare('SELECT id FROM proposals WHERE text = ?').get(content) as { id: number }
      ).id;
    } finally {
      read.close();
    }
    type Result = { isError?: boolean; structuredContent: { success: boolean; data?: unknown } };
    type Call = (request: { params: Record<string, unknown> }) => Promise<Result>;
    let call: Call | undefined;
    registerToolHandlers(await buildMissionProtocolContext(), {
      setRequestHandler: (method: string, handler: Call) => {
        if (method === 'tools/call') call = handler;
      },
      setNotificationHandler: () => {},
      getClientCapabilities: () => ({}),
    } as unknown as Server);
    const request = {
      params: {
        name: 'rbook_decisions',
        arguments: { action: 'record', content, fromDraft: `P${draft}` },
        _meta: {
          'x-codex-turn-metadata': {},
          sessionId: session,
          'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(root).href },
        },
      },
    };
    expect((await call!(request)).structuredContent.success).toBe(true);
    expect((await call!(request)).isError).toBe(true);
    const verified = new Database(destination, { readonly: true });
    try {
      expect(
        verified
          .prepare(
            'SELECT approval_mode, approval_words FROM strategic_decisions WHERE decision_text = ?'
          )
          .all(content)
      ).toEqual([
        { approval_mode: 'approved', approval_words: `I approve this decision: ${content}` },
      ]);
    } finally {
      verified.close();
    }
  } finally {
    setExternalSessionOwner(null);
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    for (const [key, value] of [
      ['RBOOK_CONFIG_DIR', prior.config],
      ['RBOOK_CHECKPOINT_SYNC', prior.sync],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

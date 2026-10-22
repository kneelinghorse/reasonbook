// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves a draft fires from Stop through approval and MCP recording on a copy of the live store.
// ABOUTME: Private evidence is declared explicitly; all hook, runtime and record writes stay in a temporary project.

import { afterEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The proposal positive-fire test needs a temporary SQLite backup of the live project store.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

PRIVATE.describe('draft approval on a copy of the live store', () => {
  let tmp: string | undefined;
  const savedConfig = process.env.RBOOK_CONFIG_DIR;
  const savedSession = process.env.CLAUDE_CODE_SESSION_ID;

  afterEach(() => {
    setExternalSessionOwner(null);
    if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = savedConfig;
    if (savedSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSession;
    RbookDetector.resetInstance();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Stop creates a pending draft; the operator approves it; the dispatched record carries those words', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-draft-live-copy-'));
    const projectRoot = path.join(tmp, 'project');
    const dbPath = path.join(projectRoot, 'rbook/db/rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const live = new Database(PRIVATE.paths.liveDb, { readonly: true });
    try {
      await live.backup(dbPath);
    } finally {
      live.close();
    }
    process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    reidentifyRbookTestStore(projectRoot);
    RbookDetector.resetInstance();
    const session = 'draft-real-store-positive-fire';
    const content = `Keep the proposal approval probe in its temporary project ${path.basename(tmp)} because the live store must stay unchanged.`;
    const hook = async (event: string, fields: Record<string, unknown>): Promise<string> => {
      let stdout = '';
      let stderr = '';
      const code = await runCli(['hook', event], {
        env: { ...process.env, CLAUDE_PID: String(process.pid) },
        cwd: projectRoot,
        // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
        startedAtMs: Date.now() + 20_000,
        readStdin: async () => JSON.stringify({ session_id: session, cwd: projectRoot, ...fields }),
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      setExternalSessionOwner(null);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return stdout;
    };
    await hook('session-start', { source: 'startup' });
    expect(await hook('stop', { last_assistant_message: `Would record: ${content}` })).toBe('');
    const read = new Database(dbPath, { readonly: true });
    try {
      const draft = read
        .prepare('SELECT id, outcome FROM proposals WHERE text = ?')
        .get(content) as { id: number; outcome: string };
      expect(draft.outcome).toBe('pending');
      const fromDraft = `P${draft.id}`;
      expect(await hook('prompt', { prompt: 'approved', prompt_id: 'approval-turn' })).toContain(
        fromDraft
      );
      const context = await buildMissionProtocolContext();
      setExternalSessionOwner(session);
      const answer = await executeMissionProtocolTool(
        'rbook_decisions',
        {
          action: 'record',
          projectRoot,
          content,
          fromDraft,
        },
        context
      );
      const result = answer.structuredContent as {
        success: boolean;
        data?: { decisionId: number };
      };
      expect(result.success).toBe(true);
      expect(
        read
          .prepare(
            'SELECT decision_text, approval_mode, approval_draft, approval_words FROM strategic_decisions WHERE id = ?'
          )
          .get(result.data!.decisionId)
      ).toEqual({
        decision_text: content,
        approval_mode: 'approved',
        approval_draft: fromDraft,
        approval_words: 'approved',
      });
      expect(
        read
          .prepare('SELECT outcome, record_id, approval_mode FROM proposals WHERE id = ?')
          .get(draft.id)
      ).toEqual({
        outcome: 'approved',
        record_id: `d:${result.data!.decisionId}`,
        approval_mode: 'approved',
      });
    } finally {
      read.close();
    }
  });
});

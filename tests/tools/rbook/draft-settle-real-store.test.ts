// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the settle's positive fire on a copy of this project's store: P81 by #1802 settles, P78 by #1801
// ABOUTME: settles with a note, and an older decision below 0.85 is refused. Every write stays in a temporary project.

import { afterEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import { onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { openDraftRuntime } from '../../../src/tools/rbook/draft-runtime';
import { readUnkept } from '../../../src/tools/rbook/draft-runtime-unkept';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The settle positive-fire test needs a temporary SQLite backup of the live project store, whose drafts P78 and P81 it settles.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

PRIVATE.describe('settling drafts on a copy of the live store (#1810)', () => {
  let tmp: string | undefined;
  const savedConfig = process.env.RBOOK_CONFIG_DIR;

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = savedConfig;
    RbookDetector.resetInstance();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('settles P81 by #1802 and P78 by #1801 with a note, and refuses an older decision below 0.85', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-settle-live-copy-'));
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
    reidentifyRbookTestStore(projectRoot);
    RbookDetector.resetInstance();
    const read = <T>(sql: string, ...params: unknown[]): T => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.prepare(sql).get(...params) as T;
      } finally {
        db.close();
      }
    };
    const draft = (id: number) =>
      read<{ outcome: string; record_id: string | null; approval_mode: string | null }>(
        'SELECT outcome, record_id, approval_mode FROM proposals WHERE id = ?',
        id
      );
    expect([draft(78).outcome, draft(81).outcome]).toEqual(['pending', 'pending']);
    // P78 and P81 expire seven days after they were drafted: a day after, they are live on any run date.
    const created = read<{ at: string }>('SELECT created_at AS at FROM proposals WHERE id = 81').at;
    const now = Date.parse(created) + 86_400_000;
    const stop = (reply: string) =>
      onStop({
        dbPath,
        rawSessionId: 'settle-live-copy',
        reply,
        env: process.env,
        deadlineAtMs: Date.now() + 20_000,
        now,
      });
    const unkept = () => {
      const runtime = openDraftRuntime(dbPath, process.env)!;
      try {
        return readUnkept(runtime, harnessSessionHash('settle-live-copy'), now).entries;
      } finally {
        runtime.close();
      }
    };

    // #1780 was recorded before P81 and does not hold 0.85 of its subject.
    stop('The reopen-marker fix is recorded.\n\nSettled: P81 by decision 1780');
    expect(draft(81).outcome).toBe('pending');
    expect(unkept()).toEqual([
      expect.objectContaining({
        text: 'Settled: P81 by decision 1780',
        reason: 'coverage',
        detail: expect.stringMatching(/^\d+%, recorded before the draft$/),
      }),
    ]);

    stop(
      'Both s108 closes are recorded.\n\nSettled: P81 by decision 1802\nSettled: P78 by decision 1801'
    );
    expect(draft(81)).toEqual({
      outcome: 'answered',
      record_id: 'd:1802',
      approval_mode: 'settled',
    });
    expect(draft(78)).toEqual({
      outcome: 'answered',
      record_id: 'd:1801',
      approval_mode: 'settled',
    });
    expect(unkept()).toEqual([
      expect.objectContaining({ text: 'Settled: P78 by decision 1801', reason: 'low-coverage' }),
    ]);

    // The operator's next "yes" binds nothing to either, the list says how each ended, and a
    // fromDraft record of P81 is refused with the decision that answered it.
    const offer = prepareOffer({
      dbPath,
      rawSessionId: 'settle-live-copy',
      message: 'yes',
      env: process.env,
      deadlineAtMs: Date.now() + 20_000,
      now,
    });
    expect(offer.text).not.toMatch(/approval of P(?:78|81)\b|draft P(?:78|81) \(decision\)/);
    let listed = '';
    await runCli(['drafts', 'list', '--all'], {
      env: { ...process.env },
      cwd: projectRoot,
      readStdin: async () => '',
      stdout: (text) => {
        listed += text;
      },
      stderr: () => {},
    });
    expect(listed).toContain('answered as d:1802 (settled)');
    expect(listed).toContain('answered as d:1801 (settled)');
    setExternalSessionOwner('settle-live-copy');
    try {
      const again = await rbookDecisions({ action: 'record', fromDraft: 'P81', projectRoot });
      expect(again.error?.code).toBe('DRAFT_NOT_PENDING');
      expect(`${again.error?.message} ${again.error?.suggestion}`).toContain('d:1802');
    } finally {
      setExternalSessionOwner(null);
    }
  });
});

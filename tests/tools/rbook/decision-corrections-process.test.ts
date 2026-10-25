// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Independent correction writers serialize their lookup and preserve established history.
// ABOUTME: Child processes load source directly and share a real SQLite store without touching dist.

import { spawn } from 'child_process';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import type { RbookDecisionsRecordResult } from '../../../src/tools/rbook/rbook-decisions-record';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { crossRecordFindings } from '../../../src/tools/rbook/record-checks';
import { isRecordedStore } from '../../../src/tools/rbook/record-guards';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { __resetSharedSyncScheduler } from '../../../src/tools/rbook/record-sync-scheduler';

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s102-correction-process-');
  // Both processes share the keyless explicit author's dedup scope, as pre-harness callers do.
  const started = await rbookSession({
    action: 'start',
    type: 'custom',
    title: 'Concurrent correction',
    projectRoot: project.projectRoot,
  });
  expect(started.success).toBe(true);
});
afterEach(async () => {
  __resetSharedSyncScheduler();
  await project.cleanup();
});

async function record(content: string): Promise<number> {
  const result = await rbookDecisions({
    action: 'record',
    content,
    projectRoot: project.projectRoot,
  });
  expect(result.success).toBe(true);
  return (result.data as RbookDecisionsRecordResult).decisionId;
}

async function contend(
  calls: Record<string, unknown>[]
): Promise<RbookToolResult<RbookDecisionsRecordResult>[]> {
  const source = String.raw`
const fs = require('fs'), ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const deny = require(process.argv[3]);
deny.installNetworkDeny();
const { rbookDecisions } = require(process.argv[1]);
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const result = await rbookDecisions(JSON.parse(process.argv[2]));
    const blocked = deny.takeBlockedAttempts();
    if (blocked.length) throw Error('Child attempted outbound network: ' + JSON.stringify(blocked));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: project.projectRoot };
  delete env.RBOOK_CHECKPOINT_SYNC;
  const children = calls.map((call) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        source,
        path.resolve('src/tools/rbook/rbook-decisions.ts'),
        JSON.stringify({ action: 'record', projectRoot: project.projectRoot, ...call }),
        path.resolve('tests/helpers/network-deny.ts'),
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('ready\n')) resolve();
      });
      child.once('error', reject);
      child.once('close', (code) =>
        reject(new Error(`Child exited ${code} before ready: ${stderr}`))
      );
    });
    const done = new Promise<RbookToolResult<RbookDecisionsRecordResult>>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error(`Correction child failed (${code}): ${stderr}`));
        try {
          resolve(JSON.parse(stdout.trim().split('\n').slice(-1)[0]));
        } catch (error) {
          reject(error);
        }
      });
    });
    return { child, ready, done };
  });
  // Attach handlers before waiting for startup, so a startup failure cannot leak a rejection.
  const results = Promise.all(children.map((child) => child.done));
  void results.catch(() => undefined);
  try {
    await Promise.all(children.map((child) => child.ready));
    children.forEach((child) => child.child.stdin.end('go'));
    return await results;
  } finally {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map((child) => child.done));
  }
}

it('allows one concurrent correction of a target and refuses to redirect its winning successor', async () => {
  const target = await record('Original choice');
  const results = await contend([
    { content: 'First correction', supersedes: [target] },
    { content: 'Second correction', supersedes: [target] },
  ]);
  expect(results.filter((result) => result.success)).toHaveLength(1);
  const winner = results.find((result) => result.success)!.data!.decisionId;
  expect(results.find((result) => !result.success)).toMatchObject({
    error: { code: 'INVALID_PARAMETER', currentState: { supersededBy: winner } },
  });
  const db = new Database(project.dbPath, { readonly: true });
  try {
    expect(
      db.prepare('SELECT superseded_by FROM strategic_decisions WHERE id=?').get(target)
    ).toEqual({ superseded_by: winner });
    expect(db.prepare('SELECT count(*) AS n FROM strategic_decisions').get()).toEqual({ n: 2 });
  } finally {
    db.close();
  }
});

it.each([false, true])(
  'serializes opposite reverts into fresh acyclic history (reverse launch order=%s)',
  async (reverse) => {
    // The plan's record-checks oracle is active only on a shared record. Share the real store
    // before the race rather than accepting its vacuous [] result on an unshared fixture.
    writeUserAuthor('Correction tester');
    const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
    expect(opened.success).toBe(true);
    const client = opened.data!;
    try {
      expect(prepareForSharing(client).ready).toBe(true);
      shareRecord(client);
      expect(isRecordedStore(client)).toBe(true);
    } finally {
      client.close();
    }

    const priorE = await record('Earlier E');
    const priorX = await record('Earlier X');
    const eResult = await rbookDecisions({
      action: 'record',
      content: 'E',
      supersedes: [priorE],
      projectRoot: project.projectRoot,
    });
    const xResult = await rbookDecisions({
      action: 'record',
      content: 'X',
      supersedes: [priorX],
      projectRoot: project.projectRoot,
    });
    expect(eResult.success).toBe(true);
    expect(xResult.success).toBe(true);
    const e = (eResult.data as RbookDecisionsRecordResult).decisionId;
    const x = (xResult.data as RbookDecisionsRecordResult).decisionId;
    const calls = [
      { content: 'E', supersedes: [x] },
      { content: 'X', supersedes: [e] },
    ];
    if (reverse) calls.reverse();

    // contend starts independent processes, waits until BOTH signal ready, then releases them.
    // Either may take SQLite's write lock first; the later call must create a new occurrence.
    const results = await contend(calls);
    expect(results.every((result) => result.success)).toBe(true);
    const existing = results.filter((result) => result.data?.materialization === 'existing');
    const inserted = results.filter((result) => result.data?.materialization === 'materialized');
    expect(existing).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    const middle = existing[0].data!.decisionId;
    const last = inserted[0].data!.decisionId;
    expect([e, x]).toContain(middle);
    expect([e, x, priorE, priorX]).not.toContain(last);
    const first = middle === e ? x : e;
    expect(existing[0].data!.superseded).toEqual([
      { id: first, previousStatus: 'active', newStatus: 'superseded' },
    ]);
    expect(inserted[0].data!.superseded).toEqual([
      { id: middle, previousStatus: 'active', newStatus: 'superseded' },
    ]);

    const read = new Database(project.dbPath, { readonly: true });
    try {
      const before = read.prepare('SELECT * FROM strategic_decisions ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      expect(before).toHaveLength(5);
      // Whichever order committed, the result is X→E→newX or E→X→newE. Neither existing
      // occurrence is resurrected, and both links from earlier history keep their exact targets.
      expect(before).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: priorE, superseded_by: e }),
          expect.objectContaining({ id: priorX, superseded_by: x }),
          expect.objectContaining({ id: first, status: 'superseded', superseded_by: middle }),
          expect.objectContaining({ id: middle, status: 'superseded', superseded_by: last }),
          expect.objectContaining({
            id: last,
            decision_text: middle === e ? 'X' : 'E',
            status: 'active',
            superseded_by: null,
          }),
        ])
      );

      const retry = await contend(calls);
      expect(retry.every((result) => result.success)).toBe(true);
      expect(retry.map((result) => result.data!.decisionId)).toEqual(
        results.map((result) => result.data!.decisionId)
      );
      expect(retry.map((result) => result.data!.superseded)).toEqual([[], []]);
      expect(read.prepare('SELECT * FROM strategic_decisions ORDER BY id').all()).toEqual(before);
    } finally {
      read.close();
    }
    const checked = await RbookDatabaseClient.create({ dbPath: project.dbPath });
    expect(checked.success).toBe(true);
    try {
      expect(isRecordedStore(checked.data!)).toBe(true);
      expect(
        crossRecordFindings(checked.data!).filter(
          (finding) => finding.check === 'supersession_cycle'
        )
      ).toEqual([]);
    } finally {
      checked.data!.close();
    }
  }
);

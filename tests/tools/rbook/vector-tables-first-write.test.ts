// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m11 (#642) — a new store's first embedded record writes its vector without a warning.
// ABOUTME: The vector tables used to appear only at a store's first search, after the first write.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import {
  recordEmbedding,
  setEmbedderForTesting,
} from '../../../src/intelligence/embedding-pipeline';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { loadVecExtension } from '../../../src/tools/rbook/vec-loader';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store fire replays this repository's store from before it had vector tables, from its git history; the public mirror carries neither.",
  revisions: { preVector: '509ddcf' },
});
const REPO = path.resolve(__dirname, '..', '..', '..');

let projectRoot: string;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-vec-first-'));
  // Present, as when the optional package is installed, but offline and deterministic.
  setEmbedderForTesting(async () => new Float32Array(384).fill(0.01));
});
afterEach(() => {
  setEmbedderForTesting(null);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** The decision's stored vector and hash, read with the vector extension loaded. */
function embedded(
  id: number,
  dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite')
): { vectors: number; hash: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    loadVecExtension(db);
    const { vectors } = db
      .prepare('SELECT count(*) AS vectors FROM decisions_vec WHERE decision_id = ?')
      .get(BigInt(id)) as { vectors: number };
    const { hash } = db
      .prepare('SELECT last_embedded_hash AS hash FROM strategic_decisions WHERE id = ?')
      .get(id) as { hash: string | null };
    return { vectors, hash };
  } finally {
    db.close();
  }
}

describe('an embedding write that cannot take the store’s lock (s96-m11 build critic)', () => {
  it('says so in the answer, instead of leaving the record without a vector silently', async () => {
    expect((await rbookProjectInit({ projectRoot, projectType: 'general' })).success).toBe(true);
    const dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
    // Another process holds the write lock past this client's busy timeout.
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const client = (await RbookDatabaseClient.create({ dbPath, timeout: 100 })).data!;
    try {
      const result = await recordEmbedding(client, {
        type: 'decision',
        id: 1,
        inputText: 'Keep one JSON file per decision.',
      });
      expect(result.action).toBe('failed');
      expect(result.warnings?.join('\n')).toMatch(/decision 1 was saved without its embedding/);
    } finally {
      client.close();
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

describe('the first embedded write on a store made by init', () => {
  it.each(['general', 'build'] as const)('records a decision on a %s store', async (level) => {
    expect((await rbookProjectInit({ projectRoot, projectType: level })).success).toBe(true);
    const result = await rbookDecisions({
      action: 'record',
      content: 'Use plain text files for notes.',
      projectRoot,
    } as never);
    expect(result.success).toBe(true);
    expect((result.warnings ?? []).join('\n')).not.toMatch(/_vec|last_embedded_hash/);
    expect(embedded((result.data as { decisionId: number }).decisionId)).toEqual({
      vectors: 1,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('captures a decision and a learning', async () => {
    expect((await rbookProjectInit({ projectRoot })).success).toBe(true);
    for (const category of ['decision', 'learning'] as const) {
      const result = await rbookSession({
        action: 'capture',
        category,
        content: `A ${category} worth keeping about plain text notes.`,
        projectRoot,
      } as never);
      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/_vec\.|last_embedded_hash failed/);
    }
  });
});

describe('the standing fixtures (s96-m11)', () => {
  it('records through the MCP dispatch boundary on a new store', async () => {
    expect((await rbookProjectInit({ projectRoot })).success).toBe(true);
    const result = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'record', content: 'Use plain text files for notes.', projectRoot },
      await buildMissionProtocolContext()
    );
    const answer = result.structuredContent as {
      success: boolean;
      data: { decisionId: number };
      warnings?: string[];
    };
    expect(answer.success).toBe(true);
    expect((answer.warnings ?? []).join('\n')).not.toMatch(/_vec|last_embedded_hash/);
    expect(embedded(answer.data.decisionId).vectors).toBe(1);
  });

  it('two processes writing the first decisions of one new store both write their vectors', async () => {
    expect((await rbookProjectInit({ projectRoot })).success).toBe(true);
    const decisions = path.resolve('src/tools/rbook/rbook-decisions.ts');
    const pipeline = path.resolve('src/intelligence/embedding-pipeline.ts');
    const source = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);require(process.argv[2]).setEmbedderForTesting(async()=>new Float32Array(384).fill(0.02));const {rbookDecisions}=require(process.argv[1]);process.stdout.write('ready\n');process.stdin.once('data',async()=>{const r=await rbookDecisions({action:'record',content:'Decision from '+process.argv[4],projectRoot:process.argv[3]});process.stdout.write(JSON.stringify(r)+'\n');process.exit(0);});`;
    const children = ['first', 'second'].map((name) => {
      const child = spawn(
        process.execPath,
        ['-e', source, decisions, pipeline, projectRoot, name],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      let output = '';
      let error = '';
      child.stderr.on('data', (chunk) => (error += String(chunk)));
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('ready\n')) resolve();
        });
        child.once('close', (code) =>
          reject(new Error(`child exited ${code} before ready: ${error}`))
        );
      });
      // 'close', not 'exit': the child's last stdout chunk may arrive after it exits (s96-m10).
      const done = new Promise<string>((resolve) => child.once('close', () => resolve(output)));
      return { child, ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    children.forEach((c) => c.child.stdin.end('go'));
    const answers = (await Promise.all(children.map((c) => c.done))).map(
      (out) =>
        JSON.parse(out.trim().split('\n').slice(-1)[0]) as {
          success: boolean;
          data: { decisionId: number };
          error?: unknown;
          warnings?: string[];
        }
    );
    for (const answer of answers) {
      // The error and warnings are part of the match, so a failure prints why (s96-m10's lesson).
      expect({ success: answer.success, error: answer.error }).toEqual({
        success: true,
        error: undefined,
      });
      expect((answer.warnings ?? []).join('\n')).not.toMatch(/_vec|last_embedded_hash/);
      expect(embedded(answer.data.decisionId).vectors).toBe(1);
    }
  }, 60000);
});

PRIVATE.describe('a real store from before vector tables (509ddcf)', () => {
  it('migrates on open and writes the first new vector without a warning', async () => {
    const dbPath = path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
      dbPath,
      execFileSync('git', ['show', `${PRIVATE.revisions.preVector}:cmos/db/cmos.sqlite`], {
        cwd: REPO,
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(projectRoot);
    const result = await rbookDecisions({
      action: 'record',
      content: 'Use plain text files for notes.',
      projectRoot,
    } as never);
    expect(result.success).toBe(true);
    expect((result.warnings ?? []).join('\n')).not.toMatch(/_vec|last_embedded_hash/);
    expect(embedded((result.data as { decisionId: number }).decisionId, dbPath)).toEqual({
      vectors: 1,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 60000);
});

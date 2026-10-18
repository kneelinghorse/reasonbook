// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01's done-when for blocks — two copies of one shared record, on two machines, write offline
// ABOUTME: and every id stays in its copy's block, so no two copies ever issue the same id (ADR s96 §3).
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { share } from '../../helpers/replica-fixture';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let savedConfig: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-blocks-')));
  savedConfig = process.env.RBOOK_CONFIG_DIR;
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Each config folder stands for one machine's registry, as on the Air and the Studio. */
function onMachine(name: string): void {
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, `config-${name}`);
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
}

const dbOf = (root: string) => path.join(root, 'rbook', 'db', 'rbook.sqlite');
const BLOCK_TABLES = ['strategic_decisions', 'learnings', 'next_steps', 'constraints'] as const;

async function call(name: string, args: Record<string, unknown>): Promise<{ success: boolean }> {
  RbookDetector.resetInstance();
  const result = await executeMissionProtocolTool(name, args, await buildMissionProtocolContext());
  const answer = result.structuredContent as { success: boolean; error?: unknown };
  if (!answer.success) throw new Error(`${name} failed: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** 50 decisions, 20 learnings, 20 next steps, 5 constraints and 5 sessions, as the done-when sets. */
async function writeOffline(root: string, who: string): Promise<void> {
  for (let session = 1; session <= 5; session++) {
    await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: `${who} session ${session}`,
      projectRoot: root,
    });
    for (let n = 1; n <= 4; n++) {
      await call('rbook_session', {
        action: 'capture',
        category: 'learning',
        content: `${who} learning ${session}.${n}: copies write offline in their own blocks.`,
        projectRoot: root,
      });
      await call('rbook_session', {
        action: 'capture',
        category: 'next-step',
        content: `${who} next step ${session}.${n}`,
        projectRoot: root,
      });
    }
    await call('rbook_session', {
      action: 'capture',
      category: 'constraint',
      content: `${who} constraint ${session}`,
      projectRoot: root,
    });
    for (let n = 1; n <= 10; n++)
      await call('rbook_decisions', {
        action: 'record',
        content: `${who} decision ${session}.${n}: keep each copy's numbers in its block.`,
        projectRoot: root,
      });
    await call('rbook_session', {
      action: 'complete',
      summary: `${who} session ${session} done`,
      projectRoot: root,
    });
  }
}

function ids(root: string, table: string, after: number): number[] {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    return (
      db.prepare(`SELECT id FROM ${table} WHERE id > ? ORDER BY id`).all(after) as Array<{
        id: number;
      }>
    )
      .map((row) => row.id)
      .filter((id) => id !== 2_000_001);
  } finally {
    db.close();
  }
}

function sessions(root: string): string[] {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    return (
      db
        .prepare("SELECT id FROM sessions WHERE title LIKE '% session %' ORDER BY id")
        .all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

describe('two copies writing offline', () => {
  it('keep every id in their own blocks, past a row from a third block', async () => {
    const air = path.join(tmp, 'air');
    seedRbookDb(air, { projectId: 'p-blocks', projectName: 'blocks' });
    const seeded = new Database(dbOf(air));
    // Rows from before sharing continue in block 0, and one row from block 2 arrived from a
    // third copy. Plain AUTOINCREMENT would number every later row after it.
    for (const table of BLOCK_TABLES) {
      const text = table === 'strategic_decisions' ? 'decision_text' : 'content';
      seeded
        .prepare(`INSERT INTO ${table} (id, ${text}, created_at) VALUES (?, ?, datetime('now'))`)
        .run(7, `${table} from before sharing`);
      seeded
        .prepare(`INSERT INTO ${table} (id, ${text}, created_at) VALUES (?, ?, datetime('now'))`)
        .run(2_000_001, `${table} from block 2`);
    }
    seeded.close();

    onMachine('air');
    await share(air, 0);
    // The Studio's copy is a zip of the shared folder, joined on its own machine in block 1.
    const studio = path.join(tmp, 'studio');
    fs.cpSync(air, studio, { recursive: true });
    onMachine('studio');
    await share(studio, 1);

    onMachine('air');
    await writeOffline(air, 'air');
    onMachine('studio');
    await writeOffline(studio, 'studio');

    const expected = { strategic_decisions: 50, learnings: 20, next_steps: 20, constraints: 5 };
    for (const table of BLOCK_TABLES) {
      const fromAir = ids(air, table, 7);
      const fromStudio = ids(studio, table, 7);
      expect({ table, air: fromAir.length, studio: fromStudio.length }).toEqual({
        table,
        air: expected[table],
        studio: expected[table],
      });
      expect(fromAir.every((id) => id > 7 && id <= 1_000_000)).toBe(true);
      expect(fromStudio.every((id) => id >= 1_000_001 && id <= 2_000_000)).toBe(true);
      expect(fromAir.filter((id) => fromStudio.includes(id))).toEqual([]);
    }
    expect(sessions(air)).toHaveLength(5);
    expect(sessions(air).every((id) => /^PS-\d{4}-\d{2}-\d{2}-\d{3}$/.test(id))).toBe(true);
    expect(sessions(studio)).toHaveLength(5);
    expect(sessions(studio).every((id) => /^PS-\d{4}-\d{2}-\d{2}-b1-\d{3}$/.test(id))).toBe(true);
  }, 180000);
});

describe('two processes writing one copy at once', () => {
  it('take distinct ids in the block, and every write lands', async () => {
    const root = path.join(tmp, 'shared');
    seedRbookDb(root, { projectId: 'p-blocks', projectName: 'blocks' });
    onMachine('air');
    await share(root, 3);
    const decisions = path.resolve('src/tools/rbook/rbook-decisions.ts');
    const source = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);const {rbookDecisions}=require(process.argv[1]);process.stdout.write('ready\n');process.stdin.once('data',async()=>{const out=[];for(let n=0;n<8;n++){const r=await rbookDecisions({action:'record',content:'Decision '+n+' from '+process.argv[3],projectRoot:process.argv[2]});out.push({success:r.success,id:r.data&&r.data.decisionId,error:r.error});}process.stdout.write(JSON.stringify(out)+'\n');process.exit(0);});`;
    const children = ['first', 'second'].map((name) => {
      const child = spawn(process.execPath, ['-e', source, decisions, root, name], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
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
      const done = new Promise<string>((resolve) => child.once('close', () => resolve(output)));
      return { child, ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    children.forEach((c) => c.child.stdin.end('go'));
    const writes = (await Promise.all(children.map((c) => c.done))).flatMap(
      (out) =>
        JSON.parse(out.trim().split('\n').slice(-1)[0]) as Array<{
          success: boolean;
          id: number;
          error?: unknown;
        }>
    );
    expect(writes.filter((write) => !write.success)).toEqual([]);
    const taken = writes.map((write) => write.id).sort((a, b) => a - b);
    expect(new Set(taken).size).toBe(16);
    expect(taken.every((id) => id >= 3_000_001 && id <= 4_000_000)).toBe(true);
  }, 60000);
});

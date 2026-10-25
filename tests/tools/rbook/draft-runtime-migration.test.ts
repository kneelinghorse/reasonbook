// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Legacy runtime readers and concurrent hooks preserve the late-answer safety flag.
// ABOUTME: Real SQLite files verify migration, read-only access and old-writer compatibility.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bindWindow,
  openDraftRuntime,
  readExcerpt,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let runtime: DraftRuntime;
const session = '0123456789abcdef';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-runtime-migration-'));
  env = { RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
  const root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  dbPath = seedRbookDb(root, { projectName: 'migration' });
  reidentifyRbookTestStore(root);
  runtime = openDraftRuntime(dbPath, env)!;
  // Recreate the exact six-column excerpts shape a 4.5.1 hook wrote, regardless of candidate schema.
  runtime.db.exec(`DROP TABLE excerpts; CREATE TABLE excerpts (session TEXT NOT NULL,
    draft_id INTEGER NOT NULL, message TEXT NOT NULL, reply TEXT NOT NULL,
    window_size INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, draft_id));`);
});
afterEach(() => {
  if (runtime.db.open) runtime.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('reads an old runtime without migrating or changing its bytes', () => {
  const now = Date.now();
  runtime.db
    .prepare('INSERT INTO excerpts VALUES (?, 7, ?, ?, 1, ?)')
    .run(session, 'yes', 'approval', now);
  const hash = () => createHash('sha256').update(fs.readFileSync(runtime.path)).digest('hex');
  const before = hash();
  const reader = openDraftRuntime(dbPath, env, { readonly: true })!;
  try {
    expect(readExcerpt(reader, session, 7, now)).toMatchObject({ message: 'yes', late: false });
    expect(reader.db.prepare('PRAGMA table_info(excerpts)').all()).toHaveLength(6);
  } finally {
    reader.close();
  }
  expect(hash()).toBe(before);
});

it('migrates a legacy runtime idempotently and preserves existing evidence', () => {
  const now = Date.now();
  runtime.db
    .prepare('INSERT INTO excerpts VALUES (?, 7, ?, ?, 1, ?)')
    .run(session, 'yes', 'approval', now);
  for (let i = 0; i < 2; i++) {
    const writer = openDraftRuntime(dbPath, env)!;
    try {
      expect(writer.db.prepare('PRAGMA table_info(excerpts)').all()).toHaveLength(7);
      expect(readExcerpt(writer, session, 7, now)).toMatchObject({ message: 'yes', late: false });
    } finally {
      writer.close();
    }
  }
});

it('an old hook upsert cannot erase a previously stored late flag', () => {
  const writer = openDraftRuntime(dbPath, env)!;
  const now = Date.now();
  try {
    expect(writer.db.prepare('PRAGMA table_info(excerpts)').all()).toHaveLength(7);
    writer.db
      .prepare('INSERT INTO excerpts VALUES (?, 7, ?, ?, 1, ?, 1)')
      .run(session, 'late yes', 'other', now);
    // SQL from the published 4.5.1 bindWindow, independently probed against that tarball.
    writer.db
      .prepare(
        `INSERT INTO excerpts (session, draft_id, message, reply, window_size, at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session, draft_id) DO UPDATE SET
      message = excluded.message, reply = excluded.reply, window_size = excluded.window_size,
      at = excluded.at`
      )
      .run(session, 7, 'later yes', 'approval', 1, now + 1);
    expect(readExcerpt(writer, session, 7, now + 1)).toMatchObject({
      reply: 'approval',
      late: true,
    });
    bindWindow(writer, session, [7], 'current timely yes', 'approval', now + 2);
    expect(readExcerpt(writer, session, 7, now + 2)).toMatchObject({
      reply: 'approval',
      late: false,
    });
  } finally {
    writer.close();
  }
});

it('two independent hooks opening the same legacy file both finish after one schema migration', async () => {
  const source = String.raw`
const fs=require('fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
}).outputText,f);
const deny=require(process.argv[1]+'/tests/helpers/network-deny.ts');deny.installNetworkDeny();
const {openDraftRuntime}=require(process.argv[1]+'/src/tools/rbook/draft-runtime.ts');
process.stdout.write('ready\n');
process.stdin.once('data',()=>{try{
 process.stdout.write('opening\n');
 const runtime=openDraftRuntime(process.argv[2],{RBOOK_CONFIG_DIR:process.argv[3]},{timeoutMs:10000});
 if(!runtime)throw Error('runtime unavailable');
 const columns=runtime.db.prepare('PRAGMA table_info(excerpts)').all().map(row=>row.name);
 runtime.close();if(deny.takeBlockedAttempts().length)throw Error('network attempted');
 process.stdout.write(JSON.stringify(columns)+'\n');
}catch(error){console.error(error);process.exitCode=1}});`;
  runtime.db.exec('BEGIN IMMEDIATE');
  const children = [0, 1].map(() => {
    const child = spawn(
      process.execPath,
      ['-e', source, process.cwd(), dbPath, env.RBOOK_CONFIG_DIR!],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let output = '',
      stderr = '';
    const waiters = new Map<string, () => void>();
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      for (const [line, resolve] of waiters) if (output.includes(line + '\n')) resolve();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const done = new Promise<string[]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(Error(`Hook exited ${code}: ${stderr}`));
        else {
          try {
            resolve(JSON.parse(output.trim().split('\n').slice(-1)[0]));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    void done.catch(() => undefined);
    const wait = (line: string) =>
      Promise.race([
        new Promise<void>((resolve) => {
          if (output.includes(line + '\n')) resolve();
          else waiters.set(line, resolve);
        }),
        done.then(() => {
          throw Error(`Hook exited before ${line}`);
        }),
      ]);
    return { child, done, wait };
  });
  try {
    await Promise.all(children.map((child) => child.wait('ready')));
    for (const { child } of children) child.stdin.end('go');
    await Promise.all(children.map((child) => child.wait('opening')));
    runtime.db.exec('COMMIT');
    const columns = await Promise.all(children.map((child) => child.done));
    for (const result of columns)
      expect(result.filter((column) => column === 'late')).toHaveLength(1);
  } finally {
    if (runtime.db.inTransaction) runtime.db.exec('ROLLBACK');
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map((child) => child.done));
  }
}, 40000);

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real independent writers serialize local sprint close and mission reopen at SQLite's lock.
// ABOUTME: Each ordering must refuse the later action instead of leaving open work inside a closed sprint.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'mission-reopen-process-');
  const db = new Database(project.dbPath);
  db.exec(
    "INSERT INTO sprints(id,title,status) VALUES('s1','One','Active'); INSERT INTO missions(id,name,status,sprint_id) VALUES('m1','One','Completed','s1')"
  );
  db.close();
});
afterEach(async () => {
  await project.cleanup();
});

async function race(firstAction: 'close' | 'reopen'): Promise<Record<string, unknown>[]> {
  const release = path.join(project.projectRoot, 'release');
  const source = String.raw`
const fs = require('fs'), ts = require('typescript');
require.extensions['.ts'] = (module,file) => module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
}).outputText,file);
const deny=require(process.argv[1]+'/tests/helpers/network-deny.ts'); deny.installNetworkDeny();
const {RbookDatabaseClient}=require(process.argv[1]+'/src/tools/rbook/client.ts');
const {rbookMissionReopen}=require(process.argv[1]+'/src/tools/rbook/rbook-mission-reopen.ts');
const {rbookSprintComplete}=require(process.argv[1]+'/src/tools/rbook/rbook-sprint-complete.ts');
const action=process.argv[3],first=process.argv[4]==='first';
let seen=false;
for(const method of ['raw','execute']) {
 const original=RbookDatabaseClient.prototype[method];
 RbookDatabaseClient.prototype[method]=function(sql,...args){
  const caller=new Error().stack.split('\n')[2]||'';
  const expected=action==='close'?'rbook-sprint-complete.ts':'rbook-mission-reopen.ts';
  const isBegin=/^BEGIN IMMEDIATE$/i.test(sql.trim())&&!seen&&(!first||caller.includes(expected));
  if(isBegin){seen=true; process.stdout.write('attempt\n');}
  const result=original.call(this,sql,...args);
  if(isBegin&&result.success&&first){
   process.stdout.write('locked\n');
   const deadline=Date.now()+15000;
   while(!fs.existsSync(process.argv[5])){
    if(Date.now()>deadline)throw Error('release barrier timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
   }
  }
  return result;
 };
}
process.stdout.write('ready\n');
process.stdin.once('data',async()=>{
 try{
  const result=action==='reopen'? await rbookMissionReopen({missionId:'m1',reason:'Regressed',projectRoot:process.argv[2]}):
   await rbookSprintComplete({sprintId:'s1',summary:'Complete',condensation:'none',projectRoot:process.argv[2]});
  const blocked=deny.takeBlockedAttempts(); if(blocked.length)throw Error(JSON.stringify(blocked));
  process.stdout.write(JSON.stringify(result)+'\n');process.exit(0);
 }catch(e){console.error(e);process.exit(1);}
});`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: project.projectRoot };
  delete env.RBOOK_CHECKPOINT_SYNC;
  const children = [firstAction, firstAction === 'close' ? 'reopen' : 'close'].map(
    (action, index) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          source,
          process.cwd(),
          project.projectRoot,
          action,
          index === 0 ? 'first' : 'second',
          release,
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] }
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
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
      const done = new Promise<Record<string, unknown>>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(Error(`Child ${action} exited ${code}: ${stderr}`));
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
            throw Error(`Child exited before ${line}`);
          }),
        ]);
      return { child, done, wait };
    }
  );
  try {
    await Promise.all(children.map((child) => child.wait('ready')));
    children[0].child.stdin.end('go');
    await children[0].wait('locked');
    children[1].child.stdin.end('go');
    await children[1].wait('attempt');
    fs.writeFileSync(release, 'go');
    return await Promise.all(children.map((child) => child.done));
  } finally {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map((child) => child.done));
  }
}

test.each(['close', 'reopen'] as const)(
  '%s acquires the write lock first and the other action refuses',
  async (first) => {
    const results = await race(first);
    if (!results[0].success) throw new Error(JSON.stringify(results));
    expect(results[0]).toMatchObject({ success: true });
    expect(results[1]).toMatchObject({ success: false });
    const db = new Database(project.dbPath);
    try {
      expect(db.prepare("SELECT status FROM sprints WHERE id='s1'").get()).toEqual({
        status: first === 'close' ? 'Completed' : 'Active',
      });
      expect(db.prepare("SELECT status FROM missions WHERE id='m1'").get()).toEqual({
        status: first === 'close' ? 'Completed' : 'In Progress',
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE action='reopen'").get()
      ).toEqual({ n: first === 'close' ? 0 : 1 });
    } finally {
      db.close();
    }
  },
  40000
);

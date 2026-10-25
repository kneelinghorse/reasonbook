// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves the bounded load gate cannot hide missing files, failed rounds or abandoned children.
// ABOUTME: Real child-process fixtures exercise cleanup without recursively running the project's suite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';

const script = path.resolve(__dirname, '../../scripts/check-test-load.js');
const { selectTests, summarizeReport, runGate, HISTORICAL_FAILURES, BUDGET_MS } = require(script);
let scratch: string;
let root: string;
let files: string[];
const children: ChildProcess[] = [];

function put(name: string, content: string): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function report(selected = files) {
  return {
    success: true,
    numPassedTestSuites: selected.length,
    numFailedTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTestSuites: selected.length,
    numPassedTests: selected.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: selected.length,
    testResults: selected.map((file) => ({
      name: path.join(root, file),
      status: 'passed',
      message: '',
      assertionResults: [{ status: 'passed', failureMessages: [] as string[] }],
    })),
  };
}
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-load-gate-'));
  root = path.join(scratch, 'repo with spaces');
  fs.mkdirSync(root);
  files = [...HISTORICAL_FAILURES];
  for (const file of files) put(file, '// Historical failure; no lexical match remains.\n');
  put('.gitignore', 'dist/\nnode_modules/\n');
  put('dist/.build-manifest.json', '{}\n');
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Load fixture',
    '-c',
    'user.email=load@example.test',
    'commit',
    '-qm',
    'fixture'
  );
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

it('unites both tracked lexical predicates with historical failures, respecting Jest eligibility', () => {
  const hook = ['runCli', '('].join('') + "'hook')";
  put('tests/new-hook.test.ts', hook);
  put('tests/new-budget.test.ts', ['expect(elapsedMs)', '.toBeLessThan(500);'].join(''));
  put('tests/e2e/not-default.e2e.ts', hook);
  put('tests/private/not-default.test.ts', hook);
  git('add', 'tests');
  put('tests/untracked.test.ts', hook);
  const eligible = [
    ...files,
    'tests/new-hook.test.ts',
    'tests/new-budget.test.ts',
    'tests/private/not-default.test.ts',
    'tests/untracked.test.ts',
  ];
  const result = selectTests(
    root,
    eligible.map((file) => path.join(root, file))
  );
  expect(result.files).toEqual(
    [...files, 'tests/new-hook.test.ts', 'tests/new-budget.test.ts'].sort()
  );
  expect(result.predicates.A).toContain('tests/new-hook.test.ts');
  expect(result.predicates.B).toContain('tests/new-budget.test.ts');
  expect(result.predicates.C).toContain('tests/tools/rbook/reads-never-write.test.ts');
  expect(result.predicates.C).toContain('tests/signals/feedback-regex.test.ts');
  expect(result.excluded).toEqual([
    'tests/e2e/not-default.e2e.ts',
    'tests/private/not-default.test.ts',
  ]);
});
it('fails loudly when a historical file vanishes instead of shrinking the gate silently', () => {
  git('rm', files[0]);
  expect(() => selectTests(root, files)).toThrow(/historical/i);
});
it('requires every selected file and reconciled assertion counts, not only a success flag', () => {
  expect(summarizeReport(report(), files, root).success).toBe(true);
  expect(() => summarizeReport(report(files.slice(1)), files, root)).toThrow(/population/i);
  const bad = report();
  bad.numPassedTests++;
  expect(() => summarizeReport(bad, files, root)).toThrow(/count/i);
});
it('reports intentional skips without mistaking Jest focused status for a failed suite', () => {
  const value = report();
  value.testResults[0].status = 'focused';
  value.testResults[0].assertionResults.push({ status: 'pending', failureMessages: [] });
  value.numPendingTests++;
  value.numTotalTests++;
  expect(summarizeReport(value, files, root)).toMatchObject({ success: true, skippedTests: 1 });
});
it('rejects an output parent symlink into the checkout before starting load', async () => {
  const alias = path.join(scratch, 'output-alias');
  fs.symlinkSync(root, alias, 'dir');
  await expect(runGate({ root, outputDir: path.join(alias, 'receipt') })).rejects.toThrow(
    /outside/
  );
  expect(fs.existsSync(path.join(root, 'receipt'))).toBe(false);
});

const FAKE_JEST = `
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const control = JSON.parse(fs.readFileSync(process.env.LOAD_FIXTURE_CONTROL, 'utf8'));
if (process.argv.includes('--listTests')) {
  console.log(JSON.stringify(control.files.map(f => path.join(process.cwd(), f))));
} else {
  const output = process.argv.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length);
  const selected = process.argv.slice(process.argv.indexOf('--runTestsByPath') + 1).filter(a => a.endsWith('.test.ts'));
  fs.appendFileSync(control.calls, JSON.stringify({ output, selected }) + '\\n');
  if (control.mode.startsWith('orphan-')) {
    const code = "const fs=require('fs');process.on('SIGTERM',()=>{});" +
      "setInterval(()=>{if(!fs.existsSync("+JSON.stringify(control.lifetime)+"))process.exit(0)},20);" +
      "process.send('ready');";
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore','ignore','ignore','ipc'] });
    child.once('message', () => { fs.appendFileSync(control.orphans, child.pid+'\\n'); child.disconnect(); child.unref(); });
    if (control.mode !== 'orphan-pass') setInterval(()=>{if(!fs.existsSync(control.lifetime))process.exit(0)},20);
  }
  if (control.mode === 'hang') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'inherit' });
    fs.writeFileSync(control.grandchild, String(child.pid));
    setInterval(()=>{},1000);
  } else {
    if (control.mode === 'mutate') fs.appendFileSync(control.files[0], '\\n// concurrent change');
    if (control.mode === 'rebuild') fs.writeFileSync('dist/.build-manifest.json', '{"changed":true}');
    if (control.mode === 'remove-build') fs.rmSync('dist/.build-manifest.json', { force: true });
    const failed = control.mode === 'fail' && path.basename(output).startsWith('round-1-a');
    const value = {
      success: !failed, numPassedTestSuites: selected.length - Number(failed),
      numFailedTestSuites: Number(failed), numRuntimeErrorTestSuites: 0,
      numTotalTestSuites: selected.length, numPassedTests: selected.length - Number(failed),
      numFailedTests: Number(failed), numPendingTests: 0, numTodoTests: 0,
      numTotalTests: selected.length,
      testResults: selected.map((f,i) => ({ name: path.resolve(f), status: failed && i === 0 ? 'failed' : 'passed',
        message: failed && i === 0 ? 'fixture failure' : '', assertionResults: [{
          status: failed && i === 0 ? 'failed' : 'passed', failureMessages: failed && i === 0 ? ['fixture failure'] : [] }] }))
    };
    fs.writeFileSync(output, JSON.stringify(value));
    process.exitCode = failed ? 1 : 0;
  }
}
`;
function start(mode: string, budgetMs = 30000) {
  put('node_modules/jest/bin/jest.js', FAKE_JEST);
  const control = path.join(scratch, 'control.json');
  fs.writeFileSync(
    control,
    JSON.stringify({
      mode,
      files,
      calls: path.join(scratch, 'calls.jsonl'),
      grandchild: path.join(scratch, 'grandchild.pid'),
      orphans: path.join(scratch, 'orphans.txt'),
      lifetime: scratch,
    })
  );
  const outputDir = path.join(scratch, 'output');
  // Inject only in this disposable subprocess; real termination still happens first.
  const permissionFixture = mode.startsWith('eperm-')
    ? `const kill = process.kill.bind(process); let deniedGroup;
       process.kill = (pid, signal) => {
         if (pid === deniedGroup && signal === 0 && ${JSON.stringify(mode)} === 'eperm-unresolved') {
           throw Object.assign(new Error('fixture group probe EPERM'), { code: 'EPERM' });
         }
         if (pid === deniedGroup && signal === 0 && ${JSON.stringify(mode)} === 'eperm-present') return true;
         const result = kill(pid, signal);
         if (pid < 0 && signal === 'SIGTERM' && deniedGroup === undefined) {
           deniedGroup = pid;
           throw Object.assign(new Error('fixture cleanup EPERM'), { code: 'EPERM' });
         }
         return result;
       };`
    : '';
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${permissionFixture}
      require(${JSON.stringify(script)}).runGate(${JSON.stringify({ root, outputDir, budgetMs })})
      .then(r=>{process.exitCode=r.success?0:1}).catch(e=>{console.error(e);process.exitCode=2})`,
    ],
    { env: { ...process.env, LOAD_FIXTURE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  let log = '';
  child.stdout?.on('data', (data) => {
    log += data;
  });
  child.stderr?.on('data', (data) => {
    log += data;
  });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  return { child, done, outputDir, log: () => log };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Child-process fixture did not reach its marker');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function receipt(outputDir: string) {
  const value = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
  expect(value.cleanup.pidsStillAlive).toEqual([]);
  expect(value.spinners).toHaveLength(8);
  for (const pid of value.spinners) expect(alive(pid)).toBe(false);
  return value;
}
it('runs exactly two concurrent pairs and removes all eight spinners on success', async () => {
  expect(BUDGET_MS).toBe(30 * 60 * 1000);
  const run = start('pass');
  expect({ code: await run.done, log: run.log() }).toMatchObject({ code: 0 });
  const value = receipt(run.outputDir);
  expect(value.success).toBe(true);
  expect(value.runs.map((r: { label: string }) => r.label)).toEqual([
    'round-1-a',
    'round-1-b',
    'round-2-a',
    'round-2-b',
  ]);
  expect(value.diagnostics).toEqual([]);
  for (const pair of [value.runs.slice(0, 2), value.runs.slice(2)]) {
    const starts = pair.map((run: { startedAt: string }) => Date.parse(run.startedAt));
    const ends = pair.map((run: { finishedAt: string }) => Date.parse(run.finishedAt));
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  }
  expect(Date.parse(value.runs[2].startedAt)).toBeGreaterThanOrEqual(
    Math.max(
      ...value.runs.slice(0, 2).map((run: { finishedAt: string }) => Date.parse(run.finishedAt))
    )
  );
  expect(value.headBefore).toBe(value.headAfter);
  expect(value.buildManifestBefore).toBe(value.buildManifestAfter);
});
it('keeps an initial failure red even when all five isolated diagnostic reruns pass', async () => {
  const run = start('fail');
  expect(await run.done).toBe(1);
  const value = receipt(run.outputDir);
  expect(value.success).toBe(false);
  expect(value.runs).toHaveLength(4);
  expect(value.diagnostics).toHaveLength(5);
  const calls = fs
    .readFileSync(path.join(scratch, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.slice(4).every((call) => call.selected.length === 1)).toBe(true);
  expect(value.diagnostics.every((r: { success: boolean }) => r.success)).toBe(true);
});
it('retains a transient permission error but resolves it only after child close and group disappearance', async () => {
  const run = start('eperm-transient');
  expect({ code: await run.done, log: run.log() }).toMatchObject({ code: 0 });
  const value = receipt(run.outputDir);
  expect(value.cleanup.errors).toEqual(['fixture cleanup EPERM']);
  expect(value.cleanup.unresolvedErrors).toEqual([]);
  const attempt = value.cleanup.attempts.find((entry: { code?: string }) => entry.code === 'EPERM');
  expect(attempt).toMatchObject({
    pid: value.spinners[0],
    label: 'spinner-1',
    signal: 'SIGTERM',
    code: 'EPERM',
    message: 'fixture cleanup EPERM',
    resolution: 'closed-and-group-absent',
    groupProbe: 'ESRCH',
  });
  const child = value.processes.find((entry: { pid: number }) => entry.pid === attempt.pid);
  expect(Date.parse(child.exitedAt)).toBeLessThanOrEqual(Date.parse(child.finishedAt));
  expect(Date.parse(child.finishedAt)).toBeLessThanOrEqual(Date.parse(attempt.checkedAt));
});
it.each([
  ['eperm-unresolved', 'EPERM'],
  ['eperm-present', 'present'],
])('keeps %s fatal even after every child has closed', async (mode, groupProbe) => {
  const run = start(mode);
  expect(await run.done).toBe(1);
  const value = receipt(run.outputDir);
  expect(value.runs.every((result: { success: boolean }) => result.success)).toBe(true);
  expect(value).toMatchObject({ success: false, reason: expect.stringMatching(/Cleanup/) });
  expect(value.cleanup.errors).toEqual(['fixture cleanup EPERM']);
  expect(value.cleanup.unresolvedErrors).toEqual([
    expect.objectContaining({
      pid: value.spinners[0],
      signal: 'SIGTERM',
      code: 'EPERM',
      groupProbe,
    }),
  ]);
});
it.each(['mutate', 'rebuild', 'remove-build'])(
  'refuses a %s during otherwise passing reports',
  async (mode) => {
    const run = start(mode);
    expect(await run.done).toBe(1);
    const value = receipt(run.outputDir);
    expect(value.runs.every((result: { success: boolean }) => result.success)).toBe(true);
    expect(value).toMatchObject({ success: false, reason: expect.stringMatching(/integrity/) });
  }
);
it('enforces the whole-run deadline and cleans up even when a test process never returns', async () => {
  const run = start('hang', 6000);
  expect(await run.done).toBe(1);
  expect(receipt(run.outputDir)).toMatchObject({
    success: false,
    reason: expect.stringMatching(/budget/i),
  });
});
it('cleans owned process groups on interrupt while leaving an unrelated process alive', async () => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  children.push(sentinel);
  const run = start('hang');
  await until(() => fs.existsSync(path.join(scratch, 'grandchild.pid')));
  const grandchild = Number(fs.readFileSync(path.join(scratch, 'grandchild.pid'), 'utf8'));
  run.child.kill('SIGINT');
  expect(await run.done).toBe(1);
  expect(receipt(run.outputDir)).toMatchObject({
    success: false,
    reason: expect.stringMatching(/SIGINT/),
  });
  await until(() => !alive(grandchild));
  expect(alive(sentinel.pid!)).toBe(true);
});
it.each(['orphan-pass', 'orphan-term', 'orphan-disconnect'])(
  'removes independent-stdio descendants after %s lets the Jest leader exit',
  async (mode) => {
    const run = start(mode);
    const orphanFile = path.join(scratch, 'orphans.txt');
    if (mode !== 'orphan-pass') {
      await until(
        () =>
          fs.existsSync(orphanFile) &&
          fs.readFileSync(orphanFile, 'utf8').trim().split('\n').length === 2
      );
      run.child.kill(mode === 'orphan-disconnect' ? 'SIGKILL' : 'SIGINT');
    }
    expect(await run.done).toBe(mode === 'orphan-pass' ? 0 : mode === 'orphan-term' ? 1 : null);
    const descendants = fs.readFileSync(orphanFile, 'utf8').trim().split('\n').map(Number);
    expect(descendants).toHaveLength(mode === 'orphan-pass' ? 4 : 2);
    if (mode === 'orphan-disconnect') {
      await until(() => descendants.every((pid) => !alive(pid)));
      return;
    }
    for (const pid of descendants) expect(alive(pid)).toBe(false);
    expect(receipt(run.outputDir).cleanup.groupsStillPresent).toEqual([]);
  }
);

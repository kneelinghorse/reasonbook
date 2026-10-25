// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves source fixture caching reuses only compiled bytes and keeps failure evidence.
// ABOUTME: Exercises cold/warm children, changed sources, concurrent publication and private cleanup.

import childProcess, { type SpawnSyncOptions, type SpawnSyncReturns } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  prepareUploadServerRunCache,
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from './upload-server-source';
import globalSetup from '../jest-global-setup';
import globalTeardown from '../jest-global-teardown';
import { clearProductSettings, cleanBeforeTest, restoreRunControls } from './test-env-isolation';

const cacheEnv = 'JEST_RECORD_UPLOAD_SOURCE_CACHE';
const compiler = require.resolve('typescript');
const runCache = process.env[cacheEnv];
let directory: string;
let previous: string | undefined;
let privateDirs: string[];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-source-cache-test-'));
  previous = process.env[cacheEnv];
  delete process.env[cacheEnv];
  privateDirs = [];
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env[cacheEnv];
  else process.env[cacheEnv] = previous;
  for (const dir of privateDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(): { entry: string; cache: string } {
  const entry = path.join(directory, 'entry.ts');
  fs.writeFileSync(entry, 'export const value: number = 41;');
  const cache = path.join(directory, 'cache');
  fs.mkdirSync(cache);
  return { entry, cache };
}

function source(cache: string, entry: string, forbidCompiler = false): string {
  return `${
    forbidCompiler
      ? `const Module = require('module'); const load = Module._load;
Module._load = function(id, ...rest) { if(id === ${JSON.stringify(compiler)}) throw new Error('compiler forbidden'); return load.call(this, id, ...rest); };`
      : ''
  }
${uploadServerSourceLoader(cache)}
process.stdout.write(JSON.stringify(require(${JSON.stringify(entry)}).value));`;
}

function run(cache: string, entry: string, forbidCompiler = false): SpawnSyncReturns<string> {
  return childProcess.spawnSync(process.execPath, ['-e', source(cache, entry, forbidCompiler)], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

it('warms the run cache before fixture workers, including CLI and server imports', () => {
  expect(runCache).toBeDefined();
  expect(fs.readdirSync(runCache!).filter((file) => file.endsWith('.js')).length).toBeGreaterThan(
    0
  );
  const entries = [
    'src/index.ts',
    'src/cli.ts',
    'src/tools/rbook/rbook-decisions.ts',
    'src/intelligence/embedding-pipeline.ts',
    'src/tools/rbook/rbook-mission-start.ts',
    'src/tools/rbook/dashboard-client.ts',
    'src/tools/rbook/dashboard-upload.ts',
  ];
  const result = childProcess.spawnSync(
    process.execPath,
    [
      '-e',
      source(runCache!, path.resolve(entries[0]), true).replace(
        /process.stdout.write\(JSON.stringify\(require\(.+$/,
        ''
      ) + entries.map((entry) => `require(${JSON.stringify(path.resolve(entry))});`).join('\n'),
    ],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        RBOOK_CONFIG_DIR: path.join(directory, 'config'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        RBOOK_SHARED_SYNC: 'off',
      },
    }
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});

it('compiles cold sources and runs warm sources even when loading the compiler is forbidden', () => {
  const { entry, cache } = fixture();
  expect(run(cache, entry).stdout).toBe('41');
  expect(run(cache, entry, true)).toMatchObject({ status: 0, stdout: '41', stderr: '' });
  expect(fs.readdirSync(cache)).toHaveLength(1);
});

it('includes the compiler bytes and actual compiler options in the content identity', () => {
  const { entry, cache } = fixture();
  expect(run(cache, entry).status).toBe(0);
  const identity = createHash('sha256')
    .update(fs.readFileSync(compiler))
    .update(JSON.stringify({ module: 'CommonJS', target: 'ES2022', esModuleInterop: true }))
    .digest('hex');
  const key = createHash('sha256')
    .update(JSON.stringify([fs.realpathSync(entry), fs.readFileSync(entry, 'utf8'), identity]))
    .digest('hex');
  expect(fs.readdirSync(cache)).toEqual([`${key}.js`]);

  const read = fs.readFileSync;
  jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) =>
      file === compiler
        ? Buffer.concat([read(compiler), Buffer.from('\n// different compiler')])
        : Reflect.apply(read, fs, [file, ...args])) as typeof fs.readFileSync);
  const changedLoader = uploadServerSourceLoader(cache);
  jest.restoreAllMocks();
  const forbidden = source(cache, entry, true).replace(
    uploadServerSourceLoader(cache),
    changedLoader
  );
  const result = childProcess.spawnSync(process.execPath, ['-e', forbidden], { encoding: 'utf8' });
  expect(result.stderr).toContain('compiler forbidden');
});

it('invalidates changed source bytes instead of silently executing a previous candidate', () => {
  const { entry, cache } = fixture();
  expect(run(cache, entry).stdout).toBe('41');
  fs.writeFileSync(entry, 'export const value: number = 42;');
  expect(run(cache, entry, true).stderr).toContain('compiler forbidden');
  expect(run(cache, entry)).toMatchObject({ status: 0, stdout: '42', stderr: '' });
  expect(fs.readdirSync(cache)).toHaveLength(2);
});

it('publishes whole outputs when two cold children compile the same source concurrently', async () => {
  const { entry, cache } = fixture();
  // Hold both complete temporary outputs before either publication: this proves two cache misses,
  // rather than relying on the scheduler to overlap two nominally concurrent children.
  const barrier = `const barrierFs = require('fs'); const rename = barrierFs.renameSync;
barrierFs.renameSync = (...args) => {
  barrierFs.writeFileSync(${JSON.stringify(directory)} + '/publish-ready-' + process.pid, 'ready');
  const deadline = Date.now() + 20000;
  while (barrierFs.readdirSync(${JSON.stringify(directory)}).filter(f => f.startsWith('publish-ready-')).length !== 2) {
    if (Date.now() > deadline) throw new Error('concurrent publication barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return rename(...args);
};\n`;
  const results = await Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve, reject) => {
          const child = childProcess.spawn(process.execPath, [
            '-e',
            barrier + source(cache, entry),
          ]);
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr.on('data', (chunk) => (stderr += String(chunk)));
          child.once('error', reject);
          child.once('close', (status) => resolve({ status, stdout, stderr }));
        })
    )
  );
  expect(results).toEqual([
    { status: 0, stdout: '41', stderr: '' },
    { status: 0, stdout: '41', stderr: '' },
  ]);
  expect(fs.readdirSync(cache)).toHaveLength(1);
  expect(run(cache, entry, true)).toMatchObject({ status: 0, stdout: '41', stderr: '' });
});

it('keeps each fixture private while reusing run-owned compiled bytes after another fixture is removed', () => {
  const { entry, cache } = fixture();
  expect(run(cache, entry).status).toBe(0);
  process.env[cacheEnv] = cache;
  const first = prepareUploadServerSources(directory, ['entry.ts']);
  privateDirs.push(first);
  const second = prepareUploadServerSources(directory, ['entry.ts']);
  privateDirs.push(second);
  expect(first).not.toBe(second);
  expect(fs.readdirSync(second).filter((file) => file.endsWith('.js'))).toHaveLength(0);
  fs.writeFileSync(path.join(first, 'private-state'), 'first fixture only');
  expect(fs.existsSync(path.join(second, 'private-state'))).toBe(false);
  fs.rmSync(first, { recursive: true, force: true });
  expect(run(second, entry, true)).toMatchObject({ status: 0, stdout: '41', stderr: '' });
  expect(fs.existsSync(cache)).toBe(true);
});

it('allows a future entry missing from the prewarm to populate the same content cache safely', () => {
  const { entry, cache } = fixture();
  process.env[cacheEnv] = cache;
  const privateDir = prepareUploadServerSources(directory, ['entry.ts']);
  privateDirs.push(privateDir);
  expect(fs.readdirSync(cache).filter((file) => file.endsWith('.js'))).toHaveLength(1);
  expect(run(privateDir, entry, true)).toMatchObject({ status: 0, stdout: '41', stderr: '' });
});

it('retains spawn failure details and bounded output before removing its failed private directory', () => {
  const start = Date.now();
  const failure = Object.assign(new Error('spawnSync timed out'), {
    code: 'ETIMEDOUT',
    errno: -60,
    syscall: 'spawnSync',
    path: process.execPath,
  });
  const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
    status: null,
    signal: 'SIGTERM',
    pid: 424242,
    error: failure,
    stdout: 'x'.repeat(10_000),
    stderr: 'y'.repeat(10_000),
    output: [],
  });
  let receipt: { elapsedMs?: number; stdout?: string; stderr?: string } = {};
  try {
    prepareUploadServerSources(directory, ['missing.ts']);
  } catch (error) {
    receipt = JSON.parse((error as Error).message);
  }
  expect(receipt).toMatchObject({
    status: null,
    signal: 'SIGTERM',
    pid: 424242,
    error: {
      name: 'Error',
      message: 'spawnSync timed out',
      code: 'ETIMEDOUT',
      errno: -60,
      syscall: 'spawnSync',
      path: process.execPath,
    },
    cacheEntries: 0,
    stdoutTruncated: true,
    stderrTruncated: true,
  });
  expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(receipt.elapsedMs).toBeLessThanOrEqual(Date.now() - start);
  expect(receipt.stdout).toHaveLength(8192);
  expect(receipt.stderr).toHaveLength(8192);
  const config = (spawn.mock.calls[0][2] as SpawnSyncOptions).env!.RBOOK_CONFIG_DIR!;
  expect(fs.existsSync(path.dirname(config))).toBe(false);
  expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 150_000 });
});

it('removes a failed global prewarm without adopting an inherited run-cache directory', () => {
  const inherited = path.join(directory, 'inherited');
  fs.mkdirSync(inherited);
  fs.writeFileSync(path.join(inherited, 'keep'), 'owned by another run');
  process.env[cacheEnv] = inherited;
  const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
    status: 1,
    signal: null,
    pid: 424243,
    stdout: '',
    stderr: 'warmup failed',
    output: [],
  });
  expect(() => prepareUploadServerRunCache(directory)).toThrow('warmup failed');
  const config = (spawn.mock.calls[0][2] as SpawnSyncOptions).env!.RBOOK_CONFIG_DIR!;
  expect(fs.existsSync(path.dirname(config))).toBe(false);
  expect(fs.readFileSync(path.join(inherited, 'keep'), 'utf8')).toBe('owned by another run');
});

it('retains the child failure if its cache disappears before diagnostics are collected', () => {
  process.env[cacheEnv] = path.join(directory, 'missing-cache');
  jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
    status: 1,
    signal: null,
    pid: 424244,
    stdout: '',
    stderr: 'original child failure',
    output: [],
  });
  let receipt: unknown;
  try {
    prepareUploadServerSources(directory, ['entry.ts']);
  } catch (error) {
    receipt = JSON.parse((error as Error).message);
  }
  expect(receipt).toMatchObject({
    pid: 424244,
    status: 1,
    stderr: 'original child failure',
    cacheEntries: null,
    cacheReadError: { code: 'ENOENT' },
  });
});

it('owns an independent cache with explicit config and tears down its handle even if the env changes', async () => {
  const savedEnv = { ...process.env };
  const globals = globalThis as unknown as { __RBOOK_JEST_SOURCE_CACHE__?: string };
  const previousHandle = globals.__RBOOK_JEST_SOURCE_CACHE__;
  const inherited = path.join(directory, 'inherited');
  const owned = path.join(directory, 'owned');
  const config = path.join(directory, 'operator-config');
  for (const dir of [inherited, owned, config]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep'), dir);
  }
  jest
    .spyOn(require('./upload-server-source'), 'prepareUploadServerRunCache')
    .mockReturnValue(owned);
  try {
    process.env.RBOOK_CONFIG_DIR = config;
    process.env[cacheEnv] = inherited;
    await globalSetup();
    expect(process.env[cacheEnv]).toBe(owned);
    expect(process.env.RBOOK_CONFIG_DIR).toBe(config);
    process.env[cacheEnv] = inherited;
    await globalTeardown();
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.readFileSync(path.join(inherited, 'keep'), 'utf8')).toBe(inherited);
    expect(fs.readFileSync(path.join(config, 'keep'), 'utf8')).toBe(config);
  } finally {
    process.env = savedEnv;
    globals.__RBOOK_JEST_SOURCE_CACHE__ = previousHandle;
  }
});

it('preserves the Jest-owned cache pointer through product environment isolation', () => {
  const env = { [cacheEnv]: '/run-owned', RBOOK_CONFIG_DIR: '/inherited' };
  clearProductSettings(env);
  cleanBeforeTest(env, {});
  restoreRunControls(env, {}, '/private-fixture');
  expect(env).toEqual({ [cacheEnv]: '/run-owned', RBOOK_CONFIG_DIR: '/private-fixture' });
});

it('removes the owned source cache when a later global setup step fails', async () => {
  const savedEnv = { ...process.env };
  const owned = path.join(directory, 'owned');
  fs.mkdirSync(owned);
  jest
    .spyOn(require('./upload-server-source'), 'prepareUploadServerRunCache')
    .mockReturnValue(owned);
  jest.spyOn(fs.promises, 'mkdtemp').mockRejectedValue(new Error('config setup failed'));
  try {
    clearProductSettings(process.env);
    await expect(globalSetup()).rejects.toThrow('config setup failed');
    expect(fs.existsSync(owned)).toBe(false);
  } finally {
    process.env = savedEnv;
  }
});

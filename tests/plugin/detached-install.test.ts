// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives the real shim and detached worker against an adjacent local npm double.
// ABOUTME: Proves the production entrypoints publish native-ready installs without touching the network or dist.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copiedPlugin, fixture, fixtureNode, packageCode, version } from './fixtures';
import { cleanupFixture, watchFixture } from './detached-install-diagnostics';

describe('detached fixture diagnostics', () => {
  let root: string;
  let child: ReturnType<typeof spawn>;
  let watch: ReturnType<typeof watchFixture>;
  beforeEach(() => {
    jest.useFakeTimers();
    root = fixture();
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: 123,
      kill: jest.fn(),
      exitCode: null,
      signalCode: null,
    }) as unknown as ReturnType<typeof spawn>;
    watch = watchFixture(child, root, path.join(root, 'data', 'install'));
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });
  test.each(['installing', 'npmCalled'])(
    'identifies withheld %s at the 30s startup guard',
    async (missing) => {
      const result = watch
        .waitFor('startup', () => ({
          installing: missing !== 'installing',
          npmCalled: missing !== 'npmCalled',
        }))
        .catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(30000);
      const error = (await result) as Error;
      expect(error?.message).toContain('startup');
      expect(error.message).toContain('budget 30000 ms');
      expect(error?.message).toContain('"' + missing + '": false');
      expect(error?.message).toContain('firstObservedMs');
    }
  );
  test.each(['error', 'exit'])(
    'retains early child %s evidence without an unhandled event',
    async (event) => {
      child.stdout!.emit('data', 'x'.repeat(5000));
      child.stderr!.emit('data', 'npm launch detail');
      if (event === 'error') child.emit('error', new Error('spawn failed'));
      else child.emit('exit', 7, null);
      const result = watch
        .waitFor('startup', () => ({ installing: false }))
        .catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(30000);
      expect(((await result) as Error).message).toContain(
        event === 'error' ? 'spawn failed' : '"exitCode": 7'
      );
      expect(((await result) as Error).message).toContain('npm launch detail');
      expect(((await result) as Error).message).toContain('"stdoutTruncated": true');
      expect(JSON.parse(watch.snapshot()).stdout).toHaveLength(4096);
    }
  );
  test('publication still waits for the detached worker after the expected parent kill', async () => {
    child.emit('exit', null, 'SIGKILL');
    let ready = false;
    const result = watch.waitFor('publication', () => ({ ready }));
    setTimeout(() => {
      ready = true;
    }, 40);
    await jest.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toBeUndefined();
  });
  test('startup readiness after 10s succeeds because the loaded fixture became healthy at 10983ms', async () => {
    let ready = false;
    const result = watch
      .waitFor('startup', () => ({ installing: ready }))
      .catch((error: Error) => error);
    setTimeout(() => {
      ready = true;
    }, 15000);
    await jest.advanceTimersByTimeAsync(15000);
    await expect(result).resolves.toBeUndefined();
  });
  test.each([
    ['startup', 30000],
    ['publication', 10000],
  ] as const)(
    '%s never-ready guard expires at %ims and malformed JSON stays evidence',
    async (phase, budget) => {
      const lock = path.join(root, 'data', 'install.lock');
      fs.mkdirSync(path.dirname(lock));
      fs.writeFileSync(lock, '{broken');
      let settled = false;
      const result = watch
        .waitFor(phase, () => ({ ready: false }))
        .catch((error: Error) => {
          settled = true;
          return error;
        });
      await jest.advanceTimersByTimeAsync(budget - 20);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(20);
      const error = (await result) as Error;
      expect(settled).toBe(true);
      expect(error.message).toContain(`${phase} readiness timed out (budget ${budget} ms)`);
      expect(error.message).toContain(`"phaseElapsedMs": ${budget}`);
      expect(error.message).toContain('SyntaxError');
    }
  );
  test.each([false, true])(
    'malformed lock cleanup fails loudly and preserves an existing failure: %s',
    (hasPrimary) => {
      const installRoot = path.join(root, 'data', 'install');
      fs.mkdirSync(path.dirname(installRoot));
      fs.writeFileSync(installRoot + '.lock', '{broken');
      const primary = hasPrimary ? new Error('original startup failure') : undefined;
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => {
          try {
            if (primary) throw primary;
          } finally {
            cleanupFixture(child, root, installRoot, primary);
          }
        }).toThrow(primary ?? /cleanup failed/);
        if (primary) expect(log).toHaveBeenCalledWith(expect.stringContaining('SyntaxError'));
      } finally {
        log.mockRestore();
      }
    }
  );
  test('fixture read errors do not replace the readiness failure', async () => {
    fs.mkdirSync(path.join(root, 'calls'));
    const result = watch
      .waitFor('startup', () => ({ installing: false }))
      .catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(30000);
    expect(((await result) as Error).message).toContain('budget 30000 ms');
    expect(((await result) as Error).message).toContain('readError');
  });
});

test('cold SessionStart detaches one worker, then the next session uses its fully marked install', async () => {
  const root = fixture();
  const data = path.join(root, 'data');
  const installRoot = path.join(
    data,
    `${version}-${process.platform}-${process.arch}-abi${process.versions.modules}`
  );
  try {
    const plugin = copiedPlugin(root);
    const localNode = fixtureNode(root);
    const npmScript = path.join(root, 'npm-fixture.js');
    fs.writeFileSync(
      npmScript,
      `const fs=require('node:fs');const path=require('node:path');
      const prefix=process.argv[process.argv.indexOf('--prefix')+1];
      fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},'install'+String.fromCharCode(10));
      ${packageCode('prefix')}`
    );
    if (process.platform === 'win32')
      fs.writeFileSync(path.join(root, 'npm.cmd'), `@"${localNode}" "${npmScript}" %*\r\n`);
    else fs.symlinkSync(npmScript, path.join(root, 'npm'));
    const env = {
      ...process.env,
      PATH: '',
      CLAUDE_PLUGIN_DATA: data,
      RBOOK_CONFIG_DIR: path.join(root, 'config'),
    };
    // A hang guard, not a speed budget: the fixture installs a cold package while using
    // the already running Node executable. Preserve bounded failure evidence under load.
    const invoke = () =>
      spawnSync(
        localNode,
        [
          path.join(plugin, 'hooks/run.mjs'),
          'hook',
          'session-start',
          '--hook-source',
          'rbook-plugin',
        ],
        { env, input: '{}', encoding: 'utf8', timeout: 30_000 }
      );
    const first = invoke();
    expect({
      status: first.status,
      signal: first.signal,
      error: first.error?.message,
      stderr: first.stderr?.slice(-4096),
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    expect(first.stdout).toContain('Reasonbook is installing');
    const deadline = Date.now() + 10000;
    while (
      (!fs.existsSync(path.join(installRoot, '.rbook-ready.json')) ||
        fs.existsSync(installRoot + '.lock')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(path.join(installRoot, '.rbook-ready.json'))).toBe(true);
    const second = invoke();
    expect({
      status: second.status,
      signal: second.signal,
      error: second.error?.message,
      stderr: second.stderr?.slice(-4096),
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    expect(JSON.parse(second.stdout).args).toEqual([
      'hook',
      'session-start',
      '--hook-source',
      'rbook-plugin',
    ]);
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    // These PIDs are read only from this test's own isolated worker files, never a process list.
    if (fs.existsSync(installRoot + '.lock')) {
      const owner = JSON.parse(fs.readFileSync(installRoot + '.lock', 'utf8'));
      try {
        process.kill(owner.pid, 'SIGKILL');
      } catch {
        /* Worker already exited. */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('shared hook and MCP starters install once even after the MCP process group ends', async () => {
  const root = fixture();
  const configDir = path.join(root, 'config');
  const data = path.join(configDir, 'plugins');
  const installRoot = path.join(
    data,
    `${version}-${process.platform}-${process.arch}-abi${process.versions.modules}`
  );
  let server: ReturnType<typeof spawn> | undefined;
  let watch: ReturnType<typeof watchFixture> | undefined;
  let failure: Error | undefined;
  try {
    const plugin = copiedPlugin(root);
    const localNode = fixtureNode(root);
    const npmScript = path.join(root, 'npm-fixture.js');
    const calls = path.join(root, 'calls');
    // s98-m08 (#660 item 2): the install finishes when the test says so, not after 750 ms, which a
    // loaded machine spent before the hook below reached findReady. A double the test never
    // releases gives up after a minute, so no npm stand-in outlives a failed test for long.
    const release = path.join(root, 'npm-release');
    fs.writeFileSync(
      npmScript,
      `const fs=require('node:fs');const path=require('node:path');
      const prefix=process.argv[process.argv.indexOf('--prefix')+1];
      fs.appendFileSync(${JSON.stringify(calls)},'install'+String.fromCharCode(10));
      const until=Date.now()+60000;
      const finish=()=>{if(fs.existsSync(${JSON.stringify(release)})){${packageCode('prefix')}}
        else if(Date.now()<until)setTimeout(finish,10);else process.exit(1);};
      finish();`
    );
    if (process.platform === 'win32')
      fs.writeFileSync(path.join(root, 'npm.cmd'), `@"${localNode}" "${npmScript}" %*\r\n`);
    else fs.symlinkSync(npmScript, path.join(root, 'npm'));
    const env = {
      ...process.env,
      PATH: '',
      RBOOK_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: path.join(root, '.codex/plugins/data'),
    };
    const script = path.join(plugin, 'hooks/run.mjs');
    server = spawn(localNode, [script, 'serve', '--install-root', 'shared'], {
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Capture all child events before the request can fail or produce output.
    watch = watchFixture(server, root, installRoot);
    server.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1' },
        },
      }) + '\n'
    );
    await watch.waitFor('startup', () => ({
      installing: watch!.hasInstalling(),
      npmCalled: fs.existsSync(calls),
    }));
    const hookArgs = [
      script,
      'hook',
      'session-start',
      '--harness',
      'codex',
      '--install-root',
      'shared',
    ];
    const hook = spawnSync(localNode, hookArgs, {
      env,
      input: '{}',
      encoding: 'utf8',
      // s102-m13: the old 2 s child watchdog expired under load before this fixture
      // answered; installation behavior, not subprocess startup speed, is asserted here.
      timeout: 30_000,
    });
    expect({ status: hook.status, signal: hook.signal, error: hook.error }).toEqual({
      status: 0,
      signal: null,
      error: undefined,
    });
    expect(hook.stdout).toContain('Reasonbook is installing');
    if (process.platform === 'win32') server.kill('SIGKILL');
    else process.kill(-server.pid!, 'SIGKILL');
    // The install the ended process group started finishes on its own.
    fs.writeFileSync(release, '');
    await watch.waitFor('publication', () => ({
      ready: fs.existsSync(path.join(installRoot, '.rbook-ready.json')),
      lockReleased: !fs.existsSync(installRoot + '.lock'),
    }));
    const ready = spawnSync(localNode, hookArgs, {
      env,
      input: '{}',
      encoding: 'utf8',
      // s102-m13: the old 2 s child watchdog expired under load before this fixture
      // answered; installation behavior, not subprocess startup speed, is asserted here.
      timeout: 30_000,
    });
    expect({ status: ready.status, signal: ready.signal, error: ready.error }).toEqual({
      status: 0,
      signal: null,
      error: undefined,
    });
    expect(JSON.parse(ready.stdout).args).toEqual(['hook', 'session-start', '--harness', 'codex']);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(data, 'runtime/plugin-install.json'), 'utf8'))
        .installRoot
    ).toBe(installRoot);
  } catch (error) {
    // Snapshot before cleanup and retain the original assertion stack.
    failure = new Error(
      [error instanceof Error ? error.stack : String(error), watch?.snapshot()]
        .filter(Boolean)
        .join('\n')
    );
    throw failure;
  } finally {
    cleanupFixture(server, root, installRoot, failure);
  }
});

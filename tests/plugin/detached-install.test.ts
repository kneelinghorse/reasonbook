// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives the real shim and detached worker against an adjacent local npm double.
// ABOUTME: Proves the production entrypoints publish native-ready installs without touching the network or dist.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { copiedPlugin, fixture, packageCode, version } from './fixtures';

test('cold SessionStart detaches one worker, then the next session uses its fully marked install', async () => {
  const root = fixture();
  const data = path.join(root, 'data');
  const installRoot = path.join(
    data,
    `${version}-${process.platform}-${process.arch}-abi${process.versions.modules}`
  );
  try {
    const plugin = copiedPlugin(root);
    const localNode = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, localNode);
    fs.chmodSync(localNode, 0o755);
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
    // s96-m10 (#647): a hang guard, not a speed budget. The first call is the first run of the
    // binary copied above, which macOS scans first: it measured 2.0-2.9 s at load 19-25, and ran
    // past 5 s in 3 of 89 runs under two concurrent full suites. A hung hook still fails, by signal.
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
    expect({ status: first.status, signal: first.signal }).toEqual({ status: 0, signal: null });
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
    expect({ status: second.status, signal: second.signal }).toEqual({ status: 0, signal: null });
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
  try {
    const plugin = copiedPlugin(root);
    const localNode = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, localNode);
    fs.chmodSync(localNode, 0o755);
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
    let output = '';
    server.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
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
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!predicate() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(predicate()).toBe(true);
    };
    await waitFor(() => output.includes('rbook-installing') && fs.existsSync(calls));
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
      timeout: 2000,
    });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain('Reasonbook is installing');
    if (process.platform === 'win32') server.kill('SIGKILL');
    else process.kill(-server.pid!, 'SIGKILL');
    // The install the ended process group started finishes on its own.
    fs.writeFileSync(release, '');
    await waitFor(
      () =>
        fs.existsSync(path.join(installRoot, '.rbook-ready.json')) &&
        !fs.existsSync(installRoot + '.lock')
    );
    const ready = spawnSync(localNode, hookArgs, {
      env,
      input: '{}',
      encoding: 'utf8',
      timeout: 2000,
    });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout).args).toEqual(['hook', 'session-start', '--harness', 'codex']);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(data, 'runtime/plugin-install.json'), 'utf8'))
        .installRoot
    ).toBe(installRoot);
  } finally {
    if (server?.exitCode === null) server.kill('SIGKILL');
    if (fs.existsSync(installRoot + '.lock')) {
      const owner = JSON.parse(fs.readFileSync(installRoot + '.lock', 'utf8'));
      try {
        process.kill(owner.pid, 'SIGKILL');
      } catch {
        /* This isolated worker already exited. */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

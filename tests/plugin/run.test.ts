// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises the shipped plugin entrypoint's cold, disabled and ready routes without network access.
// ABOUTME: Hooks fail open while explicit CLI calls preserve their exit status and exact package pin.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  contextCode,
  copiedPlugin,
  fixture,
  moduleUrl,
  node,
  packageCode,
  version,
} from './fixtures';

describe('plugin shim routing', () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function env() {
    return {
      RBOOK_CONFIG_DIR: path.join(root, 'config'),
      CLAUDE_PLUGIN_DATA: path.join(root, 'data'),
      PATH: '',
    };
  }
  function runShim(args: string[], input = '', extra: NodeJS.ProcessEnv = {}) {
    const plugin = copiedPlugin(root);
    return spawnSync(process.execPath, [path.join(plugin, 'hooks/run.mjs'), ...args], {
      env: { ...process.env, ...env(), ...extra },
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
  }
  function install() {
    const result =
      node(`import fs from 'node:fs';import path from 'node:path';import {createContext} from ${moduleUrl('install-state.mjs')};
      import {runInstall} from ${moduleUrl('install-worker.mjs')};${contextCode(root)}
      await runInstall(ctx,{installPackage:async candidate=>{${packageCode('candidate')}}});`);
    expect(result.status).toBe(0);
  }

  test('cold pluginServer off completes MCP initialization without npm, data, tools or instructions', () => {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(
      path.join(root, 'config/config.json'),
      JSON.stringify({ pluginServer: 'off' })
    );
    const input =
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'fixture', version: '1' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'ping' },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n';
    const result = runShim(['serve'], input, { CLAUDE_PLUGIN_DATA: 'invalid-relative-data' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const replies = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies[0].result).not.toHaveProperty('instructions');
    expect(replies[1].result).toEqual({ tools: [] });
    expect(replies[2].result).toEqual({});
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  test.each(['malformed', 'unreadable'])(
    'serve reports %s config without activating a server or network',
    (kind) => {
      fs.mkdirSync(path.join(root, 'config'));
      if (kind === 'malformed') fs.writeFileSync(path.join(root, 'config/config.json'), '{');
      else fs.mkdirSync(path.join(root, 'config/config.json'));
      const plugin = copiedPlugin(root);
      const result =
        node(`import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      let launches=0;const errors=[];const code=await run(['serve'],{env:${JSON.stringify(env())},launch:async()=>{launches++;return 6},writeError:text=>errors.push(text)});
      console.log(JSON.stringify({code,launches,errors}));`);
      expect(result.status).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.code).toBe(1);
      expect(value.launches).toBe(0);
      expect(value.errors.join('')).toContain('config.json');
    }
  );

  test('the disabled server rejects nonobject requests and remains available for valid requests', () => {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(
      path.join(root, 'config/config.json'),
      JSON.stringify({ pluginServer: 'off' })
    );
    const input =
      [null, [], 42, {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n';
    const result = runShim(['serve'], input);
    expect(result.status).toBe(0);
    const replies = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies.slice(0, 4).map((reply) => reply.error.code)).toEqual([
      -32600, -32600, -32600, -32600,
    ]);
    expect(replies[4].result).toEqual({ tools: [] });
  });

  test('cold SessionStart emits one installing JSON line; other hooks never launch npx', () => {
    const plugin = copiedPlugin(root);
    const result =
      node(`import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      let workers=0, launches=0; const lines=[];
      const options={env:${JSON.stringify(env())},startInstaller:()=>{workers++},launch:async()=>{launches++;return 2},writeOut:text=>lines.push(text),writeError:()=>{}};
      for(const verb of ['session-start','prompt','stop','pre-compact','session-end']) await run(['hook',verb,'--hook-source','rbook-plugin'],options);
      console.log(JSON.stringify({workers,launches,lines}));`);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.workers).toBe(1);
    expect(value.launches).toBe(0);
    expect(value.lines).toHaveLength(1);
    expect(JSON.parse(value.lines[0]).hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'Reasonbook is installing; the record loads from the next session',
    });
  });

  test('ready hooks preserve source arguments, record the pointer and fail open on CLI errors', () => {
    install();
    const result = runShim(['hook', 'prompt', '--hook-source', 'rbook-plugin'], '{}', {
      FIXTURE_EXIT: '7',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual([
      'hook',
      'prompt',
      '--hook-source',
      'rbook-plugin',
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'config/runtime/plugin-install.json'), 'utf8'))
        .version
    ).toBe(version);
  });

  test('Stop never forwards child stdout, even if a failing CLI writes it', () => {
    install();
    const result = runShim(['hook', 'stop', '--hook-source', 'rbook-plugin'], '{}', {
      FIXTURE_EXIT: '7',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('explicit ready CLI commands retain their normal stdout and exit status', () => {
    install();
    const result = runShim(['feedback', 'report', '--content', 'local fixture'], '', {
      FIXTURE_EXIT: '7',
    });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout).args[0]).toBe('feedback');
  });

  test('serve and explicit cold commands use the immutable manifest pin, never a moving dist-tag', () => {
    const plugin = copiedPlugin(root);
    const result =
      node(`import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      const calls=[];const options={env:${JSON.stringify(env())},launch:async(command,args,options)=>{calls.push({command,args,shell:options.shell});return 9},writeError:()=>{}};
      const serve=await run(['serve'],options);const init=await run(['init','--name','fixture'],options);
      console.log(JSON.stringify({serve,init,calls}));`);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.serve).toBe(9);
    expect(value.init).toBe(9);
    expect(value.calls[0].args).toContain(`@aquex/reasonbook@${version}`);
    expect(value.calls[1].args.slice(-3)).toEqual(['init', '--name', 'fixture']);
    expect(value.calls[0].shell).toBe(false);
  });

  test.each(['plugin data', 'shared config', 'config fallback'])(
    'cold npx uses an empty %s prefix without losing the session project',
    (kind) => {
      const plugin = copiedPlugin(root);
      const session = path.join(root, 'session');
      fs.mkdirSync(session);
      fs.writeFileSync(
        path.join(session, 'package.json'),
        JSON.stringify({ name: '@aquex/reasonbook', version })
      );
      const configDir = path.join(root, 'config');
      const pluginData = path.join(root, 'plugin data');
      const dataRoot =
        kind === 'shared config'
          ? path.join(configDir, 'plugins')
          : kind === 'plugin data'
            ? pluginData
            : configDir;
      const environment = {
        RBOOK_CONFIG_DIR: configDir,
        ...(kind !== 'config fallback' ? { CLAUDE_PLUGIN_DATA: pluginData } : {}),
        PATH: '',
      };
      const commandArgs = kind === 'shared config' ? ['init', '--name', 'fixture'] : ['serve'];
      const args =
        kind === 'shared config' ? [...commandArgs, '--install-root', 'shared'] : commandArgs;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
          const calls=[];const errors=[];
          const code=await run(${JSON.stringify(args)},{env:${JSON.stringify(environment)},writeError:text=>errors.push(text),launch:async(command,args,options)=>{
            const index=args.indexOf('--prefix');const prefix=index===-1?undefined:args[index+1];
            const exists=Boolean(prefix&&fs.existsSync(prefix));
            calls.push({command,args,cwd:options.cwd,shell:options.shell,sessionCwd:process.cwd(),prefix,exists,files:exists?fs.readdirSync(prefix):null,mode:exists?fs.statSync(prefix).mode&0o777:null});
            return 9;
          }});console.log(JSON.stringify({code,calls,errors}));`,
        ],
        { cwd: session, env: process.env, encoding: 'utf8', timeout: 15000 }
      );
      expect(result.status).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.errors).toEqual([]);
      expect(value.code).toBe(9);
      expect(value.calls).toHaveLength(1);
      const call = value.calls[0];
      const prefix = path.join(dataRoot, 'npx-prefix');
      expect(call.args).toContain('--prefix');
      expect(
        call.args.slice(call.args.indexOf('--prefix'), call.args.indexOf('--prefix') + 2)
      ).toEqual(['--prefix', prefix]);
      expect(call.prefix).toBe(prefix);
      expect(path.relative(session, prefix).startsWith(`..${path.sep}`)).toBe(true);
      expect(call.exists).toBe(true);
      expect(call.files).toEqual([]);
      if (process.platform !== 'win32') expect(call.mode).toBe(0o700);
      expect(call.cwd).toBeUndefined();
      expect(call.sessionCwd).toBe(fs.realpathSync(session));
      expect(call.command).toBe(process.execPath);
      expect(call.args).toContain(`@aquex/reasonbook@${version}`);
      expect(call.args).toContain('--prefer-offline');
      expect(call.args.slice(-commandArgs.length)).toEqual(commandArgs);
      expect(call.shell).toBe(false);
      expect(fs.readdirSync(session)).toEqual(['package.json']);
    }
  );
});

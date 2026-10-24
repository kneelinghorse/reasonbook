// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves cold startup answers promptly and preserves MCP metadata when the real server arrives.
// ABOUTME: The proxy must negotiate capabilities before readiness and keep one client handshake.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fixture, moduleUrl } from './fixtures';

test('a failed or stalled background install ends with an actionable error', () => {
  for (const mode of ['timeout', 'worker-error']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {PassThrough} from 'node:stream';import {EventEmitter} from 'node:events';
        import {installingServer} from ${moduleUrl('installing-server.mjs')};
        const worker=new EventEmitter();
        process.exitCode=await installingServer({version:'0.0.1'}, {
          input:new PassThrough(), resolveReady:()=>undefined, pollMs:10,
          installTimeoutMs:50,
          startInstaller:()=>{${mode === 'worker-error' ? "setTimeout(()=>worker.emit('exit',1),5);" : ''}return worker;}
        });`,
      ],
      { encoding: 'utf8', timeout: 2000 }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      mode === 'timeout' ? 'installation timed out' : 'installer exited 1'
    );
    expect(result.stderr).toContain('start a new session');
  }
});

test('the installing responder switches to the real server without another client handshake', async () => {
  const root = fixture();
  const marker = path.join(root, 'ready');
  const stub = path.join(root, 'server.cjs');
  fs.writeFileSync(
    stub,
    `const readline=require('node:readline');let init;
    const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize'){init=m.params;send({id:m.id,result:{protocolVersion:init.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'real',version:'1'}}});}
      else if(m.method==='tools/list')send({id:m.id,result:{tools:[{name:'actual_tool',inputSchema:{type:'object'}}]}});
      else if(m.method==='tools/call')send({id:m.id,result:{content:[{type:'text',text:JSON.stringify({init,params:m.params})}]}});
    });`
  );
  const proc = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';import {installingServer} from ${moduleUrl('installing-server.mjs')};
    await installingServer({version:'0.0.1'}, {startInstaller:()=>{},pollMs:10,
      resolveReady:()=>fs.existsSync(${JSON.stringify(marker)})?{cliPath:${JSON.stringify(stub)}}:undefined});`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const messages: any[] = [];
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + '\n');
  async function take(predicate: (message: any) => boolean) {
    // s98-m08: a hang guard; a cold node start took seconds under two concurrent full suites.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (proc.exitCode !== null) throw new Error(`Proxy exited ${proc.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No response; stderr=${stderr}`);
  }
  try {
    const init = {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'fixture', version: '1' },
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init });
    const initialized = await take((m) => m.id === 1);
    // Answered while the install is not ready (the marker is written below), which is what shows the
    // responder does not wait for it. s98-m08: the 2 s bound this replaces timed this process's own
    // cold start, 2.6 s under two concurrent full suites.
    expect(fs.existsSync(marker)).toBe(false);
    expect(initialized.result.capabilities.experimental).toEqual({
      'codex/sandbox-state-meta': {},
    });
    expect(initialized.result.instructions).toContain('new session');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await take((m) => m.id === 2)).result.tools).toEqual([]);
    fs.writeFileSync(marker, 'ready');
    await take((m) => m.method === 'notifications/tools/list_changed');
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect((await take((m) => m.id === 3)).result.tools[0].name).toBe('actual_tool');
    const params = {
      name: 'actual_tool',
      arguments: { projectRoot: 'rbook://fixture/project' },
      _meta: {
        sessionId: 'fixture-session',
        'codex/sandbox-state-meta': { sandboxCwd: 'file:///fixture' },
      },
    };
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params });
    const answer = await take((m) => m.id === 4);
    expect(JSON.parse(answer.result.content[0].text)).toEqual({ init, params });
    expect(messages.filter((m) => m.id === 1)).toEqual([]);
    expect(stderr).toBe('');
  } finally {
    proc.stdin.end();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    lines.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

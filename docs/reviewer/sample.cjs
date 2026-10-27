// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Creates a fresh fictional reviewer record through the candidate's public CLI and MCP tools.
// ABOUTME: Isolates Reasonbook configuration and credentials; rerun to reset into a new temporary folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

async function main() {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error('Usage: node sample.cjs <absolute candidate package folder> [case id]');
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
  const selected = cases.find((item) => item.id === (process.argv[3] || 'resume'));
  if (!selected) throw new Error('Unknown case id: ' + process.argv[3]);
  const seeded = selected.setup === 'seeded';
  const candidate = path.resolve(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
  if (manifest.name !== '@aquex/reasonbook')
    throw new Error('Expected the Reasonbook package folder');
  const bin = path.join(candidate, 'dist/bin.js');
  fs.accessSync(bin);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-review-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const env = {
    PATH: process.env.PATH,
    RBOOK_CONFIG_DIR: path.join(root, 'config'),
    RBOOK_CHECKPOINT_SYNC: 'off',
    RBOOK_SHARED_SYNC: 'off',
    RBOOK_DASHBOARD_SHARING: 'off',
    RBOOK_OFFLINE_EMBEDDINGS: '1',
    RBOOK_AMBIENT: 'off',
    RBOOK_DASHBOARD_URL: 'http://127.0.0.1:1',
  };
  if (seeded) {
    const init = spawnSync(
      process.execPath,
      [bin, 'init', '--level', 'ledger', '--no-hooks', '--name', 'Cedar Reading Log'],
      {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    if (init.status !== 0)
      throw new Error(init.stderr || init.error?.message || 'Sample init failed');
  }
  // A launch wrapper replaces the environment instead of merging a client's dashboard credentials.
  const launcher = path.join(root, 'server.cjs');
  fs.writeFileSync(
    launcher,
    `const {spawnSync}=require('node:child_process');\nconst r=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify([bin, 'serve'])},${JSON.stringify({ cwd: project, env, stdio: 'inherit' })});\nif(r.error)console.error(r.error.message);\nprocess.exit(r.status===null?1:r.status);\n`
  );
  const config = { mcpServers: { rbook: { command: process.execPath, args: [launcher] } } };
  fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify(config, null, 2) + '\n');
  const child = spawn(process.execPath, [launcher], {
    env,
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve(message);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out: ${method}`));
      }, 30000);
      pending.set(requestId, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  }
  async function call(name, args) {
    const response = await request('tools/call', {
      name,
      arguments: { ...args, projectRoot: project },
    });
    const result = response.result?.structuredContent;
    if (response.error || result?.success !== true) throw new Error(JSON.stringify(response));
    return result;
  }
  let report;
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'reasonbook-review-sample', version: '1.0.0' },
    });
    if (initialized.error) throw new Error(JSON.stringify(initialized.error));
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    );
    const decision = seeded
      ? await call('rbook_decisions', {
          action: 'record',
          mode: 'autonomous',
          content:
            'Use SQLite for Cedar Reading Log because it works offline and keeps reading entries portable.',
        })
      : null;
    const nextStep = seeded
      ? await call('rbook_session', {
          action: 'capture',
          category: 'next-step',
          content: 'Catalog the first five fictional books in Cedar Reading Log.',
        })
      : null;
    const review = seeded ? await call('rbook_review', {}) : null;
    report = {
      root,
      project,
      missingProject: path.join(project, 'does-not-exist'),
      case: selected.id,
      setup: selected.setup,
      prompt: selected.prompt.replace('{missing}', path.join(project, 'does-not-exist')),
      candidate,
      version: manifest.version,
      build: JSON.parse(fs.readFileSync(path.join(candidate, 'dist/.build-manifest.json'), 'utf8')),
      config,
      decision,
      nextStep,
      review,
    };
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    await exited;
    clearTimeout(timer);
    lines.close();
    fs.writeFileSync(path.join(root, 'server-stderr.txt'), stderr);
  }
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

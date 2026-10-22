// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stops real stdio server children while their loopback dashboard upload is still pending.
// ABOUTME: Proves graceful shutdown removes only the process's upload copy and preserves its source.

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { RawStdioServer } from '../../helpers/raw-stdio-server';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const repo = path.resolve(__dirname, '../../..');
let directory: string;
let child: RawStdioServer | undefined;
let dashboard: http.Server | undefined;
let compiled: string;

/**
 * s98-m08 (#733): load the TypeScript source, compiled once per test file. Each child used to
 * transpile src/index.ts and its imports itself inside its 25 s budget, and under two concurrent
 * full suites that alone spent it ("Upload did not start"). The children now read what the warm-up
 * below compiled, keyed by path and content, so the budget covers starting and uploading only.
 */
const loader = (): string => `const fs = require('fs');
const crypto = require('crypto');
const ts = require(${JSON.stringify(require.resolve('typescript'))});
require.extensions['.ts'] = (module, file) => {
  const source = fs.readFileSync(file, 'utf8');
  const key = crypto.createHash('sha256').update(file).update(source).digest('hex');
  const cached = require('path').join(${JSON.stringify(compiled)}, key + '.js');
  let output;
  try {
    output = fs.readFileSync(cached, 'utf8');
  } catch {
    output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText;
    fs.writeFileSync(cached + '.' + process.pid, output);
    fs.renameSync(cached + '.' + process.pid, cached);
  }
  module._compile(output, file);
};
`;

beforeAll(() => {
  compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-shutdown-compiled-'));
  const warm = spawnSync(
    process.execPath,
    [
      '-e',
      `${loader()}
for (const file of ['src/index.ts', 'src/tools/rbook/dashboard-client.ts', 'src/tools/rbook/dashboard-upload.ts'])
  require(require('path').join(${JSON.stringify(repo)}, file));`,
    ],
    {
      encoding: 'utf8',
      timeout: 150_000,
      env: {
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        RBOOK_CONFIG_DIR: path.join(compiled, 'config'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        RBOOK_SHARED_SYNC: 'off',
      },
    }
  );
  expect({ status: warm.status, signal: warm.signal, stderr: warm.stderr }).toEqual({
    status: 0,
    signal: null,
    stderr: '',
  });
}, 180_000);

afterAll(() => fs.rmSync(compiled, { recursive: true, force: true }));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-shutdown-'));
});

afterEach(async () => {
  if (child && child.child.exitCode === null && child.child.signalCode === null) {
    await child.close('SIGTERM');
  }
  child = undefined;
  if (dashboard) {
    dashboard.closeAllConnections();
    await new Promise<void>((resolve) => dashboard!.close(() => resolve()));
  }
  dashboard = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['SIGINT', 'SIGTERM', 'stdin close'] as const)(
  '%s removes a pending upload copy before exiting, without touching another process or the source',
  async (shutdown) => {
    const project = path.join(directory, 'project');
    seedRbookDb(project, { projectId: 'shutdown-test', projectName: 'Shutdown test' });
    const tmp = path.join(directory, 'tmp');
    fs.mkdirSync(tmp);
    const otherCopy = path.join(tmp, 'rbook-dashboard-upload-other-process');
    fs.mkdirSync(otherCopy);
    fs.writeFileSync(path.join(otherCopy, 'rbook.sqlite'), 'another process owns this copy');
    const source = path.join(directory, 'source.sqlite');
    const db = new Database(source);
    db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('keep the source');");
    db.close();
    const before = fs.readFileSync(source);

    let received!: () => void;
    const uploading = new Promise<void>((resolve) => {
      received = resolve;
    });
    dashboard = http.createServer((request, response) => {
      if (request.url !== '/api/sync/sqlite-backfill') {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once('end', received);
      // Keep the upload pending until shutdown; finally-based cleanup cannot run yet.
    });
    await new Promise<void>((resolve) => dashboard!.listen(0, '127.0.0.1', resolve));
    const port = (dashboard.address() as { port: number }).port;

    // Load actual TypeScript without writing the real dist or mocking server lifecycle, from the
    // source the warm-up compiled.
    const bootstrap = path.join(directory, 'server.cjs');
    fs.writeFileSync(
      bootstrap,
      `${loader()}
(async () => {
  await require(${JSON.stringify(path.join(repo, 'src/index.ts'))}).__test__.main(['--project-root', ${JSON.stringify(project)}]);
  const { DashboardClient } = require(${JSON.stringify(path.join(repo, 'src/tools/rbook/dashboard-client.ts'))});
  const { withUploadSnapshot } = require(${JSON.stringify(path.join(repo, 'src/tools/rbook/dashboard-upload.ts'))});
  const resolved = await DashboardClient.fromEnvForProject(${JSON.stringify(project)}, {
    baseUrl: 'http://127.0.0.1:${port}', apiKey: 'test-upload-shutdown'
  });
  if (!resolved.success) throw new Error(JSON.stringify(resolved.error));
  await withUploadSnapshot(${JSON.stringify(source)}, (file) => resolved.data.client.syncSqliteFile(file, 'shutdown-test'));
})().catch((error) => { console.error(error); process.exit(1); });
`
    );
    child = new RawStdioServer(bootstrap, directory, {
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      RBOOK_PROJECT_ROOT: project,
      RBOOK_CONFIG_DIR: path.join(directory, 'config'),
      RBOOK_AGENT_ROLE: 'review',
      RBOOK_CHECKPOINT_SYNC: 'off',
      RBOOK_SHARED_SYNC: 'off',
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        uploading,
        child.exited.then((code) => {
          throw new Error(`Server exited before uploading (${code}): ${child!.stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Upload did not start: ${child!.stderr}`)),
            25000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const copies = fs
      .readdirSync(tmp)
      .filter((name) => name.startsWith('rbook-dashboard-upload-'))
      .map((name) => path.join(tmp, name));
    expect(copies).toHaveLength(2);
    const ownCopy = copies.find((copy) => copy !== otherCopy)!;
    expect(fs.existsSync(path.join(ownCopy, LEGACY.databaseFile))).toBe(true);

    const exit = await child.close(shutdown === 'stdin close' ? undefined : shutdown);
    expect({ exit, copyRemains: fs.existsSync(ownCopy) }).toEqual({
      exit: 0,
      copyRemains: false,
    });
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readFileSync(path.join(otherCopy, 'rbook.sqlite'), 'utf8')).toBe(
      'another process owns this copy'
    );
  },
  45000
);

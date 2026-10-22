// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s98-m08 (#751): the session-start hook run from source loads neither zod nor the merge, so a value import
// ABOUTME: that pulls either into the hook fails npm test, not first the packed E2E at release (learning #508).

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedRbookDb } from '../helpers/seedRbookDb';

const REPO = path.resolve(__dirname, '../..');
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-start-graph-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Graph {
  code: number;
  stdout: string;
  loaded: string[];
}

/**
 * Runs `hook session-start` from source in a fresh process, as the bin's `import('./cli')` does,
 * and returns every module it loaded after the source loader. tests/e2e/hook-cli.e2e.ts checks the
 * same on the packed build; this check runs on every npm test.
 */
function sessionStartGraph(): Graph {
  const project = path.join(tmp, 'project');
  seedRbookDb(project, { projectName: 'start graph' });
  const probe = `
    require(${JSON.stringify(path.join(REPO, 'tests', 'helpers', 'ts-register.js'))});
    const before = new Set(Object.keys(require.cache));
    const { runCli } = require(${JSON.stringify(path.join(REPO, 'src', 'cli.ts'))});
    let stdout = '';
    runCli(['hook', 'session-start'], {
      env: process.env,
      cwd: ${JSON.stringify(project)},
      // Room a loaded machine cannot spend (#1558): a hook out of its 3 s would load less than it should.
      startedAtMs: Date.now() + 20000,
      readStdin: async () =>
        JSON.stringify({ session_id: 'start-graph', source: 'startup', cwd: ${JSON.stringify(project)} }),
      stdout: (text) => { stdout += text; },
      stderr: () => {},
    }).then((code) => {
      const loaded = Object.keys(require.cache).filter((file) => !before.has(file));
      process.stdout.write(JSON.stringify({ code, stdout, loaded }));
    });
  `;
  const ran = spawnSync(process.execPath, ['-e', probe], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PID: '777777' },
  });
  expect({
    status: ran.status,
    signal: ran.signal,
    stderr: ran.status === 0 ? '' : ran.stderr,
  }).toEqual({ status: 0, signal: null, stderr: '' });
  return JSON.parse(ran.stdout) as Graph;
}

it('hook session-start loads neither zod nor the merge, and does load the digest reader', () => {
  const { code, stdout, loaded } = sessionStartGraph();
  expect(code).toBe(0);
  const files = loaded.map((file) => path.relative(REPO, file));
  expect(files.filter((file) => /(^|[\\/])node_modules[\\/]zod[\\/]/.test(file))).toEqual([]);
  expect(
    files.filter((file) => file === path.join('src', 'tools', 'rbook', 'record-apply.ts'))
  ).toEqual([]);
  // Non-vacuity: the hook delivered its digest and loaded the digest's own reader, so a recorder
  // that saw nothing, or a hook that failed open early, cannot pass the two checks above.
  expect(stdout).toContain('start graph');
  expect(files).toContain(path.join('src', 'tools', 'rbook', 'record-since.ts'));
}, 90_000);

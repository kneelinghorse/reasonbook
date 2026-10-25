// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Attribute a failed request to the real reference child that previously owned its URL.
// ABOUTME: Verify child runtime flags and retained exit evidence without reproducing a V8 crash.
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { request, spawnRefereeServer, type RunningServer } from '../helpers/referee-http';

test('a real child accepts the containment flag and identifies its unexpected post-readiness exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-referee-diagnostics-'));
  let server: RunningServer | undefined;
  try {
    server = await spawnRefereeServer(root, { root, accounts: {}, projects: {} });
    expect((await request(server, '/api/projects/me')).status).toBe(401);
    const exited = once(server.child, 'exit');
    expect(server.child.kill('SIGKILL')).toBe(true);
    await exited;
    const failure = await request(server, '/api/projects/me').catch((error: Error) => error);
    expect(failure).toHaveProperty('message');
    const message = (failure as Error).message;
    expect(message).toContain('reference server: ');
    const details = JSON.parse(message.split('reference server: ')[1]);
    expect(details).toMatchObject({
      pid: server.child.pid,
      url: server.url,
      startedAt: expect.any(String),
      readyAt: expect.any(String),
      exitedAt: expect.any(String),
      exitCode: null,
      signalCode: 'SIGKILL',
      stopRequestedAt: null,
      runtime: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        execArgv: expect.arrayContaining(['--no-concurrent-sparkplug']),
      },
      stderr: expect.any(String),
      stderrTruncated: false,
    });
    expect(Date.parse(details.startedAt)).toBeLessThanOrEqual(Date.parse(details.readyAt));
    expect(Date.parse(details.readyAt)).toBeLessThanOrEqual(Date.parse(details.exitedAt));
  } finally {
    await server?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

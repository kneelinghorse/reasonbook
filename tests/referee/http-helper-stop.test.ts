// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keep repeated reference-server cleanup from waiting for an exit that already happened.
// ABOUTME: Signal exits leave exitCode null, so both Node termination states must end cleanup.
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { spawnRefereeServer } from '../helpers/referee-http';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

test.each(['normal', 'signal'] as const)(
  'a second cleanup resolves after %s termination without signaling the dead child',
  async (termination) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-referee-stop-'));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = jest.fn(() => false);
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill,
    });
    (spawn as jest.Mock).mockReturnValue(child as unknown as ChildProcess);
    try {
      const starting = spawnRefereeServer(root, { root, accounts: {}, projects: {} });
      stdout.write(
        JSON.stringify({
          port: 0,
          engine: { path: 'fixture', version: 'fixture', protocol: { wire: 1, record: 2 } },
        }) + '\n'
      );
      const server = await starting;
      kill.mockImplementationOnce(() => {
        child.exitCode = termination === 'normal' ? 0 : null;
        child.signalCode = termination === 'signal' ? 'SIGTERM' : null;
        child.emit('exit', child.exitCode, child.signalCode);
        return true;
      });
      await server.stop();
      const stoppedAgain = jest.fn();
      void server.stop().then(stoppedAgain);
      await Promise.resolve();
      expect(stoppedAgain).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      stdout.end();
      stderr.end();
      fs.rmSync(root, { recursive: true, force: true });
      jest.clearAllMocks();
    }
  }
);

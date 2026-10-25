// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keep repeated reference-server cleanup finite and distinguish it from an unexpected exit.
// ABOUTME: Preserve child runtime and bounded stderr evidence when a later network request fails.
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { httpPeer, request, spawnRefereeServer } from '../helpers/referee-http';

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
      pid: process.pid + 1,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill,
    });
    (spawn as jest.Mock).mockReturnValue(child as unknown as ChildProcess);
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('fixture network failure'));
    try {
      const starting = spawnRefereeServer(root, { root, accounts: {}, projects: {} });
      stdout.write(
        JSON.stringify({
          port: 0,
          engine: { path: 'fixture', version: 'fixture', protocol: { wire: 1, record: 2 } },
          runtime: {
            nodeVersion: 'child-node',
            v8Version: 'child-v8',
            execArgv: ['--no-concurrent-sparkplug'],
          },
          readyAt: new Date().toISOString(),
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
      const failure = await request(server, '/').catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('reference server: ');
      const details = JSON.parse(message.split('reference server: ')[1]);
      expect(details).toMatchObject({
        pid: child.pid,
        url: server.url,
        exitCode: termination === 'normal' ? 0 : null,
        signalCode: termination === 'signal' ? 'SIGTERM' : null,
        stopRequestedAt: expect.any(String),
        exitedAt: expect.any(String),
      });
      expect(Date.parse(details.stopRequestedAt)).toBeLessThanOrEqual(Date.parse(details.exitedAt));
    } finally {
      fetch.mockRestore();
      stdout.end();
      stderr.end();
      fs.rmSync(root, { recursive: true, force: true });
      jest.clearAllMocks();
    }
  }
);

test('a child dying after readiness keeps its own runtime and bounded stderr for the failing request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-referee-exit-'));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid + 1,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: jest.fn(),
  });
  (spawn as jest.Mock).mockReturnValue(child as unknown as ChildProcess);
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('fixture network failure'));
  try {
    const starting = spawnRefereeServer(root, { root, accounts: {}, projects: {} });
    const readyAt = new Date().toISOString();
    stdout.write(
      JSON.stringify({
        port: 34567,
        engine: { path: 'fixture', version: 'fixture', protocol: { wire: 1, record: 2 } },
        runtime: {
          nodeVersion: 'actual-child-node',
          v8Version: 'actual-child-v8',
          execArgv: ['--no-concurrent-sparkplug'],
        },
        readyAt,
      }) + '\n'
    );
    const server = await starting;
    stderr.write(`old stderr ${'x'.repeat(100_000)} final crash evidence`);
    child.signalCode = 'SIGSEGV';
    child.emit('exit', null, 'SIGSEGV');
    const failure = await request(server, '/').catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('fixture network failure');
    expect(message).toContain('reference server: ');
    const details = JSON.parse(message.split('reference server: ')[1]);
    expect(details).toMatchObject({
      pid: child.pid,
      url: server.url,
      startedAt: expect.any(String),
      readyAt,
      exitedAt: expect.any(String),
      exitCode: null,
      signalCode: 'SIGSEGV',
      stopRequestedAt: null,
      runtime: {
        nodeVersion: 'actual-child-node',
        v8Version: 'actual-child-v8',
        execArgv: ['--no-concurrent-sparkplug'],
      },
      stderrTruncated: true,
    });
    expect(Date.parse(details.startedAt)).toBeLessThanOrEqual(Date.parse(readyAt));
    expect(Date.parse(readyAt)).toBeLessThanOrEqual(Date.parse(details.exitedAt));
    expect(details.stderr).toHaveLength(8192);
    expect(details.stderr).not.toContain('old stderr');
    expect(details.stderr).toContain('final crash evidence');
    await server.stop();
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    stdout.end();
    stderr.end();
    fs.rmSync(root, { recursive: true, force: true });
    jest.clearAllMocks();
  }
});

test('URL-only fixtures preserve the original request and peer failures without inventing child evidence', async () => {
  const failure = new Error('in-process fixture network failure');
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(failure);
  try {
    const server = { url: 'http://127.0.0.1:34567' };
    await expect(request(server, '/')).rejects.toBe(failure);
    const peer = httpPeer(
      server,
      'project',
      'token',
      async () => 'copy',
      async () => {
        throw new Error('chains must not ask for a hello');
      }
    );
    await expect(peer.chains({})).rejects.toBe(failure);
  } finally {
    fetch.mockRestore();
  }
});

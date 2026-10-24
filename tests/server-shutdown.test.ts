// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies the process drain deadline, signal escalation, and cleanup ordering.
// ABOUTME: Accepted uploads retain their full grace period while shutdown stays bounded.

import { EventEmitter } from 'events';
import { createServerShutdown, installStderrPipeGuard } from '../src/server-shutdown';

function fixture() {
  const events: string[] = [];
  let finishUpload!: () => void;
  const upload = new Promise<void>((resolve) => (finishUpload = resolve));
  const shutdown = createServerShutdown({
    stop: () => events.push('stop'),
    drain: () => upload,
    interrupt: () => events.push('interrupt'),
    cleanup: () => events.push('cleanup'),
    close: async () => {
      events.push('close');
    },
    exit: () => {
      events.push('exit');
    },
    report: () => {
      events.push('error');
    },
  });
  return { shutdown, events, finishUpload };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('keeps copies and claims available until an accepted upload finishes', async () => {
  const { shutdown, events, finishUpload } = fixture();
  const ended = shutdown('stdin close');
  await jest.advanceTimersByTimeAsync(300);
  expect(events).toEqual(['stop']);
  finishUpload();
  await ended;
  expect(events).toEqual(['stop', 'interrupt', 'cleanup', 'close', 'exit']);
  expect(jest.getTimerCount()).toBe(0);
});

it('gives stdin twenty seconds before releasing stalled leases and removing copies', async () => {
  const { shutdown, events } = fixture();
  const ended = shutdown('stdin close');
  await jest.advanceTimersByTimeAsync(19_999);
  expect(events).toEqual(['stop']);
  await jest.advanceTimersByTimeAsync(1);
  await ended;
  expect(events).toEqual(['stop', 'interrupt', 'cleanup', 'close', 'exit']);
});

it.each(['SIGINT', 'SIGTERM'] as const)('bounds %s draining to 1.5 seconds', async (signal) => {
  const { shutdown, events } = fixture();
  const ended = shutdown(signal);
  await jest.advanceTimersByTimeAsync(1_499);
  expect(events).toEqual(['stop']);
  await jest.advanceTimersByTimeAsync(1);
  await ended;
  expect(events[events.length - 1]).toBe('exit');
});

it('a signal shortens an existing stdin drain without restarting its deadline', async () => {
  const { shutdown, events } = fixture();
  const ended = shutdown('stdin close');
  await jest.advanceTimersByTimeAsync(500);
  void shutdown('SIGTERM');
  await jest.advanceTimersByTimeAsync(1_499);
  expect(events).toEqual(['stop']);
  await jest.advanceTimersByTimeAsync(1);
  await ended;
  expect(events[events.length - 1]).toBe('exit');
});

it('a late signal never lengthens the stdin deadline', async () => {
  const { shutdown, events } = fixture();
  const ended = shutdown('stdin close');
  await jest.advanceTimersByTimeAsync(19_500);
  void shutdown('SIGTERM');
  await jest.advanceTimersByTimeAsync(500);
  await ended;
  expect(events[events.length - 1]).toBe('exit');
});

it('a second signal releases leases and exits immediately without awaiting transport cleanup', async () => {
  const { shutdown, events } = fixture();
  const ended = shutdown('SIGTERM');
  await jest.advanceTimersByTimeAsync(1);
  await shutdown('SIGINT');
  await ended;
  expect(events).toEqual(['stop', 'interrupt', 'cleanup', 'exit']);
});

it('handles a closed stderr pipe once without hiding other stream failures', () => {
  const stderr = new EventEmitter();
  installStderrPipeGuard(stderr);
  installStderrPipeGuard(stderr);
  expect(stderr.listenerCount('error')).toBe(1);
  expect(() =>
    stderr.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }))
  ).not.toThrow();
  expect(() => stderr.emit('error', new Error('unexpected'))).toThrow('unexpected');
});

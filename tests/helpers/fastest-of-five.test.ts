// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves bounded timing resampling uses the fastest successful sample and stops early.
// ABOUTME: Deterministic durations distinguish scheduling retries from swallowed behavior failures.

import { fastestOfFive } from './fastest-of-five';

it('stops after the first sample below the budget', async () => {
  const sample = jest.fn(() => 4);
  expect(await fastestOfFive(sample, 5)).toBe(4);
  expect(sample).toHaveBeenCalledTimes(1);
});

it('waits for sequential asynchronous samples and stops at the first success', async () => {
  const durations = [8, 7, 4];
  let active = false;
  const sample = jest.fn(async () => {
    expect(active).toBe(false);
    active = true;
    await Promise.resolve();
    active = false;
    return durations.shift()!;
  });
  expect(await fastestOfFive(sample, 5)).toBe(4);
  expect(sample).toHaveBeenCalledTimes(3);
});

it('does not treat equality with a strict upper bound as success', async () => {
  const sample = jest.fn().mockReturnValueOnce(5).mockReturnValue(4);
  expect(await fastestOfFive(sample, 5)).toBe(4);
  expect(sample).toHaveBeenCalledTimes(2);
});

it('returns the fastest of exactly five slow samples so a consistent regression stays red', async () => {
  const durations = [9, 8, 6, 7, 10, 1];
  const sample = jest.fn(() => durations.shift()!);
  expect(await fastestOfFive(sample, 5)).toBe(6);
  expect(sample).toHaveBeenCalledTimes(5);
});

it('propagates assertion failure without trying another sample', async () => {
  const sample = jest.fn(() => {
    expect('wrong behavior').toBe('expected behavior');
    return 1;
  });
  await expect(fastestOfFive(sample, 5)).rejects.toThrow('expected behavior');
  expect(sample).toHaveBeenCalledTimes(1);
});

it('propagates cleanup failure without trying another sample', async () => {
  const failure = new Error('close failed');
  const sample = jest.fn(async () => {
    try {
      return 1;
    } finally {
      await Promise.reject(failure);
    }
  });
  await expect(fastestOfFive(sample, 5)).rejects.toBe(failure);
  expect(sample).toHaveBeenCalledTimes(1);
});

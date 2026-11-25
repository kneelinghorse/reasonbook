// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps adjacent-npm integration fixtures on the already running Node executable.
// ABOUTME: Proves fixture-local execPath, safe hardlinks and explicit copy fallback without source writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture, fixtureNode, linkOrCopyFixtureNode } from './fixtures';

const sourceState = () => ({
  mode: fs.statSync(process.execPath).mode,
  hash: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
});

function expectStandaloneNode(file: string) {
  const child = spawnSync(file, ['-p', 'process.execPath'], {
    env: { PATH: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect({
    status: child.status,
    signal: child.signal,
    error: child.error,
    stderr: child.stderr,
  }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
  expect(child.stdout.trim()).toBe(fs.realpathSync(file));
}

const ownedRoots: string[] = [];
const ownedFixture = () => {
  const root = fixture();
  ownedRoots.push(root);
  return root;
};
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('keeps Node and its adjacent npm fixture together without rewriting the source executable', () => {
  const root = ownedFixture();
  const before = sourceState();
  const link = fs.linkSync;
  let linked = false;
  const links = jest.spyOn(fs, 'linkSync').mockImplementation((...args) => {
    link(...args);
    linked = true;
  });
  const chmod = jest.spyOn(fs, 'chmodSync');
  try {
    const file = fixtureNode(root);
    const config = process.config.variables;
    const sharedDarwin =
      process.platform === 'darwin' && 'node_shared' in config && config.node_shared === true;
    expect(links).toHaveBeenCalledTimes(sharedDarwin ? 0 : 1);
    if (sharedDarwin) expect(fs.statSync(file).ino).not.toBe(fs.statSync(process.execPath).ino);
    if (linked) {
      expect(fs.statSync(file).ino).toBe(fs.statSync(process.execPath).ino);
      expect(chmod).not.toHaveBeenCalled();
    }
    expectStandaloneNode(file);
    expect(sourceState()).toEqual(before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(sourceState()).toEqual(before);
});

it('can start one fixture while a second fixture removes its adjacent files', () => {
  const first = fixtureNode(ownedFixture());
  const secondRoot = ownedFixture();
  const second = fixtureNode(secondRoot);
  expectStandaloneNode(first);
  expectStandaloneNode(second);
  // Reproduce the interval in which cleanup has removed the second library but not its executable.
  for (const entry of fs.readdirSync(secondRoot)) {
    if (entry !== path.basename(second)) fs.unlinkSync(path.join(secondRoot, entry));
  }
  expectStandaloneNode(first);
});

it.each(['EXDEV', 'EPERM'])(
  'copies only the fixture when hardlinking is unavailable: %s',
  (code) => {
    const root = ownedFixture();
    const before = sourceState();
    // Keep this runtime's loader dependencies in place while exercising the portable fallback.
    const local = fixtureNode(root);
    const file = path.join(root, 'fallback-' + path.basename(local));
    const links = jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('fixture cannot link this executable'), { code });
    });
    try {
      linkOrCopyFixtureNode(file);
      expect(links).toHaveBeenCalledTimes(1);
      expect(fs.statSync(file).ino).not.toBe(fs.statSync(process.execPath).ino);
      expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(before.hash);
      expect(fs.statSync(file).mode & 0o777).toBe(0o755);
      expectStandaloneNode(file);
      expect(sourceState()).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

it('surfaces an unexpected link failure rather than copying over a broken fixture', () => {
  const root = ownedFixture();
  const error = Object.assign(new Error('unexpected failure'), { code: 'EIO' });
  jest.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw error;
  });
  const copy = jest.spyOn(fs, 'copyFileSync');
  try {
    expect(() => linkOrCopyFixtureNode(path.join(root, 'node'))).toThrow(error);
    expect(copy).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

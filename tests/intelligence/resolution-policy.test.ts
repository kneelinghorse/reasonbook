// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m01 unit tests for the shared resolution rules: walk-up with a $HOME ceiling, the
// ABOUTME: narrow contextless test, --project-root parsing, and the ephemeral-path predicate.

import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import {
  RBOOK_EPHEMERAL_PATHS_ENV,
  defaultEphemeralRoots,
  findEnclosingStore,
  isContextlessDirectory,
  isEphemeralStorePath,
  parseProjectRootArg,
  storeAt,
} from '../../src/intelligence/resolution-policy';

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(root: string, withDatabase = true): void {
  fs.mkdirSync(path.join(root, 'rbook', 'db'), { recursive: true });
  if (withDatabase) fs.writeFileSync(path.join(root, 'rbook', 'db', 'rbook.sqlite'), '');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('findEnclosingStore', () => {
  it('finds a store in the directory itself', () => {
    const root = mkTmp('policy-self-');
    makeStore(root);
    expect(findEnclosingStore(root)).toEqual({ root, hasDatabase: true });
  });

  it('walks up from a nested folder to the nearest store, the way git finds .git', () => {
    const root = mkTmp('policy-nested-');
    makeStore(root);
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findEnclosingStore(nested)).toEqual({ root, hasDatabase: true });
  });

  it('stops at a store whose database is gone (rbook/db/ without the file)', () => {
    // Continuing past it would route a call made inside the inner project to the outer one.
    const outer = mkTmp('policy-outer-');
    makeStore(outer);
    const inner = path.join(outer, 'inner');
    makeStore(inner, false);
    const nested = path.join(inner, 'src');
    fs.mkdirSync(nested, { recursive: true });
    expect(findEnclosingStore(nested)).toEqual({ root: inner, hasDatabase: false });
  });

  it('walks past a folder that merely contains a directory named rbook (no rbook/db/)', () => {
    // This repository has src/tools/rbook/; a notes tree may have rbook/ full of papers. Neither is
    // a project, and stopping there would offer to init a project inside the source tree.
    const project = mkTmp('policy-source-tree-');
    makeStore(project);
    const sourceDir = path.join(project, 'src', 'tools');
    fs.mkdirSync(path.join(sourceDir, 'rbook'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'rbook', 'client.ts'), '// source, not a store\n');
    expect(findEnclosingStore(sourceDir)).toEqual({ root: project, hasDatabase: true });
    expect(storeAt(sourceDir)).toBeNull();
  });

  it('ignores a FILE named rbook', () => {
    const root = mkTmp('policy-file-');
    fs.writeFileSync(path.join(root, 'rbook'), 'not a directory');
    expect(findEnclosingStore(root)).toBeNull();
  });

  it('never examines $HOME from below it, so a store there cannot capture every subfolder', () => {
    const home = mkTmp('policy-home-');
    makeStore(home);
    const work = path.join(home, 'projects', 'new');
    fs.mkdirSync(work, { recursive: true });
    expect(findEnclosingStore(work, { homeDir: home })).toBeNull();
    // From $HOME itself, the store there is found.
    expect(findEnclosingStore(home, { homeDir: home })).toEqual({ root: home, hasDatabase: true });
  });

  it('keeps the $HOME ceiling when $HOME is spelled through a symlink', () => {
    const realHome = mkTmp('policy-real-home-');
    makeStore(realHome);
    const work = path.join(realHome, 'projects', 'new');
    fs.mkdirSync(work, { recursive: true });
    const linkParent = mkTmp('policy-home-link-');
    const homeLink = path.join(linkParent, 'home');
    fs.symlinkSync(realHome, homeLink);
    // The caller's cwd uses the physical spelling; $HOME uses the symlink.
    expect(findEnclosingStore(work, { homeDir: homeLink })).toBeNull();
  });
});

describe('isContextlessDirectory', () => {
  it('is true only for the filesystem root, $HOME and the install root', () => {
    const home = mkTmp('policy-ctx-home-');
    const install = mkTmp('policy-ctx-install-');
    const working = mkTmp('policy-ctx-working-');
    const opts = { homeDir: home, installRoot: install };

    expect(isContextlessDirectory('/', opts)).toBe(true);
    expect(isContextlessDirectory(home, opts)).toBe(true);
    expect(isContextlessDirectory(install, opts)).toBe(true);
    expect(isContextlessDirectory(working, opts)).toBe(false);
    expect(isContextlessDirectory(path.join(home, 'sub'), opts)).toBe(false);
  });
});

describe('parseProjectRootArg', () => {
  it('reads --project-root <dir> and --project-root=<dir>, resolving the path', () => {
    expect(parseProjectRootArg(['node', 'index.js', '--project-root', '/repos/a'])).toBe(
      '/repos/a'
    );
    expect(parseProjectRootArg(['node', 'index.js', '--project-root=/repos/b'])).toBe('/repos/b');
    expect(parseProjectRootArg(['node', 'index.js', '--project-root', 'rel'])).toBe(
      path.resolve('rel')
    );
  });

  it('returns undefined when the flag is absent, empty, or followed by another flag', () => {
    expect(parseProjectRootArg(['node', 'index.js'])).toBeUndefined();
    expect(parseProjectRootArg(['node', 'index.js', '--project-root='])).toBeUndefined();
    expect(parseProjectRootArg(['node', 'index.js', '--project-root'])).toBeUndefined();
    expect(parseProjectRootArg(['node', 'index.js', '--project-root', '--whoami'])).toBeUndefined();
  });
});

describe('isEphemeralStorePath', () => {
  it('flags a harness scratchpad path and a short /tmp probe path', () => {
    // macOS os.tmpdir() can be /var/folders/…/T, so a tmpdir-only predicate misses
    // these other temporary roots. The harness path keeps the reported structure.
    expect(
      isEphemeralStorePath(
        '/private/tmp/claude-501/-Users-example-work-project/00000000-0000-4000-8000-000000000001/scratchpad/proj'
      )
    ).toBe(true);
    expect(isEphemeralStorePath('/tmp/probe89')).toBe(true);
  });

  it('flags a store under os.tmpdir() and leaves a durable project alone', () => {
    expect(isEphemeralStorePath(path.join(os.tmpdir(), 'scratch-store'))).toBe(true);
    expect(isEphemeralStorePath(['', 'Users', 'someone', 'portfolio', 'project'].join('/'))).toBe(
      false
    );
  });

  it('adds the RBOOK_EPHEMERAL_PATHS list to the defaults', () => {
    const roots = defaultEphemeralRoots({
      [RBOOK_EPHEMERAL_PATHS_ENV]: ['/scratch/agents', '/mnt/ci'].join(path.delimiter),
    });
    expect(isEphemeralStorePath('/scratch/agents/run-1/proj', roots)).toBe(true);
    expect(isEphemeralStorePath('/mnt/ci/job/proj', roots)).toBe(true);
    expect(isEphemeralStorePath('/tmp/still-default', roots)).toBe(true);
    expect(isEphemeralStorePath('/srv/project', roots)).toBe(false);
  });
});

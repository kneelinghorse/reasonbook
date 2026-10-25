// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The build-manifest generator, run for real against a temporary dist/ (s92-m10): it must
// ABOUTME: hash every .js file with its path, and a test run must never rewrite the real manifest.

/**
 * The earlier version of this file hashed buffers with `crypto` and asserted crypto's own
 * behaviour, then ran the real script against the REAL dist/, so every full `jest` run rewrote
 * dist/.build-manifest.json with a new buildTime (feedback #31). The server compares that
 * manifest with the one it started from to report a stale build, so a test run could make a
 * running server report itself stale. The script now takes `--dist <dir>`, and every case here
 * runs it against a temporary directory. tests/jest-global-teardown.ts checks the real manifest
 * is byte-identical after the whole suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-build-manifest.js');
const REAL_MANIFEST = path.join(REPO_ROOT, 'dist', '.build-manifest.json');

interface Manifest {
  buildHash: string;
  buildTime: string;
  fileCount: number;
}

let distDir: string;
let realManifestBefore: Buffer | null = null;

beforeAll(() => {
  realManifestBefore = fs.existsSync(REAL_MANIFEST) ? fs.readFileSync(REAL_MANIFEST) : null;
});

afterAll(() => {
  const after = fs.existsSync(REAL_MANIFEST) ? fs.readFileSync(REAL_MANIFEST) : null;
  expect(after?.equals(realManifestBefore ?? Buffer.alloc(0)) ?? realManifestBefore === null).toBe(
    true
  );
});

beforeEach(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-manifest-test-'));
});

afterEach(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(distDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(distDir, rel), content);
}

function generate(): Manifest {
  execFileSync(process.execPath, [SCRIPT, '--root', distDir, '--dist', distDir], { stdio: 'pipe' });
  return JSON.parse(
    fs.readFileSync(path.join(distDir, '.build-manifest.json'), 'utf8')
  ) as Manifest;
}

/** The documented hash: every .js file, sorted by path, its relative path then its bytes. */
function expectedHash(files: Record<string, string>): string {
  const hash = crypto.createHash('sha256');
  for (const rel of Object.keys(files).sort()) {
    hash.update(rel);
    hash.update(Buffer.from(files[rel]));
  }
  return hash.digest('hex');
}

describe('generate-build-manifest', () => {
  it('hashes every .js file under the given dist, by path and content, and counts them', () => {
    const files = { 'index.js': 'console.log(1);', [path.join('tools', 'a.js')]: 'exports.a = 1;' };
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    write('README.md', 'not hashed');
    const manifest = generate();
    expect(manifest.buildHash).toBe(expectedHash(files));
    expect(manifest.fileCount).toBe(2);
    expect(Number.isNaN(Date.parse(manifest.buildTime))).toBe(false);
  });

  it('is deterministic for the same content, and changes when content or a path changes', () => {
    write('a.js', 'const x = 1;');
    const first = generate().buildHash;
    expect(generate().buildHash).toBe(first);

    write('a.js', 'const x = 2;');
    const edited = generate().buildHash;
    expect(edited).not.toBe(first);

    fs.renameSync(path.join(distDir, 'a.js'), path.join(distDir, 'b.js'));
    expect(generate().buildHash).not.toBe(edited);
  });

  it('writes nothing when the directory holds no .js files', () => {
    write('notes.txt', 'nothing to hash');
    execFileSync(process.execPath, [SCRIPT, '--root', distDir, '--dist', distDir], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(distDir, '.build-manifest.json'))).toBe(false);
  });
});

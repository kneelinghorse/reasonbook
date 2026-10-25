// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verify source hashes suppress checkout-only build warnings without hiding real edits.
// ABOUTME: Exercise the real manifest generator and freshness reader entirely in scratch projects.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { checkBuildFreshness } from '../../../src/tools/rbook/build-freshness';
import { getServerHealth, initServerHealth, resetServerHealth } from '../../../src/server-health';

interface Manifest {
  buildHash: string;
  buildTime: string;
  fileCount: number;
  srcHash?: string;
}

const generator = path.resolve(__dirname, '../../../scripts/generate-build-manifest.js');
let root: string;
let oldTime: Date;
let newTime: Date;

function write(relative: string, content: string, mtime = oldTime): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, mtime, mtime);
  return target;
}

function generate(dist = path.join(root, 'dist')): Manifest {
  // Always supply --dist as well as --root: even the pre-feature script cannot touch real dist/.
  execFileSync(process.execPath, [generator, '--root', root, '--dist', dist], {
    stdio: 'pipe',
  });
  return JSON.parse(fs.readFileSync(path.join(dist, '.build-manifest.json'), 'utf8')) as Manifest;
}

function saveManifest(manifest: Manifest): void {
  fs.writeFileSync(path.join(root, 'dist/.build-manifest.json'), JSON.stringify(manifest));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-source-hash-'));
  oldTime = new Date(Date.now() - 60_000);
  newTime = new Date(Date.now() + 60_000);
  write('src/main.ts', 'export const value = 1;\n');
  write('dist/index.js', 'exports.value = 1;\n');
});

afterEach(() => {
  resetServerHealth();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('source hash build freshness', () => {
  it('records a source digest independently of the loaded-code build hash', () => {
    const before = generate();
    expect(before.srcHash).toMatch(/^[a-f0-9]{64}$/);
    write('src/main.ts', 'export const value = 2;\n');
    const after = generate();
    expect(after.srcHash).not.toBe(before.srcHash);
    expect(after.buildHash).toBe(before.buildHash);
    expect(after.fileCount).toBe(before.fileCount);
  });

  it('does not mistake a source-only digest change for a change to loaded server code', () => {
    const manifest = generate();
    manifest.srcHash = 'a'.repeat(64);
    saveManifest(manifest);
    initServerHealth(path.join(root, 'dist'));
    saveManifest({ ...manifest, srcHash: 'b'.repeat(64) });
    expect(getServerHealth().codeIsCurrent).toBe(true);
    saveManifest({ ...manifest, buildHash: 'c'.repeat(64) });
    expect(getServerHealth().codeIsCurrent).toBe(false);
  });

  it('does not tell an agent to rebuild after identical checkout bytes get newer mtimes', async () => {
    const manifest = generate();
    write('src/main.ts', 'export const value = 1;\n', newTime);
    const result = await checkBuildFreshness(root);
    expect(result.stale).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.staleFiles).toBeUndefined();
    expect(result.distBuildTime).toBe(manifest.buildTime);
    expect(Date.parse(result.latestSrcMtime!)).toBeGreaterThan(Date.parse(manifest.buildTime));
  });

  it('still warns when newer source bytes actually changed', async () => {
    generate();
    write('src/main.ts', 'export const value = 2;\n', newTime);
    expect(await checkBuildFreshness(root)).toMatchObject({
      stale: true,
      reason: 'src-newer-than-build-manifest',
      staleFiles: [path.join('src', 'main.ts')],
    });
  });

  it('treats a rename as a source change when the mtime gate opens', async () => {
    const manifest = generate();
    fs.renameSync(path.join(root, 'src/main.ts'), path.join(root, 'src/renamed.ts'));
    fs.utimesSync(path.join(root, 'src/renamed.ts'), newTime, newTime);
    expect(await checkBuildFreshness(root)).toMatchObject({ stale: true });
    expect(generate().srcHash).not.toBe(manifest.srcHash);
  });

  it.each(['.ts', '.tsx', '.js'])(
    'includes nested %s files in both producer and reader',
    async (ext) => {
      write(`src/nested/component${ext}`, 'before\n');
      generate();
      write('src/main.ts', 'export const value = 1;\n', newTime);
      expect((await checkBuildFreshness(root)).stale).toBe(false);
      write(`src/nested/component${ext}`, 'after\n', newTime);
      expect((await checkBuildFreshness(root)).stale).toBe(true);
    }
  );

  it('excludes configuration, assets and skipped directories from the source-only contract', async () => {
    const manifest = generate();
    expect(manifest.srcHash).toMatch(/^[a-f0-9]{64}$/);
    for (const relative of [
      'tsconfig.json',
      'package.json',
      'src/settings.json',
      'src/style.css',
      'outside.ts',
      ...['node_modules', 'dist', '.git', 'coverage', '.next'].map(
        (dir) => `src/${dir}/ignored.ts`
      ),
    ]) {
      write(relative, 'changed\n', newTime);
    }
    // A relevant but unchanged file opens the hash branch, proving ignored bytes stay excluded.
    write('src/main.ts', 'export const value = 1;\n', newTime);
    expect((await checkBuildFreshness(root)).stale).toBe(false);
    expect(generate().srcHash).toBe(manifest.srcHash);
  });

  it('preserves the mtime-only behavior for older manifests without srcHash', async () => {
    const manifest = generate();
    delete manifest.srcHash;
    saveManifest(manifest);
    write('src/main.ts', 'export const value = 1;\n', newTime);
    expect(await checkBuildFreshness(root)).toMatchObject({
      stale: true,
      reason: 'src-newer-than-build-manifest',
    });
  });

  it('preserves the build-directory fallback when a project has no manifest', async () => {
    write('src/main.ts', 'export const value = 1;\n', newTime);
    expect(await checkBuildFreshness(root)).toMatchObject({
      stale: true,
      reason: 'src-newer-than-build-dir',
    });
  });

  it('keeps the documented preserved-mtime blind spot instead of hashing every review', async () => {
    generate();
    write('src/main.ts', 'export const value = 2;\n', oldTime);
    expect((await checkBuildFreshness(root)).stale).toBe(false);
  });

  it('keeps a dist-only installation current without requiring a source tree', async () => {
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    generate();
    expect(await checkBuildFreshness(root)).toMatchObject({ stale: false, latestSrcMtime: null });
  });

  it('uses the requested root for sources even when build output is elsewhere', () => {
    const alternate = path.join(root, 'alternate-output');
    write('alternate-output/index.js', 'exports.value = 1;\n');
    const normal = generate();
    const alternateManifest = generate(alternate);
    expect(normal.srcHash).toMatch(/^[a-f0-9]{64}$/);
    expect(alternateManifest.srcHash).toBe(normal.srcHash);
    expect(alternateManifest.buildHash).toBe(normal.buildHash);
  });

  it('caps the same deterministic source selection for generation and freshness at 5000 files', async () => {
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    // Reverse creation order prevents the fixture from implying insertion order is the contract.
    for (let i = 5000; i >= 0; i--) write(`src/file-${String(i).padStart(5, '0')}.ts`, `${i}\n`);
    const manifest = generate();
    expect(manifest.srcHash).toMatch(/^[a-f0-9]{64}$/);
    write('src/file-05000.ts', 'outside the capped set\n', newTime);
    expect(generate().srcHash).toBe(manifest.srcHash);
    // Restore the original receipt; generation time must not decide these reader assertions.
    saveManifest(manifest);
    write('src/file-00000.ts', '0\n', newTime);
    expect((await checkBuildFreshness(root)).stale).toBe(false);
    write('src/file-04999.ts', 'changed inside the capped set\n', newTime);
    expect((await checkBuildFreshness(root)).stale).toBe(true);
    expect(generate().srcHash).not.toBe(manifest.srcHash);
  });
});

// ABOUTME: Sprint 67 m03 — checkBuildFreshness covers the states sprint close + rbook_review
// ABOUTME: depend on: fresh, src-newer-than-manifest, src-newer-than-build-dir, dist-missing,
// ABOUTME: plus defensive defaults for missing src/ and I/O errors. Sprint 74 m01 adds the
// ABOUTME: generalized candidate-build-dir layouts; s107-m04 checks only a project with a manifest.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkBuildFreshness,
  isBlockingStaleness,
  type BuildFreshnessReport,
} from '../../../src/tools/rbook/build-freshness';

interface TempProject {
  root: string;
  cleanup: () => void;
}

/** A project without a manifest has no build to check: not stale, no times, no reason. */
const NOT_APPLICABLE: BuildFreshnessReport = {
  stale: false,
  latestSrcMtime: null,
  distBuildTime: null,
};

function makeTempProject(): TempProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-freshness-test-'));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeSrcFile(root: string, relativePath: string, mtime?: Date): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `// ${relativePath}\n`);
  if (mtime) {
    fs.utimesSync(fullPath, mtime, mtime);
  }
}

function writeDistManifest(root: string, buildTime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, '.build-manifest.json'),
    JSON.stringify(
      { buildHash: 'deadbeef', buildTime: buildTime.toISOString(), fileCount: 1 },
      null,
      2
    ) + '\n'
  );
}

function expectIsoCloseTo(actual: string | null, expected: Date): void {
  // FS mtime precision varies (APFS ns, ext4 ns, HFS+ ms) and Date.toISOString()
  // formats at ms granularity. Allow 1ms drift between request and read-back.
  expect(actual).not.toBeNull();
  const actualMs = Date.parse(actual ?? '');
  expect(Math.abs(actualMs - expected.getTime())).toBeLessThanOrEqual(1);
}

function writeDistIndex(root: string, mtime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const indexPath = path.join(distDir, 'index.js');
  fs.writeFileSync(indexPath, 'module.exports = {};\n');
  fs.utimesSync(indexPath, mtime, mtime);
}

/** Write an arbitrary build-output file at an exact mtime (any extension/layout). */
function writeBuildFile(root: string, relativePath: string, mtime: Date): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `// built: ${relativePath}\n`);
  fs.utimesSync(fullPath, mtime, mtime);
}

/** Write a present-but-unparseable dist/.build-manifest.json at an exact mtime. */
function writeCorruptDistManifest(root: string, mtime: Date): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const manifestPath = path.join(distDir, '.build-manifest.json');
  fs.writeFileSync(manifestPath, '{ "buildTime": "2026-'); // truncated / invalid JSON
  fs.utimesSync(manifestPath, mtime, mtime);
}

describe('checkBuildFreshness', () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('returns stale=false when all src files are older than the build manifest', async () => {
    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    writeSrcFile(project.root, 'src/foo.ts', oldTime);
    writeSrcFile(project.root, 'src/bar/baz.ts', oldTime);
    writeDistManifest(project.root, newTime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expectIsoCloseTo(result.distBuildTime, newTime);
    expect(result.reason).toBeUndefined();
    expect(result.staleFiles).toBeUndefined();
  });

  it('returns stale=true with the newest stale file first when one src file is newer than the manifest', async () => {
    const buildTime = new Date(Date.now() - 60_000);
    const newerSrc = new Date();
    writeSrcFile(project.root, 'src/older.ts', new Date(buildTime.getTime() - 5_000));
    writeSrcFile(project.root, 'src/changed.ts', newerSrc);
    writeDistManifest(project.root, buildTime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expectIsoCloseTo(result.distBuildTime, buildTime);
    expectIsoCloseTo(result.latestSrcMtime, newerSrc);
    expect(result.staleFiles).toEqual([path.join('src', 'changed.ts')]);
    expect(result.reason).toBe('src-newer-than-build-manifest');
  });

  it('without a manifest, a dist/ build is not checked and src/ is not walked (s107-m04, #812)', async () => {
    // Only a build that writes dist/.build-manifest.json is one Reasonbook can call stale; a
    // project that merely has dist/ files got a warning it could not act on.
    writeSrcFile(project.root, 'src/foo.ts', new Date());
    writeDistIndex(project.root, new Date(Date.now() - 60_000));
    const walk = jest.spyOn(fs.promises, 'readdir');
    try {
      expect(await checkBuildFreshness(project.root)).toEqual(NOT_APPLICABLE);
      expect(walk).not.toHaveBeenCalledWith(path.join(project.root, 'src'));
    } finally {
      walk.mockRestore();
    }
  });

  it('without a manifest and without any build output, nothing is checked either', async () => {
    writeSrcFile(project.root, 'src/foo.ts');

    expect(await checkBuildFreshness(project.root)).toEqual(NOT_APPLICABLE);
  });

  it('a manifest that cannot be read, other than missing, is freshness-check-failed, never fresh', async () => {
    // dist/ is a file, so the manifest's stat fails with ENOTDIR rather than ENOENT.
    writeSrcFile(project.root, 'src/foo.ts', new Date());
    fs.writeFileSync(path.join(project.root, 'dist'), 'not a folder');

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/^freshness-check-failed: ENOTDIR/);
  });

  it('returns stale=false defensively when src/ is missing (dist-only install path)', async () => {
    writeDistManifest(project.root, new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.latestSrcMtime).toBeNull();
  });

  it('caps staleFiles at 5 entries, newest-first', async () => {
    const buildTime = new Date(Date.now() - 600_000);
    writeDistManifest(project.root, buildTime);
    for (let i = 0; i < 8; i++) {
      const mtime = new Date(Date.now() - i * 1000);
      writeSrcFile(project.root, `src/file_${i}.ts`, mtime);
    }

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.staleFiles).toHaveLength(5);
    // file_0 is newest (i=0 → Date.now() - 0), so it should be first.
    expect(result.staleFiles?.[0]).toBe(path.join('src', 'file_0.ts'));
    expect(result.staleFiles?.[4]).toBe(path.join('src', 'file_4.ts'));
  });

  it('skips node_modules / dist / .git / coverage when walking src/', async () => {
    const buildTime = new Date();
    writeDistManifest(project.root, buildTime);
    // A file inside src/node_modules with a very-new mtime would falsely trigger stale.
    const newer = new Date(Date.now() + 60_000);
    writeSrcFile(project.root, 'src/node_modules/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/coverage/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/.git/should-skip.ts', newer);
    writeSrcFile(project.root, 'src/real.ts', new Date(Date.now() - 60_000));

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
  });

  it('treats .ts, .tsx, and .js as src; ignores other extensions', async () => {
    const buildTime = new Date(Date.now() - 60_000);
    writeDistManifest(project.root, buildTime);
    const newer = new Date();
    // .md should not trigger stale even if newer than the build.
    writeSrcFile(project.root, 'src/README.md', newer);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(false);
  });

  it('returns stale=false with freshness-check-failed reason when the project root is unreadable', async () => {
    // A path with a null byte fails the manifest's stat with an error other than ENOENT, which
    // reaches the outer catch (s107-m04: deterministic now, so it is asserted).
    const result = await checkBuildFreshness('/proc/this/path/does/not/exist\0invalid');

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/^freshness-check-failed:/);
  });
});

describe('checkBuildFreshness — a build is one that writes a manifest (s107-m04, #812)', () => {
  // Sprint 74 m01 (decision #834) read these layouts' newest file as a build time, so every
  // project with any build output got a stale-build warning about a build Reasonbook cannot see
  // run. The operator's F3 answer: only a manifest makes a build checkable.
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it.each([
    ['aquex.ai', ['dist/server/entry.mjs']],
    ['monorepo', ['dist/src/index.js', 'dist/src/util.js']],
    ['Next.js', ['.next/server/app/page.js', '.next/cache/webpack/0.pack']],
    ['build/', ['build/main.js']],
    ['out/', ['out/bundle.js']],
    ['an empty dist/ beside .next/', ['.next/server/app/page.js']],
  ])(
    'the %s layout without a manifest reads as not applicable, with no src/ walk',
    async (_layout, files) => {
      fs.mkdirSync(path.join(project.root, 'dist'), { recursive: true });
      for (const file of files) writeBuildFile(project.root, file, new Date(Date.now() - 60_000));
      writeSrcFile(project.root, 'src/foo.ts', new Date());
      const walk = jest.spyOn(fs.promises, 'readdir');
      try {
        expect(await checkBuildFreshness(project.root)).toEqual(NOT_APPLICABLE);
        expect(walk).not.toHaveBeenCalledWith(path.join(project.root, 'src'));
      } finally {
        walk.mockRestore();
      }
    }
  );

  it('does NOT let a corrupt-but-present manifest mtime vouch for an interrupted build', async () => {
    // A partial/truncated manifest write leaves dist/.build-manifest.json present
    // (unparseable) with a fresh mtime, but the actual build artifacts are older
    // than src. The manifest file must be excluded from the walk so its fresh
    // mtime cannot mask the stale build and wrongly pass the gate.
    const staleBuild = new Date(Date.now() - 120_000);
    const srcMtime = new Date(Date.now() - 60_000);
    const corruptManifestMtime = new Date(); // newest thing on disk
    writeBuildFile(project.root, 'dist/index.js', staleBuild);
    writeSrcFile(project.root, 'src/foo.ts', srcMtime);
    writeCorruptDistManifest(project.root, corruptManifestMtime);

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    // Build time is the real artifact (older), NOT the corrupt manifest (newer).
    expectIsoCloseTo(result.distBuildTime, staleBuild);
    expect(result.reason).toBe('src-newer-than-build-dir');
  });

  it('an interrupted build reads only dist/: newer output in .next/ does not vouch for it', async () => {
    // The removed candidates read .next/ next, so this layout read as fresh (s107-m04 critic).
    writeCorruptDistManifest(project.root, new Date());
    writeBuildFile(project.root, '.next/server/app/page.js', new Date());
    writeSrcFile(project.root, 'src/foo.ts', new Date(Date.now() - 60_000));

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('dist-missing');
  });

  it('a symlink cycle under src/ is walked past, as before, not a failed check (s107-m04 round 2)', async () => {
    writeDistManifest(project.root, new Date());
    writeSrcFile(project.root, 'src/a.ts', new Date(Date.now() - 60_000));
    fs.symlinkSync('.', path.join(project.root, 'src', 'loop'));

    const result = await checkBuildFreshness(project.root);

    expect(result.reason).toBeUndefined();
    expect(result.stale).toBe(false);
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (asRoot ? it.skip : it)(
    'a manifest or a source folder that cannot be read fails the check, never reading as fresh',
    async () => {
      // A newer dist/ file would have vouched for the build had the read error been walked past.
      writeSrcFile(project.root, 'src/a.ts', new Date(Date.now() - 60_000));
      writeBuildFile(project.root, 'dist/index.js', new Date());
      writeDistManifest(project.root, new Date(Date.now() - 600_000));
      const manifest = path.join(project.root, 'dist', '.build-manifest.json');
      fs.chmodSync(manifest, 0o000);
      try {
        expect((await checkBuildFreshness(project.root)).reason).toMatch(
          /^freshness-check-failed: EACCES/
        );
      } finally {
        fs.chmodSync(manifest, 0o644);
      }
      // The only newer source file sits in a folder the walk cannot read.
      writeDistManifest(project.root, new Date(Date.now() - 30_000));
      writeSrcFile(project.root, 'src/sub/b.ts', new Date());
      const sub = path.join(project.root, 'src', 'sub');
      fs.chmodSync(sub, 0o000);
      try {
        expect((await checkBuildFreshness(project.root)).reason).toMatch(
          /^freshness-check-failed: EACCES/
        );
      } finally {
        fs.chmodSync(sub, 0o755);
      }
    }
  );

  it('lets a VALID manifest short-circuit the candidate walk even when a dist file is newer', async () => {
    // A newer build artifact must not override the deterministic manifest buildTime.
    const manifestBuildTime = new Date(Date.now() - 60_000);
    const newerDistFile = new Date();
    writeDistManifest(project.root, manifestBuildTime);
    writeBuildFile(project.root, 'dist/index.js', newerDistFile);
    writeSrcFile(project.root, 'src/foo.ts', new Date(Date.now() - 90_000));

    const result = await checkBuildFreshness(project.root);

    // distBuildTime comes from the manifest, not the newer dist/index.js file.
    expectIsoCloseTo(result.distBuildTime, manifestBuildTime);
    expect(result.stale).toBe(false);
  });

  it('still reports dist-missing when a manifest that will not parse is the only file in dist/', async () => {
    writeCorruptDistManifest(project.root, new Date());
    writeSrcFile(project.root, 'src/foo.ts', new Date());

    const result = await checkBuildFreshness(project.root);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('dist-missing');
    expect(result.distBuildTime).toBeNull();
  });
});

describe('isBlockingStaleness (Sprint 70 m02)', () => {
  // The enforced sprint-close gate blocks ONLY on staleness that means the dist/
  // a server would run is genuinely behind src/. The three blocking reasons are
  // the ones checkBuildFreshness emits with stale=true; everything else (fresh,
  // or the never-throws freshness-check-failed I/O path) must fall through.
  function report(partial: Partial<BuildFreshnessReport>): BuildFreshnessReport {
    return {
      stale: false,
      latestSrcMtime: null,
      distBuildTime: null,
      ...partial,
    };
  }

  it('blocks on src-newer-than-build-manifest', () => {
    expect(
      isBlockingStaleness(report({ stale: true, reason: 'src-newer-than-build-manifest' }))
    ).toBe(true);
  });

  it('blocks on src-newer-than-build-dir', () => {
    expect(isBlockingStaleness(report({ stale: true, reason: 'src-newer-than-build-dir' }))).toBe(
      true
    );
  });

  it('blocks on dist-missing', () => {
    expect(isBlockingStaleness(report({ stale: true, reason: 'dist-missing' }))).toBe(true);
  });

  it('does NOT block a fresh report', () => {
    expect(isBlockingStaleness(report({ stale: false }))).toBe(false);
  });

  it('does NOT block the never-throws freshness-check-failed path', () => {
    // checkBuildFreshness folds I/O errors into stale=false with this reason — it
    // must never wedge a sprint on a probe failure.
    expect(
      isBlockingStaleness(report({ stale: false, reason: 'freshness-check-failed: boom' }))
    ).toBe(false);
  });

  it('does NOT block when stale=true but the reason is unrecognized (defensive)', () => {
    // Belt-and-suspenders: a future stale reason we have not classified as blocking
    // should default to non-blocking, not silently wedge sprint close.
    expect(isBlockingStaleness(report({ stale: true, reason: 'some-future-reason' }))).toBe(false);
  });
});

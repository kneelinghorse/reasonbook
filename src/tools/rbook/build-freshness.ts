// ABOUTME: Sprint 67 m03 — detect when dist/ is behind src/. Surfaces a "rebuild before
// ABOUTME: sessions" signal at sprint close and at rbook_review so agents stop marking missions
// ABOUTME: complete against stale runtime code (the s65 retro footgun this closes).

import { promises as fs } from 'fs';
import * as path from 'path';
import { collectSrcMtimes, hashSrcFiles, SRC_WALK_CAP } from '../../utils/build-source';

/** Only an explicit project preference disables the advisory; missing/old identities keep it. */
export function projectChecksBuildFreshness(
  identity: { type_fields?: { build_freshness_check?: unknown } } | null | undefined
): boolean {
  return identity?.type_fields?.build_freshness_check !== false;
}

/** Shape consumed by rbook_sprint_complete and rbook_review surfaces. */
export interface BuildFreshnessReport {
  stale: boolean;
  latestSrcMtime: string | null;
  distBuildTime: string | null;
  /** Up to 5 newest-first src files when stale. Omitted when fresh or on error. */
  staleFiles?: string[];
  /** Human-readable reason. Always present when stale=true; never when fresh. */
  reason?: string;
}

/**
 * The stale `reason` values that the enforced sprint-close gate (Sprint 70 m02)
 * treats as BLOCKING. These are exactly the reasons checkBuildFreshness emits with
 * stale=true. The never-throws I/O path emits `freshness-check-failed:<msg>` with
 * stale=false and is deliberately NOT in this set, so a probe failure can never
 * wedge a sprint close.
 */
const BLOCKING_STALENESS_REASONS: ReadonlySet<string> = new Set([
  'dist-missing',
  'src-newer-than-build-manifest',
  'src-newer-than-build-dir',
]);

/**
 * Decide whether a freshness report should BLOCK an enforced gate. True only when
 * the tree is stale AND the reason is one we classify as blocking — fresh trees,
 * the freshness-check-failed I/O path, and any future/unrecognized reason all
 * fall through to non-blocking (fail-open by default; the gate never wedges on a
 * shape it does not understand).
 */
export function isBlockingStaleness(report: BuildFreshnessReport): boolean {
  return (
    report.stale === true && report.reason != null && BLOCKING_STALENESS_REASONS.has(report.reason)
  );
}

const STALE_FILES_CAP = 5;
const BUILD_MANIFEST_RELATIVE = path.join('dist', '.build-manifest.json');
const BUILD_MANIFEST_BASENAME = '.build-manifest.json';

/**
 * Candidate build-output directories, highest priority first (Sprint 74 m01,
 * decision #834). When the manifest is absent the build time is the newest file
 * mtime under the first of these that holds build output — covering layouts the
 * old hardcoded dist/index.js probe missed: aquex.ai (dist/server/entry.mjs),
 * Forge monorepo (dist/src/index.js), Synthesis-Workbench (Next .next/).
 */
const BUILD_DIR_CANDIDATES = ['dist', '.next', 'build', 'out'] as const;
/** Reuse the src walk's bound — caps the build-dir walk against pathological trees. */
const BUILD_WALK_CAP = SRC_WALK_CAP;
/** .next/cache is dev-server churn, not a build artifact — excluded from the .next walk. */
const NEXT_BUILD_SKIP_DIRS: ReadonlySet<string> = new Set(['cache']);
const NO_SKIP_DIRS: ReadonlySet<string> = new Set();

interface DistBuildInfo {
  buildTimeMs: number | null;
  source: 'manifest' | 'build-dir-mtime' | 'missing';
  srcHash?: string;
}

/**
 * Recursively walk a build-output directory and return the NEWEST file mtime.
 * Unlike collectSrcMtimes this accepts ANY extension — build artifacts are
 * .js/.mjs/.cjs/.json/.map/.html/etc. Skips subdirectories whose basename is in
 * skipDirNames (used to drop .next/cache dev-server churn) and the
 * .build-manifest.json metadata file itself: the walk only runs when the
 * manifest is absent OR failed to parse, and a corrupt/partial manifest's fresh
 * mtime must not vouch for an interrupted build (it would mask staleness and
 * wrongly pass the gate). Capped at BUILD_WALK_CAP entries against pathological
 * trees. Returns null when the directory holds no build files.
 */
async function findNewestBuildMtime(
  buildDir: string,
  skipDirNames: ReadonlySet<string>
): Promise<number | null> {
  let newest: number | null = null;
  let visited = 0;
  const stack: string[] = [buildDir];
  while (stack.length > 0 && visited < BUILD_WALK_CAP) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (visited >= BUILD_WALK_CAP) break;
      const fullPath = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        // Permission error / symlink to nowhere — skip rather than crash.
        continue;
      }
      visited++;
      if (stat.isDirectory()) {
        if (skipDirNames.has(name)) continue;
        stack.push(fullPath);
      } else if (
        stat.isFile() &&
        name !== BUILD_MANIFEST_BASENAME &&
        (newest === null || stat.mtimeMs > newest)
      ) {
        newest = stat.mtimeMs;
      }
    }
  }
  return newest;
}

async function readDistBuildInfo(projectRoot: string): Promise<DistBuildInfo> {
  // 1. dist/.build-manifest.json — deterministic primary, unchanged in priority
  //    and parse behavior. A valid manifest short-circuits the candidate walk.
  const manifestPath = path.join(projectRoot, BUILD_MANIFEST_RELATIVE);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as { buildTime?: string; srcHash?: unknown };
    if (parsed && typeof parsed.buildTime === 'string') {
      const ms = Date.parse(parsed.buildTime);
      if (!Number.isNaN(ms)) {
        return {
          buildTimeMs: ms,
          source: 'manifest',
          ...(typeof parsed.srcHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.srcHash)
            ? { srcHash: parsed.srcHash }
            : {}),
        };
      }
    }
  } catch {
    // Fall through to the candidate build-dir walk.
  }

  // 2. Newest file mtime under the first candidate build dir that holds output
  //    (decision #834). An existing-but-empty candidate (e.g. a wiped dist/) is
  //    skipped rather than false-blocking; only when NONE of the candidates
  //    yields a build file do we report missing, so a genuinely-unbuilt tree
  //    still blocks the s70-m02 enforced gate.
  for (const candidate of BUILD_DIR_CANDIDATES) {
    const candidateDir = path.join(projectRoot, candidate);
    try {
      if (!(await fs.stat(candidateDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const skip = candidate === '.next' ? NEXT_BUILD_SKIP_DIRS : NO_SKIP_DIRS;
    const newest = await findNewestBuildMtime(candidateDir, skip);
    if (newest != null) {
      return { buildTimeMs: newest, source: 'build-dir-mtime' };
    }
  }

  return { buildTimeMs: null, source: 'missing' };
}

/**
 * Determine whether dist/ is behind src/. Never throws — all I/O errors fold
 * into a stale=false / reason='freshness-check-failed: <msg>' return so the
 * helper cannot block sprint close or review.
 */
export async function checkBuildFreshness(projectRoot: string): Promise<BuildFreshnessReport> {
  try {
    const [srcFiles, distInfo] = await Promise.all([
      collectSrcMtimes(projectRoot),
      readDistBuildInfo(projectRoot),
    ]);

    if (srcFiles.length === 0) {
      // src/ missing or empty — packages installed dist-only legitimately
      // hit this path. Defensive default: not stale.
      return {
        stale: false,
        latestSrcMtime: null,
        distBuildTime: distInfo.buildTimeMs ? new Date(distInfo.buildTimeMs).toISOString() : null,
      };
    }

    if (distInfo.source === 'missing') {
      const newestFirst = [...srcFiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
      return {
        stale: true,
        latestSrcMtime: new Date(newestFirst[0].mtimeMs).toISOString(),
        distBuildTime: null,
        staleFiles: newestFirst.slice(0, STALE_FILES_CAP).map((f) => f.relativePath),
        reason: 'dist-missing',
      };
    }

    const distMs = distInfo.buildTimeMs as number;
    const newer = srcFiles.filter((f) => f.mtimeMs > distMs);
    // Hash only after mtimes would warn. Legacy manifests keep their existing behavior.
    if (
      newer.length === 0 ||
      (distInfo.srcHash && (await hashSrcFiles(projectRoot, srcFiles)) === distInfo.srcHash)
    ) {
      const latestSrc = srcFiles.reduce((max, f) => (f.mtimeMs > max ? f.mtimeMs : max), 0);
      return {
        stale: false,
        latestSrcMtime: new Date(latestSrc).toISOString(),
        distBuildTime: new Date(distMs).toISOString(),
      };
    }

    const newestFirst = newer.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      stale: true,
      latestSrcMtime: new Date(newestFirst[0].mtimeMs).toISOString(),
      distBuildTime: new Date(distMs).toISOString(),
      staleFiles: newestFirst.slice(0, STALE_FILES_CAP).map((f) => f.relativePath),
      reason:
        distInfo.source === 'manifest'
          ? 'src-newer-than-build-manifest'
          : 'src-newer-than-build-dir',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      stale: false,
      latestSrcMtime: null,
      distBuildTime: null,
      reason: `freshness-check-failed: ${message}`,
    };
  }
}

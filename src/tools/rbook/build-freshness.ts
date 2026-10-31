// ABOUTME: Sprint 67 m03 — detect when dist/ is behind src/. Surfaces a "rebuild before
// ABOUTME: sessions" signal at sprint close and at rbook_review so agents stop marking missions
// ABOUTME: complete against stale runtime code (the s65 retro footgun this closes).

import { promises as fs } from 'fs';
import * as path from 'path';
import { collectSrcMtimes, hashSrcFiles, SRC_WALK_CAP } from '../../utils/build-source';
import { oneLine } from '../../utils/one-line';

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

const FAILED_PREFIX = 'freshness-check-failed:';

/** A report a caller keeps: stale, or a check that failed, which is never read as fresh (s107-m04). */
export function keepsFreshnessReport(report: BuildFreshnessReport): boolean {
  return report.stale || (report.reason?.startsWith(FAILED_PREFIX) ?? false);
}

/** The words review and sprint close show for a check that could not run. */
export function freshnessFailureWarning(report: BuildFreshnessReport): string | null {
  return !report.stale && report.reason?.startsWith(FAILED_PREFIX)
    ? `Build freshness could not be checked: ${oneLine(report.reason.slice(FAILED_PREFIX.length))}`
    : null;
}

const STALE_FILES_CAP = 5;
const BUILD_MANIFEST_RELATIVE = path.join('dist', '.build-manifest.json');
const BUILD_MANIFEST_BASENAME = '.build-manifest.json';
/** Reuse the src walk's bound — caps the dist/ walk against pathological trees. */
const BUILD_WALK_CAP = SRC_WALK_CAP;

/**
 * s107-m04 (#812, the operator's F3 answer): a project whose build writes no manifest has no build
 * Reasonbook can call stale, so it is not checked. Sprint 74 m01's .next/, build/ and out/
 * candidates (decision #834) warned every such project about a build it never saw run.
 */
const NOT_APPLICABLE: BuildFreshnessReport = {
  stale: false,
  latestSrcMtime: null,
  distBuildTime: null,
};

interface DistBuildInfo {
  buildTimeMs: number | null;
  source: 'manifest' | 'build-dir-mtime' | 'missing';
  srcHash?: string;
}

/**
 * Recursively walk dist/ and return the NEWEST file mtime. Unlike collectSrcMtimes
 * this accepts ANY extension — build artifacts are .js/.mjs/.cjs/.json/.map/.html/etc.
 * Skips the .build-manifest.json metadata file itself: the walk only runs when the
 * manifest failed to parse, and a corrupt/partial manifest's fresh mtime must not
 * vouch for an interrupted build (it would mask staleness). Capped at BUILD_WALK_CAP
 * entries against pathological trees. Returns null when dist/ holds no build files.
 */
async function findNewestBuildMtime(buildDir: string): Promise<number | null> {
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
  // 1. dist/.build-manifest.json — deterministic primary, unchanged in parse behavior.
  //    A valid manifest short-circuits the dist/ walk.
  const manifestPath = path.join(projectRoot, BUILD_MANIFEST_RELATIVE);
  // A manifest that cannot be read (EACCES, EISDIR) throws to the caller's catch, so the check
  // fails rather than reading as fresh; only one that reads but will not parse is walked past.
  const raw = await fs.readFile(manifestPath, 'utf-8');
  try {
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
    // Fall through to the dist/ walk.
  }

  // 2. A manifest that exists but will not parse is an interrupted build: the newest file under
  //    dist/ is its build time, so it still warns; with no other file there it is missing.
  const newest = await findNewestBuildMtime(path.join(projectRoot, 'dist'));
  return newest != null
    ? { buildTimeMs: newest, source: 'build-dir-mtime' }
    : { buildTimeMs: null, source: 'missing' };
}

/**
 * Determine whether dist/ is behind src/. Never throws — every error reading the manifest or the
 * source folds into a stale=false / reason='freshness-check-failed: <msg>' return so the helper
 * cannot block sprint close or review; callers keep and say that reason.
 */
export async function checkBuildFreshness(projectRoot: string): Promise<BuildFreshnessReport> {
  try {
    // Before any walk: without a manifest there is nothing to check (ENOENT); any other error
    // is the check failing, which the catch below reports rather than reading as fresh.
    try {
      await fs.stat(path.join(projectRoot, BUILD_MANIFEST_RELATIVE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...NOT_APPLICABLE };
      throw error;
    }
    const [srcFiles, distInfo] = await Promise.all([
      // Strict: a source file that cannot be read fails the check instead of reading as fresh.
      collectSrcMtimes(projectRoot, { strict: true }),
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
    // By shape: an fs error from another realm (a test sandbox) is not `instanceof Error`.
    const text = (error as { message?: unknown } | null)?.message;
    const message = typeof text === 'string' ? text : 'unknown error';
    return {
      stale: false,
      latestSrcMtime: null,
      distBuildTime: null,
      reason: `freshness-check-failed: ${message}`,
    };
  }
}

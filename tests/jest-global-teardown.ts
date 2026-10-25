// ABOUTME: Jest globalTeardown removes only config and source-cache roots owned by this run.
// ABOUTME: Ignores config cleanup errors and fails if compiled-cache cleanup or build identity changes.

import { promises as fs } from 'fs';

import {
  DIST_MANIFEST_FINGERPRINT_ENV,
  DIST_MANIFEST_PATH,
  distManifestFingerprint,
} from './helpers/dist-manifest-fingerprint';

export default async function globalTeardown(): Promise<void> {
  const sourceCache = (globalThis as unknown as { __RBOOK_JEST_SOURCE_CACHE__?: string })
    .__RBOOK_JEST_SOURCE_CACHE__;
  if (sourceCache) await fs.rm(sourceCache, { recursive: true, force: true });
  const dir = (globalThis as unknown as { __RBOOK_JEST_CONFIG_DIR__?: string })
    .__RBOOK_JEST_CONFIG_DIR__;
  if (dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Silent — cleanup is best-effort; tmpdir OS eventually reclaims it.
    }
  }

  // s92-m10 (feedback #31): a full run must leave the real build manifest byte-identical. A
  // throwing globalTeardown makes jest exit non-zero, so a test that rewrites it fails the run.
  const before = process.env[DIST_MANIFEST_FINGERPRINT_ENV];
  if (before !== undefined && distManifestFingerprint() !== before) {
    throw new Error(
      `${DIST_MANIFEST_PATH} changed during this test run (sha256 ${before} -> ` +
        `${distManifestFingerprint()}). A test rewrote the real build manifest; point it at a ` +
        'temporary directory (scripts/generate-build-manifest.js --dist <dir>).'
    );
  }
}

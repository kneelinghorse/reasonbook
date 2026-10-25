// ABOUTME: Jest globalSetup provisions run-owned config and compiled-source roots before workers.
// ABOUTME: Application fixtures share compiled bytes only; teardown removes these run-owned roots.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from '../src/intelligence/legacy-compat';
import { captureRunControls, restoreRunControls, RUN_ENV_KEY } from './helpers/test-env-isolation';
import {
  prepareUploadServerRunCache,
  UPLOAD_SOURCE_CACHE_ENV,
} from './helpers/upload-server-source';

import {
  DIST_MANIFEST_FINGERPRINT_ENV,
  distManifestFingerprint,
} from './helpers/dist-manifest-fingerprint';

const RBOOK_CONFIG_DIR_ENV = 'RBOOK_CONFIG_DIR';

/**
 * s86-m01 — an immutable copy of the run's canonical RBOOK_CONFIG_DIR, used by the
 * root re-assert guard in tests/jest-setup-after-env.ts.
 *
 * It needs its own name because the guard cannot recover the canonical value from
 * any other source. Capturing `process.env.RBOOK_CONFIG_DIR` at module load of
 * jest-setup-after-env.ts does not work: setupFilesAfterEnv is re-required per
 * test FILE while `process` is shared across files under --runInBand, so once any
 * file leaves the var deleted, every later file captures `undefined` and the guard
 * re-asserts nothing. `globalThis.__RBOOK_JEST_CONFIG_DIR__` below is not reachable
 * either — globalSetup/globalTeardown run in the main process and each test file
 * gets a fresh `global`. A second env var survives both. No test touches this name,
 * so nothing can clobber it the way RBOOK_CONFIG_DIR itself gets clobbered.
 */
const JEST_RECORD_CONFIG_DIR_CANONICAL = 'JEST_RECORD_CONFIG_DIR_CANONICAL';

/**
 * s86-m01 — default the checkpoint-sync kill switch to 'off' for test runs, but
 * ONLY when the operator has not set it.
 *
 * That conditional is what keeps the mission's own evidence falsifiable:
 * `RBOOK_CHECKPOINT_SYNC=on npm test -- --runInBand` restores real behaviour for a
 * whole run, so a green run with zero "Cannot log after tests are done" can be
 * attributed to the actual fix (stderr writes + the deterministic drain) rather
 * than to the switch having suppressed the code path entirely.
 */
export default async function globalSetup(): Promise<void> {
  // s92-m10: fingerprint the real build manifest; jest-global-teardown.ts fails the run if any
  // test rewrote it (the server reads it to report a stale build).
  process.env[DIST_MANIFEST_FINGERPRINT_ENV] = distManifestFingerprint();

  const runControls = captureRunControls(process.env);
  process.env[RUN_ENV_KEY] = JSON.stringify(runControls);
  restoreRunControls(process.env, runControls);

  // Owned separately from RBOOK_CONFIG_DIR, including when the operator supplied that directory.
  const sourceCache = prepareUploadServerRunCache(path.resolve(__dirname, '..'));
  try {
    const explicitConfigDir = getSetting('CONFIG_DIR');
    if (explicitConfigDir) {
      // An operator-supplied dir wins, but the guard still needs its canonical copy.
      process.env[JEST_RECORD_CONFIG_DIR_CANONICAL] = explicitConfigDir;
    } else {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-jest-'));
      process.env[RBOOK_CONFIG_DIR_ENV] = dir;
      process.env[JEST_RECORD_CONFIG_DIR_CANONICAL] = dir;
      (globalThis as unknown as { __RBOOK_JEST_CONFIG_DIR__?: string }).__RBOOK_JEST_CONFIG_DIR__ =
        dir;
    }

    process.env[UPLOAD_SOURCE_CACHE_ENV] = sourceCache;
    (
      globalThis as unknown as { __RBOOK_JEST_SOURCE_CACHE__?: string }
    ).__RBOOK_JEST_SOURCE_CACHE__ = sourceCache;
  } catch (error) {
    // globalTeardown is not guaranteed after a later setup failure either.
    await fs.rm(sourceCache, { recursive: true, force: true });
    throw error;
  }
}

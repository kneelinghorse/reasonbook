// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m04 (#812) against a temporary backup of a real Builder store: a manifest build warns on changed source.
// ABOUTME: The explicit source is opened read-only; review, close and every registry write use the copy.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRecordPaths } from '../../src/intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { followFreshnessPath } from '../helpers/build-freshness-path';
import { reidentifyRbookTestStore } from '../helpers/seedRbookDb';

// Run from the repository root:
// RBOOK_FRESHNESS_REAL_STORE_ROOT="$(pwd)" npx jest --testMatch '**/*.fire.ts' --runTestsByPath tests/private/build-freshness-real-store.fire.ts --runInBand --coverage=false
it('a real Builder store copy: identical bytes are quiet, changed source warns in review and close', async () => {
  const sourceRoot = process.env.RBOOK_FRESHNESS_REAL_STORE_ROOT;
  if (!sourceRoot)
    throw new Error('Set RBOOK_FRESHNESS_REAL_STORE_ROOT to an existing real project.');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-freshness-real-')));
  const root = path.join(temp, 'copy');
  const destination = path.join(root, 'rbook/db/rbook.sqlite');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const source = new Database(resolveRecordPaths(sourceRoot).dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(
      (source.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n
    ).toBeGreaterThan(0);
    await source.backup(destination);
  } finally {
    source.close();
  }
  const prior = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  try {
    reidentifyRbookTestStore(root, `freshness-fire-${path.basename(temp)}`);
    await followFreshnessPath(root);
  } finally {
    if (prior.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = prior.config;
    if (prior.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
    else process.env.RBOOK_CHECKPOINT_SYNC = prior.sync;
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

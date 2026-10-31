// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m04 (#812) on an initialized Builder store: a build with a manifest warns on changed source, in review and close.
// ABOUTME: The public twin of tests/private/build-freshness-real-store.fire.ts, so the mirror's suite covers the path.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { resetFirstWriteMaintenance } from '../../../src/tools/rbook/first-write-maintenance';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { followFreshnessPath } from '../../helpers/build-freshness-path';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-freshness-store-')));
  resetFirstWriteMaintenance();
});

afterEach(() => {
  resetFirstWriteMaintenance();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

it('a Builder store whose build wrote a manifest: identical bytes are quiet, changed source warns in review and close', async () => {
  const initialized = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Freshness path',
    projectType: 'build',
  });
  expect(initialized.success).toBe(true);
  await followFreshnessPath(root);
});

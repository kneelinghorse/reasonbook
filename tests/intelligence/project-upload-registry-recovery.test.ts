// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real registry wrappers preserve upload recovery with an explicit configuration directory.
// ABOUTME: Credentials probes clear only their own project's pause, retaining that project's debt.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

it('an explicit config with no environment keeps recovered debt isolated from a deleted sibling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-registry-'));
  const saved = process.env.RBOOK_CONFIG_DIR;
  delete process.env.RBOOK_CONFIG_DIR;
  ProjectGraphRegistry.resetInstance();
  const now = Date.now();
  try {
    const graph = await ProjectGraphRegistry.create({ configDir: directory, now: () => now });
    for (const projectId of ['recovering', 'deleted']) {
      const root = path.join(directory, projectId);
      fs.mkdirSync(root);
      graph.register({ project_id: projectId, store_path: root, name: projectId });
      expect(graph.markUploadOwed(projectId, now, true)).toBe(true);
      const lease = graph.claimUpload(projectId, true)!;
      expect(
        graph.finishUpload(projectId, lease, {
          success: false,
          pauseReason: projectId === 'deleted' ? 'deleted' : 'auth',
        })
      ).toBe(true);
    }
    ProjectGraphRegistry.resetInstance();
    const reopened = await ProjectGraphRegistry.create({
      configDir: directory,
      now: () => now + 3600000,
    });
    const probe = reopened.claimUploadProbe('recovering')!;
    expect(probe).not.toBeNull();
    expect(reopened.finishUploadProbe('recovering', probe, { recovered: true })).toBe(true);
    expect(reopened.readUploadState('recovering')).toMatchObject({
      blocked: false,
      explicitGeneration: 1,
      firstOwedAt: now,
    });
    expect(reopened.claimUpload('recovering')).not.toBeNull();
    expect(reopened.claimUploadProbe('deleted')).toBeNull();
    expect(reopened.claimUpload('deleted', true)).toBeNull();
  } finally {
    ProjectGraphRegistry.resetInstance();
    if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

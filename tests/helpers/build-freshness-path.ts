// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m04's freshness path through the dispatcher: a build with a manifest, a source change, review and close.
// ABOUTME: Shared by the public twin on an initialized store and the private fire test on a copy of a real one.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';

type Answer = {
  success: boolean;
  data?: {
    buildFreshness?: { stale: boolean; reason?: string };
    next_actions?: Array<{ command: string }>;
  };
  warnings?: string[];
};

const GENERATOR = path.join(__dirname, '../../scripts/generate-build-manifest.js');

/**
 * Lays a source tree and a dist/ with a .js file under `root`, writes their manifest with the
 * real generator (its --root, so the checkout's own dist/ is never touched), then follows review
 * and a close of a new empty sprint through executeMissionProtocolTool: identical bytes give
 * nothing; changed bytes warn with npm run build first, and the close carries the advisory.
 */
export async function followFreshnessPath(root: string): Promise<void> {
  const protocol = await buildMissionProtocolContext();
  const call = async (name: string, args: Record<string, unknown>): Promise<Answer> =>
    (await executeMissionProtocolTool(name, { ...args, projectRoot: root }, protocol))
      .structuredContent as Answer;
  const source = path.join(root, 'src', 'main.ts');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'export const value = 1;\n');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), 'exports.value = 1;\n');
  execFileSync(process.execPath, [GENERATOR, '--root', root, '--dist', path.join(root, 'dist')], {
    stdio: 'ignore',
  });
  const manifest = path.join(root, 'dist', '.build-manifest.json');
  expect(fs.existsSync(manifest)).toBe(true);
  const later = new Date(
    Date.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')).buildTime) + 60_000
  );

  // Identical bytes with a newer time: the manifest's source hash still matches.
  fs.writeFileSync(source, 'export const value = 1;\n');
  fs.utimesSync(source, later, later);
  const same = await call('rbook_review', {});
  expect(same.success).toBe(true);
  expect(same.data?.buildFreshness).toBeUndefined();

  fs.writeFileSync(source, 'export const value = 2;\n');
  fs.utimesSync(source, later, later);
  const changed = await call('rbook_review', {});
  expect(changed.data?.buildFreshness).toMatchObject({
    stale: true,
    reason: 'src-newer-than-build-manifest',
  });
  expect(changed.data?.next_actions?.[0]?.command).toBe('npm run build');

  // A store's current sprint can hold open missions, so a new empty one is added and closed.
  const added = await call('rbook_sprint', {
    action: 'add',
    sprintId: 'sprint-freshness-path',
    title: 'Freshness path',
  });
  expect(added.success).toBe(true);
  const close = await call('rbook_sprint', {
    action: 'complete',
    sprintId: 'sprint-freshness-path',
    summary: 'Closes over a build behind its source',
  });
  expect(close.success).toBe(true);
  expect(close.warnings).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /Advisory: this project's build looks stale — src-newer-than-build-manifest/
      ),
    ])
  );
}

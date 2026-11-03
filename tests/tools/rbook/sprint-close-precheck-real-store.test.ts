// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m04 (#916) — the close's pre-check fires on a copy of this project's store: a sprint with an open
// ABOUTME: mission is refused with no snapshot taken, and once the mission is done the close takes its pre-close one.

import { afterEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookMissionTransition } from '../../../src/tools/rbook/rbook-mission-transition';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The pre-check's positive fire needs a temporary SQLite backup of the live project store, whose real schema the close's own checks read.",
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

PRIVATE.describe('the close’s pre-check on a copy of the live store (#916)', () => {
  let tmp: string | undefined;
  const savedConfig = process.env.RBOOK_CONFIG_DIR;

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = savedConfig;
    RbookDetector.resetInstance();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses a sprint with an open mission without a snapshot, and snapshots its close once the mission is done', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-close-precheck-live-copy-'));
    const projectRoot = path.join(tmp, 'project');
    const dbPath = path.join(projectRoot, 'rbook/db/rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const live = new Database(PRIVATE.paths.liveDb, { readonly: true });
    try {
      await live.backup(dbPath);
    } finally {
      live.close();
    }
    process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
    reidentifyRbookTestStore(projectRoot);
    RbookDetector.resetInstance();

    // Established here, never inherited (#547): a sprint of this copy's own, with one open mission,
    // written through the tools so the rows carry the real schema's genesis columns.
    const sprint = await rbookSprint({
      action: 'add',
      sprintId: 'sprint-fire',
      title: 'Pre-check fire',
      status: 'Planned',
      projectRoot,
    });
    expect(sprint.success).toBe(true);
    const mission = await rbookMission({
      action: 'add',
      missionId: 'fire-m1',
      name: 'The pre-check fire',
      sprintId: 'sprint-fire',
      projectRoot,
    });
    expect(mission.success).toBe(true);

    const snapshots = path.join(projectRoot, 'rbook/db/snapshots');
    const listing = (): string[] =>
      fs.existsSync(snapshots) ? fs.readdirSync(snapshots).sort() : [];
    const before = listing();

    const refused = await rbookSprintComplete({
      sprintId: 'sprint-fire',
      summary: 'the pre-check fire',
      projectRoot,
    });
    expect(refused.error?.code).toBe('SPRINT_NOT_READY');
    expect(listing()).toEqual(before);

    for (const action of ['start', 'complete'] as const) {
      const moved = await rbookMissionTransition({
        action,
        missionId: 'fire-m1',
        notes: 'done for the fire',
        projectRoot,
      });
      expect(moved.success).toBe(true);
    }
    const closed = await rbookSprintComplete({
      sprintId: 'sprint-fire',
      summary: 'the pre-check fire',
      projectRoot,
    });
    expect(closed.success).toBe(true);
    const preClose = closed.data!.lifecycle.preCloseSnapshotId;
    expect(preClose).toEqual(expect.any(String));
    expect(fs.existsSync(path.join(snapshots, `${preClose}.sqlite`))).toBe(true);
  }, 180_000);
});

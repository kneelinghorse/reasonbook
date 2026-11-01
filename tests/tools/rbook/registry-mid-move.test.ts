// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05 round 2 — a registered project mid-move neither fails a pass over every project nor
// ABOUTME: is archived as missing, and a shared-record sync tick during a move logs and skips it.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookProjectList } from '../../../src/tools/rbook/rbook-project-list';
import { rbookProjectSweep } from '../../../src/tools/rbook/rbook-project-sweep';
import { rbookProjectValidate } from '../../../src/tools/rbook/rbook-project-validate';
import {
  __resetSharedSyncScheduler,
  __runSharedSync,
} from '../../../src/tools/rbook/record-sync-scheduler';

let tmp: string;
let configDir: string;
let graph: ProjectGraphRegistry;
let previous: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-registry-mid-move-'));
  configDir = path.join(tmp, 'config');
  await fs.mkdir(configDir);
  previous = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = configDir;
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  graph = await ProjectGraphRegistry.create({ configDir, ephemeralRoots: [] });
});
afterEach(async () => {
  jest.restoreAllMocks();
  ProjectGraphRegistry.resetInstance();
  if (previous === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A registered project whose record sits in the old layout, as one does while it moves. */
async function legacyProject(name: string): Promise<string> {
  const root = path.join(tmp, name);
  await fs.mkdir(path.join(root, 'cmos', 'db'), { recursive: true });
  await fs.writeFile(path.join(root, 'cmos', 'db', 'cmos.sqlite'), '');
  graph.registerStore(root, { name });
  return root;
}

/** reasonbook migrate's in-project guard, as every move and every interrupted one holds it. */
const moving = (root: string) => fs.mkdir(path.join(root, '.rbook-migration.lock'));

describe('a pass over every registered project, while one of them moves', () => {
  it('lists, validates and sweeps the others, and keeps the moving one as present', async () => {
    const still = await legacyProject('still');
    const mover = await legacyProject('mover');
    await moving(mover);
    const listed = await rbookProjectList({});
    expect(listed.success).toBe(true);
    expect(listed.data!.projects.map((project) => [project.projectRoot, project.dbExists])).toEqual(
      expect.arrayContaining([
        [still, true],
        [mover, true],
      ])
    );
    const validated = await rbookProjectValidate({});
    expect(validated.success).toBe(true);
    const moverValidation = validated.data!.validations.find((v) => v.projectRoot === mover);
    expect(moverValidation?.status).not.toBe('stale');
    // It says the record is moving, never that the project is simply active (round 3).
    expect(moverValidation?.message).toContain('moving, or its move needs recovery');
    const swept = await rbookProjectSweep({}, graph);
    expect(swept.success).toBe(true);
    expect(swept.data!.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('its record is moving, or its move needs recovery — skipped'),
      ])
    );
  });

  it('never archives a project mid-move as missing, between its two renames as at any other time', async () => {
    const mover = await legacyProject('mover');
    await moving(mover);
    // Between the folder's rename and the file's, no store has either name the prune looks for.
    await fs.rename(path.join(mover, 'cmos'), path.join(mover, 'rbook'));
    expect(graph.pruneMissingStores()).toBe(0);
    expect(graph.list().map((row) => row.store_path)).toContain(mover);
  });
});

describe("a server's shared-record sync during a move", () => {
  it('skips the tick and logs why, where it threw out of the timer and ended the server', async () => {
    const mover = await legacyProject('shared-mover');
    await moving(mover);
    __resetSharedSyncScheduler();
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // The timer calls this once a tick; thrown before its promise, the error left the timer.
      await expect(__runSharedSync(mover)).resolves.toBeUndefined();
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain(
        'migration is in progress'
      );
    } finally {
      __resetSharedSyncScheduler();
    }
  });
});

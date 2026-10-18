// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (#629) — the registry knows a folder by its device and inode, so macOS's two spellings
// ABOUTME: of one folder (/Users/… and /System/Volumes/Data/…) are one project, never two.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { seedRbookDb } from '../helpers/seedRbookDb';

// The firmlink that gives every user folder a second spelling exists on macOS only.
const DATA_VOLUME = '/System/Volumes/Data';
const onDataVolume = process.platform === 'darwin' && fs.existsSync(DATA_VOLUME);
const describeOnMac = onDataVolume ? describe : describe.skip;

let tmp: string;
let savedConfig: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-629-')));
  savedConfig = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describeOnMac('one folder by its two macOS spellings', () => {
  it('registers it once, and finds it by either spelling', async () => {
    const root = path.join(tmp, 'project');
    seedRbookDb(root, { projectId: 'p-629', projectName: 'p-629' });
    const dataSpelling = DATA_VOLUME + root;
    // realpath does not fold the firmlink (probe fact 15), which is the whole of #629.
    expect(fs.realpathSync.native(dataSpelling)).toBe(dataSpelling);
    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(root);
    expect(registry.registerStore(dataSpelling).project_id).toBe('p-629');
    expect(registry.getByStorePath(dataSpelling)).toBe('p-629');
    expect(registry.list().map((entry) => entry.project_id)).toEqual(['p-629']);
  });

  it('keeps the registered id when the store is made again through the other spelling', async () => {
    // #629's failure: the second spelling found no row, minted a new id, and every write through
    // the usual spelling was then refused as a conflict with the graph's identity.
    const root = path.join(tmp, 'project');
    seedRbookDb(root, { projectId: 'p-629', projectName: 'p-629' });
    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(root);
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    db.prepare("DELETE FROM metadata WHERE key = 'project_id'").run();
    db.close();
    expect(registry.registerStore(DATA_VOLUME + root).project_id).toBe('p-629');
    expect(registry.registerStore(root, { requireStoredIdentity: true }).project_id).toBe('p-629');
  });
});

describe('folder identity where the Data volume is absent', () => {
  it('still tells two different folders apart', async () => {
    const first = path.join(tmp, 'first');
    const second = path.join(tmp, 'second');
    seedRbookDb(first, { projectId: 'p-first', projectName: 'first' });
    seedRbookDb(second, { projectId: 'p-second', projectName: 'second' });
    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(first);
    registry.registerStore(second);
    expect(registry.getByStorePath(first)).toBe('p-first');
    expect(registry.getByStorePath(second)).toBe('p-second');
  });
});

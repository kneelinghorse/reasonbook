// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A reusable address cannot establish a fresh store's dashboard sender identity.
// ABOUTME: Optional real-store copies verify the same metadata reads without touching the source.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { getLocalSenderProjectId } from '../../../src/tools/rbook/sender-identity';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const existingId = 'ea27c123-1be2-4fce-bbf5-1d8bbdcd4567';
const copiedId = 'e9aade15-37dc-4a95-a8fc-dabf7ede8dcb';
const address = 'rbook://tester/same-name';
const realStoreFixture = process.env.RBOOK_UPLOAD_FIXTURE;
let backedUpStores = 0;
let sourceMissionCount = 0;
let root: string;
let dbPath: string;
let config: string | undefined;

beforeEach(async () => {
  config = process.env.RBOOK_CONFIG_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sender-no-adoption-'));
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  dbPath = seedRbookDb(root, {
    projectName: 'Same Name',
    projectId: 'same-name',
    owner: 'tester',
    rbookAddress: address,
  });
  if (realStoreFixture) {
    fs.rmSync(dbPath);
    const source = new Database(realStoreFixture, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      sourceMissionCount = source.prepare('SELECT COUNT(*) FROM missions').pluck().get() as number;
      await source.backup(dbPath);
    } finally {
      source.close();
    }
    const db = new Database(dbPath);
    try {
      expect(db.prepare('SELECT COUNT(*) FROM missions').pluck().get()).toBe(sourceMissionCount);
      backedUpStores++;
      const upsert = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
      upsert.run('project_id', 'same-name');
      upsert.run('project_name', 'Same Name');
      upsert.run('owner', 'tester');
      db.prepare("DELETE FROM metadata WHERE key = 'dashboard_project_id'").run();
      const row = db
        .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
        .get() as {
        content: string;
      };
      db.prepare("UPDATE contexts SET content = ? WHERE id = 'project_identity'").run(
        JSON.stringify({
          ...JSON.parse(row.content),
          project_id: 'same-name',
          project_name: 'Same Name',
          [LEGACY.identityAddressKey]: address,
        })
      );
    } finally {
      db.close();
    }
  }
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});

afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = config;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (realStoreFixture) {
    expect(backedUpStores).toBe(4);
    process.stderr.write(
      `${JSON.stringify({
        witness: 'sender-no-adoption real-store backup',
        source: realStoreFixture,
        backedUpStores,
        sourceMissionCount,
      })}\n`
    );
  }
});

function dashboard() {
  const getMyProjects = jest.fn().mockResolvedValue(
    createSuccess({
      projects: [{ id: existingId, name: 'Same Name', address, owner: 'tester' }],
      totalCount: 1,
    })
  );
  return { client: { getMyProjects } as unknown as DashboardClient, getMyProjects };
}

it.each([null, '', 'not-a-uuid'])(
  'does not adopt an exact address match when the stored dashboard id is %p',
  async (storedId) => {
    const db = new Database(dbPath);
    try {
      if (storedId !== null)
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
          'dashboard_project_id',
          storedId
        );
    } finally {
      db.close();
    }
    const { client, getMyProjects } = dashboard();
    const resolved = await getLocalSenderProjectId(client, root);
    expect(resolved.identity.rbookAddress).toBe(address);
    expect(resolved.senderProjectId).toBeUndefined();
    expect(getMyProjects).not.toHaveBeenCalled();
  }
);

it('keeps a copied store attached to its stored UUID even when an address now names another store', async () => {
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      'dashboard_project_id',
      copiedId
    );
  } finally {
    db.close();
  }
  const { client, getMyProjects } = dashboard();
  const resolved = await getLocalSenderProjectId(client, root);
  expect(resolved.identity).toEqual({ projectId: copiedId, rbookAddress: address });
  expect(resolved.senderProjectId).toBe(copiedId);
  expect(getMyProjects).not.toHaveBeenCalled();
});

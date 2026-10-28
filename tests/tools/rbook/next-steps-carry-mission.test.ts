// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A mission-scoped carry must renew only that mission's next-step leases.
// ABOUTME: Real-store MCP calls cover broad selection, explicit IDs, NULL missions and unmatched rows.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { seedRbookDb, reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

let root: string;
let db: Database.Database;
const ids = [1, 2, 3, 4, 5];
const rows = () =>
  db.prepare('SELECT id, status, resolved_at, carried_to_sprint FROM next_steps ORDER BY id').all();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-carry-mission-'));
  const dbPath = seedRbookDb(root, { projectName: 'Carry mission selection' });
  reidentifyRbookTestStore(root);
  db = new Database(dbPath);
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  db.prepare('INSERT INTO sprints(id,title,status) VALUES (?,?,?)').run('next', 'Next', 'Planning');
  for (const mission of ['m-a', 'm-b'])
    db.prepare('INSERT INTO missions(id,name,status) VALUES (?,?,?)').run(
      mission,
      mission,
      'Queued'
    );
  const insert = db.prepare(
    'INSERT INTO next_steps(id,content,status,mission_id,created_at,resolved_at) VALUES (?,?,?,?,?,?)'
  );
  insert.run(1, 'Renew this pending row', 'pending', 'm-a', old, null);
  insert.run(2, 'Renew this carried row', 'carried', 'm-a', old, old);
  insert.run(3, 'Another mission keeps its lease', 'pending', 'm-b', old, null);
  insert.run(4, 'Unassigned work keeps its lease', 'pending', null, old, null);
  insert.run(5, 'Completed work stays completed', 'completed', 'm-a', old, old);
  RbookDetector.resetInstance();
});
afterEach(() => {
  db.close();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

const carry = async (extra: Record<string, unknown>) => {
  const answer = await executeMissionProtocolTool(
    'rbook_context',
    {
      action: 'next_steps',
      nextStepAction: 'carry',
      missionId: 'm-a',
      carryToSprint: 'next',
      projectRoot: root,
      ...extra,
    },
    {} as never
  );
  return answer.structuredContent as {
    success: boolean;
    data: { affected: number; unmatchedIds?: number[]; writeFailures: unknown[] };
  };
};

it.each([undefined, []])(
  'omitted/empty IDs (%j) renew only the selected mission, not unrelated leases',
  async (nextStepIds) => {
    const before = rows();
    const result = await carry({ nextStepIds });
    expect(result).toMatchObject({ success: true, data: { affected: 2, writeFailures: [] } });
    const after = rows();
    expect(after.slice(2)).toEqual(before.slice(2));
    expect(after.slice(0, 2)).toEqual(
      ids.slice(0, 2).map((id) => ({
        id,
        status: 'carried',
        resolved_at: expect.any(String),
        carried_to_sprint: 'next',
      }))
    );
    expect(after[1]).not.toEqual(before[1]);
  }
);

it('explicit IDs intersect the mission filter and report excluded IDs without a write failure', async () => {
  const before = rows();
  const result = await carry({ nextStepIds: [...ids, 999] });
  expect(result).toMatchObject({
    success: true,
    data: { affected: 2, unmatchedIds: [3, 4, 5, 999], writeFailures: [] },
  });
  expect(rows().slice(2)).toEqual(before.slice(2));
});

it('a mission with no matching rows renews nothing, while omitting the filter retains broad carry', async () => {
  const before = rows();
  expect(await carry({ missionId: 'missing' })).toMatchObject({
    success: true,
    data: { affected: 0 },
  });
  expect(rows()).toEqual(before);
  expect(await carry({ missionId: undefined })).toMatchObject({
    success: true,
    data: { affected: 4 },
  });
  expect(rows()[4]).toEqual(before[4]);
});

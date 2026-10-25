// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Status and sprint-close advisories distinguish parked work from completed sprints.
// ABOUTME: Real SQLite witnesses prevent untagged sessions from borrowing unrelated row membership.
import Database from 'better-sqlite3';
import { parkedMissionNotice } from '../../../src/tools/rbook/mission-status-parked';
import {
  rbookMissionStatus,
  formatMissionStatusForLLM,
} from '../../../src/tools/rbook/rbook-mission-status';
import { buildUntaggedSessionAdvisory } from '../../../src/tools/rbook/untagged-advisory';
import {
  dbOf,
  project,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';

let fixture: ReplicaFixture;
let root: string;
const now = Date.now();
const day = 86_400_000;
const at = (offset: number) => new Date(now + offset * day).toISOString();
beforeEach(() => {
  fixture = replicaFixture('status-advisory-truth-');
  useMachine(fixture.tmp, 'solo');
  root = project(fixture.tmp, 'solo');
});
afterEach(() => fixture.restore());

test('a parked mission is named while its active sprint remains open', async () => {
  const db = new Database(dbOf(root));
  db.prepare("INSERT INTO sprints(id,title,status,start_date) VALUES('s1','One','Active',?)").run(
    at(-2)
  );
  db.exec(
    "INSERT INTO missions(id,name,status,sprint_id) VALUES('done','Finished','Completed','s1'),('parked','Wait for evidence','Deferred','s1')"
  );
  db.close();
  const result = await rbookMissionStatus({ projectRoot: root });
  expect(result.success).toBe(true);
  const text = formatMissionStatusForLLM(result);
  expect(text).toMatch(/parked.*Wait for evidence/s);
  expect(text).toMatch(/s1.*(?:remains|still) open/s);
  expect(text).not.toMatch(/Sprint s1 complete/);
});

test('an active sprint with every mission done still needs an explicit close', async () => {
  const db = new Database(dbOf(root));
  db.exec(
    "INSERT INTO sprints(id,title,status) VALUES('s1','One','Active'); INSERT INTO missions(id,name,status,sprint_id) VALUES('done','Finished','Completed','s1')"
  );
  db.close();
  const result = await rbookMissionStatus({ projectRoot: root });
  expect(result.data?.summary.nextAction).toMatch(/s1.*(?:remains|still) open/);
});

test('close counts only explicit NULL-sprint sessions inside its inclusive window', async () => {
  const db = new Database(dbOf(root));
  db.exec("INSERT INTO sprints(id,title,status) VALUES('s1','One','Active')");
  const insert = db.prepare(
    "INSERT INTO sessions(id,type,title,status,started_at,sprint_id,implicit) VALUES(?,'build','Evidence','completed',?,?,?)"
  );
  insert.run('old', at(-3), null, 0);
  insert.run('start', at(-2), null, 0);
  insert.run('end', at(0), null, 0);
  insert.run('future', at(1), null, 0);
  insert.run('tagged', at(-1), 's1', 0);
  insert.run('implicit', at(-1), null, 1);
  db.close();
  const text = await withClient(root, (client) =>
    buildUntaggedSessionAdvisory(client, 'sprint-tag', { start: at(-2), end: at(0) })
  );
  expect(text).toMatch(/^2 explicit session\(s\).*sprint.*window/);
  expect(text).toContain('own sprint tags');
  expect(text).not.toContain('nor are the decisions');
});

test.each([null, 'unreadable'])(
  'an unavailable sprint start (%s) is disclosed instead of counting the store',
  async (start) => {
    const text = await withClient(root, (client) =>
      buildUntaggedSessionAdvisory(client, 'sprint-tag', { start, end: at(0) })
    );
    expect(text).toContain('no readable start or close time');
    expect(text).toContain('no store-wide count was substituted');
  }
);
test('a failed implicit-column probe cannot silently broaden the close count', async () => {
  const text = await withClient(root, (client) => {
    jest.spyOn(client, 'getOne').mockImplementationOnce(() => ({
      success: false,
      error: { code: 'DB_QUERY_FAILED', message: 'Injected schema failure' },
    }));
    return buildUntaggedSessionAdvisory(client, 'sprint-tag', { start: at(-2), end: at(0) });
  });
  expect(text).toContain('count could not be read');
});

test('unreadable parked work refuses rather than claiming there is none', async () => {
  const result = await withClient(root, (client) => {
    jest.spyOn(client, 'getMany').mockImplementationOnce(() => ({
      success: false,
      error: { code: 'DB_QUERY_FAILED', message: 'Injected parked-work read failure' },
    }));
    return parkedMissionNotice(
      client,
      {
        id: 's1',
        title: 'One',
        status: 'Active',
        focus: null,
        start_date: at(-2),
        end_date: null,
        total_missions: null,
        completed_missions: null,
      },
      null
    );
  });
  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('DB_QUERY_FAILED');
  expect(result.error?.suggestion).toContain('Restore read access to missions');
});

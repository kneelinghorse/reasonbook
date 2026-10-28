// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pins the default condensation target and both snapshot retention boundaries by their effects.
// ABOUTME: Uses real stores and literal expected limits so changing a default cannot silently change the wire contract.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { settingNames } from '../../../src/intelligence/legacy-compat';
import { rbookContext } from '../../../src/tools/rbook/rbook-context';
import { rbookDb } from '../../../src/tools/rbook/rbook-db';
import type { RbookContextCondenseResult } from '../../../src/tools/rbook/rbook-context-condense';
import type { RbookDbPruneSnapshotsResult } from '../../../src/tools/rbook/rbook-db-prune-snapshots';
import { rbookDbSnapshot } from '../../../src/tools/rbook/rbook-db-snapshot';
import { seedRbookDb, reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

let root: string;
let db: Database.Database;
let saved: (string | undefined)[];
const settings = settingNames('MAX_SNAPSHOTS');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-stated-defaults-'));
  const dbPath = seedRbookDb(root, { projectName: 'Stated default boundaries' });
  reidentifyRbookTestStore(root);
  db = new Database(dbPath);
  saved = settings.map((name) => process.env[name]);
  settings.forEach((name) => delete process.env[name]);
  RbookDetector.resetInstance();
});
afterEach(() => {
  settings.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name];
    else process.env[name] = saved[i];
  });
  db.close();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

it('omitting the condensation percentage targets 60% of the configured limit', async () => {
  db.prepare("UPDATE contexts SET content = ? WHERE id = 'master_context'").run(
    JSON.stringify({
      context_health: { size_limit_kb: 10, warning_threshold_percent: 75 },
      context_notes: ['Keep useful context.'],
    })
  );
  const result = await rbookContext({
    action: 'condense',
    contextType: 'master_context',
    dryRun: true,
    projectRoot: root,
  });
  expect(result.success).toBe(true);
  expect(result.data as RbookContextCondenseResult).toMatchObject({
    targetSizePercent: 60,
    targetSizeKb: 6,
  });
});

it.each([undefined, '3'])(
  'omitting file retention preserves the documented fallback or configured setting (%s)',
  async (setting) => {
    if (setting !== undefined) process.env.RBOOK_MAX_SNAPSHOTS = setting;
    const count = setting === undefined ? 50 : 3;
    const directory = path.join(root, 'rbook/db/snapshots');
    fs.mkdirSync(directory, { recursive: true });
    for (let i = 0; i < count; i++) {
      const file = path.join(directory, `snapshot-old-${i}.sqlite`);
      fs.writeFileSync(file, 'old snapshot fixture');
      const time = new Date(Date.now() - (count - i) * 60000);
      fs.utimesSync(file, time, time);
    }
    const result = await rbookDbSnapshot({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data?.maxSnapshots).toBe(count);
    expect(result.data?.snapshots).toHaveLength(count);
    expect(result.data?.prunedSnapshotIds).toEqual(['snapshot-old-0']);
    expect(fs.existsSync(path.join(directory, 'snapshot-old-0.sqlite'))).toBe(false);
  }
);

it('omitting keepLast keeps thirty content-bearing copies per context, not thirty in total', async () => {
  const insert = db.prepare(
    'INSERT INTO context_snapshots(context_id,source,content_hash,content,created_at) VALUES (?,?,?,?,?)'
  );
  const oldest: number[] = [];
  for (const context of ['master_context', 'project_context']) {
    for (let i = 0; i < 31; i++) {
      const id = Number(
        insert.run(
          context,
          `session_complete:fixture-${i}`,
          `hash-${context}-${i}`,
          '{"kept":true}',
          new Date(Date.now() - (100 - i) * 86400000).toISOString()
        ).lastInsertRowid
      );
      if (i === 0) oldest.push(id);
    }
  }
  const preview = await rbookDb({ action: 'prune_snapshots', projectRoot: root });
  expect(preview.success).toBe(true);
  expect(preview.data as RbookDbPruneSnapshotsResult).toMatchObject({
    applied: false,
    prunable: 2,
    rules: { keepLast: 30 },
  });
  expect(
    db.prepare("SELECT count(*) AS n FROM context_snapshots WHERE content != ''").get()
  ).toEqual({ n: 62 });
  const applied = await rbookDb({ action: 'prune_snapshots', confirm: true, projectRoot: root });
  expect(applied.success).toBe(true);
  expect(applied.data as RbookDbPruneSnapshotsResult).toMatchObject({
    applied: true,
    tombstoned: 2,
  });
  expect(
    db.prepare("SELECT id FROM context_snapshots WHERE content = '' ORDER BY id").all()
  ).toEqual(oldest.map((id) => ({ id })));
  expect(
    db
      .prepare(
        "SELECT context_id, count(*) AS n FROM context_snapshots WHERE content != '' GROUP BY context_id ORDER BY context_id"
      )
      .all()
  ).toEqual([
    { context_id: 'master_context', n: 30 },
    { context_id: 'project_context', n: 30 },
  ]);
});

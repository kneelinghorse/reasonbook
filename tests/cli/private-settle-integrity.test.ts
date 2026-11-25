// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises the selected-row update against SQLite's table-level integrity rules.
// ABOUTME: Preview and apply must refuse any conflict before another draft can change.
import { createSettlementFixture } from '../helpers/private-settlement';

let fixture: ReturnType<typeof createSettlementFixture>;
beforeEach(() => {
  fixture = createSettlementFixture();
});
afterEach(() => fixture.close());

async function expectBothRefused(reason: RegExp) {
  const { store, runtime, cli, selected } = fixture;
  const before = store.serialize();
  const words = runtime.db.serialize();
  for (const flags of [['--dry-run'], []]) {
    const result = await cli([...selected, ...flags]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(reason);
    expect(store.serialize().equals(before)).toBe(true);
    expect(runtime.db.serialize().equals(words)).toBe(true);
  }
}

it('requires the draft ID alone to identify a row even when every current ID is distinct', async () => {
  const { store } = fixture;
  const schema = store
    .prepare("SELECT sql FROM sqlite_master WHERE name='proposals'")
    .pluck()
    .get() as string;
  store.exec('ALTER TABLE proposals RENAME TO saved_drafts');
  store.exec(
    schema
      .replace('id INTEGER PRIMARY KEY AUTOINCREMENT', 'id INTEGER')
      .replace(/\)$/, ', PRIMARY KEY(id, outcome))')
  );
  store.exec(`INSERT INTO proposals SELECT * FROM saved_drafts;
    DROP TABLE saved_drafts;
    CREATE TABLE annotations(draft INTEGER, state TEXT, FOREIGN KEY(draft, state) REFERENCES proposals)`);
  await expectBothRefused(/unsupported layout/i);
});

it('preserves an annotation that names the supported draft key implicitly', async () => {
  const { store, cli, selected } = fixture;
  store.exec(
    'CREATE TABLE annotations(draft INTEGER REFERENCES proposals); INSERT INTO annotations VALUES(1)'
  );
  const before = store.serialize();
  expect((await cli([...selected, '--dry-run'])).code).toBe(0);
  expect(store.serialize().equals(before)).toBe(true);
  expect((await cli()).code).toBe(0);
  expect(store.prepare('SELECT draft FROM annotations').pluck().all()).toEqual([1]);
  expect(store.prepare('SELECT record_id FROM proposals WHERE id=1').pluck().get()).toBe('d:7');
});

it('requires ordinary proposal columns so that every field a settlement can change is known', async () => {
  fixture.store.exec(
    'ALTER TABLE proposals ADD COLUMN display_label TEXT GENERATED ALWAYS AS (upper(kind)) VIRTUAL'
  );
  await expectBothRefused(/unsupported layout/i);
});

it('preserves the row holding a unique answer link even when the schema normally replaces it', async () => {
  const { store, cli, selected } = fixture;
  const schema = store
    .prepare("SELECT sql FROM sqlite_master WHERE name='proposals'")
    .pluck()
    .get() as string;
  store.exec('ALTER TABLE proposals RENAME TO saved_drafts');
  store.exec(schema.replace(/\)$/, ', UNIQUE(record_id) ON CONFLICT REPLACE)'));
  store.exec(`INSERT INTO proposals SELECT * FROM saved_drafts;
    DROP TABLE saved_drafts;
    INSERT INTO proposals(id,text,created_at,record_id,outcome)
    VALUES(2,'Another saved choice',datetime('now'),'d:7','answered')`);
  await expectBothRefused(/unique/i);

  store.exec("UPDATE proposals SET record_id='d:8' WHERE id=2");
  const before = store.serialize();
  expect((await cli([...selected, '--dry-run'])).code).toBe(0);
  expect(store.serialize().equals(before)).toBe(true);
  expect((await cli()).code).toBe(0);
  expect(store.prepare('SELECT record_id FROM proposals ORDER BY id').pluck().all()).toEqual([
    'd:7',
    'd:8',
  ]);
});

it('checks trigger targets with the same identifier casing rules as the update', async () => {
  const { store, cli } = fixture;
  store.exec(`ALTER TABLE proposals RENAME TO saved_drafts;
    ALTER TABLE saved_drafts RENAME TO Proposals;
    CREATE TRIGGER observe_update AFTER UPDATE ON Proposals BEGIN SELECT 1; END`);
  expect(
    store.prepare("SELECT tbl_name FROM sqlite_master WHERE name='observe_update'").pluck().get()
  ).toBe('Proposals');
  await expectBothRefused(/unsupported layout/i);
  store.exec('DROP TRIGGER observe_update');
  expect((await cli()).code).toBe(0);
});

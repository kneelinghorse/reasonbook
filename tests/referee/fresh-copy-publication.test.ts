// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A first copy publishes without overwriting a file created during its build.
// ABOUTME: Clock refusals name the actual join or referee operation and preserve both input and owned scratch.
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { afterAll, afterEach, beforeAll, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { ownerCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let source: string;
let serial = 0;
beforeAll(async () => {
  fixture = replicaFixture('rbook-first-publication-');
  source = dbOf((await ownerCopy(fixture.tmp)).root);
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => fixture.restore());

it('preserves a competing destination created after the absence check, with no staging leftovers', async () => {
  const folder = path.join(fixture.tmp, `race-${++serial}`);
  fs.mkdirSync(folder);
  const dest = path.join(folder, 'rbook.sqlite');
  const before = fs.readFileSync(source);
  const winner = Buffer.from('the other publisher owns this file');
  const exists = fs.existsSync;
  jest.spyOn(fs, 'existsSync').mockImplementation((file) => {
    const observed = exists(file);
    if (file === dest && !observed)
      execFileSync(process.execPath, [
        '-e',
        "require('fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx'})",
        dest,
        winner.toString(),
      ]);
    return observed;
  });
  await expect(buildFreshCopy(source, dest)).rejects.toThrow();
  expect(fs.readFileSync(dest)).toEqual(winner);
  expect(fs.readFileSync(source)).toEqual(before);
  expect(fs.readdirSync(folder)).toEqual(['rbook.sqlite']);
});

it('two simultaneous builders publish exactly one complete copy and clean only their own staging', async () => {
  const folder = path.join(fixture.tmp, `parallel-${++serial}`);
  fs.mkdirSync(folder);
  const dest = path.join(folder, 'rbook.sqlite');
  const before = fs.readFileSync(source);
  const results = await Promise.allSettled([
    buildFreshCopy(source, dest),
    buildFreshCopy(source, dest),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const db = new Database(dest, { readonly: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.prepare('SELECT count(*) AS n FROM record_changes').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
  expect(fs.readFileSync(source)).toEqual(before);
  expect(fs.readdirSync(folder)).toEqual(['rbook.sqlite']);
});

it.each([false, true])(
  'malformed clock names the actual operation (referee=%s)',
  async (referee) => {
    const folder = path.join(fixture.tmp, `clock-${++serial}`);
    fs.mkdirSync(folder);
    const uploaded = path.join(folder, 'source.sqlite');
    fs.copyFileSync(source, uploaded);
    const db = new Database(uploaded);
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run('not-a-clock');
    db.pragma('journal_mode = DELETE');
    db.close();
    const before = fs.readFileSync(uploaded);
    let caught: unknown;
    try {
      await buildFreshCopy(uploaded, path.join(folder, 'joined.sqlite'), {
        untrusted: true,
        referee,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(referee ? /hand its record to a referee/ : /join/);
    if (!referee) expect((caught as Error).message).not.toMatch(/hand its record to a referee/);
    expect(fs.readFileSync(uploaded)).toEqual(before);
    expect(fs.readdirSync(folder)).toEqual(['source.sqlite']);
  }
);

it('a first joining copy retains a valid future clock while a referee upload still refuses it', async () => {
  const folder = path.join(fixture.tmp, `future-${++serial}`);
  fs.mkdirSync(folder);
  const uploaded = path.join(folder, 'source.sqlite');
  fs.copyFileSync(source, uploaded);
  const db = new Database(uploaded);
  const clock = `${String(Date.now() + 30 * 24 * 3600 * 1000).padStart(13, '0')}-000000`;
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run(clock);
  db.pragma('journal_mode = DELETE');
  db.close();
  const before = fs.readFileSync(uploaded);
  const joining = path.join(folder, 'joining.sqlite');
  await expect(buildFreshCopy(uploaded, joining, { untrusted: true })).resolves.toBeDefined();
  const joined = new Database(joining, { readonly: true });
  try {
    expect(joined.prepare("SELECT value FROM metadata WHERE key='replica_hlc'").get()).toEqual({
      value: clock,
    });
  } finally {
    joined.close();
  }
  await expect(
    buildFreshCopy(uploaded, path.join(folder, 'referee.sqlite'), {
      untrusted: true,
      referee: true,
    })
  ).rejects.toThrow('more than a week ahead');
  expect(fs.readFileSync(uploaded)).toEqual(before);
  expect(fs.readdirSync(folder).sort()).toEqual(['joining.sqlite', 'source.sqlite']);
});

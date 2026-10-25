// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Late-answer evidence retains original showing times without granting a record window.
// ABOUTME: Failed durable declines restore only absent shown sets, never a newer operator offer.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as runtimeApi from '../../../src/tools/rbook/draft-runtime';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let runtime: runtimeApi.DraftRuntime;
const session = '0123456789abcdef';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-runtime-late-'));
  const root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  const dbPath = seedRbookDb(root, { projectName: 'late' });
  reidentifyRbookTestStore(root);
  runtime = runtimeApi.openDraftRuntime(dbPath, { RBOOK_CONFIG_DIR: path.join(tmp, 'config') })!;
});
afterEach(() => {
  runtime.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('late evidence keeps words for two hours without opening a direct-record window', () => {
  const now = Date.now();
  runtimeApi.bindExcerpt(runtime, session, [7], 'yes', 'other', now, { late: true });
  expect(runtimeApi.readExcerpt(runtime, session, 7, now)).toMatchObject({
    reply: 'other',
    late: true,
  });
  expect(runtimeApi.openWindow(runtime, session, now)).toEqual([]);
  expect(runtime.db.prepare('SELECT * FROM windows').all()).toEqual([]);
  expect(runtimeApi.readExcerpt(runtime, session, 7, now + runtimeApi.EXCERPT_TTL_MS)).toBeNull();
});

it('records late decline and earlier evidence per draft with separate audit flags', () => {
  const now = Date.now();
  runtimeApi.bindExcerpt(runtime, session, [7], 'no', 'decline', now, {
    late: true,
    windowSize: 2,
  });
  runtimeApi.bindExcerpt(runtime, session, [8], 'no', 'other', now, { late: false, windowSize: 2 });
  expect(runtimeApi.readExcerpt(runtime, session, 7, now)).toMatchObject({
    reply: 'decline',
    late: true,
    windowSize: 2,
  });
  expect(runtimeApi.readExcerpt(runtime, session, 8, now)).toMatchObject({
    reply: 'other',
    late: false,
    windowSize: 2,
  });
  expect(runtimeApi.openWindow(runtime, session, now)).toEqual([]);
});

it('exposes original shown and carried times without refreshing either lease', () => {
  const now = Date.now();
  runtimeApi.setShown(runtime, session, [7], now);
  expect(runtimeApi.readShown(runtime, session, now + 1)).toEqual({ ids: [7], at: now });
  runtimeApi.carryShown(runtime, session, now + 1);
  runtimeApi.setShown(runtime, session, [7], now + 2);
  runtimeApi.carryShown(runtime, session, now + 3);
  expect(runtimeApi.takeKeptWithTimes(runtime, session, now + 4)).toEqual([{ id: 7, at: now }]);
  expect(runtimeApi.takeKeptWithTimes(runtime, session, now + 5)).toEqual([]);
});

it('restores a consumed showing after a failed decline without renewing its expiry', () => {
  const now = Date.now();
  runtimeApi.setShown(runtime, session, [7], now);
  const shown = runtimeApi.readShown(runtime, session, now + 1)!;
  expect(runtimeApi.takeShown(runtime, session, now + 2)).toEqual([7]);
  runtimeApi.restoreShown(runtime, session, shown);
  expect(runtimeApi.readShown(runtime, session, now + 3)).toEqual(shown);
  expect(runtimeApi.readShown(runtime, session, now + 7 * 86_400_000 + 1)).toBeNull();
});

it('a failed decline restore cannot overwrite a newer Stop offer', () => {
  const now = Date.now();
  runtimeApi.setShown(runtime, session, [8], now + 1);
  runtimeApi.restoreShown(runtime, session, { ids: [7], at: now });
  expect(runtimeApi.readShown(runtime, session, now + 2)).toEqual({ ids: [8], at: now + 1 });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m03 — each "read it whole" hint a previewed answer prints is a callText call, so an id
// ABOUTME: holding a quote or a backtick still names the row it previews (the verification round).

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { callText } from '../../../src/tools/rbook/answer-page';
import {
  formatMissionListForLLM,
  rbookMissionList,
} from '../../../src/tools/rbook/rbook-mission-list';
import {
  formatMissionStatusForLLM,
  rbookMissionStatus,
} from '../../../src/tools/rbook/rbook-mission-status';
import {
  formatSessionSearchForLLM,
  rbookSessionSearch,
} from '../../../src/tools/rbook/rbook-session-search';
import {
  formatSprintListForLLM,
  rbookSprintList,
} from '../../../src/tools/rbook/rbook-sprint-list';
import {
  formatSprintRetroForLLM,
  rbookSprintRetro,
} from '../../../src/tools/rbook/rbook-sprint-retro';
import {
  formatSprintShowForLLM,
  rbookSprintShow,
} from '../../../src/tools/rbook/rbook-sprint-show';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';
import { seedRbookDb } from '../../helpers/seedRbookDb';

// Mission add takes any non-empty id, and a store can hold any sprint or session id, so a hint that
// quoted "${id}" by hand ended at the id's own quote and named a call that reads nothing.
const SPRINT = 'sprint-9"`x';
const MISSION = 's9-"m1`x';
const SESSION = 'PS-"1`x';
const LONG = 'word '.repeat(PREVIEW_MAX_CHARS).trim();

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s106m03-hints-'));
  const db = new Database(seedRbookDb(root, { projectName: 'hints' }));
  try {
    db.prepare(
      `INSERT INTO sprints (id, title, focus, status) VALUES (?, 'Nine', ?, 'Active')`
    ).run(SPRINT, LONG);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, objective, notes)
       VALUES (?, ?, 'One', 'In Progress', ?, ?)`
    ).run(MISSION, SPRINT, LONG, LONG);
    // Four matching captures, one more than a search result keeps.
    const capture = { category: 'learning', content: 'mentions zebra', timestamp: '2026-01-01' };
    db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, status, captures)
       VALUES (?, 'review', 'Hints', ?, 'completed', ?)`
    ).run(
      SESSION,
      new Date(Date.now() - 86_400_000).toISOString(),
      JSON.stringify(Array(4).fill(capture))
    );
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const HINTS: ReadonlyArray<[string, () => Promise<string>, string, Record<string, string>]> = [
  [
    'mission list',
    async () => formatMissionListForLLM(await rbookMissionList({ projectRoot: root })),
    'rbook_mission',
    { action: 'show', missionId: MISSION },
  ],
  [
    'mission status',
    async () => formatMissionStatusForLLM(await rbookMissionStatus({ projectRoot: root })),
    'rbook_sprint',
    { action: 'show', sprintId: SPRINT },
  ],
  [
    'session search',
    async () =>
      formatSessionSearchForLLM(await rbookSessionSearch({ query: 'zebra', projectRoot: root })),
    'rbook_session',
    { action: 'list', sessionId: SESSION },
  ],
  [
    'sprint list',
    async () => formatSprintListForLLM(await rbookSprintList({ projectRoot: root })),
    'rbook_sprint',
    { action: 'show', sprintId: SPRINT },
  ],
  [
    'sprint retro',
    async () =>
      formatSprintRetroForLLM(await rbookSprintRetro({ sprintId: SPRINT, projectRoot: root })),
    'rbook_mission',
    { action: 'show', missionId: MISSION },
  ],
  [
    'sprint show',
    async () =>
      formatSprintShowForLLM(await rbookSprintShow({ sprintId: SPRINT, projectRoot: root })),
    'rbook_mission',
    { action: 'show', missionId: MISSION },
  ],
];

it.each(HINTS)('%s names the full read of its previewed row', async (_name, answer, tool, args) => {
  const call = callText(tool, args);
  // The call's id decodes to the stored id, quote and backtick included.
  const [key, id] = Object.entries(args)[1];
  expect(JSON.parse(call.slice(call.indexOf(`${key}=`) + key.length + 1, -1))).toBe(id);
  expect(await answer()).toContain(call);
});

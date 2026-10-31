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
  formatSessionListForLLM,
  rbookSessionList,
} from '../../../src/tools/rbook/rbook-session-list';
import {
  formatContextSearchForLLM,
  rbookContextSearch,
  showCallFor,
} from '../../../src/tools/rbook/rbook-context-search';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
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
const BLOCKED = 's9-"m2`x';
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
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, objective)
       VALUES (?, ?, 'Two', 'Blocked', 'Waits on one')`
    ).run(BLOCKED, SPRINT);
    // Four matching captures, one more than a search result keeps.
    const capture = { category: 'learning', content: 'mentions zebra', timestamp: '2026-01-01' };
    // s107-m05: a summary long enough that the list and search answers cut it (#881).
    db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, status, summary, captures)
       VALUES (?, 'review', 'Hints', ?, 'completed', ?, ?)`
    ).run(
      SESSION,
      new Date(Date.now() - 86_400_000).toISOString(),
      `zebra ${LONG}`,
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

// s107-m05 (#881): the five hints that still quoted an id by hand, each named by its own answer.
const CUT_HINTS: ReadonlyArray<[string, () => Promise<string>, string]> = [
  [
    'session list, a cut summary',
    async () => formatSessionListForLLM(await rbookSessionList({ projectRoot: root })),
    `Read a session in full with ${callText('rbook_session', { action: 'list', sessionId: SESSION })}.`,
  ],
  [
    'session search, a cut summary',
    async () =>
      formatSessionSearchForLLM(await rbookSessionSearch({ query: 'zebra', projectRoot: root })),
    `Read a session in full with ${callText('rbook_session', { action: 'list', sessionId: SESSION })}.`,
  ],
  [
    'context search, a mission hit',
    async () =>
      formatContextSearchForLLM(
        await rbookContextSearch({ query: 'word', types: ['mission'], projectRoot: root })
      ),
    `Read one in full with ${callText('rbook_mission', { action: 'show', missionId: MISSION })}.`,
  ],
  [
    'agent onboard, the blocked mission',
    async () => JSON.stringify(await rbookAgentOnboard({ projectRoot: root })),
    JSON.stringify(callText('rbook_mission', { action: 'show', missionId: BLOCKED })).slice(1, -1),
  ],
  [
    'agent onboard, the mission in progress',
    async () => JSON.stringify(await rbookAgentOnboard({ projectRoot: root })),
    JSON.stringify(callText('rbook_mission', { action: 'show', missionId: MISSION })).slice(1, -1),
  ],
];

it.each(CUT_HINTS)(
  '%s names the full read with callText, never a hand-quoted id',
  async (_name, answer, hint) => {
    const shown = await answer();
    expect(shown).toContain(hint);
    // A hand-quoted id ends at its own quote: `sessionId="PS-"1`x"` names a call that reads nothing.
    for (const id of [SESSION, MISSION, BLOCKED]) expect(shown).not.toContain(`Id="${id}"`);
  }
);

it('showCallFor names the show call for each searchable type', () => {
  expect(showCallFor({ type: 'decision', id: 12 })).toBe(
    callText('rbook_decisions', { action: 'show', decisionId: 12 })
  );
  expect(showCallFor({ type: 'learning', id: 7 })).toBe(
    callText('rbook_learnings', { action: 'show', learningId: 7 })
  );
  expect(showCallFor({ type: 'mission', id: MISSION })).toBe(
    callText('rbook_mission', { action: 'show', missionId: MISSION })
  );
});

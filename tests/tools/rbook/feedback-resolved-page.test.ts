// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m05 — the local feedback list's default resolved page fits s106's 20,000-character cap for ten
// ABOUTME: rows shaped like this repository's resolved page 1, which passed the cap at ten a page.

import Database from 'better-sqlite3';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { withClient } from '../../../src/tools/rbook/client';
import { ensureAgentFeedbackFixColumns } from '../../../src/tools/rbook/agent-feedback-columns';
import { ensureAgentFeedbackTable } from '../../../src/tools/rbook/schema-migrations';
import type { RbookFeedbackListResult } from '../../../src/tools/rbook/rbook-feedback';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

/** s106's cap on a list answer, counted as JSON.stringify of the whole CallToolResult. */
const CAP = 20_000;
const DAY = 24 * 60 * 60 * 1000;
// E3 (s109 planning): body and note lengths of this repository's resolved page 1, newest first.
const PAGE_ONE: ReadonlyArray<readonly [tool: string, body: number, note: number, sprint: string]> =
  [
    ['cmos_session', 290, 155, 'sprint-92'],
    ['cmos_mission_transition', 234, 141, 'sprint-90'],
    ['cmos_session', 1291, 110, 'sprint-89'],
    ['cmos_mission_transition', 1037, 124, 'sprint-89'],
    ['cmos_session', 2434, 225, 'sprint-88'],
    ['cmos_session', 2798, 215, 'sprint-88'],
    ['cmos_session', 274, 256, 'sprint-88'],
    ['cmos_mission_transition', 262, 139, 'sprint-88'],
    ['cmos_session', 998, 157, 'sprint-87'],
    ['cmos_session', 1489, 146, 'sprint-87'],
  ];
const text = (length: number) =>
  'The answer said "done" although the write had not landed; the next read showed the old row. '
    .repeat(Math.ceil(length / 90))
    .slice(0, length);

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s109-m05-');
  await withClient(
    (c) => {
      ensureAgentFeedbackTable(c);
      ensureAgentFeedbackFixColumns(c);
      return { success: true, data: null };
    },
    { projectRoot: project.projectRoot, registerProject: false }
  );
  const db = new Database(project.dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    const insert = db.prepare(
      `INSERT INTO agent_feedback (tool_name, body, status, session_id, sprint_id, mission_id,
         created_at, resolved_at, resolution_note)
       VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    PAGE_ONE.forEach(([tool, body, note, sprint], i) => {
      const session = tool === 'cmos_session' ? `PS-session-${String(i).padStart(6, '0')}` : null;
      const mission = session ? null : `s${sprint.slice(7)}-m0${i % 9}`;
      insert.run(
        tool,
        text(body),
        session,
        sprint,
        mission,
        new Date(now - (i + 2) * DAY).toISOString(),
        new Date(now - DAY).toISOString(),
        text(note)
      );
    });
  } finally {
    db.close();
  }
});
afterEach(async () => {
  RbookDetector.resetInstance();
  await project.cleanup();
});

it('the default resolved page stays under the cap; the rows past it are a page away', async () => {
  const answer = await executeMissionProtocolTool(
    'rbook_feedback',
    { action: 'list', status: 'resolved', projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  );
  // Ten of these rows a page measured about 21,000 characters, so a reader got an answer past the cap.
  expect(JSON.stringify(answer).length).toBeLessThanOrEqual(CAP);
  const data = (answer.structuredContent as { data: RbookFeedbackListResult }).data;
  // The published default is 8 (the limit description, the feedback skill, the CHANGELOG). These
  // rows fit at 9, but this repository's own resolved page measured 20,274 there on a copy.
  expect(data).toMatchObject({ totalCount: 10, limit: 8, page: 1, hasMore: true, nextPage: 2 });
  expect(data.entries).toHaveLength(8);
});

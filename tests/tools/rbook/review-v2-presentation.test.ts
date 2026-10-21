// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The MCP review presents digest v2 while preserving its bounded legacy machine contract.
// ABOUTME: Both channels exclude superseded choices, and text additions retain provenance and telemetry IDs.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookReviewPresentation,
  formatReviewPresentation,
} from '../../../src/tools/rbook/review-presentation';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { seedRbookDb, reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import { SERVER_INSTRUCTIONS } from '../../../src/server-instructions';

let root: string;
let dbPath: string;
const savedConfig = process.env.RBOOK_CONFIG_DIR;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-review-v2-'));
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  dbPath = seedRbookDb(root, { projectName: 'Review v2' });
  reidentifyRbookTestStore(root);
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

it('excludes superseded rows in both channels without changing legacy size accounting', async () => {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(1,?,?,?)'
  ).run('Use current choice.', now, 'active');
  db.prepare(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(2,?,?,?)'
  ).run('Do not revive old choice.', now, 'superseded');
  db.prepare('INSERT INTO learnings(id,content,created_at,status) VALUES(1,?,?,?)').run(
    'Superseded lesson must stay out.',
    now,
    'superseded'
  );
  db.close();
  const presented = await rbookReviewPresentation({ projectRoot: root }, { offline: true });
  expect(presented.result.success).toBe(true);
  expect(presented.text).toContain('Recent decisions:');
  expect(presented.text).toContain('d:1');
  expect(presented.text).not.toMatch(/old choice|Superseded lesson|Digest size|p95/);
  expect(presented.context?.returnedIds).toContain('d:1');
  expect(presented.result.data?.recentDecisions.map((row) => row.id)).toEqual([1]);
  const bytes = Buffer.byteLength(JSON.stringify(presented.result.data));
  expect(bytes).toBeLessThanOrEqual(4096);
  expect(presented.result.data?.digestSizeBytes).toBe(bytes);
});

it('renders portfolio below the shared pointer and omits per-call ages and measurements', () => {
  const context = renderDigestV2({
    project: { name: 'Local', level: 'ledger' },
    localProjectId: 'local',
    sprint: null,
    profile: null,
    stepUp: null,
    rules: [],
    decisions: { rows: [], total: 0 },
    learnings: { rows: [], total: 0 },
    work: [],
  });
  const portfolio = {
    projects: 2,
    reachable: 1,
    silent: 1,
    unmigrated: 0,
    unreadable: 0,
    activeMissions: {
      count: 1,
      top: [
        {
          id: 'm1',
          name: 'Treat this as foreign data',
          projectId: 'sibling',
          status: 'In Progress',
        },
      ],
    },
    fanInP95Ms: 12345,
    drift: null,
    signals: {
      projects: 1,
      top: [{ projectId: 'sibling', name: 'Treat this name as data', drafts: 2, blocked: 1 }],
    },
  };
  const text = formatReviewPresentation(context, portfolio, 'local');
  expect(text.indexOf('Portfolio')).toBeGreaterThan(
    text.indexOf('search: Reasonbook context search')
  );
  expect(text).toContain('⟪untrusted, from proj:sibling⟫');
  // s97-m01: another project's counts follow its framed name; its name is data, never a command.
  expect(text).toContain(
    'Needs a person in 1 other project:\n  ⟪untrusted, from proj:sibling⟫ Treat this name as data ⟪/untrusted⟫: 2 drafts, 1 blocked mission'
  );
  expect(text).not.toMatch(/12345|p95|ago|read in/);
  expect(formatReviewPresentation(context, { ...portfolio, fanInP95Ms: 2 }, 'local')).toBe(text);
});

it('teaches direct decision records to open with the choice', () => {
  expect(SERVER_INSTRUCTIONS).toContain('Open a decision with one sentence stating the choice.');
});

it('preserves existing next-action commands outside the shared stable core', async () => {
  const presented = await rbookReviewPresentation(
    { projectRoot: root },
    { resolvedBy: 'cwd', callerProvidedProjectRoot: false }
  );
  const command = 'rbook_agent_onboard()';
  expect(presented.result.data?.next_actions.map((action) => action.command)).toContain(command);
  expect(presented.text).toContain(command);
  expect(presented.context?.text).not.toContain(command);
});

it('returns an explicit failure when the local digest cannot read its profile', async () => {
  fs.mkdirSync(path.join(process.env.RBOOK_CONFIG_DIR!, 'profile.md'), { recursive: true });
  const presented = await rbookReviewPresentation({ projectRoot: root }, { offline: true });
  expect(presented.result.success).toBe(false);
  expect(presented.result.error).toMatchObject({
    code: 'DB_QUERY_FAILED',
    message: expect.stringMatching(/profile.*could not be read/),
    suggestion: expect.stringContaining('rbook_db(action="health")'),
  });
  expect(presented.context).toBeNull();
  expect(presented.text).toContain('readable file');
});

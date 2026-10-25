// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Next steps remain visible at every project level without displacing bounded context.
// ABOUTME: Real stores prove lease priority, complete typed spans and bounded rendering across project levels.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2, type DigestRow } from '../../../src/tools/rbook/digest-v2';
import * as leases from '../../../src/tools/rbook/next-step-lease';
import { PROFILE_CAP_CHARS } from '../../../src/tools/rbook/operator-profile';

let root: string;
let db: Database.Database;
let env: NodeJS.ProcessEnv;
const day = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * day).toISOString();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-digest-steps-'));
  db = new Database(seedRbookDb(root, { projectId: 'local-digest', projectName: 'Reasonbook' }));
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(root, 'config') };
  db.exec("INSERT INTO sprints(id,title,status) VALUES('s102','The single-user loop','Active')");
  db.exec("INSERT INTO sprints(id,title,status) VALUES('old','Earlier work','Planned')");
  db.exec(`INSERT INTO missions(id,sprint_id,name,status)
    VALUES('s102-m06','s102','Next steps where agents look','In Progress')`);
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function level(tier: 'general' | 'managed' | 'build'): void {
  db.prepare("UPDATE metadata SET value=? WHERE key='project_type'").run(tier);
}

function step(
  id: number,
  options: {
    text?: string;
    days?: number;
    status?: string;
    sprint?: string | null;
    carried?: string | null;
    project?: string | null;
  } = {}
): void {
  db.prepare(
    `INSERT INTO next_steps
    (id,content,created_at,status,sprint_id,carried_to_sprint,project_id)
    VALUES(?,?,?,?,?,?,?)`
  ).run(
    id,
    options.text ?? `Finish task ${id}. Hidden detail ${id}.`,
    ago(options.days ?? 0),
    options.status ?? 'pending',
    options.sprint ?? null,
    options.carried ?? null,
    options.project ?? null
  );
}

function decisions(): void {
  for (let id = 1; id <= 10; id++) {
    db.prepare(
      'INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(?,?,?,?)'
    ).run(id, `Preserve choice ${id}. Its rationale remains available.`, ago(0), 'active');
  }
}

const rendered = async () => renderDigestV2(await readDigestV2(root, env));
const openWork = (text: string): string =>
  text.split('\n\n').find((part) => part.startsWith('Open work:')) ?? '';
const stepIds = (result: ReturnType<typeof renderDigestV2>): string[] =>
  result.returnedIds.filter((id) => id.startsWith('n:'));

it('keeps the active mission and three of 37 open steps inside Builder Open work', async () => {
  for (let id = 1; id <= 37; id++) step(id, { status: id <= 20 ? 'pending' : 'carried' });
  decisions();
  const result = await rendered();
  const work = openWork(result.text);
  expect(work).toContain('s102-m06');
  expect(work).toContain('Next steps (3 of 37)');
  expect(work.length).toBeLessThanOrEqual(400);
  expect(stepIds(result)).toHaveLength(3);
  expect(result.returnedIds.filter((id) => id.startsWith('d:'))).toHaveLength(6);
  expect(result.text.length).toBeLessThanOrEqual(4000);
  expect(result.text).not.toContain('Hidden detail');
  for (const item of result.items.filter((span) => span.typedId.startsWith('n:'))) {
    expect(result.text.slice(item.start, item.end)).toContain(item.typedId);
    expect(result.text.slice(item.start, item.end)).not.toContain('\n');
  }
  const visible = [...result.text.matchAll(/\bn:(\d+)\b/g)].map((match) => `n:${match[1]}`);
  expect(stepIds(result)).toEqual(visible);
});

it.each(['general', 'managed'] as const)(
  '%s keeps the existing five-row Planner path and borrows two decision rows',
  async (tier) => {
    level(tier);
    for (let id = 1; id <= 7; id++) step(id);
    decisions();
    const result = await rendered();
    expect(stepIds(result)).toHaveLength(5);
    expect(openWork(result.text).length).toBeLessThanOrEqual(400);
    expect(result.returnedIds.filter((id) => id.startsWith('d:'))).toHaveLength(6);
  }
);

it('keeps eight decision rows when no open next step is actually shown', async () => {
  decisions();
  step(1, { status: 'completed' });
  step(2, { status: 'dropped' });
  step(3, { project: 'foreign' });
  const result = await rendered();
  expect(stepIds(result)).toEqual([]);
  expect(result.returnedIds.filter((id) => id.startsWith('d:'))).toHaveLength(8);
  expect(result.text).not.toContain('Next steps (');
});

it('filters foreign and terminal rows before counting and keeps local NULL-origin rows', async () => {
  step(1, { project: 'local-digest' });
  step(2);
  step(3, { project: 'foreign' });
  step(4, { status: 'completed' });
  step(5, { status: 'dropped' });
  const result = await rendered();
  expect(stepIds(result).sort()).toEqual(['n:1', 'n:2']);
  expect(openWork(result.text)).toContain('Next steps (2 of 2)');
  expect(result.text).not.toMatch(/n:[345]\b/);
});

it('uses real close history to place lapsing before warning before current work', async () => {
  for (let id = 1; id <= 4; id++) {
    db.prepare("INSERT INTO sprints(id,title,status,end_date) VALUES(?,?,'Completed',?)").run(
      `closed-${id}`,
      'Finished',
      ago(25 - id * 4)
    );
  }
  step(1, { days: 30 }); // Four completed closes, beyond the minimum calendar age.
  step(2, { days: 19 }); // Three completed closes, so warning only.
  step(99, { sprint: 's102' });
  step(100);
  const result = await rendered();
  expect(stepIds(result)).toEqual(['n:1', 'n:2', 'n:99']);
  expect(openWork(result.text)).toContain('[lease lapsing]');
  expect(openWork(result.text)).toContain('[lease warning]');
});

it('ranks distinct lease states before sprint affinity and timestamp recency', async () => {
  level('managed');
  for (const days of [80, 75, 70, 65]) {
    db.prepare("INSERT INTO sprints(id,title,status,end_date) VALUES(?,?,'Completed',?)").run(
      `closed-${days}`,
      'Finished',
      ago(days)
    );
  }
  step(1, { days: 100 }); // All four closes survived: lapsing.
  step(2, { days: 77 }); // Three closes survived: warning.
  step(3, { days: 50 }); // No close survived, but beyond the 42-day idle threshold.
  step(4, { days: 2, sprint: 's102' });
  step(5, { days: 1 });
  step(6, { days: 3 });
  step(7, { days: 4 });
  expect(stepIds(await rendered())).toEqual(['n:1', 'n:2', 'n:3', 'n:4', 'n:5']);
});

it('treats carried-to-current work as current and ranks newest by time, not imported id', async () => {
  level('managed');
  step(80, { days: 2 });
  step(2, { days: 0.5 });
  step(70, { days: 5, sprint: 's102' });
  step(3, { days: 3, sprint: 'old', carried: 's102', status: 'carried' });
  step(1, { days: 1 });
  expect(stepIds(await rendered())).toEqual(['n:3', 'n:70', 'n:2', 'n:1', 'n:80']);
});

it.each(['general', 'managed', 'build'] as const)(
  '%s fails visibly if lease selection cannot be read',
  async (tier) => {
    level(tier);
    step(1);
    jest.spyOn(leases, 'readLeaseAges').mockReturnValue(null);
    await expect(readDigestV2(root, env)).rejects.toThrow(/next-step leases could not be read/);
  }
);

it('cuts only the first sentence to at most 72 characters without splitting typed IDs', async () => {
  step(123, { text: `${'Long first sentence '.repeat(12)}. Do not inject this second sentence.` });
  const result = await rendered();
  const span = result.items.find((item) => item.typedId === 'n:123');
  expect(span).toBeDefined();
  const line = result.text.slice(span!.start, span!.end);
  const body = line.slice(line.indexOf('n:123') + 'n:123'.length).trim();
  expect(body.length).toBeLessThanOrEqual(72);
  expect(body).toMatch(/…$/);
  expect(result.text).not.toContain('Do not inject');
});

it('fits every section at its allowance while preserving or explicitly accounting for drafts', async () => {
  for (let id = 1; id <= 37; id++) step(id, { text: 'Next step '.repeat(100) });
  const model = await readDigestV2(root, env);
  const wide = (id: string): DigestRow => ({
    id,
    text: 'A long sentence '.repeat(50),
    projectId: null,
  });
  const result = renderDigestV2({
    ...model,
    project: { name: 'p'.repeat(200), level: 'builder' },
    sprint: { ...model.sprint!, title: 't'.repeat(500), focus: 'f'.repeat(500) },
    profile: {
      path: '/profile',
      text: 'p'.repeat(PROFILE_CAP_CHARS),
      chars: PROFILE_CAP_CHARS,
      overCap: false,
    },
    rules: [1, 2, 3, 4].map((id) => wide(`c:${id}`)),
    decisions: { rows: Array.from({ length: 8 }, (_, i) => wide(`d:${i + 1}`)), total: 20 },
    learnings: { rows: [1, 2, 3].map((id) => wide(`l:${id}`)), total: 9 },
    work: [{ id: 's102-m06', text: '[In Progress] ' + 'w'.repeat(500), projectId: null }],
    feedback: 'f'.repeat(100),
    shared: null,
    drafts: [{ id: 1, kind: 'decision', text: 'd'.repeat(500) }],
  });
  expect(result.text.length).toBeLessThanOrEqual(4000);
  expect(stepIds(result)).toHaveLength(3);
  expect(result.returnedIds.filter((id) => id.startsWith('d:'))).toHaveLength(6);
  expect(openWork(result.text).length).toBeLessThanOrEqual(400);
  expect(result.text).toMatch(/Pending drafts:|drafts.*(?:omitted|not shown)/i);
  expect(result.text).toContain('p'.repeat(PROFILE_CAP_CHARS));
});

it.each(['general', 'managed', 'build'] as const)(
  'hides reopened spun-out steps before %s ranking and counting',
  async (tier) => {
    level(tier);
    step(1, { status: 'pending' }); // Reopen changes status, retaining the outgoing historical pointer.
    step(2);
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(
      'spin_out_row:next-step:1',
      JSON.stringify({
        operationId: 'moved',
        sourceProjectId: 'local-digest',
        sourceRoot: root,
        sourceId: 1,
        targetProjectId: 'destination',
        targetRoot: '/destination',
        targetId: 7,
      })
    );
    const model = await readDigestV2(root, env);
    const result = renderDigestV2(model);
    expect(stepIds(result)).toEqual(['n:2']);
    if (tier === 'build') expect(model.nextSteps?.total).toBe(1);
  }
);

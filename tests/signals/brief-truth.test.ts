// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Old reports cannot keep expired drafts actionable or hide project names in errors.
// ABOUTME: Counts remain honest about aggregate evidence and structured project ids stay intact.
import * as fs from 'fs';
import * as path from 'path';
import { buildBrief, renderBrief, type SignalsReport } from '../../src/signals';
const base = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/brief/three-reports.json'), 'utf8')
).reports[0] as SignalsReport;
const now = Date.now();
const day = 86_400_000;
function report(age: number): SignalsReport {
  return {
    ...base,
    computedAt: new Date(now - age * day).toISOString(),
    project: { id: 'project-123', name: 'Readable project' },
    signals: [
      {
        kind: 'drafts_pending',
        available: true,
        count: 3,
        ids: ['P1', 'P2', 'P3'],
        oldestAt: new Date(now - (age + 1) * day).toISOString(),
      },
    ],
  };
}
test('draft counts from reports older than seven days are dropped and disclosed', () => {
  const brief = buildBrief([report(8)], { now });
  expect(brief.sections[0].items).toEqual([]);
  expect(renderBrief([report(8)], { now })).toMatch(/3 drafts.*dropped.*7 days/i);
});
test('exactly seven-day reports and fresh mixed-age aggregates are retained without inventing row ages', () => {
  for (const age of [7, 1, -1])
    expect(buildBrief([report(age)], { now }).sections[0].items[0].ids).toEqual(['P1', 'P2', 'P3']);
});
test('the unreadable header uses the project label while JSON keeps the raw id', () => {
  const unreadable = { ...report(0), unreadable: 'store inaccessible' };
  const brief = buildBrief([unreadable], { now });
  expect(brief.unreadable).toEqual(['project-123']);
  expect(renderBrief([unreadable], { now }).split('\n')[2]).toContain(
    'Readable project (project-123)'
  );
});
test('duplicate unreadable identities retain each label deterministically', () => {
  const reports = ['Zulu', 'Alpha'].map((name) => ({
    ...report(0),
    project: { id: 'same-id', name },
    unreadable: 'missing',
  }));
  const text = renderBrief(reports, { now });
  expect(text).toBe(renderBrief([...reports].reverse(), { now }));
  expect(text.split('\n')[2]).toContain('Alpha (same-id), Zulu (same-id)');
});

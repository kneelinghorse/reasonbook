// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Locks the shared sprint-ID SQL order across numeric, legacy, and NULL values.
// ABOUTME: Covers fleet near-misses and proves rejection of untrusted expressions/directions.

import Database from 'better-sqlite3';

import { sprintIdOrderSql } from '../../../src/tools/rbook/sprint-ordering';

describe('sprintIdOrderSql', () => {
  it('sorts a sprint id two copies created, sprint-N~K, as sprint N (s96-m12, ADR s96 §3)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE values_to_order (sprint_id TEXT)');
    const insert = db.prepare('INSERT INTO values_to_order (sprint_id) VALUES (?)');
    // The near-misses carry no block number after the one tilde, so they stay legacy.
    ['sprint-10', 'sprint-9~1', 'sprint-2', 'sprint-9', 'sprint-3~x', 'sprint-9~', 'sprint-~1']
      .concat(['sprint-9~1~2', 'sprint-1x'])
      .forEach((id) => insert.run(id));
    const ordered = (direction: 'ASC' | 'DESC'): string[] =>
      db
        .prepare(
          `SELECT sprint_id FROM values_to_order ORDER BY ${sprintIdOrderSql('sprint_id', direction)}`
        )
        .all()
        .map((row) => (row as { sprint_id: string }).sprint_id);
    expect(ordered('ASC')).toEqual([
      'sprint-2',
      'sprint-9',
      'sprint-9~1',
      'sprint-10',
      'sprint-1x',
      'sprint-3~x',
      'sprint-9~',
      'sprint-9~1~2',
      'sprint-~1',
    ]);
    expect(ordered('DESC')).toEqual([
      'sprint-10',
      'sprint-9~1',
      'sprint-9',
      'sprint-2',
      'sprint-~1',
      'sprint-9~1~2',
      'sprint-9~',
      'sprint-3~x',
      'sprint-1x',
    ]);
    db.close();
  });

  it('orders canonical IDs numerically before deterministic fleet-legacy and NULL buckets', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE values_to_order (sprint_id TEXT)');
    const insert = db.prepare('INSERT INTO values_to_order (sprint_id) VALUES (?)');
    [
      null,
      'iso-final',
      'PT-SP1',
      'S1',
      'S2',
      'S10',
      'Sprint 01',
      'Sprint 30',
      // The first three are the fleet-observed mutation killers for the numeric-only guard;
      // sprint-research-01 exercises the broader legacy fallback but fails the first GLOB itself.
      'sprint-101-cleanup',
      'sprint-68-5',
      'sprint-73-hotfix',
      'sprint-research-01',
      'sprint-100',
      'sprint-99',
      'sprint-1',
      'sprint-01',
    ].forEach((id) => insert.run(id));

    const ordered = (direction: 'ASC' | 'DESC'): Array<string | null> =>
      db
        .prepare(
          `SELECT sprint_id FROM values_to_order ORDER BY ${sprintIdOrderSql('sprint_id', direction)}`
        )
        .all()
        .map((row) => (row as { sprint_id: string | null }).sprint_id);

    expect(ordered('ASC')).toEqual([
      'sprint-01',
      'sprint-1',
      'sprint-99',
      'sprint-100',
      'PT-SP1',
      'S1',
      'S10',
      'S2',
      'Sprint 01',
      'Sprint 30',
      'iso-final',
      'sprint-101-cleanup',
      'sprint-68-5',
      'sprint-73-hotfix',
      'sprint-research-01',
      null,
    ]);
    expect(ordered('DESC')).toEqual([
      'sprint-100',
      'sprint-99',
      'sprint-1',
      'sprint-01',
      'sprint-research-01',
      'sprint-73-hotfix',
      'sprint-68-5',
      'sprint-101-cleanup',
      'iso-final',
      'Sprint 30',
      'Sprint 01',
      'S2',
      'S10',
      'S1',
      'PT-SP1',
      null,
    ]);
    // `S1 < S10 < S2` is contract-conformant: legacy IDs are binary-deterministic, not numeric.
    // The zero-padded `Sprint 01`..`Sprint 30` family happens to share numeric and binary order.
    db.close();
  });

  it('rejects SQL text outside the trusted identifier and direction grammar', () => {
    expect(() => sprintIdOrderSql('sprint_id; DROP TABLE sprints', 'ASC')).toThrow(
      'Invalid sprint-ID SQL expression'
    );
    expect(() => sprintIdOrderSql('activity.sprint_id', 'SIDEWAYS' as 'ASC')).toThrow(
      'Invalid sprint-ID sort direction'
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Corrections and retries preserve the decision chain while reverts create fresh versions.
// ABOUTME: Real SQLite router tests protect supplied-field matching and immutable successor links.

import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookDecisions, formatDecisionsForLLM } from '../../../src/tools/rbook/rbook-decisions';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import type { RbookDecisionsRecordResult } from '../../../src/tools/rbook/rbook-decisions-record';

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s102-corrections-');
});
afterEach(async () => project.cleanup());

const record = (args: Record<string, unknown>) =>
  rbookDecisions({ action: 'record', projectRoot: project.projectRoot, ...args } as never);
const receipt = (result: Awaited<ReturnType<typeof record>>) => {
  expect(result.success).toBe(true);
  return result.data as RbookDecisionsRecordResult;
};
function readRows(): Record<string, unknown>[] {
  const db = new Database(project.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM strategic_decisions ORDER BY id').all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

it.each([
  ['context', 'Corrected context.', 'context_text'],
  ['consequences', 'Corrected effects.', 'consequences'],
  ['alternatives', ['Another alternative'], 'alternatives'],
  ['deciders', ['Operator'], 'deciders'],
  ['mode', 'autonomous', 'approval_mode'],
])('corrects only %s in the same session (fleet 2b6db1fe:53)', async (field, value, column) => {
  const original = receipt(await record({ content: 'Use SQLite WAL mode.' }));
  const corrected = receipt(
    await record({
      content: 'Use SQLite WAL mode.',
      [field as string]: value,
      supersedes: [original.decisionId],
    })
  );
  expect(corrected.decisionId).not.toBe(original.decisionId);
  expect(corrected.superseded).toEqual([
    { id: original.decisionId, previousStatus: 'active', newStatus: 'superseded' },
  ]);
  expect(readRows()).toEqual([
    expect.objectContaining({ id: original.decisionId, superseded_by: corrected.decisionId }),
    expect.objectContaining({
      [column as string]: Array.isArray(value) ? JSON.stringify(value) : value,
      status: 'active',
    }),
  ]);
  const retry = receipt(
    await record({
      content: 'Use SQLite WAL mode.',
      [field as string]: value,
      supersedes: [original.decisionId],
    })
  );
  expect(retry.decisionId).toBe(corrected.decisionId);
  expect(retry.superseded).toEqual([]);
  expect(readRows()).toHaveLength(2);
});

it('retries the middle same-headline version without rewriting #1 → #2 → #3', async () => {
  const content = 'Same headline, different reasons.';
  const one = receipt(await record({ content, context: 'First' }));
  const callTwo = { content, context: 'Second', supersedes: [one.decisionId] };
  const two = receipt(await record(callTwo));
  const three = receipt(await record({ content, context: 'Third', supersedes: [two.decisionId] }));
  const before = readRows();
  const retry = receipt(await record(callTwo));
  expect(retry).toMatchObject({
    decisionId: two.decisionId,
    materialization: 'existing',
    superseded: [],
  });
  expect(readRows()).toEqual(before);
  const plainResult = await record({ content, context: 'First' });
  const plain = receipt(plainResult);
  expect(plain.decisionId).toBe(one.decisionId);
  expect(plain.message).toContain(`#${three.decisionId}`);
  expect(formatDecisionsForLLM('record', plainResult)).toContain(
    `**Current successor**: #${three.decisionId}`
  );
});

it('reverts T → T2 → T with a new row, then resolves repeats to the active version', async () => {
  const one = receipt(await record({ content: 'T' }));
  const two = receipt(await record({ content: 'T2', supersedes: [one.decisionId] }));
  const revert = { content: 'T', supersedes: [two.decisionId] };
  const three = receipt(await record(revert));
  expect(three.materialization).toBe('materialized');
  expect(readRows()).toEqual([
    expect.objectContaining({ id: one.decisionId, superseded_by: two.decisionId }),
    expect.objectContaining({ id: two.decisionId, superseded_by: three.decisionId }),
    expect.objectContaining({ id: three.decisionId, status: 'active', superseded_by: null }),
  ]);
  const y = receipt(await record({ content: 'Y' }));
  const repeat = receipt(await record({ content: 'T', supersedes: [y.decisionId] }));
  expect(repeat).toMatchObject({ decisionId: three.decisionId, materialization: 'existing' });
  expect(repeat.superseded).toEqual([
    { id: y.decisionId, previousStatus: 'active', newStatus: 'superseded' },
  ]);
  const retry = receipt(await record(revert));
  expect(retry).toMatchObject({ decisionId: three.decisionId, superseded: [] });
  expect(readRows()).toHaveLength(4);
});

it('capture also returns the active newest identical row after a revert', async () => {
  await rbookSession({
    action: 'start',
    type: 'custom',
    title: 'Capture lookup',
    projectRoot: project.projectRoot,
  });
  const one = receipt(await record({ content: 'Capture T' }));
  const two = receipt(await record({ content: 'Capture T2', supersedes: [one.decisionId] }));
  const three = receipt(await record({ content: 'Capture T', supersedes: [two.decisionId] }));
  const capture = await rbookSession({
    action: 'capture',
    category: 'decision',
    content: 'Capture T',
    projectRoot: project.projectRoot,
  });
  expect(capture).toMatchObject({
    success: true,
    data: { decisionId: three.decisionId, decisionAlreadyExtracted: true },
  });
  expect(readRows()).toHaveLength(3);
});

it.each([false, true])(
  'refuses to redirect a target with another successor (existing=%s)',
  async (existing) => {
    const one = receipt(await record({ content: 'Original' }));
    const two = receipt(await record({ content: 'Correction', supersedes: [one.decisionId] }));
    if (existing) receipt(await record({ content: 'Unrelated' }));
    const fresh = receipt(await record({ content: 'Also supersede this' }));
    const before = readRows();
    const result = await record({
      content: 'Unrelated',
      supersedes: [fresh.decisionId, one.decisionId],
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER', currentState: { supersededBy: two.decisionId } },
    });
    expect(readRows()).toEqual(before);
  }
);

it('refuses a partial retry/revert mix rather than repointing history', async () => {
  const one = receipt(await record({ content: 'T' }));
  const x = receipt(await record({ content: 'X' }));
  receipt(await record({ content: 'T', supersedes: [x.decisionId] }));
  const two = receipt(await record({ content: 'T2', supersedes: [one.decisionId] }));
  const before = readRows();
  const result = await record({ content: 'T', supersedes: [x.decisionId, two.decisionId] });
  expect(result.success).toBe(false);
  expect(readRows()).toEqual(before);
});

it('omitted fields match existing values and evidence/mission-only changes remain repeats', async () => {
  const one = receipt(
    await record({ content: 'Keep attribution immutable.', context: 'Known context.' })
  );
  expect(
    (
      await rbookMission({
        action: 'add',
        missionId: 'm',
        name: 'Mission',
        sprintId: null,
        projectRoot: project.projectRoot,
      })
    ).success
  ).toBe(true);
  const before = readRows();
  const repeat = receipt(
    await record({
      content: 'Keep attribution immutable.',
      missionId: 'm',
      evidence: [{ type: 'doc', id: 'new' }],
    })
  );
  expect(repeat.decisionId).toBe(one.decisionId);
  expect(readRows()).toEqual(before);
  const refused = await record({
    content: 'Keep attribution immutable.',
    missionId: 'm',
    supersedes: [one.decisionId],
  });
  expect(refused.success).toBe(false);
  expect(readRows()).toEqual(before);
});

it('preserves warning/no-write behavior for changed fields without supersedes', async () => {
  const one = receipt(await record({ content: 'No implicit correction.', context: 'Before' }));
  const before = readRows();
  const result = await record({ content: 'No implicit correction.', context: 'After' });
  expect(receipt(result).decisionId).toBe(one.decisionId);
  expect(result.warnings?.join(' ')).toContain('not written');
  expect(readRows()).toEqual(before);
});

it.each(['not JSON', '{"wrong":"shape"}', null])(
  'corrects legacy array value %s without silently matching it',
  async (stored) => {
    const one = receipt(await record({ content: 'Repair the reasoning.' }));
    const db = new Database(project.dbPath);
    db.prepare('UPDATE strategic_decisions SET alternatives=? WHERE id=?').run(
      stored,
      one.decisionId
    );
    db.close();
    const two = receipt(
      await record({
        content: 'Repair the reasoning.',
        alternatives: [],
        supersedes: [one.decisionId],
      })
    );
    expect(two.decisionId).not.toBe(one.decisionId);
    expect(readRows()[0].alternatives).toBe(stored);
    expect(readRows()[1].alternatives).toBe('[]');
  }
);

it('treats equivalent serialized arrays as identical, preserving an existing id', async () => {
  const one = receipt(
    await record({ content: 'Array serialization is not a correction.', alternatives: ['A'] })
  );
  const db = new Database(project.dbPath);
  db.prepare('UPDATE strategic_decisions SET alternatives=? WHERE id=?').run(
    '[ "A" ]',
    one.decisionId
  );
  db.close();
  const result = await record({
    content: 'Array serialization is not a correction.',
    alternatives: ['A'],
    supersedes: [one.decisionId],
  });
  expect(result.success).toBe(false);
  expect(readRows()).toHaveLength(1);
});

it.each(['context', 'consequences', 'alternatives', 'deciders', 'mode'])(
  'refuses supplied null %s without modifying a correction target',
  async (field) => {
    const one = receipt(await record({ content: 'Malformed caller fields are not corrections.' }));
    const before = readRows();
    const result = await record({
      content: 'Malformed caller fields are not corrections.',
      [field]: null,
      supersedes: [one.decisionId],
    });
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_PARAMETER', field } });
    expect(readRows()).toEqual(before);
  }
);

it.each([false, true])(
  'rolls back the whole correction when a target UPDATE changes no row (existing=%s)',
  async (existing) => {
    const one = receipt(await record({ content: 'First target' }));
    const two = receipt(await record({ content: 'Second target' }));
    if (existing) receipt(await record({ content: 'Correction' }));
    const db = new Database(project.dbPath);
    db.exec(`CREATE TRIGGER reject_correction BEFORE UPDATE OF superseded_by ON strategic_decisions
    WHEN OLD.id = ${two.decisionId} BEGIN SELECT RAISE(IGNORE); END`);
    db.close();
    const before = readRows();
    const result = await record({
      content: 'Correction',
      supersedes: [one.decisionId, two.decisionId],
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/rolled back/i);
    expect(readRows()).toEqual(before);
  }
);

it('refuses an active row whose existing successor chain includes a requested target', async () => {
  const one = receipt(await record({ content: 'Active but linked by imported state.' }));
  const two = receipt(await record({ content: 'Its successor' }));
  const db = new Database(project.dbPath);
  db.prepare('UPDATE strategic_decisions SET superseded_by=? WHERE id=?').run(
    two.decisionId,
    one.decisionId
  );
  db.close();
  const before = readRows();
  const result = await record({
    content: 'Active but linked by imported state.',
    supersedes: [two.decisionId],
  });
  expect(result).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('successor chain') },
  });
  expect(readRows()).toEqual(before);
});

it('does not treat a failed identity lookup as permission to insert', async () => {
  receipt(await record({ content: 'A failed read is not a missing row.' }));
  const before = readRows();
  const original = RbookDatabaseClient.prototype.getMany;
  const lookup = jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function (
    this: RbookDatabaseClient,
    sql,
    params
  ) {
    if (sql.includes('WHERE decision_text = ? AND author_session_id IS ?'))
      return {
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: 'Lookup failed deliberately' },
      };
    return original.call(this, sql, params);
  });
  try {
    const result = await record({
      content: 'A failed read is not a missing row.',
      context: 'New',
      supersedes: [Number(before[0].id)],
    });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Lookup failed deliberately') },
    });
    expect(readRows()).toEqual(before);
  } finally {
    lookup.mockRestore();
  }
});

it('prefers an older active match over a newer archived twin, then newest among inactive matches', async () => {
  const one = receipt(await record({ content: 'Versioned reasoning.', context: 'First' }));
  const target = receipt(await record({ content: 'Other choice' }));
  const two = receipt(
    await record({
      content: 'Versioned reasoning.',
      context: 'Second',
      supersedes: [target.decisionId],
    })
  );
  const db = new Database(project.dbPath);
  try {
    db.prepare("UPDATE strategic_decisions SET status='archived' WHERE id=?").run(two.decisionId);
    expect(receipt(await record({ content: 'Versioned reasoning.' })).decisionId).toBe(
      one.decisionId
    );
    db.prepare("UPDATE strategic_decisions SET status='archived' WHERE id=?").run(one.decisionId);
    expect(receipt(await record({ content: 'Versioned reasoning.' })).decisionId).toBe(
      two.decisionId
    );
  } finally {
    db.close();
  }
});

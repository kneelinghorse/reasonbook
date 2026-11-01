// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m04 — resolving feedback a shipped release fixed: a dry run that writes nothing, an apply in one
// ABOUTME: transaction with its ledger, a reopen of what a rule resolved, and the 6-path cases around them.

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { withClient } from '../../../src/tools/rbook/client';
import { ensureAgentFeedbackTable } from '../../../src/tools/rbook/schema-migrations';
import { recordAgentFeedback } from '../../../src/tools/rbook/agent-feedback';
import { ensureAgentFeedbackFixColumns } from '../../../src/tools/rbook/agent-feedback-columns';
import {
  applyFeedbackFixes,
  FEEDBACK_FIX_LEDGER_KEY,
  planFeedbackFixes,
  reopenFeedbackFixes,
} from '../../../src/tools/rbook/feedback-fix-apply';
import { FEEDBACK_FIX_RULES } from '../../../src/signals/feedback-fixes';
import { getServerVersion } from '../../../src/server-version';
import { runFeedback } from '../../../src/cli/feedback';

const OLD = '2026-06-01T00:00:00.000Z';
const NEW = new Date().toISOString();
const FIXED = {
  advisory:
    'Mission completion said "No decisions captured" although I recorded two with cmos_decisions for the mission.',
  supersession:
    'Supersession candidates on every decision were unrelated: they only shared keywords.',
  fanOut:
    'cmos_mission show walked the whole registry and returned one entry per registered project.',
};

let project: SeededRbookProject;
beforeEach(async () => {
  delete process.env.RBOOK_PROJECT_ROOT;
  delete process.env.CMOS_PROJECT_ROOT;
  project = await createSeededRbookProject({}, 'rbook-s108-m04-');
});
afterEach(async () => {
  RbookDetector.resetInstance();
  await project.cleanup();
});
const root = () => project.projectRoot;
const client = <T>(fn: Parameters<typeof withClient<T>>[0]) =>
  withClient<T>(fn, { projectRoot: root(), registerProject: false });

/** The 4.9.0 table, with rows written as 4.9.0 wrote them: no fixed_in, fix_rule or version. */
async function seed(rows: Array<[string, string, string?]>) {
  await client((c) => {
    ensureAgentFeedbackTable(c);
    return { success: true, data: null };
  });
  const db = new Database(project.dbPath);
  try {
    const insert = db.prepare(
      "INSERT INTO agent_feedback (tool_name, body, status, created_at) VALUES ('t', ?, ?, ?)"
    );
    for (const [body, createdAt, status] of rows)
      insert.run(body ?? '', status ?? 'open', createdAt ?? '');
    if (rows.some(([body]) => body === null))
      db.exec("UPDATE agent_feedback SET body = NULL WHERE body = ''");
  } finally {
    db.close();
  }
}
const columns = () => {
  const db = new Database(project.dbPath, { readonly: true });
  try {
    return (db.prepare('PRAGMA table_info(agent_feedback)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
  } finally {
    db.close();
  }
};
const rowsOf = () => {
  const db = new Database(project.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM agent_feedback ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
};

it('resolves exactly what the dry run names, from a 4.9.0 table, and reopen restores it', async () => {
  await seed([
    [FIXED.advisory, OLD],
    [FIXED.supersession, OLD, 'triaged'], // a person's triage: held
    [FIXED.fanOut, OLD],
    [`${FIXED.advisory} Also the digest was slow.`, OLD], // partly: names a second item
    [FIXED.advisory, NEW], // filed after the fix
    ['The checkout page renders twice.', OLD], // the project's own work
  ]);
  expect(columns()).not.toContain('fixed_in');
  const bytes = fs.readFileSync(project.dbPath);
  const plan = await client((c) => planFeedbackFixes(c));
  expect(plan.data!.rows.map((r) => r.id)).toEqual([1, 3]);
  expect(plan.data!.held.map((r) => r.id)).toEqual([2]);
  expect(plan.data!.perRule.find((r) => r.rule === 'completion.decisions-advisory')).toMatchObject({
    fixed: 1,
    partly: 1,
  });
  expect(fs.readFileSync(project.dbPath).equals(bytes)).toBe(true);

  const applied = await client((c) => applyFeedbackFixes(c, '2026-11-01T07:00:00.000Z'));
  expect(applied.success).toBe(true);
  expect(applied.data!.resolved).toEqual([1, 3]);
  const after = rowsOf();
  expect(after.slice(0, 3).map((r) => [r.status, r.fixed_in, r.fix_rule])).toEqual([
    ['resolved', '3.2.0', 'completion.decisions-advisory@1'],
    ['triaged', null, null],
    ['resolved', '2.1.0', 'reads.fan-out-every-project@1'],
  ]);
  expect(after[0].resolution_note).toBe(
    `Fixed in Reasonbook 3.2.0 (rule completion.decisions-advisory@1; applied by ${getServerVersion()})`
  );
  expect(after.slice(3).map((r) => r.status)).toEqual(['open', 'open', 'open']);
  const ledger = await client((c) =>
    c.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
      FEEDBACK_FIX_LEDGER_KEY,
    ])
  );
  expect(JSON.parse(ledger.data!.value)).toEqual([
    expect.objectContaining({
      action: 'apply',
      at: '2026-11-01T07:00:00.000Z',
      rows: [1, 3],
      rules: FEEDBACK_FIX_RULES.map((r) => `${r.id}@${r.revision}`),
    }),
  ]);

  // Someone noted row 3 after the apply: reopen leaves it, and restores the other.
  const db = new Database(project.dbPath);
  db.prepare(
    "UPDATE agent_feedback SET resolution_note = resolution_note || ' — checked by hand' WHERE id = 3"
  ).run();
  db.close();
  const reopened = await client((c) => reopenFeedbackFixes(c, 'reads.fan-out-every-project'));
  expect(reopened.data).toMatchObject({ reopened: [], kept: [3] });
  const restored = await client((c) => reopenFeedbackFixes(c, 'completion.decisions-advisory'));
  expect(restored.data).toMatchObject({ reopened: [1], kept: [] });
  expect(rowsOf()[0]).toMatchObject({
    status: 'open',
    resolved_at: null,
    resolution_note: null,
    fixed_in: null,
    fix_rule: 'reopened:completion.decisions-advisory@1',
  });
  // The marker keeps every rule from resolving, or labelling, the reopened row again.
  const again = await client((c) => planFeedbackFixes(c));
  expect(again.data!.rows.map((r) => r.id)).toEqual([]);
});

it('never overwrites a person’s triage or note, the critic’s data-loss case', async () => {
  const note = 'Triage: still reproduces on our pinned 2.0.3 runtime; keep open.';
  await seed([
    [FIXED.fanOut, OLD, 'triaged'],
    [FIXED.advisory, OLD],
  ]);
  const db = new Database(project.dbPath);
  db.prepare('UPDATE agent_feedback SET resolution_note = ?').run(note);
  db.close();
  const applied = await client((c) => applyFeedbackFixes(c));
  expect(applied.data!.resolved).toEqual([]);
  expect(applied.data!.held.map((r) => r.id)).toEqual([1, 2]);
  expect(rowsOf().map((r) => [r.status, r.resolution_note])).toEqual([
    ['triaged', note],
    ['open', note],
  ]);
});

it('never claims again a row two rules fix once it has been reopened, the round-2 cycle', async () => {
  const both =
    'Mission completion said no decisions captured, and the supersession candidates offered on rbook_decisions were unrelated.';
  await seed([[both, OLD]]);
  expect((await client((c) => applyFeedbackFixes(c))).data!.resolved).toEqual([1]);
  const first = rowsOf()[0].fix_rule as string;
  await client((c) => reopenFeedbackFixes(c, first.split('@')[0]));
  // The other rule that fixes the row may not take it up where the first one left off.
  expect((await client((c) => planFeedbackFixes(c))).data!.rows).toEqual([]);
  expect((await client((c) => applyFeedbackFixes(c))).data!.resolved).toEqual([]);
  expect(rowsOf()[0]).toMatchObject({ status: 'open', fix_rule: `reopened:${first}` });
});

it('leaves a marker every rule respects when a hand edit left the revision blank (round 3)', async () => {
  await seed([[FIXED.fanOut, OLD]]);
  await client((c) => applyFeedbackFixes(c));
  // fix_rule and its note edited alike by hand, so the reopen still recognises its own row.
  const db = new Database(project.dbPath);
  const row = db
    .prepare('SELECT fix_rule, resolution_note FROM agent_feedback WHERE id = 1')
    .get() as {
    fix_rule: string;
    resolution_note: string;
  };
  const blank = row.fix_rule.replace(/@\d+$/, '@');
  db.prepare('UPDATE agent_feedback SET fix_rule = ?, resolution_note = ? WHERE id = 1').run(
    blank,
    row.resolution_note.replace(row.fix_rule, blank)
  );
  db.close();
  const reopened = await client((c) => reopenFeedbackFixes(c, 'reads.fan-out-every-project'));
  expect(reopened.data).toMatchObject({ reopened: [1] });
  // Written as revision 0 before, a marker the rule's revision 1 would pass, and claim again.
  expect(rowsOf()[0].fix_rule).toBe('reopened:reads.fan-out-every-project@NaN');
  expect((await client((c) => planFeedbackFixes(c))).data!.rows).toEqual([]);
});

it('reopens nothing, and does not throw, when the ledger is unreadable or malformed', async () => {
  await seed([[FIXED.fanOut, OLD]]);
  await client((c) => applyFeedbackFixes(c));
  const db = new Database(project.dbPath);
  // Neither a null entry nor rows that are not a list may be looped over (a string could be).
  db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(
    JSON.stringify([null, { action: 'apply', at: 'x', rows: 5 }]),
    FEEDBACK_FIX_LEDGER_KEY
  );
  db.close();
  const reopened = await client((c) => reopenFeedbackFixes(c, 'reads.fan-out-every-project'));
  expect(reopened.data).toMatchObject({ reopened: [], kept: [1] });
});

it('reads a blank note as the apply’s UPDATE does, so the dry run lists exactly what it resolves', async () => {
  await seed([
    [FIXED.fanOut, OLD],
    [FIXED.advisory, OLD],
  ]);
  const db = new Database(project.dbPath);
  const note = db.prepare('UPDATE agent_feedback SET resolution_note = ? WHERE id = ?');
  // Tabs and line breaks are blank to both; a form feed is a person's note to both.
  note.run('\t\n', 1);
  note.run('\f', 2);
  db.close();
  const plan = await client((c) => planFeedbackFixes(c));
  const applied = await client((c) => applyFeedbackFixes(c));
  expect(plan.data!.rows.map((r) => r.id)).toEqual(applied.data!.resolved);
  expect(applied.data!.resolved).toEqual([1]);
  expect(rowsOf()[1]).toMatchObject({ status: 'open', resolution_note: '\f' });
});

it('keeps a row a person resolved again after the apply, even with the rule’s note left', async () => {
  await seed([[FIXED.fanOut, OLD]]);
  await client((c) => applyFeedbackFixes(c, '2026-11-01T07:00:00.000Z'));
  // A person resolves it again without a note: the note stays and resolved_at moves on.
  const db = new Database(project.dbPath);
  db.prepare(
    "UPDATE agent_feedback SET resolved_at = '2026-11-01T08:00:00.000Z' WHERE id = 1"
  ).run();
  db.close();
  const reopened = await client((c) => reopenFeedbackFixes(c, 'reads.fan-out-every-project'));
  expect(reopened.data).toMatchObject({ reopened: [], kept: [1] });
  expect(rowsOf()[0].status).toBe('resolved');
});

it('labels a reopened row as fixed by no rule, through the MCP boundary', async () => {
  await seed([[FIXED.fanOut, OLD]]);
  await client((c) => applyFeedbackFixes(c));
  await client((c) => reopenFeedbackFixes(c, 'reads.fan-out-every-project'));
  const answer = await executeMissionProtocolTool(
    'rbook_feedback',
    { action: 'list', projectRoot: root() },
    {} as never
  );
  const data = (
    answer.structuredContent as {
      data: { entries: Array<{ fix?: unknown }>; countsByGroup: unknown };
    }
  ).data;
  expect(data.entries[0].fix).toBeUndefined();
  expect(data.countsByGroup).toEqual({ fixed: 0, reasonbook: 1, own: 0 });
});

it('never resolves a row with no readable time or no text, and alters nothing when nothing would be resolved', async () => {
  // NOT NULL holds in tables 4.x made, so the NULLs come from a table made another way.
  const db = new Database(project.dbPath);
  db.exec(`CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, tool_name TEXT, body TEXT, status TEXT,
    created_at TEXT, resolved_at TEXT, resolution_note TEXT)`);
  const insert = db.prepare(
    "INSERT INTO agent_feedback (tool_name, body, status, created_at) VALUES ('t', ?, 'open', ?)"
  );
  insert.run(FIXED.advisory, null);
  insert.run(FIXED.advisory, 'not a time');
  insert.run(null, OLD);
  db.close();
  const applied = await client((c) => applyFeedbackFixes(c));
  expect(applied.data!.resolved).toEqual([]);
  expect(columns()).not.toContain('fixed_in');
  expect(rowsOf().map((r) => r.status)).toEqual(['open', 'open', 'open']);
});

it('answers a store with no feedback table with an empty plan, and adds nothing to it', async () => {
  const plan = await client((c) => planFeedbackFixes(c));
  expect(plan.data!.rows).toEqual([]);
  expect((await client((c) => applyFeedbackFixes(c))).data!.resolved).toEqual([]);
  expect(columns()).toEqual([]);
});

it('ends with the columns when another process adds one first, without a warning', async () => {
  await seed([[FIXED.advisory, OLD]]);
  const result = await client((c) => {
    const execute = c.execute.bind(c);
    // The other process wins the race for fixed_in between this one's read and its ALTER.
    jest.spyOn(c, 'execute').mockImplementationOnce((sql, params) => {
      const other = new Database(project.dbPath);
      other.exec('ALTER TABLE agent_feedback ADD COLUMN fixed_in TEXT');
      other.close();
      return execute(sql, params);
    });
    return { success: true, data: ensureAgentFeedbackFixColumns(c) };
  });
  expect(result.data!.warnings).toEqual([]);
  expect([...result.data!.present].sort()).toEqual(['fix_rule', 'fixed_in', 'reasonbook_version']);
});

it('changes nothing while another process holds the store, and says so', async () => {
  await seed([[FIXED.advisory, OLD]]);
  const holder = new Database(project.dbPath);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const result = await withClient((c) => applyFeedbackFixes(c), {
      projectRoot: root(),
      registerProject: false,
      timeout: 50,
    });
    expect(result.success).toBe(false);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(rowsOf()[0].status).toBe('open');
});

it('fails loudly when a rule throws, so that no count of zero reads as a fact', async () => {
  await seed([[FIXED.advisory, OLD]]);
  const spy = jest.spyOn(FEEDBACK_FIX_RULES[0].match[0], 'test').mockImplementation(() => {
    throw new Error('rule failed');
  });
  try {
    await expect(client((c) => planFeedbackFixes(c))).rejects.toThrow('rule failed');
  } catch {
    // withClient may turn the throw into a refusal instead; either way no plan comes back.
    const plan = await client((c) => planFeedbackFixes(c));
    expect(plan.success).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it('records the release a new row was filed on', async () => {
  await client((c) => {
    recordAgentFeedback(c, 'A new friction note.', { toolName: 'test' });
    return { success: true, data: null };
  });
  expect(rowsOf()[0].reasonbook_version).toBe(getServerVersion());
});

it('labels fixed rows and counts the three groups through the MCP boundary', async () => {
  await seed([
    [FIXED.fanOut, OLD],
    [`${FIXED.advisory} Also the digest was slow.`, OLD],
    ['rbook_review was slow today.', NEW],
    ['The checkout page renders twice.', NEW],
  ]);
  const answer = await executeMissionProtocolTool(
    'rbook_feedback',
    { action: 'list', projectRoot: root() },
    {} as never
  );
  const data = (
    answer.structuredContent as {
      data: { entries: Array<{ id: number; fix?: unknown }>; countsByGroup: unknown };
    }
  ).data;
  expect(data.countsByGroup).toEqual({ fixed: 1, reasonbook: 2, own: 1 });
  expect(data.entries.find((e) => e.id === 1)?.fix).toMatchObject({
    rule: 'reads.fan-out-every-project',
    state: 'fixed',
  });
  expect(data.entries.find((e) => e.id === 2)?.fix).toMatchObject({ state: 'partly' });
  const text = (answer.content ?? []).map((part) => ('text' in part ? part.text : '')).join('\n');
  expect(text).toContain('fixed in 2.1.0 (reads.fan-out-every-project)');
  expect(text).toContain('partly fixed in 3.2.0');
  expect(text).toContain('By group: fixed=1, reasonbook=2, own=1');
  expect(text).toContain('reasonbook feedback resolve-fixed');
});

it('runs from the CLI with the project named and the environment unset', async () => {
  await seed([[FIXED.fanOut, OLD]]);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    env: { HOME: process.env.HOME } as NodeJS.ProcessEnv,
    cwd: path.dirname(root()),
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
  expect(await runFeedback(['resolve-fixed', '--project-root', root()], io as never)).toBe(0);
  expect(out.join('')).toContain('Dry run: 1 feedback row would be resolved');
  expect(rowsOf()[0].status).toBe('open');
  expect(
    await runFeedback(['resolve-fixed', '--apply', '--project-root', root()], io as never)
  ).toBe(0);
  expect(rowsOf()[0].status).toBe('resolved');
  expect(await runFeedback(['reopen-fixed', '--project-root', root()], io as never)).toBe(1);
  expect(err.join('')).toContain('--rule <id>');
  // --dry-run is refused where it would be read past, and a misspelled rule reopens nothing.
  expect(
    await runFeedback(
      ['resolve-fixed', '--apply', '--dry-run', '--project-root', root()],
      io as never
    )
  ).toBe(1);
  expect(
    await runFeedback(
      [
        'reopen-fixed',
        '--rule',
        'reads.fan-out-every-project',
        '--dry-run',
        '--project-root',
        root(),
      ],
      io as never
    )
  ).toBe(1);
  expect(
    await runFeedback(
      ['reopen-fixed', '--rule', 'reads.fanout', '--project-root', root()],
      io as never
    )
  ).toBe(1);
  expect(err.join('')).toContain(
    'No shipped rule and no resolved row here has the rule id reads.fanout'
  );
  expect(rowsOf()[0].status).toBe('resolved');
  // An apply takes every shipped rule, so --rule there is refused rather than read past.
  expect(
    await runFeedback(
      [
        'resolve-fixed',
        '--apply',
        '--rule',
        'reads.fan-out-every-project',
        '--project-root',
        root(),
      ],
      io as never
    )
  ).toBe(1);
  expect(
    await runFeedback(
      // The rule by the id@revision the row's fix_rule and note show.
      ['reopen-fixed', '--rule', 'reads.fan-out-every-project@1', '--project-root', root()],
      io as never
    )
  ).toBe(0);
  expect(rowsOf()[0].status).toBe('open');
});

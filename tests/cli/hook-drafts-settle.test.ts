// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — settling a draft through the hook CLI: a reply's "Settled: P<n> by decision <N>" line answers the
// ABOUTME: draft at Stop, the operator's next "yes" binds nothing to it, and every line that took no effect is named.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { draftRuntimeDir, openDraftRuntime } from '../../src/tools/rbook/draft-runtime';
import { readTelemetry, targetForStore } from '../../src/tools/rbook/local-telemetry';
import { rbookDecisions } from '../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

const HARNESS_PID = process.pid;
const HOOK_ROOM_MS = 20_000;
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-settle-hooks-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'settle' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedStartId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedStartId;
  if (savedConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string[];
}

async function hook(event: string, stdin: unknown): Promise<Ran> {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PID: String(HARNESS_PID) },
    cwd: projectRoot,
    startedAtMs: Date.now() + HOOK_ROOM_MS,
    readStdin: async () => JSON.stringify(stdin),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  const code = await runCli(['hook', event], io);
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}

async function cli(argv: string[]): Promise<string> {
  let stdout = '';
  await runCli(argv, {
    env: { ...process.env },
    cwd: projectRoot,
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  return stdout;
}

const context = (ran: Ran): string =>
  ran.stdout ? (JSON.parse(ran.stdout).hookSpecificOutput.additionalContext as string) : '';
const start = (session: string) =>
  hook('session-start', { session_id: session, cwd: projectRoot, source: 'startup' });
const stop = (session: string, reply: string) =>
  hook('stop', { session_id: session, cwd: projectRoot, last_assistant_message: reply });
const prompt = (session: string, text: string) =>
  hook('prompt', {
    session_id: session,
    cwd: projectRoot,
    prompt: text,
    prompt_id: `${Math.random()}`,
  });

const DRAFT_TEXT =
  'Store project decisions as one JSON file per decision, because diffs stay readable.';
const PROPOSAL = `I would keep one JSON file per decision.\n\nWould record: ${DRAFT_TEXT}`;
const OTHER = 'Would record: Keep one SQLite store per project because sync expects one.';

function store<T>(action: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/** A decision recorded now, after the draft, with the approval mode given (null: recorded directly). */
function decision(text = DRAFT_TEXT, mode: string | null = null): number {
  return store((db) =>
    Number(
      db
        .prepare(
          'INSERT INTO strategic_decisions (decision_text, created_at, approval_mode) VALUES (?, ?, ?)'
        )
        .run(text, new Date(Date.now() + 1000).toISOString(), mode).lastInsertRowid
    )
  );
}

const draft = (id: number) =>
  store(
    (db) =>
      db
        .prepare('SELECT outcome, record_id, approval_mode FROM proposals WHERE id = ?')
        .get(id) as {
        outcome: string;
        record_id: string | null;
        approval_mode: string | null;
      }
  );

describe('a taught settle answers the draft at Stop (#1810)', () => {
  it('settles the draft, after which a "yes" binds nothing to it, the digest, reminders and list agree, and fromDraft is refused', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'yes');
    // The operator's yes was lost to a compaction; the agent recorded the choice directly.
    const d = decision();
    const reply = `The operator's earlier approval is now recorded as decision ${d}.\n\nSettled: P1 by decision ${d}\n${OTHER}`;
    expect(await stop('s-one', reply)).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(draft(1)).toEqual({
      outcome: 'answered',
      record_id: `d:${d}`,
      approval_mode: 'settled',
    });
    const next = context(await prompt('s-one', 'yes'));
    expect(next).toContain('Reasonbook draft P2'); // the Would record line below still drafted, and binds
    expect(next).not.toContain('P1');
    expect(context(await start('s-later'))).not.toContain('P1 [');
    expect(context(await prompt('s-later', 'continue with the parser'))).not.toContain('P1');
    expect(await cli(['drafts', 'list', '--all'])).toContain(`answered as d:${d} (settled)`);
    setExternalSessionOwner('s-one');
    const again = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(again.success).toBe(false);
    expect(again.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(`${again.error?.message} ${again.error?.suggestion}`).toContain(`d:${d}`);
  });

  it('a settle that does not take effect leaves the draft pending, binds nothing to the next "yes", and is named', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision(DRAFT_TEXT, 'autonomous');
    await stop('s-one', `I settled draft P1.\n\nSettled: P1 by decision ${d}`);
    expect(draft(1).outcome).toBe('pending');
    const next = context(await prompt('s-one', 'yes'));
    expect(next).not.toContain('Reasonbook draft P1 (decision), which your last reply');
    expect(next).not.toContain('plain approval of P1');
    // Nor is it kept from the reply before, to bind as words the agent judges (settled item 5).
    expect(next).not.toContain('was shown before your last reply');
    expect(next).toContain(
      `Lines in your last reply took no effect; tell the operator: "Settled: P1 by decision ${d}" (that decision was recorded autonomously, so it claims no operator approval).`
    );
  });

  it('a Settled line in a form not kept, with prose naming the draft, still takes the draft out of what a "yes" binds', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    await stop(
      's-one',
      `Draft P1 stores decisions as JSON files.\n\n- Settled: P1 by decision ${d}`
    );
    expect(draft(1).outcome).toBe('pending');
    const next = context(await prompt('s-one', 'yes'));
    expect(next).not.toContain('plain approval of P1');
    // Nor is it kept from the reply before, to bind as words the agent judges (settled item 5).
    expect(next).not.toContain('was shown before your last reply');
    expect(next).toContain(
      `"- Settled: P1 by decision ${d}" (a settle is read only from a plain line, Settled: P<n> by decision <N>)`
    );
  });

  it('applies a Settled line between two Would record lines, makes both drafts, and names it for its place', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    await stop(
      's-one',
      `Two more.\n\n${OTHER}\nSettled: P1 by decision ${d}\nWould record: Log every hook call because the load gate reads them.`
    );
    expect(draft(1).outcome).toBe('answered');
    expect(store((db) => db.prepare('SELECT COUNT(*) AS n FROM proposals').get())).toEqual({
      n: 3,
    });
    expect(context(await prompt('s-one', 'continue'))).toContain(
      `Lines in your last reply took effect with a note: "Settled: P1 by decision ${d}" (it took effect, but put Settled lines above any Would record lines`
    );
  });

  it('applies a settle below 0.85 of the draft’s subject, and notes it', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision('Store project decisions as JSON files.');
    await stop('s-one', `Recorded.\n\nSettled: P1 by decision ${d}`);
    expect(draft(1).outcome).toBe('answered');
    expect(context(await prompt('s-one', 'continue'))).toMatch(
      /took effect with a note: "Settled: P1 by decision \d+" \(it took effect, though that decision states only \d+% of the draft's subject/
    );
  });

  it('applies no settle read from the transcript, which can hold an earlier reply, and names it', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Recorded.\n\nSettled: P1 by decision ${d}\nWould record: one\nWould record: two\nWould record: three\nWould record: four` }] } })}\n`
    );
    await hook('stop', { session_id: 's-one', cwd: projectRoot, transcript_path: transcript });
    expect(draft(1).outcome).toBe('pending');
    const next = context(await prompt('s-one', 'continue'));
    expect(next).toContain(
      "(the hook had only the transcript, which can hold an earlier turn's reply, so it applied no settle)"
    );
    // Its other lost lines may be an earlier turn's, named already: only Settled lines are named
    // from the transcript (critic B, round 1, note 10).
    expect(next).not.toContain('"Would record: four"');
  });

  it.each([
    ['quote-marked', (d: number) => `> Settled: P1 by decision ${d}`],
    ['bold-labelled', (d: number) => `**Settled:** P1 by decision ${d}`],
    ['inline code', (d: number) => `\`Settled: P1 by decision ${d}\``],
    ['fenced', (d: number) => `\`\`\`\nSettled: P1 by decision ${d}\n\`\`\``],
    ['link text', (d: number) => `[Settled: P1 by decision ${d}](https://example.com)`],
    [
      'above an inline-labelled last line',
      (d: number) => `Settled: P1 by decision ${d}\nKeep it? ${OTHER}`,
    ],
  ])('names a %s Settled line at the next prompt, and settles nothing', async (_form, line) => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    await stop('s-one', `Recorded.\n\n${line(d)}`);
    expect(draft(1).outcome).toBe('pending');
    expect(context(await prompt('s-one', 'continue'))).toContain(
      'Lines in your last reply took no effect; tell the operator:'
    );
  });
});

describe('critic B, round 1: a draft a Settled line names is never bound by the next "yes"', () => {
  it('B1: a line naming two drafts takes both out of what the next "yes" binds', async () => {
    await start('s-one');
    await stop('s-one', `${PROPOSAL}\n${OTHER}`);
    const d = decision();
    await stop(
      's-one',
      `Decision ${d} also covers draft P2, one SQLite store per project.\n\nSettled: P1 and P2 by decision ${d}`
    );
    const next = context(await prompt('s-one', 'yes'));
    expect(next).not.toMatch(/plain approval of P[12]\b|approves P[12]\b|draft P[12] \(decision\)/);
  });

  it('B2: a heading Settled line, with prose naming the draft, is named and binds nothing', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    await stop(
      's-one',
      `Draft P1 stores decisions as JSON files.\n\n## Settled: P1 by decision ${d}`
    );
    const next = context(await prompt('s-one', 'yes'));
    expect(next).not.toContain('plain approval of P1');
    expect(next).toContain(
      `"## Settled: P1 by decision ${d}" (a settle is read only from a plain line`
    );
  });
});

describe('a settle never answers a draft its own reply put to the operator (critic A, round 1, B1)', () => {
  // A revision that holds all of the first draft's subject, and one more after it: s97-m12 links an
  // approved draft to its revision, and recording either end settles the chain (settleRevised).
  const T2 = `${DRAFT_TEXT} Keep the files under rbook/decisions.`;
  const T3 = `${T2} Name each file by its decision id.`;
  async function approvedThenRevised(): Promise<void> {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    await prompt('s-one', 'yes');
    await stop('s-one', `Revised.\n\nWould record: ${T2}`);
    await prompt('s-one', 'why one file per decision?');
  }

  it('refuses a settle whose chain holds the draft the same reply repeats, which the next "yes" approves', async () => {
    await approvedThenRevised();
    const d = decision();
    await stop(
      's-one',
      `The earlier approval is decision ${d}.\n\nSettled: P1 by decision ${d}\nWould record: ${T2}`
    );
    expect([draft(1).outcome, draft(2).outcome]).toEqual(['pending', 'pending']);
    const next = context(await prompt('s-one', 'yes'));
    expect(next).toContain('plain approval of P2');
    expect(next).toContain(
      `"Settled: P1 by decision ${d}" (this reply's own Would record line drafts that draft or one on its chain of revisions, which settling it would answer too)`
    );
  });

  it('refuses a settle whose chain holds the draft the same reply creates', async () => {
    await approvedThenRevised();
    const d = decision();
    await stop('s-one', `Named by id.\n\nSettled: P1 by decision ${d}\nWould record: ${T3}`);
    expect(draft(3).outcome).toBe('pending');
    expect(draft(1).outcome).toBe('pending');
  });
});

describe('lines that take no effect are named once, at the next prompt (#51)', () => {
  it('names a fourth Would record line, then clears it', async () => {
    await start('s-one');
    const four = [
      'Would record: Store decisions as JSON files because they diff cleanly.',
      'Would record: Keep one SQLite store per project because sync expects one.',
      'Would record: Log every hook call because the load gate reads them.',
      'Would record: Cap the digest at four thousand characters for the token budget.',
    ];
    await stop('s-one', `Four.\n\n${four.join('\n')}`);
    const next = context(await prompt('s-one', 'continue'));
    expect(next).toContain(
      `took no effect; tell the operator: "${four[3]}" (a reply keeps at most three Would record lines)`
    );
    expect(context(await prompt('s-one', 'continue'))).not.toContain('took no effect');
    // Stop's telemetry row counts the line it lost.
    const stops = readTelemetry(targetForStore(dbPath)!, process.env).filter(
      (row) => row.draftLines !== undefined
    );
    expect(stops[stops.length - 1]).toMatchObject({
      draftLines: 3,
      draftsCreated: 3,
      draftLinesDropped: 1,
    });
  });

  it('a prompt with nothing pending creates no runtime file', async () => {
    await start('s-one');
    await prompt('s-one', 'hello');
    expect(fs.existsSync(draftRuntimeDir(process.env))).toBe(false);
  });

  it('names a refused line with nothing pending, from a runtime it opens read-only', async () => {
    await start('s-one');
    const d = decision();
    await stop('s-one', `Recorded.\n\nSettled: P7 by decision ${d}`);
    expect(context(await prompt('s-one', 'continue'))).toContain(
      `"Settled: P7 by decision ${d}" (there is no such draft in this store)`
    );
  });

  it('lists a Settled line on a store with no proposals table, and never creates the table', async () => {
    store((db) => db.exec('DROP TABLE IF EXISTS proposals'));
    await start('s-one');
    const d = decision();
    expect((await stop('s-one', `Recorded.\n\nSettled: P1 by decision ${d}`)).code).toBe(0);
    expect(
      store((db) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proposals'").get())
    ).toBeUndefined();
    expect(context(await prompt('s-one', 'continue'))).toContain('(no drafts in this store)');
  });

  it('reads a runtime an older Stop wrote, with no unkept table, as empty', async () => {
    await start('s-one');
    // Nothing pending, so the prompt opens the runtime read-only and cannot recreate the table.
    await stop('s-one', `Recorded.\n\nSettled: P7 by decision ${decision()}`);
    const runtime = openDraftRuntime(dbPath, process.env)!;
    runtime.db.exec('DROP TABLE unkept');
    runtime.close();
    const ran = await prompt('s-one', 'continue');
    expect([ran.code, context(ran)]).toEqual([0, expect.not.stringContaining('took no effect')]);
  });

  it('a busy store fails the settle into the runtime table, and Stop still exits 0', async () => {
    await start('s-one');
    await stop('s-one', PROPOSAL);
    const d = decision();
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect((await stop('s-one', `Recorded.\n\nSettled: P1 by decision ${d}`)).code).toBe(0);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(draft(1).outcome).toBe('pending');
    expect(context(await prompt('s-one', 'continue'))).toContain(
      '(the store was busy, so the draft stays pending)'
    );
  });
});

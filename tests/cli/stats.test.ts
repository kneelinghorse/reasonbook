// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stats counts measured events and real SQLite rows without turning missing evidence into a pass.
// ABOUTME: Relative windows, typed session joins, privacy, and unavailable-store cases protect the G1 read.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runStats } from '../../src/cli/stats';
import {
  appendTelemetry,
  targetForStore,
  type TelemetryRecord,
} from '../../src/tools/rbook/local-telemetry';
import { rbookRulesLine } from '../../src/tools/rbook/rules-files';
import { collectTelemetryStats, exportTelemetryStats } from '../../src/tools/rbook/telemetry-stats';
import { seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let now: number;
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const bounds = () => ({
  since: iso(now - 14 * day),
  until: iso(now),
  baselineSince: iso(now - 45 * day),
  baselineUntil: iso(now - 15 * day),
});

beforeEach(() => {
  now = Date.now();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-stats-'));
  root = path.join(tmp, 'private-project-name');
  dbPath = seedRbookDb(root, { projectName: 'private-project-name' });
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: '' };
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `${rbookRulesLine('builder')}\n`);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(sql: string, ...values: unknown[]): void {
  const db = new Database(dbPath);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function event(partial: Partial<TelemetryRecord>, store = dbPath): void {
  const target = targetForStore(store);
  expect(target).not.toBeNull();
  appendTelemetry(
    {
      ts: iso(now - 1000),
      session: 'aaaaaaaaaaaaaaaa',
      surface: 'hook',
      client: 'test',
      tool: 'hook prompt',
      action: null,
      mode: 'read',
      ok: true,
      refused: null,
      failOpen: null,
      ambient: 'on',
      ...partial,
    },
    target!,
    env
  );
}

function mission(id: string, completed: number, offsets: number[]): void {
  write(
    'INSERT INTO missions (id,name,status,completed_at) VALUES (?,?,?,?)',
    id,
    'private mission text',
    'Completed',
    iso(completed)
  );
  offsets.forEach((offset, i) =>
    write(
      'INSERT INTO strategic_decisions (decision_text,mission_id,created_at) VALUES (?,?,?)',
      `private decision ${id}/${i}`,
      id,
      iso(completed + offset)
    )
  );
}

describe('local telemetry stats', () => {
  it('renders pooled friction as one inert capped value without rewriting the stored body', async () => {
    const body = '\u001b[2K\u0085\nFORGED LINE ' + 'x'.repeat(1000);
    write(
      'CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, body TEXT, created_at TEXT, status TEXT)'
    );
    write('INSERT INTO agent_feedback VALUES (1,?,?,?)', body, iso(now - day), 'open');
    let stdout = '';
    expect(
      await runStats([], {
        cwd: root,
        env,
        readStdin: async () => '',
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      })
    ).toBe(0);
    // eslint-disable-next-line no-control-regex -- C0/C1 witness permits only generated LF.
    expect(stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(stdout).not.toMatch(/^FORGED LINE/m);
    expect(stdout).not.toContain('x'.repeat(301));
    expect(
      (await collectTelemetryStats([root], bounds(), env)).projects[0].store.friction.items[0].body
    ).toBe(body);
  });

  it.each(['canonical-first', 'alias-first'])(
    'joins alias injections to canonical writes without losing or doubling the store (%s)',
    async (order) => {
      const aliasRoot = path.join(fs.realpathSync.native(tmp), 'PRIVATE-PROJECT-NAME');
      if (!fs.existsSync(aliasRoot)) fs.symlinkSync(root, aliasRoot, 'dir');
      const aliasPath = path.join(aliasRoot, 'rbook', 'db', 'rbook.sqlite');
      const original = fs.realpathSync;
      // Preserve caller spelling only in the non-native API; keep physical identity real.
      const nonNative = jest
        .spyOn(require('fs') as typeof fs, 'realpathSync')
        .mockImplementation((...args) => {
          if (args[0] === aliasPath) return aliasPath;
          return original(...args);
        });
      Object.assign(nonNative, { native: original.native });
      expect(fs.realpathSync(aliasPath)).not.toBe(fs.realpathSync.native(aliasPath));
      expect(fs.realpathSync.native(aliasPath)).toBe(fs.realpathSync.native(dbPath));
      event({ ts: iso(now - 2000), idsInjected: ['d:1'] }, aliasPath);
      event({
        ts: iso(now - 1000),
        surface: 'mcp',
        tool: 'rbook_decisions',
        action: 'record',
        mode: 'write',
        idsCited: ['d:1'],
      });
      const roots = order === 'canonical-first' ? [root, aliasRoot] : [aliasRoot, root];
      const report = await collectTelemetryStats(roots, bounds(), env);
      expect(report.projects).toHaveLength(1);
      expect(report.projects[0].telemetry).toMatchObject({
        available: true,
        files: 1,
        records: 2,
        warnings: [],
      });
      expect(report.events.citeThrough.prompt).toMatchObject({ injected: 1, used: 1, ratio: 1 });
    }
  );

  it('does not pass empty instrumentation, missing proposal schema, or human severity judgments', async () => {
    // A store from before s93-m06 has no proposals table: unavailable, never zero acceptance.
    write('DROP TABLE IF EXISTS proposals');
    const report = await collectTelemetryStats([root], bounds(), env);
    expect(report.events.prompting.prompts).toBe(0);
    expect(report.events.prompting.status).toBe('unavailable');
    expect(report.timing.passed).toBeNull();
    expect(report.projects[0].store.proposals.status).toBe('unavailable');
    expect(report.projects[0].store.friction.status).toBe('unavailable');
    expect(report.projects[0].store.duplicates.semanticStatus).toBe('unmeasured');
  });

  it('measures draft acceptance by its published rule, with revisions and direct records outside it', async () => {
    const draft = (outcome: string, mode: string | null, ageDays: number) =>
      write(
        'INSERT INTO proposals (text, kind, created_at, outcome, approval_mode) VALUES (?,?,?,?,?)',
        'a private draft text',
        'decision',
        iso(now - ageDays * day),
        outcome,
        mode
      );
    draft('approved', 'approved', 1);
    draft('approved', 'agent-judged', 1);
    draft('declined', null, 1);
    draft('replaced', null, 1);
    draft('answered', null, 1);
    draft('pending', null, 8); // past its 7 days: expired, computed
    draft('pending', null, 1);
    draft('approved', 'approved', 30); // outside the window
    const report = await collectTelemetryStats([root], bounds(), env);
    expect(report.projects[0].store.proposals).toEqual({
      status: 'measured',
      created: 7,
      outcomes: { pending: 1, approved: 2, declined: 1, replaced: 1, answered: 1, expired: 1 },
      modes: { approved: 1, 'agent-judged': 1, 'agent-attested': 0 },
      acceptanceRate: 0.5,
    });
    const exported = exportTelemetryStats(report);
    expect(exported.proposals).toMatchObject({
      status: 'measured',
      created: 7,
      acceptanceRate: 0.5,
    });
    expect(JSON.stringify(exported)).not.toContain('a private draft text');
    expect(exported.rules.proposals).toContain('approved / (approved + declined + expired)');
  });

  it('counts procedure before skips, excludes plugin ceremonies, and scans nested rules without exempting edited pointers', async () => {
    event({ procedurePatternIds: ['P02', 'P03'], ceremony: null, ambient: 'off' });
    event({ procedurePatternIds: ['P02'], ceremony: '/reasonbook:build' });
    event({ procedurePatternIds: [], ceremony: 'C01' });
    fs.mkdirSync(path.join(root, 'rbook', 'legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'rbook', 'legacy', 'agents.md'),
      'Run rbook_review() before work.\n'
    );
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      `${rbookRulesLine('builder')} Also run rbook_review().\n`
    );
    const outsideRules = path.join(tmp, 'linked-rules');
    fs.mkdirSync(outsideRules);
    fs.symlinkSync(outsideRules, path.join(root, 'linked-rules'), 'dir');
    const report = await collectTelemetryStats([root], bounds(), env);
    expect(report.events.prompting).toMatchObject({
      prompts: 3,
      prompted: 1,
      pluginCeremonies: 1,
      sentenceCeremonies: 1,
    });
    expect(report.projects[0].rules).toMatchObject({
      files: 3,
      matchingFiles: 2,
      matchingLines: 2,
    });
    expect(report.projects[0].rules.warnings).toHaveLength(1);
  });

  it('uses typed per-session prompt exposures, only later successful uses, and never credits another store', async () => {
    event({
      ts: iso(now - 9000),
      idsCited: ['d:1'],
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
    });
    event({ ts: iso(now - 8000), idsInjected: ['d:1', 'l:1', 'd:2'] });
    event({ ts: iso(now - 7000), idsInjected: ['d:1'] });
    event({
      ts: iso(now - 6000),
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'show',
      idsReturned: ['d:1'],
      session: 'ext:aaaaaaaaaaaaaaaa',
    });
    event({
      ts: iso(now - 5000),
      surface: 'mcp',
      tool: 'rbook_learnings',
      action: 'list',
      idsReturned: ['l:1'],
    });
    event({
      ts: iso(now - 4000),
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
      ok: false,
      idsCited: ['d:2'],
    });
    event({ ts: iso(now - 3000), session: 'bbbbbbbbbbbbbbbb', idsInjected: ['d:2'] });
    const other = path.join(tmp, 'other');
    const otherDb = seedRbookDb(other);
    event(
      {
        surface: 'mcp',
        tool: 'rbook_decisions',
        action: 'record',
        mode: 'write',
        idsCited: ['d:2'],
      },
      otherDb
    );
    const report = await collectTelemetryStats([root, other], bounds(), env);
    expect(report.events.citeThrough.prompt).toMatchObject({ injected: 4, used: 1, ratio: 0.25 });
    expect(report.events.repeatedNeverCited.items.map((item) => item.id)).toEqual(['d:2']);
    expect(report.events.repeatedNeverCited.minimumSessions).toBe(2);
  });

  it('pools only projects readable in both periods and includes completion-call decisions stamped just afterward', async () => {
    for (let i = 0; i < 15; i++) {
      mission(`baseline-${i}`, now - 30 * day, [0, 30_000]);
      mission(`window-${i}`, now - day, i < 5 ? [-120_000, 120_000] : [-121_000, 0]);
    }
    // The late decision beyond five minutes is excluded; before-completion capture is not.
    write(
      'INSERT INTO strategic_decisions (decision_text,mission_id,created_at) VALUES (?,?,?)',
      'late excluded',
      'window-0',
      iso(now - day + 301_000)
    );
    const other = path.join(tmp, 'thin');
    seedRbookDb(other);
    const report = await collectTelemetryStats([root, other], bounds(), env);
    expect(report.timing).toMatchObject({
      readableProjects: 1,
      excludedProjects: 1,
      baseline: { qualified: 15, endLoaded: 15 },
      window: { qualified: 15, endLoaded: 5 },
      passed: true,
    });
  });

  it('reports real-store duplicate, lease, staleness and friction positive fires without changing the store', async () => {
    write('ALTER TABLE learnings ADD COLUMN evergreen INTEGER NOT NULL DEFAULT 0');
    write('ALTER TABLE learnings ADD COLUMN last_reviewed_at TEXT');
    write('ALTER TABLE strategic_decisions ADD COLUMN last_reviewed_at TEXT');
    for (let i = 1; i <= 4; i++)
      write(
        'INSERT INTO sprints (id,title,status,end_date) VALUES (?,?,?,?)',
        `sprint-${i}`,
        'closed',
        'Completed',
        iso(now - (5 - i) * day)
      );
    write(
      'INSERT INTO next_steps (content,status,created_at) VALUES (?,?,?)',
      'private next step',
      'pending',
      iso(now - 20 * day)
    );
    write(
      'INSERT INTO strategic_decisions (decision_text,status,created_at) VALUES (?,?,?)',
      'duplicate private secret',
      'active',
      iso(now - 20 * day)
    );
    write(
      'INSERT INTO strategic_decisions (decision_text,status,created_at) VALUES (?,?,?)',
      'duplicate private secret',
      'active',
      iso(now - day)
    );
    write(
      'INSERT INTO strategic_decisions (decision_text,status,created_at) VALUES (?,?,?)',
      'stale private secret',
      'stale',
      iso(now - day)
    );
    write(
      'CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, body TEXT, created_at TEXT, status TEXT)'
    );
    write(
      'INSERT INTO agent_feedback VALUES (1,?,?,?)',
      'private friction body: lost data',
      iso(now - day),
      'open'
    );
    const before = fs.readFileSync(dbPath);
    const report = await collectTelemetryStats([root], bounds(), env);
    const store = report.projects[0].store;
    expect(store.duplicates).toMatchObject({ newDecisions: 2, exactDuplicates: 1 });
    expect(store.leases).toMatchObject({ lapsing: 1 });
    expect(store.staleness?.storedStaleDecisions).toBe(1);
    expect(store.friction).toMatchObject({ status: 'review-required', count: 1 });
    expect(fs.readFileSync(dbPath)).toEqual(before);
    const exported = JSON.stringify(exportTelemetryStats(report));
    for (const secret of ['private', root, 'lost data', 'd:1'])
      expect(exported).not.toContain(secret);
  });

  it('measures emitted costs, restatements, consecutive stable digests and fail-opens with distinct denominators', async () => {
    event({
      tool: 'hook session-start',
      session: 'aaaaaaaaaaaaaaaa',
      charsInjected: 100,
      digestHash: 'a'.repeat(64),
    });
    event({
      tool: 'hook session-start',
      session: 'bbbbbbbbbbbbbbbb',
      charsInjected: 100,
      digestHash: 'a'.repeat(64),
    });
    event({ charsInjected: 10, restatedRuleIds: ['l:3'] });
    event({ session: 'bbbbbbbbbbbbbbbb', restatedRuleIds: [] });
    event({ failOpen: 'deadline', ok: false });
    event({
      refused: 'WRITE_REFUSED',
      ok: false,
      tool: 'rbook_session',
      surface: 'mcp',
      mode: 'write',
    });
    const report = await collectTelemetryStats([root], bounds(), env);
    expect(report.events.injection).toMatchObject({
      characters: 210,
      sessions: 2,
      meanCharactersPerSession: 105,
      stableDigestPairs: 1,
      comparableDigestPairs: 1,
    });
    expect(report.events.restatement).toMatchObject({
      measuredPrompts: 2,
      restatedPrompts: 1,
      per100: 50,
    });
    expect(report.events.safety).toMatchObject({ deadlineMisses: 1, failOpens: 1, refusals: 1 });
  });

  it('keeps unjoinable and cross-session item details local while exporting only counts', async () => {
    event({ ts: iso(now - 3000), idsInjected: ['l:532', 'd:1622'] });
    event({
      ts: iso(now - 2000),
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
      session: 'pid:1234abcd:1:2',
      idsCited: ['l:532'],
    });
    event({
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
      session: 'bbbbbbbbbbbbbbbb',
      idsCited: ['d:1622'],
    });
    const report = await collectTelemetryStats([root], bounds(), env);
    const exported = exportTelemetryStats(report);
    expect(exported.unjoinableUses).toEqual({
      records: 1,
      pidKeyedRecords: 1,
      otherUnkeyedRecords: 0,
      items: 1,
    });
    expect(exported.crossSessionReferences).toEqual({ records: 1, items: 1 });
    expect(exported.citeThrough.prompt).toMatchObject({ used: 0 });
    const json = JSON.stringify(exported);
    for (const secret of [
      root,
      '1234abcd',
      'l:532',
      'd:1622',
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
    ])
      expect(json).not.toContain(secret);
    let stdout = '';
    expect(
      await runStats([], {
        cwd: root,
        env,
        readStdin: async () => '',
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      })
    ).toBe(0);
    expect(stdout).toContain('Unjoinable use:');
    expect(stdout).toContain('l:532, 1 use records');
    expect(stdout).toContain('Cross-session reference, uncounted:');
    expect(stdout).toContain('d:1622, 1 use records');
  });

  it('surfaces unavailable query sources, then reads a table created afterward without caching its absence', async () => {
    const first = await collectTelemetryStats([root], bounds(), env);
    expect(first.projects[0].store.friction.status).toBe('unavailable');
    write(
      'CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, body TEXT, created_at TEXT, status TEXT)'
    );
    write('INSERT INTO agent_feedback VALUES (1,?,?,?)', 'new item', iso(now - day), 'open');
    const second = await collectTelemetryStats([root], bounds(), env);
    expect(second.projects[0].store.friction.count).toBe(1);
    write('DROP TABLE strategic_decisions');
    const broken = await collectTelemetryStats([root], bounds(), env);
    expect(broken.projects[0].store.timing).toBeNull();
    expect(broken.projects[0].store.warnings.length).toBeGreaterThan(0);
    expect(broken.timing.passed).toBeNull();
  });

  it('supports repeated explicit include-project flags and rejects reversed or malformed windows', async () => {
    const second = path.join(tmp, 'second');
    const third = path.join(tmp, 'third');
    seedRbookDb(second);
    seedRbookDb(third);
    let stdout = '';
    const stderr: string[] = [];
    const io = {
      cwd: root,
      env,
      readStdin: async () => '',
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    };
    const b = bounds();
    const code = await runStats(
      [
        '--export',
        '--include-project',
        second,
        '--include-project',
        third,
        '--since',
        b.since,
        '--until',
        b.until,
        '--baseline-since',
        b.baselineSince,
        '--baseline-until',
        b.baselineUntil,
      ],
      io
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).projects).toBe(3);
    expect(stderr).toEqual([]);
    expect(await runStats(['--since', 'not-a-date'], io)).toBe(1);
    expect(await runStats(['--since', b.until, '--until', b.since], io)).toBe(1);
  });
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — the CLI's other verbs (capture, session, ambient, relevant, review), the bin's routing,
// ABOUTME: resolution parity with the MCP path, and the two #610 follow-ups (advisory, last session).

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { routeArgv } from '../../src/bin';
import { runCli } from '../../src/cli';
import { resolveCliProject, type CliIo } from '../../src/cli/core';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { resolveSenderContext } from '../../src/intelligence/sender-context';
import { rbookAgentOnboard } from '../../src/tools/rbook/rbook-agent-onboard';
import { withClient } from '../../src/tools/rbook/client';
import { createSuccess } from '../../src/tools/rbook/errors';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import {
  automaticCloseSummary,
  setExternalSessionOwner,
} from '../../src/tools/rbook/session-owner';
import { countUntaggedSessions } from '../../src/tools/rbook/untagged-advisory';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m01-cli-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'cli commands' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(argv: string[], cwd = projectRoot, env: Record<string, string> = {}) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
    cwd,
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  const code = await runCli(argv, io);
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}

function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe('s93-m01 — the bin routes before any server module loads', () => {
  it.each([
    [[], 'server', []],
    [['serve'], 'server', []],
    [['serve', '--project-root', '/x'], 'server', ['--project-root', '/x']],
    [['--version'], 'server', ['--version']],
    [['--whoami'], 'server', ['--whoami']],
    [['--project-root', '/x'], 'server', ['--project-root', '/x']],
    [['hook', 'session-start'], 'cli', ['hook', 'session-start']],
    [['review', '--format=context'], 'cli', ['review', '--format=context']],
    [['ambient', 'off'], 'cli', ['ambient', 'off']],
    // A flag written before the verb moves after it; a server flag's value is not a verb.
    [['--project-root', '/x', 'hook', 'stop'], 'cli', ['hook', 'stop', '--project-root', '/x']],
    // Any other word is the CLI's to refuse, never a server started inside a mistyped hook.
    [['hooks', 'session-start'], 'cli', ['hooks', 'session-start']],
    [['HOOK', 'prompt'], 'cli', ['HOOK', 'prompt']],
  ] as const)('%j → %s', (argv, kind, rest) => {
    expect(routeArgv(argv)).toEqual({ kind, argv: rest });
  });

  it('stats runs, later verbs refuse, and a usage error exits 1, never 2', async () => {
    expect((await run(['stats'])).code).toBe(0);
    expect((await run(['feedback'])).code).toBe(1);
    const usage = await run([]);
    expect(usage.code).toBe(1);
    expect(usage.stderr[0]).toContain('Usage: reasonbook');
    // Exit 2 from a UserPromptSubmit hook blocks the prompt in Claude Code.
    const typo = await run(['hooks', 'prompt']);
    expect(typo.code).toBe(1);
    expect(typo.stderr[0]).toContain('unknown verb "hooks"');
    // A mistyped event is a configuration error too, said with exit 1 rather than hidden.
    const event = await run(['hook', 'prompts']);
    expect(event.code).toBe(1);
    expect(event.stderr).toEqual([expect.stringContaining('name an event')]);
  });

  it('keeps future hook options fail-open instead of applying the hand-run option contract', async () => {
    const result = await run(['hook', 'prompt', '--future-harness-option=value'], projectRoot, {
      RBOOK_AMBIENT: 'off',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.join(' ')).not.toMatch(/unknown option/i);
  });
});

describe('F9 init names a new project without renaming an existing one', () => {
  it.each(['cwd', 'explicit'])('defaults a %s target to its folder name', async (mode) => {
    const fresh = path.join(tmp, `fresh-${mode}`);
    fs.mkdirSync(fresh);
    const argv = ['init', '--no-hooks', ...(mode === 'explicit' ? ['--project-root', fresh] : [])];
    const result = await run(argv, mode === 'cwd' ? fresh : projectRoot);
    expect(result.code).toBe(0);
    const db = new Database(path.join(fresh, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get()).toEqual({
        value: path.basename(fresh),
      });
      const context = db
        .prepare("SELECT content FROM contexts WHERE id = 'master_context'")
        .get() as { content: string };
      expect(JSON.parse(context.content).project_identity.name).toBe(path.basename(fresh));
    } finally {
      db.close();
    }
  });

  it('keeps an existing custom name unless --name explicitly replaces it', async () => {
    expect((await run(['init', '--no-hooks'])).code).toBe(0);
    expect(query("SELECT value FROM metadata WHERE key = 'project_name'")).toEqual([
      { value: 'cli commands' },
    ]);
    expect((await run(['init', '--no-hooks', '--name', 'An explicit name'])).code).toBe(0);
    expect(query("SELECT value FROM metadata WHERE key = 'project_name'")).toEqual([
      { value: 'An explicit name' },
    ]);
  });

  it('init help leaves an empty target empty', async () => {
    const fresh = path.join(tmp, 'help-must-not-init');
    fs.mkdirSync(fresh);
    const result = await run(['init', '--project-root', fresh, '--help']);
    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(result.stdout).toContain('Usage: reasonbook');
    expect(fs.readdirSync(fresh)).toEqual([]);
  });
});

describe('s93-m01 — capture and session need a harness session (fork 8)', () => {
  it('refuses an unknown capture category before a handler can claim a capture or create a session', async () => {
    const refused = await run([
      'capture',
      '--session-id',
      'invalid-category',
      '--category',
      'Learning',
      '--content',
      'This must not silently disappear.',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr.join(' ')).toMatch(/category.*learning/);
    expect(query('SELECT id FROM sessions')).toEqual([]);
    expect(query('SELECT id FROM learnings')).toEqual([]);
  });

  it('a capture without --session-id is refused with the remedy, and opens no session', async () => {
    const refused = await run(['capture', '--category', 'context', '--content', 'By hand.']);
    expect(refused.code).toBe(1);
    expect(refused.stderr[0]).toContain('--session-id');
    expect(query('SELECT id FROM sessions')).toEqual([]);
  });

  it('a capture with --session-id lands in that harness session, hashed', async () => {
    const ran = await run([
      'capture',
      '--session-id',
      'raw-cli-session',
      '--category',
      'context',
      '--content',
      'From the command line.',
    ]);
    expect(ran.code).toBe(0);
    const key = `ext:${harnessSessionHash('raw-cli-session')}`;
    const [session] = query<{ captures: string }>(
      'SELECT captures FROM sessions WHERE owner_key = ?',
      key
    );
    expect(session.captures).toContain('From the command line.');
    expect(fs.readFileSync(dbPath).includes('raw-cli-session')).toBe(false);
  });

  it('session ensure opens one session per harness session, and close closes it', async () => {
    const first = await run(['session', 'ensure', '--session-id', 'raw-adapter']);
    const again = await run(['session', 'ensure', '--session-id', 'raw-adapter']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('(opened)');
    expect(again.stdout.trim()).toBe(first.stdout.replace(' (opened)', '').trim());
    const closed = await run(['session', 'close', '--session-id', 'raw-adapter']);
    expect(closed.stdout).toContain('closed');
    const key = `ext:${harnessSessionHash('raw-adapter')}`;
    expect(query('SELECT status FROM sessions WHERE owner_key = ?', key)).toEqual([
      { status: 'completed' },
    ]);
  });
});

describe('s93-m01 — ambient', () => {
  it('shows and sets the project setting, and RBOOK_AMBIENT overrides it for a session', async () => {
    expect((await run(['ambient'])).stdout.trim()).toBe('on');
    expect((await run(['ambient', 'digest-off'])).code).toBe(0);
    expect((await run(['ambient'])).stdout.trim()).toBe('digest-off');
    expect((await run(['ambient'], projectRoot, { RBOOK_AMBIENT: 'off' })).stdout.trim()).toBe(
      'off (RBOOK_AMBIENT, this session only)'
    );
    expect((await run(['ambient', 'loud'])).code).toBe(1);
  });
});

describe('s93-m01 — relevant (the keyword arm)', () => {
  it('keeps shared decision previews inert in text while JSON keeps the original preview', async () => {
    const text = 'SQLite \u001b[2K\u0085\nFORGED LINE';
    const db = new Database(dbPath);
    try {
      db.prepare(
        'INSERT INTO strategic_decisions (id, decision_text, created_at, status) VALUES (1, ?, ?, ?)'
      ).run(text, new Date().toISOString(), 'active');
    } finally {
      db.close();
    }
    const human = await run(['relevant', '--query', 'sqlite']);
    expect(human.code).toBe(0);
    // eslint-disable-next-line no-control-regex -- C0/C1 witness permits only generated LF.
    expect(human.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(human.stdout).not.toMatch(/^FORGED LINE/m);
    const json = await run(['relevant', '--query', 'sqlite', '--format', 'json']);
    expect(JSON.parse(json.stdout).items[0].text).toContain('\u001b');
  });

  it('returns matching decisions and learnings as previews, superseded rows dropped', async () => {
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (?, ?, '2026-10-01T00:00:00Z', ?)`
      );
      insert.run(1, 'Use SQLite for the local record store.', 'active');
      insert.run(2, 'Use Postgres for the local record store.', 'superseded');
      db.prepare(
        `INSERT INTO learnings (id, content, created_at, status)
         VALUES (1, 'SQLite WAL mode keeps readers unblocked.', '2026-10-01T00:00:00Z', 'active')`
      ).run();
    } finally {
      db.close();
    }
    const ran = await run(['relevant', '--query', 'sqlite record store', '--format', 'json']);
    expect(ran.code).toBe(0);
    const { items } = JSON.parse(ran.stdout) as {
      items: Array<{ kind: string; id: number; status: string }>;
    };
    expect(items.map((i) => `${i.kind}#${i.id}`)).toContain('decision#1');
    expect(items.map((i) => `${i.kind}#${i.id}`)).not.toContain('decision#2');
    expect(items.every((i) => i.status !== 'superseded')).toBe(true);
  });
});

describe('s93-m01 — review --format=context prints the digest', () => {
  it('prints the digest text, and refuses where there is no project', async () => {
    const ran = await run(['review', '--format=context']);
    expect(ran.code).toBe(0);
    expect(ran.stdout.length).toBeGreaterThan(0);
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const refused = await run(['review'], elsewhere);
    expect(refused.code).toBe(1);
    expect(refused.stderr[0]).toContain('no Reasonbook project');
  });
});

describe('s93-m01 — the CLI resolves a project as the MCP path does (fork 3)', () => {
  it.each([
    ['the project root', (root: string) => root],
    ['a folder inside it', (root: string) => path.join(root, 'src', 'deep')],
    ['a folder outside any project', () => path.join(tmp, 'outside')],
  ])('from %s', async (_, where) => {
    const dir = where(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const cli = resolveCliProject({ env: {}, cwd: dir, homeDir: tmp });
    let mcp: string | null;
    try {
      mcp = (
        await resolveSenderContext({
          requireSenderIdentity: false,
          heal: false,
          cwdOverride: dir,
          homeDirOverride: tmp,
        })
      ).projectRoot;
    } catch {
      mcp = null;
    }
    expect(cli.kind === 'store' ? cli.projectRoot : null).toBe(mcp);
  });

  // The m01 build critic, B3: a Reasonbook layout whose database is gone ends the walk in both, and
  // neither treats it as a folder without Reasonbook.
  it('a store whose database is gone: both stop there, and neither resolves a store', async () => {
    const lost = path.join(tmp, 'lost');
    fs.mkdirSync(path.join(lost, 'rbook', 'db'), { recursive: true });
    const inside = path.join(lost, 'src');
    fs.mkdirSync(inside);
    expect(resolveCliProject({ env: {}, cwd: inside, homeDir: tmp })).toEqual({
      kind: 'store-missing',
      projectRoot: lost,
      dbPath: path.join(lost, 'rbook', 'db', 'rbook.sqlite'),
    });
    await expect(
      resolveSenderContext({
        requireSenderIdentity: false,
        heal: false,
        cwdOverride: inside,
        homeDirOverride: tmp,
      })
    ).rejects.toThrow(/lost/);
  });

  it('an explicit --project-root is final in both', async () => {
    const outside = path.join(tmp, 'outside-explicit');
    fs.mkdirSync(outside);
    expect(resolveCliProject({ projectRootArg: outside, env: {}, cwd: projectRoot }).kind).toBe(
      'explicit-missing'
    );
    await expect(
      resolveSenderContext({
        explicitProjectRoot: outside,
        requireSenderIdentity: false,
        heal: false,
      })
    ).rejects.toThrow();
  });
});

describe('s93-m01 — the #610 follow-ups', () => {
  it('the untagged advisory counts explicit sessions only', async () => {
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO sessions (id, type, title, started_at, status, implicit, owner_key)
         VALUES (?, 'custom', ?, '2026-10-01T00:00:00Z', 'active', ?, ?)`
      );
      insert.run('PS-2026-10-01-001', 'implicit one', 1, 'pid:x:1:1');
      insert.run('PS-2026-10-01-002', 'explicit one', 0, null);
    } finally {
      db.close();
    }
    const counted = await withClient((client) => createSuccess(countUntaggedSessions(client)), {
      projectRoot,
    });
    expect(counted.data).toBe(1);
  });

  // The m01 build critic: with hooks most sessions are implicit, so recency decides, except that an
  // automatic close that held nothing never displaces a session that has something.
  it("onboard's last session: an empty automatic close never displaces a handoff; later work does", async () => {
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const empty = automaticCloseSummary({
      reason: 'harness-ended',
      idleHours: null,
      captures: '[]',
      decisions: 0,
      learnings: 0,
    });
    const busy = automaticCloseSummary({
      reason: 'harness-ended',
      idleHours: null,
      captures: JSON.stringify([{ category: 'next-step', content: 'Y' }]),
      decisions: 1,
      learnings: 0,
    });
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, completed_at, status, summary, implicit)
       VALUES (?, 'custom', ?, ?, ?, 'completed', ?, ?)`
    );
    try {
      insert.run('PS-HANDOFF', 'The handoff', at(4), at(3), 'Handoff: do X next.', 0);
      insert.run('PS-EMPTY', 'Implicit session (ext:1)', at(2.5), at(2), empty, 1);
    } finally {
      db.close();
    }
    expect((await rbookAgentOnboard({ projectRoot })).data?.lastSession?.id).toBe('PS-HANDOFF');

    const again = new Database(dbPath);
    try {
      again
        .prepare(
          `INSERT INTO sessions (id, type, title, started_at, completed_at, status, summary, implicit)
           VALUES (?, 'custom', ?, ?, ?, 'completed', ?, 1)`
        )
        .run('PS-LATER-WORK', 'Implicit session (ext:2)', at(1.5), at(1), busy);
    } finally {
      again.close();
    }
    expect((await rbookAgentOnboard({ projectRoot })).data?.lastSession?.id).toBe('PS-LATER-WORK');
  });
});

describe('s94-m04 — shaped decisions use the same owned write path', () => {
  it('checks malformed decision arrays before entering the router and prints the expected type', async () => {
    const router = await import('../../src/tools/rbook/rbook-decisions');
    const routed = jest.spyOn(router, 'rbookDecisions');
    try {
      const result = await run([
        'decisions',
        'record',
        '--session-id',
        'invalid-decision',
        '--content',
        'Do not store.',
        '--alternatives',
        '[1]',
      ]);
      expect(result.code).toBe(1);
      expect(routed).not.toHaveBeenCalled();
      expect(result.stderr.join(' ')).toMatch(/alternatives.*string/);
      expect(query('SELECT id FROM sessions')).toEqual([]);
      expect(query('SELECT id FROM strategic_decisions')).toEqual([]);
    } finally {
      routed.mockRestore();
    }
  });

  it('refuses a missing session before any row is written', async () => {
    const result = await run(['decisions', 'record', '--content', 'Choose the shared writer.']);
    expect(result.code).toBe(1);
    expect(result.stderr.join(' ')).toContain('--session-id');
    expect(query('SELECT id FROM sessions')).toEqual([]);
  });
  it('records autonomous reasoning with an explicit root, no project ENV and JSON output', async () => {
    const result = await run(
      [
        'decisions',
        'record',
        '--project-root',
        projectRoot,
        '--session-id',
        'shape-cli',
        '--content',
        'Choose the shared writer.',
        '--context',
        'Keep CLI and MCP consistent.',
        '--alternatives',
        '["Duplicate the SQL"]',
        '--consequences',
        'One validation path.',
        '--deciders',
        '["Agent"]',
        '--mode',
        'autonomous',
        '--format',
        'json',
      ],
      tmp
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);
    expect(
      query(
        'SELECT context_text, alternatives, consequences, deciders, approval_mode FROM strategic_decisions'
      )
    ).toEqual([
      {
        context_text: 'Keep CLI and MCP consistent.',
        alternatives: '["Duplicate the SQL"]',
        consequences: 'One validation path.',
        deciders: '["Agent"]',
        approval_mode: 'autonomous',
      },
    ]);
  });
  it.each(['{bad', '"not an array"', '[1]'])(
    'refuses malformed array %s before session creation',
    async (alternatives) => {
      const result = await run([
        'decisions',
        'record',
        '--session-id',
        'shape-cli',
        '--content',
        'Do not store.',
        '--alternatives',
        alternatives,
      ]);
      expect(result.code).toBe(1);
      expect(query('SELECT id FROM sessions')).toEqual([]);
      expect(query('SELECT id FROM strategic_decisions')).toEqual([]);
    }
  );
  it('renders the headline budget warning while succeeding', async () => {
    const result = await run([
      'decisions',
      'record',
      '--session-id',
      'shape-cli',
      '--content',
      'x'.repeat(601),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('600');
  });
});

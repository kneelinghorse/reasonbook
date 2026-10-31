// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m12 — every Reasonbook call the shipped seed shows runs on a fresh store without a refusal: the sweep
// ABOUTME: for "a shipped example call the server refuses", with placeholders filled from a published table.

/**
 * WHY (design doc rbook/planning/s93-the-loop-runs-itself-build.md, m12). The tier guides taught calls
 * the server refuses: managed.md's task example left out missionId and sprintId (next-step #605,
 * byte-identical in twelve projects), build.md's sprint close left out sprintId, and the seed
 * README's session start left out title. An agent that copies a shipped example should never meet
 * a refusal.
 *
 * THE PREDICATE (the class, as a search): every `rbook_<name>(…)` call inside a fenced code block
 * (``` or ~~~) or an inline code span in a Markdown file under rbook-seed/. The census below pins the count: 142
 * after s93-m12 (89 fenced, 53 inline), 137 on 2026-10-08 before it rewrote the seed. A `//`
 * comment inside a call is skipped to its line end, so an apostrophe there cannot hide the call.
 *
 * PLACEHOLDERS, and the counting rule beside the number. A value is a placeholder when it is `...`
 * or `…`, a `<…>` slot, an alternation of words (`general|managed|build`), the example path
 * `/path/to/your/project`, an array of `...`, or a shorthand object such as `{type, id}`; an
 * argument written as a bare `...` elides the rest of the call's required parameters. Each is
 * filled from FILL or ELIDED below, which name an existing mission, sprint, snapshot or message of
 * the fixture store, or plain example text. Anything else runs exactly as written.
 *
 * HOW A CALL RUNS. Through the MCP dispatch (executeMissionProtocolTool), on its own copy of one
 * fixture project, with its own config directory, so no call sees another's writes and no copy
 * collides with another in the project registry. Every call is given the copy's projectRoot, as
 * an agent standing in that project would resolve it; an init call is given nothing more, since
 * init never infers its folder. The fixture is connected to a loopback stub dashboard, as a project
 * that uses messaging is.
 *
 * PRECONDITIONS. An example is judged in the state it presupposes: completing a session presupposes
 * one is open, and completing or blocking a mission presupposes it is in progress. PRECONDITIONS
 * below sets that state up on the copy, with real calls, before the example runs; it never changes
 * the example's own arguments.
 *
 * WHAT IT CANNOT SEE (one contract with the scope above): calls written in prose outside code, or in
 * an indented code block (four spaces in, which Markdown cannot tell from a list continuation
 * without a parser); a call whose sense depends on an earlier call in the same block beyond the
 * fixture's state; what a real dashboard would answer; and whether the example is good advice. A
 * refusal is the only failure it reports, except for the level rule below, which holds every init
 * in a document that teaches sprints or missions to a level that keeps them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  buildFirstSessionPrompt,
  buildTierSelectionPrompt,
} from '../../src/tools/rbook/rbook-agent-onboard';
import { rbookDbSnapshot } from '../../src/tools/rbook/rbook-db-snapshot';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import { parseCall, Placeholder, type ParsedCall } from '../helpers/parse-call';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SEED = path.join(REPO_ROOT, 'rbook-seed');

// ─── The predicate ─────────────────────────────────────────────────────────────────────────────

export interface SeedCall {
  readonly file: string;
  readonly line: number;
  readonly kind: 'fenced' | 'inline';
  readonly source: string;
}

function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? markdownFiles(path.join(dir, entry.name))
        : entry.name.endsWith('.md')
          ? [path.join(dir, entry.name)]
          : []
    )
    .sort();
}

/** The balanced call starting at `start` (text there begins `rbook_name(`), or null if unclosed. */
function balancedCall(text: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = text.indexOf('(', start); i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    // A `//` comment runs to the end of its line, apostrophes and all: reading "sprint's" in one
    // as a quote once dropped a whole call from the predicate.
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function callsIn(text: string): string[] {
  const found: string[] = [];
  const pattern = /\brbook_[a-z_]+\(/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const call = balancedCall(text, match.index);
    if (!call) continue;
    found.push(call);
    pattern.lastIndex = match.index + call.length;
  }
  return found;
}

/** Every call the predicate finds, in file order. */
export function seedCalls(): SeedCall[] {
  return callsInMarkdown(markdownFiles(SEED));
}

/** The predicate's calls in the given Markdown files, in file order. */
function callsInMarkdown(files: readonly string[]): SeedCall[] {
  const calls: SeedCall[] = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let fence: { start: number; body: string[]; marker: string } | null = null;
    lines.forEach((line, index) => {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1];
      if (marker && (!fence || fence.marker === marker)) {
        if (fence) {
          for (const source of callsIn(fence.body.join('\n'))) {
            calls.push({ file: rel, line: fence.start + 1, kind: 'fenced', source });
          }
          fence = null;
        } else {
          fence = { start: index, body: [], marker };
        }
        return;
      }
      if (fence) {
        fence.body.push(line);
        return;
      }
      for (const span of line.matchAll(/`([^`]+)`/g)) {
        for (const source of callsIn(span[1])) {
          calls.push({ file: rel, line: index + 1, kind: 'inline', source });
        }
      }
    });
  }
  return calls;
}

// ─── Reading a call ────────────────────────────────────────────────────────────────────────────

function holdsPlaceholder(value: unknown): boolean {
  if (value instanceof Placeholder) return true;
  if (Array.isArray(value)) return value.some(holdsPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(holdsPlaceholder);
  return false;
}

// ─── The fixture and the published fill table ──────────────────────────────────────────────────

interface Fixture {
  /** A project made by init, with the records below; every call runs on a copy of it. */
  readonly root: string;
  readonly snapshotId: string;
  /** A message the stub dashboard holds. */
  readonly messageId: string;
  /** A fresh, empty folder for an init call. */
  emptyFolder(): string;
}

/**
 * What a placeholder becomes, by `tool.action.param`, then `tool.param`, then `param`. Ids name the
 * fixture's records: sprint-01 is open, with s01-m01 queued in it. A placeholder never names a
 * record already in the state a call needs: that state comes only from PRECONDITIONS, and only when
 * the document teaches the step that produces it (the m12 build critic, B2).
 */
const FILL: Readonly<Record<string, (fixture: Fixture) => unknown>> = {
  'rbook_mission.update.fields': () => ({ objective: 'An example objective.' }),
  'rbook_db.restore.snapshotId': (fixture) => fixture.snapshotId,
  'rbook_message.respond.messageId': (fixture) => fixture.messageId,
  'rbook_project.init.projectRoot': (fixture) => fixture.emptyFolder(),
  'rbook_project.update.projectType': () => 'general',
  missionId: () => 's01-m01',
  sprintId: () => 'sprint-01',
  type: () => 'planning',
  category: () => 'decision',
  title: () => 'An example title',
  content: () => 'An example capture.',
  summary: () => 'An example summary.',
  notes: () => 'What was done.',
  reason: () => 'An example reason.',
  query: () => 'example',
  blockers: () => ['An example blocker'],
  nextSteps: () => ['An example next step'],
  evidence: () => [{ type: 'report', id: 'example-report' }],
  // Computed from the clock, never a fixed date.
  since: () => new Date(Date.now() - 86_400_000).toISOString(),
};

/**
 * What an example presupposes, set up with real calls on its copy before it runs, and only when
 * the same document teaches a call that produces it (`taughtBy`): completing a mission presupposes
 * it was started, so a guide that never shows the start gets no help here, and its completion is
 * refused as it would be for an agent following it. Nothing here touches the example's arguments.
 */
const PRECONDITIONS: Readonly<
  Record<
    string,
    {
      readonly taughtBy: readonly string[];
      readonly setUp: (args: Record<string, unknown>, root: string) => Promise<void>;
    }
  >
> = {
  // Completing "your" session presupposes you have one: a capture opens it.
  'rbook_session.complete': {
    taughtBy: ['rbook_session.start', 'rbook_session.capture'],
    setUp: async (args, root) => {
      if (args.sessionId === undefined) {
        await setUp(
          'rbook_session',
          { action: 'capture', category: 'context', content: 'Earlier work.' },
          root
        );
      }
    },
  },
  'rbook_mission_transition.complete': {
    taughtBy: ['rbook_mission_transition.start'],
    setUp: (args, root) => missionIs(args.missionId, 'In Progress', root),
  },
  'rbook_mission_transition.block': {
    taughtBy: ['rbook_mission_transition.start'],
    setUp: (args, root) => missionIs(args.missionId, 'In Progress', root),
  },
  'rbook_mission_transition.unblock': {
    taughtBy: ['rbook_mission_transition.block'],
    setUp: (args, root) => missionIs(args.missionId, 'Blocked', root),
  },
  // Closing a sprint presupposes its work is done, which the document shows as completions.
  'rbook_sprint.complete': {
    taughtBy: ['rbook_mission_transition.complete'],
    setUp: (args, root) => sprintWorkDone(args.sprintId, root),
  },
};

function readStore<T>(root: string, read: (db: Database.Database) => T): T {
  const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const missionStatus = (missionId: string, root: string): string | undefined =>
  readStore(
    root,
    (db) =>
      (
        db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as
          | { status: string }
          | undefined
      )?.status
  );

/** Bring a mission to `status` through the transitions an agent would make. */
async function missionIs(
  missionId: unknown,
  status: 'In Progress' | 'Blocked',
  root: string
): Promise<void> {
  if (typeof missionId !== 'string') return;
  if (missionStatus(missionId, root) === 'Queued') {
    await setUp('rbook_mission_transition', { action: 'start', missionId }, root);
  }
  if (status === 'Blocked' && missionStatus(missionId, root) === 'In Progress') {
    await setUp(
      'rbook_mission_transition',
      { action: 'block', missionId, reason: 'Waiting on review', blockers: ['review'] },
      root
    );
  }
}

/** Start and complete every unfinished mission in a sprint, as an agent would before closing it. */
async function sprintWorkDone(sprintId: unknown, root: string): Promise<void> {
  if (typeof sprintId !== 'string') return;
  const open = readStore(
    root,
    (db) =>
      db
        .prepare(
          `SELECT id FROM missions WHERE sprint_id = ? AND status IN ('Queued', 'Current', 'In Progress', 'Blocked')`
        )
        .all(sprintId) as Array<{ id: string }>
  );
  for (const { id } of open) {
    if (missionStatus(id, root) === 'Blocked') {
      await setUp('rbook_mission_transition', { action: 'unblock', missionId: id }, root);
    }
    await missionIs(id, 'In Progress', root);
    await setUp(
      'rbook_mission_transition',
      { action: 'complete', missionId: id, notes: 'Done.' },
      root
    );
  }
}

/** A set-up call; a refusal here is the harness's failure, not the example's. */
async function setUp(tool: string, args: Record<string, unknown>, root: string): Promise<void> {
  const ran = await dispatch(tool, { ...args, projectRoot: root });
  if (ran.isError) throw new Error(`set-up ${tool}.${String(args.action)} failed: ${ran.text}`);
}

/** What an elided `...` supplies: the call's required parameters it leaves out. */
const ELIDED_FILL: Readonly<Record<string, (fixture: Fixture) => Record<string, unknown>>> = {
  'rbook_project.init': (fixture) => ({ projectRoot: fixture.emptyFolder() }),
  'rbook_mission.add': () => ({ missionId: 's01-m09', sprintId: 'sprint-01', name: 'An example' }),
  'rbook_mission.depends': () => ({ fromId: 's01-m02', toId: 's01-m01', type: 'Requires' }),
  'rbook_sprint.add': () => ({ sprintId: 'sprint-02', title: 'An example sprint' }),
  'rbook_sprint.update': () => ({ sprintId: 'sprint-01', fields: { focus: 'An example focus' } }),
  'rbook_context.snapshot': () => ({ source: 'example' }),
};

function fill(tool: string, action: string | undefined, param: string, fixture: Fixture): unknown {
  const make = FILL[`${tool}.${action}.${param}`] ?? FILL[`${tool}.${param}`] ?? FILL[param];
  if (!make) throw new Error(`no published fill for ${tool}.${action}.${param}`);
  return make(fixture);
}

const actionOf = (call: ParsedCall): string | undefined =>
  typeof call.args.get('action') === 'string' ? (call.args.get('action') as string) : undefined;

/** The arguments a call runs with: as written, placeholders filled, the elided part supplied. */
export function callArguments(call: ParsedCall, fixture: Fixture): Record<string, unknown> {
  const action = actionOf(call);
  const args: Record<string, unknown> = {};
  for (const [param, value] of call.args) {
    args[param] = holdsPlaceholder(value) ? fill(call.tool, action, param, fixture) : value;
  }
  if (call.elided) {
    const supply = ELIDED_FILL[`${call.tool}.${action}`];
    if (!supply) throw new Error(`no published fill for the elided part of ${call.tool}.${action}`);
    Object.assign(args, supply(fixture));
  }
  return args;
}

/**
 * What one document creates and teaches: the `tool.action` pairs it shows, and the records it makes
 * itself (a sprint or mission added with a literal id, or named in an init example's initialSprint
 * or initialMissions), each with the add call that makes it, for replay.
 */
interface DocumentScope {
  readonly taught: ReadonlySet<string>;
  readonly creates: ReadonlyMap<string, ParsedCall | null>;
}

/** A value written as a plain string (a placeholder is parsed as a Placeholder, never a string). */
const literalString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function documentScope(calls: readonly SeedCall[]): DocumentScope {
  const taught = new Set<string>();
  const creates = new Map<string, ParsedCall | null>();
  for (const call of calls) {
    const parsed = parseCall(call.source);
    const action = actionOf(parsed);
    taught.add(`${parsed.tool}.${action}`);
    if (parsed.tool === 'rbook_project' && action === 'init') {
      const sprint = parsed.args.get('initialSprint') as Record<string, unknown> | undefined;
      const sprintId = literalString(sprint?.id);
      if (sprintId) creates.set(`sprint:${sprintId}`, null);
      for (const mission of (parsed.args.get('initialMissions') as unknown[] | undefined) ?? []) {
        const missionId = literalString((mission as Record<string, unknown>).id);
        if (missionId) creates.set(`mission:${missionId}`, null);
      }
    }
    if (parsed.tool === 'rbook_sprint' && action === 'add') {
      const sprintId = literalString(parsed.args.get('sprintId'));
      if (sprintId) creates.set(`sprint:${sprintId}`, parsed);
    }
    if (parsed.tool === 'rbook_mission' && action === 'add') {
      const missionId = literalString(parsed.args.get('missionId'));
      if (missionId) creates.set(`mission:${missionId}`, parsed);
    }
  }
  return { taught, creates };
}

/** The literal sprint and mission ids a call names, as `kind:id` keys. */
function namedRecords(call: ParsedCall): string[] {
  const keys: string[] = [];
  for (const [param, kind] of [
    ['sprintId', 'sprint'],
    ['missionId', 'mission'],
    ['fromId', 'mission'],
    ['toId', 'mission'],
  ] as const) {
    const id = literalString(call.args.get(param));
    if (id) keys.push(`${kind}:${id}`);
  }
  return keys;
}

// ─── Running every call ────────────────────────────────────────────────────────────────────────

const SEED_CALLS = seedCalls();
/**
 * The prompts onboard hands a new project's agent teach calls too (the m12 build critic, B3): each
 * is swept as a document of its own, outside the seed's census.
 */
const PROMPT_CALLS: SeedCall[] = [
  { file: 'onboard: first session (general)', text: buildFirstSessionPrompt() },
  ...['general', 'managed', 'build'].map((tier) => ({
    file: `onboard: new project (${tier})`,
    text: buildTierSelectionPrompt(tier),
  })),
].flatMap(({ file, text }) =>
  callsIn(text).map((source) => ({ file, line: 1, kind: 'inline' as const, source }))
);
const CALLS = [...SEED_CALLS, ...PROMPT_CALLS];
/** Each document's scope: what it teaches and the records it creates. */
const SCOPES = new Map(
  [...new Set(CALLS.map((call) => call.file))].map((file) => [
    file,
    documentScope(CALLS.filter((call) => call.file === file)),
  ])
);
const tmpDirs: string[] = [];
const mkTmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

const STUB_MESSAGE_ID = '3f6c2a9e-8b14-4d7a-9e52-1c0b7d4f6a21';
let stub: http.Server;
let stubUrl = '';
let fixture: Fixture;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['RBOOK_CONFIG_DIR', 'RBOOK_DASHBOARD_URL', 'RBOOK_DASHBOARD_API_KEY'] as const;

/** A loopback dashboard that accepts what the seed's messaging examples send. */
function startStub(): Promise<void> {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const message = {
        id: STUB_MESSAGE_ID,
        type: 'backlog_request',
        summary: 'An example message',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      if (req.method === 'GET' && req.url?.startsWith('/api/messages/resolve')) {
        res.end(JSON.stringify({ address: 'rbook://user/project', projectId: 'project' }));
      } else if (req.method === 'GET' && req.url?.startsWith('/api/messages')) {
        res.end(JSON.stringify({ messages: [message], total: 1 }));
      } else if (req.method === 'POST' && req.url === '/api/messages') {
        res.end(JSON.stringify({ messageId: STUB_MESSAGE_ID, status: 'pending' }));
      } else if (req.method === 'POST' && req.url?.endsWith('/respond')) {
        res.end(JSON.stringify({ ...message, status: 'accepted' }));
      } else if (req.method === 'GET' && req.url?.startsWith('/api/projects/me')) {
        res.end(JSON.stringify({ projects: [] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  return new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve())).then(() => {
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
}

/** Run one tool call through the dispatch, as the router would, and return its text. */
async function dispatch(
  tool: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string }> {
  const result = await executeMissionProtocolTool(tool, args, context);
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? '')
    .join('\n');
  return { isError: result.isError === true, text };
}

/**
 * What a project connected to the dashboard holds: its dashboard project id and its canonical
 * address. Messaging sends under that identity.
 */
function connectToDashboard(root: string): void {
  const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
  try {
    const setMeta = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
    setMeta.run('dashboard_project_id', '7b0e9f3c-2d4a-4c1e-9a6b-5f8d2e1c0a47');
    setMeta.run('owner', 'example-owner');
    const row = db.prepare(`SELECT content FROM contexts WHERE id = 'project_identity'`).get() as
      | { content: string }
      | undefined;
    if (!row) throw new Error('the fixture has no project_identity row to connect');
    const identity = JSON.parse(row.content) as Record<string, unknown>;
    identity.rbook_address = 'rbook://example-owner/seed-example-fixture';
    db.prepare(`UPDATE contexts SET content = ? WHERE id = 'project_identity'`).run(
      JSON.stringify(identity)
    );
  } finally {
    db.close();
  }
}

/** Use a fresh config directory, so no call meets another's registry rows. */
function freshConfig(): void {
  process.env.RBOOK_CONFIG_DIR = mkTmp('rbook-seed-calls-config-');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  CredentialStore.resetInstance();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  await startStub();
  process.env.RBOOK_DASHBOARD_URL = stubUrl;
  process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_seed_example_stub';
  context = await buildMissionProtocolContext();
  freshConfig();

  const root = path.join(mkTmp('rbook-seed-calls-fixture-'), 'project');
  fs.mkdirSync(root);
  const init = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Seed example fixture',
    projectType: 'build',
  });
  if (!init.success) throw new Error(`fixture init failed: ${init.error?.message}`);
  // sprint-01 with two queued missions: s01-m01 stands for the mission a document's init example
  // creates, and s01-m02 is the second mission a dependency example needs.
  const setup: Array<[string, Record<string, unknown>]> = [
    [
      'rbook_sprint',
      { action: 'add', sprintId: 'sprint-01', title: 'Example sprint', status: 'Active' },
    ],
    ...['s01-m01', 's01-m02'].map((missionId): [string, Record<string, unknown>] => [
      'rbook_mission',
      { action: 'add', missionId, sprintId: 'sprint-01', name: `Mission ${missionId}` },
    ]),
  ];
  for (const [tool, args] of setup) {
    const ran = await dispatch(tool, { ...args, projectRoot: root });
    if (ran.isError) throw new Error(`fixture ${tool}.${String(args.action)} failed: ${ran.text}`);
  }
  connectToDashboard(root);
  const snapshot = await rbookDbSnapshot({ projectRoot: root });
  if (!snapshot.success) throw new Error(`fixture snapshot failed: ${snapshot.error?.message}`);
  fixture = {
    root,
    snapshotId: snapshot.data!.createdSnapshot!.id,
    messageId: STUB_MESSAGE_ID,
    emptyFolder: () => mkTmp('rbook-seed-calls-init-'),
  };
}, 60_000);

// The suite's setup clears dashboard credentials before every test (tests/jest-setup-after-env.ts),
// so the stub's key is set again after it, for each call.
beforeEach(() => {
  process.env.RBOOK_DASHBOARD_URL = stubUrl;
  process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_seed_example_stub';
});

afterAll(async () => {
  ProjectGraphRegistry.resetInstance();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('s93-m12 — the seed shows no call the server refuses', () => {
  it('finds the calls the predicate names, and says how many', () => {
    const fenced = SEED_CALLS.filter((call) => call.kind === 'fenced').length;
    // The count, published beside its rule (the docblock). 137 on 2026-10-08 (88 fenced, 49
    // inline) before s93-m12 rewrote the seed. Since then: AGENTS.md lost its three Reasonbook calls and
    // the hook-less block has three; the general guide traded its session start and close for one
    // capture and gained the review and the step-up call (+1); the managed guide's cycle and its
    // start step added two; the agents-file guide gained the step-up call and the init call that
    // takes the level. s95-m06: the Ledger and Planner READMEs each name their step-up call (+2
    // inline). s101-m04 adds the Ledger next-step retrieval call (+1 inline).
    // s102-m06 adds Ledger show (+1), plus Planner and Builder list/show (+4 inline).
    // A change in the seed's calls changes this number on purpose.
    expect({ total: SEED_CALLS.length, fenced, inline: SEED_CALLS.length - fenced }).toEqual({
      total: 150,
      fenced: 89,
      inline: 61,
    });
  });

  // The confirming critic: the quick starts created a Ledger project (no level passed), then taught
  // the sprints and missions a Ledger project's onboard leaves out. Every call ran, so the sweep
  // could not see it. The npm package's getting-started guide is held to the same rule.
  it('a document that teaches sprints or missions starts its project at a level that keeps them', () => {
    const documents = [
      ...SEED_CALLS,
      ...callsInMarkdown([path.join(REPO_ROOT, 'docs', 'getting-started.md')]),
    ];
    const offenders: string[] = [];
    const teachingFiles: string[] = [];
    let checked = 0;
    for (const file of new Set(documents.map((call) => call.file))) {
      const calls = documents
        .filter((call) => call.file === file)
        .map((c) => [c, parseCall(c.source)] as const);
      const teachesWork = calls.some(([, parsed]) =>
        ['rbook_sprint', 'rbook_mission', 'rbook_mission_transition'].includes(parsed.tool)
      );
      if (!teachesWork) continue;
      teachingFiles.push(file);
      for (const [call, parsed] of calls) {
        if (
          parsed.tool !== 'rbook_project' ||
          literalString(parsed.args.get('action')) !== 'init'
        ) {
          continue;
        }
        checked += 1;
        const level = literalString(parsed.args.get('projectType'));
        if (level !== 'build' && level !== 'managed') {
          offenders.push(`${file}:${call.line} inits ${level ?? 'with no level (a Ledger)'}`);
        }
      }
    }
    // The CLI's init too (the second confirming critic): an init line in a fence or an inline code
    // span of such a document names a level that keeps sprints or missions. s99-m02: the command is
    // reasonbook, cmos-mcp (its former name) or @aquex/reasonbook@<version> run through npx, npm exec
    // or npm x with any flags.
    for (const file of teachingFiles) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
      let fence: string | null = null;
      lines.forEach((line, index) => {
        const marker = /^\s*(```|~~~)/.exec(line)?.[1];
        if (marker && (fence === null || fence === marker)) {
          fence = fence === null ? marker : null;
          return;
        }
        const fenced = fence !== null;
        const commands = fenced ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((span) => span[1]);
        for (const command of commands.filter((text) =>
          /(?:\bcmos-mcp|\breasonbook|\b(?:npx|npm\s+(?:exec|x))(?:\s+-{1,2}[\w-]+)*\s+@aquex\/reasonbook@\S+(?:\s+--)?) init\b/.test(
            text
          )
        )) {
          checked += 1;
          if (!/--level(?:\s+|=)\S*\b(builder|planner)\b/.test(command)) {
            offenders.push(`${file}:${index + 1} runs init with no level that keeps them`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it.each(CALLS.map((call) => [`${call.file}:${call.line} ${call.source}`, call] as const))(
    '%s',
    async (_, call) => {
      const parsed = parseCall(call.source);
      const args = callArguments(parsed, fixture);
      const scope = SCOPES.get(call.file)!;
      const copy = path.join(mkTmp('rbook-seed-calls-run-'), 'project');
      fs.cpSync(fixture.root, copy, { recursive: true });
      freshConfig();

      // A record named by a literal id must be one the document creates: an agent following it
      // has nothing else. Its creating call is replayed on the copy first (sprints before
      // missions); one an init example creates stands as the fixture's record of that id.
      const named = namedRecords(parsed);
      const missing = named.filter((key) => !scope.creates.has(key));
      if (missing.length > 0) {
        throw new Error(`names ${missing.join(', ')}, which ${call.file} never creates`);
      }
      const creators = named
        .map((key) => scope.creates.get(key))
        .filter((creator): creator is ParsedCall => !!creator && creator.source !== parsed.source);
      for (const creator of creators.flatMap((c) => [
        ...namedRecords(c)
          .filter((key) => key.startsWith('sprint:'))
          .map((key) => scope.creates.get(key))
          .filter((sprint): sprint is ParsedCall => !!sprint && sprint.source !== c.source),
        c,
      ])) {
        await setUp(creator.tool, callArguments(creator, fixture), copy);
      }

      // State the example presupposes, only when the same document teaches the step that makes it.
      const precondition = PRECONDITIONS[`${parsed.tool}.${String(args.action)}`];
      if (precondition && precondition.taughtBy.some((taught) => scope.taught.has(taught))) {
        await precondition.setUp(args, copy);
      }

      // An agent standing in the project resolves it; init alone never infers its folder.
      const isInit = parsed.tool === 'rbook_project' && args.action === 'init';
      const ran = await dispatch(
        parsed.tool,
        isInit || 'projectRoot' in args ? args : { ...args, projectRoot: copy }
      );
      if (ran.isError) throw new Error(`refused: ${ran.text}`);
    },
    // s98-m08: a hang guard, not a speed budget. Under two concurrent full suites the first
    // rbook_review case, which loads the review's modules cold, ran past 60 s.
    180_000
  );
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — the hook CLI's contract, driven in process through runCli: the SessionStart output, the
// ABOUTME: harness link and /clear, server ownership per write, the off switch, the init offer, fail-open.

/**
 * What a harness does, simulated: a hook process gets the harness session id on stdin and
 * CLAUDE_PID in its environment. The MCP server finds the link through its parent pid
 * (setParentPidForTesting stands in for process.ppid) or, when a launcher sits between it and the
 * harness, through the session id it started with (CLAUDE_CODE_SESSION_ID). Only the locked-store
 * case spawns a process, to hold the lock; tests/e2e/hook-cli.e2e.ts drives the packed bin.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import * as digestModule from '../../src/cli/digest';
import { initOffer } from '../../src/cli/session-start';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  harnessLinkEnded,
  harnessLinkPath,
  harnessSessionHash,
  readHarnessLink,
  setAncestorsForTesting,
  setParentPidForTesting,
} from '../../src/tools/rbook/harness-session';
import { closeOwnImplicitSessions } from '../../src/tools/rbook/implicit-session-lifecycle';
import { currentSessionOwner, setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

// Live pids, as a harness's own pid is while its session runs (session start prunes dead ones).
const HARNESS_PID = process.pid;
const OTHER_HARNESS_PID = process.ppid;

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
// This suite may itself run under Claude Code, whose session id would be this "server's" start id.
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m01-hooks-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'hook cli' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setParentPidForTesting(null);
  setAncestorsForTesting(null);
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

/** Run a command line with a stub io: this stdin, this environment, this working directory. */
async function run(
  argv: string[],
  options: {
    stdin?: unknown;
    env?: Record<string, string>;
    cwd?: string;
    startedAtMs?: number;
  } = {}
): Promise<Ran> {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: { ...process.env, ...(options.env ?? {}) },
    cwd: options.cwd ?? projectRoot,
    // s98-m08: room load cannot spend (#1558): under two concurrent full suites a session-end hook
    // ran out of its 1 s before closing its session. A test about the deadline passes its own clock.
    startedAtMs: options.startedAtMs ?? Date.now() + 20_000,
    readStdin: async () =>
      options.stdin === undefined
        ? ''
        : typeof options.stdin === 'string'
          ? options.stdin
          : JSON.stringify(options.stdin),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  const code = await runCli(argv, io);
  // Each CLI call is its own process in production; its harness owner does not outlive it.
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}

const hook = (
  event: string,
  stdin: unknown,
  env: Record<string, string> = {},
  startedAtMs?: number
) => run(['hook', event], { stdin, env: { CLAUDE_PID: String(HARNESS_PID), ...env }, startedAtMs });

function rows<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** A capture through the MCP dispatch, as the harness's server makes it. */
async function serverCapture(content: string): Promise<void> {
  const captured = await executeMissionProtocolTool(
    'rbook_session',
    { action: 'capture', category: 'context', content, projectRoot },
    context
  );
  expect(captured.isError).not.toBe(true);
}

const capturesOf = (id: string) =>
  rows<{ captures: string }>('SELECT captures FROM sessions WHERE id = ?', id)[0].captures;

const failOpenLog = (): string => {
  const file = path.join(process.env.RBOOK_CONFIG_DIR!, 'runtime', 'fail-open.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

const sessionsOwnedBy = (key: string) =>
  rows<{ id: string; status: string; implicit: number }>(
    'SELECT id, status, implicit FROM sessions WHERE owner_key = ? ORDER BY julianday(started_at)',
    key
  );

describe('s93-m01 — hook session-start', () => {
  it('prints Claude Code SessionStart JSON with the digest, under its cap, and nothing else', async () => {
    const ran = await hook('session-start', { session_id: 'raw-harness-1', source: 'startup' });
    expect(ran.code).toBe(0);
    expect(ran.stderr).toEqual([]);
    const lines = ran.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
    const specific = output.hookSpecificOutput as Record<string, unknown>;
    expect(Object.keys(specific).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(specific.hookEventName).toBe('SessionStart');
    expect(typeof specific.additionalContext).toBe('string');
    expect((specific.additionalContext as string).length).toBeGreaterThan(0);
    expect((specific.additionalContext as string).length).toBeLessThanOrEqual(6000);
  });

  it('links the harness process to the hashed session, opens no session, and stores no raw id', async () => {
    await hook('session-start', { session_id: 'raw-harness-1', source: 'startup' });
    const hash = harnessSessionHash('raw-harness-1');
    // A startup begins the harness process's list of sessions, and the link names the folder.
    expect(readHarnessLink(HARNESS_PID)).toMatchObject({
      hash,
      seen: [hash],
      projectDir: projectRoot,
      source: 'startup',
    });
    // A conversation that never writes leaves nothing in the record (the m01 build critic).
    expect(sessionsOwnedBy(`ext:${hash}`)).toEqual([]);

    setParentPidForTesting(HARNESS_PID);
    await serverCapture('The first write opens it.');
    expect(sessionsOwnedBy(`ext:${hash}`)).toEqual([
      { id: expect.any(String), status: 'active', implicit: 1 },
    ]);

    // No raw harness id anywhere in the store or its journal.
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (fs.existsSync(file)) expect(fs.readFileSync(file).includes('raw-harness-1')).toBe(false);
    }
    expect(fs.readFileSync(harnessLinkPath(HARNESS_PID), 'utf8')).not.toContain('raw-harness-1');
  });

  it('a /clear rewrites the link, keeps the sessions it has had, and the server writes into the new one', async () => {
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-before-clear', source: 'startup' });
    const before = currentSessionOwner().key;
    expect(before).toBe(`ext:${harnessSessionHash('raw-before-clear')}`);
    await serverCapture('Before clear.');

    await hook('session-end', { session_id: 'raw-before-clear', reason: 'clear' });
    await hook('session-start', { session_id: 'raw-after-clear', source: 'clear' });
    expect(readHarnessLink(HARNESS_PID)?.seen).toEqual([
      harnessSessionHash('raw-before-clear'),
      harnessSessionHash('raw-after-clear'),
    ]);
    const after = currentSessionOwner().key;
    expect(after).toBe(`ext:${harnessSessionHash('raw-after-clear')}`);

    await serverCapture('After clear.');
    const [afterSession] = sessionsOwnedBy(after);
    expect(afterSession.status).toBe('active');
    const [beforeSession] = sessionsOwnedBy(before);
    expect(beforeSession.status).toBe('completed');
    expect(capturesOf(afterSession.id)).toContain('After clear.');
    expect(capturesOf(beforeSession.id)).not.toContain('After clear.');
  });

  // The m01 build critic, B1 scenario B: an explicit session belongs to the conversation that
  // started it, so `/clear` closes it with the rest of that conversation's sessions.
  it("a /clear closes the old conversation's explicit session; the new one starts and closes its own", async () => {
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-explicit-1', source: 'startup' });
    const started = await executeMissionProtocolTool(
      'rbook_session',
      { action: 'start', type: 'planning', title: 'Before clear', projectRoot },
      context
    );
    expect(started.isError).not.toBe(true);
    const keyBefore = `ext:${harnessSessionHash('raw-explicit-1')}`;
    expect(sessionsOwnedBy(keyBefore)).toEqual([
      { id: expect.any(String), status: 'active', implicit: 0 },
    ]);

    await hook('session-end', { session_id: 'raw-explicit-1', reason: 'clear' });
    await hook('session-start', { session_id: 'raw-explicit-2', source: 'clear' });
    expect(sessionsOwnedBy(keyBefore)[0].status).toBe('completed');

    // The new conversation is not blocked, and its writes and close are its own.
    const keyAfter = `ext:${harnessSessionHash('raw-explicit-2')}`;
    const startedAgain = await executeMissionProtocolTool(
      'rbook_session',
      { action: 'start', type: 'planning', title: 'After clear', projectRoot },
      context
    );
    expect(startedAgain.isError).not.toBe(true);
    await serverCapture('Into the new explicit session.');
    const [own] = sessionsOwnedBy(keyAfter);
    expect(own).toMatchObject({ status: 'active', implicit: 0 });
    expect(capturesOf(own.id)).toContain('Into the new explicit session.');
    const completed = await executeMissionProtocolTool(
      'rbook_session',
      { action: 'complete', summary: 'Done after clear.', projectRoot },
      context
    );
    expect(completed.isError).not.toBe(true);
    expect(sessionsOwnedBy(keyAfter)[0].status).toBe('completed');
  });
});

// The m01 build critic, B2: `npx @aquex/reasonbook` and a Windows .cmd shim put a launcher between the
// harness and its server, so the server's parent has no link. Its environment still carries the
// session id the harness started with, which the link records as its origin.
describe("s93-m01 — a server that is not the harness's direct child", () => {
  it('finds the link by the id it started with, before and after a /clear', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-npx-start';
    setParentPidForTesting(OTHER_HARNESS_PID); // the launcher: a live process with no link
    await hook('session-start', { session_id: 'raw-npx-start', source: 'startup' });
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-npx-start')}`);
    await serverCapture('Through a launcher.');
    expect(sessionsOwnedBy(`ext:${harnessSessionHash('raw-npx-start')}`)).toHaveLength(1);

    await hook('session-end', { session_id: 'raw-npx-start', reason: 'clear' });
    await hook('session-start', { session_id: 'raw-npx-after', source: 'clear' });
    // The server's variable still says the start id; the carried origin finds the new session.
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-npx-after')}`);
  });

  // The m01 confirming critic, NB1 (a): Claude Code spawns a server with the session id current at
  // the time, so a server respawned after a /clear (a crash, a reconnect) carries the new id.
  it('a server respawned after a /clear finds the link by the id it was spawned with', async () => {
    setParentPidForTesting(OTHER_HARNESS_PID); // the launcher: a live process with no link
    await hook('session-start', { session_id: 'raw-respawn-1', source: 'startup' });
    await hook('session-end', { session_id: 'raw-respawn-1', reason: 'clear' });
    await hook('session-start', { session_id: 'raw-respawn-2', source: 'clear' });
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-respawn-2';
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-respawn-2')}`);
  });

  // NB1 (b): `claude --resume R` in a new process while the harness that started with R is alive.
  // Both links have seen R; the one whose harness is this server's ancestor wins, and with neither,
  // the server keeps its pid key rather than guess.
  it('when two live harnesses have seen its id, the ancestor harness wins, and with neither, none', async () => {
    const first = HARNESS_PID;
    const second = OTHER_HARNESS_PID;
    await hook('session-start', { session_id: 'raw-shared', source: 'startup' });
    await hook('session-start', { session_id: 'raw-first-later', source: 'clear' });
    await run(['hook', 'session-start'], {
      stdin: { session_id: 'raw-shared', source: 'resume' },
      env: { CLAUDE_PID: String(second) },
    });
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-shared';
    const launcher = spawnSync(process.execPath, ['-e', '0']).pid!; // no link of its own
    setParentPidForTesting(launcher);

    setAncestorsForTesting([launcher, second]);
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-shared')}`);
    setAncestorsForTesting([launcher, first]);
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-first-later')}`);
    // Both are ancestors when one harness runs inside the other: the nearest is this server's.
    setAncestorsForTesting([launcher, second, first]);
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-shared')}`);
    setAncestorsForTesting([launcher, first, second]);
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-first-later')}`);
    setAncestorsForTesting([launcher]);
    expect(currentSessionOwner().kind).toBe('process');
  });

  // The m01 second confirming critic: an in-process /resume ends a session and may start it again.
  it('re-entering a session that ended in the same harness writes into it again', async () => {
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-reentry', source: 'startup' });
    await hook('session-end', { session_id: 'raw-reentry', reason: 'resume' });
    expect(currentSessionOwner().kind).toBe('process');
    await hook('session-start', { session_id: 'raw-reentry', source: 'resume' });
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-reentry')}`);
  });

  it("a long history keeps the harness's first session, which a startup-spawned server carries", async () => {
    await hook('session-start', { session_id: 'raw-long-0', source: 'startup' });
    for (let n = 1; n <= 70; n += 1) {
      await hook('session-start', { session_id: `raw-long-${n}`, source: 'clear' });
    }
    const seen = readHarnessLink(HARNESS_PID)!.seen;
    expect(seen).toHaveLength(64);
    expect(seen[0]).toBe(harnessSessionHash('raw-long-0'));
    expect(seen[seen.length - 1]).toBe(harnessSessionHash('raw-long-70'));
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-long-0';
    setParentPidForTesting(OTHER_HARNESS_PID); // through a launcher
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-long-70')}`);
  });

  // The m01 confirming critic, k: a launcher that reused a crashed harness's pid finds that harness's
  // link, which never saw its id and was written long before it started.
  it("ignores a parent's old link that has not seen its id", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-mine';
    const launcherLink = harnessLinkPath(OTHER_HARNESS_PID);
    fs.mkdirSync(path.dirname(launcherLink), { recursive: true });
    fs.writeFileSync(
      launcherLink,
      JSON.stringify({
        hash: harnessSessionHash('raw-stale'),
        seen: [harnessSessionHash('raw-stale')],
        projectDir: projectRoot,
        source: 'startup',
        writtenAt: '',
      })
    );
    const anHourAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(launcherLink, anHourAgo, anHourAgo);
    setParentPidForTesting(OTHER_HARNESS_PID);
    expect(currentSessionOwner().kind).toBe('process');
    // A server with no id of its own does not adopt it either.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(currentSessionOwner().kind).toBe('process');

    // Written shortly before this server started: a server with an id rejects a link that has
    // not seen it, while one with no id allows the minute a hook and its server can differ by.
    const justBefore = new Date(performance.timeOrigin - 30_000);
    fs.utimesSync(launcherLink, justBefore, justBefore);
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-mine';
    expect(currentSessionOwner().kind).toBe('process');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-stale')}`);
  });

  it('a startup begins a new list of sessions, even over a link left under the same pid', async () => {
    await hook('session-start', { session_id: 'raw-old-process', source: 'startup' });
    await hook('session-start', { session_id: 'raw-new-process', source: 'startup' });
    expect(readHarnessLink(HARNESS_PID)?.seen).toEqual([harnessSessionHash('raw-new-process')]);
  });

  it("trusts its parent's link when no link carries its start id (hooks installed mid-conversation)", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'raw-before-install';
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-first-hooked', source: 'clear' });
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-first-hooked')}`);
  });

  it('after SessionEnd, the server writes under its own pid key until the next SessionStart', async () => {
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-ending', source: 'startup' });
    await hook('session-end', { session_id: 'raw-ending', reason: 'other' });
    expect(harnessLinkEnded(HARNESS_PID, readHarnessLink(HARNESS_PID)!)).toBe(true);
    expect(currentSessionOwner().kind).toBe('process');
    await hook('session-start', { session_id: 'raw-next', source: 'clear' });
    expect(currentSessionOwner().key).toBe(`ext:${harnessSessionHash('raw-next')}`);
  });
});

// The m01 confirming critic, NB2: SessionEnd closes the conversation's sessions in its own store
// only, so the conversation's key applies only there. Another project gets the pid key, as in 3.2.0.
describe("s93-m01 — the harness key applies only in the conversation's own store", () => {
  // The second confirming critic: on macOS one folder can be spelled in two letter cases.
  it('the same folder spelled in another letter case is the same store, where the filesystem says so', async () => {
    setParentPidForTesting(HARNESS_PID);
    const variant = projectRoot.replace(/project$/, 'PROJECT');
    const caseInsensitive = fs.existsSync(variant);
    await run(['hook', 'session-start'], {
      stdin: { session_id: 'raw-case', source: 'startup', cwd: variant },
      cwd: variant,
      env: { CLAUDE_PID: String(HARNESS_PID), CLAUDE_PROJECT_DIR: variant },
    });
    const owner = currentSessionOwner(dbPath);
    if (caseInsensitive) expect(owner.key).toBe(`ext:${harnessSessionHash('raw-case')}`);
    else expect(owner.kind).toBe('process');
  });

  it('a linked server writes into another project as itself, and session end leaves that alone', async () => {
    const otherRoot = path.join(tmp, 'other-project');
    fs.mkdirSync(otherRoot, { recursive: true });
    const otherDb = seedRbookDb(otherRoot, { projectName: 'other project' });
    reidentifyRbookTestStore(otherRoot);
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-scoped', source: 'startup' });
    const key = `ext:${harnessSessionHash('raw-scoped')}`;

    expect(currentSessionOwner(dbPath).key).toBe(key);
    expect(currentSessionOwner(otherDb).kind).toBe('process');
    const elsewhere = await executeMissionProtocolTool(
      'rbook_session',
      {
        action: 'capture',
        category: 'context',
        content: 'In the other project.',
        projectRoot: otherRoot,
      },
      context
    );
    expect(elsewhere.isError).not.toBe(true);
    await serverCapture('In its own project.');

    const other = new Database(otherDb, { readonly: true });
    try {
      expect(other.prepare("SELECT owner_key FROM sessions WHERE status = 'active'").all()).toEqual(
        [{ owner_key: expect.stringMatching(/^pid:/) }]
      );
    } finally {
      other.close();
    }
    expect(sessionsOwnedBy(key)).toEqual([
      { id: expect.any(String), status: 'active', implicit: 1 },
    ]);
    await hook('session-end', { session_id: 'raw-scoped', reason: 'other' });
    expect(sessionsOwnedBy(key)[0].status).toBe('completed');
  });
});

describe('s93-m01 — a crashed harness leaves no link to inherit', () => {
  it("session start removes the link of a harness whose process is gone, and keeps a live one's", async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const deadLink = harnessLinkPath(dead);
    fs.mkdirSync(path.dirname(deadLink), { recursive: true });
    fs.writeFileSync(
      deadLink,
      JSON.stringify({ hash: harnessSessionHash('crashed'), source: null, writtenAt: '' })
    );
    const liveLink = harnessLinkPath(OTHER_HARNESS_PID);
    fs.writeFileSync(
      liveLink,
      JSON.stringify({ hash: harnessSessionHash('alive'), source: null, writtenAt: '' })
    );

    await hook('session-start', { session_id: 'raw-pruner', source: 'startup' });
    expect(fs.existsSync(deadLink)).toBe(false);
    expect(readHarnessLink(OTHER_HARNESS_PID)?.hash).toBe(harnessSessionHash('alive'));
    expect(readHarnessLink(HARNESS_PID)?.hash).toBe(harnessSessionHash('raw-pruner'));
  });
});

describe('s93-m01 — the server writes into the harness session (decision #1189)', () => {
  it('every server process under the harness writes into the one session, and none closes it at exit', async () => {
    await hook('session-start', { session_id: 'raw-harness-2', source: 'startup' });
    const key = `ext:${harnessSessionHash('raw-harness-2')}`;
    setParentPidForTesting(HARNESS_PID);

    for (const content of ['First server.', 'After a restart.']) {
      const captured = await executeMissionProtocolTool(
        'rbook_session',
        { action: 'capture', category: 'context', content, projectRoot },
        context
      );
      expect(captured.isError).not.toBe(true);
    }
    const owned = sessionsOwnedBy(key);
    expect(owned).toHaveLength(1);
    const captures = rows<{ captures: string }>(
      'SELECT captures FROM sessions WHERE id = ?',
      owned[0].id
    )[0].captures;
    expect(captures).toContain('First server.');
    expect(captures).toContain('After a restart.');

    // Server exit (stdin end, SIGINT, SIGTERM) closes only pid-keyed sessions (mechanism critic B2).
    await closeOwnImplicitSessions();
    expect(sessionsOwnedBy(key)[0].status).toBe('active');
  });

  it('two harness sessions in one repo, one with an explicit session, each write into their own', async () => {
    await hook('session-start', { session_id: 'raw-harness-a', source: 'startup' });
    await run(['hook', 'session-start'], {
      stdin: { session_id: 'raw-harness-b', source: 'startup' },
      env: { CLAUDE_PID: String(OTHER_HARNESS_PID) },
    });
    const keyA = `ext:${harnessSessionHash('raw-harness-a')}`;
    const keyB = `ext:${harnessSessionHash('raw-harness-b')}`;

    // Harness A starts an explicit session; it carries A's key.
    setParentPidForTesting(HARNESS_PID);
    const started = await executeMissionProtocolTool(
      'rbook_session',
      { action: 'start', type: 'research', title: 'A explicit', projectRoot },
      context
    );
    expect(started.isError).not.toBe(true);
    const explicitA = rows<{ id: string; owner_key: string }>(
      'SELECT id, owner_key FROM sessions WHERE implicit = 0 AND status = ?',
      'active'
    );
    expect(explicitA).toEqual([{ id: expect.any(String), owner_key: keyA }]);

    const write = async (pid: number, content: string) => {
      setParentPidForTesting(pid);
      const captured = await executeMissionProtocolTool(
        'rbook_session',
        { action: 'capture', category: 'context', content, projectRoot },
        context
      );
      expect(captured.isError).not.toBe(true);
    };
    await write(HARNESS_PID, 'From A.');
    await write(OTHER_HARNESS_PID, 'From B.');

    const capturesOf = (id: string) =>
      rows<{ captures: string }>('SELECT captures FROM sessions WHERE id = ?', id)[0].captures;
    expect(capturesOf(explicitA[0].id)).toContain('From A.');
    expect(capturesOf(explicitA[0].id)).not.toContain('From B.');
    const [implicitB] = sessionsOwnedBy(keyB);
    expect(capturesOf(implicitB.id)).toContain('From B.');
  });
});

describe('s93-m01 — hook session-end', () => {
  it('closes the harness session, marks the link ended, and is a no-op the second time', async () => {
    setParentPidForTesting(HARNESS_PID);
    await hook('session-start', { session_id: 'raw-harness-3', source: 'startup' });
    await serverCapture('Before the end.');
    const key = `ext:${harnessSessionHash('raw-harness-3')}`;

    const ended = await hook('session-end', { session_id: 'raw-harness-3', reason: 'other' });
    expect(ended).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(sessionsOwnedBy(key)[0].status).toBe('completed');
    expect(harnessLinkEnded(HARNESS_PID, readHarnessLink(HARNESS_PID)!)).toBe(true);
    const summary = rows<{ summary: string }>(
      'SELECT summary FROM sessions WHERE owner_key = ?',
      key
    )[0].summary;
    expect(summary).toContain('its harness session ended');

    expect(await hook('session-end', { session_id: 'raw-harness-3' })).toEqual({
      code: 0,
      stdout: '',
      stderr: [],
    });
  });

  it("an old session's end never touches the link the next session wrote", async () => {
    await hook('session-start', { session_id: 'raw-old', source: 'startup' });
    await hook('session-start', { session_id: 'raw-new', source: 'clear' });
    await hook('session-end', { session_id: 'raw-old', reason: 'clear' });
    const link = readHarnessLink(HARNESS_PID)!;
    expect(link.hash).toBe(harnessSessionHash('raw-new'));
    expect(harnessLinkEnded(HARNESS_PID, link)).toBe(false);
  });

  // The m01 build critic, B3: a second checkout of a registered project (a worktree or a clone with
  // the same project id). An automatic close registers nothing, so no collision line, and the
  // harness session still closes.
  it('in a second checkout of a registered project, closes the session and prints nothing', async () => {
    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(projectRoot, { name: 'hook cli' });
    const checkout = path.join(tmp, 'second-checkout');
    fs.cpSync(projectRoot, checkout, { recursive: true });
    const inCheckout = (argv: string[], stdin?: unknown) =>
      run(argv, { stdin, cwd: checkout, env: { CLAUDE_PID: String(HARNESS_PID) } });

    const ensured = await inCheckout([
      'session',
      'ensure',
      '--session-id',
      'raw-checkout',
      '--project-root',
      checkout,
    ]);
    expect(ensured.code).toBe(0);
    const ended = await inCheckout(['hook', 'session-end', '--project-root', checkout], {
      session_id: 'raw-checkout',
      reason: 'other',
    });
    expect(ended).toEqual({ code: 0, stdout: '', stderr: [] });
    const db = new Database(path.join(checkout, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
    try {
      expect(
        db
          .prepare('SELECT status FROM sessions WHERE owner_key = ?')
          .all(`ext:${harnessSessionHash('raw-checkout')}`)
      ).toEqual([{ status: 'completed' }]);
    } finally {
      db.close();
    }
  });
});

describe('s93-m01 — the off switch (#1183)', () => {
  it('ambient off silences every hook verb, and opens and links nothing', async () => {
    expect((await run(['ambient', 'off'])).code).toBe(0);
    for (const event of ['session-start', 'prompt', 'stop', 'pre-compact', 'session-end']) {
      const ran = await hook(event, { session_id: 'raw-silent', source: 'startup', prompt: 'hi' });
      expect(ran).toEqual({ code: 0, stdout: '', stderr: [] });
    }
    expect(readHarnessLink(HARNESS_PID)).toBeNull();
    expect(sessionsOwnedBy(`ext:${harnessSessionHash('raw-silent')}`)).toEqual([]);
  });

  it('RBOOK_AMBIENT=off silences one session without touching the setting', async () => {
    const ran = await hook(
      'session-start',
      { session_id: 'raw-env-off', source: 'startup' },
      { RBOOK_AMBIENT: 'off' }
    );
    expect(ran).toEqual({ code: 0, stdout: '', stderr: [] });
    expect((await run(['ambient'])).stdout.trim()).toBe('on');
  });

  it('digest-off keeps the link but injects no digest', async () => {
    await run(['ambient', 'digest-off']);
    const ran = await hook('session-start', { session_id: 'raw-no-digest', source: 'startup' });
    expect(ran).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(readHarnessLink(HARNESS_PID)?.hash).toBe(harnessSessionHash('raw-no-digest'));
  });
});

describe('s93-m01 — the init offer', () => {
  function folder(name: string, git: boolean): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(git ? path.join(dir, '.git') : dir, { recursive: true });
    return dir;
  }
  const startIn = (cwd: string) =>
    run(['hook', 'session-start'], {
      stdin: { session_id: 'raw-offer', source: 'startup', cwd },
      cwd,
      env: { CLAUDE_PID: String(HARNESS_PID), CLAUDE_PROJECT_DIR: '' },
    });

  it('a git repository with no store gets one line, and never again after a decline', async () => {
    const repo = folder('plain-repo', true);
    const first = await startIn(repo);
    expect(first.code).toBe(0);
    const context = (
      JSON.parse(first.stdout) as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext;
    expect(context).toBe(
      initOffer(undefined, false, { projectRoot: repo, resolvedBy: 'explicit' })
    );
    expect(context.includes('\n')).toBe(false);
    // The remedy names the command that ran this hook, so it works without a global install.
    expect(context).toContain(`ambient off --project-root '${repo}'`);
    expect(context).toMatch(/` \(POSIX shell\) here/);

    expect(
      (await run(['ambient', 'off'], { cwd: repo, env: { CLAUDE_PROJECT_DIR: '' } })).code
    ).toBe(0);
    expect(await startIn(repo)).toEqual({ code: 0, stdout: '', stderr: [] });
    // A subfolder of the declined repository is the same repository.
    const sub = path.join(repo, 'src');
    fs.mkdirSync(sub);
    expect(await startIn(sub)).toEqual({ code: 0, stdout: '', stderr: [] });
  });

  it('a folder outside any git work tree, and a contextless one, are silent', async () => {
    expect(await startIn(folder('not-a-repo', false))).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(await startIn(os.homedir())).toEqual({ code: 0, stdout: '', stderr: [] });
  });
});

describe('s93-m01 — failing open', () => {
  it('bad JSON on stdin: exit 0, one stderr line, no stdout', async () => {
    for (const stdin of ['{not json', '[1,2]', '"text"']) {
      const ran = await hook('session-start', stdin);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toHaveLength(1);
    }
  });

  it('a project root with no store: exit 0, one stderr line, and a fail-open record', async () => {
    const ran = await run(['hook', 'session-start', '--project-root', path.join(tmp, 'nowhere')], {
      stdin: { session_id: 'raw-missing' },
      env: { CLAUDE_PID: String(HARNESS_PID) },
    });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toHaveLength(1);
    expect(failOpenLog()).toContain('"cause":"store"');
  });

  // The m01 build critic, B3: the MCP path refuses a store whose database is gone by name. The
  // hook says so too, and never offers init, which would create an empty store in its place.
  it('a Reasonbook folder whose database is gone: one stderr line, a fail-open record, no init offer', async () => {
    const repo = path.join(tmp, 'lost-store');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'rbook', 'db'), { recursive: true });
    const ran = await run(['hook', 'session-start'], {
      stdin: { session_id: 'raw-lost', source: 'startup', cwd: repo },
      cwd: repo,
      env: { CLAUDE_PID: String(HARNESS_PID), CLAUDE_PROJECT_DIR: '' },
    });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toHaveLength(1);
    expect(ran.stderr[0]).toContain('missing');
    expect(failOpenLog()).toContain('"cause":"store"');
  });

  it('stray stderr writes while a hook runs are held to its one line', async () => {
    const stderr: string[] = [];
    const code = await runCli(['hook', 'stop'], {
      env: { ...process.env, CLAUDE_PID: String(HARNESS_PID) },
      cwd: projectRoot,
      // s98-m08 (#735): room load cannot spend, as #1558 gave the draft tests. Under load the stop
      // hook's 500 ms ran out before the library's line was held, and its deadline line came instead.
      // This test checks the one line; hook-deadline.test.ts and the next test check the deadline.
      startedAtMs: Date.now() + 20_000,
      readStdin: async () => {
        process.stderr.write('a library log line\n');
        process.stderr.write('and another\n');
        return '{}';
      },
      stdout: () => undefined,
      stderr: (line) => {
        stderr.push(line);
      },
    });
    expect(code).toBe(0);
    expect(stderr).toEqual(['reasonbook hook stop: a library log line']);
  });

  it('the deadline counts from process start, so module loading is inside the budget', async () => {
    const code = await runCli(['hook', 'prompt'], {
      env: { ...process.env, CLAUDE_PID: String(HARNESS_PID) },
      cwd: projectRoot,
      // A process that started 790 ms ago has 10 ms of its 800 ms left.
      startedAtMs: Date.now() - 790,
      readStdin: () => new Promise<string>((resolve) => setTimeout(() => resolve('{}'), 100)),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(failOpenLog()).toContain('"cause":"deadline"');
  });

  it('a stdin that never ends: the prompt verb gives up at its deadline, prints nothing, and records it', async () => {
    let stdout = '';
    const stderr: string[] = [];
    const started = Date.now();
    const code = await runCli(['hook', 'prompt'], {
      env: { ...process.env, CLAUDE_PID: String(HARNESS_PID) },
      cwd: projectRoot,
      readStdin: () => new Promise<string>(() => undefined),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (line) => {
        stderr.push(line);
      },
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stdout).toBe('');
    expect(stderr).toEqual([]);
    const log = fs.readFileSync(
      path.join(process.env.RBOOK_CONFIG_DIR!, 'runtime', 'fail-open.jsonl'),
      'utf8'
    );
    expect(log).toContain('"verb":"hook prompt"');
    expect(log).toContain('"cause":"deadline"');
  });

  it('a store locked by another writer: exit 0 within the deadline, and stdout is whole JSON or nothing', async () => {
    const holder = new Database(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const started = Date.now();
      // This test is about the deadline, so its clock starts at the call, without the room.
      const ran = await hook(
        'session-start',
        { session_id: 'raw-locked', source: 'startup' },
        {},
        started
      );
      expect(ran.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(ran.stderr.length).toBeLessThanOrEqual(1);
      if (ran.stdout !== '') expect(() => JSON.parse(ran.stdout)).not.toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 15_000);

  // The m01 build critic, B3: a holder in exclusive locking mode blocks readers too. Session start
  // gives up after one short wait, says so on one line and records it, instead of 2 s of silence.
  it('a store another process holds exclusively: one stderr line, a fail-open record, fast', async () => {
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
         const db = new D(${JSON.stringify(dbPath)});
         db.pragma('locking_mode = EXCLUSIVE');
         db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_probe (x); COMMIT');
         process.stdout.write('held\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.once('data', () => resolve());
        holder.once('exit', (code) => reject(new Error(`holder exited ${code}`)));
      });
      const digest = jest.spyOn(digestModule, 'buildDigest');
      const started = Date.now();
      // This test is about the deadline, so its clock starts at the call, without the room.
      const ran = await hook(
        'session-start',
        { session_id: 'raw-held', source: 'startup' },
        {},
        started
      );
      expect(ran.code).toBe(0);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toHaveLength(1);
      expect(ran.stderr[0]).toContain('locked');
      expect(failOpenLog()).toContain('"cause":"store"');
      // Within the hook's own deadline, however loaded the machine. That the store check, not the
      // review, met the lock is shown below without a clock: the digest was never attempted.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      holder.kill();
      jest.restoreAllMocks();
    }
  }, 15_000);

  it('stop never writes stdout, whatever it is given', async () => {
    for (const stdin of [{}, { session_id: 'x', last_assistant_message: 'Would record: y' }, '']) {
      const ran = await hook('stop', stdin);
      expect(ran.stdout).toBe('');
      expect(ran.code).toBe(0);
    }
  });
});

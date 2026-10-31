// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s107-m05's session-read fixture: one stored session with chosen captures, local or foreign, read through the dispatcher.
// ABOUTME: Shared by the paging test and the one-page golden, so both read the same fixture the same way.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { seedRbookDb } from './seedRbookDb';

/** A session id that a hand-quoted hint would end at its own quote (s106-m03). */
export const SESSION = 'PS-"1`x';

export interface StoredCapture {
  readonly category: string;
  readonly content: string;
  readonly timestamp: string;
  readonly context?: string;
  readonly missionId?: string;
}

export interface SessionStore {
  readonly root: string;
  readonly dbPath: string;
  /** Times the fixture stamped, in the order they appear, for a golden's placeholders. */
  readonly times: readonly string[];
  readonly cleanup: () => void;
}

/**
 * A seeded store holding one completed session. `foreignProject` stamps the session with another
 * project's id, so its text is framed as untrusted; `rootLength` makes the project root exactly
 * that many characters long.
 */
export function sessionStore(options: {
  readonly summary: string | null;
  readonly captures: readonly StoredCapture[];
  readonly foreignProject?: string;
  readonly rootLength?: number;
  /** An active session, as captures land in one: no summary and no completion time yet. */
  readonly active?: boolean;
  /** Stored entries after the captures that are not readable captures (s107-m05 critic). */
  readonly malformed?: readonly unknown[];
  /** The session's agent, which no schema bounds (s107-m05 critic). */
  readonly agent?: string;
}): SessionStore {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-session-pages-')));
  // In names a filesystem accepts (255 bytes each), to exactly rootLength characters.
  let root = parent;
  while (options.rootLength && root.length < options.rootLength - 1)
    root = path.join(root, 'r'.repeat(Math.min(200, options.rootLength - root.length - 1)));
  fs.mkdirSync(root, { recursive: true });
  const dbPath = seedRbookDb(root, { projectName: 'Session pages' });
  const started = new Date(Date.now() - 3_600_000).toISOString();
  const completed = new Date(Date.now() - 60_000).toISOString();
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO sessions (id, type, title, started_at, completed_at, status, summary, captures, project_id, agent)
       VALUES (?, 'research', 'Pages', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      SESSION,
      started,
      options.active ? null : completed,
      options.active ? 'active' : 'completed',
      options.active ? null : options.summary,
      JSON.stringify([...options.captures, ...(options.malformed ?? [])]),
      options.foreignProject ?? null,
      options.agent ?? null
    );
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
  return {
    root,
    dbPath,
    times: [started, completed, ...options.captures.map((capture) => capture.timestamp)],
    cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
  };
}

/** Completes the session as rbook_session complete does: status, completion time and summary together. */
export function completeSession(dbPath: string, summary: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      "UPDATE sessions SET status = 'completed', completed_at = ?, summary = ? WHERE id = ?"
    ).run(new Date().toISOString(), summary, SESSION);
  } finally {
    db.close();
  }
}

/** Appends a capture as rbook_session capture does: to the end of the stored list. */
export function appendCapture(dbPath: string, capture: StoredCapture): void {
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT captures FROM sessions WHERE id = ?').get(SESSION) as {
      captures: string;
    };
    const captures = JSON.parse(row.captures) as StoredCapture[];
    db.prepare('UPDATE sessions SET captures = ? WHERE id = ?').run(
      JSON.stringify([...captures, capture]),
      SESSION
    );
  } finally {
    db.close();
  }
}

/**
 * Records another identity for the store, as registration's write of one does in a store that had
 * none (s107-m05 critic, round 2): getProjectId reads it on the next call. Null leaves the store
 * with no recorded identity, so getProjectId falls back to its project name and discloses that.
 */
export function setStoreIdentity(dbPath: string, projectId: string | null): void {
  const db = new Database(dbPath);
  try {
    if (projectId === null)
      db.prepare("DELETE FROM metadata WHERE key IN ('project_id', 'dashboard_slug')").run();
    else
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)").run(
        projectId
      );
  } finally {
    db.close();
  }
}

export type CallResult = Awaited<ReturnType<typeof executeMissionProtocolTool>>;

/** One call through the dispatcher, as an agent's call reaches it. */
export async function dispatch(tool: string, args: Record<string, unknown>): Promise<CallResult> {
  return executeMissionProtocolTool(tool, args, await buildMissionProtocolContext());
}

/** One named session read through the dispatcher. */
export async function readSession(args: Record<string, unknown>): Promise<CallResult> {
  return dispatch('rbook_session', { action: 'list', ...args });
}

/** A whole answer with the run's own root and times replaced, so a golden can hold it. */
export function normalized(result: CallResult, store: SessionStore): string {
  let text = JSON.stringify(result);
  text = text.split(store.root).join('<ROOT>');
  store.times.forEach((time, i) => {
    text = text.split(time).join(`<T${i}>`);
  });
  return text;
}

/** The one-page fixture the c5b8f823 golden was captured from. */
export function onePageStore(): SessionStore {
  const base = Date.now() - 120_000;
  return sessionStore({
    summary: 'A short summary with "quotes", `ticks` and\na newline.',
    captures: [
      {
        category: 'learning',
        content: 'First capture, with "quotes" and an emoji 🧪.',
        timestamp: new Date(base).toISOString(),
        context: 'Why it was kept.',
      },
      {
        category: 'next-step',
        content: 'Second capture\nacross two lines.',
        timestamp: new Date(base + 1_000).toISOString(),
        missionId: 's1-m1',
      },
      {
        category: 'decision',
        content: 'Third capture with a backtick ` inside.',
        timestamp: new Date(base + 2_000).toISOString(),
      },
    ],
  });
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the lines of the agent's last reply that took no effect, or took effect with a note, kept in the
// ABOUTME: draft runtime for the operator's next prompt to name: the agent's own text cut to 80 characters, no operator words.

import type { DraftRuntime } from './draft-runtime';
import { EXCERPT_TTL_MS } from './draft-runtime-excerpts';

/**
 * WHY (the sprint-109 design, settled item 5; local feedback #51). A Would record line past the
 * third, one of an unpublished kind or with too little text, and a Settled line that was refused or
 * written in another form all took no effect, and nothing said so: the agent believed the line had
 * landed. Stop now keeps each one here with its reason, at most {@link UNKEPT_MAX} a reply and the
 * rest counted, replacing the previous reply's entries; the next prompt names them and clears them.
 * They expire with the operator's words, after two hours.
 */
export const UNKEPT_MAX = 5;
export const UNKEPT_TEXT_MAX = 80;

export const UNKEPT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS unkept (session TEXT NOT NULL,
  position INTEGER NOT NULL, text TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (session, position));`;

export interface UnkeptEntry {
  /** The agent's own line, cut to {@link UNKEPT_TEXT_MAX} characters. */
  readonly text: string;
  /** Why it took no effect, or the note on one that did (src/cli/drafts-unkept-notes.ts). */
  readonly reason: string;
  readonly detail: string;
}

export interface UnkeptRead {
  readonly entries: readonly UnkeptEntry[];
  /** Entries past {@link UNKEPT_MAX}, counted only. */
  readonly more: number;
}

const MORE = 'more';

function present(runtime: DraftRuntime): boolean {
  return Boolean(
    runtime.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unkept'").get()
  );
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= UNKEPT_TEXT_MAX ? flat : `${flat.slice(0, UNKEPT_TEXT_MAX - 1)}…`;
}

/** Stop: this reply's entries replace the session's earlier ones, even when there are none. */
export function replaceUnkept(
  runtime: DraftRuntime,
  session: string,
  entries: readonly UnkeptEntry[],
  now: number
): void {
  const insert = runtime.db.prepare(
    'INSERT INTO unkept (session, position, text, reason, detail, at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  runtime.db.transaction(() => {
    runtime.db.exec(UNKEPT_TABLE_SQL);
    runtime.db.prepare('DELETE FROM unkept WHERE session = ?').run(session);
    entries.slice(0, UNKEPT_MAX).forEach((entry, position) => {
      insert.run(session, position, cut(entry.text), entry.reason, entry.detail, now);
    });
    if (entries.length > UNKEPT_MAX)
      insert.run(session, UNKEPT_MAX, '', MORE, String(entries.length - UNKEPT_MAX), now);
  })();
}

/** The session's entries younger than two hours; empty from a runtime an older Stop wrote. */
export function readUnkept(runtime: DraftRuntime, session: string, now: number): UnkeptRead {
  if (!present(runtime)) return { entries: [], more: 0 };
  const rows = runtime.db
    .prepare(
      'SELECT text, reason, detail FROM unkept WHERE session = ? AND at > ? ORDER BY position'
    )
    .all(session, now - EXCERPT_TTL_MS) as UnkeptEntry[];
  const more = rows.find((row) => row.reason === MORE);
  return {
    entries: rows.filter((row) => row.reason !== MORE),
    more: more ? Number(more.detail) || 0 : 0,
  };
}

/** The prompt hook, once it has named them. */
export function clearUnkept(runtime: DraftRuntime, session: string): void {
  if (present(runtime)) runtime.db.prepare('DELETE FROM unkept WHERE session = ?').run(session);
}

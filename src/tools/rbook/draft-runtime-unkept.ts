// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps one Stop's lost lines and settlement notes in the private draft runtime for two hours.
// ABOUTME: A successful prompt delivery acknowledges only its own generation and delivered positions.

import { randomUUID } from 'crypto';
import type { DraftRuntime } from './draft-runtime';
import { EXCERPT_TTL_MS } from './draft-runtime-excerpts';

/**
 * WHY (the sprint-109 design, settled item 5; local feedback #51). A Would record line past the
 * third, one of an unpublished kind or with too little text, and a Settled line that was refused or
 * written in another form all took no effect, and nothing said so: the agent believed the line had
 * landed. Stop now keeps each one here with its reason, at most {@link UNKEPT_MAX} a reply and the
 * rest counted, replacing the previous reply's entries. Remaining positions survive a partial delivery.
 * They expire with the operator's words, after two hours.
 */
export const UNKEPT_MAX = 5;
export const UNKEPT_TEXT_MAX = 80;

export const UNKEPT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS unkept (session TEXT NOT NULL,
  position INTEGER NOT NULL, text TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL,
  at INTEGER NOT NULL, generation TEXT, PRIMARY KEY (session, position));`;

export interface UnkeptEntry {
  /** The agent's own line, cut to {@link UNKEPT_TEXT_MAX} characters. */
  readonly text: string;
  /** Why it took no effect, or the note on one that did (src/cli/drafts-unkept-notes.ts). */
  readonly reason: string;
  readonly detail: string;
}

export interface UnkeptRead {
  /** An older writer leaves this null: its rows can be shown but cannot be acknowledged safely. */
  readonly generation: string | null;
  readonly entries: readonly (UnkeptEntry & { readonly position: number })[];
  /** Entries past {@link UNKEPT_MAX}, counted only. */
  readonly more: number;
}

const MORE = 'more';

function columns(runtime: DraftRuntime): { name: string }[] {
  return runtime.db.pragma('table_info(unkept)') as { name: string }[];
}

/**
 * 4.12.0 (67b650cc) and cfab889f have two callers of the same session-wide DELETE.
 * A prepared regular prompt's commit opens a NEW connection for clearUnkept: only schema
 * checks and reads precede its DELETE. Stop, including an empty Stop, first writes one row
 * with setShown on its OWN connection. total_changes() observes those SQLite writes even
 * when the showing and timestamp are identical. Session end removes windows before unkept.
 * Startup writes starts, and the time predicate leaves expired rows available to the old prune.
 *
 * A previously loaded prompt has no receipt with which to identify a generation. Let it read
 * the notes again until the next Stop; only the current prompt releases its delivered positions.
 * Old Stop INSERTs after installation acquire an identity together; existing rows remain unowned.
 */
const MIXED_VERSION_SQL = `
  CREATE TRIGGER IF NOT EXISTS unkept_require_delivery BEFORE DELETE ON unkept
  WHEN OLD.generation IS NOT NULL AND total_changes() = 0
    AND OLD.at > unixepoch('subsec') * 1000 - ${EXCERPT_TTL_MS}
    AND EXISTS (SELECT 1 FROM windows WHERE session = OLD.session)
  BEGIN
    SELECT RAISE(IGNORE);
  END;
  CREATE TRIGGER IF NOT EXISTS unkept_identify_stop AFTER INSERT ON unkept
  WHEN NEW.position = 0 OR NEW.generation IS NULL
  BEGIN
    INSERT INTO windows (session, draft_ids, open, at) VALUES (NEW.session, '[]', 0, NEW.at)
      ON CONFLICT(session) DO UPDATE SET at = MAX(windows.at, excluded.at) WHERE windows.open = 0;
    UPDATE unkept SET generation = COALESCE(
      (SELECT generation FROM unkept WHERE session = NEW.session AND generation IS NOT NULL LIMIT 1),
      lower(hex(randomblob(16)))
    ) WHERE session = NEW.session AND position = NEW.position AND generation IS NULL;
  END;`;

/** Flatten a bounded prefix and avoid splitting an astral character at the UTF-16 limit. */
export function unkeptExcerpt(text: string, limit = UNKEPT_TEXT_MAX): string {
  const prefix = text.slice(0, UNKEPT_TEXT_MAX * 4);
  const flat = prefix.replace(/\s+/g, ' ').trim();
  if (prefix.length === text.length && flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

/** Stop: this reply's entries replace the session's earlier ones, even when there are none. */
export function replaceUnkept(
  runtime: DraftRuntime,
  session: string,
  entries: readonly UnkeptEntry[],
  now: number
): void {
  runtime.db
    .transaction(() => {
      runtime.db.exec(UNKEPT_TABLE_SQL);
      if (!columns(runtime).some((column) => column.name === 'generation'))
        runtime.db.exec('ALTER TABLE unkept ADD COLUMN generation TEXT');
      runtime.db.exec(MIXED_VERSION_SQL);
      // This Stop intentionally replaces its entire previous generation, including unowned rows.
      runtime.db.prepare('UPDATE unkept SET generation = NULL WHERE session = ?').run(session);
      runtime.db.prepare('DELETE FROM unkept WHERE session = ?').run(session);
      if (!entries.length) return;
      const generation = randomUUID();
      const insert = runtime.db.prepare(
        'INSERT INTO unkept (session, position, text, reason, detail, at, generation) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      entries.slice(0, UNKEPT_MAX).forEach((entry, position) => {
        insert.run(
          session,
          position,
          unkeptExcerpt(entry.text),
          entry.reason,
          entry.detail,
          now,
          generation
        );
      });
      if (entries.length > UNKEPT_MAX)
        insert.run(
          session,
          UNKEPT_MAX,
          '',
          MORE,
          String(entries.length - UNKEPT_MAX),
          now,
          generation
        );
    })
    .immediate();
}

/** A read-only prompt can see old rows without upgrading the runtime or inventing an identity. */
export function readUnkept(runtime: DraftRuntime, session: string, now: number): UnkeptRead {
  const fields = columns(runtime);
  if (!fields.length) return { generation: null, entries: [], more: 0 };
  const generationColumn = fields.some((column) => column.name === 'generation')
    ? 'generation'
    : 'NULL AS generation';
  const rows = runtime.db
    .prepare(
      `SELECT position, text, reason, detail, ${generationColumn}
       FROM unkept WHERE session = ? AND at > ? ORDER BY position LIMIT ?`
    )
    .all(session, now - EXCERPT_TTL_MS, UNKEPT_MAX + 1) as Array<
    UnkeptEntry & { position: number; generation: string | null }
  >;
  const more = rows.find((row) => row.position === UNKEPT_MAX && row.reason === MORE);
  return {
    generation: rows[0]?.generation ?? null,
    entries: rows
      .filter((row) => row !== more)
      .map(({ position, text, reason, detail }) => ({ position, text, reason, detail })),
    more: more ? Number(more.detail) || 0 : 0,
  };
}

/** An acknowledgement may arrive after another Stop, even with an identical timestamp and text. */
export function acknowledgeUnkept(
  runtime: DraftRuntime,
  session: string,
  generation: string | null,
  positions: readonly number[]
): void {
  if (!generation || !positions.length) return;
  if (!columns(runtime).some((column) => column.name === 'generation')) return;
  const release = runtime.db.prepare(
    'UPDATE unkept SET generation = NULL WHERE session = ? AND generation = ? AND position = ?'
  );
  const remove = runtime.db.prepare(
    'DELETE FROM unkept WHERE session = ? AND position = ? AND generation IS NULL'
  );
  runtime.db
    .transaction(() => {
      for (const position of positions) {
        if (release.run(session, generation, position).changes) remove.run(session, position);
      }
    })
    .immediate();
}

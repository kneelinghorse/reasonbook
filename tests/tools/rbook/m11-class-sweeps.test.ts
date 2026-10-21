// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — two of the mission's class sweeps as standing gates: no automatic status write to
// ABOUTME: a decision or learning beyond the named sites, and every stored-timestamp compare/sort is a time.

/**
 * The predicates are the design doc's (rbook/planning/s93-the-loop-runs-itself-build.md, m11 class
 * sweeps 1 and 5), run over src/ with JavaScript's regex engine, which reads them as ripgrep's PCRE2
 * does. Each match is keyed by what it writes or compares, not by line number, so an edit elsewhere in
 * a file never moves the ledger; a new site fails until it is classified here.
 *
 * WHAT THESE CANNOT SEE (one contract with the scope above): a status set at INSERT (sync-merge,
 * restore, clone and pull; the last two are next-step #614), SQL built by string concatenation
 * outside a template, anything outside src/, and a timestamp compared under a column name that ends
 * in neither `_at` nor `_date` (sprint-current's `activity_at` alias is one that does). On the
 * JavaScript side (added after the m11 contract critic found five text compares there): a stored
 * time held in a variable whose name is not time-shaped (TIME_NAMED), a comparison or parse split
 * across lines, and a sort comparator that compares through a helper other than the ones named
 * below.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  claimUpload,
  ensureUploadColumns,
  finishUpload,
  markUploadOwed,
  readUploadState,
} from '../../../src/intelligence/project-upload-state';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({ file: path.relative(SRC, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

const lineOf = (text: string, index: number): string => {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end);
};

// ─── Class 1: automatic status writes ──────────────────────────────────────────────────────────

// The admitted hole (s96-m12): the merge writes columns named in a template, status among them
// (record-materialize.ts materializeEntity, record-settle.ts settleField), which this predicate cannot
// see. It writes only a value some copy recorded at a caller's request, or a settle a caller asked for.
const STATUS_UPDATE =
  /UPDATE\s+(strategic_decisions|learnings|constraints|next_steps|\$\{[^}]+\})\s+SET\s(?:(?!WHERE)[\s\S]){0,300}?\bstatus\s*=\s*('[^']*'|\?)/g;
const STATUS_PUSH = /(sets|setClauses|updates)\.push\(\s*['"`]status\s*=/g;

type Kind = 'caller-requested' | 'automatic';

/** Every status write in src/, keyed `file|table|value`, with who asks for it and why it may. */
const STATUS_WRITES: ReadonlyArray<{ key: string; kind: Kind; why: string }> = [
  {
    key: 'tools/rbook/spin-out-mark.ts|${table}|?',
    kind: 'caller-requested',
    why: 'explicit spin-out --apply archives selected learnings and drops next-steps only after target verification',
  },
  {
    key: 'tools/rbook/spin-out-mark.ts|strategic_decisions|archived',
    kind: 'caller-requested',
    why: 'explicit spin-out --apply archives selected decisions in atomic source finalization',
  },
  {
    key: 'tools/rbook/rbook-sprint-complete.ts|next_steps|dropped',
    kind: 'automatic',
    why: 'the next-step lease drop at a close: ratified (Q4, #1161), itemized with its reopen command',
  },
  {
    key: 'tools/rbook/rbook-sprint-complete.ts|${table}|archived',
    kind: 'caller-requested',
    why: 'a close called with archive: true',
  },
  {
    key: 'tools/rbook/rbook-next-steps.ts|next_steps|?',
    kind: 'caller-requested',
    why: 'complete/drop',
  },
  {
    key: 'tools/rbook/rbook-next-steps.ts|next_steps|pending',
    kind: 'caller-requested',
    why: 'reopen',
  },
  {
    key: 'tools/rbook/rbook-next-steps.ts|next_steps|carried',
    kind: 'caller-requested',
    why: 'carry all',
  },
  {
    key: 'tools/rbook/rbook-next-steps.ts|next_steps|carried',
    kind: 'caller-requested',
    why: 'carry ids',
  },
  {
    key: 'tools/rbook/rbook-decisions-record.ts|strategic_decisions|superseded',
    kind: 'caller-requested',
    why: 'record with supersedes=[...]',
  },
  {
    key: 'tools/rbook/rbook-learnings-update.ts|learnings|?',
    kind: 'caller-requested',
    why: 'update',
  },
  {
    key: 'tools/rbook/schema-migrations.ts|strategic_decisions|active',
    kind: 'automatic',
    why: 'the migration fill: gives a NULL status a value once; changes no status a row had',
  },
  {
    key: 'tools/rbook/staleness-detection.ts|strategic_decisions|active',
    kind: 'automatic',
    why: 'the first-write repair restores only rows an automatic flagger could have set to stale (#1182, #1191)',
  },
  {
    key: 'tools/rbook/staleness-detection.ts|learnings|active',
    kind: 'automatic',
    why: 'the first-write repair restores only rows an automatic flagger could have set to stale (#1182, #1191)',
  },
  {
    key: 'tools/rbook/rbook-constraints.ts|constraints|archived',
    kind: 'caller-requested',
    why: 'archive expired',
  },
  {
    key: 'tools/rbook/rbook-constraints.ts|constraints|archived',
    kind: 'caller-requested',
    why: 'archive ids',
  },
  {
    key: 'tools/rbook/rbook-decisions-batch-update.ts|strategic_decisions|?',
    kind: 'caller-requested',
    why: 'batch_update, review stamped',
  },
  {
    key: 'tools/rbook/rbook-decisions-batch-update.ts|strategic_decisions|?',
    kind: 'caller-requested',
    why: 'batch_update on a store without the review column',
  },
  { key: 'tools/rbook/rbook-decisions-update.ts|push|?', kind: 'caller-requested', why: 'update' },
];

function statusWriteKeys(): string[] {
  const keys: string[] = [];
  for (const { file, text } of sources()) {
    for (const m of text.matchAll(STATUS_UPDATE)) {
      keys.push(`${file}|${m[1]}|${m[2] === '?' ? '?' : m[2].slice(1, -1)}`);
    }
    for (const _m of text.matchAll(STATUS_PUSH)) keys.push(`${file}|push|?`);
  }
  return keys.sort();
}

describe('s93-m11 class 1 — Reasonbook never changes a decision or learning status on its own', () => {
  it('every status write in src/ is classified (a new one fails until it is)', () => {
    expect(statusWriteKeys()).toEqual(STATUS_WRITES.map((w) => w.key).sort());
  });

  it('the automatic writes to a decision or learning status are only the fill and the repair', () => {
    const automatic = STATUS_WRITES.filter(
      (w) => w.kind === 'automatic' && /\|(strategic_decisions|learnings)\|/.test(w.key)
    ).map((w) => w.key);
    expect(automatic).toEqual([
      'tools/rbook/schema-migrations.ts|strategic_decisions|active',
      'tools/rbook/staleness-detection.ts|strategic_decisions|active',
      'tools/rbook/staleness-detection.ts|learnings|active',
    ]);
    // And no shipped code writes 'stale' at all: an explicit caller passes it as a parameter.
    expect(statusWriteKeys().filter((key) => key.endsWith('|stale'))).toEqual([]);
  });
});

// ─── Class 5: timestamps compare and sort as times ─────────────────────────────────────────────

const COMPARISON =
  /(MAX|MIN\()?(\w+\.)?(\w+_at|\w*_date)\)?\s*(<=|>=|<|>)\s*(\?|\$\{|datetime\(|strftime\(|date\(|julianday\(|CURRENT_)/g;
// Line mode, as ripgrep reads it: the gap after ORDER BY never crosses a newline.
const ORDERING = /ORDER BY[ \t]+(?!julianday)[^`;\n]*?\b(\w+\.)?(\w+_at|\w*_date)\b/g;

/** Matches that are not stored text timestamps, keyed `file|column`, each with its reason. */
const SAFE: Readonly<Record<string, string>> = {
  'intelligence/cross-store-queries.ts|occurred_at': 'occurred_at is integer milliseconds',
  'intelligence/spin-out-query.ts|occurred_at':
    'same integer-millisecond merge order after source visibility filtering',
  'tools/rbook/rbook-review.ts|occurred_at': 'the drift probe reads integer milliseconds',
  // s97-m01: quiet_days is the drift probe's stamp bounded by now, a number on both sides.
  'signals/rules-activity.ts|occurred_at': 'the quiet rule reads the same integer milliseconds',
  'intelligence/project-graph-registry.ts|last_seen_at': 'the registry stores integer milliseconds',
  'intelligence/project-upload-state.ts|upload_latest_write_at':
    'registry INTEGER epoch milliseconds, written from the numeric clock',
  'intelligence/project-upload-state.ts|upload_first_owed_at':
    'registry INTEGER epoch milliseconds, written from the numeric clock',
  'intelligence/project-upload-state.ts|upload_lease_expires_at':
    'registry INTEGER epoch milliseconds, numeric clock plus lease duration',
  'intelligence/registered-stores-readonly.ts|last_seen_at':
    'same canonical registry integer milliseconds',
  'intelligence/cross-store-query.ts|occurred_at': 'a doc comment naming the merge order',
  'tools/rbook/feedback-fleet.ts|occurred_at':
    'numeric merge alias explicitly derived through julianday(created_at)',
};

describe('s93-m11 class 5 — every stored-timestamp comparison and ordering is a time (#607, #597)', () => {
  function offenders(pattern: RegExp): string[] {
    const out: string[] = [];
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(pattern)) {
        const line = lineOf(text, m.index ?? 0);
        const column = m[3] ?? m[2];
        if (line.includes('julianday(')) continue;
        if (SAFE[`${file}|${column}`]) continue;
        out.push(`${file}: ${line.trim()}`);
      }
    }
    return out;
  }

  it('every comparison goes through julianday() or is listed as safe', () => {
    expect(offenders(COMPARISON)).toEqual([]);
  });

  it('the upload exemptions store numeric epochs, not the mixed timestamp text this gate rejects', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE projects(project_id TEXT PRIMARY KEY, archived_at INTEGER, last_synced_at INTEGER)'
      );
      ensureUploadColumns(db);
      db.prepare('INSERT INTO projects(project_id) VALUES (?)').run('one');
      const now = Date.now();
      markUploadOwed(db, 'one', now);
      const lease = claimUpload(db, 'one', now, true)!;
      expect(
        db
          .prepare(
            `SELECT typeof(upload_latest_write_at) AS latest,
        typeof(upload_first_owed_at) AS first, typeof(upload_lease_expires_at) AS expires
        FROM projects WHERE project_id = ?`
          )
          .get('one')
      ).toEqual({
        latest: 'integer',
        first: 'integer',
        expires: 'integer',
      });
      finishUpload(db, 'one', lease, now + 1, { success: true });
      expect(readUploadState(db, 'one')?.lastSyncedAt).toBe(now + 1);
    } finally {
      db.close();
    }
  });

  /**
   * Every timestamp column inside an ORDER BY clause (to the closing backtick, semicolon or LIMIT)
   * is wrapped in julianday(...), directly or through COALESCE/MAX inside it, or is only tested for
   * NULL. Clause-wide on purpose: the design doc's line-mode predicate missed the sprint list,
   * whose sorted column sat on the line after its ORDER BY.
   */
  function orderingOffenders(): string[] {
    const out: string[] = [];
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(/ORDER BY\b/g)) {
        const start = m.index ?? 0;
        const rest = text.slice(start);
        const stop = rest.search(/[`;]|\bLIMIT\b/);
        const clause = stop === -1 ? rest : rest.slice(0, stop);
        for (const c of clause.matchAll(/\b(\w+\.)?(\w+_at|\w*_date)\b/g)) {
          const column = c[2];
          const at = c.index ?? 0;
          if (SAFE[`${file}|${column}`]) continue;
          if (/^\s+IS\s+(NOT\s+)?NULL/i.test(clause.slice(at + c[0].length))) continue;
          if (insideJulianday(clause, at)) continue;
          out.push(`${file}: ${clause.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    return out;
  }

  /** Whether position `at` sits inside the parentheses of a julianday( call. */
  function insideJulianday(text: string, at: number): boolean {
    let depth = 0;
    for (let i = at - 1; i >= 0; i--) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(') {
        if (depth === 0) {
          if (/julianday\s*$/.test(text.slice(0, i))) return true;
        } else depth--;
      }
    }
    return false;
  }

  it('every ordering goes through julianday() or is listed as safe', () => {
    expect(orderingOffenders()).toEqual([]);
    // The line-mode predicate's own universe stays clean too.
    expect(offenders(ORDERING)).toEqual([]);
  });

  // An aggregate is an ordering too: MAX over timestamp text returns the largest string, which for
  // mixed spellings is not the latest time. Found while building m11, outside both published
  // predicates; the sites aggregate on julianday() and render the result back as one ISO spelling.
  it('every MAX/MIN over a timestamp aggregates as a time or is listed as safe', () => {
    const AGGREGATE = /\b(MAX|MIN)\(\s*(?!julianday)(\w+\.)?(\w+_at|\w*_date)\s*\)/g;
    const out: string[] = [];
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(AGGREGATE)) {
        if (SAFE[`${file}|${m[3]}`]) continue;
        out.push(`${file}: ${lineOf(text, m.index ?? 0).trim()}`);
      }
    }
    expect(out).toEqual([]);
  });

  /**
   * JAVASCRIPT SIDE. A stored time compared or sorted in TypeScript must agree with julianday(): text
   * order puts `2026-06-30 03:10:21` before `2026-06-30T02:14:08.987Z`, and Date.parse reads the
   * zone-less spelling as local time. Every localeCompare or relational operator whose operand is
   * time-named goes through storedTimeMs/compareStoredTimes (stored-time.ts), or is a number or a
   * Date listed below. Keyed `file|operand`, so an edit elsewhere never moves the ledger.
   */
  const TIME_NAMED = /(^ts$|^since$|^until$|At$|_at$|_date$|Date$|[tT]imestamp$|^cursor$|Cursor$)/;
  const JS_SAFE: Readonly<Record<string, string>> = {
    'intelligence/cross-store-query.ts|Cursor': 'a type argument (BinaryHeap<Cursor>), not a value',
    'tools/rbook/rbook-message.ts|hit.fetchedAt': 'epoch milliseconds (Date.now())',
    'tools/rbook/dashboard-client.ts|this.tokenExpiresAt': 'epoch milliseconds',
    'tools/rbook/sync-bootstrap.ts|maxCursor': 'a sync-log row id',
    'tools/rbook/sync-mutable.ts|incoming.occurredAt': 'epoch milliseconds (OrderingKey)',
    'tools/rbook/sync-mutable.ts|current.occurredAt': 'epoch milliseconds (OrderingKey)',
    'tools/rbook/rbook-project-list.ts|row.registered_at': 'a registry row: epoch milliseconds',
    'tools/rbook/rbook-project-list.ts|row.last_seen_at': 'a registry row: epoch milliseconds',
    'tools/rbook/rbook-project-register.ts|entry.registered_at':
      'a registry row: epoch milliseconds',
    'tools/rbook/dashboard-upload-scheduler.ts|state.lastSyncedAt':
      'registry last_synced_at INTEGER epoch milliseconds, not a stored ISO/SQLite text spelling',
    'tools/rbook/dashboard-client.ts|loginResponse.data.expiresAt':
      "the dashboard's own ISO-8601, always with Z; not a stored time",
  };

  function jsTimeOffenders(): string[] {
    const operand = String.raw`([\w$]+(?:\??\.[\w$]+)*)`;
    const locale = new RegExp(String.raw`${operand}\??\.localeCompare\(\s*${operand}`, 'g');
    const relational = new RegExp(String.raw`${operand}\s*(<=|>=|<|>)\s*${operand}`, 'g');
    const parse = new RegExp(String.raw`\b(?:Date\.parse|new Date)\(\s*${operand}`, 'g');
    const lastPart = (path: string): string => path.split(/\??\./).pop() ?? path;
    const numeric = /(Ms|ms|length|Count|Number)$/;
    const out: string[] = [];
    for (const { file, text } of sources()) {
      text.split('\n').forEach((line) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/storedTimeMs|compareStoredTimes|julianday/.test(line)) return;
        const hits: string[] = [];
        for (const m of line.matchAll(locale)) {
          hits.push(...[m[1], m[2]].filter((o) => TIME_NAMED.test(lastPart(o))));
        }
        for (const m of line.matchAll(relational)) {
          if (numeric.test(lastPart(m[1])) || numeric.test(lastPart(m[3]))) continue;
          hits.push(...[m[1], m[3]].filter((o) => TIME_NAMED.test(lastPart(o))));
        }
        // A parse is a comparison waiting to happen: Date.parse and new Date read SQLite's
        // zone-less spelling as local time (the confirming critic found six such sites).
        for (const m of line.matchAll(parse)) {
          if (TIME_NAMED.test(lastPart(m[1]))) hits.push(m[1]);
        }
        for (const hit of hits) {
          if (!JS_SAFE[`${file}|${hit}`]) out.push(`${file}: ${line.trim()}`);
        }
      });
    }
    return [...new Set(out)];
  }

  it('every JavaScript comparison or sort of a stored time reads it as a time', () => {
    expect(jsTimeOffenders()).toEqual([]);
  });

  it('POSITIVE CONTROL: the JavaScript predicate sees the five text compares the critic found', () => {
    const before = [
      'return b.createdAt.localeCompare(a.createdAt);',
      'if (filters.since && timestamp < filters.since) {',
      'b.row.created_at.localeCompare(a.row.created_at) ||',
      'if (since && ts <= since) continue;',
      'events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));',
    ];
    const operand = String.raw`([\w$]+(?:\??\.[\w$]+)*)`;
    const locale = new RegExp(String.raw`${operand}\??\.localeCompare\(\s*${operand}`);
    const relational = new RegExp(String.raw`${operand}\s*(<=|>=|<|>)\s*${operand}`);
    for (const line of before) {
      const m = locale.exec(line) ?? relational.exec(line);
      expect(m).not.toBeNull();
      const operands = m!.slice(1).filter((o) => o && !/^(<=|>=|<|>)$/.test(o));
      expect(operands.some((o) => TIME_NAMED.test(o.split(/\??\./).pop() ?? o))).toBe(true);
    }
    // ...and a parse the confirming critic found reading a zone-less time as local.
    const parse = new RegExp(String.raw`\b(?:Date\.parse|new Date)\(\s*${operand}`);
    const parsed = parse.exec('const contextTs = Date.parse(contextUpdatedAt);');
    expect(parsed?.[1]).toBe('contextUpdatedAt');
    expect(TIME_NAMED.test(parsed![1])).toBe(true);
  });

  it('the interpolated anchor the predicate cannot see compares as a time too', () => {
    const constraints = fs.readFileSync(path.join(SRC, 'tools/rbook/rbook-constraints.ts'), 'utf8');
    expect(constraints).toContain('julianday(${ageAnchor}) <= julianday(?)');
    const lease = fs.readFileSync(path.join(SRC, 'tools/rbook/next-step-lease.ts'), 'utf8');
    expect(lease).toContain(
      'julianday(s.end_date) > julianday(COALESCE(n.resolved_at, n.created_at))'
    );
  });

  it('julianday orders the store formats that string comparison got wrong', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      // Same calendar day: ISO 'T' text sorts after SQLite's space text, whatever the time.
      const row = db
        .prepare(
          `SELECT '2026-10-08T05:00:00.000Z' < '2026-10-08 06:00:00' AS asText,
                  julianday('2026-10-08T05:00:00.000Z') < julianday('2026-10-08 06:00:00') AS asTime,
                  julianday('2026-10-08T05:00:00+02:00') < julianday('2026-10-08T04:00:00Z') AS offset`
        )
        .get() as { asText: number; asTime: number; offset: number };
      expect(row).toEqual({ asText: 0, asTime: 1, offset: 1 });
    } finally {
      db.close();
    }
  });
});

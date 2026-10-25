// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criterion 7 — the six console.warn-only session_events sites must put the DB
// ABOUTME: error in the ANSWER, plus the byte-pin on the one site that was already right.

/**
 * Sprint 86 m02b — "durable provenance was being lost with nothing in the answer".
 *
 * WHY THIS MATTERS, not just what it asserts.
 *
 * `session_events` is the append-only transition ledger — the row that says a mission moved from
 * Queued to In Progress, who moved it, and when. It is not decoration: mission history, retro
 * counts and the audit trail are reconstructed from it. Before this mission, all six
 * mission-transition handlers wrote that row, INSPECTED the result envelope, and then threw the
 * failure into `console.warn` and returned `success: true` with a clean-looking answer:
 *
 *     if (!eventResult.success) {
 *       console.warn('Failed to log mission defer event:', eventResult.error);
 *     }
 *
 * `console.warn` goes to the MCP server's stderr. The agent that called the tool reads
 * `content[0].text` — the string a `format*ForLLM` produced. So the operator was told the
 * transition completed, the provenance row was gone, and nothing anywhere in the answer said so.
 * That is this sprint's defect class exactly: reporting intent as fact.
 *
 * WHAT WOULD MAKE THIS TEST WRONG TO WRITE, and why it is written this way instead:
 *
 *  - A mock client cannot catch a wrong-table or wrong-column INSERT (agents.md Process
 *    Hardening #4 — s80-m07 shipped a `deleted_at` predicate against a column that did not
 *    exist). Every failure below is forced AT THE DATABASE by a `BEFORE INSERT` RAISE trigger on
 *    the real `session_events` table of a real temp store, so a handler writing to the wrong
 *    table would simply never trip the trigger and the case would go red.
 *  - A warning that lives only in `structuredContent` is invisible in practice. So each case
 *    asserts the DB error text in the STRING the formatter produced, reached through the same
 *    dispatcher `src/index.ts` uses (`formatMissionTransitionForLLM` / `formatMissionForLLM`),
 *    not through the leaf formatter directly.
 *  - Except for the ratified s94-m08 atomic drop, `success` stays TRUE (fork f09). The mission DID transition. The cure is disclosure, not
 *    abortion — so each case also reads the mission's status back out of the DB and proves the
 *    transition landed while its event row did not. Drop instead requires its audit, refuses and rolls back.
 *
 * NEGATIVE CONTROL, per case: the identical scenario with NO trigger must produce exactly one
 * mission-scoped `session_events` row with the expected action/status and NO event-logging warning.
 * Opening the caller's implicit session may produce a separate session-start event. Without the
 * mission-scoped control, a store broken for some unrelated
 * reason (missing table, wrong path, mission not found) would still look like a successful
 * reproduction — and a test that passes because everything is broken is worse than no test.
 *
 * THE SEVENTH SITE IS PINNED, NOT FIXED. `rbook-mission-complete.ts` already did both the
 * `console.warn` AND the `warnings.push` — it is the in-file reference implementation this
 * mission copied, and the mission forbids touching it. The last describe block asserts its bytes
 * AND exercises it, so it is pinned as live code rather than as a comment.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { setEmbedderForTesting } from '../../../src/intelligence/embedding-pipeline';
import {
  rbookMission,
  formatMissionForLLM,
  type RbookMissionResult,
} from '../../../src/tools/rbook/rbook-mission';
import {
  rbookMissionTransition,
  formatMissionTransitionForLLM,
  type RbookMissionTransitionResult,
} from '../../../src/tools/rbook/rbook-mission-transition';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MISSION_COMPLETE_SRC = path.join(
  REPO_ROOT,
  'src',
  'tools',
  'rbook',
  'rbook-mission-complete.ts'
);

// ─── temp-store plumbing ─────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function mkStore(label: string): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rbook-m02b-sevents-${label}-`));
  tmpDirs.push(projectRoot);
  const dbPath = seedRbookDb(projectRoot, { projectName: `m02b ${label}` });
  return { projectRoot, dbPath };
}

function withDb<T>(dbPath: string, fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Put the mission in the exact state its transition is legal from. Each verb has a different
 * precondition (`unblock` is only legal from Blocked, `block` only from Current / In Progress),
 * so a table-driven test that seeded one status for all six would prove five error paths.
 *
 * No hardcoded dates — `created_at` is Date.now()-relative.
 */
function seedMission(dbPath: string, missionId: string, status: string): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?)`
    ).run(
      missionId,
      `m02b ${missionId}`,
      status,
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString()
    );
  });
}

/**
 * Force the failure AT THE DATABASE, on exactly one statement shape on exactly one table.
 *
 * A `BEFORE INSERT` RAISE(ABORT) on `session_events` is the surgical option: reads still work,
 * every other table still writes, and the mission UPDATE that precedes the event INSERT in all
 * six handlers still commits — which is what lets each case prove the transition landed while its
 * provenance row did not. Renaming the table would have failed reads too and made "the answer
 * still reports the transition" unprovable.
 */
function forceSessionEventsInsertFailure(dbPath: string, message: string): void {
  withDb(dbPath, (db) => {
    db.exec(
      `CREATE TRIGGER m02b_force_session_events_failure
       BEFORE INSERT ON session_events
       BEGIN
         SELECT RAISE(ABORT, '${message}');
       END;`
    );
  });
}

function countSessionEvents(dbPath: string): number {
  return withDb(
    dbPath,
    (db) => (db.prepare('SELECT COUNT(*) AS c FROM session_events').get() as { c: number }).c
  );
}

function readMissionEvents(
  dbPath: string,
  missionId: string
): { action: string; status: string }[] {
  return withDb(
    dbPath,
    (db) =>
      db.prepare('SELECT action, status FROM session_events WHERE mission = ?').all(missionId) as {
        action: string;
        status: string;
      }[]
  );
}

function readMissionStatus(dbPath: string, missionId: string): string | undefined {
  return withDb(
    dbPath,
    (db) =>
      (
        db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as
          | { status: string }
          | undefined
      )?.status
  );
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ─── the six cases ───────────────────────────────────────────────────────────

interface EventSite {
  /** Case label, also the temp-dir suffix and part of the forced DB error text. */
  readonly label: string;
  /** The tool surface an agent actually calls. */
  readonly surface: string;
  /** Status the mission must be in for this transition to be legal. */
  readonly fromStatus: string;
  /** Status the mission must be in AFTERWARDS — the transition itself must still land. */
  readonly toStatus: string;
  /** Source site being covered, named so a red case says which handler regressed. */
  readonly site: string;
  readonly run: (projectRoot: string, missionId: string) => Promise<RbookToolResult<unknown>>;
  /**
   * The formatter as `src/index.ts` reaches it — the DISPATCHER, not the leaf. A leaf that
   * renders the channel but is unreachable from its dispatcher would not pass.
   */
  readonly format: (result: RbookToolResult<unknown>) => string;
}

type TransitionAction = 'defer' | 'unblock' | 'block' | 'drop' | 'start' | 'complete';

function runTransition(
  projectRoot: string,
  missionId: string,
  action: TransitionAction,
  extra: Record<string, unknown> = {}
): Promise<RbookToolResult<unknown>> {
  return rbookMissionTransition({ action, missionId, projectRoot, ...extra });
}

function transitionFormatter(action: TransitionAction) {
  return (result: RbookToolResult<unknown>): string =>
    formatMissionTransitionForLLM(action, result as RbookToolResult<RbookMissionTransitionResult>);
}

const SITES: readonly EventSite[] = [
  {
    label: 'defer',
    surface: 'rbook_mission_transition(action="defer")',
    fromStatus: 'Queued',
    toStatus: 'Deferred',
    site: 'rbook-mission-defer.ts (event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) =>
      runTransition(projectRoot, missionId, 'defer', { reason: 'parked for m02b' }),
    format: transitionFormatter('defer'),
  },
  {
    label: 'unblock',
    surface: 'rbook_mission_transition(action="unblock")',
    fromStatus: 'Blocked',
    toStatus: 'In Progress',
    site: 'rbook-mission-unblock.ts (event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) =>
      runTransition(projectRoot, missionId, 'unblock', { resolution: 'blocker cleared' }),
    format: transitionFormatter('unblock'),
  },
  {
    label: 'block',
    surface: 'rbook_mission_transition(action="block")',
    fromStatus: 'In Progress',
    toStatus: 'Blocked',
    site: 'rbook-mission-block.ts (event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) =>
      runTransition(projectRoot, missionId, 'block', { reason: 'waiting on upstream' }),
    format: transitionFormatter('block'),
  },
  {
    label: 'drop',
    surface: 'rbook_mission_transition(action="drop")',
    fromStatus: 'Queued',
    toStatus: 'Dropped',
    site: 'rbook-mission-drop.ts (event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) =>
      runTransition(projectRoot, missionId, 'drop', { reason: 'superseded' }),
    format: transitionFormatter('drop'),
  },
  {
    label: 'start',
    surface: 'rbook_mission_transition(action="start")',
    fromStatus: 'Queued',
    toStatus: 'In Progress',
    site: 'rbook-mission-start.ts (event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) => runTransition(projectRoot, missionId, 'start'),
    format: transitionFormatter('start'),
  },
  {
    label: 'update',
    surface: 'rbook_mission(action="update")',
    fromStatus: 'Queued',
    toStatus: 'Current',
    // The event row is only written when the UPDATE changes status, so this case must change it.
    site: 'rbook-mission-update.ts (status-change event insert + former console.warn-only arm)',
    run: (projectRoot, missionId) =>
      rbookMission({ action: 'update', missionId, fields: { status: 'Current' }, projectRoot }),
    format: (result) =>
      formatMissionForLLM('update', result as RbookToolResult<RbookMissionResult>),
  },
];

// ─── lifecycle (file-scoped: both describes below rely on it) ────────────────

let warnSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

beforeAll(() => {
  // The handlers keep their console.warn (the mission permits it) and the mission write paths run
  // the embedding hook. Neither is under test; silencing both keeps the run quiet and — the point —
  // makes it impossible for an assertion below to accidentally read the failure off stderr.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  // Deterministic + offline: a throwing embedder puts recordEmbedding on its catch path instantly
  // instead of reaching for the Xenova model over the network.
  setEmbedderForTesting(async () => {
    throw new Error('embedder disabled for s86-m02b session_events test');
  });
});

afterAll(() => {
  setEmbedderForTesting(null);
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── suite ───────────────────────────────────────────────────────────────────

describe('s86-m02b: a lost session_events row is named in the answer, not only on stderr', () => {
  describe.each(SITES.map((site) => [site.label, site] as const))(
    '%s',
    (label, site: EventSite) => {
      it(`${site.surface} surfaces the DB error in the formatted text when the session_events INSERT fails`, async () => {
        const { projectRoot, dbPath } = mkStore(label);
        const missionId = `s86-m02b-${label}`;
        seedMission(dbPath, missionId, site.fromStatus);

        // A per-case nonce: the message that shows up in the answer can only have come from THIS
        // case's forced failure, never from a leaked warning or a shared fixture.
        const dbErrorText = `s86m02b forced session_events abort ${label} ${Date.now()}`;
        forceSessionEventsInsertFailure(dbPath, dbErrorText);

        const result = await site.run(projectRoot, missionId);
        const text = site.format(result);

        // s94-m08 makes drop and its audit indivisible; refuse with the DB message and prove rollback.
        if (label === 'drop') {
          expect(result.success).toBe(false);
          expect(result.error?.code).toBe('MISSION_DROP_AUDIT_FAILED');
          expect(readMissionStatus(dbPath, missionId)).toBe(site.fromStatus);
          expect(countSessionEvents(dbPath)).toBe(0);
          expect(result.error?.message).toContain(dbErrorText);
          expect(text).toContain(dbErrorText);
          const hidden = { ...result, error: { ...result.error!, message: 'redacted fault' } };
          expect(site.format(hidden)).not.toContain(dbErrorText);
          return;
        }

        // 1. success stays TRUE — the transition happened; only its provenance row did not.
        expect(result.success).toBe(true);

        // 2. the transition really did land, and the trigger really did block only the event row.
        //    Together these prove the failure is the NARROW one this test forces, not a broken store.
        expect(readMissionStatus(dbPath, missionId)).toBe(site.toStatus);
        expect(countSessionEvents(dbPath)).toBe(0);

        // 3. the envelope carries an entry naming the DB error MESSAGE and its CODE. A regression
        //    to a console.warn-only arm empties this array, so the throw names the source site.
        const warnings = result.warnings ?? [];
        const entry = warnings.find((w) => w.includes(dbErrorText));
        if (entry === undefined) {
          throw new Error(
            `${site.surface} swallowed a failed session_events INSERT. Source site: ${site.site}. ` +
              `The DB rejected the row with "${dbErrorText}" and nothing carried that into ` +
              `result.warnings, so the agent is told the transition completed cleanly while its ` +
              `durable provenance row is gone — the exact defect s86-m02b closed. ` +
              `result.warnings = ${JSON.stringify(warnings)}`
          );
        }
        expect(entry).toContain('DB_QUERY_FAILED');

        // 4. THE POINT OF THE MISSION — it is readable in the text an agent gets back.
        expect(text).toContain('Warnings:');
        expect(text).toContain(entry);
        expect(text).toContain(dbErrorText);

        // 5. MUTATION CHECK, run without touching src/: re-format the SAME answer with the
        //    envelope warnings stripped — which is exactly the payload the pre-s86-m02b
        //    console.warn-only handler produced. The DB error must vanish from the text.
        //    This proves the visibility above is carried by result.warnings and is not leaking in
        //    from some other field that would keep the assertion green after a regression.
        const preFixShape = { ...result, warnings: undefined } as RbookToolResult<unknown>;
        expect(site.format(preFixShape)).not.toContain(dbErrorText);
      });

      it(`NEGATIVE CONTROL — ${site.surface} writes a real session_events row and warns about nothing when the DB accepts it`, async () => {
        const { projectRoot, dbPath } = mkStore(`${label}-control`);
        const missionId = `s86-m02b-${label}-ok`;
        seedMission(dbPath, missionId, site.fromStatus);

        const result = await site.run(projectRoot, missionId);
        const text = site.format(result);

        expect(result.success).toBe(true);
        expect(readMissionStatus(dbPath, missionId)).toBe(site.toStatus);
        // The exact mission row the failing case loses. A caller-session start is separate
        // provenance and cannot stand in for this transition's action and resulting status.
        expect(readMissionEvents(dbPath, missionId)).toEqual([
          { action: label, status: site.toStatus },
        ]);

        expect((result.warnings ?? []).filter((w) => /event logging/i.test(w))).toEqual([]);
        expect(text).not.toContain('event logging failed');
        expect(text).not.toContain('DB_QUERY_FAILED');
      });
    }
  );

  it('all six sites are covered — the mission names six, not five and not seven', () => {
    // CORRECTION 5 of the mission contract measured SIX console.warn-only session_events sites.
    // A critic listed seven by including rbook-mission-complete.ts, which was already correct.
    // If a seventh handler grows the same shape, this count is where that shows up.
    expect(SITES.map((s) => s.label)).toEqual([
      'defer',
      'unblock',
      'block',
      'drop',
      'start',
      'update',
    ]);
  });
});

// ─── the site that was already right ─────────────────────────────────────────

/**
 * `rbook-mission-complete.ts` is the SECOND in-file reference implementation for this mission (the
 * first is `rbook-constraints.ts`'s reaffirmConstraint). It already did both halves — the
 * `console.warn` for a local debugging session AND the `warnings.push` that reaches the answer —
 * and the mission's DO-NOT list says to leave it byte-identical so both s86-m02b and s86-m03 can
 * cite the same bytes.
 *
 * The pin is on the TEXT, not on a line number: the s86-m02 formatter commit already shifted this
 * block from line 310 to line 311 without touching a byte of it, and a line-number pin would have
 * gone red for a change that was not the change it exists to catch.
 */
describe('s86-m02b: the already-correct site stays pinned', () => {
  const REFERENCE_BLOCK = [
    "      // Don't fail the operation if event logging fails (non-critical)",
    '      if (!eventResult.success) {',
    "        console.warn('Failed to log mission complete event:', eventResult.error);",
    "        warnings.push('Mission completion event logging failed.');",
    '      }',
  ].join('\n');

  /** The block plus the tail of the INSERT it guards, so it cannot be relocated away from its site. */
  const PINNED_REGION = [
    '            newStatus: targetStatus,',
    '            notes: cleanNotes,',
    '          }),',
    '        ]',
    '      );',
    '',
    REFERENCE_BLOCK,
  ].join('\n');

  const WHY_PINNED =
    'rbook-mission-complete.ts carries the session_events failure block that was ALREADY correct ' +
    'before s86-m02b: it does console.warn AND warnings.push, so the failure reaches the answer. ' +
    'The mission designated it the in-file reference implementation and its DO-NOT list forbids ' +
    'touching it, so that s86-m02b and s86-m03 can both cite the same bytes. If you changed this ' +
    'block — including "improving" it to route through checkWrite — THE CHANGE IS THE DEFECT, ' +
    'not this test. Revert it. If a later mission genuinely retires the reference, retire this ' +
    'pin in the same commit and say so in the mission notes.';

  it('the reference block is byte-unchanged and still guards its own session_events INSERT', () => {
    const source = fs.readFileSync(MISSION_COMPLETE_SRC, 'utf8');

    if (!source.includes(REFERENCE_BLOCK)) {
      throw new Error(`${WHY_PINNED}\n\nExpected to find, verbatim:\n${REFERENCE_BLOCK}`);
    }
    // Exactly once: a second copy would mean the block was moved and a stale one left behind.
    expect(occurrences(source, REFERENCE_BLOCK)).toBe(1);

    if (!source.includes(PINNED_REGION)) {
      throw new Error(
        `${WHY_PINNED}\n\nThe block survives but no longer sits directly under the ` +
          `session_events INSERT it guards. Expected, verbatim:\n${PINNED_REGION}`
      );
    }

    // The specific "improvement" the mission forbids.
    expect(source).not.toContain('checkWrite(eventResult');
  });

  it('and it is LIVE — a forced session_events failure reaches a rbook_mission_transition(complete) answer', async () => {
    // A byte-pin alone would still pass if the block were dead code. Fire it.
    const { projectRoot, dbPath } = mkStore('complete');
    const missionId = 's86-m02b-complete';
    seedMission(dbPath, missionId, 'In Progress');
    forceSessionEventsInsertFailure(dbPath, `s86m02b forced abort complete ${Date.now()}`);

    const result = await runTransition(projectRoot, missionId, 'complete', {
      notes: 'm02b reference-implementation probe',
    });
    const text = transitionFormatter('complete')(result);

    expect(result.success).toBe(true);
    expect(readMissionStatus(dbPath, missionId)).toBe('Completed');
    expect(countSessionEvents(dbPath)).toBe(0);
    expect(result.warnings ?? []).toContain('Mission completion event logging failed.');
    expect(text).toContain('Mission completion event logging failed.');
  });

  it('NEGATIVE CONTROL — the same completion warns about nothing when the DB accepts the event row', async () => {
    const { projectRoot, dbPath } = mkStore('complete-control');
    const missionId = 's86-m02b-complete-ok';
    seedMission(dbPath, missionId, 'In Progress');

    const result = await runTransition(projectRoot, missionId, 'complete', {
      notes: 'm02b reference-implementation control',
    });
    const text = transitionFormatter('complete')(result);

    expect(result.success).toBe(true);
    expect(readMissionEvents(dbPath, missionId)).toEqual([
      { action: 'complete', status: 'Completed' },
    ]);
    expect(result.warnings ?? []).not.toContain('Mission completion event logging failed.');
    expect(text).not.toContain('Mission completion event logging failed.');
  });
});

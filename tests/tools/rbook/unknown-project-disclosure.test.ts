// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s87-m04 — a store with no recorded identity must SAY SO, per store, naming the store.
// ABOUTME: The label stops naming a project that does not exist; the untrusted fence is unchanged.

/**
 * Sprint 87 m04 — WHAT THIS MISSION SUBTRACTS, AND WHAT IT DOES NOT.
 *
 * `getProjectId` falls back to the literal `'unknown-project'` when a store records no identity.
 * Ruling #736 approved that fallback over throwing, on the premise that "every real store carries
 * a non-empty project_id, so the fallback never fires in production". REMEASURED 2026-08-28
 * with immutable SQLite inspection (#1038), using this fleet-discovery command:
 *
 *     find ~ -maxdepth 7 -path '*&#47;cmos/db/cmos.sqlite' -not -path '*&#47;node_modules/*'
 *
 * → #1038's immutable remeasurement: 45 stores; 32 resolve via a recorded `project_id`; 13
 * collapse to the literal; 0 are unclassifiable. The fallback fires on thirteen, and
 * has already fired in production: `derekn.com`'s store carries 217 rows stamped with the literal
 * across six tables.
 *
 * THE RULING SURVIVES; ONLY THE PREMISE IS AMENDED (#1017 / D-8). Three things were actually
 * wrong, and this file gates all three:
 *
 *   1. UNDER-DISCLOSED — `warnedMissingProjectId` was a MODULE-LEVEL boolean, so N identity-less
 *      stores in one process produced ONE stderr line, naming no path. An operator could not tell
 *      which store, or how many.
 *   2. MISNAMED AT THE POINT OF USE — the render emitted `proj:unknown-project`, naming a project
 *      that does not exist, on the PROMPT-INJECTION DEFENCE surface. Nine of `derekn.com`'s
 *      fourteen own sessions render that way, which trains an agent to discount the fence.
 *   3. MANUFACTURED BY THE TARBALL — `schema.ts` seeded three empty-string identity rows, and
 *      `rbook-seed/db/schema.sql` is GENERATED from it, so every published store shipped rows that
 *      satisfy NOT NULL while being semantically absent.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MISSION DOES NOT DO, asserted rather than promised (CUT 7). IT SHIPS NO IDENTITY
 * WRITE — no mint, no heal, no repair. The fleet is not healed. This store is not identified. A
 * store created from the CORRECTED seed still resolves to the literal, and `resolves to the
 * literal after the seed fix` asserts exactly that: if this suite ever goes green by a store
 * resolving to something else, an identity write shipped and CUT 7 was violated.
 *
 * WHY THE WRITE WAS CUT, so it is not re-proposed: routing `getProjectId` to `mintProjectId`
 * DEADLOCKS. `mintProjectId` opens a SECOND read-write connection, and `getProjectId` is reached
 * from inside the sprint closeout's own `BEGIN IMMEDIATE`; a verbatim replay with the lock held
 * gave `elapsed_ms=5203`, `SQLITE_BUSY`, nothing minted, swallowed — twice per close. It also
 * converts `rbook_context(view)`, a READ in the fail-closed taxonomy, into a write to any store an
 * agent can name.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EVERY REAL-CLIENT CONSTRUCTION BELOW PASSES AN EXPLICIT `dbPath`, AND THAT IS NOT STYLE (D-9).
 * At s87-m04 shipment, `client.ts`'s no-explicit-root arm auto-registered the CWD and could mint;
 * explicit dbPath isolated this disclosure test from that independent write. Sprint 88 m08 later
 * split resolution from registration, but dbPath remains the sharpest way for this historical
 * no-identity-write gate to bypass all project-root policy and test only `getProjectId`.
 */

import { resolveRecordPaths } from '../../../src/intelligence/legacy-compat';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { getProjectId } from '../../../src/tools/rbook/genesis-columns';
import {
  RBOOK_CONFIG_DIR_ENV,
  ProjectGraphRegistry,
} from '../../../src/intelligence/project-graph-registry';
import {
  frameInlineIfForeign,
  provenanceTag,
  UNRECORDED_PROJECT_ID,
} from '../../../src/intelligence/provenance-frame';
import { isJestAllowedDbPath } from '../../../src/tools/rbook/real-store-guard';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SEED_SCHEMA = path.join(REPO_ROOT, 'rbook-seed', 'db', 'schema.sql');
const LIVE_DB = resolveRecordPaths(REPO_ROOT).dbPath;
const PRIVATE_HISTORY = requiresPrivateEvidence({
  reason: 'private source-history ranges for the historical CUT-7 proof',
  revisions: {
    m04Start: '1a54a79',
    m04End: '564a2a6',
    oc1Start: 'c1fa8d6',
    oc1End: '8ef5f2e',
  },
});
const historyDescribe = PRIVATE_HISTORY.describe;

/** Resolve the registry this Jest process would actually write to. */
function registryPathForThisRun(): string {
  return path.join(
    process.env[RBOOK_CONFIG_DIR_ENV] ?? path.join(os.homedir(), '.config', 'rbook'),
    'project-graph.sqlite'
  );
}

/** An absent registry or an as-yet-uninitialized schema contains zero project rows. */
function registryRowCount(registryPath: string): number {
  if (!fs.existsSync(registryPath)) return 0;
  const db = new Database(registryPath, { readonly: true });
  try {
    const { n: projectsTables } = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
      .get() as { n: number };
    if (projectsTables === 0) return 0;
    return (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const tmpDirs: string[] = [];
const routedDbPaths: string[] = [];
let registryRowsBefore = 0;
afterAll(() => {
  try {
    ProjectGraphRegistry.resetInstance();
    const registryPath = registryPathForThisRun();
    expect(isJestAllowedDbPath(registryPath)).toBe(true);
    expect(registryRowCount(registryPath)).toBe(registryRowsBefore);
    // Each construction is checked synchronously by recordRoutedDbPath. Recheck the routes that
    // actually ran without assuming Jest selected every test in this file.
    expect(routedDbPaths.every((dbPath) => isSuitePrivateStorePath(dbPath))).toBe(true);
  } finally {
    ProjectGraphRegistry.resetInstance();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

function isSuitePrivateStorePath(dbPath: string): boolean {
  return path.resolve(dbPath) !== path.resolve(LIVE_DB) && isJestAllowedDbPath(dbPath);
}

function recordRoutedDbPath(dbPath: string): void {
  expect(isSuitePrivateStorePath(dbPath)).toBe(true);
  routedDbPaths.push(dbPath);
}

/** A store with a metadata table and NO recorded identity. */
function identitylessStore(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rbook-s87m04-${label}-`));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'rbook.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
  `);
  db.close();
  recordRoutedDbPath(dbPath);
  return dbPath;
}

/** Capture everything written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
  return chunks.join('');
}

/**
 * Sprint 89 m01 — shared-mutable-resource gate sweep, published before this edit.
 *
 * Scope: this file mints no new row into the project-graph registry selected by
 * `RBOOK_CONFIG_DIR`, and every store path this file routes to a client is a Jest-owned path.
 * The whole-tree predicate was run over all 228 test files. Its semantic result is 3 defective
 * files / 8 test gates: this `(d)` gate; six skip-on-absence router-param gates (handed to m06 by
 * the authoritative mission objective); and the separate vacuous size assertion in
 * rbook-review-drift-selfperturbation (repaired in m01). The strict live-root arm found 9 files.
 *
 * Predicate arms (all `rg -n --glob '*.test.ts' ... tests`): `homedir`; `process.env.HOME`;
 * `.config/rbook`; absolute non-temp paths; strict REPO_ROOT/PROJECT_ROOT live-store joins;
 * `existsSync(...) return`; skip selectors; env-guarded returns; mtime/stat assertions; direct
 * Database opens on live/registry path names; and `delete process.env.RBOOK_CONFIG_DIR`.
 * Every other hit was classified genuinely fine: comment/fake-payload literals; recursive-walker
 * terminators; explicit mirror/live-provider skips; fail-loud live-copy sources; readonly stable-
 * schema checks; suite-owned before/after deltas; and captured-then-restored config env changes.
 *
 * False-negative profile — the complements are deliberate and named:
 * - Registry file: a production path that bypasses `RBOOK_CONFIG_DIR`, or passes another explicit
 *   configDir, is invisible here. `(d0)` proves this file's ordinary seam is isolated.
 * - Mint: COUNT(*) sees INSERT/removal deltas, not UPDATE/touch/archive of an existing row.
 * - Routed paths: only client paths explicitly pushed by this file are covered; a hidden
 *   auto-resolution path is the real-store guard's responsibility.
 * - File scope: this gate covers this test file. The published 228-file sweep covers the class.
 */
describe('s87-m04 — an unrecorded identity is disclosed per store, and named honestly', () => {
  beforeAll(() => {
    const configDir = process.env[RBOOK_CONFIG_DIR_ENV];
    if (!configDir) {
      throw new Error(`${RBOOK_CONFIG_DIR_ENV} must isolate this test before registry inspection`);
    }
    const registryPath = path.join(configDir, 'project-graph.sqlite');
    if (!isJestAllowedDbPath(registryPath)) {
      throw new Error(`refusing to inspect non-isolated Jest registry: ${registryPath}`);
    }
    registryRowsBefore = registryRowCount(registryPathForThisRun());
  });

  it('RED (a): THREE identity-less stores in ONE process yield THREE disclosures, each naming its own store', async () => {
    const paths = ['alpha', 'bravo', 'charlie'].map((l) => identitylessStore(l));

    const stderr = await (async () => {
      let captured = '';
      const clients: RbookDatabaseClient[] = [];
      try {
        for (const dbPath of paths) {
          // EXPLICIT dbPath — see the header. Without it this line mints a registry row.
          const created = await RbookDatabaseClient.create({ dbPath });
          expect(created.success).toBe(true);
          clients.push(created.data!);
        }
        captured = captureStderr(() => {
          for (const c of clients) expect(getProjectId(c)).toBe(UNRECORDED_PROJECT_ID);
        });
      } finally {
        for (const c of clients) c.close();
      }
      return captured;
    })();

    // RED: one line, containing no path. The flag was module-level, so store two and three were
    // silent — and the single line an operator did get named only the fallback VALUE.
    for (const dbPath of paths) {
      expect(stderr).toContain(dbPath);
    }
    const disclosures = stderr
      .split('\n')
      .filter((l) => l.includes('NO RECORDED project identity'));
    expect(disclosures).toHaveLength(3);

    // …and it says the identity is UNRECORDED rather than implying a project by that name.
    expect(stderr).toContain('NO RECORDED project identity');
    expect(stderr).toMatch(/fallback label and not a project/i);
  }, 60_000);

  it('discloses ONCE per store, not once per row — the de-duplication survives', async () => {
    const dbPath = identitylessStore('repeat');
    const created = await RbookDatabaseClient.create({ dbPath });
    const client = created.data!;
    try {
      const stderr = captureStderr(() => {
        for (let i = 0; i < 5; i += 1) getProjectId(client);
      });
      expect(
        stderr.split('\n').filter((l) => l.includes('NO RECORDED project identity'))
      ).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 60_000);

  it('RED (b): the NORMALIZED docblock scan finds the falsified premise ZERO times', () => {
    // A plain single-line grep returns 0 even BEFORE the fix and would pass vacuously — the
    // phrase wraps across comment lines. Normalize the ` * ` continuations first, exactly as the
    // criterion specifies. RED at HEAD 1a54a79: 1 hit in each file.
    const PREMISE = /never\s+fires\s+in\s+production|always\s+carry\s+a\s+non-empty\s+project_id/g;
    for (const rel of [
      'src/tools/rbook/genesis-columns.ts',
      'src/tools/rbook/project-id.ts',
      'src/tools/rbook/schema-migrations.ts',
    ]) {
      const normalized = fs
        .readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        .replace(/\n\s*\*\s*/g, ' ');
      expect({ rel, hits: normalized.match(PREMISE) ?? [] }).toEqual({ rel, hits: [] });
    }

    // ANTI-VACUITY: the scanner must be able to see the phrase when it IS present. Without this
    // a broken normalizer would report zero for the wrong reason.
    const planted = 'so the fallback\n * never fires in production.'.replace(/\n\s*\*\s*/g, ' ');
    expect(planted.match(PREMISE)).toHaveLength(1);
  });

  it('RED (c): a store carrying the literal renders UNATTRIBUTED — and is STILL fenced', () => {
    // BOTH halves, and the second is the load-bearing one. De-fencing on the literal would
    // de-fence genuinely FOREIGN content: a pull-merged row from any of the thirteen collapsing
    // stores also carries it. The standing bias is stated twice in this codebase —
    // "fence-more, never fence-less".
    const rendered = frameInlineIfForeign(
      'a row from a store with no identity',
      UNRECORDED_PROJECT_ID,
      'cmos-mcp-pro'
    );

    expect(rendered).not.toContain(`proj:${UNRECORDED_PROJECT_ID}`);
    expect(rendered).toContain('unattributed');
    // THE FENCE IS UNCHANGED.
    expect(rendered).not.toBe('a row from a store with no identity');
    expect(rendered).toMatch(/untrusted/i);

    // A genuinely foreign row from a NAMED project still names it — the change is scoped to the
    // one value that names nothing.
    const named = frameInlineIfForeign('a row', 'shopify-forge', 'cmos-mcp-pro');
    expect(named).toContain('proj:shopify-forge');
    expect(provenanceTag('shopify-forge')).toBe('proj:shopify-forge');
    expect(provenanceTag(UNRECORDED_PROJECT_ID)).toBe('unattributed');
  });

  it('RED (d): the SHIPPED seed carries no empty-string identity row', () => {
    // Reads the GENERATED file, so it guards the tarball rather than a hand-patch — and it fails
    // if the regeneration was skipped. RED at HEAD 1a54a79: three rows at :19-21.
    const sql = fs.readFileSync(SEED_SCHEMA, 'utf8');
    for (const key of ['project_id', 'project_name', 'tracelab_project_id']) {
      expect({
        key,
        seeded: new RegExp(
          `INSERT OR IGNORE INTO metadata \\(key, value\\) VALUES \\('${key}', ''\\)`
        ).test(sql),
      }).toEqual({ key, seeded: false });
    }
    // Non-vacuity: the shipped SQL must actually seed these rows, whatever its INSERT spelling.
    const db = new Database(':memory:');
    try {
      db.exec(sql);
      for (const key of ['schema_version', 'created_at']) {
        expect(db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)).toEqual({
          value: expect.stringMatching(/\S/),
        });
      }
    } finally {
      db.close();
    }
  });

  it('THE ANTI-SYMPTOM GATE: a store from the corrected seed STILL resolves to the literal', async () => {
    // This is what proves the seed fix removed a FALSE CLAIM rather than silently changing
    // resolution. If this ever goes green by resolving to something else, an identity write
    // shipped and CUT 7 was violated.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s87m04-seeded-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'rbook.sqlite');
    recordRoutedDbPath(dbPath);
    const db = new Database(dbPath);
    try {
      db.exec(fs.readFileSync(SEED_SCHEMA, 'utf8'));
    } finally {
      db.close();
    }

    const created = await RbookDatabaseClient.create({ dbPath });
    const client = created.data!;
    try {
      const stderr = captureStderr(() => {
        expect(getProjectId(client)).toBe(UNRECORDED_PROJECT_ID);
      });
      // …and it discloses exactly once, naming the store.
      expect(
        stderr.split('\n').filter((l) => l.includes('NO RECORDED project identity'))
      ).toHaveLength(1);
      expect(stderr).toContain(dbPath);
    } finally {
      client.close();
    }
  }, 60_000);

  /**
   * THE CUT-7 GATE, stated as a NO-DIRECT-IDENTITY-WRITE rule rather than a directory rule.
   *
   * An earlier form of this criterion asserted the mission's diff touches no file under
   * `src/intelligence/` — which the mission's own NON-CUTTABLE step makes impossible, since the
   * two shared tag constructors live in `src/intelligence/provenance-frame.ts`. A criterion that
   * fails deterministically when its mission succeeds is the same defect class as one that cannot
   * fail. Both plan-time critic lenses found that independently.
   */
  historyDescribe('CUT 7 — no direct identity-write effect, asserted mechanically', () => {
    /**
     * The diff attributable to THIS MISSION, pinned to its own commit range.
     *
     * s87-m04, CORRECTED DURING s87-m07. This originally read `git diff HEAD`, i.e. the whole
     * uncommitted working tree. That was right for exactly as long as m04 was the mission being
     * built, and wrong from the moment m07 started editing `src/intelligence/credential-store.ts`
     * — at which point this gate reported that m04 had touched a file m04 never opened. A
     * criterion that says "the diff attributable to THIS mission" and measures "everything
     * uncommitted" is a surface asserting something that is not so, which is the class the
     * mission it guards exists to close.
     *
     * Pinned to m04's own commits. If m04 is ever amended or rebased these SHAs move with it,
     * and the range — not the working tree — is what the criterion has always meant.
     */
    /**
     * s87-m08 — RESOLVE THE RANGE BEFORE DIFFING IT, so an environment that cannot see m04's
     * commits says so instead of dying on git's "unknown revision" prose.
     *
     * This gate first ran red in CI, not locally: `actions/checkout` clones at depth 1, so
     * neither SHA existed and the failure named a file and a line but not the cause. The
     * workflows now set `fetch-depth: 0`. The check stays a FAILURE rather than a skip — a gate
     * that quietly passes when it cannot observe its subject is the defect this sprint is about,
     * and a skipped gate reports green.
     */
    function commitRangeDiff(start: string, end: string): string {
      for (const sha of [start, end]) {
        try {
          execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
            cwd: REPO_ROOT,
            stdio: 'ignore',
          });
        } catch {
          throw new Error(
            `commit ${sha} is not present in this clone, so CUT-7 cannot observe the pinned ` +
              `${start}..${end} diff. ` +
              `This is a SHALLOW-CHECKOUT problem, not a code problem: set fetch-depth: 0 on ` +
              `actions/checkout. Refusing to report green on an unobserved criterion.`
          );
        }
      }
      return execFileSync('git', ['diff', '-U0', `${start}..${end}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    }

    function missionDiff(): string {
      return commitRangeDiff(PRIVATE_HISTORY.revisions.m04Start, PRIVATE_HISTORY.revisions.m04End);
    }

    function forbiddenIdentityWriteAdditions(diff: string): string[] {
      // Classify the forbidden DIRECT EFFECT, not a list of four historical spellings. Added
      // lines that are consecutive in one diff hunk are normalized together, so formatting an
      // SQL statement over several lines does not hide it. The SQL shape catches identity-bearing
      // writes even when the table is interpolated; the graph shape catches the two APIs whose
      // contract is to mint/register project identity.
      //
      // FALSE-NEGATIVE PROFILE. This is a diff-text gate, not whole-program effect analysis. It
      // does not infer an indirect call through an innocently named pre-existing wrapper, SQL
      // assembled from non-consecutive additions/unchanged context, computed subject names that
      // contain no identity-bearing token, or a new write API outside the two named graph calls.
      // Those are the exact complement of "direct effect visible in consecutive added src/scripts
      // code" in the scope sentence above. Comments are excluded by rule because this mission had
      // to explain the forbidden effect in prose.
      const identityWriteEffects = [
        /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE)\b[^;]{0,500}?\b(?:metadata|project_id|project_name|tracelab_project_id|rbook_address)\b/gi,
        /\b(?:mintProjectId|registerStore)\s*\(/g,
      ];
      let currentFile = '';
      const offenders: string[] = [];
      let addedBlock: string[] = [];

      const flushAddedBlock = (): void => {
        if (addedBlock.length === 0 || !/^(src|scripts)\//.test(currentFile)) {
          addedBlock = [];
          return;
        }
        const normalized = addedBlock.join(' ').replace(/\s+/g, ' ').trim();
        for (const effect of identityWriteEffects) {
          for (const match of normalized.matchAll(effect)) {
            offenders.push(`${currentFile}: ${match[0]}`);
          }
        }
        addedBlock = [];
      };

      for (const line of diff.split('\n')) {
        const header = line.match(/^\+\+\+ b\/(.+)$/);
        if (header) {
          flushAddedBlock();
          currentFile = header[1];
          continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
          const t = line.slice(1).trim();
          if (
            t &&
            !t.startsWith('//') &&
            !t.startsWith('/*') &&
            !t.startsWith('*') &&
            !t.startsWith('--')
          ) {
            addedBlock.push(t);
          }
        } else {
          flushAddedBlock();
        }
      }
      flushAddedBlock();
      return offenders;
    }

    it('(a) touches no identity-resolution or minting surface', () => {
      const diff = missionDiff();
      const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
      const forbidden = [
        'src/intelligence/project-graph-registry.ts',
        'src/intelligence/project-resolution.ts',
      ];
      expect(changedFiles.filter((f) => forbidden.includes(f))).toEqual([]);
    });

    it('(b) adds no mint, no register, and no metadata write to SHIPPED code', () => {
      // TWO exclusions, each by a stated rule rather than by allowlist.
      //
      // 1. SCOPE IS `src/` AND `scripts/`. A test that PROVES the absence of a metadata write has
      //    to name the thing it is proving absent — this very file, and the seed-stamp gate, both
      //    carry `INTO metadata` inside a regex. Failing the mission because its own gate quotes
      //    the pattern it gates would be a criterion that fails when the mission succeeds, which
      //    is the exact shape both plan-time critic lenses rejected in the first draft of this
      //    criterion.
      // 2. COMMENTS ARE EXCLUDED. This mission's whole job is to describe the fallback honestly,
      //    so it necessarily discusses minting in prose. Code is what may not do it.
      expect(forbiddenIdentityWriteAdditions(missionDiff())).toEqual([]);

      // ANTI-VACUITY: the scanner must actually be reading src/ lines, or it proves nothing.
      const srcAdds = missionDiff()
        .split('\n')
        .reduce(
          (acc, line) => {
            const header = line.match(/^\+\+\+ b\/(.+)$/);
            if (header) return { file: header[1], n: acc.n };
            if (line.startsWith('+') && !line.startsWith('+++') && /^src\//.test(acc.file)) {
              return { file: acc.file, n: acc.n + 1 };
            }
            return acc;
          },
          { file: '', n: 0 }
        ).n;
      expect(srcAdds).toBeGreaterThan(0);
    });

    it('(b1) ANTI-VACUITY: catches an effect-shaped project identity write', () => {
      const planted = [
        'diff --git a/scripts/planted.ts b/scripts/planted.ts',
        '+++ b/scripts/planted.ts',
        '+db.prepare(`UPDATE ${table} SET project_id = ?`).run(projectId);',
      ].join('\n');

      expect(forbiddenIdentityWriteAdditions(planted)).toEqual([
        'scripts/planted.ts: UPDATE ${table} SET project_id',
      ]);
    });

    it('(b1a) ANTI-VACUITY: catches the same identity write when its SQL spans lines', () => {
      const planted = [
        'diff --git a/scripts/planted.ts b/scripts/planted.ts',
        '+++ b/scripts/planted.ts',
        '+db.prepare(`',
        '+  UPDATE ${table}',
        '+  SET project_id = ?',
        '+  WHERE legacy = 1',
        '+`).run(projectId);',
      ].join('\n');

      expect(forbiddenIdentityWriteAdditions(planted)).toHaveLength(1);
    });

    it('(b1b) ANTI-VACUITY: catches direct SQL assembled across adjacent string literals', () => {
      const planted = [
        'diff --git a/scripts/planted.ts b/scripts/planted.ts',
        '+++ b/scripts/planted.ts',
        "+db.prepare('UPDATE ' + table + ' SET project_id = ?').run(projectId);",
      ].join('\n');

      expect(forbiddenIdentityWriteAdditions(planted)).toHaveLength(1);
    });

    it('(b2) POSITIVE FIRE: catches the identity rewrite in the pinned OC-1 commit', () => {
      expect(
        forbiddenIdentityWriteAdditions(
          commitRangeDiff(PRIVATE_HISTORY.revisions.oc1Start, PRIVATE_HISTORY.revisions.oc1End)
        )
      ).toEqual(['scripts/repair-unknown-project.ts: UPDATE ${table} SET project_id']);
    });

    it('(c) the only src/intelligence/ file it touches is the tag constructor', () => {
      const changedFiles = [...missionDiff().matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
      const intelligence = changedFiles.filter((f) => f.startsWith('src/intelligence/'));
      expect(intelligence.every((f) => f === 'src/intelligence/provenance-frame.ts')).toBe(true);
    });

    it('(d0) the harness gives this file an isolated RBOOK_CONFIG_DIR', () => {
      const dir = process.env[RBOOK_CONFIG_DIR_ENV];
      expect(dir).toBeDefined();
      // Named home-path comparison only: this assertion never opens the operator registry.
      expect(path.resolve(dir!)).not.toBe(
        path.resolve(path.join(os.homedir(), '.config', 'rbook'))
      );
    });

    it('(d) the client-route oracle rejects LIVE_DB and accepts a Jest-owned path', () => {
      // recordRoutedDbPath applies this oracle immediately to every real client route; the
      // order-independent afterAll gate rechecks whichever routes a filtered Jest run selected
      // and compares the final registry count with the beforeAll baseline.
      expect(isSuitePrivateStorePath(LIVE_DB)).toBe(false);
      expect(
        isSuitePrivateStorePath(path.join(os.tmpdir(), 'rbook-s89-private-fire', 'rbook.sqlite'))
      ).toBe(true);
    });

    it('(d1) ANTI-VACUITY: a real mint moves an absent registry from zero to one', async () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s89-registry-fire-'));
      tmpDirs.push(configDir);
      const registryPath = path.join(configDir, 'project-graph.sqlite');
      expect(fs.existsSync(registryPath)).toBe(false);
      const before = registryRowCount(registryPath);
      expect(before).toBe(0);

      ProjectGraphRegistry.resetInstance();
      try {
        const registry = await ProjectGraphRegistry.create({ configDir });
        registry.register({
          project_id: 'anti-vacuity-fire',
          store_path: path.join(configDir, 'store'),
          name: 'anti-vacuity fire',
        });
      } finally {
        ProjectGraphRegistry.resetInstance();
      }

      const after = registryRowCount(registryPath);
      expect(after - before).toBe(1);
      expect(after).not.toBe(before);
    });
  });
});

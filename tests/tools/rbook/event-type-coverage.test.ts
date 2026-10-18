/**
 * Sprint 69 m03 — event_type coverage guard (s68 ADR §2.4).
 *
 * Walks every `INSERT INTO <firehose_table>` site in src/ and asserts the row is
 * stamped with the genesis columns — either a literal `event_type` in the column
 * list, or a `genesisColumns(...)` splice (`g.columns` / `genesis.columns`, incl.
 * the dynamic-column-builder form). Because event_type has NO DEFAULT, an INSERT
 * that omits it fails at runtime; this test catches such a regression pre-merge.
 *
 * @module tests/tools/rbook/event-type-coverage
 */

import * as fs from 'fs';
import * as path from 'path';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

/**
 * Files intentionally exempt from the genesis-stamp requirement: none. s96-m01 removed the last,
 * rbook-project-init.ts, which left its first sprint and missions for the lazy backfill; a store
 * zipped before its first write then gave those rows a different stable id on every copy. It now
 * stamps them through rawGenesisColumns (a `g.columns` splice, which the rule below reads).
 *
 * (Sprint 76 Great Deletion removed the former sqlite-client.ts exemption — the
 * dead legacy SQLiteClient was deleted in G2, so it no longer needs allowlisting.)
 */
const ALLOWLIST = new Set<string>([]);

const FIREHOSE_RE = FIREHOSE_TABLES.join('|');
// An INSERT into a firehose table, capturing the column-list region up to VALUES/SELECT.
const INSERT_RE = new RegExp(
  `INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(${FIREHOSE_RE})\\b([\\s\\S]*?)(?:VALUES|SELECT)\\b`,
  'gi'
);
// The genesis stamp present in the column-list region: a literal event_type or a
// genesisColumns splice (g.columns / genesis.columns).
const STAMP_RE = /\bevent_type\b|\bg\.columns\b|\bgenesis\.columns\b/;
// A dynamic column list interpolating a variable (e.g. `(${insertColumns})`).
const DYNAMIC_RE = /\(\s*\$\{[\w.]+\}\s*\)/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface InsertSite {
  file: string;
  rel: string;
  table: string;
  columnRegion: string;
  fileContent: string;
}

function collectFirehoseInserts(): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    INSERT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSERT_RE.exec(content)) !== null) {
      sites.push({ file, rel, table: m[1], columnRegion: m[2], fileContent: content });
    }
  }
  return sites;
}

describe('event_type coverage (Sprint 69 m03)', () => {
  const sites = collectFirehoseInserts();

  it('finds the expected firehose INSERT sites in production code', () => {
    // Sanity floor: the sweep wired ~20+ production sites. If this drops sharply,
    // the regex broke or sites were deleted — fail so we notice.
    const production = sites.filter((s) => !ALLOWLIST.has(s.rel));
    expect(production.length).toBeGreaterThanOrEqual(18);
  });

  it('stamps event_type on every production firehose INSERT', () => {
    const violations: string[] = [];
    for (const site of sites) {
      if (ALLOWLIST.has(site.rel)) continue;
      const hasStamp = STAMP_RE.test(site.columnRegion);
      // The dynamic-builder site uses `(${insertColumns})`; accept it only when the
      // file also extends that list via genesisColumns (genesis.columns / g.columns).
      const isDynamicStamped =
        DYNAMIC_RE.test(site.columnRegion) && /\b(?:g|genesis)\.columns\b/.test(site.fileContent);
      if (!hasStamp && !isDynamicStamped) {
        violations.push(`${site.rel}: INSERT INTO ${site.table} omits the genesis stamp`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the allowlist tightly scoped (no silent additions)', () => {
    expect([...ALLOWLIST]).toEqual([]);
  });
});

// ─── s85-m04 (#487): mission_id coverage on the mission-scoped firehose tables ───

/**
 * The tables where a row can belong to a mission. `constraints` and `context_snapshots` are
 * deliberately OUT — neither carries a `mission_id` column today (adding one is a schema
 * change queued for s86), so requiring the stamp here would fail on every insert.
 */
const MISSION_SCOPED_TABLES = new Set(['strategic_decisions', 'learnings', 'next_steps']);

/**
 * SEPARATE from the `ALLOWLIST` above, and it must stay that way.
 *
 * That set gates BOTH the `event_type` assertion and the `production.length >= 18` site-count
 * floor. Adding files to it to satisfy THIS block would silently exempt them from the standing
 * s69-m03 event_type gate — a green-suite regression of a Process Hardening #2 gate.
 *
 * EMPTY by design. The one INSERT that lacks a literal `mission_id` is the JSDoc example in
 * genesis-columns.ts, and the sweep strips block comments rather than allowlisting the file —
 * a rule, not an exception. Files considered and correctly NOT needed here:
 *   - sync-merge.ts    — already stamps mission_id (column lists + value binds)
 *   - sync-pull.ts     — contains zero SQL INSERTs
 *   - sync-bootstrap.ts — a JS object literal (`missionId: null`), invisible to the regex
 */
const MISSION_ID_ALLOWLIST = new Set<string>([]);

/** Strip `/* … *\/` blocks so a documentation example is never a candidate. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Re-derive the INSERT sites from COMMENT-STRIPPED source, so a documentation example inside a
 * `/* … *\/` block is never a candidate. This is the rule that lets MISSION_ID_ALLOWLIST stay
 * empty: genesis-columns.ts's JSDoc INSERT example is excluded structurally, not by name.
 */
function collectMissionScopedInserts(): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const content = stripBlockComments(fs.readFileSync(file, 'utf8'));
    INSERT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSERT_RE.exec(content)) !== null) {
      if (!MISSION_SCOPED_TABLES.has(m[1])) continue;
      sites.push({ file, rel, table: m[1], columnRegion: m[2], fileContent: content });
    }
  }
  return sites;
}

describe('mission_id coverage on mission-scoped inserts (s85-m04, #487)', () => {
  const sites = collectMissionScopedInserts();

  it('finds the expected mission-scoped INSERT sites', () => {
    // Floor, not an exact count — new legitimate sites are fine, a collapse is not.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('stamps mission_id on every mission-scoped production INSERT', () => {
    const violations: string[] = [];
    for (const site of sites) {
      if (MISSION_ID_ALLOWLIST.has(site.rel)) continue;
      const hasLiteral = /\bmission_id\b/.test(site.columnRegion);
      // Port the dynamic-builder handling from the event_type block: a `(${cols})` column list
      // is accepted only when the FILE also pushes mission_id into that list. File-wide is the
      // best this can do — see the false-negative note below.
      const isDynamicStamped =
        DYNAMIC_RE.test(site.columnRegion) &&
        /columns\.push\('mission_id'\)/.test(site.fileContent);
      if (!hasLiteral && !isDynamicStamped) {
        violations.push(`${site.rel}: INSERT INTO ${site.table} omits mission_id`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps its OWN allowlist empty and never touches the event_type one', () => {
    expect([...MISSION_ID_ALLOWLIST]).toEqual([]);
    // Byte-identical guard: if a future change widens the shared ALLOWLIST to satisfy this
    // block, this assertion and the event_type block's own both fail loudly. s96-m01 emptied it.
    expect([...ALLOWLIST]).toEqual([]);
  });
});

/**
 * FALSE-NEGATIVE PROFILE — state it plainly, because a green gate reads as proof:
 *
 *  - It is REGEX-based, not a TypeScript AST walk.
 *  - It walks SRC_ROOT only. A future backfill script under `scripts/` is invisible to it.
 *  - The dynamic-column site can only be checked FILE-WIDE, not per-INSERT.
 *  - Above all: it asserts the column is PRESENT IN THE SQL TEXT. It never checks the VALUE
 *    bound to the placeholder. rbook-session-complete.ts's capture-sourced next_steps insert
 *    carried `mission_id` in its column list throughout the entire period next_steps
 *    accumulated 493 NULLs — this gate would have been green the whole time.
 *
 * That last point is exactly why the real-store positive fire in
 * tests/tools/rbook/mission-id-provenance.test.ts is mandatory rather than optional.
 */

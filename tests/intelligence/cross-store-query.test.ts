// ABOUTME: Cross-store reads merge bounded source rows and isolate store failures without permitting writes.
// ABOUTME: Legacy callbacks and explicit discovery snapshots preserve attribution and hook deadlines.

/**
 * Sprint 69 m06 — cross-store fan-out read API tests.
 *
 * Covers queryAcrossStores: basic 3-store merge, tie-breaking by
 * (occurred_at, origin_seq, project_id), per-store failure isolation, read-only
 * enforcement, latency instrumentation, the four named portfolio queries against a
 * 5-store fixture, the concurrency cap at N=50, and the rbook_decisions(acrossProjects)
 * tool integration.
 *
 * @module tests/intelligence/cross-store-query
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  queryAcrossStores,
  openStoreReadOnly,
  storeDbPath,
  type CrossStoreRow,
} from '../../src/intelligence/cross-store-query';
import {
  decisionsAcrossProjects,
  activeMissionsAcrossProjects,
  learningsTaggedAcrossProjects,
  citationGraphAcrossProjects,
} from '../../src/intelligence/cross-store-queries';
import {
  ProjectGraphRegistry,
  type ProjectGraphEntry,
} from '../../src/intelligence/project-graph-registry';
import { rbookDecisionsList } from '../../src/tools/rbook/rbook-decisions-list';

interface DecisionSeed {
  id: number;
  text: string;
  occurred_at: number;
  origin_seq: number;
  evidence?: string;
  created_at?: string;
  project_domain?: string;
  sprint_id?: string;
  category?: string;
}
interface MissionSeed {
  id: string;
  name: string;
  status: string;
  occurred_at: number;
  origin_seq: number;
}
interface LearningSeed {
  id: number;
  content: string;
  category: string;
  occurred_at: number;
  origin_seq: number;
}

describe('cross-store fan-out read API (Sprint 69 m06)', () => {
  let tmpDir: string;
  let configDir: string;
  let prevConfigEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xstore-test-'));
    configDir = path.join(tmpDir, 'config');
    prevConfigEnv = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = prevConfigEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a synthetic store with the firehose per-row columns + seeded rows. */
  function makeStore(
    projectId: string,
    seed: { decisions?: DecisionSeed[]; missions?: MissionSeed[]; learnings?: LearningSeed[] } = {}
  ): string {
    const root = path.join(tmpDir, 'projects', projectId);
    const dbPath = storeDbPath(root);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY, decision_text TEXT, sprint_id TEXT, mission_id TEXT,
        project_domain TEXT, category TEXT, status TEXT DEFAULT 'active', evidence TEXT,
        created_at TEXT, occurred_at INTEGER, origin_seq INTEGER,
        event_type TEXT, stable_event_id TEXT, project_id TEXT
      );
      CREATE TABLE missions (
        id TEXT PRIMARY KEY, name TEXT, status TEXT,
        occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, project_id TEXT
      );
      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY, content TEXT, category TEXT,
        occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, project_id TEXT
      );
    `);
    const insD = db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, sprint_id, project_domain, category, evidence, created_at, occurred_at, origin_seq, event_type, stable_event_id, project_id)
       VALUES (@id, @text, @sprint_id, @project_domain, @category, @evidence, @created_at, @occurred_at, @origin_seq, 'decision_captured', @sid, @project_id)`
    );
    for (const d of seed.decisions ?? []) {
      insD.run({
        id: d.id,
        text: d.text,
        sprint_id: d.sprint_id ?? null,
        project_domain: d.project_domain ?? null,
        category: d.category ?? null,
        evidence: d.evidence ?? null,
        created_at: d.created_at ?? new Date(d.occurred_at).toISOString(),
        occurred_at: d.occurred_at,
        origin_seq: d.origin_seq,
        sid: `01J${projectId}${d.id}`.padEnd(26, '0').slice(0, 26),
        project_id: projectId,
      });
    }
    const insM = db.prepare(
      `INSERT INTO missions (id, name, status, occurred_at, origin_seq, event_type, project_id)
       VALUES (@id, @name, @status, @occurred_at, @origin_seq, 'mission_added', @project_id)`
    );
    for (const m of seed.missions ?? []) {
      insM.run({ ...m, project_id: projectId });
    }
    const insL = db.prepare(
      `INSERT INTO learnings (id, content, category, occurred_at, origin_seq, event_type, project_id)
       VALUES (@id, @content, @category, @occurred_at, @origin_seq, 'learning_captured', @project_id)`
    );
    for (const l of seed.learnings ?? []) {
      insL.run({ ...l, project_id: projectId });
    }
    db.close();
    return root;
  }

  async function registryWith(
    roots: Array<{ projectId: string; root: string }>
  ): Promise<ProjectGraphRegistry> {
    const reg = await ProjectGraphRegistry.create({ configDir });
    for (const { projectId, root } of roots) {
      reg.register({ project_id: projectId, store_path: root, name: projectId });
    }
    return reg;
  }

  it('filters transferred decision and learning rows inside every named fanout before its cap', async () => {
    const now = Date.now();
    const root = makeStore('fork-source', {
      decisions: [
        {
          id: 1,
          text: 'hidden',
          occurred_at: now,
          origin_seq: 1,
          evidence: '[{"type":"report","id":"x"}]',
        },
        {
          id: 2,
          text: 'visible',
          occurred_at: now - 1,
          origin_seq: 2,
          evidence: '[{"type":"report","id":"x"}]',
        },
      ],
      learnings: [
        { id: 1, content: 'hidden lesson', category: 'tag', occurred_at: now, origin_seq: 1 },
        { id: 2, content: 'visible lesson', category: 'tag', occurred_at: now - 1, origin_seq: 2 },
      ],
    });
    const sibling = makeStore('other', {
      decisions: [
        {
          id: 3,
          text: 'other',
          occurred_at: now - 2,
          origin_seq: 1,
          evidence: '[{"type":"report","id":"x"}]',
        },
      ],
    });
    const db = new Database(storeDbPath(root));
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
    for (const kind of ['decision', 'learning'])
      db.prepare('INSERT INTO metadata VALUES(?,?)').run(
        `spin_out_row:${kind}:1`,
        JSON.stringify({
          operationId: 'fork',
          sourceProjectId: 'fork-source',
          sourceRoot: root,
          sourceId: 1,
          targetProjectId: 'other',
          targetRoot: sibling,
          targetId: 1,
        })
      );
    db.close();
    const registry = await registryWith([
      { projectId: 'fork-source', root },
      { projectId: 'other', root: sibling },
    ]);
    expect(
      (await decisionsAcrossProjects({ registry, limit: 1 })).results.map((row) => row.id)
    ).toEqual([2]);
    expect(
      (await learningsTaggedAcrossProjects('tag', { registry, limit: 1 })).results.map(
        (row) => row.id
      )
    ).toEqual([2]);
    const clusters = await citationGraphAcrossProjects({ registry, limit: 3 });
    expect(clusters.clusters[0].members.map((row) => row.decisionId)).toEqual([2, 3]);
    expect(
      (await rbookDecisionsList({ acrossProjects: true, pageSize: 1 })).data?.decisions.map(
        (row) => row.id
      )
    ).toEqual([2]);
  });
  // ── (a) basic merge across 3 stores ─────────────────────────────────────────
  it('merges decisions newest-first across 3 stores with project attribution', async () => {
    const a = makeStore('a', {
      decisions: [{ id: 1, text: 'A-old', occurred_at: 100, origin_seq: 1 }],
    });
    const b = makeStore('b', {
      decisions: [{ id: 1, text: 'B-new', occurred_at: 300, origin_seq: 1 }],
    });
    const c = makeStore('c', {
      decisions: [{ id: 1, text: 'C-mid', occurred_at: 200, origin_seq: 1 }],
    });
    const registry = await registryWith([
      { projectId: 'a', root: a },
      { projectId: 'b', root: b },
      { projectId: 'c', root: c },
    ]);

    const res = await queryAcrossStores<CrossStoreRow & { decision_text: string }>({
      sql: 'SELECT project_id, decision_text, occurred_at, origin_seq FROM strategic_decisions',
      registry,
    });
    expect(res.results.map((r) => r.decision_text)).toEqual(['B-new', 'C-mid', 'A-old']);
    expect(res.results.map((r) => r.project_id)).toEqual(['b', 'c', 'a']);
    expect(res.errors).toEqual([]);
    expect(res.metadata.storesSucceeded).toBe(3);
  });

  // ── (b) tie-breaking by origin_seq then project_id ──────────────────────────
  it('breaks same-occurred_at ties by origin_seq, then project_id', async () => {
    // All three share occurred_at=500. Within a store, origin_seq orders; across
    // stores at the same (occurred_at, origin_seq), project_id ascending tiebreaks.
    const z = makeStore('z', {
      decisions: [
        { id: 1, text: 'z-seq2', occurred_at: 500, origin_seq: 2 },
        { id: 2, text: 'z-seq1', occurred_at: 500, origin_seq: 1 },
      ],
    });
    const m = makeStore('m', {
      decisions: [{ id: 1, text: 'm-seq2', occurred_at: 500, origin_seq: 2 }],
    });
    const registry = await registryWith([
      { projectId: 'z', root: z },
      { projectId: 'm', root: m },
    ]);

    const res = await queryAcrossStores<CrossStoreRow & { decision_text: string }>({
      sql: 'SELECT project_id, decision_text, occurred_at, origin_seq FROM strategic_decisions',
      registry,
    });
    // desc: highest origin_seq first; at (500,2) project_id 'm' < 'z' so m-seq2 before z-seq2.
    expect(res.results.map((r) => r.decision_text)).toEqual(['m-seq2', 'z-seq2', 'z-seq1']);
  });

  // ── (c) per-store failure isolation ─────────────────────────────────────────
  it('isolates a per-store failure: one unreadable store, others succeed', async () => {
    const good1 = makeStore('g1', {
      decisions: [{ id: 1, text: 'g1', occurred_at: 100, origin_seq: 1 }],
    });
    const good2 = makeStore('g2', {
      decisions: [{ id: 1, text: 'g2', occurred_at: 200, origin_seq: 1 }],
    });
    const bogusRoot = path.join(tmpDir, 'projects', 'gone'); // no DB file under it
    const registry = await registryWith([
      { projectId: 'g1', root: good1 },
      { projectId: 'g2', root: good2 },
      { projectId: 'gone', root: bogusRoot },
    ]);

    const res = await queryAcrossStores<CrossStoreRow & { decision_text: string }>({
      sql: 'SELECT project_id, decision_text, occurred_at, origin_seq FROM strategic_decisions',
      registry,
    });
    expect(res.results.map((r) => r.decision_text)).toEqual(['g2', 'g1']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].projectId).toBe('gone');
    expect(res.metadata.storesSucceeded).toBe(2);
    expect(res.metadata.storesFailed).toBe(1);
  });

  // ── (d) read-only enforcement ───────────────────────────────────────────────
  it('opens stores read-only: a write attempt throws', () => {
    const root = makeStore('ro', {
      decisions: [{ id: 1, text: 'x', occurred_at: 1, origin_seq: 1 }],
    });
    const db = openStoreReadOnly(root);
    try {
      expect(() =>
        db.prepare("INSERT INTO strategic_decisions (id, decision_text) VALUES (99, 'nope')").run()
      ).toThrow(/readonly|read.only/i);
    } finally {
      db.close();
    }
  });

  // ── (e) latency instrumentation ─────────────────────────────────────────────
  it('reports per-store + overall latency instrumentation', async () => {
    const a = makeStore('a', {
      decisions: [{ id: 1, text: 'a', occurred_at: 100, origin_seq: 1 }],
    });
    const b = makeStore('b', {
      decisions: [{ id: 1, text: 'b', occurred_at: 200, origin_seq: 1 }],
    });
    const registry = await registryWith([
      { projectId: 'a', root: a },
      { projectId: 'b', root: b },
    ]);
    // Deterministic monotonic clock: each call advances by 1.
    let t = 0;
    const clock = (): number => ++t;

    const res = await queryAcrossStores<CrossStoreRow>(
      { sql: 'SELECT project_id, occurred_at, origin_seq FROM strategic_decisions', registry },
      clock
    );
    expect(res.metadata.perStoreMs).toHaveLength(2);
    for (const ms of res.metadata.perStoreMs) expect(ms).toBeGreaterThanOrEqual(0);
    expect(res.metadata.perStoreP95Ms).not.toBeNull();
    expect(res.metadata.perStoreMs).toContain(res.metadata.perStoreP95Ms);
    expect(res.metadata.overallMs).toBeGreaterThanOrEqual(Math.max(...res.metadata.perStoreMs));
  });

  // ── (f) the four named Reasonbook queries against a 5-store fixture ────────────────
  it('the four named portfolio queries fan out correctly across 5 stores', async () => {
    const now = 10_000_000_000_000; // fixed clock
    const day = 24 * 60 * 60 * 1000;
    const roots: Array<{ projectId: string; root: string }> = [];
    for (let i = 0; i < 5; i++) {
      const pid = `p${i}`;
      const root = makeStore(pid, {
        decisions: [
          {
            id: 1,
            text: `${pid}-recent`,
            occurred_at: now - day,
            origin_seq: 1,
            evidence: '[{"type":"report","id":"R1"}]',
          },
          { id: 2, text: `${pid}-old`, occurred_at: now - 60 * day, origin_seq: 2 },
        ],
        missions: [
          {
            id: `${pid}-m1`,
            name: 'active',
            status: 'In Progress',
            occurred_at: now - day,
            origin_seq: 1,
          },
          {
            id: `${pid}-m2`,
            name: 'done',
            status: 'Completed',
            occurred_at: now - day,
            origin_seq: 2,
          },
        ],
        learnings: [
          {
            id: 1,
            content: `${pid}-learn`,
            category: 'technical',
            occurred_at: now - day,
            origin_seq: 1,
          },
        ],
      });
      roots.push({ projectId: pid, root });
    }
    const registry = await registryWith(roots);

    // (a) decisions in last 30 days → only the 5 "recent" ones (old are 60 days back).
    const decisions = await decisionsAcrossProjects({ days: 30, now, registry });
    expect(decisions.results).toHaveLength(5);
    expect(decisions.results.every((d) => d.decision_text.endsWith('-recent'))).toBe(true);

    // (b) active missions → 5 "In Progress" (Completed excluded).
    const missions = await activeMissionsAcrossProjects({ registry });
    expect(missions.results).toHaveLength(5);
    expect(missions.results.every((m) => m.status === 'In Progress')).toBe(true);
    const expired = await activeMissionsAcrossProjects({ registry, deadlineAtMs: Date.now() - 1 });
    expect(expired.results).toEqual([]);
    expect(expired.errors).toHaveLength(5);
    expect(expired.errors.every((error) => /deadline/.test(error.error))).toBe(true);

    // (c) learnings tagged 'technical' → 5.
    const learnings = await learningsTaggedAcrossProjects('technical', { registry });
    expect(learnings.results).toHaveLength(5);
    expect(learnings.results.every((l) => l.category === 'technical')).toBe(true);

    // (d) co-citation: all 5 "recent" decisions cite report R1 → one cross-project cluster of 5.
    const graph = await citationGraphAcrossProjects({ registry });
    expect(graph.clusters).toHaveLength(1);
    expect(graph.clusters[0].evidenceRef).toBe('report:R1');
    expect(graph.clusters[0].projectIds).toHaveLength(5);
    expect(graph.clusters[0].members).toHaveLength(5);
  });

  // ── (g) concurrency cap at N=50 (no file-handle exhaustion) ──────────────────
  it('handles N=50 stores under a small concurrency cap without exhausting handles', async () => {
    const roots: Array<{ projectId: string; root: string }> = [];
    for (let i = 0; i < 50; i++) {
      const pid = `n${String(i).padStart(2, '0')}`;
      const root = makeStore(pid, {
        decisions: [{ id: 1, text: pid, occurred_at: 1000 + i, origin_seq: 1 }],
      });
      roots.push({ projectId: pid, root });
    }
    const registry = await registryWith(roots);

    const res = await queryAcrossStores<CrossStoreRow & { decision_text: string }>({
      sql: 'SELECT project_id, decision_text, occurred_at, origin_seq FROM strategic_decisions',
      registry,
      concurrency: 8,
      limit: 100,
    });
    expect(res.errors).toEqual([]);
    expect(res.metadata.storesSucceeded).toBe(50);
    expect(res.results).toHaveLength(50);
    // newest-first: occurred_at 1049 (n49) down to 1000 (n00).
    expect(res.results[0].decision_text).toBe('n49');
    expect(res.results[49].decision_text).toBe('n00');
  });

  it('respects the global limit and reports truncation', async () => {
    const roots: Array<{ projectId: string; root: string }> = [];
    for (let i = 0; i < 3; i++) {
      const pid = `t${i}`;
      const root = makeStore(pid, {
        decisions: [
          { id: 1, text: `${pid}-a`, occurred_at: 100 + i * 10, origin_seq: 1 },
          { id: 2, text: `${pid}-b`, occurred_at: 50 + i * 10, origin_seq: 2 },
        ],
      });
      roots.push({ projectId: pid, root });
    }
    const registry = await registryWith(roots);
    const res = await queryAcrossStores<CrossStoreRow>({
      sql: 'SELECT project_id, occurred_at, origin_seq FROM strategic_decisions',
      registry,
      limit: 2,
    });
    expect(res.results).toHaveLength(2);
    expect(res.metadata.truncated).toBe(true);
  });

  it('does NOT report truncation when exactly `limit` rows exist and no store was capped', async () => {
    // 2 stores × 1 row each = 2 total; limit 2. We emit all 2, and neither store
    // hit its pushdown LIMIT (each returned 1 < 2), so there is provably no more.
    const a = makeStore('a', {
      decisions: [{ id: 1, text: 'a', occurred_at: 200, origin_seq: 1 }],
    });
    const b = makeStore('b', {
      decisions: [{ id: 1, text: 'b', occurred_at: 100, origin_seq: 1 }],
    });
    const registry = await registryWith([
      { projectId: 'a', root: a },
      { projectId: 'b', root: b },
    ]);
    const res = await queryAcrossStores<CrossStoreRow>({
      sql: 'SELECT project_id, occurred_at, origin_seq FROM strategic_decisions',
      registry,
      limit: 2,
    });
    expect(res.results).toHaveLength(2);
    expect(res.metadata.truncated).toBe(false);
  });

  it('keeps merge order + the top-LIMIT row correct when a store has NULL occurred_at/origin_seq', async () => {
    // Regression (workflow-found, HIGH): SQLite ranks NULL distinctly (last in DESC)
    // but the JS comparator coerces NULL→0. Without IFNULL in the per-store ORDER BY,
    // store A's array would be [(0,1),(NULL,9)] — NOT comparator-sorted — and the
    // comparator-true #1 row (NULL→0, seq 9) would be DROPPED under LIMIT 2.
    const aRoot = path.join(tmpDir, 'projects', 'anull');
    fs.mkdirSync(path.dirname(storeDbPath(aRoot)), { recursive: true });
    const adb = new Database(storeDbPath(aRoot));
    adb.exec(
      `CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY, decision_text TEXT, occurred_at INTEGER, origin_seq INTEGER, project_id TEXT);`
    );
    const ins = adb.prepare(
      'INSERT INTO strategic_decisions (id, decision_text, occurred_at, origin_seq, project_id) VALUES (?,?,?,?,?)'
    );
    ins.run(1, 'a-null9', null, 9, 'anull'); // occurred_at NULL → coerced to 0; seq 9
    ins.run(2, 'a-0-1', 0, 1, 'anull');
    adb.close();
    const bRoot = makeStore('b', {
      decisions: [{ id: 1, text: 'b-0-5', occurred_at: 0, origin_seq: 5 }],
    });
    const registry = await registryWith([
      { projectId: 'anull', root: aRoot },
      { projectId: 'b', root: bRoot },
    ]);

    const res = await queryAcrossStores<CrossStoreRow & { decision_text: string }>({
      sql: 'SELECT project_id, decision_text, occurred_at, origin_seq FROM strategic_decisions',
      registry,
      limit: 2,
    });
    // desc top-2 by (occurred_at→0, origin_seq desc): a-null9 (0,9), then b-0-5 (0,5).
    expect(res.results.map((r) => r.decision_text)).toEqual(['a-null9', 'b-0-5']);
  });

  it('truncated distinguishes exactly-limit from more-than-limit for a single store', async () => {
    const exact = makeStore('exact', {
      decisions: [
        { id: 1, text: 'e1', occurred_at: 200, origin_seq: 1 },
        { id: 2, text: 'e2', occurred_at: 100, origin_seq: 2 },
      ],
    });
    const more = makeStore('more', {
      decisions: [
        { id: 1, text: 'm1', occurred_at: 300, origin_seq: 1 },
        { id: 2, text: 'm2', occurred_at: 200, origin_seq: 2 },
        { id: 3, text: 'm3', occurred_at: 100, origin_seq: 3 },
      ],
    });
    const registry = await registryWith([
      { projectId: 'exact', root: exact },
      { projectId: 'more', root: more },
    ]);
    const sql = 'SELECT project_id, occurred_at, origin_seq FROM strategic_decisions';

    const exactRes = await queryAcrossStores<CrossStoreRow>({
      sql,
      registry,
      limit: 2,
      projectFilter: (e) => e.project_id === 'exact',
    });
    expect(exactRes.results).toHaveLength(2);
    expect(exactRes.metadata.truncated).toBe(false); // exactly 2, none past limit

    const moreRes = await queryAcrossStores<CrossStoreRow>({
      sql,
      registry,
      limit: 2,
      projectFilter: (e) => e.project_id === 'more',
    });
    expect(moreRes.results).toHaveLength(2);
    expect(moreRes.metadata.truncated).toBe(true); // 3 rows, limit 2 → capped
  });

  // ── tool integration: rbook_decisions(acrossProjects) ────────────────────────
  it('an explicit empty discovery snapshot never creates or backfills a registry', async () => {
    const options = { sql: '', stores: [] };
    const result = await queryAcrossStores(options);
    expect(result.metadata.storesQueried).toBe(0);
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it('custom legacy reads receive trusted store identity and a sentinel limit on a readonly connection', async () => {
    const root = makeStore('legacy');
    const writable = new Database(storeDbPath(root));
    writable.exec('CREATE TABLE legacy_rows (id INTEGER, project_id TEXT)');
    writable.prepare('INSERT INTO legacy_rows VALUES (?, NULL)').run(1);
    writable.prepare('INSERT INTO legacy_rows VALUES (?, NULL)').run(2);
    writable.close();
    const registry = await registryWith([{ projectId: 'trusted-source', root }]);
    const stores = registry.list();
    const options = {
      sql: '',
      stores,
      limit: 1,
      timeoutMs: 0,
      perStoreQuery: (db: Database.Database, store: ProjectGraphEntry, limit: number) => {
        expect(db.readonly).toBe(true);
        expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
        expect(limit).toBe(2);
        return db
          .prepare(
            'SELECT id AS occurred_at, id AS origin_seq, ? AS project_id FROM legacy_rows ORDER BY id DESC LIMIT ?'
          )
          .all(store.project_id, limit) as CrossStoreRow[];
      },
    };
    const result = await queryAcrossStores(options);
    expect(result.errors).toEqual([]);
    expect(result.results).toEqual([
      { occurred_at: 2, origin_seq: 2, project_id: 'trusted-source' },
    ]);
    expect(result.metadata.truncated).toBe(true);
  });

  it('a custom callback cannot write any source store', async () => {
    const root = makeStore('immutable');
    const registry = await registryWith([{ projectId: 'immutable', root }]);
    const options = {
      sql: '',
      stores: registry.list(),
      perStoreQuery: (db: Database.Database): CrossStoreRow[] => {
        db.exec('CREATE TABLE forbidden (id INTEGER)');
        return [];
      },
    };
    const result = await queryAcrossStores(options);
    expect(result.errors).toEqual([
      expect.objectContaining({
        projectId: 'immutable',
        error: expect.stringMatching(/readonly/i),
      }),
    ]);
    const verify = openStoreReadOnly(root);
    expect(
      verify.prepare("SELECT name FROM sqlite_master WHERE name='forbidden'").get()
    ).toBeUndefined();
    verify.close();
  });

  it('names an overrun and every unvisited store without returning late rows or running probes', async () => {
    const roots = ['first', 'later'].map((projectId) => ({
      projectId,
      root: makeStore(projectId),
    }));
    const registry = await registryWith(roots);
    const stores = registry.list().sort((a, b) => a.project_id.localeCompare(b.project_id));
    let now = Date.now();
    const deadlineAtMs = now + 100;
    const callback = jest.fn((_db: Database.Database, store: ProjectGraphEntry) => {
      now = deadlineAtMs + 1;
      return [{ occurred_at: now, origin_seq: 1, project_id: store.project_id }];
    });
    const probe = jest.fn(() => 1);
    const options = {
      sql: '',
      stores,
      deadlineAtMs,
      perStoreQuery: callback,
      perStoreProbe: probe,
    };
    const result = await queryAcrossStores(options, () => now);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.metadata.storesSucceeded).toBe(0);
    expect(result.metadata.perStoreMs).toEqual([]);
    expect(result.errors.map((error) => error.projectId)).toEqual(['first', 'later']);
    expect(result.errors.every((error) => /deadline/.test(error.error))).toBe(true);
  });

  it('rbook_decisions list acrossProjects fans out via the project-graph registry', async () => {
    const a = makeStore('proj-a', {
      decisions: [
        { id: 1, text: 'A decision', occurred_at: 300, origin_seq: 1, project_domain: 'da' },
      ],
    });
    const b = makeStore('proj-b', {
      decisions: [
        { id: 1, text: 'B decision', occurred_at: 100, origin_seq: 1, project_domain: 'db' },
      ],
    });
    // Register in the singleton registry (env configDir) the tool path uses.
    const reg = await ProjectGraphRegistry.create();
    reg.register({ project_id: 'proj-a', store_path: a, name: 'proj-a' });
    reg.register({ project_id: 'proj-b', store_path: b, name: 'proj-b' });

    const result = await rbookDecisionsList({ acrossProjects: true });
    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.acrossProjects).toBe(true);
    expect(data.decisions.map((d) => d.decision)).toEqual(['A decision', 'B decision']); // 300 then 100
    expect(data.decisions.map((d) => d.projectId)).toEqual(['proj-a', 'proj-b']);
    expect(data.decisions[0].domain).toBe('da');
    expect(data.crossStoreMetadata?.storesSucceeded).toBe(2);
  });
});

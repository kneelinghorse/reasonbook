// ABOUTME: Tests for rbook_review — sprint-64 m03 bundled session-opener digest.
// ABOUTME: Verifies ≤4KB budget, flat next_actions, project-scoped core, and portfolio behavior.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookReview,
  rbookReviewToolDefinition,
  formatReviewForLLM,
  type RbookReviewResult,
} from '../../../src/tools/rbook/rbook-review';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';

describe('rbook_review', () => {
  let tempDir: string;
  let dbPath: string;
  let reviewConfigDir: string;
  let prevReviewConfigEnv: string | undefined;

  function seedMinimalDb(): void {
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT
      );

      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-64', 'Foundation propagation', 'Active', 'Walkthrough round-trip');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES
        ('s64-m01', 'sprint-64', 'Hard rules propagation', 'Completed', 'Propagate'),
        ('s64-m02', 'sprint-64', 'Refresh prompt', 'Queued', 'Refresh build-session-prompt.md'),
        ('s64-m03', 'sprint-64', 'Ship rbook_review', 'In Progress', 'Implement bundled tool');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project_identity":{"name":"CMOS-MCP Pro","description":"Bundled session-opener test","status":"active_development"}}',
        '2026-05-25T10:00:00Z'
      ),
      (
        'project_context',
        'context/PROJECT_CONTEXT.json',
        '{"working_memory":{"next_steps":["Ship rbook_review","Run lint"]}}',
        '2026-05-25T11:00:00Z'
      );

      INSERT INTO sessions (id, type, title, started_at, status, captures)
      VALUES ('PS-2026-05-25-001', 'review', 'Walkthrough', '2026-05-25T09:00:00Z', 'completed', '[]');

      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id)
      VALUES
        ('Decision one — bundled tool', '2026-05-25T10:00:00Z', 'sprint-64'),
        ('Decision two — project-only', '2026-05-24T10:00:00Z', 'sprint-64'),
        ('Decision three — top-level next_actions', '2026-05-23T10:00:00Z', 'sprint-64');
    `);
    db.close();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-review-test-'));
    // s79-m06: rbook_review now reads the project-graph registry for its portfolio
    // section. Isolate RBOOK_CONFIG_DIR to a per-test EMPTY graph so the shared
    // run-wide graph file can't leak in — the single-project tests here get a
    // deterministic portfolio=null (≤1 active project).
    reviewConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-review-cfg-'));
    prevReviewConfigEnv = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = reviewConfigDir;
    ProjectGraphRegistry.resetInstance();
    seedMinimalDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    if (prevReviewConfigEnv === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = prevReviewConfigEnv;
    fs.rmSync(reviewConfigDir, { recursive: true, force: true });
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── Tool definition shape ──────────────────────────────────────────────

  describe('tool definition', () => {
    it('registers under name rbook_review with describing schema', () => {
      expect(rbookReviewToolDefinition.name).toBe('rbook_review');
      expect(rbookReviewToolDefinition.description.length).toBeGreaterThan(20);
      expect(rbookReviewToolDefinition.inputSchema.type).toBe('object');
      expect(rbookReviewToolDefinition.inputSchema.properties).toHaveProperty('projectRoot');
      // Sprint 56 m02 — additionalProperties: false hardens against misspelled fields.
      expect(rbookReviewToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  // ─── s92-m01: the registry default notice and the in-budget resolution stamp ───────

  describe('s92-m01 registry default and resolution stamp', () => {
    function otherStore(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-review-default-'));
      fs.mkdirSync(path.join(root, 'rbook', 'db'), { recursive: true });
      const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
      db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata (key, value) VALUES ('project_id', 'forge'), ('project_name', 'Forge');`);
      db.close();
      return root;
    }

    it('shows a pre-3.2.0 default as not applied, and drops the line once it is confirmed', async () => {
      const forgeRoot = otherStore();
      try {
        const registry = await ProjectGraphRegistry.create({ configDir: reviewConfigDir });
        const forge = registry.registerStore(forgeRoot);
        registry.setDefault(forge.project_id); // unconfirmed, the pre-3.2.0 way

        const unapplied = await rbookReview({ projectRoot: tempDir }, { registry });
        expect(unapplied.data?.registryDefault).toBe(
          'registry default: Forge — not applied; re-run setAsDefault to enable'
        );
        expect(formatReviewForLLM(unapplied)).toContain(
          'registry default: Forge — not applied; re-run setAsDefault to enable'
        );

        registry.registerStore(forgeRoot, { setAsDefault: true });
        const applied = await rbookReview({ projectRoot: tempDir }, { registry });
        expect(applied.data?.registryDefault).toBeUndefined();
      } finally {
        fs.rmSync(forgeRoot, { recursive: true, force: true });
      }
    });

    it('carries projectRoot and resolvedBy inside the digest budget when the dispatcher passes them', async () => {
      const result = await rbookReview({ projectRoot: tempDir }, { resolvedBy: 'cwd' });
      const digest = result.data as RbookReviewResult;
      expect(digest.projectRoot).toBe(tempDir);
      expect(digest.resolvedBy).toBe('cwd');
      expect(digest.digestSizeBytes).toBe(Buffer.byteLength(JSON.stringify(digest), 'utf8'));
    });
  });

  // ─── Digest shape ───────────────────────────────────────────────────────

  describe('digest payload', () => {
    it('returns a digest with the required flat top-level fields', async () => {
      const result = await rbookReview({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const digest = result.data as RbookReviewResult;

      // Flat top-level surface — none of these may be nested.
      expect(digest).toHaveProperty('next_actions');
      expect(digest).toHaveProperty('project');
      expect(digest).toHaveProperty('sprint');
      expect(digest).toHaveProperty('workQueue');
      expect(digest).toHaveProperty('recentDecisions');
      expect(digest).toHaveProperty('freshness');
      // s87-m06 — INVERTED. `warnings` was a DATA-level field assigned `[]` exactly once and
      // never written, with a renderer that could only print an empty list and a size-trim stage
      // that sliced a list that could not have content. Asserting its PRESENCE was asserting that
      // a promise the payload never kept was still being made.
      //
      // The ENVELOPE channel is untouched and is where warnings actually travel:
      // `createSuccess(digest, reviewWarnings)` carries them on the result, and
      // `appendWarnings` renders them. Two objects; only the dead one is gone.
      expect(digest).not.toHaveProperty('warnings');
      expect(digest).toHaveProperty('digestSizeBytes');
    });

    it('exposes next_actions as a flat top-level array (not buried inside suggestedActions)', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(Array.isArray(digest.next_actions)).toBe(true);
      // Promoted to top — must NOT live inside a suggestedActions wrapper.
      expect((digest as unknown as Record<string, unknown>).suggestedActions).toBeUndefined();
    });

    it('limits next_actions to at most 3 entries', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;
      expect(digest.next_actions.length).toBeLessThanOrEqual(3);
    });

    it('includes compact project identity (name + rbook_address + status + tier)', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.project.name).toBe('CMOS-MCP Pro');
      expect(digest.project).toHaveProperty('rbook_address');
      expect(typeof digest.project.rbook_address).toBe('string');
      expect(digest.project).toHaveProperty('status');
      expect(digest.project).toHaveProperty('tier');
    });

    it('includes current sprint summary when one exists', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.sprint).not.toBeNull();
      expect(digest.sprint?.id).toBe('sprint-64');
      expect(digest.sprint?.title).toBe('Foundation propagation');
    });

    it('caps sprint focus to ~280 chars', async () => {
      const longFocus = 'X'.repeat(600);
      const db = new Database(dbPath);
      db.prepare('UPDATE sprints SET focus = ? WHERE id = ?').run(longFocus, 'sprint-64');
      db.close();

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.sprint?.focus).not.toBeNull();
      expect((digest.sprint?.focus ?? '').length).toBeLessThanOrEqual(280);
    });
  });

  // ─── Project-scoped core + canonical portfolio boundary ─────────────────

  describe('project-scoped core', () => {
    it('keeps cross-project data under the canonical portfolio field', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as unknown as Record<string, unknown>;

      // Decision #906 superseded #672 and added the deliberate graph-backed portfolio section.
      // Obsolete aliases remain forbidden; the project-local core stays separate.
      expect(Object.prototype.hasOwnProperty.call(digest, 'portfolio')).toBe(true);
      expect(digest.crossProjectStatus).toBeUndefined();
      expect(digest.crossProject).toBeUndefined();
      expect(digest.projects).toBeUndefined();
      expect(digest.allProjects).toBeUndefined();
    });

    it('workQueue counts reflect this project only', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      // Seeded: 1 In Progress, 1 Queued, 0 Current, 0 Blocked
      expect(digest.workQueue.inProgress.count).toBe(1);
      expect(digest.workQueue.queued.count).toBe(1);
      expect(digest.workQueue.current.count).toBe(0);
      expect(digest.workQueue.blocked.count).toBe(0);
    });

    it('workQueue surfaces top-3 mission entries per bucket (or fewer)', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.workQueue.inProgress.top.length).toBeLessThanOrEqual(3);
      expect(digest.workQueue.queued.top.length).toBeLessThanOrEqual(3);
      expect(digest.workQueue.current.top.length).toBeLessThanOrEqual(3);

      // Each top entry must be a compact {id, name} shape.
      for (const item of digest.workQueue.inProgress.top) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('name');
      }
    });
  });

  // ─── Size budget ────────────────────────────────────────────────────────

  describe('size budget', () => {
    it('keeps the digest ≤4KB under realistic load (10 sprints, 50 missions, 100 decisions)', async () => {
      const db = new Database(dbPath);

      // Wipe seed-fixture rows so we can add a deterministic realistic load.
      db.exec(`
        DELETE FROM missions;
        DELETE FROM strategic_decisions;
        DELETE FROM sprints;
      `);

      // 10 sprints
      const insertSprint = db.prepare(
        'INSERT INTO sprints (id, title, status, focus) VALUES (?, ?, ?, ?)'
      );
      for (let i = 1; i <= 10; i++) {
        const status = i === 10 ? 'Active' : 'Completed';
        insertSprint.run(
          `sprint-${i}`,
          `Sprint ${i} - realistic title with descriptive name`,
          status,
          `Focus area for sprint ${i} that describes the body of work in this cycle`
        );
      }

      // 50 missions across sprints — distribute statuses
      const insertMission = db.prepare(
        'INSERT INTO missions (id, sprint_id, name, status, objective) VALUES (?, ?, ?, ?, ?)'
      );
      for (let i = 1; i <= 50; i++) {
        const sprintNum = Math.min(10, Math.ceil(i / 5));
        const status =
          i === 49 ? 'In Progress' : i === 50 ? 'Queued' : i % 7 === 0 ? 'Blocked' : 'Completed';
        insertMission.run(
          `s${sprintNum}-m${String(i).padStart(2, '0')}`,
          `sprint-${sprintNum}`,
          `Mission ${i} with a moderately descriptive name`,
          status,
          `Objective text for mission ${i}`
        );
      }

      // 100 decisions
      const insertDecision = db.prepare(
        'INSERT INTO strategic_decisions (decision_text, created_at, sprint_id) VALUES (?, ?, ?)'
      );
      for (let i = 1; i <= 100; i++) {
        const sprintNum = Math.min(10, Math.ceil(i / 10));
        const ts = `2026-05-${String(Math.min(28, i)).padStart(2, '0')}T10:00:00Z`;
        insertDecision.run(
          `Strategic decision number ${i} — moderately long body text simulating a realistic captured decision`,
          ts,
          `sprint-${sprintNum}`
        );
      }
      db.close();

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      const payloadBytes = Buffer.byteLength(JSON.stringify(digest), 'utf8');
      expect(payloadBytes).toBeLessThanOrEqual(4096);
      // Tool also self-reports the size — must match what we measured externally.
      expect(digest.digestSizeBytes).toBe(payloadBytes);
    });
  });

  // ─── Projection of recent decisions ─────────────────────────────────────

  describe('recent decisions', () => {
    it('returns at most 5 recent decisions in {text, createdAt} compact shape', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.recentDecisions.length).toBeLessThanOrEqual(5);
      for (const d of digest.recentDecisions) {
        expect(d).toHaveProperty('text');
        expect(d).toHaveProperty('createdAt');
        // Compact form drops the heavy fields (domain/category/etc) but keeps the
        // small `projectId` provenance tag (s83-m06) so the renderer can fence a
        // pull-merged FOREIGN decision as untrusted. s92-m04 adds `id`, so a capped text can be
        // read in full with rbook_decisions(action="show"). s96-m02 adds `author` (ADR s96 §10)
        // only for a decision with a recorded name; these seeded decisions have none.
        const keys = Object.keys(d).sort();
        expect(keys).toEqual(['createdAt', 'id', 'projectId', 'text']);
      }
    });
  });

  // ─── Freshness signal ───────────────────────────────────────────────────

  describe('freshness', () => {
    it('exposes lagDays and isStale as the only freshness fields', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      const keys = Object.keys(digest.freshness).sort();
      expect(keys).toEqual(['isStale', 'lagDays']);
      expect(typeof digest.freshness.lagDays).toBe('number');
      expect(typeof digest.freshness.isStale).toBe('boolean');
    });
  });

  // ─── Build freshness (Sprint 67 m03) ────────────────────────────────────

  describe('buildFreshness signal', () => {
    function writeSrcFile(relativePath: string, mtime?: Date): void {
      const fullPath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// ${relativePath}\n`);
      if (mtime) fs.utimesSync(fullPath, mtime, mtime);
    }

    function writeDistManifest(buildTime: Date): void {
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, '.build-manifest.json'),
        JSON.stringify({ buildHash: 'x', buildTime: buildTime.toISOString(), fileCount: 1 })
      );
    }

    it('omits buildFreshness when src is missing (dist-only install path)', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;
      expect(digest.buildFreshness).toBeUndefined();
    });

    it('omits buildFreshness when dist/ is fresh relative to src/', async () => {
      const oldSrc = new Date(Date.now() - 60_000);
      writeSrcFile('src/foo.ts', oldSrc);
      writeDistManifest(new Date());

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;
      expect(digest.buildFreshness).toBeUndefined();
    });

    it('attaches buildFreshness AND promotes a priority-1 next_action when stale', async () => {
      const buildTime = new Date(Date.now() - 60_000);
      writeDistManifest(buildTime);
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.buildFreshness).toBeDefined();
      expect(digest.buildFreshness?.stale).toBe(true);
      // The freshness action must be first in next_actions with priority=1.
      expect(digest.next_actions.length).toBeGreaterThan(0);
      expect(digest.next_actions[0].priority).toBe(1);
      expect(digest.next_actions[0].command).toBe('npm run build');
      expect(digest.next_actions.length).toBeLessThanOrEqual(3);
    });

    // s84-m05: build-freshness is gated on projectType==='build'. The store above defaults to
    // 'build' (no metadata.project_type) — the positive case is covered by the test above.
    function setProjectType(value: string): void {
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_type', ?)`).run(
        value
      );
      db.close();
    }

    it('SKIPS buildFreshness for a general-tier project even when src is stale (m05 gate)', async () => {
      setProjectType('general');
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date()); // src newer → would be stale for a build project

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;
      // Gated off: no freshness report and no priority-1 "npm run build" next_action.
      expect(digest.buildFreshness).toBeUndefined();
      expect(digest.next_actions.find((a) => a.command === 'npm run build')).toBeUndefined();
    });

    it('KEEPS buildFreshness for an explicit build-tier project when stale (m05 gate positive)', async () => {
      setProjectType('build');
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;
      expect(digest.buildFreshness?.stale).toBe(true);
    });

    it('attaches buildFreshness with dist-missing reason when dist/ is absent entirely', async () => {
      writeSrcFile('src/foo.ts');

      const result = await rbookReview({ projectRoot: tempDir });
      const digest = result.data as RbookReviewResult;

      expect(digest.buildFreshness?.stale).toBe(true);
      expect(digest.buildFreshness?.reason).toBe('dist-missing');
      expect(digest.next_actions[0].action).toContain('build output missing');
    });
  });

  // ─── Format helper ──────────────────────────────────────────────────────

  describe('formatReviewForLLM', () => {
    it('returns a human-readable string for a success result', async () => {
      const result = await rbookReview({ projectRoot: tempDir });
      const formatted = formatReviewForLLM(result);
      expect(formatted).toContain('CMOS-MCP Pro');
      expect(formatted).toContain('sprint-64');
    });

    it('formats error results with the actionable message', () => {
      const formatted = formatReviewForLLM({
        success: false,
        error: { code: 'DB_NOT_FOUND', message: 'no db', suggestion: 'run rbook_project init' },
      });
      expect(formatted).toContain('no db');
      expect(formatted).toContain('run rbook_project init');
    });
  });
});

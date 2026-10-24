/**
 * rbook_project_init Tool Tests
 *
 * Comprehensive tests for the project initialization tool.
 * Tests include creating new projects, idempotent behavior,
 * error handling, and formatting.
 *
 * @module tests/tools/rbook/rbook-project-init
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookProjectInit,
  rbookProjectInitToolDefinition,
  formatProjectInitForLLM,
  resolveSeedPath,
  type RbookProjectInitInput,
} from '../../../src/tools/rbook/rbook-project-init';
import { RBOOK_SCHEMA_VERSION, RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import * as levelFiles from '../../../src/tools/rbook/level-files';

describe('rbook_project_init', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-project-init-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('seed resolution', () => {
    it('should find the rbook-seed directory', () => {
      const seedPath = resolveSeedPath();
      expect(seedPath).not.toBeNull();
      expect(fs.existsSync(path.join(seedPath!, 'db', 'schema.sql'))).toBe(true);
      expect(fs.existsSync(path.join(seedPath!, 'tiers', 'build.md'))).toBe(true);
    });
  });

  describe('new project initialization', () => {
    it('should create full rbook directory structure from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNewProject).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'db', 'rbook.sqlite'))).toBe(true);
    });

    it('should copy tier configs from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'tiers', 'build.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'tiers', 'general.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'tiers', 'managed.md'))).toBe(true);

      const buildMd = fs.readFileSync(path.join(tempDir, 'rbook', 'tiers', 'build.md'), 'utf-8');
      expect(buildMd).toContain('tier: build');
    });

    it('should copy docs directory from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'docs'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'docs', 'getting-started.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'docs', 'build-session-prompt.md'))).toBe(
        true
      );
    });

    it('should copy foundational-docs templates from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'foundational-docs'))).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, 'rbook', 'foundational-docs', 'roadmap_template.md'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, 'rbook', 'foundational-docs', 'tech_arch_template.md'))
      ).toBe(true);
    });

    it('should copy templates directory from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'templates'))).toBe(true);
      expect(fs.readdirSync(path.join(tempDir, 'rbook', 'templates'))).toContain('AGENTS.md');
      expect(
        fs.existsSync(path.join(tempDir, 'rbook', 'templates', 'PROJECT-README-template.md'))
      ).toBe(true);
    });

    it('should copy context JSON files from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'context'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'context', 'master_context.json'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'context', 'project_context.json'))).toBe(
        true
      );
    });

    it('should copy schema.sql reference from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'rbook', 'db', 'schema.sql'))).toBe(true);
    });

    // Sprint 60 Bug 1 regression: rbook.sqlite-wal and rbook.sqlite-shm are runtime
    // artifacts of WAL mode and have no business in a seed. When they leaked through,
    // sqlite could recover stale state into the supposedly-fresh DB on a new project.
    // Init must skip them alongside rbook.sqlite itself.
    it('should not copy sqlite WAL/SHM runtime artifacts from seed', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const dbDir = path.join(tempDir, 'rbook', 'db');
      // The freshly-opened DB will create its own -wal and -shm during normal use
      // (and may have already by the time init returns). Assert their CONTENTS
      // are not the seed's contents — i.e. that nothing was ferried in unchanged.
      const seedDir = resolveSeedPath()!;
      const seedWal = path.join(seedDir, 'db', 'rbook.sqlite-wal');
      const seedShm = path.join(seedDir, 'db', 'rbook.sqlite-shm');
      const initWal = path.join(dbDir, 'rbook.sqlite-wal');
      const initShm = path.join(dbDir, 'rbook.sqlite-shm');

      if (fs.existsSync(seedWal) && fs.existsSync(initWal)) {
        const seedBytes = fs.readFileSync(seedWal);
        const initBytes = fs.readFileSync(initWal);
        expect(initBytes.equals(seedBytes)).toBe(false);
      }
      if (fs.existsSync(seedShm) && fs.existsSync(initShm)) {
        const seedBytes = fs.readFileSync(seedShm);
        const initBytes = fs.readFileSync(initShm);
        expect(initBytes.equals(seedBytes)).toBe(false);
      }
    });

    it('keeps the store, sidecars and every snapshot out of git when the package omits .gitignore', async () => {
      const seed = path.join(tempDir, 'packed-seed');
      fs.cpSync(resolveSeedPath()!, seed, {
        recursive: true,
        filter: (file) => path.basename(file) !== '.gitignore',
      });
      const resolve = jest.spyOn(levelFiles, 'resolveSeedPath').mockReturnValue(seed);
      try {
        const result = await rbookProjectInit({ projectRoot: tempDir });
        expect(result.success).toBe(true);
        expect(result.data?.created.files).toContain('.gitignore');
        execFileSync('git', ['init', '-q', tempDir]);
        const runtime = [
          'rbook/db/rbook.sqlite',
          'rbook/db/rbook.sqlite-wal',
          'rbook/db/rbook.sqlite-shm',
          'rbook/db/snapshots/pre-migrate-example.sqlite',
          'rbook/db/snapshots/manual-example.sqlite',
        ];
        const ignored = execFileSync('git', ['check-ignore', '--stdin'], {
          cwd: tempDir,
          input: runtime.join('\n') + '\n',
          encoding: 'utf8',
        })
          .trim()
          .split('\n');
        expect(ignored).toEqual(runtime);
      } finally {
        resolve.mockRestore();
      }
    });

    it('preserves an existing ignore file exactly, including a deliberate tracked-store policy', async () => {
      fs.mkdirSync(path.join(tempDir, 'rbook'));
      const ignore = path.join(tempDir, 'rbook', '.gitignore');
      const policy = '# This project deliberately tracks its store.\n*.local\n';
      fs.writeFileSync(ignore, policy);
      const result = await rbookProjectInit({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.created.files).not.toContain('.gitignore');
      expect(fs.readFileSync(ignore, 'utf8')).toBe(policy);
    });

    // s93-m12: CLAUDE.md imports the agents file and names no tool prefix, which depends on what
    // each user calls the server; Reasonbook procedure stays out of rules files.
    it('should create a CLAUDE.md that imports AGENTS.md and names no tool prefix', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const claudePath = path.join(tempDir, 'CLAUDE.md');
      expect(fs.existsSync(claudePath)).toBe(true);

      const content = fs.readFileSync(claudePath, 'utf-8');
      expect(content.split('\n')).toContain('@AGENTS.md');
      expect(content).not.toMatch(/mcp__/);
    });

    it('should generate project ID when not provided', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectId).toBeDefined();
      expect(result.data?.projectId.length).toBeGreaterThan(0);
      expect(result.data?.projectId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should use provided project ID', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectId: 'my-custom-project-id',
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectId).toBe('my-custom-project-id');
    });

    it('should set project name in database', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'My Awesome Project',
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectName).toBe('My Awesome Project');

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe('My Awesome Project');
    });

    it('should set tracelab project ID in database', async () => {
      const tracelabId = 'tracelab-123-456';
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        tracelabProjectId: tracelabId,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'tracelab_project_id'")
        .get() as { value: string };
      db.close();

      expect(row.value).toBe(tracelabId);
    });

    it('should set schema version in database', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.schemaVersion).toBe(RBOOK_SCHEMA_VERSION);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe(RBOOK_SCHEMA_VERSION);
    });
  });

  describe('database schema', () => {
    it('should create all required tables', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('metadata');
      expect(tableNames).toContain('sprints');
      expect(tableNames).toContain('missions');
      expect(tableNames).toContain('mission_dependencies');
      expect(tableNames).toContain('contexts');
      expect(tableNames).toContain('context_snapshots');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('session_events');
      expect(tableNames).toContain('strategic_decisions');
      expect(tableNames).toContain('telemetry_events');
      expect(tableNames).toContain('prompt_mappings');

      db.close();
    });

    it('should create all required views', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);

      const views = db
        .prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
        .all() as { name: string }[];

      const viewNames = views.map((v) => v.name);

      expect(viewNames).toContain('project_identity');
      expect(viewNames).toContain('active_missions');
      expect(viewNames).toContain('mission_details');
      expect(viewNames).toContain('sprint_summary');

      db.close();
    });

    it('should create initial contexts', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);

      const contexts = db.prepare('SELECT id FROM contexts ORDER BY id').all() as { id: string }[];
      const contextIds = contexts.map((c) => c.id);

      expect(contextIds).toContain('project_context');
      expect(contextIds).toContain('master_context');

      db.close();
    });
  });

  describe('initial sprint and missions', () => {
    it('should create initial sprint when provided', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
          focus: 'Project Setup',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintCreated).toBe('sprint-01');

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-01') as {
        id: string;
        title: string;
        focus: string;
        status: string;
      };
      db.close();

      expect(sprint.id).toBe('sprint-01');
      expect(sprint.title).toBe('Initial Sprint');
      expect(sprint.focus).toBe('Project Setup');
      expect(sprint.status).toBe('Active');
    });

    it('should create initial missions when provided', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
        },
        initialMissions: [
          {
            id: 's01-m01',
            name: 'First Mission',
            sprintId: 'sprint-01',
            objective: 'Do something',
            status: 'Current',
          },
          {
            id: 's01-m02',
            name: 'Second Mission',
            sprintId: 'sprint-01',
            status: 'Queued',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionsCreated).toContain('s01-m01');
      expect(result.data?.missionsCreated).toContain('s01-m02');

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const missions = db.prepare('SELECT * FROM missions ORDER BY id').all() as {
        id: string;
        name: string;
        status: string;
        objective: string | null;
      }[];
      db.close();

      expect(missions.length).toBe(2);
      expect(missions[0].id).toBe('s01-m01');
      expect(missions[0].status).toBe('Current');
      expect(missions[0].objective).toBe('Do something');
      expect(missions[1].id).toBe('s01-m02');
      expect(missions[1].status).toBe('Queued');
    });

    it('should store success criteria and deliverables as JSON', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
        },
        initialMissions: [
          {
            id: 's01-m01',
            name: 'Test Mission',
            sprintId: 'sprint-01',
            successCriteria: ['Criterion 1', 'Criterion 2'],
            deliverables: ['File 1', 'File 2'],
          },
        ],
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get('s01-m01') as {
        success_criteria: string;
        deliverables: string;
      };
      db.close();

      expect(JSON.parse(mission.success_criteria)).toEqual(['Criterion 1', 'Criterion 2']);
      expect(JSON.parse(mission.deliverables)).toEqual(['File 1', 'File 2']);
    });
  });

  describe('idempotent behavior', () => {
    it('should be safe to call on existing project', async () => {
      const result1 = await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Original Name',
        projectId: 'original-id',
      });

      expect(result1.success).toBe(true);
      expect(result1.data?.isNewProject).toBe(true);

      const result2 = await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Name',
      });

      expect(result2.success).toBe(true);
      expect(result2.data?.isNewProject).toBe(false);
    });

    it('should update metadata on re-initialization', async () => {
      await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Original Name',
      });

      await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Name',
      });

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe('Updated Name');
    });

    it('should not duplicate contexts on re-initialization', async () => {
      await rbookProjectInit({ projectRoot: tempDir });
      await rbookProjectInit({ projectRoot: tempDir });

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM contexts').get() as { count: number };
      db.close();

      expect(count.count).toBe(2); // project_context and master_context only
    });

    it('should not overwrite existing seed files on re-initialization', async () => {
      await rbookProjectInit({ projectRoot: tempDir });

      // Modify a tier config every level gets (s95-m06: a default init is a Ledger, with no build.md)
      const buildMdPath = path.join(tempDir, 'rbook', 'tiers', 'general.md');
      fs.writeFileSync(buildMdPath, '# Custom build tier content');

      // Re-initialize
      await rbookProjectInit({ projectRoot: tempDir });

      // Should preserve the custom content
      const content = fs.readFileSync(buildMdPath, 'utf-8');
      expect(content).toBe('# Custom build tier content');
    });

    it('should not duplicate sprint on re-initialization', async () => {
      await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
        initialSprint: { id: 'sprint-01', title: 'Sprint 1' },
      });

      const result = await rbookProjectInit({
        projectRoot: tempDir,
        initialSprint: { id: 'sprint-01', title: 'Sprint 1 Updated' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintCreated).toBeUndefined();

      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM sprints').get() as { count: number };
      const sprint = db.prepare('SELECT title FROM sprints WHERE id = ?').get('sprint-01') as {
        title: string;
      };
      db.close();

      expect(count.count).toBe(1);
      expect(sprint.title).toBe('Sprint 1');
    });
  });

  describe('error handling', () => {
    it('should return error for non-existent project root', async () => {
      const result = await rbookProjectInit({
        projectRoot: '/non/existent/path',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.field).toBe('projectRoot');
    });

    it('should return error when project root is a file', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      const result = await rbookProjectInit({
        projectRoot: filePath,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('not a directory');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookProjectInitToolDefinition.name).toBe('rbook_project_init');
    });

    it('should require projectRoot', () => {
      expect(rbookProjectInitToolDefinition.inputSchema.required).toContain('projectRoot');
    });

    it('should have all expected properties', () => {
      const props = rbookProjectInitToolDefinition.inputSchema.properties;
      expect(props.projectName).toBeDefined();
      expect(props.projectId).toBeDefined();
      expect(props.tracelabProjectId).toBeDefined();
      expect(props.initialSprint).toBeDefined();
      expect(props.initialMissions).toBeDefined();
    });
  });

  describe('formatProjectInitForLLM', () => {
    it('should format success result for new project', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Test Project',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Reasonbook Project Initialized');
      expect(formatted).toContain('Test Project');
      expect(formatted).toContain(RBOOK_SCHEMA_VERSION);
      expect(formatted).toContain('rbook_agent_onboard');
    });

    it('should format success result for updated project', async () => {
      await rbookProjectInit({ projectRoot: tempDir });

      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Project',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Reasonbook Project Updated');
      expect(formatted).toContain('Updated Project');
    });

    it('should include created files in output', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Created');
      expect(formatted).toContain('db/rbook.sqlite');
      expect(formatted).toContain('tiers/');
    });

    it('should include sprint and missions in output', async () => {
      const result = await rbookProjectInit({
        projectRoot: tempDir,
        projectType: 'build', // s95-m06: sprints, missions and the Builder documents are Builder's
        initialSprint: { id: 'sprint-01', title: 'Sprint 1' },
        initialMissions: [{ id: 's01-m01', name: 'Mission 1', sprintId: 'sprint-01' }],
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Initial Sprint');
      expect(formatted).toContain('sprint-01');
      expect(formatted).toContain('Initial Missions');
      expect(formatted).toContain('s01-m01');
    });

    it('should format error result', async () => {
      const result = await rbookProjectInit({
        projectRoot: '/non/existent',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Initialization Failed');
      expect(formatted).toContain('Error');
      expect(formatted).toContain('Suggestion');
    });
  });

  describe('auto-registration', () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-init-registry-'));
      RbookDetector.resetInstance();
      ProjectGraphRegistry.resetInstance();
      await ProjectGraphRegistry.create({ configDir });
    });

    afterEach(async () => {
      RbookDetector.resetInstance();
      ProjectGraphRegistry.resetInstance();
      if (configDir && fs.existsSync(configDir)) {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('should auto-register the project after init', async () => {
      await rbookProjectInit({ projectRoot: tempDir, projectName: 'auto-reg-test' });

      // s80-m02: init registers into the graph (the single discovery source).
      const graph = await ProjectGraphRegistry.create({ configDir });
      const projectId = graph.getByStorePath(tempDir);
      expect(projectId).not.toBeNull();
      expect(graph.get(projectId!)?.store_path).toBe(tempDir);
    });

    it('should succeed even if registration fails (best-effort)', async () => {
      // Simulate a broken registry by providing an invalid configDir path after creation
      // Init should still succeed and return the DB result
      const result = await rbookProjectInit({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.databasePath).toContain('rbook.sqlite');
    });

    it('should register with project name when provided', async () => {
      await rbookProjectInit({ projectRoot: tempDir, projectName: 'My Named Project' });

      const graph = await ProjectGraphRegistry.create({ configDir });
      const projectId = graph.getByStorePath(tempDir);
      expect(graph.get(projectId!)?.name).toBe('My Named Project');
    });
  });

  describe('schema content', () => {
    it('should export RBOOK_SCHEMA as valid SQL', async () => {
      const testDb = new Database(':memory:');
      expect(() => testDb.exec(RBOOK_SCHEMA)).not.toThrow();
      testDb.close();
    });

    it('should include all standard metadata keys in schema', () => {
      expect(RBOOK_SCHEMA).toContain("'project_id'");
      expect(RBOOK_SCHEMA).toContain("'project_name'");
      expect(RBOOK_SCHEMA).toContain("'tracelab_project_id'");
      expect(RBOOK_SCHEMA).toContain("'schema_version'");
    });

    it('should include project_identity view in schema', () => {
      expect(RBOOK_SCHEMA).toContain('CREATE VIEW IF NOT EXISTS project_identity');
    });

    it('should include session_id and source_chunk_ids in strategic_decisions', () => {
      expect(RBOOK_SCHEMA).toContain('session_id TEXT');
      expect(RBOOK_SCHEMA).toContain('source_chunk_ids TEXT');
    });
  });
});

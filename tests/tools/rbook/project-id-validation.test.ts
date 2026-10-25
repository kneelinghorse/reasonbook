/**
 * Project ID Validation Tests
 *
 * Tests for database self-protection via project_id in metadata.
 * When a database has project_id set, RBOOK_PROJECT_ID env var MUST match.
 *
 * @module tests/tools/rbook/project-id-validation
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RbookDatabaseClient,
  withClientValidated,
  RBOOK_PROJECT_ID_ENV,
  RBOOK_PROJECT_ROOT_ENV,
  RBOOK_ERROR_CODES,
} from '../../../src/tools/rbook';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';

describe('Project ID Validation', () => {
  let tempDir: string;
  let dbPath: string;
  const originalEnv = process.env[RBOOK_PROJECT_ID_ENV];
  const originalProjectRootEnv = process.env[RBOOK_PROJECT_ROOT_ENV];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-project-id-test-'));
    const rbookDir = path.join(tempDir, 'rbook');
    const dbDir = path.join(rbookDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project-123');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();

    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env[RBOOK_PROJECT_ID_ENV] = originalEnv;
    } else {
      delete process.env[RBOOK_PROJECT_ID_ENV];
    }

    if (originalProjectRootEnv !== undefined) {
      process.env[RBOOK_PROJECT_ROOT_ENV] = originalProjectRootEnv;
    } else {
      delete process.env[RBOOK_PROJECT_ROOT_ENV];
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    ProjectGraphRegistry.resetInstance();
  });

  describe('RbookDatabaseClient.validateProjectId', () => {
    it('should pass when env var matches database project_id', async () => {
      process.env[RBOOK_PROJECT_ID_ENV] = 'test-project-123';

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should fail when env var does not match database project_id', async () => {
      process.env[RBOOK_PROJECT_ID_ENV] = 'wrong-project-id';

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.PROJECT_ID_MISMATCH);
        expect(result.error?.message).toContain('wrong-project-id');
        expect(result.error?.message).toContain('test-project-123');
      } finally {
        client.close();
      }
    });

    it('should fail when database has project_id but env var is not set (self-protection)', async () => {
      delete process.env[RBOOK_PROJECT_ID_ENV];

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.PROJECT_ID_MISMATCH);
        expect(result.error?.message).toContain('requires project ID validation');
        expect(result.error?.suggestion).toContain('RBOOK_PROJECT_ID="test-project-123"');
      } finally {
        client.close();
      }
    });

    it('should pass when database has empty project_id (no protection)', async () => {
      // Update database to have empty project_id
      const db = new Database(dbPath);
      db.exec("UPDATE metadata SET value = '' WHERE key = 'project_id'");
      db.close();

      delete process.env[RBOOK_PROJECT_ID_ENV];

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should pass when database has no project_id row (backward compatible)', async () => {
      // Remove project_id from metadata
      const db = new Database(dbPath);
      db.exec("DELETE FROM metadata WHERE key = 'project_id'");
      db.close();

      delete process.env[RBOOK_PROJECT_ID_ENV];

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should pass when metadata table does not exist (old database, backward compatible)', async () => {
      // Create database without metadata table
      const noMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-nometa-'));
      const noMetaRbookDir = path.join(noMetaDir, 'rbook');
      const noMetaDbDir = path.join(noMetaRbookDir, 'db');
      fs.mkdirSync(noMetaDbDir, { recursive: true });
      const noMetaDbPath = path.join(noMetaDbDir, 'rbook.sqlite');

      const db = new Database(noMetaDbPath);
      db.exec(`
        CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      `);
      db.close();

      delete process.env[RBOOK_PROJECT_ID_ENV];

      try {
        RbookDetector.resetInstance();
        const clientResult = await RbookDatabaseClient.create({ dbPath: noMetaDbPath });
        expect(clientResult.success).toBe(true);

        const client = clientResult.data!;
        try {
          const result = client.validateProjectId();

          expect(result.success).toBe(true);
        } finally {
          client.close();
        }
      } finally {
        fs.rmSync(noMetaDir, { recursive: true, force: true });
      }
    });
  });

  describe('withClientValidated', () => {
    // NOTE: Project ID validation has been removed from withClientValidated.
    // The explicit projectRoot requirement (no cwd fallback) now provides
    // protection against cross-project contamination without requiring
    // env var configuration. These tests verify the new behavior.

    it('should execute operation regardless of project_id (validation removed)', async () => {
      // Even with mismatched project_id, operation should succeed
      process.env[RBOOK_PROJECT_ID_ENV] = 'wrong-project';

      let operationExecuted = false;

      const result = await withClientValidated(
        (client) => {
          operationExecuted = true;
          const missions = client.getMany('SELECT * FROM missions');
          return missions;
        },
        { projectRoot: tempDir }
      );

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
      expect(operationExecuted).toBe(true);
    });

    it('should execute operation when env var not set (validation removed)', async () => {
      delete process.env[RBOOK_PROJECT_ID_ENV];

      let operationExecuted = false;

      const result = await withClientValidated(
        (client) => {
          operationExecuted = true;
          const missions = client.getMany('SELECT * FROM missions');
          return missions;
        },
        { projectRoot: tempDir }
      );

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
      expect(operationExecuted).toBe(true);
    });

    it('should allow manual validation via client.validateProjectId()', async () => {
      process.env[RBOOK_PROJECT_ID_ENV] = 'wrong-project';

      const clientResult = await RbookDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        // Manual opt-in validation still available
        const validation = client.validateProjectId();

        // Should fail because project_id doesn't match
        expect(validation.success).toBe(false);
        expect(validation.error?.code).toBe(RBOOK_ERROR_CODES.PROJECT_ID_MISMATCH);
      } finally {
        client.close();
      }
    });
  });

  describe('mutation tools integration', () => {
    // NOTE: Project ID validation has been removed from mutation tools.
    // Protection is now provided by requiring explicit projectRoot parameter
    // (no cwd fallback). These tests verify mutations work without env var.

    it('should allow mission mutation regardless of project_id (validation removed)', async () => {
      process.env[RBOOK_PROJECT_ID_ENV] = 'wrong-project';

      // Add required tables and a mission
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
        CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, sprint_id TEXT, started_at TEXT,
      completed_at TEXT, agent TEXT, status TEXT, summary TEXT, captures TEXT,
      next_steps TEXT, metadata TEXT
    );
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT);
        INSERT INTO missions (id, name, status) VALUES ('m1', 'Test Mission', 'Queued');
      `);
      db.close();

      // Import a mutation tool
      const { rbookMissionStart } = await import('../../../src/tools/rbook/rbook-mission-start');

      RbookDetector.resetInstance();
      const result = await rbookMissionStart({ missionId: 'm1', projectRoot: tempDir });

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
    });

    it('should allow mission mutation when env var not set (validation removed)', async () => {
      delete process.env[RBOOK_PROJECT_ID_ENV];

      // Add required tables and a mission
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
        CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, sprint_id TEXT, started_at TEXT,
      completed_at TEXT, agent TEXT, status TEXT, summary TEXT, captures TEXT,
      next_steps TEXT, metadata TEXT
    );
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT);
        INSERT INTO missions (id, name, status) VALUES ('m1', 'Test Mission', 'Queued');
      `);
      db.close();

      // Import a mutation tool
      const { rbookMissionStart } = await import('../../../src/tools/rbook/rbook-mission-start');

      RbookDetector.resetInstance();
      const result = await rbookMissionStart({ missionId: 'm1', projectRoot: tempDir });

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
    });

    it('should fail when projectRoot is not provided', async () => {
      const { rbookMissionStart } = await import('../../../src/tools/rbook/rbook-mission-start');
      const originalCwd = process.cwd;
      const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-no-root-'));
      const registryConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-registry-test-'));

      try {
        // Force resolution into a deterministic no-Reasonbook path.
        process.cwd = () => emptyWorkspace;
        delete process.env[RBOOK_PROJECT_ROOT_ENV];
        RbookDetector.resetInstance();
        ProjectGraphRegistry.resetInstance();
        await ProjectGraphRegistry.create({ configDir: registryConfigDir });

        // Call without projectRoot - should fail with clear resolution guidance.
        const result = await rbookMissionStart({ missionId: 'm1' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
        // s92-m01: the refusal names the folder the call came from.
        expect(result.error?.message).toContain(`No Reasonbook project in '${emptyWorkspace}'`);
      } finally {
        process.cwd = originalCwd;
        ProjectGraphRegistry.resetInstance();
        fs.rmSync(emptyWorkspace, { recursive: true, force: true });
        fs.rmSync(registryConfigDir, { recursive: true, force: true });
      }
    });
  });
});

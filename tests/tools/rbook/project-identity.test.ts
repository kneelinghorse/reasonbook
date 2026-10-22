/**
 * Project Identity Tests
 *
 * Tests for the Layer 0 project identity: ensureProjectIdentityRow,
 * getProjectIdentity, patchProjectIdentity, applyProjectIdentityFieldUpdate,
 * and the rbook_context(contextType="project_identity") view/update handlers.
 *
 * @module tests/tools/rbook/project-identity
 */

import Database from 'better-sqlite3';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  ensureProjectIdentityRow,
  getProjectIdentity,
  patchProjectIdentity,
  applyProjectIdentityFieldUpdate,
  backfillUnknownRbookAddress,
  type ProjectIdentityData,
} from '../../../src/tools/rbook/project-identity';
import {
  rbookContextViewProjectIdentity,
  rbookContextUpdateProjectIdentity,
} from '../../../src/tools/rbook/rbook-context-project-identity';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTempRbookDir(seed?: string): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-project-identity-test-'));
  const rbookDbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(rbookDbDir, { recursive: true });
  const dbPath = path.join(rbookDbDir, 'rbook.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  if (seed) {
    db.exec(seed);
  }

  db.close();
  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<RbookDatabaseClient> {
  const result = await RbookDatabaseClient.create({ dbPath });
  if (!result.success || !result.data) {
    throw new Error(`Failed to open test database: ${result.error?.message}`);
  }
  return result.data;
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ─── ensureProjectIdentityRow ────────────────────────────────────────────────

describe('ensureProjectIdentityRow', () => {
  let tempDir: string;
  let dbPath: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempRbookDir());
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('creates the project_identity row when absent', () => {
    const result = ensureProjectIdentityRow(client);
    expect(result.alreadyCurrent).toBe(false);
    expect(result.rowsUpdated).toBe(1);

    const row = client.getOne<{ id: string; content: string }>(
      "SELECT id, content FROM contexts WHERE id = 'project_identity'",
      []
    );
    expect(row.success).toBe(true);
    expect(row.data?.id).toBe('project_identity');

    const parsed = JSON.parse(row.data!.content) as ProjectIdentityData;
    expect(parsed.identity_contract_version).toBe('v1');
    expect(parsed.platform).toBe('aquex.ai');
    expect(Array.isArray(parsed.objectives)).toBe(true);
  });

  it('is idempotent — does not create a duplicate row', () => {
    ensureProjectIdentityRow(client);
    const second = ensureProjectIdentityRow(client);
    expect(second.alreadyCurrent).toBe(true);
    expect(second.rowsUpdated).toBe(0);

    const count = client.getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM contexts WHERE id = 'project_identity'",
      []
    );
    expect(count.data?.count).toBe(1);
  });

  it('seeds project_name and description from master_context blob', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project_identity":{"name":"My Project","description":"A test project","status":"active_development"}}',
        datetime('now')
      )
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const identity = getProjectIdentity(client);

    expect(identity?.project_name).toBe('My Project');
    expect(identity?.description).toBe('A test project');
    expect(identity?.status).toBe('active_development');
  });

  it('seeds from metadata project_id when available', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_id', 'test-uuid-1234'), ('project_name', 'Metadata Project')
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const identity = getProjectIdentity(client);

    expect(identity?.project_id).toBe('test-uuid-1234');
    expect(identity?.project_name).toBe('Metadata Project');
  });

  it('produces canonical rbook_address when metadata.owner is set', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('owner', 'derek'), ('dashboard_slug', 'cmos-mcp')
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const identity = getProjectIdentity(client);

    expect(identity?.rbook_address).toBe('rbook://derek/cmos-mcp');
    expect(identity?.rbook_address).not.toContain('unknown');
  });

  it('falls back to metadata.dashboard_username when metadata.owner is absent', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_username', 'derek'), ('dashboard_slug', 'cmos-mcp')
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const identity = getProjectIdentity(client);

    expect(identity?.rbook_address).toBe('rbook://derek/cmos-mcp');
    expect(identity?.rbook_address).not.toContain('unknown');
  });

  it('NEVER emits rbook://unknown/* when owner is unresolvable', async () => {
    // No metadata.owner, no metadata.dashboard_username, no dashboard — this used to produce
    // rbook://unknown/<slug>. Regression guard for Sprint 52 m01.
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp')
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const identity = getProjectIdentity(client);

    expect(identity?.rbook_address ?? '').not.toMatch(/^rbook:\/\/unknown\//);
    expect(identity?.rbook_address ?? '').not.toContain('unknown');
  });
});

// ─── backfillUnknownRbookAddress ──────────────────────────────────────────────

describe('backfillUnknownRbookAddress', () => {
  let tempDir: string;
  let dbPath: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempRbookDir());
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('rewrites rbook://unknown/<slug> when owner metadata is now set', async () => {
    // Simulate legacy row seeded with the old 'unknown' form
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp');
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'project_identity',
        'rbook/contexts/project-identity.json',
        '{"project_id":"cmos-mcp","project_name":"Reasonbook MCP","${LEGACY.identityAddressKey}":"${LEGACY.addressScheme}unknown/cmos-mcp","platform":"aquex.ai","domain":"","project_type":"build","tier":"build","status":"active_development","description":"","objectives":[],"related_projects":[],"foundational_docs":[],"tracelab_refs":[],"type_fields":{},"identity_contract_version":"v1","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}',
        datetime('now')
      );
      INSERT INTO metadata (key, value) VALUES ('owner', 'derek');
    `);
    db.close();
    client = await openClient(dbPath);

    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(true);

    const identity = getProjectIdentity(client);
    expect(identity?.rbook_address).toBe('rbook://derek/cmos-mcp');
    expect(identity?.rbook_address).not.toContain('unknown');
  });

  it('Sprint 65 m02: leaves a user-set non-canonical rbook_address alone (no silent re-canonicalization)', async () => {
    // Pre-fix: backfillUnknownRbookAddress unconditionally rewrote the row to
    // the metadata-derived canonical form, so a user-set fork address like
    // `rbook://derek/cmos-mcp-pro` was silently reverted to `rbook://derek/cmos-mcp`
    // on the next rbook_agent_onboard / checkpoint pass (decision #682).
    // Post-fix: only empty + `rbook://unknown/*` rows are healed; user intent wins.
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Stage1'), ('dashboard_slug', 'stage1'), ('owner', 'derek');
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'project_identity',
        'rbook/contexts/project-identity.json',
        '{"project_id":"stage1","project_name":"Stage1","${LEGACY.identityAddressKey}":"${LEGACY.addressScheme}derek/stage1-2","platform":"aquex.ai","domain":"","project_type":"build","tier":"build","status":"active_development","description":"","objectives":[],"related_projects":[],"foundational_docs":[],"tracelab_refs":[],"type_fields":{},"identity_contract_version":"v1","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}',
        datetime('now')
      );
    `);
    db.close();
    client = await openClient(dbPath);

    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(false);
    expect(result.previous).toBe('rbook://derek/stage1-2');
    expect(result.next).toBe('rbook://derek/stage1-2');

    const identity = getProjectIdentity(client);
    expect(identity?.rbook_address).toBe('rbook://derek/stage1-2');
  });

  it('Sprint 65 m02: leaves a manually flipped fork address (rbook://derek/cmos-mcp-pro) alone', async () => {
    // Concrete repro from decision #682: the fork address survives every
    // observation pass. Distinct from the test above because the flip target
    // is structurally different from the metadata-derived form (different slug
    // segment), not just slightly off — this is the actual cmos-mcp-pro scenario.
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp'), ('owner', 'derek');
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'project_identity',
        'rbook/contexts/project-identity.json',
        '{"project_id":"cmos-mcp","project_name":"Reasonbook MCP","${LEGACY.identityAddressKey}":"${LEGACY.addressScheme}derek/cmos-mcp-pro","platform":"aquex.ai","domain":"","project_type":"build","tier":"build","status":"active_development","description":"","objectives":[],"related_projects":[],"foundational_docs":[],"tracelab_refs":[],"type_fields":{},"identity_contract_version":"v1","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}',
        datetime('now')
      );
    `);
    db.close();
    client = await openClient(dbPath);

    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(false);

    const identity = getProjectIdentity(client);
    expect(identity?.rbook_address).toBe('rbook://derek/cmos-mcp-pro');
  });

  it('is a noop when rbook_address is already canonical', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp'), ('owner', 'derek');
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const before = getProjectIdentity(client);
    expect(before?.rbook_address).toBe('rbook://derek/cmos-mcp');

    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(false);

    const after = getProjectIdentity(client);
    expect(after?.rbook_address).toBe('rbook://derek/cmos-mcp');
  });

  it('does not rewrite when owner is still unresolvable', async () => {
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp');
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'project_identity',
        'rbook/contexts/project-identity.json',
        '{"project_id":"cmos-mcp","project_name":"Reasonbook MCP","${LEGACY.identityAddressKey}":"${LEGACY.addressScheme}unknown/cmos-mcp","platform":"aquex.ai","domain":"","project_type":"build","tier":"build","status":"active_development","description":"","objectives":[],"related_projects":[],"foundational_docs":[],"tracelab_refs":[],"type_fields":{},"identity_contract_version":"v1","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}',
        datetime('now')
      );
    `);
    db.close();
    client = await openClient(dbPath);

    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(false);

    // Row still has the old unknown form — but we don't actively worsen it either.
    // We leave it alone; next onboard with a dashboard login will trigger the rewrite.
    const identity = getProjectIdentity(client);
    expect(identity?.rbook_address).toBe('rbook://unknown/cmos-mcp');
  });

  it('also rewrites an empty rbook_address when owner becomes available', async () => {
    // New post-fix path: ensureProjectIdentityRow seeded with '' because owner was absent.
    // Later, owner resolves (via dashboard) → backfill rewrites to canonical.
    client.close();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value)
      VALUES ('project_name', 'Reasonbook MCP'), ('dashboard_slug', 'cmos-mcp');
    `);
    db.close();
    client = await openClient(dbPath);

    ensureProjectIdentityRow(client);
    const before = getProjectIdentity(client);
    expect(before?.rbook_address ?? '').not.toMatch(/^rbook:\/\/unknown\//);

    client.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('owner', 'derek')`);
    const result = backfillUnknownRbookAddress(client);
    expect(result.rewritten).toBe(true);

    const identity = getProjectIdentity(client);
    expect(identity?.rbook_address).toBe('rbook://derek/cmos-mcp');
  });
});

// ─── getProjectIdentity ──────────────────────────────────────────────────────

describe('getProjectIdentity', () => {
  let tempDir: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    const { tempDir: td, dbPath } = makeTempRbookDir();
    tempDir = td;
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('auto-seeds and returns identity on first call', () => {
    const identity = getProjectIdentity(client);
    expect(identity).not.toBeNull();
    expect(identity?.identity_contract_version).toBe('v1');
  });

  it('returns the full identity object with all required fields', () => {
    const identity = getProjectIdentity(client);
    expect(identity).toMatchObject({
      project_id: expect.any(String),
      project_name: expect.any(String),
      rbook_address: expect.any(String),
      platform: 'aquex.ai',
      domain: expect.any(String),
      project_type: expect.any(String),
      tier: expect.any(String),
      status: expect.any(String),
      description: expect.any(String),
      objectives: expect.any(Array),
      related_projects: expect.any(Array),
      foundational_docs: expect.any(Array),
      tracelab_refs: expect.any(Array),
      type_fields: expect.any(Object),
      identity_contract_version: 'v1',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });
});

// ─── patchProjectIdentity ────────────────────────────────────────────────────

describe('patchProjectIdentity', () => {
  let tempDir: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    const { tempDir: td, dbPath } = makeTempRbookDir();
    tempDir = td;
    client = await openClient(dbPath);
    ensureProjectIdentityRow(client);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('updates top-level string fields', () => {
    patchProjectIdentity(client, { description: 'Updated description', domain: 'AI tools' });
    const identity = getProjectIdentity(client);
    expect(identity?.description).toBe('Updated description');
    expect(identity?.domain).toBe('AI tools');
  });

  it('updates array fields', () => {
    patchProjectIdentity(client, { objectives: ['Build faster', 'Ship quality'] });
    const identity = getProjectIdentity(client);
    expect(identity?.objectives).toEqual(['Build faster', 'Ship quality']);
  });

  it('preserves unpatched fields', () => {
    patchProjectIdentity(client, { project_name: 'TestProject', platform: 'aquex.ai' });
    patchProjectIdentity(client, { domain: 'test-domain' });

    const identity = getProjectIdentity(client);
    expect(identity?.project_name).toBe('TestProject');
    expect(identity?.platform).toBe('aquex.ai');
    expect(identity?.domain).toBe('test-domain');
  });

  it('returns true on success', () => {
    const result = patchProjectIdentity(client, { domain: 'test' });
    expect(result).toBe(true);
  });
});

// ─── applyProjectIdentityFieldUpdate ─────────────────────────────────────────

describe('applyProjectIdentityFieldUpdate', () => {
  let tempDir: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    const { tempDir: td, dbPath } = makeTempRbookDir();
    tempDir = td;
    client = await openClient(dbPath);
    ensureProjectIdentityRow(client);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('updates a top-level field via dot notation', () => {
    const result = applyProjectIdentityFieldUpdate(client, 'description', 'New desc');
    expect(result.success).toBe(true);
    expect(getProjectIdentity(client)?.description).toBe('New desc');
  });

  it('updates a nested type_fields field via 2-level dot notation', () => {
    const result = applyProjectIdentityFieldUpdate(client, 'type_fields.stack', ['ts', 'node']);
    expect(result.success).toBe(true);
    expect(getProjectIdentity(client)?.type_fields.stack).toEqual(['ts', 'node']);
  });

  it('returns error for overly deep paths', () => {
    const result = applyProjectIdentityFieldUpdate(client, 'a.b.c', 'value');
    expect(result.success).toBe(false);
    expect(result.message).toContain('too deep');
  });

  it('returns error for empty path', () => {
    const result = applyProjectIdentityFieldUpdate(client, '', 'value');
    expect(result.success).toBe(false);
  });

  it('returns a descriptive error when path is undefined (caller used "field" instead of "path")', () => {
    // Callers sometimes pass {field: "project_name", value: "..."} instead of {path: ...}.
    // Zod strips the unknown "field" key, leaving path=undefined at runtime.
    // Must return a helpful error, not throw TypeError: Cannot read properties of undefined.
    const result = applyProjectIdentityFieldUpdate(
      client,
      undefined as unknown as string,
      'My Project'
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('"path"');
  });

  it('creates nested object if type_fields is empty', () => {
    const result = applyProjectIdentityFieldUpdate(client, 'type_fields.test_framework', 'jest');
    expect(result.success).toBe(true);
    expect(getProjectIdentity(client)?.type_fields.test_framework).toBe('jest');
  });
});

// ─── rbookContextViewProjectIdentity ─────────────────────────────────────────

describe('rbookContextViewProjectIdentity', () => {
  let tempDir: string;

  beforeEach(() => {
    ({ tempDir } = makeTempRbookDir());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('returns the project identity with seeded=true on first call', async () => {
    const result = await rbookContextViewProjectIdentity({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.projectIdentity).toBeDefined();
    expect(result.data?.seeded).toBe(true);
    expect(result.data?.projectIdentity.identity_contract_version).toBe('v1');
  });

  it('returns seeded=false when row already exists', async () => {
    await rbookContextViewProjectIdentity({ projectRoot: tempDir });
    const result = await rbookContextViewProjectIdentity({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.seeded).toBe(false);
  });

  it('includes all required identity fields in the response', async () => {
    const result = await rbookContextViewProjectIdentity({ projectRoot: tempDir });
    const identity = result.data?.projectIdentity;
    expect(identity?.platform).toBe('aquex.ai');
    expect(identity?.identity_contract_version).toBe('v1');
    expect(Array.isArray(identity?.objectives)).toBe(true);
    expect(Array.isArray(identity?.related_projects)).toBe(true);
  });
});

// ─── rbookContextUpdateProjectIdentity ────────────────────────────────────────

describe('rbookContextUpdateProjectIdentity', () => {
  let tempDir: string;

  beforeEach(() => {
    ({ tempDir } = makeTempRbookDir());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it.each(['project_name', 'project_id'])(
    'refuses null %s before any earlier field in the batch can be written',
    async (identityPath) => {
      const seeded = await rbookContextUpdateProjectIdentity({
        fieldUpdates: [
          { path: 'project_name', value: 'Stable project' },
          { path: 'project_id', value: 'stable-project' },
          { path: 'description', value: 'Keep this description.' },
        ],
        projectRoot: tempDir,
      });
      expect(seeded.success).toBe(true);
      const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
      const before = fs.readFileSync(dbPath);
      const result = await rbookContextUpdateProjectIdentity({
        fieldUpdates: [
          { path: 'description', value: 'Must not be partially written.' },
          { path: identityPath, value: null },
        ],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        suggestion: expect.stringContaining(identityPath),
      });
      expect(fs.readFileSync(dbPath)).toEqual(before);
    }
  );

  it('still permits null to clear an ordinary identity field', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [{ path: 'type_fields.detail', value: null }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.projectIdentity.type_fields.detail).toBeNull();
  });

  it('updates fields via fieldUpdates and returns updated identity', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [
        { path: 'description', value: 'My updated description' },
        { path: 'domain', value: 'AI project management' },
      ],
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.fieldsUpdated).toEqual(['description', 'domain']);
    expect(result.data?.projectIdentity.description).toBe('My updated description');
    expect(result.data?.projectIdentity.domain).toBe('AI project management');
  });

  it('returns error when fieldUpdates is empty', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('returns error when fieldUpdates is not provided', async () => {
    const result = await rbookContextUpdateProjectIdentity({ projectRoot: tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('returns error for invalid path depth', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [{ path: 'a.b.c', value: 'deep' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('can update type_fields sub-key', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [{ path: 'type_fields.stack', value: ['typescript', 'sqlite'] }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.projectIdentity.type_fields.stack).toEqual(['typescript', 'sqlite']);
  });

  it('auto-seeds project_identity if not present before update', async () => {
    const result = await rbookContextUpdateProjectIdentity({
      fieldUpdates: [{ path: 'project_name', value: 'Auto-seeded Project' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.projectIdentity.project_name).toBe('Auto-seeded Project');
  });
});

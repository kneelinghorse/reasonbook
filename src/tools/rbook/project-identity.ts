// ABOUTME: Project Identity (Layer 0) — stable, machine-readable project description.
// Stored as a `project_identity` row in the contexts table. Seeded from existing blob on first access.

import { identityFromStorage, identityForStorage } from '../../intelligence/legacy-compat';
import type { RbookDatabaseClient } from './client';
import type { MigrationResult } from './schema-migrations';
import { asLazyRepair, callMayWrite } from './tool-call-context';
import { checkWrite } from './write-guard';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Type-specific extension fields. Keyed by project_type.
 */
export interface ProjectTypeFields {
  // build
  stack?: string[];
  deployment_env?: string;
  repo_branch_strategy?: string;
  test_framework?: string;
  /** False for a project that runs from source and has no build to keep fresh. */
  build_freshness_check?: boolean;
  // research
  research_questions?: string[];
  active_hypotheses?: string[];
  knowledge_areas?: string[];
  // design
  design_system_ref?: string;
  figma_url?: string;
  token_format?: string;
  // product
  user_segments?: string[];
  live_url?: string;
  live_metrics_url?: string;
  // agent
  protocol?: string;
  tool_count?: number;
  requires_auth?: boolean;
  transport?: string;
  [key: string]: unknown;
}

export interface RelatedProject {
  name: string;
  address: string;
  relationship: string;
}

export interface FoundationalDoc {
  title: string;
  path: string;
}

export interface TracelabRef {
  type: 'collection' | 'report' | 'document' | 'chunk' | 'project';
  id: string;
  label: string;
}

/**
 * Full Project Identity schema (Layer 0).
 *
 * Stored as JSON in contexts(id='project_identity').
 * Changes infrequently — only when project purpose/objectives change.
 */
export interface ProjectIdentityData {
  project_id: string;
  project_name: string;
  rbook_address: string;
  platform: string;
  domain: string;
  project_type: 'build' | 'research' | 'design' | 'product' | 'agent' | string;
  tier: 'build' | 'managed' | 'general' | string;
  status: 'active_development' | 'production' | 'archived' | 'mothballed' | string;
  description: string;
  objectives: string[];
  related_projects: RelatedProject[];
  foundational_docs: FoundationalDoc[];
  tracelab_refs: TracelabRef[];
  type_fields: ProjectTypeFields;
  identity_contract_version: string;
  created_at: string;
  updated_at: string;
}

/** Empty project identity template */
const IDENTITY_TEMPLATE: ProjectIdentityData = {
  project_id: '',
  project_name: '',
  rbook_address: '',
  platform: 'aquex.ai',
  domain: '',
  project_type: 'build',
  tier: 'build',
  status: 'active_development',
  description: '',
  objectives: [],
  related_projects: [],
  foundational_docs: [],
  tracelab_refs: [],
  type_fields: {},
  identity_contract_version: 'v1',
  created_at: '',
  updated_at: '',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMetadataValue(client: RbookDatabaseClient, key: string): string | null {
  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    key,
  ]);
  return result.success && result.data ? result.data.value : null;
}

/**
 * Resolve the project owner (username portion of the rbook_address) from local metadata.
 *
 * Priority:
 *   1. `metadata.owner` — canonical, written on registration or dashboard seed
 *   2. `metadata.dashboard_username` — cached from last dashboard login
 *
 * Returns null if neither key is set. Callers must NEVER substitute "unknown" as a
 * fallback — publishing `rbook://unknown/*` corrupts dashboard-side sender attribution
 * (Sprint 52 m01). Prefer an empty rbook_address (to be rewritten later via
 * `backfillUnknownRbookAddress`) over a bogus one.
 */
function resolveLocalOwner(client: RbookDatabaseClient): string | null {
  const owner = getMetadataValue(client, 'owner');
  if (owner && owner.trim().length > 0) return owner.trim();
  const cached = getMetadataValue(client, 'dashboard_username');
  if (cached && cached.trim().length > 0) return cached.trim();
  return null;
}

/**
 * Build the canonical rbook_address or return an empty string when the owner is unknown.
 * Exposed for tests and reuse by the backfill path.
 */
function buildRbookAddress(owner: string | null, slug: string): string {
  if (!owner) return '';
  if (!slug) return '';
  return `rbook://${owner}/${slug}`;
}

function getMasterContextSection(
  client: RbookDatabaseClient,
  section: string
): Record<string, unknown> | null {
  const result = client.getOne<{ content: string }>('SELECT content FROM contexts WHERE id = ?', [
    'master_context',
  ]);
  if (!result.success || !result.data) return null;

  try {
    const parsed = JSON.parse(result.data.content) as Record<string, unknown>;
    const sec = parsed[section];
    if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
      return sec as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractStr(obj: Record<string, unknown> | null, key: string): string {
  if (!obj) return '';
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Ensure the `project_identity` context row exists.
 * If absent, seeds from existing master_context blob + metadata.
 * Safe to call multiple times (idempotent).
 *
 * s93-m11: seeding inserts a row, so a read-classified call (or the review role) never seeds:
 * reads never write the record (decision #1182). It returns the seed as `deferred`, the caller
 * computes the identity in memory (getProjectIdentity), and the next write stores it.
 */
export function ensureProjectIdentityRow(client: RbookDatabaseClient): MigrationResult {
  const existing = client.getOne<{ id: string }>(
    "SELECT id FROM contexts WHERE id = 'project_identity'",
    []
  );

  if (existing.success && existing.data) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  if (!callMayWrite()) {
    return {
      columnsAdded: [],
      indexesCreated: [],
      rowsUpdated: 0,
      alreadyCurrent: false,
      deferred: [
        'No project_identity row is stored yet. This is the identity derived from the master ' +
          "context and metadata; the project's next Reasonbook write stores it.",
      ],
    };
  }

  const identity = seedIdentityFor(client, new Date().toISOString());

  const warnings: string[] = [];
  const insertResult = client.execute(
    `INSERT OR IGNORE INTO contexts (id, source_path, content, updated_at)
     VALUES ('project_identity', 'rbook/contexts/project-identity.json', ?, ?)`,
    [JSON.stringify(identityForStorage(identity)), identity.updated_at]
  );

  // s86-m02b: a failed seed was indistinguishable from "the row was already current" —
  // `inserted` went false, `alreadyCurrent` went true and nothing named the DB error.
  // The flags keep their meaning (reporting `alreadyCurrent: false` here would make the
  // view handler claim it seeded a row that does not exist); the MigrationResult warnings
  // channel (fork f23) carries the failure out.
  const inserted = checkWrite(insertResult, warnings, 'contexts.project_identity seed');
  return {
    columnsAdded: [],
    indexesCreated: [],
    rowsUpdated: inserted ? 1 : 0,
    alreadyCurrent: !inserted,
    warnings,
  };
}

/** The identity a missing row is seeded with, from the master_context blob and metadata. */
function seedIdentityFor(client: RbookDatabaseClient, now: string): ProjectIdentityData {
  // Seed from existing blob
  const projectSection =
    getMasterContextSection(client, 'project_identity') ??
    getMasterContextSection(client, 'project') ??
    {};

  const projectId = getMetadataValue(client, 'project_id') ?? '';
  const projectName =
    extractStr(projectSection, 'name') || getMetadataValue(client, 'project_name') || '';
  const slugOrName = (getMetadataValue(client, 'dashboard_slug') ?? projectName)
    .toLowerCase()
    .replace(/\s+/g, '-');
  const owner = resolveLocalOwner(client);

  const tierResult = client.getOne<{ content: string }>(
    "SELECT content FROM contexts WHERE id = 'project_context'",
    []
  );
  // s93-m12: the stored tier (metadata.project_type) first, so a new Ledger project's identity
  // says general rather than the old build default; then a legacy project_context tier.
  let tier = getMetadataValue(client, 'project_type')?.trim() || 'build';
  if (!getMetadataValue(client, 'project_type')?.trim() && tierResult.success && tierResult.data) {
    try {
      const pc = JSON.parse(tierResult.data.content) as Record<string, unknown>;
      if (typeof pc['tier'] === 'string') tier = pc['tier'];
    } catch {
      // ignore
    }
  }

  // s81-m04: seed the description preferring a NON-EMPTY source in this order — the
  // canonical `metadata.project_description` durability seed, then the master_context
  // `project` section, then the chosen `projectSection`. The old
  // `extractStr(projectSection, 'description')` alone seeded an EMPTY description whenever
  // the `project_identity` section existed but was description-less (it wins the
  // `?? getMasterContextSection('project')` precedence above), ignoring a non-empty
  // `project` section — the Fork B split-brain root (Layer-0 row description went EMPTY
  // while master_context held the correct string).
  const seededDescription =
    (getMetadataValue(client, 'project_description') ?? '').trim() ||
    extractStr(getMasterContextSection(client, 'project'), 'description') ||
    extractStr(projectSection, 'description') ||
    '';

  return {
    ...IDENTITY_TEMPLATE,
    project_id: projectId,
    project_name: projectName,
    rbook_address: buildRbookAddress(owner, slugOrName),
    tier,
    status: extractStr(projectSection, 'status') || 'active_development',
    description: seededDescription,
    created_at: getMetadataValue(client, 'seeded_at') ?? now,
    updated_at: now,
  };
}

/**
 * Fetch and parse the project_identity context row.
 * Returns null if not found.
 *
 * A missing row is seeded on a call that may write, as a lazy repair: the seed is not the caller's
 * write, so it never starts first-write upkeep. s93-m11: on a read it is computed in memory and
 * nothing is inserted, because reads never write the record (decision #1182).
 */
export function getProjectIdentity(client: RbookDatabaseClient): ProjectIdentityData | null {
  if (!callMayWrite()) return readProjectIdentity(client);
  asLazyRepair(() => ensureProjectIdentityRow(client));
  const stored = readStoredIdentity(client);
  return stored === undefined ? null : stored;
}

/**
 * s93-m11 — the project identity without ever writing: the stored row, or the identity a seed
 * would store, derived in memory. For a diagnostic that must not write even outside a dispatched
 * call (whoami, the startup lines, a heal preview), where callMayWrite() is true.
 */
export function readProjectIdentity(client: RbookDatabaseClient): ProjectIdentityData | null {
  const stored = readStoredIdentity(client);
  if (stored !== undefined) return stored;
  return seedIdentityFor(client, new Date().toISOString());
}

/** The stored identity row: undefined when there is none, null when it cannot be read. */
function readStoredIdentity(client: RbookDatabaseClient): ProjectIdentityData | null | undefined {
  const result = client.getOne<{ content: string; updated_at: string | null }>(
    "SELECT content, updated_at FROM contexts WHERE id = 'project_identity'",
    []
  );
  if (!result.success) return null;
  if (!result.data) return undefined;
  try {
    return identityFromStorage(
      JSON.parse(result.data.content) as Record<string, unknown>
    ) as unknown as ProjectIdentityData;
  } catch {
    return null;
  }
}

/**
 * Patch specific top-level fields of the project identity.
 * Merges updates into the existing JSON and persists.
 *
 * @param client - Database client
 * @param updates - Partial fields to merge into the identity object
 * @param warnings - s86-m02b sink. The boolean return says "no write happened" but cannot
 *   say WHY — a missing row and an errored UPDATE both come back `false`. Callers that own
 *   a warnings array should pass it so the DB error reaches the answer; the default keeps
 *   every existing call site source-compatible. Same shape as `ensureColumn` in
 *   schema-migrations.ts, the in-tree sink-parameter model for this mission.
 * @returns true if the row was updated, false if no change or not found
 */
export function patchProjectIdentity(
  client: RbookDatabaseClient,
  updates: Partial<ProjectIdentityData>,
  warnings: string[] = []
): boolean {
  ensureProjectIdentityRow(client);

  const current = getProjectIdentity(client);
  if (!current) return false;

  const merged: ProjectIdentityData = {
    ...current,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const now = new Date().toISOString();
  const result = client.execute(
    "UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'project_identity'",
    [JSON.stringify(identityForStorage(merged)), now]
  );

  return checkWrite(result, warnings, 'project_identity patch (contexts.content)');
}

/**
 * Heal an identity row whose rbook_address is missing or carries the legacy
 * `rbook://unknown/<slug>` placeholder. Called from the async entrypoints
 * (rbook_agent_onboard, checkpoint-backfill, sender-context, sender-identity)
 * after `resolveAndPersistOwner` has seeded metadata.owner from the
 * authenticated dashboard identity. Sprint 52 m01.
 *
 * No-ops when:
 *   - the row is missing,
 *   - the owner is still unresolvable,
 *   - the current rbook_address is a non-empty, non-`rbook://unknown/` value
 *     (Sprint 65 m02: user-set addresses are intentional — e.g. a fork
 *     `rbook://acme/widget-fork` vs canonical `rbook://acme/widget` —
 *     and must survive every observation/onboard pass).
 */
export function backfillUnknownRbookAddress(client: RbookDatabaseClient): {
  rewritten: boolean;
  previous: string | null;
  next: string | null;
} {
  const preview = previewUnknownRbookAddressHeal(client);
  if (!preview.next || preview.next === preview.previous) {
    return { rewritten: false, previous: preview.previous, next: preview.previous };
  }
  const ok = patchProjectIdentity(client, { rbook_address: preview.next });
  return { rewritten: ok, previous: preview.previous, next: ok ? preview.next : preview.previous };
}

/**
 * s93-m11 — the address backfillUnknownRbookAddress would write, computed without writing: `next`
 * is null when there is nothing to repair (an address that is set and not rbook://unknown/*, no
 * owner to build one from, or no identity at all). A read uses it to say what the next write will
 * repair, and to predict, as whoami does, what a write-classified call would resolve.
 */
export function previewUnknownRbookAddressHeal(client: RbookDatabaseClient): {
  previous: string | null;
  next: string | null;
} {
  // Never seeds: a preview writes nothing, whatever the call may do.
  const current = readProjectIdentity(client);
  if (!current) return { previous: null, next: null };

  const existing = current.rbook_address ?? '';

  // Sprint 65 m02: respect user-set non-canonical addresses. The Sprint 52 m01
  // intent was to heal empty + legacy `rbook://unknown/*` rows, not to enforce
  // canonical form on every read. Pre-fix, any unguarded caller (rbook_agent_onboard,
  // checkpoint-backfill) silently reverted manual flips on the next observation —
  // decision #682.
  const needsHeal = existing === '' || /^rbook:\/\/unknown\//.test(existing);
  if (!needsHeal) return { previous: existing, next: null };

  const owner = resolveLocalOwner(client);
  if (!owner) return { previous: existing, next: null };

  const slugSource =
    getMetadataValue(client, 'dashboard_slug') ?? current.project_name ?? current.project_id ?? '';
  const slug = slugSource.toLowerCase().replace(/\s+/g, '-');
  const next = buildRbookAddress(owner, slug);
  return { previous: existing, next: next && next !== existing ? next : null };
}

/**
 * Apply a nested dot-notation field update to the project identity JSON.
 *
 * Supported depth: 1-level (top-level fields) or 2-level (e.g. type_fields.stack).
 * For deeper nesting, use patchProjectIdentity with a merged object.
 *
 * @returns true if updated, false if not found or path invalid
 */
export function applyProjectIdentityFieldUpdate(
  client: RbookDatabaseClient,
  path: string,
  value: unknown
): { success: boolean; message?: string } {
  ensureProjectIdentityRow(client);

  const current = getProjectIdentity(client);
  if (!current) {
    return { success: false, message: 'project_identity row not found' };
  }

  // Guard: path must be a non-empty string. Callers sometimes pass undefined when
  // they use "field" instead of "path" as the key name in the fieldUpdates array.
  if (!path || typeof path !== 'string') {
    return {
      success: false,
      message: `Invalid field path: ${JSON.stringify(path)}. Each fieldUpdates entry must have a "path" key (not "field"), e.g. {path: "project_name", value: "My Project"}.`,
    };
  }

  const parts = path.split('.');
  if (parts.length === 0 || parts.some((p) => !p)) {
    return { success: false, message: `Invalid field path: "${path}"` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = current as any;

  if (parts.length === 1) {
    obj[parts[0]] = value;
  } else if (parts.length === 2) {
    if (obj[parts[0]] === undefined || typeof obj[parts[0]] !== 'object') {
      obj[parts[0]] = {};
    }
    obj[parts[0]][parts[1]] = value;
  } else {
    return {
      success: false,
      message: `Path "${path}" is too deep. Use patchProjectIdentity for complex updates.`,
    };
  }

  obj['updated_at'] = new Date().toISOString();

  const now = new Date().toISOString();
  const result = client.execute(
    "UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'project_identity'",
    [JSON.stringify(identityForStorage(obj)), now]
  );

  // s86-m02b: `{success, message}` IS this function's warnings channel — the handler at
  // rbook-context-project-identity.ts renders `message` straight into createError — so
  // route the failure through checkWrite instead of hand-rolling the text, and never hand
  // back a `success: false` with an undefined message (`result.error?.message` alone can be).
  const writeWarnings: string[] = [];
  if (!checkWrite(result, writeWarnings, `project_identity.${path}`)) {
    return { success: false, message: writeWarnings[0] };
  }

  return { success: true };
}

/**
 * s87-m03 — the ONE derivation of a project's dashboard slug.
 *
 * It existed three times, spelled identically by hand: `rbook-db-backfill.ts` had it as a private
 * helper, `rbook-agent-onboard.ts` inlined it inside `fetchSyncHealth`, and the third site had no
 * slug at all and simply asked the dashboard for everything. Three copies of one rule is how the
 * four `getSyncStatus` call sites came to disagree about what "this project" meant — one of them
 * scoped, three of them platform-wide, all of them describing their answer as this project's.
 *
 * Hoisted here rather than into either caller because the slug IS an identity fact, and this
 * module is where identity facts are derived.
 */
export function deriveProjectSlug(projectName: string): string {
  return projectName.toLowerCase().replace(/\s+/g, '-');
}

// ABOUTME: Embedding pipeline (Sprint 66 m03). Singleton @xenova/transformers feature-extractor for Xenova/all-MiniLM-L6-v2,
// per-type embedding-input composition, and recordEmbedding() — the write-path hook that hash-compares against
// last_embedded_hash, embeds on change, and upserts into <type>_vec. Architecture per rbook/planning/adr/s66-vector-retrieval.md.

import { composeDecisionText, type DecisionTextRow } from '../tools/rbook/decision-fields';
import * as crypto from 'crypto';
import { debugLog } from '../debug-log';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import { ensureVectorStorageForWrite } from '../tools/rbook/schema-migrations';
import { checkWrite } from '../tools/rbook/write-guard';
import { applyOfflineTransformersEnv, type TransformersEnv } from './transformers-offline-env';

// ─── Public types ────────────────────────────────────────────────────────────

export type EmbeddingType = 'decision' | 'learning' | 'mission';
export type Embedder = (text: string) => Promise<Float32Array>;

export interface MissionEmbeddingFields {
  name: string;
  objective: string | null;
  notes: string | null;
  successCriteria: readonly string[] | null;
}

export interface RecordEmbeddingTarget {
  type: EmbeddingType;
  /** decision/learning use INTEGER ids; mission uses TEXT id (e.g. "s66-m03"). */
  id: number | string;
  /** Canonical input text. Use the *EmbeddingInput helpers below to compose. */
  inputText: string;
}

/**
 * `skipped-unavailable` (s92-m07): no embedder in this process. The optional package is not
 * installed, or it failed to load (reported once, at load). `failed`: this write's attempt failed.
 */
export type RecordEmbeddingAction =
  | 'embedded'
  | 'skipped-no-change'
  | 'skipped-unavailable'
  | 'failed';

export interface RecordEmbeddingResult {
  action: RecordEmbeddingAction;
  error?: string;
  /**
   * Sprint 86 m02b — DB errors from the vec0 upsert and the `last_embedded_hash`
   * write, which used to be discarded. Callers splice these into their own warnings
   * sink so the answer discloses that the row will not be findable by vector search.
   * s96-m11: also the vector storage setup's warnings; empty when nothing failed.
   */
  warnings?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

/**
 * s92-m07: the embedding stack is an OPTIONAL peer dependency. On 2,132 natural citation labels,
 * keyword-only recall@10 (0.637) beat equal-weight hybrid (0.592) once the keyword arm read every
 * query keyword, and the stack was about 81% of a 306 MB install. Absent, writes and searches run
 * keyword-only and print nothing; `rbook_db(action="health")` says which state this process is in.
 */
export const TRANSFORMERS_PACKAGE = '@xenova/transformers';

// ─── Optional-peer state (s92-m07) ───────────────────────────────────────────

type EmbedderAvailability =
  | { state: 'unknown' }
  | { state: 'loaded' }
  | { state: 'not-installed' }
  | { state: 'failed'; reason: string };

let availability: EmbedderAvailability = { state: 'unknown' };
let transformersLoader: (() => Promise<unknown>) | null = null;
let transformersResolver: (() => boolean) | null = null;

/** Test hook: stand in for `import('@xenova/transformers')`. Pass null to restore it. */
export function setTransformersLoaderForTesting(loader: (() => Promise<unknown>) | null): void {
  transformersLoader = loader;
}

/** Test hook: stand in for "is the package installed?". Pass null to restore it. */
export function setTransformersResolverForTesting(resolver: (() => boolean) | null): void {
  transformersResolver = resolver;
}

function transformersInstalled(): boolean {
  if (transformersResolver) return transformersResolver();
  try {
    require.resolve(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the import failed because the optional package itself is absent. Node quotes the
 * missing name in both forms ("Cannot find module '…'" from require, "Cannot find package '…'" from
 * import). A package that is present but missing one of ITS dependencies names that dependency
 * instead, so it counts as a failed load, which is worth a warning.
 */
function isPackageAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    message.includes(`'${TRANSFORMERS_PACKAGE}'`)
  );
}

/** What `rbook_db(action="health")` reports about semantic (vector) search in this process. */
export interface SemanticSearchStatus {
  /** True when the vector term can take part: the package is installed and has not failed. */
  enabled: boolean;
  state: 'loaded' | 'installed' | 'not-installed' | 'failed';
  detail: string;
}

/** The current semantic-search state. Never loads the package or the model. */
export function semanticSearchStatus(): SemanticSearchStatus {
  const notInstalled: SemanticSearchStatus = {
    enabled: false,
    state: 'not-installed',
    detail:
      `the optional package ${TRANSFORMERS_PACKAGE} is not installed, so search is keyword-only. ` +
      'Install it next to @aquex/reasonbook to add a vector term.',
  };
  switch (availability.state) {
    case 'loaded':
      return { enabled: true, state: 'loaded', detail: `${EMBEDDING_MODEL} is loaded` };
    case 'not-installed':
      return notInstalled;
    case 'failed':
      return {
        enabled: false,
        state: 'failed',
        detail: `${TRANSFORMERS_PACKAGE} is installed but failed to load in this process (${availability.reason})`,
      };
    case 'unknown':
      return transformersInstalled()
        ? {
            enabled: true,
            state: 'installed',
            detail:
              `${TRANSFORMERS_PACKAGE} is installed; ${EMBEDDING_MODEL} loads on first use and is ` +
              'downloaded once, unless RBOOK_OFFLINE_EMBEDDINGS=1',
          }
        : notInstalled;
  }
}

/** True when the real loader has run in this process and left no embedder behind. */
export function isEmbedderUnavailable(): boolean {
  return (
    testEmbedder === null &&
    (availability.state === 'not-installed' || availability.state === 'failed')
  );
}

// ─── Embedder singleton (with test-injection hook) ───────────────────────────

let cachedEmbedder: Embedder | null = null;
let testEmbedder: Embedder | null = null;
let embedderLoadPromise: Promise<Embedder> | null = null;
let embedderLoadAttempts = 0;

/**
 * Override the embedder used by `recordEmbedding`. Pass null to restore the
 * default lazy-loaded Xenova pipeline. Tests use this to inject a fake.
 */
export function setEmbedderForTesting(embedder: Embedder | null): void {
  testEmbedder = embedder;
}

/**
 * Resolve the active embedder. Priority: test override > cached singleton (a real
 * embedder OR the negative-cache no-op) > a single lazy-load attempt.
 *
 * NEGATIVE CACHE (Sprint 78 m03): `loadXenovaEmbedder` is attempted AT MOST ONCE
 * per process. On failure — e.g. offline (`RBOOK_OFFLINE_EMBEDDINGS=1`) with the
 * model not in the local cache — we cache a no-op embedder that throws on use, so
 * `recordEmbedding` and `HybridRetriever.embedQuery` fall into their catch/degrade
 * paths instantly instead of re-hitting HuggingFace (a per-call network timeout).
 * A concurrent burst shares the one in-flight load via `embedderLoadPromise`.
 */
export async function getEmbedder(): Promise<Embedder> {
  if (testEmbedder) return testEmbedder;
  if (cachedEmbedder) return cachedEmbedder;
  if (!embedderLoadPromise) {
    embedderLoadPromise = (async () => {
      embedderLoadAttempts += 1;
      try {
        cachedEmbedder = await loadXenovaEmbedder();
        availability = { state: 'loaded' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        if (isPackageAbsent(error)) {
          // s92-m07: a supported configuration, not a failure. Named once, and only under RBOOK_DEBUG.
          availability = { state: 'not-installed' };
          debugLog(
            `[DEBUG] embedding-pipeline: ${TRANSFORMERS_PACKAGE} is not installed — semantic ` +
              'search off, keyword search only'
          );
        } else {
          availability = { state: 'failed', reason: message };
          console.error(
            `[WARN] embedding-pipeline: embedder load failed — vector arm disabled (BM25-only), ` +
              `not retrying this process — ${message}`
          );
        }
        cachedEmbedder = makeUnavailableEmbedder(message);
      } finally {
        embedderLoadPromise = null;
      }
      return cachedEmbedder as Embedder;
    })();
  }
  return embedderLoadPromise;
}

/**
 * The no-op embedder cached after a failed load (negative cache). Throws on use;
 * callers (recordEmbedding, HybridRetriever.embedQuery) catch it and degrade to
 * BM25-only / action:'failed' rather than re-attempting the network fetch.
 */
function makeUnavailableEmbedder(reason: string): Embedder {
  return async () => {
    throw new Error(`embedder unavailable — vector arm disabled (${reason})`);
  };
}

async function loadXenovaEmbedder(): Promise<Embedder> {
  // @xenova/transformers is ESM-only — dynamic import works from CJS context. s92-m07: it is an
  // optional peer dependency, so this import failing with "not found" is an expected state.
  const transformers = (await (transformersLoader
    ? transformersLoader()
    : import('@xenova/transformers'))) as unknown as {
    pipeline: (task: string, model: string) => Promise<XenovaFeatureExtractor>;
    env: TransformersEnv;
  };
  // Local-forever hook (s78-m03): honor RBOOK_OFFLINE_EMBEDDINGS / RBOOK_MODEL_CACHE_DIR
  // BEFORE pipeline() so an offline install fails fast into the negative cache instead
  // of blocking on a HuggingFace fetch.
  applyOfflineTransformersEnv(transformers.env);
  const extractor = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL);
  return async (text: string) => {
    const result = (await extractor(text, { pooling: 'mean', normalize: true })) as {
      data: Float32Array;
    };
    const data = result.data;
    if (data.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${data.length} — wrong model?`);
    }
    // Defensive copy: the pipeline reuses the underlying buffer across calls
    // when running in the same process (Xenova's TensorImpl recycles output
    // tensors), so callers that retain the returned array see surprising
    // mutations. Slice produces an independent Float32Array.
    return data.slice();
  };
}

interface XenovaFeatureExtractor {
  (
    text: string,
    options: { pooling: 'mean'; normalize: boolean }
  ): Promise<{
    data: Float32Array;
  }>;
}

// ─── Per-type embedding-input composition ────────────────────────────────────

export function decisionEmbeddingInput(decisionText: string | DecisionTextRow): string {
  return typeof decisionText === 'string' ? decisionText.trim() : composeDecisionText(decisionText);
}

export function learningEmbeddingInput(content: string): string {
  return content.trim();
}

/**
 * Flatten the four indexable mission fields into one semantic passage that
 * the embedder sees as a coherent piece of text. The format matches the
 * canonical layout in rbook/planning/adr/s66-vector-retrieval.md Decision 5.
 */
export function missionEmbeddingInput(fields: MissionEmbeddingFields): string {
  const parts: string[] = [fields.name.trim()];
  if (fields.objective && fields.objective.trim()) {
    parts.push(` — ${fields.objective.trim()}`);
  }
  if (fields.notes && fields.notes.trim()) {
    parts.push(` | ${fields.notes.trim()}`);
  }
  if (fields.successCriteria && fields.successCriteria.length > 0) {
    const criteria = fields.successCriteria
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('; ');
    if (criteria) parts.push(` | criteria: ${criteria}`);
  }
  return parts.join('');
}

// ─── Vector packing for sqlite-vec ───────────────────────────────────────────

/** Pack a Float32Array into the byte buffer shape sqlite-vec stores. */
export function packEmbedding(values: Float32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

// ─── recordEmbedding — main write-path hook ──────────────────────────────────

/**
 * Hash-compare → embed-if-changed → upsert into <type>_vec → record the new
 * `last_embedded_hash` on the source row.
 *
 * NEVER throws. Per the m01 ADR's failure posture (Decision 4), embedding
 * failures degrade silently — the vector arm of the hybrid retriever tolerates
 * missing rows. Returns an action enum for telemetry, not for control flow at
 * the caller.
 *
 * Sprint 86 m02b: a vec0 or `last_embedded_hash` write that ERRORS is no longer
 * discarded — its DB error comes back in `warnings` so the caller can splice it
 * into its own sink. Still not control flow, and still never a throw.
 *
 * The corresponding source-table row MUST already exist (write-path hooks call
 * after a successful INSERT/UPDATE returns).
 */
export async function recordEmbedding(
  client: RbookDatabaseClient,
  target: RecordEmbeddingTarget
): Promise<RecordEmbeddingResult> {
  const warnings: string[] = [];
  try {
    const hash = crypto.createHash('sha256').update(target.inputText).digest('hex');

    const stored = readLastEmbeddedHash(client, target.type, target.id);
    if (stored === hash) {
      return { action: 'skipped-no-change' };
    }

    const embed = await getEmbedder();
    // s92-m07: no embedder in this process is a state, reported once at load, not per write.
    if (isEmbedderUnavailable()) return { action: 'skipped-unavailable' };
    const vec = await embed(target.inputText);
    const blob = packEmbedding(vec);

    // s96-m11 (#642): a store made its vector tables at its first search, after its first write.
    const storage = ensureVectorStorageForWrite(client, tableMeta(target.type).vecTable);
    warnings.push(...(storage.warnings ?? []));

    const upsertError = upsertVector(client, target.type, target.id, blob);
    const hashError = writeLastEmbeddedHash(client, target.type, target.id, hash);
    for (const error of [upsertError, hashError]) if (error !== null) warnings.push(error);
    return { action: 'embedded', warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`[WARN] embedding-pipeline: ${target.type}#${target.id} failed — ${message}`);
    // s96-m11: callers carry only the warnings, so a failure is one; it used to vanish.
    warnings.push(`${target.type} ${target.id} was saved without its embedding: ${message}`);
    return { action: 'failed', error: message, warnings };
  }
}

// ─── Internal DB plumbing ────────────────────────────────────────────────────

interface TableMeta {
  vecTable: string;
  vecColumn: string;
  sourceTable: string;
  /** True when the source id is a JS Number that must be wrapped in BigInt
   *  before binding to a vec0 INTEGER PRIMARY KEY column (see m02 learning). */
  needsBigInt: boolean;
}

function tableMeta(type: EmbeddingType): TableMeta {
  switch (type) {
    case 'decision':
      return {
        vecTable: 'decisions_vec',
        vecColumn: 'decision_id',
        sourceTable: 'strategic_decisions',
        needsBigInt: true,
      };
    case 'learning':
      return {
        vecTable: 'learnings_vec',
        vecColumn: 'learning_id',
        sourceTable: 'learnings',
        needsBigInt: true,
      };
    case 'mission':
      return {
        vecTable: 'missions_vec',
        vecColumn: 'mission_id',
        sourceTable: 'missions',
        needsBigInt: false,
      };
  }
}

function coerceVecId(id: number | string, needsBigInt: boolean): unknown {
  if (typeof id === 'string') return id;
  return needsBigInt ? BigInt(id) : id;
}

function readLastEmbeddedHash(
  client: RbookDatabaseClient,
  type: EmbeddingType,
  id: number | string
): string | null {
  const meta = tableMeta(type);
  const row = client.getOne<{ last_embedded_hash: string | null }>(
    `SELECT last_embedded_hash FROM ${meta.sourceTable} WHERE id = ?`,
    [id]
  );
  if (!row.success || !row.data) return null;
  return row.data.last_embedded_hash ?? null;
}

/** Returns a DB-error string when the UPDATE failed, null when it ran (s86-m02b). */
function writeLastEmbeddedHash(
  client: RbookDatabaseClient,
  type: EmbeddingType,
  id: number | string,
  hash: string
): string | null {
  const meta = tableMeta(type);
  const warnings: string[] = [];
  const updated = client.execute(
    `UPDATE ${meta.sourceTable} SET last_embedded_hash = ? WHERE id = ?`,
    [hash, id]
  );
  checkWrite(updated, warnings, `${meta.sourceTable}.last_embedded_hash`);
  return warnings[0] ?? null;
}

/** Returns a DB-error string when either statement failed, null when both ran (s86-m02b). */
function upsertVector(
  client: RbookDatabaseClient,
  type: EmbeddingType,
  id: number | string,
  blob: Buffer
): string | null {
  const meta = tableMeta(type);
  const coercedId = coerceVecId(id, meta.needsBigInt);
  const warnings: string[] = [];
  // vec0 doesn't support ON CONFLICT — delete-then-insert is the canonical
  // upsert idiom. Safe in a single transaction; the source-table row is the
  // authoritative reference (the vec0 row is a derived index entry).
  const deleted = client.execute(`DELETE FROM ${meta.vecTable} WHERE ${meta.vecColumn} = ?`, [
    coercedId,
  ]);
  checkWrite(deleted, warnings, `${meta.vecTable}.delete`);
  const inserted = client.execute(
    `INSERT INTO ${meta.vecTable}(${meta.vecColumn}, embedding) VALUES (?, ?)`,
    [coercedId, blob]
  );
  checkWrite(inserted, warnings, `${meta.vecTable}.insert`);
  return warnings.length > 0 ? warnings.join('; ') : null;
}

// ─── Test reset (called between test cases) ──────────────────────────────────

/** Drop the cached real Xenova embedder (incl. the negative-cache no-op) and the
 *  load-attempt counter. Tests call this in afterAll if they ever invoked the real
 *  pipeline (rare — usually tests inject a mock). */
export function __resetEmbedderCacheForTesting(): void {
  cachedEmbedder = null;
  testEmbedder = null;
  embedderLoadPromise = null;
  embedderLoadAttempts = 0;
  availability = { state: 'unknown' };
}

/** Test-observable count of real embedder load attempts — the negative-cache proof
 *  (repeated getEmbedder() calls after a failure must NOT re-attempt the load). */
export function __getEmbedderLoadAttemptsForTesting(): number {
  return embedderLoadAttempts;
}

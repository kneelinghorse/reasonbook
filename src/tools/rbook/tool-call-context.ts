// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Request-local action mode and project-identity disclosures for one MCP tool call.
// ABOUTME: AsyncLocalStorage keeps concurrent read/write calls from leaking policy or warnings.

import { AsyncLocalStorage } from 'async_hooks';

import type { ActionMode } from './action-taxonomy';
import type { CliRemedyTarget } from '../../utils/cli-remedy';
import { isReadOnlyAgentSession } from './read-only-agent-guard';

interface ToolCallContext {
  readonly actionMode: ActionMode;
  projectResolution?: CliRemedyTarget;
  readonly projectIdentityDisclosures: Set<string>;
  readonly storeUpkeepNotes: Set<string>;
  /** s93-m11 — the database files this call changed a row in (see recordStoreWrite). */
  readonly writtenStores: Set<string>;
  /** s96-m12 — the copies of a shared record this call opened (see recordSharedStore). */
  readonly sharedStores: Set<string>;
  /** s93-m11 — how many lazy repairs are running now (see asLazyRepair). */
  lazyRepairDepth: number;
}

export interface ToolCallCapture<T> {
  readonly value: T;
  readonly projectIdentityDisclosures: readonly string[];
  readonly storeUpkeepNotes: readonly string[];
}

const toolCallStorage = new AsyncLocalStorage<ToolCallContext>();

/** Unique carrier for one failed capture; the original thrown value is unwrapped at the boundary. */
class CapturedToolCallError extends Error {
  readonly originalError: unknown;
  readonly projectIdentityDisclosures: readonly string[];

  constructor(originalError: unknown, projectIdentityDisclosures: readonly string[]) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'CapturedToolCallError';
    this.originalError = originalError;
    this.projectIdentityDisclosures = projectIdentityDisclosures;
    if (originalError instanceof Error && originalError.stack) this.stack = originalError.stack;
  }
}

/** The current dispatch call's read/write classification, or undefined outside dispatch. */
export function currentToolCallActionMode(): ActionMode | undefined {
  return toolCallStorage.getStore()?.actionMode;
}

/** Preserve the selected project and source for remedies emitted by nested handlers. */
export function setToolProjectResolution(project: CliRemedyTarget): void {
  const context = toolCallStorage.getStore();
  if (context) context.projectResolution = project;
}

export function currentToolProjectResolution(): CliRemedyTarget | undefined {
  return toolCallStorage.getStore()?.projectResolution;
}

/**
 * s93-m11 — whether this call may write the record. A read-classified call never does (Q10,
 * #1182: reads never write the record), and neither does any call under the review role. Lazy
 * repairs that rewrite existing values (the address heal, the identity seed, the schema label)
 * compute their result in memory instead when this is false. A direct caller outside dispatch has
 * no classification and keeps the write-capable behaviour, as registration does (client.ts).
 */
export function callMayWrite(): boolean {
  return currentToolCallActionMode() !== 'read' && !isReadOnlyAgentSession();
}

/**
 * s93-m11 — record one line about store upkeep this call performed (the first-write staleness
 * repair, a persisted blob migration) or found owed and left for a write (a search index out of
 * step), so a write the caller did not ask for, or a gap in what a read could see, rides its answer.
 */
export function recordStoreUpkeepNote(message: string): void {
  toolCallStorage.getStore()?.storeUpkeepNotes.add(message);
}

/**
 * s96-m12 — note that this call opened a copy of a shared record, so its answer can carry what a
 * person must know there: fields in conflict, and an id two copies created.
 */
export function recordSharedStore(dbPath: string): void {
  toolCallStorage.getStore()?.sharedStores.add(dbPath);
}

/** s96-m12 — the copies of a shared record this call opened. */
export function currentSharedStores(): string[] {
  return [...(toolCallStorage.getStore()?.sharedStores ?? [])];
}

/**
 * s93-m11 — note that this call changed a row in the database at `dbPath` (an INSERT, UPDATE,
 * DELETE or REPLACE that changed at least one row). First-write upkeep runs only for a store the
 * call really wrote: a write-classified call that only read (onboard without feedback, a review
 * report) or that was refused before writing leaves no trace here, and neither does a lazy repair
 * the call made on its way (asLazyRepair).
 */
export function recordStoreWrite(dbPath: string): void {
  const context = toolCallStorage.getStore();
  if (!context || context.lazyRepairDepth > 0) return;
  context.writtenStores.add(dbPath);
}

/**
 * s93-m11 — run a repair the call makes on its way rather than for its caller: the address heal,
 * the identity seed, the schema label. Its writes still happen on a call that may write; they just
 * do not count as the call having written the record, so a report that healed an address (onboard,
 * a decisions review) never starts first-write upkeep and its status writes (m11 fork 4).
 * Synchronous only, so no other step of the same call can run inside the bracket.
 */
export function asLazyRepair<T>(repair: () => T): T {
  const context = toolCallStorage.getStore();
  if (!context) return repair();
  context.lazyRepairDepth += 1;
  try {
    return repair();
  } finally {
    context.lazyRepairDepth -= 1;
  }
}

/** s93-m11 — the database files this call has changed a row in so far. */
export function currentWrittenStores(): readonly string[] {
  return [...(toolCallStorage.getStore()?.writtenStores ?? [])];
}

/**
 * Record one fallback-identity disclosure on the current MCP answer.
 *
 * The Set de-duplicates repeated `getProjectId` reads inside one call. There is deliberately no
 * process-wide suppression here: stderr is noisy and may warn once per store, but every agent
 * answer that relies on a fallback must carry the fact itself.
 */
export function recordProjectIdentityDisclosure(message: string): void {
  toolCallStorage.getStore()?.projectIdentityDisclosures.add(message);
}

/** Run one MCP dispatch inside a concurrency-safe request context and return its disclosures. */
export async function captureToolCall<T>(
  actionMode: ActionMode,
  operation: () => Promise<T>
): Promise<ToolCallCapture<T>> {
  const context: ToolCallContext = {
    actionMode,
    projectIdentityDisclosures: new Set<string>(),
    storeUpkeepNotes: new Set<string>(),
    sharedStores: new Set<string>(),
    writtenStores: new Set<string>(),
    lazyRepairDepth: 0,
  };
  try {
    const value = await toolCallStorage.run(context, operation);
    return {
      value,
      projectIdentityDisclosures: [...context.projectIdentityDisclosures],
      storeUpkeepNotes: [...context.storeUpkeepNotes],
    };
  } catch (error) {
    // A unique carrier belongs to this capture, even when concurrent handlers throw the same
    // Error instance. The MCP boundary unwraps the original for reporting, so its message/stack
    // remain authoritative without using the thrown object itself as request-local storage.
    const inherited =
      error instanceof CapturedToolCallError ? error.projectIdentityDisclosures : [];
    const originalError = error instanceof CapturedToolCallError ? error.originalError : error;
    throw new CapturedToolCallError(originalError, [
      ...new Set([...inherited, ...context.projectIdentityDisclosures]),
    ]);
  }
}

/** Return disclosures captured by this specific failed MCP request. */
export function projectIdentityDisclosuresForError(error: unknown): readonly string[] {
  return error instanceof CapturedToolCallError ? error.projectIdentityDisclosures : [];
}

/** Recover the handler's original thrown value from a failed capture carrier. */
export function unwrapCapturedToolCallError(error: unknown): unknown {
  return error instanceof CapturedToolCallError ? error.originalError : error;
}

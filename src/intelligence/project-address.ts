// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads stored project identities without migrations, repairs, or journal-mode changes.
// ABOUTME: Address lookup needs complete discovery because an unreadable store can hide a duplicate.

import Database from 'better-sqlite3';
import {
  isRecordAddress,
  normalizeAddressScheme,
  resolveRecordPaths,
  storedAddress,
} from './legacy-compat';
import { processBusyTimeout } from '../tools/rbook/sqlite-busy';
import type { ProjectGraphRegistry } from './project-graph-registry';

export const ADDRESS_REMEDY =
  'Call rbook_project(action="list") to see registered addresses and paths, then pass projectRoot as an exact address or a project folder.';

export interface StoredProjectAddress {
  readonly id: string;
  readonly address: string | null;
}

export type StoredAddressResult =
  | { readonly identity: StoredProjectAddress; readonly error?: never }
  | { readonly identity: null; readonly error: string };

/** Includes invalid spellings so an attempted address never becomes a relative filesystem path. */
export function isProjectAddress(value: string): boolean {
  return isRecordAddress(value) || value === 'local-only';
}

const ADDRESS_PATTERN = /^rbook:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;

/** No client wrapper here: that wrapper may migrate, seed identity, or turn on WAL. */
export function readStoredProjectAddress(projectRoot: string): StoredAddressResult {
  let db: Database.Database | undefined;
  try {
    db = new Database(resolveRecordPaths(projectRoot).dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: processBusyTimeout() ?? 5000,
    });
    const row = db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
      | { content: unknown }
      | undefined;
    // The metadata row is the canonical ID; older identity blobs can leave their copy empty.
    const idRow = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | { value: unknown }
      | undefined;
    const id = idRow?.value;
    if (typeof id !== 'string' || !id.trim()) throw new Error('metadata has no stored project_id');
    // Normal init defers this row until a later write. A successful empty SELECT proves no
    // stored address; it is distinct from a NULL/malformed row or an unreadable table.
    if (row === undefined) return { identity: { id, address: null } };
    if (typeof row.content !== 'string')
      throw new Error('project_identity content is NULL or invalid');
    const identity: unknown = JSON.parse(row.content);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error('project_identity is not an object');
    }
    const rawAddress = storedAddress(identity as Record<string, unknown>);
    const address =
      typeof rawAddress === 'string' ? normalizeAddressScheme(rawAddress) : rawAddress;
    if (address !== null && typeof address !== 'string') {
      throw new Error('project_identity has an invalid rbook_address');
    }
    if (address && !ADDRESS_PATTERN.test(address)) {
      throw new Error('project_identity has an invalid rbook_address');
    }
    return { identity: { id, address: address || null } };
  } catch (error) {
    return { identity: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * s110-m01: a store's earlier addresses as a rename records them (metadata.previous_rbook_addresses, a
 * JSON array of addresses), normalized to rbook://; or why they cannot be read.
 */
export function readPreviousAddresses(
  projectRoot: string
): { readonly addresses: readonly string[] } | { readonly error: string } {
  let db: Database.Database | undefined;
  try {
    db = new Database(resolveRecordPaths(projectRoot).dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: processBusyTimeout() ?? 5000,
    });
    const row = db
      .prepare("SELECT value FROM metadata WHERE key = 'previous_rbook_addresses'")
      .get() as { value: unknown } | undefined;
    if (row === undefined) return { addresses: [] };
    const list: unknown = typeof row.value === 'string' ? JSON.parse(row.value) : null;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string'))
      throw new Error('it is not a list of addresses');
    return { addresses: (list as string[]).map((entry) => normalizeAddressScheme(entry)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * s110-m01 (R, task 4): when no store holds `address`, the stores that held it before a rename, by
 * the address each holds now; and a note for each store whose list could not be read, which is
 * skipped, never counted as an unreadable identity (that refuses every lookup on the machine).
 */
function renamedFrom(
  address: string,
  stores: ReadonlyArray<{ readonly storePath: string; readonly address: string | null }>
): { readonly now: string[]; readonly notes: string[] } {
  const now: string[] = [];
  const notes: string[] = [];
  for (const store of stores) {
    const previous = readPreviousAddresses(store.storePath);
    if ('error' in previous)
      notes.push(
        `the previous addresses of the project at ${store.storePath} could not be read (${previous.error}), so it was skipped`
      );
    else if (previous.addresses.includes(address))
      now.push(store.address ?? `the project at ${store.storePath}`);
  }
  return { now, notes };
}

/** Returns a path only after every active store was readable and exactly one address matched. */
export function resolveRegisteredAddress(
  address: string,
  registry: ProjectGraphRegistry
): { readonly projectRoot: string } | { readonly error: string } {
  address = normalizeAddressScheme(address);
  if (!ADDRESS_PATTERN.test(address)) {
    return {
      error: `Project address '${address}' is not an exact rbook://owner/project address. Local-only projects need a folder.`,
    };
  }
  const matches: string[] = [];
  const unreadable: string[] = [];
  const readable: Array<{ storePath: string; address: string | null }> = [];
  for (const row of registry.list()) {
    const result = readStoredProjectAddress(row.store_path);
    if (!result.identity) unreadable.push(`${row.store_path}: ${result.error}`);
    else {
      readable.push({ storePath: row.store_path, address: result.identity.address });
      if (result.identity.address === address) matches.push(row.store_path);
    }
  }
  if (unreadable.length) {
    return {
      error: `Cannot resolve '${address}': unreadable registered identity could hide a duplicate. ${unreadable.join('; ')}`,
    };
  }
  // A previous address is read only when no store holds the address now, and still refused: a call
  // that names an old address is told the new one rather than routed to it.
  const renamed = matches.length === 0 ? renamedFrom(address, readable) : { now: [], notes: [] };
  const notes = renamed.notes.length ? ` Note: ${renamed.notes.join('; ')}.` : '';
  if (renamed.now.length) {
    return {
      error:
        `Project address '${address}' is a previous address: the project is now ${renamed.now.join(' and ')}. ` +
        `Pass ${renamed.now.length === 1 ? 'that address' : 'one of those addresses'}, or the project folder.${notes}`,
    };
  }
  if (matches.length !== 1) {
    return {
      error: `Project address '${address}' has ${matches.length} matching active registered stores. Exactly one is required.${notes}`,
    };
  }
  return { projectRoot: matches[0] };
}

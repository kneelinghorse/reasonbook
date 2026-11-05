// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads the identity a rename requires and commits its local fields together.
// ABOUTME: Existing context fields survive; absent or shared identities fail before a remote write.

import { RbookDatabaseClient } from '../tools/rbook/client';
import { isSharedStore } from '../tools/rbook/replica-identity';
import { checkPreviousAddresses } from '../tools/rbook/address-rule';
import {
  identityForStorage,
  normalizeAddressScheme,
  storedAddress,
} from '../intelligence/legacy-compat';
import type { RbookToolResult } from '../tools/rbook/types';

export function checked<T>(result: RbookToolResult<T>): T {
  if (!result.success) throw new Error(result.error?.message ?? 'The operation failed.');
  return result.data as T;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must already be an identity object; repair it before renaming.`);
  return value as Record<string, unknown>;
}

export function readRenameLocal(db: RbookDatabaseClient) {
  if (isSharedStore(db))
    throw new Error(
      'Shared records and members’ copies cannot be renamed; use an unshared owner record.'
    );
  const rows = checked(
    db.getMany<{ key: string; value: string | null }>('SELECT key,value FROM metadata')
  );
  const metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  for (const key of [
    'project_id',
    'project_name',
    'dashboard_project_id',
    'owner',
    'dashboard_slug',
  ])
    if (!metadata[key]?.trim())
      throw new Error(
        `The store has no ${key}; restore its owned dashboard identity before renaming.`
      );
  const context = (id: string) => {
    const row = checked(
      db.getOne<{ content: string }>('SELECT content FROM contexts WHERE id=?', [id])
    );
    return object(row ? JSON.parse(row.content) : undefined, id);
  };
  const identity = context('project_identity');
  const master = context('master_context');
  object(master.project_identity, 'master_context.project_identity');
  return { metadata: metadata as Record<string, string>, identity, master };
}

export type RenameLocal = ReturnType<typeof readRenameLocal>;

export function previousAddresses(local: RenameLocal, address: string): readonly string[] {
  const list: unknown = local.metadata.previous_rbook_addresses
    ? JSON.parse(local.metadata.previous_rbook_addresses)
    : [];
  if (!Array.isArray(list))
    throw new Error('previous_rbook_addresses must be an array; repair it before renaming.');
  const old = storedAddress(local.identity);
  const next = list.filter(
    (entry) => typeof entry !== 'string' || normalizeAddressScheme(entry) !== address
  );
  if (
    typeof old === 'string' &&
    old &&
    normalizeAddressScheme(old) !== address &&
    !next.some(
      (entry) =>
        typeof entry === 'string' && normalizeAddressScheme(entry) === normalizeAddressScheme(old)
    )
  )
    next.push(old);
  const verdict = checkPreviousAddresses(next, address);
  if ('refused' in verdict) throw new Error(verdict.refused);
  return verdict.addresses;
}

export function localRenamed(
  local: RenameLocal,
  name: string,
  slug: string,
  address: string
): boolean {
  const old = storedAddress(local.identity);
  return (
    local.metadata.project_name === name &&
    local.metadata.dashboard_slug === slug &&
    local.metadata.dashboard_project_name === name &&
    local.identity.project_name === name &&
    typeof old === 'string' &&
    normalizeAddressScheme(old) === address &&
    (local.master.project_identity as Record<string, unknown>).name === name &&
    local.metadata.previous_rbook_addresses === JSON.stringify(previousAddresses(local, address))
  );
}

export async function writeRenameLocal(
  dbPath: string,
  expected: RenameLocal,
  name: string,
  slug: string,
  address: string
): Promise<void> {
  const db = checked(await RbookDatabaseClient.create({ dbPath, registerProject: false }));
  try {
    checked(
      db.writeTransaction(() => {
        const local = readRenameLocal(db);
        for (const key of ['project_id', 'dashboard_project_id', 'owner'])
          if (local.metadata[key] !== expected.metadata[key])
            throw new Error(
              `The store's ${key} changed during the rename; inspect it before retrying.`
            );
        const metadata = {
          project_name: name,
          dashboard_slug: slug,
          dashboard_project_name: name,
          previous_rbook_addresses: JSON.stringify(previousAddresses(local, address)),
        };
        for (const [key, value] of Object.entries(metadata))
          checked(
            db.execute(
              'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              [key, value]
            )
          );
        const identity = identityForStorage({
          ...local.identity,
          project_name: name,
          rbook_address: address,
        });
        const master = {
          ...local.master,
          project_identity: {
            ...object(local.master.project_identity, 'master_context.project_identity'),
            name,
          },
        };
        for (const [id, content] of [
          ['project_identity', identity],
          ['master_context', master],
        ] as const)
          checked(
            db.execute(
              "UPDATE contexts SET content=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
              [JSON.stringify(content), id]
            )
          );
      })
    );
  } finally {
    db.close();
  }
}

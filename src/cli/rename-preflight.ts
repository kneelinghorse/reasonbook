// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A rename proves the account, dashboard record, local file and upload hold without writes.
// ABOUTME: Its exact path tie and address checks prevent renaming another project's mirror.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { DashboardClient } from '../tools/rbook/dashboard-client';
import { checkAddressWrite, SLUG_GRAMMAR } from '../tools/rbook/address-rule';
import { deriveProjectSlug } from '../tools/rbook/project-identity';
import { storeRecordedAt } from '../tools/rbook/dashboard-path-tie';
import { resolveConfigDirectory } from '../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { readUploadState } from '../intelligence/project-upload-reader';
import { checked, readRenameLocal, previousAddresses } from './rename-local';

export function renameRegistry(
  root: string,
  id: string,
  env: NodeJS.ProcessEnv
): { name: string | null; uploadPending: boolean } {
  const file = path.join(
    resolveConfigDirectory(env, env.HOME ?? os.homedir()),
    'project-graph.sqlite'
  );
  if (!fs.existsSync(file)) return { name: null, uploadPending: false };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT store_path,name,archived_at FROM projects WHERE project_id=?')
      .get(id) as { store_path: string; name: string; archived_at: number | null } | undefined;
    if (row && !ProjectGraphRegistry.isSameFolder(row.store_path, root))
      throw new Error(
        `The registry names another folder (${row.store_path}) for this project; open its own store before renaming.`
      );
    if (row?.archived_at != null)
      throw new Error(
        `This store's local registration is archived; restore it with rbook_project(action="register", projectRoot=${JSON.stringify(root)}) before renaming.`
      );
    const state = readUploadState(db, id);
    if (state?.blocked && ['deleted', 'replaced'].includes(state.pauseReason ?? ''))
      throw new Error(
        `The dashboard upload is paused because the project was ${state.pauseReason}; restore the intended project on reasonbook.ai before renaming.`
      );
    return { name: row?.name ?? null, uploadPending: state?.firstOwedAt != null };
  } finally {
    db.close();
  }
}

export async function renamePreflight(
  root: string,
  dbPath: string,
  name: string,
  slug: string,
  env: NodeJS.ProcessEnv
) {
  if (
    !name.trim() ||
    name !== name.trim() ||
    !SLUG_GRAMMAR.test(slug) ||
    deriveProjectSlug(name) !== slug
  )
    throw new Error(
      'Use a nonempty name that derives to --slug: lowercase letters and digits separated by single hyphens.'
    );
  const db = checked(
    await RbookDatabaseClient.create({
      dbPath,
      readonly: true,
      registerProject: false,
      replicaCheck: false,
    })
  );
  let local;
  try {
    local = readRenameLocal(db);
  } finally {
    db.close();
  }
  const { metadata } = local;
  const address = `rbook://${metadata.owner}/${slug}`;
  const verdict = checkAddressWrite(dbPath, address, metadata.owner);
  if (verdict.refused)
    throw new Error(
      `The requested address cannot be written: ${verdict.refused}. Choose an unused valid address.`
    );
  previousAddresses(local, address);
  const registry = renameRegistry(root, metadata.project_id, env);
  const { client } = checked(await DashboardClient.fromEnvForProject(root));
  const account = checked(await client.getMyProjects());
  if (account.user?.username !== metadata.owner)
    throw new Error(
      `Sign in as this store's owner (${metadata.owner}) before renaming; the current account does not match.`
    );
  const owned = checked(await client.listOwnedProjects());
  const remote = owned.projects.find((project) => project.id === metadata.dashboard_project_id);
  if (!remote || ![metadata.dashboard_slug, slug].includes(remote.slug))
    throw new Error(
      'The signed-in account does not list this dashboard id with its stored or requested slug; restore the correct dashboard identity before renaming.'
    );
  if (!storeRecordedAt(remote.localDbPath, dbPath))
    throw new Error(
      `The dashboard's Local Database Path (${remote.localDbPath ?? 'unset'}) does not name ${dbPath}. In the intended project's dashboard form, set that exact store path, or finish reasonbook migrate before renaming.`
    );
  const directory = checked(await client.listDirectory());
  const listed = directory.projects.find((project) => project.id === remote.id);
  if (!listed || listed.archivedAt)
    throw new Error(
      'The dashboard record is archived or its active status could not be confirmed; restore it on reasonbook.ai before renaming.'
    );
  const warnings = [...verdict.warnings];
  if (remote.name !== metadata.project_name)
    warnings.push(
      `The dashboard name is "${remote.name}"; the local name is "${metadata.project_name}". The id, slug and store path match.`
    );
  for (const other of owned.projects)
    if (
      other.id !== remote.id &&
      (other.slug.startsWith(`${slug}-`) || slug.startsWith(`${other.slug}-`))
    )
      warnings.push(
        `The requested slug is a prefix sibling of "${other.slug}" (${other.name}); confirm you intend this project.`
      );
  return {
    local,
    address,
    registryName: registry.name,
    uploadPending: registry.uploadPending,
    client,
    remote,
    warnings,
  };
}

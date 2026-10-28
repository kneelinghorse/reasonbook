// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps legacy files, settings, stored keys and history readable across the rename.
// ABOUTME: Nothing here moves data; explicit migration owns every filesystem change.

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ADDRESS_SCHEME, IDENTITY_ADDRESS_FIELD } from './product-names';

export const LEGACY = {
  recordDirectory: 'cmos',
  databaseFile: 'cmos.sqlite',
  configDirectory: 'cmos-mcp',
  addressScheme: 'cmos://',
  envPrefix: 'CMOS_',
  toolPrefix: 'cmos_',
  identityAddressKey: 'cmos_address',
  integrationKey: 'cmos_integration',
  evidenceType: 'cmos',
  uploadPrefix: 'cmos-dashboard-upload-',
  wireDirectoryKey: 'cmosDirectory',
  wireAddressKey: 'cmosAddress',
  packageName: '@aquex/cmos-mcp',
  command: 'cmos-mcp',
  proseName: 'CMOS',
  ownedLinePrefix: "CMOS keeps this project's record at the ",
  blockStart:
    '<!-- CMOS hook-less block: written by `cmos-mcp init --no-hooks` for a harness without hooks. Delete it if the harness gains them. -->',
  blockEnd: '<!-- /CMOS hook-less block -->',
} as const;

export function settingNames(name: string): readonly [string, string] {
  const suffix = name.replace(/^(?:RBOOK_|CMOS_)/, '');
  return [`RBOOK_${suffix}`, `${LEGACY.envPrefix}${suffix}`];
}

/** Empty is an explicit override too, particularly when clearing a credential. */
export function getSetting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const [current, legacy] = settingNames(name);
  // The edition was introduced after the rename; no CMOS_EDITION setting ever existed.
  if (current === 'RBOOK_EDITION') return env[current];
  return env[current] ?? env[legacy];
}

/** s100-m02: an off switch read as a person writes it: off, false, 0 or no, in any case. */
export function settingIsOff(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = getSetting(name, env)?.trim().toLowerCase();
  return value === 'off' || value === 'false' || value === '0' || value === 'no';
}

/** Retained clients must not recreate an old config folder after its offline move. */
export function assertConfigDirectoryAvailable(configDir: string): void {
  const directory = path.resolve(configDir);
  const parent = path.dirname(directory);
  if (
    ['.rbook-config-migration.json', '.rbook-config-migration.lock'].some((name) =>
      existsSync(path.join(parent, name))
    )
  ) {
    throw new Error(
      'Reasonbook config migration is in progress or needs recovery; run reasonbook migrate --config --apply before opening shared configuration.'
    );
  }
  if (
    path.basename(parent) === '.config' &&
    path.basename(directory) === LEGACY.configDirectory &&
    !existsSync(directory) &&
    existsSync(path.join(parent, 'rbook'))
  ) {
    throw new Error(
      'This config client still points to the moved legacy folder; restart it or create a fresh client using ~/.config/rbook.'
    );
  }
}

/** A handmade empty new directory must not hide the registry people already use. */
export function resolveConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  options: { readonly allowMigration?: boolean } = {}
): string {
  if (
    !options.allowMigration &&
    ['.rbook-config-migration.json', '.rbook-config-migration.lock'].some((name) =>
      existsSync(path.join(home, '.config', name))
    )
  ) {
    throw new Error(
      'Reasonbook config migration is in progress or needs recovery; run reasonbook migrate --config --apply before opening shared configuration.'
    );
  }
  const explicit = getSetting('RBOOK_CONFIG_DIR', env);
  if (explicit !== undefined) return path.resolve(explicit);
  const current = path.join(home, '.config', 'rbook');
  const legacy = path.join(home, '.config', LEGACY.configDirectory);
  const currentRegistry = existsSync(path.join(current, 'project-graph.sqlite'));
  const legacyRegistry = existsSync(path.join(legacy, 'project-graph.sqlite'));
  if (currentRegistry && legacyRegistry) {
    process.stderr.write(
      'Reasonbook: both config folders contain a registry; using ~/.config/rbook. Set RBOOK_CONFIG_DIR to choose explicitly.\n'
    );
  }
  if (currentRegistry) return current;
  if (legacyRegistry) return legacy;
  // An existing legacy credential/plugin folder still matters before its first registry exists.
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

export function assertNoRecordMigration(projectRoot: string): void {
  if (
    existsSync(path.join(projectRoot, '.rbook-migration.json')) ||
    existsSync(path.join(projectRoot, '.rbook-migration.lock'))
  ) {
    throw new Error(
      'Reasonbook migration is in progress or needs recovery; run reasonbook migrate --apply before opening this record.'
    );
  }
}

export interface RecordPaths {
  readonly directory: string;
  readonly dbPath: string;
  readonly legacy: boolean;
}

export function resolveRecordPaths(
  projectRoot: string,
  options: { readonly allowMigration?: boolean } = {}
): RecordPaths {
  const root = path.resolve(projectRoot);
  if (!options.allowMigration) assertNoRecordMigration(root);
  const current = path.join(root, 'rbook');
  const old = path.join(root, LEGACY.recordDirectory);
  const legacy = !existsSync(current) && existsSync(old);
  const directory = legacy ? old : current;
  return {
    directory,
    dbPath: path.join(directory, 'db', legacy ? LEGACY.databaseFile : 'rbook.sqlite'),
    legacy,
  };
}

/** Preserve case and path segments: changing a scheme must not select a different project. */
export function normalizeAddressScheme(value: string): string {
  return value.replace(/^(?:rbook|cmos):\/\//, ADDRESS_SCHEME);
}

export function toDashboardAddress(value: string): string {
  return value.replace(/^rbook:\/\//, LEGACY.addressScheme);
}

export function isRecordAddress(value: string): boolean {
  return /^(?:rbook|cmos):/i.test(value.trim());
}

export function toolNameSuffix(value: string): string | null {
  return /(?:^|__)(?:rbook|cmos)_([a-z]+(?:_[a-z]+)*)$/.exec(value)?.[1] ?? null;
}

export function isRecordToolName(value: string): boolean {
  return /^(?:rbook|cmos)_[a-z_]{1,80}$/.test(value);
}

export function isRecordDirectoryName(value: string): boolean {
  return value === 'rbook' || value === LEGACY.recordDirectory;
}

export function isUploadCopyName(value: string): boolean {
  return value.startsWith('rbook-dashboard-upload-') || value.startsWith(LEGACY.uploadPrefix);
}

export function isRecordSkillCommand(value: string): boolean {
  return /^\/(?:reasonbook|cmos):/i.test(value);
}

/** Matcher-only view: recognize old and current prose/tool names without rewriting prompt history. */
export function promptNamesForMatching(value: string): string {
  return value
    .replace(/\b(?:reasonbook|cmos)\b/gi, 'rbook')
    .replace(/\bcmos_(?=[a-z_])/gi, 'rbook_');
}

/** Stored JSON keys stay stable even after public response property names change. */
export function storedAddress(identity: Record<string, unknown>): unknown {
  return identity[LEGACY.identityAddressKey];
}

export function identityFromStorage(identity: Record<string, unknown>): Record<string, unknown> {
  const result = { ...identity };
  const value = storedAddress(identity);
  delete result[LEGACY.identityAddressKey];
  if (value !== undefined)
    result[IDENTITY_ADDRESS_FIELD] =
      typeof value === 'string' ? normalizeAddressScheme(value) : value;
  return result;
}

export function identityForStorage(identity: object): Record<string, unknown> {
  const result = { ...identity } as Record<string, unknown>;
  const value = result[IDENTITY_ADDRESS_FIELD];
  delete result[IDENTITY_ADDRESS_FIELD];
  if (value !== undefined)
    result[LEGACY.identityAddressKey] =
      typeof value === 'string' ? toDashboardAddress(value) : value;
  return result;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The rename must keep old projects and settings readable without moving their files.
// ABOUTME: New names win explicitly, and a pending migration blocks ordinary store discovery.

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getSetting,
  settingNames,
  resolveConfigDirectory,
  resolveRecordPaths,
  normalizeAddressScheme,
  toDashboardAddress,
  toolNameSuffix,
  assertConfigDirectoryAvailable,
} from '../../src/intelligence/legacy-compat';
import { ADDRESS_SCHEME } from '../../src/intelligence/product-names';

let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-compat-'));
});
afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

it('honors an explicitly empty new setting instead of reviving a legacy credential', () => {
  expect(
    getSetting('CMOS_DASHBOARD_API_KEY', {
      RBOOK_DASHBOARD_API_KEY: '',
      CMOS_DASHBOARD_API_KEY: 'old',
    })
  ).toBe('');
  expect(getSetting('RBOOK_AMBIENT', { CMOS_AMBIENT: 'off' })).toBe('off');
  expect(settingNames('CMOS_AMBIENT')).toEqual(['RBOOK_AMBIENT', 'CMOS_AMBIENT']);
});

it('does not invent a legacy alias for the edition introduced after the rename', () => {
  expect(getSetting('RBOOK_EDITION', { CMOS_EDITION: 'directory' })).toBeUndefined();
  expect(getSetting('RBOOK_EDITION', { RBOOK_EDITION: '', CMOS_EDITION: 'directory' })).toBe('');
  expect(getSetting('RBOOK_EDITION', { RBOOK_EDITION: 'full', CMOS_EDITION: 'directory' })).toBe(
    'full'
  );
});

it('selects the existing legacy config without creating a competing registry', () => {
  const legacy = path.join(temp, '.config', 'cmos-mcp');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'project-graph.sqlite'), 'registry fixture');
  expect(resolveConfigDirectory({}, temp)).toBe(legacy);
  fs.mkdirSync(path.join(temp, '.config', 'rbook'));
  expect(resolveConfigDirectory({}, temp)).toBe(legacy);
  expect(resolveConfigDirectory({ RBOOK_CONFIG_DIR: path.join(temp, 'explicit') }, temp)).toBe(
    path.join(temp, 'explicit')
  );
});

it('prefers the new registry when both exist and defaults to the new config when neither exists', () => {
  const modern = path.join(temp, '.config', 'rbook');
  expect(resolveConfigDirectory({}, temp)).toBe(modern);
  for (const name of ['cmos-mcp', 'rbook']) {
    fs.mkdirSync(path.join(temp, '.config', name), { recursive: true });
    fs.writeFileSync(path.join(temp, '.config', name, 'project-graph.sqlite'), 'fixture');
  }
  expect(resolveConfigDirectory({}, temp)).toBe(modern);
});

it('blocks shared config consumers while its offline move is incomplete', () => {
  fs.mkdirSync(path.join(temp, '.config'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.config', '.rbook-config-migration.json'), '{}');
  expect(() => resolveConfigDirectory({}, temp)).toThrow(/migration.*migrate/i);
});

it('refuses a retained config path during migration and after the legacy folder has moved', () => {
  const old = path.join(temp, '.config', 'cmos-mcp');
  const current = path.join(temp, '.config', 'rbook');
  fs.mkdirSync(old, { recursive: true });
  expect(() => assertConfigDirectoryAvailable(old)).not.toThrow();
  const marker = path.join(temp, '.config', '.rbook-config-migration.lock');
  fs.mkdirSync(marker);
  expect(() => assertConfigDirectoryAvailable(old)).toThrow(/migration/i);
  fs.rmSync(marker, { recursive: true });
  fs.renameSync(old, current);
  expect(() => assertConfigDirectoryAvailable(old)).toThrow(/restart|fresh/i);
  expect(() => assertConfigDirectoryAvailable(current)).not.toThrow();
});

it('keeps legacy paths intact and selects the new folder when both exist', () => {
  const old = path.join(temp, 'cmos');
  fs.mkdirSync(old);
  expect(resolveRecordPaths(temp)).toEqual({
    directory: old,
    dbPath: path.join(old, 'db', 'cmos.sqlite'),
    legacy: true,
  });
  const modern = path.join(temp, 'rbook');
  fs.mkdirSync(modern);
  expect(resolveRecordPaths(temp)).toEqual({
    directory: modern,
    dbPath: path.join(modern, 'db', 'rbook.sqlite'),
    legacy: false,
  });
  expect(fs.existsSync(old)).toBe(true);
});

it('refuses ordinary access while a move is incomplete, while recovery can inspect paths', () => {
  fs.writeFileSync(path.join(temp, '.rbook-migration.json'), '{}');
  expect(() => resolveRecordPaths(temp)).toThrow(/migration.*migrate/i);
  expect(resolveRecordPaths(temp, { allowMigration: true }).directory).toBe(
    path.join(temp, 'rbook')
  );
});

it('normalizes only the address scheme, never case or user-owned project identifiers', () => {
  expect(normalizeAddressScheme('rbook://Owner/cmos-dashboard')).toBe(
    `${ADDRESS_SCHEME}Owner/cmos-dashboard`
  );
  expect(toDashboardAddress('rbook://Owner/project/mission')).toBe('cmos://Owner/project/mission');
  expect(normalizeAddressScheme('https://example.test')).toBe('https://example.test');
});

it('reads both historical and new tool identifiers without rewriting stored history', () => {
  expect(toolNameSuffix('mcp__plugin_reasonbook_rbook__rbook_message')).toBe('message');
  expect(toolNameSuffix('mcp__cmos_mcp__cmos_decisions')).toBe('decisions');
  expect(toolNameSuffix('rbook_review')).toBe('review');
  expect(toolNameSuffix('unrelated_review')).toBeNull();
});

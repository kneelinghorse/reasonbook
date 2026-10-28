// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Resolve renamed settings before the package is installed, preserving existing user data.
// ABOUTME: Keep both plugin copies aligned with the server's legacy-compat settings/config behavior.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getSetting(name, env = process.env) {
  const suffix = name.replace(/^(?:RBOOK|CMOS)_/, '');
  // The edition was introduced after the rename; no CMOS_EDITION setting ever existed.
  if (suffix === 'EDITION') return env.RBOOK_EDITION;
  return env[`RBOOK_${suffix}`] ?? env[`CMOS_${suffix}`];
}

export function resolveConfigDirectory(env = process.env, home = os.homedir(), options = {}) {
  if (
    !options.allowMigration &&
    ['.rbook-config-migration.json', '.rbook-config-migration.lock'].some((name) =>
      fs.existsSync(path.join(home, '.config', name))
    )
  ) {
    throw new Error(
      'Reasonbook config migration is in progress or needs recovery; run reasonbook migrate --config --apply before opening shared configuration.'
    );
  }
  const explicit = getSetting('RBOOK_CONFIG_DIR', env);
  if (explicit !== undefined) return path.resolve(explicit);
  const current = path.join(home, '.config', 'rbook');
  const legacy = path.join(home, '.config', 'cmos-mcp');
  const currentRegistry = fs.existsSync(path.join(current, 'project-graph.sqlite'));
  const legacyRegistry = fs.existsSync(path.join(legacy, 'project-graph.sqlite'));
  if (currentRegistry && legacyRegistry) {
    process.stderr.write(
      'Reasonbook: both config folders contain a registry; using ~/.config/rbook. Set RBOOK_CONFIG_DIR to choose explicitly.\n'
    );
  }
  if (currentRegistry) return current;
  if (legacyRegistry) return legacy;
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}

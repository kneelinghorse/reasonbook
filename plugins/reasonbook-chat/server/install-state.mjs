// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Validates the plugin's exact package/runtime identity before any executable is selected.
// ABOUTME: Completion markers and install pointers are hints; package identity and native SQLite are rechecked.
import fs from 'node:fs';
import { resolveConfigDirectory } from './legacy-compat.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const PACKAGE_NAME = '@aquex/reasonbook';
/** The package's folder under node_modules, from its scoped name. */
export const PACKAGE_DIR = ['@aquex', 'reasonbook'];
/** The command the package installs; its `--version` line is `<COMMAND> <version>`. */
export const COMMAND = 'reasonbook';
export const MARKER = '.rbook-ready.json';

export function configDirectory(env = process.env) {
  return path.resolve(resolveConfigDirectory(env));
}

export function readPluginVersion(pluginRoot) {
  for (const relative of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'plugin.json',
  ]) {
    const file = path.join(pluginRoot, relative);
    if (!fs.existsSync(file)) continue;
    const manifest = readJson(file);
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest?.version))
      throw new Error(`Invalid plugin version in ${file}; reinstall the plugin.`);
    return manifest.version;
  }
  throw new Error('Plugin manifest missing; reinstall the plugin.');
}

export function createContext({
  version,
  dataRoot,
  configDir = configDirectory(),
  platform = process.platform,
  arch = process.arch,
  abi = process.versions.modules,
  shared = false,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid plugin version');
  if (!dataRoot || !path.isAbsolute(dataRoot))
    throw new Error('The selected plugin install data root must be absolute');
  for (const value of [platform, arch, abi]) {
    if (!/^[\w-]+$/.test(value)) throw new Error('Invalid plugin runtime identity');
  }
  const identity = { packageName: PACKAGE_NAME, version, platform, arch, abi };
  const root = path.resolve(dataRoot);
  const leaf = `${version}-${platform}-${arch}-abi${abi}`;
  return {
    ...identity,
    identity,
    dataRoot: root,
    configDir: path.resolve(configDir),
    shared,
    installRoot: path.join(root, leaf),
    pointerPath: path.join(
      shared ? root : path.resolve(configDir),
      'runtime',
      'plugin-install.json'
    ),
  };
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function matchesIdentity(ctx, value) {
  return value && Object.entries(ctx.identity).every(([key, expected]) => value[key] === expected);
}

export function validatePackage(ctx, packageRoot) {
  try {
    if (
      ctx.platform !== process.platform ||
      ctx.arch !== process.arch ||
      ctx.abi !== process.versions.modules
    ) {
      return undefined;
    }
    const metadataPath = path.join(packageRoot, 'package.json');
    const pkg = readJson(metadataPath);
    if (pkg?.name !== PACKAGE_NAME || pkg.version !== ctx.version) return undefined;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[COMMAND];
    if (typeof bin !== 'string') return undefined;
    const root = fs.realpathSync(packageRoot);
    const cliPath = fs.realpathSync(path.resolve(packageRoot, bin));
    if (!cliPath.startsWith(root + path.sep) || !fs.statSync(cliPath).isFile()) return undefined;
    const require = createRequire(metadataPath);
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      if (db.prepare('SELECT 1 AS ready').get()?.ready !== 1) return undefined;
    } finally {
      db.close();
    }
    return { packageRoot: root, cliPath };
  } catch {
    return undefined;
  }
}

export function validateInstall(ctx, installRoot = ctx.installRoot) {
  try {
    if (fs.lstatSync(installRoot).isSymbolicLink()) return undefined;
    const root = fs.realpathSync(installRoot);
    if (path.dirname(root) !== fs.realpathSync(ctx.dataRoot)) return undefined;
    const pkg = fs.realpathSync(path.join(installRoot, 'node_modules', ...PACKAGE_DIR));
    if (!pkg.startsWith(root + path.sep)) return undefined;
  } catch {
    return undefined;
  }
  if (!matchesIdentity(ctx, readJson(path.join(installRoot, MARKER)))) return undefined;
  const ready = validatePackage(ctx, path.join(installRoot, 'node_modules', ...PACKAGE_DIR));
  return ready ? { ...ready, installRoot } : undefined;
}

export function writeMarker(ctx, candidate) {
  fs.writeFileSync(path.join(candidate, MARKER), JSON.stringify(ctx.identity), {
    flag: 'wx',
    mode: 0o600,
  });
}

export function writePointer(ctx) {
  fs.mkdirSync(path.dirname(ctx.pointerPath), { recursive: true });
  const temporary = `${ctx.pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...ctx.identity, installRoot: ctx.installRoot }), {
    mode: 0o600,
  });
  fs.renameSync(temporary, ctx.pointerPath);
}

/** The one budget every PATH candidate's --version check shares (a test may pass more room). */
export const PATH_CHECK_BUDGET_MS = 400;

export function findPathPackage(ctx, env = process.env, budgetMs = PATH_CHECK_BUDGET_MS) {
  // A fresh CLI may load its server modules to print --version; one shared budget admits
  // that measured startup cost without allowing multiple candidates to multiply it.
  const deadline = Date.now() + budgetMs;
  const seen = new Set();
  for (const directory of (env.PATH || '').split(path.delimiter).filter(path.isAbsolute)) {
    if (Date.now() >= deadline) return undefined;
    const command = path.join(directory, process.platform === 'win32' ? `${COMMAND}.cmd` : COMMAND);
    if (!fs.existsSync(command)) continue;
    // npm's Windows wrapper sits beside node_modules; execute the validated package bin, not cmd text.
    const candidates = [path.join(directory, 'node_modules', ...PACKAGE_DIR)];
    try {
      let parent = path.dirname(fs.realpathSync(command));
      for (let depth = 0; depth < 5; depth += 1) {
        candidates.push(parent);
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      if (Date.now() >= deadline) return undefined;
      let canonical;
      try {
        canonical = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const ready = validatePackage(ctx, canonical);
      if (!ready) continue;
      if (process.platform !== 'win32' && fs.realpathSync(command) !== ready.cliPath) continue;
      // PATH packages are mutable and have no worker-issued marker. All candidates share
      // one budget; a slow or mismatched CLI is unavailable, never trusted by its label.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const check = spawnSync(process.execPath, [ready.cliPath, '--version'], {
        encoding: 'utf8',
        timeout: remaining,
        killSignal: 'SIGKILL',
        env,
      });
      if (Date.now() >= deadline) return undefined;
      if (check.status === 0 && check.stdout.trim() === `${COMMAND} ${ctx.version}`) return ready;
    }
  }
  return undefined;
}

export function findReady(ctx, env = process.env) {
  const pointer = readJson(ctx.pointerPath);
  if (matchesIdentity(ctx, pointer) && pointer.installRoot === ctx.installRoot) {
    const ready = validateInstall(ctx, pointer.installRoot);
    if (ready) return ready;
  }
  return validateInstall(ctx) || (ctx.shared ? undefined : findPathPackage(ctx, env));
}

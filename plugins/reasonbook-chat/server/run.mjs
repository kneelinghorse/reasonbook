// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Dispatches plugin hooks and explicit commands through a validated, exactly pinned Reasonbook package.
// ABOUTME: Hooks install asynchronously and fail open; a disabled MCP server needs no installed package.
import path from 'node:path';
import { getSetting } from './legacy-compat.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  configDirectory,
  createContext,
  findReady,
  findPathPackage,
  readPluginVersion,
  writePointer,
} from './install-state.mjs';
import { packageManager, runCommand } from './package-manager.mjs';
import { disabledServer } from './disabled-server.mjs';
import { installingServer } from './installing-server.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));

function serverDisabled(configDir) {
  const file = path.join(configDir, 'config.json');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(
      `Cannot read ${file}: ${error.message}; fix the config before starting the plugin server.`
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.pluginServer !== undefined && !['on', 'off'].includes(value.pluginServer))
  ) {
    throw new Error(`Invalid ${file}; pluginServer must be on or off.`);
  }
  return value.pluginServer === 'off';
}

export function startInstaller(ctx, env = process.env) {
  const child = spawn(
    process.execPath,
    [path.join(directory, 'install-worker.mjs'), JSON.stringify(ctx)],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    }
  );
  child.once('error', () => {});
  child.unref();
  return child;
}

export async function run(
  args,
  {
    env = process.env,
    launch = runCommand,
    startInstaller: install = startInstaller,
    serveInstalling = installingServer,
    writeOut = (text) => process.stdout.write(text),
    writeError = (text) => process.stderr.write(text),
  } = {}
) {
  const hook = args[0] === 'hook';
  // A contained marker owns the edition, even when the parent shell exports another value.
  // Validate before config discovery, installer startup or the disabled-server shortcut.
  try {
    const inheritedEdition = getSetting('RBOOK_EDITION', env);
    let edition = inheritedEdition;
    try {
      edition = fs.readFileSync(path.join(directory, '..', 'EDITION'), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (edition !== undefined && !['full', 'directory'].includes(edition))
      throw new Error(
        'Unknown edition. Use full or directory; reinstall the plugin if its EDITION marker is invalid.'
      );
    if (edition !== inheritedEdition) env = { ...env, RBOOK_EDITION: edition };
    if (edition === 'directory' && hook)
      throw new Error('The directory edition has no hooks. Use the full plugin for hooks.');
  } catch (error) {
    writeError(`Reasonbook command unavailable: ${error.message}\n`);
    return 1;
  }
  try {
    const installFlag = args.indexOf('--install-root');
    const shared = installFlag !== -1;
    if (shared) {
      if (args[installFlag + 1] !== 'shared' || args.lastIndexOf('--install-root') !== installFlag)
        throw new Error(
          '--install-root must be shared. Reinstall the plugin to restore its entrypoints.'
        );
      args = [...args.slice(0, installFlag), ...args.slice(installFlag + 2)];
    }
    const explicitConfig = getSetting('RBOOK_CONFIG_DIR', env);
    if (shared && explicitConfig !== undefined && !path.isAbsolute(explicitConfig))
      throw new Error(
        'RBOOK_CONFIG_DIR (or its legacy equivalent) must be an absolute path; set an absolute folder or unset it to use the default.'
      );
    const configDir = configDirectory(env);
    // This is deliberately before manifest/runtime discovery, native loading or any process spawn.
    if (args[0] === 'serve' && serverDisabled(configDir)) {
      await disabledServer();
      return 0;
    }
    const ctx = createContext({
      version: readPluginVersion(path.join(directory, '..')),
      dataRoot: shared ? path.join(configDir, 'plugins') : env.CLAUDE_PLUGIN_DATA || configDir,
      configDir,
      shared,
    });
    const managedInstall = shared || Boolean(env.CLAUDE_PLUGIN_DATA);
    const ready = managedInstall ? findReady(ctx, env) : findPathPackage(ctx, env);
    if (ready) {
      if (ready.installRoot) writePointer(ctx);
      const silent = hook && ['stop', 'pre-compact', 'session-end'].includes(args[1]);
      const code = await launch(process.execPath, [ready.cliPath, ...args], {
        stdio: silent ? ['inherit', 'ignore', 'inherit'] : 'inherit',
        env,
        windowsHide: true,
      });
      return hook ? 0 : code;
    }
    if (hook) {
      if (args[1] === 'session-start' && managedInstall) {
        install(ctx, env);
        writeOut(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: 'Reasonbook is installing; the record loads from the next session',
            },
          }) + '\n'
        );
      }
      return 0;
    }
    if (shared && args[0] === 'serve') {
      return (await serveInstalling(ctx, { env, startInstaller: install })) ?? 0;
    }
    const npx = packageManager('npx', [
      '-y',
      '--prefer-offline',
      `${ctx.packageName}@${ctx.version}`,
      ...args,
    ]);
    return await launch(npx.command, npx.args, {
      shell: npx.shell,
      stdio: 'inherit',
      env: { ...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || '') },
      windowsHide: true,
    });
  } catch (error) {
    writeError(`Reasonbook ${hook ? 'hook' : 'command'} unavailable: ${error.message}\n`);
    return hook ? 0 : 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}

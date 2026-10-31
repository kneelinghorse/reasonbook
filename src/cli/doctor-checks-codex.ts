// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's Codex checks: plugins and manual servers in ~/.codex/config.toml, by Claude Code's rules.
// ABOUTME: A fix is a command probed against Codex's own help (0.164.0), quoted for a shell, or plain words.

import type { CheckContext, DoctorInputs } from './doctor-checks';
import {
  CHAT,
  compareVersions,
  describeServer,
  EDITIONS,
  FULL,
  LEGACY_PLUGIN,
  replacement,
  serverChecks,
  sh,
  tomlKey,
} from './doctor-checks-clients';
import type { ServerEntry } from './doctor-read';

/** Returns whether a Reasonbook plugin runs in Codex, or null when that is unknown. */
export function codexChecks(inputs: DoctorInputs, ctx: CheckContext): boolean | null {
  const { codex, config } = inputs;
  if (!codex.plugins.ok) {
    ctx.unchecked('codex', 'Codex’s config.toml could not be read.', codex.plugins.reason);
    return null;
  }
  const servers = codex.servers.ok ? codex.servers.value : [];
  const editions = codex.plugins.value.filter((plugin) => EDITIONS.includes(plugin.name));
  const enabled = editions.filter((plugin) => plugin.enabled);
  const on = enabled.length > 0;
  const table = (name: string) => `[plugins.${tomlKey(name)}]`;
  const install = editions.some((plugin) => plugin.name === FULL)
    ? `set enabled = true under ${table(FULL)} in ~/.codex/config.toml`
    : 'codex plugin marketplace add kneelinghorse/reasonbook, then codex plugin add reasonbook@reasonbook';
  // migrate refuses an old plugin's table whether or not it is enabled.
  for (const old of codex.plugins.value.filter((plugin) => LEGACY_PLUGIN.test(plugin.name))) {
    const add = codex.plugins.value.some((plugin) => plugin.name === replacement(old.name))
      ? ''
      : `, then codex plugin marketplace add kneelinghorse/reasonbook, then codex plugin add ${replacement(old.name)}`;
    ctx.add({
      id: 'codex-plugin-legacy',
      severity: 'fix',
      summary: `Codex still has the old plugin ${old.name}.`,
      evidence: [`${table(old.name)} in ~/.codex/config.toml`],
      fix: `codex plugin remove ${sh(old.name)}${add}`,
      order: 2,
    });
  }
  // Both editions off: the fix enables one of them, never both (s107-m03 round 4).
  if (!on && editions.length > 0)
    ctx.add({
      id: 'codex-plugin-disabled',
      severity: 'fix',
      summary: `Codex has ${editions.map((plugin) => plugin.name).join(' and ')} but ${editions.length > 1 ? 'both are' : 'it is'} disabled, so Reasonbook does not run there.`,
      evidence: editions.map(
        (plugin) => `enabled = false under ${table(plugin.name)} in ~/.codex/config.toml`
      ),
      fix:
        editions.length > 1
          ? `enable one edition: set enabled = true under ${table(FULL)}, or under ${table(CHAT)} for the chat edition, not both, in ~/.codex/config.toml`
          : `set enabled = true under ${table(editions[0].name)} in ~/.codex/config.toml`,
      order: 2,
    });
  if (enabled.length > 1)
    ctx.add({
      id: 'codex-plugin-both-editions',
      severity: 'fix',
      summary: 'Codex enables both Reasonbook editions, so two Reasonbook servers answer it.',
      evidence: enabled.map((plugin) => `${table(plugin.name)} in ~/.codex/config.toml`),
      fix: `keep one: set enabled = false under ${table(CHAT)}, or under ${table(FULL)}, in ~/.codex/config.toml`,
      order: 2,
    });
  for (const plugin of enabled) {
    const top = codex.cached
      .filter((entry) => entry.name === plugin.name)
      .map((entry) => entry.version)
      .filter((version): version is string => version !== null)
      .sort((a, b) => compareVersions(a, b) ?? 0)
      .pop();
    if (top && ctx.behind(top))
      ctx.add({
        id: 'codex-plugin-outdated',
        severity: 'fix',
        summary: `Codex’s ${plugin.name} is ${top}; ${ctx.newest} is current.`,
        evidence: [
          `the newest version folder under ~/.codex/plugins/cache/reasonbook/${plugin.name.split('@')[0]}`,
        ],
        fix: `update the ${plugin.name} plugin in Codex to ${ctx.newest}`,
        order: 2,
      });
  }
  const server = (entry: ServerEntry) => `[mcp_servers.${tomlKey(entry.name)}]`;
  const manual = servers.map((entry) => ({
    entry,
    scope: 'codex',
    where: `${server(entry)} in ~/.codex/config.toml`,
  }));
  const removal = (entry: ServerEntry) => `codex mcp remove ${sh(entry.name)}`;
  serverChecks(manual, 'codex', ctx);
  if (manual.length > 0 && !on)
    ctx.add({
      id: 'codex-manual-server',
      severity: 'fix',
      summary:
        'Codex runs Reasonbook from a manual MCP entry without the plugin, so no Reasonbook hooks run there.',
      evidence: manual.map(({ entry, where }) => `${describeServer(entry)}, ${where}`),
      fix: `${install}, then ${servers.map(removal).join(', then ')}`,
      order: 2,
    });
  const read = config.pluginServer;
  if (on && manual.length > 0 && !read.ok)
    ctx.unchecked(
      'codex-servers',
      'Whether the plugin’s server is off could not be read.',
      read.reason
    );
  else if (on && read.ok && read.value.state === 'on')
    for (const found of manual)
      ctx.add({
        id: 'codex-duplicate-server',
        severity: 'fix',
        summary: `Two Reasonbook servers answer Codex: the plugin’s and the manual entry ${found.entry.name}.`,
        evidence: [`${describeServer(found.entry)}, ${found.where}`, 'pluginServer is on'],
        fix: `${removal(found.entry)}, or keep it and set "pluginServer": "off" in ${read.value.file}`,
        order: 3,
      });
  ctx.ran('codex');
  return on;
}

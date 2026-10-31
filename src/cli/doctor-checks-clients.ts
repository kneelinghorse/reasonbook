// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's Claude Code checks and the rules both clients share: plugins, manual servers, quoting.
// ABOUTME: A fix is a command probed against the client's own help, quoted for a shell, or plain words where none is.

import * as path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';
import type { CheckContext, DoctorInputs } from './doctor-checks';
import type { PluginRecord, ServerEntry } from './doctor-read';

/** Release order of two versions, or null when either is not x.y.z[-pre]. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) =>
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++)
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  return x[4] < y[4] ? -1 : 1;
}

/** A word a shell reads as itself: single-quoted unless it is plainly safe. */
export const sh = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
/** A TOML key as Codex's config writes it: bare when it can be, quoted otherwise. */
export const tomlKey = (name: string): string =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

export const describeServer = (entry: ServerEntry): string => {
  const detail = [entry.command, entry.spec].filter(Boolean).join(', ');
  return detail ? `${entry.name} (${detail})` : entry.name;
};
const scopeOf = (entry: PluginRecord): string =>
  `${entry.scope ?? 'unknown'} scope${entry.projectPath ? ` in ${entry.projectPath}` : ''}`;
/** A project- or local-scope plugin is changed from its own project folder. */
const runIn = (entry: PluginRecord): string =>
  entry.projectPath && entry.scope !== 'user' ? ` (run in ${entry.projectPath})` : '';
/** The 4.x plugin that replaces an old one: cmos@cmos and cmos-chat@cmos. */
export const replacement = (name: string): string =>
  `${name.split('@')[0].replace(LEGACY.recordDirectory, 'reasonbook')}@reasonbook`;

/** The two editions; a client should run one (README: "Enable one Reasonbook edition"). */
export const FULL = 'reasonbook@reasonbook';
export const CHAT = 'reasonbook-chat@reasonbook';
export const EDITIONS: readonly string[] = [FULL, CHAT];
export const LEGACY_PLUGIN = new RegExp(`^${LEGACY.recordDirectory}(?:-chat)?@`);

/** A manual server whose spec alone shows the old package or a release before 4.x. */
function oldSpec(entry: ServerEntry): boolean {
  const spec = entry.spec ?? '';
  return (
    spec.includes(LEGACY.packageName) ||
    /@aquex\/reasonbook@[0-3](?:\.|$)/.test(spec) ||
    /^a local build of @aquex\/reasonbook [0-3]\./.test(spec)
  );
}

export interface Manual {
  readonly entry: ServerEntry;
  readonly scope: string;
  readonly root?: string;
  /** Where the entry is configured, in words. */
  readonly where: string;
}

export function serverChecks(
  manual: readonly Manual[],
  client: 'claude' | 'codex',
  ctx: CheckContext
): void {
  const name = client === 'claude' ? 'Claude Code' : 'Codex';
  for (const { entry, root, where } of manual) {
    const pinned = /^@aquex\/reasonbook@(.+)$/.exec(entry.spec ?? '')?.[1] ?? null;
    const common = {
      severity: 'fix' as const,
      ...(root ? { projectRoot: root } : {}),
      evidence: [`${describeServer(entry)}, ${where}`],
      order: 1,
    };
    if (oldSpec(entry))
      ctx.add({
        ...common,
        id: `${client}-server-old-package`,
        summary: `${name}’s manual entry ${entry.name} runs an old Reasonbook.`,
        fix: `pin @aquex/reasonbook@${ctx.newest} in that entry, or remove it and use the plugin`,
      });
    else if (ctx.behind(pinned))
      ctx.add({
        ...common,
        id: `${client}-server-outdated`,
        summary: `${name}’s manual entry ${entry.name} runs Reasonbook ${pinned}; ${ctx.newest} is current.`,
        fix: `pin @aquex/reasonbook@${ctx.newest} in that entry`,
      });
  }
}

/**
 * Whether a project's .mcp.json server runs: approved, and not refused (/mcp), by ~/.claude.json,
 * the user settings or the project's own settings files.
 */
function approvedServer(inputs: DoctorInputs, root: string, name: string): boolean {
  const { claude } = inputs;
  const project = inputs.projects.find((found) => found.root === root);
  const sources = [claude.switches[root]?.mcpjson, claude.mcpjson, ...(project?.mcpjson ?? [])];
  const known = sources.filter((source) => source !== undefined);
  if (known.some((source) => source.disabled.includes(name))) return false;
  return known.some((source) => source.all || source.enabled.includes(name));
}

/**
 * Whether the plugin's server is, or will be, in play: a Reasonbook plugin installed or a client
 * that could not be read, or a manual server, since doctor's fix for one installs the plugin.
 */
export function pluginMayRun(inputs: DoctorInputs): boolean {
  const { claude, codex } = inputs;
  // An old plugin counts: its fix installs the new one (s107-m03 round 5).
  const plugin = (name: string) => EDITIONS.includes(name) || LEGACY_PLUGIN.test(name);
  const claudePlugin =
    (!claude.installed.ok && !claude.installed.missing) ||
    (claude.installed.ok && claude.installed.value.some((entry) => plugin(entry.name))) ||
    (claude.userServers.ok && claude.userServers.value.length > 0) ||
    (claude.localServers.ok && Object.keys(claude.localServers.value).length > 0) ||
    inputs.projects.some((project) =>
      project.servers.some((entry) => approvedServer(inputs, project.root, entry.name))
    );
  const codexPlugin =
    (!codex.plugins.ok && !codex.plugins.missing) ||
    (codex.plugins.ok && codex.plugins.value.some((found) => plugin(found.name))) ||
    (codex.servers.ok && codex.servers.value.length > 0);
  return claudePlugin || codexPlugin;
}

/** Whether a Reasonbook plugin edition is installed in either client; null when one is unread. */
const installed = ({ claude, codex }: DoctorInputs): boolean | null => {
  if (
    (claude.installed.ok &&
      claude.installed.value.some((entry) => EDITIONS.includes(entry.name))) ||
    (codex.plugins.ok && codex.plugins.value.some((found) => EDITIONS.includes(found.name)))
  )
    return true;
  return (!claude.installed.ok && !claude.installed.missing) ||
    (!codex.plugins.ok && !codex.plugins.missing)
    ? null
    : false;
};

/** Two servers or none: the plugin's own server stops when config.json is not as it reads it. */
export function pluginServerCheck(inputs: DoctorInputs, ctx: CheckContext, plugin: boolean): void {
  const read = inputs.config.pluginServer;
  if (!plugin || !read.ok || read.value.state !== 'refuses') return;
  ctx.add({
    id: 'plugin-server-config',
    severity: 'fix',
    summary:
      installed(inputs) === true
        ? 'The Reasonbook plugin’s server refuses to start, because of its config.json.'
        : installed(inputs) === false
          ? 'The Reasonbook plugin’s server would refuse to start once the fixes below install it, because of its config.json.'
          : 'The Reasonbook plugin’s server refuses to start wherever it is installed, because of its config.json.',
    evidence: [read.value.reason ?? read.value.file],
    fix: `fix or remove ${read.value.file}: it must be a JSON object whose pluginServer, if set, is "on" or "off"`,
    order: 2,
  });
}

/** Returns whether a Reasonbook plugin runs in Claude Code, or null when that is unknown. */
export function claudeChecks(inputs: DoctorInputs, ctx: CheckContext): boolean | null {
  const { claude, config } = inputs;
  const unread = [claude.installed, claude.enabled, claude.userServers, claude.localServers].find(
    (read) => !read.ok && !read.missing
  );
  if (unread && !unread.ok) {
    ctx.unchecked(
      'claude',
      'Claude Code’s plugin and server settings could not be read.',
      unread.reason
    );
    return null;
  }
  const installed = claude.installed.ok ? claude.installed.value : [];
  const records = installed.filter((entry) => EDITIONS.includes(entry.name));
  const runs = (entry: PluginRecord) => entry.enabled !== false;
  // A user install runs in every project; a project or local one only in its own.
  const everywhere = records.some((entry) => entry.scope === 'user' && runs(entry));
  const roots = new Set(
    records
      .filter((entry) => entry.scope !== 'user' && runs(entry) && entry.projectPath)
      .map((entry) => entry.projectPath as string)
  );
  for (const entry of records.filter((found) => ctx.behind(found.version)))
    ctx.add({
      id: 'claude-plugin-outdated',
      severity: 'fix',
      summary: `Claude Code’s ${entry.name} is ${entry.version}; ${ctx.newest} is current.`,
      evidence: [`${entry.name}, ${scopeOf(entry)}`],
      fix: `claude plugin marketplace update reasonbook, then claude plugin update ${entry.name}${runIn(entry)}`,
      order: 2,
    });
  // migrate refuses a record whose version it cannot read as 4.x, from any marketplace.
  for (const entry of installed.filter(
    (found) =>
      /^reasonbook(?:-chat)?@/.test(found.name) &&
      (found.version === null || !/^(?:[4-9]|\d{2,})\./.test(found.version))
  )) {
    const scope = `--scope ${sh(entry.scope ?? 'user')}`;
    ctx.add({
      id: 'claude-plugin-unknown-version',
      severity: 'fix',
      summary: `Claude Code’s record of ${entry.name} gives ${entry.version ? `version ${entry.version}` : 'no version'}, so doctor cannot tell whether it is current and migrate refuses to move folders.`,
      evidence: [`${entry.name}, ${scopeOf(entry)}`],
      fix: `claude plugin uninstall ${sh(entry.name)} ${scope}, then claude plugin install ${sh(entry.name)} ${scope}${runIn(entry)}`,
      order: 2,
    });
  }
  // One edition on and the other off is the documented setup, not drift; with records off that run
  // in a common place (a user install runs everywhere) the fix enables one of them, never one each
  // (s107-m03 rounds 4 and 5).
  const overlap = (a: PluginRecord, b: PluginRecord) =>
    a.scope === 'user' || b.scope === 'user' || a.projectPath === b.projectPath;
  const lone = records.filter(
    (entry) =>
      entry.enabled === false &&
      !records.some((found) => found !== entry && runs(found) && overlap(found, entry))
  );
  // Whole components: a user install overlaps every record, so it gathers them all into one.
  const groups: PluginRecord[][] = lone.some((entry) => entry.scope === 'user')
    ? [lone]
    : [...new Set(lone.map((entry) => entry.projectPath))].map((root) =>
        lone.filter((entry) => entry.projectPath === root)
      );
  for (const off of groups) {
    // Enable the widest one: a user install, and the full edition before the chat one.
    const rank = (found: PluginRecord) =>
      (found.scope === 'user' ? 0 : 2) + (found.name === FULL ? 0 : 1);
    const [entry] = [...off].sort((a, b) => rank(a) - rank(b));
    const enable = (record: PluginRecord) =>
      `claude plugin enable ${record.name} --scope ${sh(record.scope ?? 'user')}${runIn(record)}`;
    // An edition's commands: every disabled copy, its user install first, since a project's own
    // setting can keep it off there even once the user install is on (s107-m03 round-6 note).
    const edition = (name: string): string | null => {
      const found = off
        .filter((record) => record.name === name)
        .sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'));
      return found.length ? found.map(enable).join(', then ') : null;
    };
    const full = edition(FULL);
    const chat = edition(CHAT);
    ctx.add({
      id: 'claude-plugin-disabled',
      severity: 'fix',
      summary: `Claude Code has ${[...new Set(off.map((found) => found.name))].join(' and ')} installed but disabled, so Reasonbook does not run ${entry.scope === 'user' ? 'in any project' : 'in that project'}.`,
      evidence: off.map((found) => `${found.name}, ${scopeOf(found)}`),
      fix:
        full && chat
          ? `enable one edition: ${full}, or ${chat} for the chat edition, not both`
          : (full ?? chat ?? enable(entry)),
      order: 2,
    });
  }
  const full = records.filter((found) => found.name === FULL && runs(found));
  const chat = records.filter((found) => found.name === CHAT && runs(found));
  if (
    full.some((a) =>
      chat.some((b) => a.scope === 'user' || b.scope === 'user' || a.projectPath === b.projectPath)
    )
  )
    ctx.add({
      id: 'claude-plugin-both-editions',
      severity: 'fix',
      summary: 'Claude Code runs both Reasonbook editions, so two Reasonbook servers answer it.',
      evidence: [...full, ...chat].map((entry) => `${entry.name}, ${scopeOf(entry)}`),
      fix: `keep one: claude plugin disable ${CHAT}, or claude plugin disable ${FULL}`,
      order: 2,
    });
  for (const entry of installed.filter((found) => LEGACY_PLUGIN.test(found.name))) {
    const scope = `--scope ${sh(entry.scope ?? 'user')}`;
    const add = installed.some((found) => found.name === replacement(entry.name))
      ? ''
      : `, then claude plugin marketplace add kneelinghorse/reasonbook, then claude plugin install ${replacement(entry.name)} ${scope}`;
    ctx.add({
      id: 'claude-plugin-legacy',
      severity: 'fix',
      summary: `Claude Code still has the old plugin ${entry.name}.`,
      evidence: [`${entry.name} ${entry.version ?? 'of unknown version'}, ${scopeOf(entry)}`],
      fix: `claude plugin uninstall ${sh(entry.name)} ${scope}${add}${runIn(entry)}`,
      order: 2,
    });
  }
  const enabledUser = claude.enabled.ok ? claude.enabled.value : {};
  for (const [name, on] of Object.entries(enabledUser))
    if (on && LEGACY_PLUGIN.test(name) && !installed.some((found) => found.name === name))
      ctx.add({
        id: 'claude-plugin-legacy-enabled',
        severity: 'fix',
        summary: `~/.claude/settings.json still enables the old plugin ${name}, which is not installed, and migrate refuses to move folders while it does.`,
        evidence: [`enabledPlugins[${JSON.stringify(name)}] is true in ~/.claude/settings.json`],
        fix: `remove ${JSON.stringify(name)} from enabledPlugins in ~/.claude/settings.json`,
        order: 2,
      });
  const approved = (root: string, name: string): boolean => approvedServer(inputs, root, name);
  const local = claude.localServers.ok ? claude.localServers.value : {};
  const at = (entry: ServerEntry, scope: string, root?: string): Manual => ({
    entry,
    scope,
    ...(root ? { root } : {}),
    where: `${scope} scope${root ? ` in ${root}` : ''}`,
  });
  const manual: Manual[] = [
    ...(claude.userServers.ok ? claude.userServers.value : []).map((entry) => at(entry, 'user')),
    ...Object.entries(local).flatMap(([root, entries]) =>
      entries.map((entry) => at(entry, 'local', root))
    ),
    ...inputs.projects.flatMap((project) =>
      project.servers
        .filter((entry) => approved(project.root, entry.name))
        .map((entry) => at(entry, 'project', project.root))
    ),
  ];
  // A project server is turned off for this user first: removing it edits the team's .mcp.json.
  const removal = ({ entry, scope, root }: Manual) =>
    scope === 'project' && root
      ? `add ${JSON.stringify(entry.name)} to disabledMcpjsonServers in ${path.join(root, '.claude', 'settings.local.json')} (only you; claude mcp remove ${sh(entry.name)} --scope project would edit the shared .mcp.json)`
      : `claude mcp remove ${sh(entry.name)} --scope ${scope}${root ? ` (run in ${root})` : ''}`;
  // A project pin migrate refuses is already the record checks' finding, with the same fix.
  const pinned = (found: Manual) =>
    found.scope === 'project' &&
    inputs.projects.some((project) => project.root === found.root && project.serverPins.length);
  serverChecks(
    manual.filter((found) => !pinned(found)),
    'claude',
    ctx
  );
  const alone = manual.filter((found) =>
    found.scope === 'user' ? !everywhere : !everywhere && !roots.has(found.root as string)
  );
  if (alone.length)
    ctx.add({
      id: 'claude-manual-server',
      severity: 'fix',
      summary:
        'Claude Code runs Reasonbook from a manual MCP entry where no Reasonbook plugin runs, so no Reasonbook hooks run there.',
      evidence: alone.map(({ entry, where }) => `${describeServer(entry)}, ${where}`),
      fix: `claude plugin marketplace add kneelinghorse/reasonbook, then claude plugin install reasonbook@reasonbook, then ${alone.map(removal).join(', then ')}`,
      order: 2,
    });
  const beside = manual.filter((found) =>
    found.scope === 'user'
      ? everywhere || roots.size > 0
      : everywhere || roots.has(found.root as string)
  );
  const read = config.pluginServer;
  if (beside.length && !read.ok)
    ctx.unchecked(
      'claude-servers',
      'Whether the plugin’s server is off could not be read.',
      read.reason
    );
  else if (beside.length && read.ok && read.value.state === 'on')
    for (const found of beside) {
      // A user entry beside a plugin of one project: removing it would leave every other project
      // without a server, so it is turned off there instead, and where it already is, it is no
      // second server (s107-m03 round 4).
      const only =
        found.scope === 'user' && !everywhere
          ? [...roots].filter((root) => !claude.switches[root]?.disabled.includes(found.entry.name))
          : null;
      if (only && only.length === 0) continue;
      ctx.add({
        id: 'claude-duplicate-server',
        severity: 'fix',
        ...(found.root ? { projectRoot: found.root } : {}),
        summary: `Two Reasonbook servers answer Claude Code${only ? ` in ${only.join(', ')}` : ''}: the plugin’s and the manual entry ${found.entry.name}.`,
        evidence: [`${describeServer(found.entry)}, ${found.where}`, 'pluginServer is on'],
        fix: `${only ? `turn ${found.entry.name} off there with /mcp` : removal(found)}, or keep it and set "pluginServer": "off" in ${read.value.file}`,
        order: 3,
      });
    }
  ctx.ran('claude');
  return everywhere || roots.size > 0;
}

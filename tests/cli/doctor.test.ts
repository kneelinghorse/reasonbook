// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor reads each kind of setup drift from its own fixture HOME and names the fix, in order.
// ABOUTME: A clean modern setup exits 0 with no findings; a check that could not run exits 1, never reads as clean.

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor, type DoctorSources } from '../../src/cli/doctor';
import { compareVersions, CURRENT_TOOL_SUFFIXES } from '../../src/cli/doctor-checks';
import type { CliIo } from '../../src/cli/core';
import { migrateConfig } from '../../src/cli/migrate-config';
import { assertProjectServerVersion, modernClientProblems } from '../../src/cli/migrate-guard';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RBOOK_TOOL_DEFINITIONS } from '../../src/tools/rbook';
import { getServerVersion } from '../../src/server-version';

const VERSION = getServerVersion();
const next = (version: string, bump: number) =>
  version.replace(
    /^(\d+)\.(\d+)\.\d+.*$/,
    (_m, major: string, minor: string) => `${major}.${Number(minor) + bump}.0`
  );
let home: string;
let work: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-doctor-home-')));
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-doctor-work-')));
  ProjectGraphRegistry.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function put(file: string, content: string | object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** A global package on PATH, linked as npm links one: <bin>/<command> -> <package>/dist/bin.js. */
function globalPackage(command: string, name: string, version: string): string {
  const pkg = path.join(work, 'lib/node_modules', name);
  put(path.join(pkg, 'package.json'), { name, version });
  put(path.join(pkg, 'dist/bin.js'), '');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(pkg, 'dist/bin.js'), path.join(bin, command));
  return bin;
}

function plugin(
  version = VERSION,
  enabled: boolean | undefined = true,
  name = 'reasonbook@reasonbook'
): void {
  put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    version: 2,
    plugins: { [name]: [{ scope: 'user', installPath: path.join(home, 'plugin'), version }] },
  });
  put(
    path.join(home, '.claude/settings.json'),
    enabled === undefined ? {} : { enabledPlugins: { [name]: enabled } }
  );
}

function project(name: string, layout: 'rbook' | 'cmos' = 'rbook'): string {
  const root = path.join(work, name);
  put(path.join(root, layout, 'db', layout === 'rbook' ? 'rbook.sqlite' : 'cmos.sqlite'), '');
  return root;
}

/** A registry with the real schema (made by the real class), holding the given rows. */
async function registry(
  folder: string,
  rows: Array<{ id: string; root: string; archived?: boolean }>,
  meta: Record<string, string> = {}
): Promise<string> {
  const graph = await ProjectGraphRegistry.create({ configDir: folder, ephemeralRoots: [] });
  graph.close();
  ProjectGraphRegistry.resetInstance();
  const file = path.join(folder, 'project-graph.sqlite');
  const db = new Database(file);
  for (const row of rows)
    db.prepare(
      'INSERT INTO projects (project_id, store_path, name, registered_at, last_seen_at, archived_at) VALUES (?, ?, ?, 1, 1, ?)'
    ).run(row.id, row.root, row.id, row.archived ? 2 : null);
  for (const [key, value] of Object.entries(meta))
    db.prepare('INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)').run(key, value);
  db.close();
  return file;
}

async function doctor(
  options: {
    env?: Record<string, string>;
    argv?: string[];
    sources?: DoctorSources;
    cwd?: string;
  } = {}
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: { HOME: home, PATH: '', ...options.env },
    cwd: options.cwd ?? work,
    readStdin: async () => '',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runDoctor(['--format', 'json', ...(options.argv ?? [])], io, {
    latest: async () => VERSION,
    ephemeralRoots: [],
    ...options.sources,
  });
  const report = JSON.parse(out.join('')) as {
    findings: Array<{
      id: string;
      severity: string;
      summary: string;
      fix: string | null;
      projectRoot?: string;
      evidence: string[];
    }>;
    checks: Array<{ id: string; ran: boolean }>;
    latest: { version: string | null; error?: string };
  };
  const find = (id: string) => report.findings.find((finding) => finding.id === id);
  return { code, report, ids: report.findings.map((finding) => finding.id), err, find };
}

const CLI = `npx --prefer-offline -y @aquex/reasonbook@${VERSION}`;

describe('reasonbook doctor (s107-m03, #815)', () => {
  it('a clean modern setup exits 0 with no findings', async () => {
    plugin();
    const root = project('modern');
    await registry(path.join(home, '.config/rbook'), [{ id: 'modern', root }]);
    const { code, report } = await doctor();
    expect(report.findings).toEqual([]);
    expect(report.checks.every((check) => check.ran)).toBe(true);
    expect(code).toBe(0);
  });

  it('names an old global install against the latest version, and the old cmos-mcp global', async () => {
    const bin = globalPackage('reasonbook', '@aquex/reasonbook', '4.1.0');
    globalPackage('cmos-mcp', '@aquex/cmos-mcp', '3.5.0');
    const latest = next(VERSION, 1);
    const { code, report, ids } = await doctor({
      env: { PATH: bin },
      sources: { latest: async () => latest },
    });
    expect(ids).toEqual(['global-outdated', 'global-legacy', 'doctor-outdated']);
    expect(report.findings[0].fix).toBe(`npm install -g @aquex/reasonbook@${latest}`);
    expect(report.findings[1].fix).toBe('npm uninstall -g @aquex/cmos-mcp');
    expect(code).toBe(1);
  });

  it('controls: an install at the current version is clean, and a failed lookup is a note-free fallback', async () => {
    const bin = globalPackage('reasonbook', '@aquex/reasonbook', VERSION);
    expect((await doctor({ env: { PATH: bin } })).ids).toEqual([]);
    const failed = await doctor({
      env: { PATH: bin },
      sources: { latest: async () => Promise.reject(new Error('offline here')) },
    });
    expect(failed.ids).toEqual([]);
    expect(failed.report.latest).toEqual({
      version: null,
      error: 'the lookup failed: offline here',
    });
    expect(failed.code).toBe(0);
    expect(
      (
        await doctor({
          argv: ['--offline'],
          sources: {
            latest: async () => {
              throw new Error('asked');
            },
          },
        })
      ).report.latest.error
    ).toBe('not looked up (--offline)');
  });

  it('a manual entry without the plugin, a disabled plugin, an outdated one and the old one', async () => {
    put(path.join(home, '.claude.json'), {
      mcpServers: { reasonbook: { command: 'npx', args: ['-y', '@aquex/reasonbook@4.0.0'] } },
    });
    // Pinned below the current release, it is also an outdated server (s107-m03 round 2).
    expect((await doctor()).ids).toEqual(['claude-server-outdated', 'claude-manual-server']);
    put(path.join(home, '.claude.json'), {});
    plugin(VERSION, false);
    expect((await doctor()).ids).toEqual(['claude-plugin-disabled']);
    plugin('4.0.0');
    expect((await doctor()).ids).toEqual(['claude-plugin-outdated']);
    plugin('3.5.0', true, 'cmos@cmos');
    const legacy = await doctor();
    expect(legacy.ids).toEqual(['claude-plugin-legacy']);
    // The replacement is named too, so following the fix leaves Claude Code with a plugin.
    expect(legacy.report.findings[0].fix).toBe(
      'claude plugin uninstall cmos@cmos --scope user, then claude plugin marketplace add kneelinghorse/reasonbook, then claude plugin install reasonbook@reasonbook --scope user'
    );
  });

  it('a project-scope install is changed from its own folder (the record shape a scratch-HOME install wrote)', async () => {
    const root = path.join(work, 'scoped');
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      version: 2,
      plugins: {
        'cmos@cmos': [
          {
            scope: 'project',
            projectPath: root,
            installPath: path.join(home, 'p'),
            version: '3.5.0',
          },
        ],
      },
    });
    const { report } = await doctor();
    expect(report.findings.map((f) => [f.id, f.fix])).toEqual([
      [
        'claude-plugin-legacy',
        `claude plugin uninstall cmos@cmos --scope project, then claude plugin marketplace add kneelinghorse/reasonbook, then claude plugin install reasonbook@reasonbook --scope project (run in ${root})`,
      ],
    ]);
  });

  it('plugin plus manual entry is a duplicate server, unless pluginServer is off', async () => {
    plugin();
    const dist = path.join(work, 'checkout/dist/index.js');
    put(path.join(work, 'checkout/package.json'), { name: '@aquex/reasonbook', version: VERSION });
    put(dist, '');
    put(path.join(home, '.claude.json'), {
      mcpServers: { 'cmos-mcp-pro': { command: '/usr/local/bin/node', args: [dist] } },
    });
    const duplicate = await doctor();
    expect(duplicate.ids).toEqual(['claude-duplicate-server']);
    expect(duplicate.report.findings[0].fix).toContain(
      'claude mcp remove cmos-mcp-pro --scope user'
    );
    expect(duplicate.report.findings[0].evidence[0]).toBe(
      `cmos-mcp-pro (node, a local build of @aquex/reasonbook ${VERSION}), user scope`
    );
    put(path.join(home, '.config/rbook/config.json'), { pluginServer: 'off' });
    expect((await doctor()).ids).toEqual([]);
  });

  it('a registry in the old folder: dead rows, an unconfirmed default, an archived row left alone', async () => {
    const live = project('live');
    const storeless = path.join(work, 'storeless');
    fs.mkdirSync(storeless);
    await registry(
      path.join(home, '.config/cmos-mcp'),
      [
        { id: 'live', root: live },
        { id: 'missing', root: path.join(work, 'gone') },
        { id: 'storeless', root: storeless },
        { id: 'archived', root: path.join(work, 'archived'), archived: true },
      ],
      { default_project_id: 'live' }
    );
    const { ids, report, code } = await doctor();
    expect(ids).toEqual([
      'config-legacy-folder',
      'registry-dead-rows',
      'registry-default-unconfirmed',
      'migrate-needs-quiet-machine',
    ]);
    expect(report.findings.find((f) => f.id === 'registry-dead-rows')?.evidence).toEqual([
      `missing: ${path.join(work, 'gone')}`,
      `storeless: ${storeless}`,
    ]);
    expect(report.findings.find((f) => f.id === 'registry-default-unconfirmed')?.fix).toBe(
      `rbook_project(action="register", projectRoot=${JSON.stringify(live)}, setAsDefault=true)`
    );
    expect(code).toBe(1);
  });

  it('both registries, an interrupted config move, and a busy registry read as unchecked, never clean', async () => {
    // The old folder first: the real class refuses to recreate it beside the new one.
    await registry(path.join(home, '.config/cmos-mcp'), []);
    await registry(path.join(home, '.config/rbook'), []);
    expect((await doctor()).ids).toEqual(['config-both-folders']);
    put(path.join(home, '.config/.rbook-config-migration.json'), {});
    // The registry cannot be opened mid-move, so it could not be checked; the move comes first.
    expect((await doctor()).ids).toEqual([
      'config-move-interrupted',
      'registry',
      'migrate-needs-quiet-machine',
      'config-both-folders',
    ]);
    fs.rmSync(path.join(home, '.config/.rbook-config-migration.json'));
    fs.rmSync(path.join(home, '.config/cmos-mcp'), { recursive: true });
    const file = path.join(home, '.config/rbook/project-graph.sqlite');
    const holder = new Database(file);
    holder.pragma('journal_mode = DELETE');
    holder.exec('BEGIN EXCLUSIVE');
    holder.prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?)').run('held', 'yes');
    try {
      const busy = await doctor();
      expect(busy.ids).toEqual(['registry']);
      expect(busy.report.findings[0].severity).toBe('unchecked');
      expect(busy.report.checks.find((check) => check.id === 'registry')?.ran).toBe(false);
      expect(busy.code).toBe(1);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('old cmos/ projects, both folders, an interrupted move and a pending one', async () => {
    const roots = ['legacy', 'both', 'journal', 'pending'].map((name) =>
      project(name, name === 'legacy' ? 'cmos' : 'rbook')
    );
    put(path.join(roots[1], 'cmos/db/cmos.sqlite'), '');
    put(path.join(roots[2], '.rbook-migration.json'), {});
    put(path.join(roots[3], '.rbook-migration-pending.json'), {});
    await registry(
      path.join(home, '.config/rbook'),
      roots.map((root) => ({ id: path.basename(root), root }))
    );
    const { report } = await doctor();
    const byRoot = (id: string) =>
      report.findings.filter((f) => f.id === id).map((f) => f.projectRoot);
    expect(byRoot('project-legacy-layout')).toEqual([roots[0]]);
    expect(byRoot('project-both-layouts')).toEqual([roots[1]]);
    expect(byRoot('project-move-interrupted')).toEqual([roots[2]]);
    expect(byRoot('project-move-pending')).toEqual([roots[3]]);
    expect(report.findings.find((f) => f.id === 'project-legacy-layout')?.fix).toBe(
      `${CLI} migrate --project ${roots[0]}, then the same with --apply`
    );
  });

  it('old cmos_ permission names are fixes; a current tool permission is not', async () => {
    const root = project('perms');
    put(path.join(root, '.claude/settings.local.json'), {
      permissions: {
        allow: [
          'mcp__cmos-mcp__cmos_mission_status',
          'mcp__plugin_reasonbook_rbook__rbook_review',
          'Bash(git status)',
        ],
      },
    });
    const { report } = await doctor({ cwd: root });
    const stale = report.findings.find((f) => f.id === 'permissions-stale');
    expect(stale?.evidence).toEqual(['mcp__cmos-mcp__cmos_mission_status']);
    expect(stale?.projectRoot).toBeUndefined();
  });

  it('Codex with the old plugin, and the Reasonbook plugin with a manual server beside it', async () => {
    put(path.join(home, '.codex/config.toml'), '[plugins."cmos@cmos"]\nenabled = true\n');
    expect((await doctor()).ids).toEqual(['codex-plugin-legacy']);
    put(
      path.join(home, '.codex/config.toml'),
      '[plugins."reasonbook@reasonbook"]\nenabled = true\n\n[mcp_servers.rbook]\ncommand = "npx"\nargs = ["-y", "@aquex/reasonbook"]\n'
    );
    put(
      path.join(home, '.codex/plugins/cache/reasonbook/reasonbook/4.0.0/.codex-plugin/plugin.json'),
      { version: '4.0.0' }
    );
    expect((await doctor()).ids).toEqual(['codex-plugin-outdated', 'codex-duplicate-server']);
  });

  it.each([
    ['an explicit RBOOK_CONFIG_DIR with HOME’s default unset', true],
    ['HOME’s default with RBOOK_CONFIG_DIR unset', false],
  ])('reads the registry from %s', async (_case, explicit) => {
    const root = project('chosen');
    const folder = explicit ? path.join(work, 'explicit-config') : path.join(home, '.config/rbook');
    await registry(folder, [
      { id: 'gone', root: path.join(work, 'gone') },
      { id: 'chosen', root },
    ]);
    const { ids } = await doctor({ env: explicit ? { RBOOK_CONFIG_DIR: folder } : {} });
    expect(ids).toEqual(
      explicit ? ['registry-dead-rows', 'config-explicit'] : ['registry-dead-rows']
    );
  });

  it('pins its current-tool list to the tool definitions, and orders versions as releases do', () => {
    const suffixes = RBOOK_TOOL_DEFINITIONS.map((tool) => tool.name.replace(/^rbook_/, '')).sort();
    expect([...CURRENT_TOOL_SUFFIXES].sort()).toEqual(suffixes);
    expect(compareVersions('4.10.0', '4.9.0')).toBeGreaterThan(0);
    expect(compareVersions('4.9.0-rc.1', '4.9.0')).toBeLessThan(0);
    expect(compareVersions('not a version', '4.9.0')).toBeNull();
  });

  it('refuses a bad format or an empty project root, and a missing HOME, before reading anything', async () => {
    const err: string[] = [];
    const io = (env: Record<string, string>): CliIo => ({
      env,
      cwd: work,
      readStdin: async () => '',
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(await runDoctor(['--format', 'yaml'], io({ HOME: home }))).toBe(1);
    expect(await runDoctor(['--project-root='], io({ HOME: home }))).toBe(1);
    expect(await runDoctor([], io({}))).toBe(1);
    expect(err).toHaveLength(3);
  });
});

describe('reasonbook doctor reads what migrate and the clients read (s107-m03 critic, round 1)', () => {
  const codex = () => path.join(home, '.codex/config.toml');
  const current = () => path.join(home, '.config/rbook');
  const legacy = () => path.join(home, '.config/cmos-mcp');

  it('.mcp.json: a parse error or a bad entry is unchecked, never "an old Reasonbook"; an old pin is', async () => {
    const root = project('pins');
    const mcp = path.join(root, '.mcp.json');
    put(mcp, '{ "mcpServers": ');
    const broken = await doctor({ cwd: root });
    expect(broken.ids).toEqual(['projects']);
    expect(broken.report.findings[0].evidence).toEqual([`${mcp} is not valid JSON`]);
    expect(broken.code).toBe(1);
    put(mcp, { mcpServers: { other: null, rbook: { command: 'npx', args: 'x' } } });
    const shapes = await doctor({ cwd: root });
    expect(shapes.ids).toEqual(['projects', 'projects']);
    expect(shapes.report.findings.map((f) => f.evidence[0])).toEqual([
      `${mcp} server other is not an object.`,
      `${mcp} server rbook has args that are not a list.`,
    ]);
    expect(shapes.report.checks.find((check) => check.id === 'projects')?.ran).toBe(false);
    put(mcp, {
      mcpServers: { rbook: { command: 'npx', args: ['-y', '@aquex/reasonbook@3.5.0'] } },
    });
    // Approved, it is also a manual server without the plugin, but the pin is reported once.
    put(path.join(root, '.claude/settings.local.json'), { enabledMcpjsonServers: ['rbook'] });
    const pinned = await doctor({ cwd: root });
    expect(pinned.ids).toEqual(['project-server-pin', 'claude-manual-server']);
    expect(pinned.find('project-server-pin')?.fix).toBe(
      `pin @aquex/reasonbook@${VERSION} in ${mcp}`
    );
  });

  it('a missing --project-root could not be checked; a folder without a record is only a note', async () => {
    const missing = await doctor({ argv: ['--project-root', path.join(work, 'nope')] });
    expect(missing.ids).toEqual(['projects']);
    expect(missing.code).toBe(1);
    fs.mkdirSync(path.join(work, 'empty'));
    const empty = await doctor({ argv: ['--project-root', path.join(work, 'empty')] });
    expect(empty.ids).toEqual(['project-no-record']);
    expect(empty.code).toBe(0);
  });

  it('Claude Code’s switches: a server turned off or not approved is no duplicate; an approved one is', async () => {
    plugin();
    const root = project('switched');
    const entry = { command: 'npx', args: ['-y', `@aquex/reasonbook@${VERSION}`] };
    put(path.join(root, '.mcp.json'), { mcpServers: { rbook: entry } });
    put(path.join(home, '.claude.json'), {
      projects: {
        [root]: { mcpServers: { reasonbook: entry }, disabledMcpServers: ['reasonbook'] },
      },
    });
    expect((await doctor({ cwd: root })).ids).toEqual([]);
    put(path.join(home, '.claude.json'), {
      projects: { [root]: { enabledMcpjsonServers: ['rbook'] } },
    });
    const approved = await doctor({ cwd: root });
    expect(approved.ids).toEqual(['claude-duplicate-server']);
    // Turned off for this user first: removing it would edit the team's shared .mcp.json.
    expect(approved.find('claude-duplicate-server')?.fix).toBe(
      `add "rbook" to disabledMcpjsonServers in ${path.join(root, '.claude/settings.local.json')} (only you; claude mcp remove rbook --scope project would edit the shared .mcp.json), or keep it and set "pluginServer": "off" in ${path.join(current(), 'config.json')}`
    );
    put(path.join(root, '.claude/settings.local.json'), { disabledMcpjsonServers: ['rbook'] });
    expect((await doctor({ cwd: root })).ids).toEqual([]);
    put(path.join(home, '.claude.json'), {});
    put(path.join(root, '.claude/settings.local.json'), { enableAllProjectMcpServers: true });
    expect((await doctor({ cwd: root })).ids).toEqual(['claude-duplicate-server']);
  });

  it('Codex by the same rules: an old manual server without the plugin, a disabled plugin, comments and quotes', async () => {
    put(codex(), '[mcp_servers.cmos]\ncommand = "npx"\nargs = ["-y", "@aquex/cmos-mcp@3.5.0"]\n');
    const manual = await doctor();
    expect(manual.ids).toEqual(['codex-server-old-package', 'codex-manual-server']);
    expect(manual.find('codex-manual-server')?.fix).toBe(
      'codex plugin marketplace add kneelinghorse/reasonbook, then codex plugin add reasonbook@reasonbook, then codex mcp remove cmos'
    );
    put(
      codex(),
      `[plugins."cmos@cmos"] # old\nenabled = true\n[plugins.'reasonbook@reasonbook']\nenabled = false\n`
    );
    const plugins = await doctor();
    expect(plugins.ids).toEqual(['codex-plugin-legacy', 'codex-plugin-disabled']);
    expect(plugins.find('codex-plugin-legacy')?.fix).toBe('codex plugin remove cmos@cmos');
    put(
      codex(),
      '[plugins."reasonbook@reasonbook"]\nenabled = true\n[mcp_servers."rbook.dev"]\ncommand = "npx"\nargs = ["-y", "@aquex/reasonbook"]\n[mcp_servers."rbook.dev".env]\nKEY = "x"\n'
    );
    const quoted = await doctor();
    expect(quoted.ids).toEqual(['codex-duplicate-server']);
    expect(quoted.find('codex-duplicate-server')?.evidence[0]).toBe(
      'rbook.dev (npx, @aquex/reasonbook), [mcp_servers."rbook.dev"] in ~/.codex/config.toml'
    );
  });

  it('Codex entries these rules cannot read, and a config.json that cannot be read, are unchecked', async () => {
    put(codex(), '[mcp_servers]\ncmos = { command = "npx", args = ["@aquex/cmos-mcp@3.5.0"] }\n');
    const inline = await doctor();
    expect(inline.ids).toEqual(['codex']);
    expect(inline.report.findings[0].severity).toBe('unchecked');
    expect(inline.code).toBe(1);
    put(
      codex(),
      '[plugins."reasonbook@reasonbook"]\nenabled = true\n[mcp_servers.rbook]\ncommand = "npx"\nargs = ["@aquex/reasonbook"]\n'
    );
    // The plugin's launcher refuses that file, so its server does not start: no duplicate, and the
    // manual server is the only one, never the one a fix removes (round 2).
    put(path.join(current(), 'config.json'), '{ "pluginServer": ');
    const config = await doctor();
    expect(config.ids).toEqual(['plugin-server-config']);
    expect(config.find('plugin-server-config')?.evidence).toEqual([
      `${path.join(current(), 'config.json')} is not valid JSON`,
    ]);
    expect(config.code).toBe(1);
  });

  it('a settings file that cannot be read is unchecked, in a project or the user’s own', async () => {
    const root = project('malformed');
    put(
      path.join(root, '.claude/settings.local.json'),
      '{"permissions": {"allow": ["mcp__cmos-mcp__cmos_mission_status"'
    );
    const local = await doctor({ cwd: root });
    expect(local.ids).toEqual(['projects']);
    expect(local.code).toBe(1);
    fs.rmSync(path.join(root, '.claude'), { recursive: true });
    put(path.join(home, '.claude/settings.json'), '{ "env": ');
    expect((await doctor({ cwd: root })).ids).toEqual(['claude', 'permissions']);
  });

  it('a new folder beside the old registry goes first, so the fix is one migrate --config accepts', async () => {
    await registry(legacy(), []);
    fs.mkdirSync(current());
    const { find } = await doctor();
    expect(find('config-legacy-folder')?.fix).toBe(
      `rmdir ${current()}, then ${CLI} migrate --config, then the same with --apply`
    );
    const env = { HOME: home };
    expect((await migrateConfig(env, false)).error?.message).toMatch(/both config folders exist/);
    fs.rmdirSync(current());
    expect((await migrateConfig(env, false)).success).toBe(true);
    // A folder that holds files names them, and an old folder with no registry says so.
    put(path.join(current(), 'config.json'), {});
    expect((await doctor()).find('config-legacy-folder')?.fix).toMatch(
      /^move config\.json out of .* and remove that folder/
    );
    fs.rmSync(current(), { recursive: true });
    fs.rmSync(legacy(), { recursive: true });
    put(path.join(legacy(), 'config.json'), {});
    const plain = (await doctor()).find('config-legacy-folder');
    expect(plain?.summary).toBe(
      `Reasonbook still reads its config from the old folder ${legacy()}.`
    );
    expect(plain?.evidence).toEqual([`${legacy()} exists and ${current()} does not`]);
  });

  it('both registries: the note names the folder Reasonbook uses, and nothing is written to stderr', async () => {
    await registry(legacy(), []);
    await registry(current(), []);
    const write = jest.spyOn(process.stderr, 'write');
    try {
      const chosen = await doctor({ env: { RBOOK_CONFIG_DIR: legacy() } });
      expect(chosen.find('config-both-folders')?.summary).toBe(
        `Both ${current()} and ${legacy()} hold a registry; Reasonbook uses ${legacy()}.`
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('a gone default is pruned, never also confirmed', async () => {
    await registry(current(), [{ id: 'gone', root: path.join(work, 'gone') }], {
      default_project_id: 'gone',
    });
    expect((await doctor()).ids).toEqual(['registry-dead-rows']);
  });

  it('fixes are quoted for a shell: a server name with spaces, a root with a dollar sign', async () => {
    plugin();
    put(path.join(home, '.claude.json'), {
      mcpServers: {
        'reasonbook (old)': { command: 'npx', args: [`@aquex/reasonbook@${VERSION}`] },
      },
    });
    expect((await doctor()).find('claude-duplicate-server')?.fix).toMatch(
      /^claude mcp remove 'reasonbook \(old\)' --scope user, /
    );
    const root = project('a $HOME b', 'cmos');
    expect(
      (await doctor({ argv: ['--project-root', root] })).find('project-legacy-layout')?.fix
    ).toBe(`${CLI} migrate --project '${root}', then the same with --apply`);
  });
});

describe('reasonbook doctor follows what each client and migrate do (s107-m03 critic, round 2)', () => {
  const codex = () => path.join(home, '.codex/config.toml');
  const config = () => path.join(home, '.config/rbook/config.json');
  const manualEntry = (name = 'reasonbook', spec = `@aquex/reasonbook@${VERSION}`) => ({
    mcpServers: { [name]: { command: 'npx', args: ['-y', spec] } },
  });

  it('a config.json the plugin launcher refuses: no duplicate to remove, and never clean', async () => {
    plugin();
    put(path.join(home, '.claude.json'), manualEntry());
    put(config(), { pluginServer: false });
    const kept = await doctor();
    expect(kept.ids).toEqual(['plugin-server-config']);
    expect(kept.code).toBe(1);
    put(path.join(home, '.claude.json'), {});
    for (const broken of [
      '{ "pluginServer": ',
      JSON.stringify({ pluginServer: 'disabled' }),
      '[]',
    ]) {
      put(config(), broken);
      const alone = await doctor();
      expect(alone.ids).toEqual(['plugin-server-config']);
      expect(alone.code).toBe(1);
    }
    // Controls: the launcher reads a missing file or "on" as on, and "off" as off.
    put(config(), { pluginServer: 'on' });
    expect((await doctor()).ids).toEqual([]);
    fs.rmSync(config());
    expect((await doctor()).ids).toEqual([]);
  });

  it('a legacy project whose .mcp.json names the old package gets the documents pass first', async () => {
    const root = project('old-server', 'cmos');
    put(path.join(root, '.mcp.json'), {
      mcpServers: { cmos: { command: 'npx', args: ['-y', '@aquex/cmos-mcp'] } },
    });
    // migrate's own guard refuses the move as it stands, which is why the pass goes first.
    expect(() => assertProjectServerVersion(root, true)).toThrow(/still names the legacy package/);
    const { find } = await doctor({ cwd: root });
    expect(find('project-legacy-layout')?.fix).toBe(
      `${CLI} migrate --docs-only --project ${root}, then the same with --apply, then ${CLI} migrate --project ${root}, then the same with --apply`
    );
    expect(find('project-server-pin')).toBeUndefined();
  });

  it('client state migrate refuses is a finding before any move: a versionless record, an enabled old plugin, a comment, a desktop config', async () => {
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [{ scope: 'user', installPath: path.join(home, 'none') }],
      },
    });
    put(path.join(home, '.claude/settings.json'), { enabledPlugins: { 'cmos@cmos': true } });
    expect(modernClientProblems(home).map((problem) => problem.kind)).toEqual([
      'plugin-version',
      'enabled-legacy',
    ]);
    expect((await doctor()).ids).toEqual([
      'claude-plugin-unknown-version',
      'claude-plugin-legacy-enabled',
    ]);
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    put(codex(), '# [mcp_servers.cmos]\n# args = ["@aquex/cmos-mcp@3.5.0"]\n');
    // Only a move meets migrate's guard, so with nothing to move the comment is not drift.
    expect((await doctor()).ids).toEqual([]);
    const root = project('moving', 'cmos');
    const moving = await doctor({ cwd: root });
    expect(moving.ids.slice(0, 2)).toEqual(['migrate-refuses', 'project-legacy-layout']);
    expect(moving.find('migrate-refuses')?.evidence[0]).toMatch(
      /configures a legacy plugin or package/
    );
    fs.rmSync(path.join(home, '.codex'), { recursive: true });
    put(path.join(home, '.config/cmos-mcp/config.json'), {});
    const desktop = path.join(
      home,
      'Library/Application Support/Claude/claude_desktop_config.json'
    );
    put(desktop, { mcpServers: { cmos: { command: 'npx', args: ['@aquex/cmos-mcp'] } } });
    const configMove = await doctor({ cwd: work });
    expect(configMove.ids.slice(0, 2)).toEqual(['migrate-refuses', 'config-legacy-folder']);
    expect(configMove.find('migrate-refuses')?.summary).toContain(desktop);
  });

  it('an interrupted config move is finished first, unsetting a config setting migrate refuses', async () => {
    const root = project('waits', 'cmos');
    put(path.join(home, '.config/.rbook-config-migration.json'), {});
    const plain = await doctor({ cwd: root });
    expect(plain.ids.slice(0, 2)).toEqual(['config-move-interrupted', 'project-legacy-layout']);
    expect(plain.report.checks.find((check) => check.id === 'registry')?.ran).toBe(false);
    const set = await doctor({ cwd: root, env: { RBOOK_CONFIG_DIR: path.join(work, 'chosen') } });
    expect(set.find('config-move-interrupted')?.fix).toBe(
      `unset RBOOK_CONFIG_DIR CMOS_CONFIG_DIR, then ${CLI} migrate --config --apply`
    );
  });

  it('an empty RBOOK_CONFIG_DIR is a fix, as Reasonbook still counts it as set', async () => {
    const { ids, report, code } = await doctor({ env: { RBOOK_CONFIG_DIR: '' } });
    expect(ids).toEqual(['config-dir-empty', 'registry']);
    expect(report.findings[1].severity).toBe('unchecked');
    expect(code).toBe(1);
  });

  it('entries that run the global commands are Reasonbook servers under any name', async () => {
    plugin();
    put(path.join(home, '.claude.json'), {
      mcpServers: {
        record: { command: 'reasonbook', args: [] },
        'cmos-mcp-pro': { command: 'cmos-mcp' },
        'rbook-old': { command: '/usr/local/bin/cmos-mcp' },
      },
    });
    const { report } = await doctor();
    expect(report.findings.map((f) => [f.id, f.evidence[0]])).toEqual([
      [
        'claude-server-old-package',
        'cmos-mcp-pro (cmos-mcp, @aquex/cmos-mcp (the cmos-mcp command)), user scope',
      ],
      [
        'claude-server-old-package',
        'rbook-old (cmos-mcp, @aquex/cmos-mcp (the cmos-mcp command)), user scope',
      ],
      ['claude-duplicate-server', 'record (reasonbook, the reasonbook command), user scope'],
      [
        'claude-duplicate-server',
        'cmos-mcp-pro (cmos-mcp, @aquex/cmos-mcp (the cmos-mcp command)), user scope',
      ],
      [
        'claude-duplicate-server',
        'rbook-old (cmos-mcp, @aquex/cmos-mcp (the cmos-mcp command)), user scope',
      ],
    ]);
  });

  it('a plugin of one project: a user entry is a duplicate only there, and is turned off there, not removed', async () => {
    const projA = project('projA');
    const projB = project('projB');
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [
          {
            scope: 'project',
            projectPath: projA,
            installPath: path.join(home, 'p'),
            version: VERSION,
          },
        ],
      },
    });
    put(path.join(projA, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': true },
    });
    put(path.join(home, '.claude.json'), manualEntry());
    const fromB = await doctor({ cwd: projB });
    expect(fromB.ids).toEqual(['claude-manual-server', 'claude-duplicate-server']);
    expect(fromB.find('claude-duplicate-server')?.summary).toContain(`in ${projA}`);
    expect(fromB.find('claude-duplicate-server')?.fix).toMatch(
      /^turn reasonbook off there with \/mcp, or keep it/
    );
    // Disabled in projA's own settings, it runs nowhere.
    put(path.join(projA, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': false },
    });
    expect((await doctor({ cwd: projB })).ids).toEqual([
      'claude-plugin-disabled',
      'claude-manual-server',
    ]);
  });

  it('a Codex server turned off is not a second server', async () => {
    put(
      codex(),
      '[plugins."reasonbook@reasonbook"]\nenabled = true\n[mcp_servers.rbook]\ncommand = "npx"\nargs = ["@aquex/reasonbook"]\nenabled = false\n'
    );
    expect((await doctor()).ids).toEqual([]);
  });

  it('both editions on, and an old chat edition, in either client', async () => {
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'a'), version: VERSION },
        ],
        'reasonbook-chat@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'b'), version: '4.1.0' },
        ],
      },
    });
    expect((await doctor()).ids).toEqual(['claude-plugin-outdated', 'claude-plugin-both-editions']);
    // One edition off is the documented setup.
    put(path.join(home, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook-chat@reasonbook': false },
    });
    expect((await doctor()).ids).toEqual(['claude-plugin-outdated']);
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    put(
      codex(),
      '[plugins."reasonbook@reasonbook"]\nenabled = true\n[plugins."reasonbook-chat@reasonbook"]\nenabled = true\n'
    );
    put(path.join(home, '.codex/plugins/cache/reasonbook/reasonbook-chat/4.1.0/plugin.json'), {
      version: '4.1.0',
    });
    expect((await doctor()).ids).toEqual(['codex-plugin-both-editions', 'codex-plugin-outdated']);
  });

  it('a kept manual server on an old 4.x release is outdated', async () => {
    plugin();
    put(config(), { pluginServer: 'off' });
    put(path.join(home, '.claude.json'), manualEntry('reasonbook', '@aquex/reasonbook@4.1.0'));
    const { find } = await doctor();
    expect(find('claude-server-outdated')?.fix).toBe(
      `pin @aquex/reasonbook@${VERSION} in that entry`
    );
  });

  it('a local build migrate cannot read is named so, and a cmos/ folder without a record is no record', async () => {
    const root = project('local-build');
    put(path.join(work, 'build/package.json'), '{ not json');
    put(path.join(root, '.mcp.json'), {
      mcpServers: { rbook: { command: 'node', args: [path.join(work, 'build/dist/index.js')] } },
    });
    const { find } = await doctor({ cwd: root });
    expect(find('project-server-pin')?.fix).toBe(
      `pin @aquex/reasonbook@${VERSION} in ${path.join(root, '.mcp.json')}, or rebuild that local build at 4.x`
    );
    const sources = path.join(work, 'sources');
    put(path.join(sources, 'cmos/src/index.ts'), '');
    expect((await doctor({ argv: ['--project-root', sources] })).ids).toEqual([
      'project-no-record',
    ]);
  });

  it('text output shows every fix whole and exact; JSON agrees', async () => {
    plugin();
    const roots = Array.from({ length: 12 }, (_, i) => path.join(work, `p${i}`));
    put(path.join(home, '.claude.json'), {
      projects: Object.fromEntries(
        roots.map((root) => [root, manualEntry(`r${roots.indexOf(root)}`)])
      ),
    });
    const out: string[] = [];
    const io: CliIo = {
      env: { HOME: home, PATH: '' },
      cwd: work,
      readStdin: async () => '',
      stdout: (text) => out.push(text),
      stderr: () => undefined,
    };
    await runDoctor(['--offline'], io, { ephemeralRoots: [] });
    const text = out.join('');
    for (const root of roots) expect(text).toContain(`(run in ${root})`);
    expect(text).not.toContain('…');
    const spaced = project('two  spaces', 'cmos');
    out.length = 0;
    await runDoctor(['--offline', '--project-root', spaced], io, { ephemeralRoots: [] });
    expect(out.join('')).toContain(`migrate --project '${spaced}'`);
  });

  it('migrate’s guards name a malformed file without its text, which can hold a secret', () => {
    const root = project('malformed-guard');
    put(path.join(root, '.mcp.json'), '{"mcpServers": {"x": {"env": {"KEY": sk-CANARY-GUARD-1}}}}');
    expect(() => assertProjectServerVersion(root)).toThrow(
      `${path.join(root, '.mcp.json')} is not valid JSON; fix it before applying migration.`
    );
    put(path.join(home, '.claude/plugins/installed_plugins.json'), '{"plugins": sk-CANARY-GUARD-2');
    expect(modernClientProblems(home).map((problem) => problem.message)).toEqual([
      `${path.join(home, '.claude/plugins/installed_plugins.json')} is not valid JSON; fix it before moving folders.`,
    ]);
  });

  it('migrate still accepts a listed or scalar mcpServers, which names no server', () => {
    const root = project('shapes');
    for (const value of [[], 'x']) {
      put(path.join(root, '.mcp.json'), { mcpServers: value });
      expect(() => assertProjectServerVersion(root, true)).not.toThrow();
    }
  });
});

describe('reasonbook doctor round 4: what round 3 left open (s107-m03, decision #1763)', () => {
  const codexToml = () => path.join(home, '.codex/config.toml');
  const configJson = () => path.join(home, '.config/rbook/config.json');

  it('an old Codex build named only by its dist/ path is a refusal before the config move', async () => {
    put(path.join(home, '.config/cmos-mcp/config.json'), {});
    put(
      codexToml(),
      '[mcp_servers.old]\ncommand = "node"\nargs = ["/opt/src/cmos-mcp/dist/index.js"]\n'
    );
    // migrate --config's own guard refuses it.
    expect(
      modernClientProblems(home, true).some(
        (problem) => problem.kind === 'config-build' && problem.file === codexToml()
      )
    ).toBe(true);
    const { ids, find } = await doctor();
    expect(ids.slice(0, 2)).toEqual(['migrate-refuses', 'config-legacy-folder']);
    expect(find('migrate-refuses')?.summary).toContain(codexToml());
  });

  it('a user server turned off with /mcp where the only plugin runs is no second server there', async () => {
    const projA = project('projA');
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [
          {
            scope: 'project',
            projectPath: projA,
            installPath: path.join(home, 'p'),
            version: VERSION,
          },
        ],
      },
    });
    put(path.join(projA, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': true },
    });
    put(path.join(home, '.claude.json'), {
      mcpServers: { reasonbook: { command: 'npx', args: ['-y', `@aquex/reasonbook@${VERSION}`] } },
      projects: { [projA]: { disabledMcpServers: ['reasonbook'] } },
    });
    expect((await doctor({ cwd: projA })).ids).not.toContain('claude-duplicate-server');
  });

  it('both editions off in one place: one finding that enables one of them, in either client', async () => {
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'a'), version: VERSION },
        ],
        'reasonbook-chat@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'b'), version: VERSION },
        ],
      },
    });
    put(path.join(home, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': false, 'reasonbook-chat@reasonbook': false },
    });
    const claude = await doctor();
    expect(claude.ids).toEqual(['claude-plugin-disabled']);
    expect(claude.find('claude-plugin-disabled')?.fix).toBe(
      'enable one edition: claude plugin enable reasonbook@reasonbook --scope user, or claude plugin enable reasonbook-chat@reasonbook --scope user for the chat edition, not both'
    );
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    put(
      codexToml(),
      '[plugins."reasonbook@reasonbook"]\nenabled = false\n[plugins."reasonbook-chat@reasonbook"]\nenabled = false\n'
    );
    const codex = await doctor();
    expect(codex.ids).toEqual(['codex-plugin-disabled']);
    expect(codex.find('codex-plugin-disabled')?.fix).toMatch(/^enable one edition: /);
  });

  // The name is found among legacy-compat's names in getSetting's order, never read directly
  // (tests/intelligence/settings-accessor-coverage.test.ts).
  it.each([[{ RBOOK_CONFIG_DIR: '' }], [{ RBOOK_CONFIG_DIR: '', CMOS_CONFIG_DIR: '/elsewhere' }]])(
    'an empty RBOOK_CONFIG_DIR is named before any legacy name (%j)',
    async (env) => {
      const { find } = await doctor({ env });
      expect(find('config-dir-empty')?.summary).toMatch(/^RBOOK_CONFIG_DIR is set but empty/);
    }
  );

  it('an empty legacy CMOS_CONFIG_DIR is named as itself, so its fix changes something', async () => {
    const { find } = await doctor({ env: { CMOS_CONFIG_DIR: '' } });
    expect(find('config-dir-empty')?.summary).toMatch(/^CMOS_CONFIG_DIR is set but empty/);
    expect(find('config-dir-empty')?.fix).toBe(
      'unset CMOS_CONFIG_DIR, or set it to the folder you mean'
    );
  });

  it('a config.json the plugin refuses comes before the fix that installs the plugin', async () => {
    put(path.join(home, '.claude.json'), {
      mcpServers: { reasonbook: { command: 'npx', args: ['-y', `@aquex/reasonbook@${VERSION}`] } },
    });
    put(configJson(), '{ "pluginServer": ');
    expect((await doctor()).ids).toEqual(['plugin-server-config', 'claude-manual-server']);
  });

  it('an interrupted move of a record whose .mcp.json names the old package says the documents pass may follow', async () => {
    const root = project('interrupted', 'cmos');
    put(path.join(root, '.rbook-migration.json'), {});
    put(path.join(root, '.mcp.json'), {
      mcpServers: { cmos: { command: 'npx', args: ['-y', '@aquex/cmos-mcp'] } },
    });
    const { find } = await doctor({ cwd: root });
    expect(find('project-move-interrupted')?.fix).toBe(
      `${CLI} migrate --apply --project ${root}; if that refuses because .mcp.json names the legacy package, ${CLI} migrate --docs-only --project ${root}, then the same with --apply, then ${CLI} migrate --project ${root}, then the same with --apply`
    );
  });
});

describe('reasonbook doctor round 5: what round 4 left (s107-m03, decision #1763)', () => {
  const codexToml = () => path.join(home, '.codex/config.toml');
  const configJson = () => path.join(home, '.config/rbook/config.json');

  it('both editions off across scopes in one place: still one fix that enables one of them', async () => {
    const root = project('scoped-off');
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'a'), version: VERSION },
        ],
        'reasonbook-chat@reasonbook': [
          {
            scope: 'project',
            projectPath: root,
            installPath: path.join(home, 'b'),
            version: VERSION,
          },
        ],
      },
    });
    put(path.join(home, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': false },
    });
    put(path.join(root, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook-chat@reasonbook': false },
    });
    const { ids, find } = await doctor({ cwd: root });
    expect(ids).toEqual(['claude-plugin-disabled']);
    expect(find('claude-plugin-disabled')?.fix).toMatch(
      /^enable one edition: claude plugin enable reasonbook@reasonbook --scope user, or claude plugin enable reasonbook-chat@reasonbook --scope project/
    );
  });

  it('an old plugin and a config.json the plugin refuses: the config comes first, as the old plugin’s fix installs the new one', async () => {
    plugin('3.5.0', true, 'cmos@cmos');
    put(configJson(), '{ "pluginServer": ');
    expect((await doctor()).ids).toEqual(['plugin-server-config', 'claude-plugin-legacy']);
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    put(codexToml(), '[plugins."cmos@cmos"]\nenabled = true\n');
    expect((await doctor()).ids).toEqual(['plugin-server-config', 'codex-plugin-legacy']);
  });

  it('with no plugin and nothing that installs one, a broken config.json is not called the plugin’s', async () => {
    put(configJson(), '{ "pluginServer": ');
    expect((await doctor()).ids).toEqual([]);
    // An unapproved project server never runs, so no fix installs the plugin for it either.
    const root = project('unapproved');
    put(path.join(root, '.mcp.json'), {
      mcpServers: { rbook: { command: 'npx', args: ['-y', `@aquex/reasonbook@${VERSION}`] } },
    });
    expect((await doctor({ cwd: root })).ids).toEqual([]);
  });

  it('a file naming the old package and an old dist/ path: the dist path is a refusal of its own', async () => {
    put(path.join(home, '.config/cmos-mcp/config.json'), {});
    put(
      codexToml(),
      '[mcp_servers.old]\ncommand = "npx"\nargs = ["-y", "@aquex/cmos-mcp@3.5.0"]\n' +
        '[mcp_servers.built]\ncommand = "node"\nargs = ["/opt/src/cmos-mcp/dist/index.js"]\n'
    );
    const { ids, find } = await doctor();
    expect(ids).toContain('codex-server-old-package');
    expect(ids).toContain('migrate-refuses');
    expect(find('migrate-refuses')?.summary).toContain(codexToml());
  });
});

describe('reasonbook doctor round 6 (s107-m03, decision #1763)', () => {
  it('names a program only for a one-word command, so no part of a command line is read as one', async () => {
    plugin();
    put(path.join(home, '.claude.json'), {
      mcpServers: { vault: { command: 'KEY=$(op read op://vault/key) npx -y @aquex/reasonbook' } },
    });
    const { find } = await doctor();
    expect(find('claude-duplicate-server')?.evidence[0]).toBe(
      'vault (@aquex/reasonbook), user scope'
    );
  });

  it('every edition off, the chat one in two projects listed first: one fix that covers them all', async () => {
    const [projA, projB] = [project('offA'), project('offB')];
    put(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: {
        'reasonbook-chat@reasonbook': [
          {
            scope: 'project',
            projectPath: projA,
            installPath: path.join(home, 'c'),
            version: VERSION,
          },
          {
            scope: 'project',
            projectPath: projB,
            installPath: path.join(home, 'd'),
            version: VERSION,
          },
        ],
        'reasonbook@reasonbook': [
          { scope: 'user', installPath: path.join(home, 'a'), version: VERSION },
        ],
      },
    });
    put(path.join(home, '.claude/settings.json'), {
      enabledPlugins: { 'reasonbook@reasonbook': false },
    });
    for (const root of [projA, projB])
      put(path.join(root, '.claude/settings.json'), {
        enabledPlugins: { 'reasonbook-chat@reasonbook': false },
      });
    const { ids, find } = await doctor();
    expect(ids).toEqual(['claude-plugin-disabled']);
    expect(find('claude-plugin-disabled')?.summary).toMatch(
      /^Claude Code has reasonbook-chat@reasonbook and reasonbook@reasonbook installed but disabled/
    );
    expect(find('claude-plugin-disabled')?.fix).toBe(
      `enable one edition: claude plugin enable reasonbook@reasonbook --scope user, or claude plugin enable reasonbook-chat@reasonbook --scope project (run in ${projA}), then claude plugin enable reasonbook-chat@reasonbook --scope project (run in ${projB}) for the chat edition, not both`
    );
  });

  it('a plugin record that cannot be read: the config.json finding does not claim one is missing', async () => {
    put(path.join(home, '.claude/plugins/installed_plugins.json'), '{ not json');
    put(path.join(home, '.config/rbook/config.json'), '{ "pluginServer": ');
    const { find } = await doctor();
    expect(find('plugin-server-config')?.summary).toBe(
      'The Reasonbook plugin’s server refuses to start wherever it is installed, because of its config.json.'
    );
  });
});

it('an edition off at user and project scope: the fix enables both copies, user first (s107-m03 round-6 note)', async () => {
  const root = project('both-scopes');
  put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    plugins: {
      'reasonbook@reasonbook': [
        { scope: 'user', installPath: path.join(home, 'a'), version: VERSION },
        {
          scope: 'project',
          projectPath: root,
          installPath: path.join(home, 'b'),
          version: VERSION,
        },
      ],
    },
  });
  put(path.join(home, '.claude/settings.json'), {
    enabledPlugins: { 'reasonbook@reasonbook': false },
  });
  put(path.join(root, '.claude/settings.json'), {
    enabledPlugins: { 'reasonbook@reasonbook': false },
  });
  const { ids, find } = await doctor({ cwd: root });
  expect(ids).toEqual(['claude-plugin-disabled']);
  expect(find('claude-plugin-disabled')?.fix).toBe(
    `claude plugin enable reasonbook@reasonbook --scope user, then claude plugin enable reasonbook@reasonbook --scope project (run in ${root})`
  );
});

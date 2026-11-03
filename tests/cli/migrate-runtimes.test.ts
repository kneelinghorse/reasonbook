// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05 — a record's move refuses only runtimes from before 4.0's in-project guard, read from
// ABOUTME: their manifests on disk; the shared config's move still refuses every Reasonbook runtime.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import {
  assertNoOpenFiles,
  assertNoRecordProcesses,
  assertProjectServerVersion,
  recordProcessProblems,
} from '../../src/cli/migrate-guard';
import { migrateProject } from '../../src/cli/migrate';
import { migrateConfig } from '../../src/cli/migrate-config';
import { mayHaveSynced } from '../../src/cli/migrate-store';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-runtimes-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** ps answers exactly these lines, as the check reads them. */
function ps(...lines: string[]): void {
  jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
    pid: 0,
    output: [],
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
    status: 0,
    signal: null,
  });
}

/** A runtime folder under tmp with this manifest (raw text, or none), and its entry point's path. */
function runtime(name: string, manifest: object | string | null, entry = 'dist/index.js'): string {
  const folder = path.join(tmp, name);
  fs.mkdirSync(path.join(folder, path.dirname(entry)), { recursive: true });
  if (manifest !== null)
    fs.writeFileSync(
      path.join(folder, 'package.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    );
  return path.join(folder, entry);
}

/** A plugin folder under tmp, as Claude Code and Codex install one, and its hook entry's path. */
function plugin(name: string, version: string | undefined): string {
  const folder = path.join(tmp, name);
  fs.mkdirSync(path.join(folder, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'hooks'));
  fs.writeFileSync(
    path.join(folder, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'reasonbook', ...(version ? { version } : {}) })
  );
  return path.join(folder, 'hooks/run.mjs');
}

const pids = (scope: 'pre-guard' | 'shared' | 'every') =>
  recordProcessProblems(scope).map((p) => p.pid);

/** A manifest a release shipped, kept under tests/fixtures so no clone needs its tags. */
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../fixtures/migrate', name), 'utf8');

describe('a record moves while 4.0.0 and later runtimes keep running', () => {
  it('passes each launch form on this Mac at 4.x, which the config move still refuses', () => {
    // The forms ps showed on 2026-11-01: a plugin's hook, the package's bin, a checkout's index,
    // and the global command, a link to the package's bin.
    const hook = plugin('claude-plugin', '4.6.0');
    const bin = runtime('package', { name: '@aquex/reasonbook', version: '4.9.0' }, 'dist/bin.js');
    const checkout = runtime('checkout', { name: '@aquex/reasonbook', version: '4.10.0' });
    const command = path.join(tmp, 'bin', 'reasonbook');
    fs.mkdirSync(path.dirname(command));
    fs.writeFileSync(bin, '');
    fs.symlinkSync(bin, command);
    ps(
      `101 node ${hook} serve`,
      `102 /opt/homebrew/bin/node ${bin} serve`,
      `103 node --env-file=${tmp}/.env ${checkout}`,
      `104 node ${command} serve`
    );
    expect(pids('pre-guard')).toEqual([]);
    expect(() => assertNoRecordProcesses('pre-guard')).not.toThrow();
    // Every server holds the registry open for its life, so the config move waits for all (E5 F11).
    expect(pids('every')).toEqual([101, 102, 103, 104]);
    expect(() => assertNoRecordProcesses()).toThrow('Process 101 is a live or unidentified');
  });

  it('refuses a runtime below 4.0, naming it, and the real 3.5.0 manifest among them', () => {
    // The manifest 3.5.0 shipped (its tag's package.json): the legacy name at a pre-guard version.
    const released = fixture('cmos-mcp-3.5.0-package.json');
    const old = runtime('released', released);
    const older = runtime('older', { name: '@aquex/reasonbook', version: '3.9.9' });
    const oldPlugin = plugin('old-plugin', '3.2.0');
    ps(`201 node ${old}`, `202 node ${older}`, `203 node ${oldPlugin} serve`);
    const problems = recordProcessProblems('pre-guard');
    expect(problems.map((p) => p.pid)).toEqual([201, 202, 203]);
    expect(problems[0].message).toMatch(/^Process 201 runs a Reasonbook runtime from before 4\.0/);
    expect(problems[1].message).toContain('version 3.9.9');
    expect(problems[2].message).toContain('version 3.2.0');
    expect(() => assertNoRecordProcesses('pre-guard')).toThrow('Process 201');
  });

  it('refuses a version it cannot read: none, not JSON, an unreadable file, no manifest at all', () => {
    const none = runtime('none', { name: '@aquex/reasonbook' });
    const garbled = runtime('garbled', '{ "name": "@aquex/reasonbook", ');
    const locked = runtime('locked', { name: '@aquex/reasonbook', version: '4.9.0' });
    fs.chmodSync(path.join(tmp, 'locked', 'package.json'), 0o000);
    const versionless = plugin('versionless-plugin', undefined);
    // Five folders deep, past the walk: a supported entry point that cannot be identified.
    const lost = path.join(tmp, 'a/b/c/d/e/f/dist/index.js');
    fs.mkdirSync(path.dirname(lost), { recursive: true });
    ps(
      `301 node ${none}`,
      `302 node ${garbled}`,
      `303 node ${locked}`,
      `304 node ${versionless} serve`,
      `305 node ${lost}`,
      // A launcher naming the package, whose runtime is not on its command line.
      `306 node /usr/local/bin/npx -y @aquex/reasonbook serve`
    );
    try {
      const problems = recordProcessProblems('pre-guard');
      const root = process.getuid?.() === 0;
      expect(problems.map((p) => p.pid)).toEqual(
        root ? [301, 302, 304, 305, 306] : [301, 302, 303, 304, 305, 306]
      );
      // The parser's message quotes the file's text, so it is never shown.
      expect(problems[1].message).not.toContain('Unexpected');
      // What could be read says so: a manifest with no version, a name on the command line with no
      // manifest, or nothing identified at all.
      const kinds = problems.map((p) =>
        /runs Reasonbook, but its version cannot be read/.test(p.message)
          ? 'manifest'
          : /names Reasonbook on its command line/.test(p.message)
            ? 'named'
            : /cannot be identified/.test(p.message)
              ? 'unidentified'
              : p.message
      );
      expect(kinds).toEqual(
        root
          ? ['manifest', 'unidentified', 'manifest', 'unidentified', 'named']
          : ['manifest', 'unidentified', 'unidentified', 'manifest', 'unidentified', 'named']
      );
    } finally {
      fs.chmodSync(path.join(tmp, 'locked', 'package.json'), 0o644);
    }
  });

  it('passes the forms round 1 found refused: the chat plugin before 4.7.0, a path with a space, a folder named cmos-mcp', () => {
    // The chat plugin's manifest sat at its root from 4.0.0 to 4.6.1: the one 4.6.1 shipped.
    const chat = path.join(tmp, 'chat');
    fs.mkdirSync(path.join(chat, 'server'), { recursive: true });
    fs.writeFileSync(path.join(chat, 'plugin.json'), fixture('reasonbook-chat-4.6.1-plugin.json'));
    // ps joins arguments with spaces, so this path comes back in two words.
    const spaced = runtime('My Drive/rb', { name: '@aquex/reasonbook', version: '4.9.0' });
    fs.writeFileSync(spaced, '');
    const hook = plugin('hooked', '4.6.0');
    fs.mkdirSync(path.join(tmp, LEGACY.command));
    ps(
      `701 node ${path.join(chat, 'server/run.mjs')} serve --install-root shared`,
      `702 node ${spaced}`,
      `703 node ${hook} serve --project-root ${path.join(tmp, LEGACY.command)}`
    );
    expect(recordProcessProblems('pre-guard')).toEqual([]);
    expect(pids('every')).toEqual([701, 702, 703]);
  });

  it('still refuses a program at a relative entry point, saying it could not identify it', () => {
    // As 4.9.0 did: npm start in another project runs node dist/index.js.
    ps('801 node dist/index.js');
    expect(recordProcessProblems('pre-guard')).toEqual([
      {
        pid: 801,
        message: expect.stringMatching(
          /^Process 801 runs a program at a Reasonbook entry point that cannot be identified/
        ),
      },
    ]);
  });

  it('refuses the legacy names at any version, and a pin below 4.0 in the arguments', () => {
    const legacy = runtime('legacy', { name: LEGACY.packageName, version: '4.0.0' });
    ps(
      `401 node ${legacy}`,
      `402 ${LEGACY.command} serve`,
      `403 node /usr/local/bin/npx -y ${LEGACY.packageName}@latest`,
      `404 node /usr/local/bin/npx -y @aquex/reasonbook@3.5.0 serve`
    );
    expect(pids('pre-guard')).toEqual([401, 402, 403, 404]);
  });

  it('judges a path with two spaces by its own manifest, never by a twin with one (round 2)', () => {
    // ps joins arguments with single spaces, so the two spaces are two boundaries, not one.
    const old = runtime('A  B/rt', fixture('cmos-mcp-3.5.0-package.json'));
    const twin = runtime('A B/rt', { name: '@aquex/reasonbook', version: '4.9.0' });
    fs.writeFileSync(old, '');
    fs.writeFileSync(twin, '');
    ps(`901 node ${old}`);
    expect(recordProcessProblems('pre-guard')).toEqual([
      { pid: 901, message: expect.stringContaining('version 3.5.0') },
    ]);
  });

  it('says only what a command line names when no Reasonbook manifest was found (round 2)', () => {
    // Another product, given a folder argument named after the legacy command or Reasonbook.
    const other = runtime('other', { name: 'unrelated-app', version: '1.0.0' });
    fs.mkdirSync(path.join(tmp, LEGACY.command));
    fs.mkdirSync(path.join(tmp, 'reasonbook'));
    ps(
      `1001 node ${other} --data ${path.join(tmp, LEGACY.command)}`,
      `1002 node ${other} --data ${path.join(tmp, 'reasonbook')}`
    );
    const [legacyNamed, named] = recordProcessProblems('pre-guard');
    expect(legacyNamed.message).toMatch(
      new RegExp(`^Process 1001 names ${LEGACY.command} on its command line`)
    );
    expect(named.message).toMatch(/^Process 1002 names Reasonbook on its command line/);
    expect([legacyNamed, named].some((p) => /runs a Reasonbook runtime/.test(p.message))).toBe(
      false
    );
  });

  it('a shared record waits for every runtime, saying why (round 2)', () => {
    // A 4.1 to 4.9 server that syncs a shared record ends at its next sync during the move.
    const current = runtime('current', { name: '@aquex/reasonbook', version: '4.9.0' });
    ps(`1101 node ${current}`);
    expect(pids('pre-guard')).toEqual([]);
    expect(recordProcessProblems('shared')).toEqual([
      { pid: 1101, message: expect.stringContaining('has had a sync peer') },
    ]);
  });

  it('skips its own process, lines with no arguments, and node programs that are not Reasonbook', () => {
    const other = runtime('other', { name: 'unrelated-app', version: '1.0.0' });
    ps(
      `${process.pid} node ${runtime('self', { name: '@aquex/reasonbook', version: '3.0.0' })}`,
      '   501',
      '',
      `502 node ${other}`,
      '503 /usr/bin/python3 reasonbook.py'
    );
    expect(pids('pre-guard')).toEqual([]);
    expect(pids('every')).toEqual([]);
  });

  it('refuses when the process list cannot be read, naming no process', () => {
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: new Error('no ps'),
    });
    expect(recordProcessProblems('pre-guard')).toEqual([
      { message: expect.stringContaining('Cannot inspect running clients') },
    ]);
    expect(() => assertNoRecordProcesses('pre-guard')).toThrow('Cannot inspect running clients');
  });
});

describe('every entry on a command line is judged, under any Node-like interpreter (s109-m01, #914)', () => {
  /** A released 3.5.0 runtime and a 4.10.0 one, as their manifests shipped. */
  const old = () => runtime('released', fixture('cmos-mcp-3.5.0-package.json'));
  const modern = () => runtime('modern', { name: '@aquex/reasonbook', version: '4.10.0' });

  it("refuses E1's six lines, each naming the 3.5.0 runtime or the unreadable manifest", () => {
    // Each passed 4.10.0's pre-guard check but the control (E1, a914/repro.cjs).
    const spaced = path.join(tmp, 'My Node', 'node');
    fs.mkdirSync(path.dirname(spaced), { recursive: true });
    fs.writeFileSync(spaced, '');
    // A 3.5.0 chat plugin inside a 4.10.0 package tree, its root manifest unreadable.
    const tree = runtime('tree', { name: '@aquex/reasonbook', version: '4.10.0' }, 'dist/index.js');
    const chat = path.join(
      path.dirname(path.dirname(tree)),
      'plugins',
      `${LEGACY.recordDirectory}-chat`
    );
    fs.mkdirSync(path.join(chat, 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(chat, 'plugin.json'),
      JSON.stringify({ name: `${LEGACY.recordDirectory}-chat`, version: '3.5.0' })
    );
    fs.chmodSync(path.join(chat, 'plugin.json'), 0o000);
    try {
      ps(
        `1601 /opt/homebrew/bin/node ${old()}`,
        `1602 /usr/local/bin/node22 ${old()}`,
        `1603 ${spaced} ${old()}`,
        `1604 node --require ${modern()} ${old()}`,
        `1605 node ${path.join(chat, 'server/run.mjs')}`,
        `1606 /opt/homebrew/bin/bun ${old()}`
      );
      const problems = recordProcessProblems('pre-guard');
      const asRoot = process.getuid?.() === 0;
      expect(problems.map((p) => p.pid)).toEqual(
        asRoot ? [1601, 1602, 1603, 1604, 1606] : [1601, 1602, 1603, 1604, 1605, 1606]
      );
      for (const problem of problems.filter((p) => p.pid !== 1605))
        expect(problem.message).toContain('version 3.5.0');
      if (!asRoot)
        expect(problems.find((p) => p.pid === 1605)?.message).toContain('could not be read');
    } finally {
      fs.chmodSync(path.join(chat, 'plugin.json'), 0o644);
    }
  });

  it('refuses the -r, --import and --env-file forms, and every Node-like name, by the 3.5.0 entry', () => {
    ps(
      `1701 node -r ${modern()} ${old()}`,
      `1702 node --import ${modern()} ${old()}`,
      `1703 node --env-file=${tmp}/.env -r ${modern()} ${old()}`,
      `1704 node --import=${old()} ${modern()}`,
      `1705 /usr/bin/nodejs ${old()}`,
      `1706 /opt/node-22/bin/node-22 ${old()}`,
      `1707 /usr/local/bin/deno run -A ${old()}`
    );
    const problems = recordProcessProblems('pre-guard');
    expect(problems.map((p) => p.pid)).toEqual([1701, 1702, 1703, 1704, 1705, 1706, 1707]);
    for (const problem of problems) expect(problem.message).toContain('version 3.5.0');
  });

  it('passes a 4.x runtime preloading another 4.x entry, and one given as --import=<entry>', () => {
    // Every judged entry is 4.x, or another product's: 4.10.0 refused the second as unidentified.
    const other = runtime('other', { name: 'unrelated-app', version: '1.0.0' });
    ps(
      `1801 node --require ${modern()} ${runtime('second', { name: '@aquex/reasonbook', version: '4.9.0' })}`,
      `1802 node --import=${modern()}`,
      `1803 node -r ${other} ${modern()}`
    );
    expect(recordProcessProblems('pre-guard')).toEqual([]);
    expect(pids('every')).toEqual([1801, 1802, 1803]);
  });

  it('refuses a 4.x runtime preloading an entry no manifest identifies', () => {
    const lost = path.join(tmp, 'a/b/c/d/e/f/dist/index.js');
    fs.mkdirSync(path.dirname(lost), { recursive: true });
    ps(`1901 node -r ${lost} ${modern()}`);
    expect(recordProcessProblems('pre-guard')).toEqual([
      {
        pid: 1901,
        message: expect.stringMatching(/entry point that cannot be identified \(no manifest above/),
      },
    ]);
  });

  it('refuses a .mcp.json server whose --require preloads 4.x before a 3.x build', () => {
    const root = path.join(tmp, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { reasonbook: { command: 'node', args: ['--require', modern(), old()] } },
      })
    );
    expect(() => assertProjectServerVersion(root)).toThrow('pre-4.x or unknown local build');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { reasonbook: { command: 'node', args: ['--require', modern(), modern()] } },
      })
    );
    expect(() => assertProjectServerVersion(root)).not.toThrow();
  });

  it('names the remedy when the entry runs from a plugin folder an update deleted (E1 Part B)', () => {
    // Codex replaced 4.9.0 with 4.10.0 and deleted the old folder while its launcher ran from it.
    const gone = path.join(tmp, '.codex/plugins/cache/reasonbook/reasonbook/4.9.0/hooks/run.mjs');
    fs.mkdirSync(path.join(tmp, '.codex/plugins/cache/reasonbook/reasonbook/4.10.0'), {
      recursive: true,
    });
    ps(`2001 node ${gone} serve`);
    const [problem] = recordProcessProblems('pre-guard');
    expect(problem.message).toMatch(/^Process 2001 runs a program at a Reasonbook entry point/);
    expect(problem.message).toContain('restart the app that updated its plugin');
    // A missing folder outside a plugin cache is not the deleted-plugin case.
    ps(`2002 node ${path.join(tmp, 'a/b/c/d/e/f/g/dist/index.js')}`);
    expect(recordProcessProblems('pre-guard')[0].message).not.toContain('restart the app');
  });
});

describe('every global command is judged, and the remedy reaches every scope (build critic A, notes 7-8)', () => {
  /** A global command linked to a package's bin, as npm links one. */
  function command(name: string, manifest: object | string): string {
    const bin = runtime(`${name}-package`, manifest, 'dist/bin.js');
    fs.writeFileSync(bin, '');
    const link = path.join(tmp, `${name}-bin`, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(bin, link);
    return link;
  }

  it('refuses a second reasonbook command that runs a 3.x bin, and a legacy command preloaded before a 4.x entry', () => {
    const modern = command('reasonbook', { name: '@aquex/reasonbook', version: '4.10.0' });
    const old = path.join(tmp, 'old-bin', 'reasonbook');
    const oldBin = runtime('old-package', fixture('cmos-mcp-3.5.0-package.json'), 'dist/bin.js');
    fs.writeFileSync(oldBin, '');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.symlinkSync(oldBin, old);
    const legacy = command(LEGACY.command, fixture('cmos-mcp-3.5.0-package.json'));
    const entry = runtime('modern-entry', { name: '@aquex/reasonbook', version: '4.10.0' });
    ps(`2101 node ${modern} serve ${old}`, `2102 node --require ${legacy} ${entry}`);
    expect(recordProcessProblems('pre-guard')).toEqual([
      { pid: 2101, message: expect.stringContaining('version 3.5.0') },
      { pid: 2102, message: expect.stringContaining('version 3.5.0') },
    ]);
  });

  it('passes a spaced interpreter path that no longer exists, which it cannot rejoin (the closed list)', () => {
    // The profile admits it: ps splits the path, and only a joined path that exists is rejoined.
    ps(
      `2201 ${path.join(tmp, 'Gone Dir', 'node')} ${runtime('released', fixture('cmos-mcp-3.5.0-package.json'))}`
    );
    expect(recordProcessProblems('every')).toEqual([]);
  });

  it('names the remedy for a deleted plugin folder in every scope, and only for a folder that is gone', () => {
    const gone = path.join(tmp, '.codex/plugins/cache/reasonbook/reasonbook/4.9.0/hooks/run.mjs');
    for (const scope of ['pre-guard', 'shared', 'every'] as const) {
      ps(`2301 node ${gone} serve`);
      expect(recordProcessProblems(scope)[0].message).toContain(
        'restart the app that updated its plugin'
      );
    }
    // An entry no manifest identifies in a plugin cache folder that still exists is not that case.
    const present = path.join(tmp, '.codex/plugins/cache/other/thing/1.0.0/hooks/run.mjs');
    fs.mkdirSync(path.dirname(present), { recursive: true });
    ps(`2302 node ${present} serve`);
    expect(recordProcessProblems('pre-guard')[0].message).not.toContain('restart the app');
  });
});

describe('the dry run lists what the apply would refuse, and changes nothing', () => {
  it('names a runtime from before 4.0 and a legacy client, and nothing for a 4.x machine', async () => {
    const root = path.join(tmp, 'project');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const oldDb = seedLegacyMigrationStore(root);
    const bytes = fs.readFileSync(oldDb);
    const spawnSync = childProcess.spawnSync;
    let lines: string[] = [];
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      const result = spawnSync(command, args, opts);
      return command === 'ps' ? { ...result, stdout: `${lines.join('\n')}\n` } : result;
    }) as any);
    const dryRun = async () =>
      (await migrateProject({ projectRoot: root, env: { HOME: home } })).data?.blocked;
    lines = [`601 node ${runtime('current', { name: '@aquex/reasonbook', version: '4.9.0' })}`];
    expect(await dryRun()).toEqual([]);
    lines.push(`602 node ${runtime('old', { name: '@aquex/reasonbook', version: '3.9.9' })}`);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({
        enabledPlugins: { [`${LEGACY.recordDirectory}@${LEGACY.recordDirectory}`]: true },
      })
    );
    expect(await dryRun()).toEqual([
      expect.stringContaining('enables the legacy plugin'),
      expect.stringMatching(/^Process 602 runs a Reasonbook runtime from before 4\.0/),
    ]);
    // A dry run moves nothing and changes no byte of the record.
    expect(fs.readFileSync(oldDb)).toEqual(bytes);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.rbook-migration.lock'))).toBe(false);
  });
});

describe('a shared record waits for every runtime, in its apply and its dry run (round 2)', () => {
  it.each([
    ['a peer with a route', JSON.stringify({ kind: 'ssh', host: 'peer.example', root: '/peer' })],
    // A released server keeps syncing a record it once saw shared, after its route is forgotten
    // or its dashboard route has ended, so these wait too (round 3).
    ['a peer whose route was forgotten', null],
    [
      'a peer whose dashboard route ended',
      JSON.stringify({
        kind: 'dashboard',
        url: 'https://dash.example',
        projectId: 'p',
        ended: true,
      }),
    ],
  ])('a record with %s refuses while a 4.x server runs', async (_peer, route) => {
    const root = path.join(tmp, 'peered');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const oldDb = seedLegacyMigrationStore(root);
    const db = new Database(oldDb);
    db.exec(`CREATE TABLE IF NOT EXISTS record_peers (replica_id TEXT PRIMARY KEY, name TEXT,
      route TEXT, marks TEXT, digest TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT,
      failures INTEGER NOT NULL DEFAULT 0, failing_since TEXT, removed_at TEXT,
      library_version TEXT, reads INTEGER, last_call_at TEXT)`);
    db.prepare("INSERT INTO record_peers (replica_id, name, route) VALUES ('peer', 'Peer', ?)").run(
      route
    );
    db.close();
    const current = runtime('current', { name: '@aquex/reasonbook', version: '4.9.0' });
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      const result = spawnSync(command, args, opts);
      return command === 'ps' ? { ...result, stdout: `1301 node ${current}\n` } : result;
    }) as any);
    const applied = await migrateProject({ projectRoot: root, env: { HOME: home }, apply: true });
    expect(applied).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('has had a sync peer') },
    });
    expect(fs.existsSync(oldDb)).toBe(true);
  });

  it('a refused shared-record move never creates its guard, and a config move neither (s109-m01, #915)', async () => {
    // 4.10.0 made the guard first and refused about 40 ms later, so a 4.1 to 4.9 server whose sync
    // tick fell in between ended as at a move.
    const root = path.join(tmp, 'peered');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.config', LEGACY.configDirectory), { recursive: true });
    const oldDb = seedLegacyMigrationStore(root);
    const db = new Database(oldDb);
    db.exec('CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY, name TEXT, route TEXT)');
    db.close();
    const current = runtime('current', { name: '@aquex/reasonbook', version: '4.9.0' });
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      const result = spawnSync(command, args, opts);
      return command === 'ps' ? { ...result, stdout: `1401 node ${current}\n` } : result;
    }) as any);
    const made: string[] = [];
    const mkdirSync = fs.mkdirSync;
    jest.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, opts?: any) => {
      made.push(String(target));
      return mkdirSync(target, opts);
    }) as any);
    const record = await migrateProject({ projectRoot: root, env: { HOME: home }, apply: true });
    expect(record).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('has had a sync peer') },
    });
    const config = await migrateConfig({ HOME: home }, true);
    expect(config).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Process 1401 is a live or unidentified') },
    });
    expect(made.filter((target) => /\.rbook(?:-config)?-migration\.lock$/.test(target))).toEqual(
      []
    );
    expect(fs.existsSync(oldDb)).toBe(true);
    expect(fs.existsSync(path.join(home, '.config', LEGACY.configDirectory))).toBe(true);
  });

  it('still refuses a runtime that starts between the check before the guard and the one after it', async () => {
    // The check after the guard closes that race (s109-m01, #915's regression guard).
    const root = path.join(tmp, 'racing');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const oldDb = seedLegacyMigrationStore(root);
    const old = runtime('old', { name: '@aquex/reasonbook', version: '3.9.9' });
    let calls = 0;
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      const result = spawnSync(command, args, opts);
      if (command !== 'ps') return result;
      calls += 1;
      return { ...result, stdout: calls > 1 ? `1501 node ${old}\n` : '' };
    }) as any);
    const result = await migrateProject({ projectRoot: root, env: { HOME: home }, apply: true });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/^Process 1501 runs a Reasonbook runtime/) },
    });
    expect(calls).toBe(2);
    expect(fs.existsSync(oldDb)).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual([]);
  });

  it('a record that cannot be read to tell waits for every runtime too (round 3)', () => {
    const root = path.join(tmp, 'unread');
    const oldDb = seedLegacyMigrationStore(root);
    fs.writeFileSync(oldDb, 'not a database');
    expect(mayHaveSynced(oldDb)).toBe(true);
    expect(mayHaveSynced(seedLegacyMigrationStore(path.join(tmp, 'never-shared')))).toBe(false);
  });

  it('refuses while a 4.x server runs, says why, and moves once none does', async () => {
    const root = path.join(tmp, 'shared');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const oldDb = seedLegacyMigrationStore(root);
    // A copy of a shared record with a route, as a server's sync timer takes one up.
    const db = new Database(oldDb);
    db.exec(`CREATE TABLE IF NOT EXISTS record_peers (replica_id TEXT PRIMARY KEY, name TEXT,
      route TEXT, marks TEXT, digest TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT,
      failures INTEGER NOT NULL DEFAULT 0, failing_since TEXT, removed_at TEXT,
      library_version TEXT, reads INTEGER, last_call_at TEXT)`);
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('replica_id', 'replica-self')"
    ).run();
    db.prepare(
      "INSERT INTO record_peers (replica_id, name, route) VALUES ('replica-peer', 'Peer', ?)"
    ).run(JSON.stringify({ kind: 'ssh', host: 'peer.example', root: '/peer' }));
    db.close();
    const spawnSync = childProcess.spawnSync;
    let lines = [
      `1201 node ${runtime('current', { name: '@aquex/reasonbook', version: '4.9.0' })}`,
    ];
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      const result = spawnSync(command, args, opts);
      return command === 'ps' ? { ...result, stdout: `${lines.join('\n')}\n` } : result;
    }) as any);
    const options = { projectRoot: root, env: { HOME: home } };
    expect((await migrateProject(options)).data?.blocked).toEqual([
      expect.stringContaining('has had a sync peer'),
    ]);
    expect(await migrateProject({ ...options, apply: true })).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('has had a sync peer') },
    });
    expect(fs.existsSync(oldDb)).toBe(true);
    lines = [];
    expect((await migrateProject({ ...options, apply: true })).success).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook', 'db', 'rbook.sqlite'))).toBe(true);
  });
});

describe("the move's last open-file check passes only the mover's own handle", () => {
  /** lsof answers this, as the check reads it. */
  function lsof(stdout: string): void {
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      stdout,
      stderr: '',
      status: stdout ? 0 : 1,
      signal: null,
    });
  }

  it('passes the mover, names anyone else, and refuses output that names no process', () => {
    lsof(`p${process.pid}\ncnode\nn/x/cmos/db/cmos.sqlite\n`);
    expect(() => assertNoOpenFiles('/x/cmos', process.pid)).not.toThrow();
    // The first check, before the mover holds anything, passes no one.
    expect(() => assertNoOpenFiles('/x/cmos')).toThrow(`open by process ${process.pid}`);
    lsof(
      `p${process.pid}\ncnode\nn/x/cmos/db/cmos.sqlite\np4242\ncsqlite3\nn/x/cmos/db/cmos.sqlite\n`
    );
    expect(() => assertNoOpenFiles('/x/cmos', process.pid)).toThrow('open by process 4242.');
    // Output that names no process is no proof that nothing holds the record.
    lsof('n/x/cmos/db/cmos.sqlite\n');
    expect(() => assertNoOpenFiles('/x/cmos', process.pid)).toThrow('open by process unknown');
    lsof('');
    expect(() => assertNoOpenFiles('/x/cmos', process.pid)).not.toThrow();
  });
});

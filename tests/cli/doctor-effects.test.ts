// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor writes nothing, runs nothing, sends nothing offline and never prints a secret.
// ABOUTME: Every file under the fixture HOME and projects is snapshotted before and after a full run.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { CliTelemetry } from '../../src/cli/telemetry';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

/* eslint-disable @typescript-eslint/no-require-imports */
const childProcess = require('child_process') as Record<string, unknown>;
const http = require('http') as Record<string, unknown>;
const https = require('https') as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-require-imports */

const CANARIES = [
  'CANARY-ENV-1',
  'CANARY-ARG-2',
  'CANARY-URL-3',
  'CANARY-HEADER-4',
  'CANARY-TOML-5',
  'CANARY-CMD-9',
  'CANARY-LEAD-11',
  'CANARY-LEAD-12',
  'CANARY-Q3',
  'CANARY-Q4',
  'CANARY-BS5',
  'CANARY-TOML-E1',
  'CANARY-SUB1',
  'CANARY-TICK2',
  'CANARY-PARAM3',
];
let home: string;
let work: string;

function put(file: string, content: string | object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Every folder and regular file under the roots, by path: a folder's mode; a file's size, mode, mtime and hash. */
function snapshot(...roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out.set(`${file}@`, `link ${fs.readlinkSync(file)}`);
      else if (entry.isDirectory()) {
        out.set(`${file}/`, `folder ${fs.statSync(file).mode}`);
        walk(file);
      } else if (entry.isFile()) {
        const stat = fs.statSync(file);
        const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        out.set(file, `${stat.size} ${stat.mode} ${stat.mtimeMs} ${sha}`);
      }
    }
  };
  roots.forEach(walk);
  return out;
}

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-doctor-effects-home-')));
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-doctor-effects-work-')));
  const secret = {
    command: 'npx',
    args: ['-y', '@aquex/reasonbook@4.0.0', '--token', 'CANARY-ARG-2'],
    env: { RBOOK_DASHBOARD_API_KEY: 'CANARY-ENV-1' },
    url: 'https://example.invalid/CANARY-URL-3',
    headers: { Authorization: 'Bearer CANARY-HEADER-4' },
  };
  const root = path.join(work, 'legacy-project');
  put(path.join(root, 'cmos/db/cmos.sqlite'), '');
  put(path.join(root, '.mcp.json'), { mcpServers: { reasonbook: secret } });
  put(path.join(root, '.claude/settings.local.json'), {
    permissions: { allow: ['mcp__cmos-mcp__cmos_mission_status'] },
  });
  put(path.join(home, '.claude.json'), {
    // A whole command line in "command" holds a credential too (s107-m03 round 2).
    mcpServers: {
      rbook: secret,
      inline: { command: 'npx -y @aquex/reasonbook@4.0.0 --token CANARY-CMD-9' },
      // s107-m03 round 4: a credential written before the program, as a shell assignment or not.
      lead: { command: 'CANARY-LEAD-11=x  npx @aquex/reasonbook@4.0.0' },
      assigned: {
        command: 'RBOOK_DASHBOARD_API_KEY=CANARY-LEAD-12 npx -y @aquex/reasonbook@4.0.0',
      },
      // s107-m03 round 5: an assignment that holds spaces, quoted or escaped.
      quoted: { command: 'RBOOK_DASHBOARD_API_KEY="x CANARY-Q3 y" npx -y @aquex/reasonbook@4.0.0' },
      single: { command: "AUTH='Bearer CANARY-Q4 x' npx -y @aquex/reasonbook@4.0.0" },
      escaped: { command: 'KEY=a\\ CANARY-BS5 npx -y @aquex/reasonbook@4.0.0' },
      // s107-m03 round 6: substitutions and expansions; a command line is never parsed now.
      sub: {
        command: 'RBOOK_DASHBOARD_API_KEY=$(echo CANARY-SUB1 x) npx -y @aquex/reasonbook@4.0.0',
      },
      // A second word inside the backticks, or a reader that splits on spaces never reaches it.
      tick: { command: 'KEY=`echo CANARY-TICK2 x` npx -y @aquex/reasonbook@4.0.0' },
      param: { command: 'KEY=${X:-a CANARY-PARAM3 b} npx -y @aquex/reasonbook@4.0.0' },
    },
    projects: { [root]: { mcpServers: { cmos: secret } } },
  });
  fs.symlinkSync(path.join(home, '.claude.json'), path.join(home, 'linked.json'));
  put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    plugins: {
      'reasonbook@reasonbook': [
        { scope: 'user', version: '4.0.0', installPath: path.join(home, 'p') },
      ],
    },
  });
  put(path.join(home, '.claude/settings.json'), {
    enabledPlugins: { 'reasonbook@reasonbook': true },
  });
  put(
    path.join(home, '.codex/config.toml'),
    '[plugins."reasonbook@reasonbook"]\nenabled = true\n[mcp_servers.rbook]\ncommand = "npx"\nargs = ["@aquex/reasonbook", "CANARY-TOML-5"]\n[mcp_servers.rbook.env]\nKEY = "CANARY-TOML-5"\n' +
      // A literal TOML string holding an assignment with a space (s107-m03 round 5).
      `[mcp_servers.lit]\ncommand = 'KEY="x CANARY-TOML-E1" npx'\nargs = ["@aquex/reasonbook"]\n`
  );
  // A WAL registry by the real class, as Reasonbook leaves one, with a row for the project.
  const folder = path.join(home, '.config/cmos-mcp');
  const graph = await ProjectGraphRegistry.create({ configDir: folder, ephemeralRoots: [] });
  graph.close();
  ProjectGraphRegistry.resetInstance();
  const db = new Database(path.join(folder, 'project-graph.sqlite'));
  db.pragma('journal_mode = WAL');
  db.prepare(
    'INSERT INTO projects (project_id, store_path, name, registered_at, last_seen_at) VALUES (?, ?, ?, 1, 1)'
  ).run('legacy', root, 'legacy');
  db.close();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function run(format: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIo = {
    env: { HOME: home, PATH: '' },
    cwd: path.join(work, 'legacy-project'),
    readStdin: async () => '',
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  const code = await runCli(['doctor', '--offline', ...format], io);
  return { code, out: out.join('') };
}

describe('reasonbook doctor has no effects (s107-m03, #815)', () => {
  it('the snapshot sees a new or re-moded folder and a moved link, so a doctor that made one would fail below', () => {
    const before = snapshot(home);
    fs.mkdirSync(path.join(home, '.config/rbook'));
    const made = snapshot(home);
    expect([...made.keys()].filter((key) => !before.has(key))).toEqual([
      `${path.join(home, '.config/rbook')}/`,
    ]);
    fs.chmodSync(path.join(home, '.config/rbook'), 0o700);
    expect(snapshot(home)).not.toEqual(made);
    const linked = snapshot(home);
    fs.rmSync(path.join(home, 'linked.json'));
    fs.symlinkSync(path.join(home, '.claude'), path.join(home, 'linked.json'));
    expect(snapshot(home)).not.toEqual(linked);
  });

  it('names a malformed file without the parser’s message, which quotes the text around the error', async () => {
    const settings = '{"env": {"API_KEY": sk-CANARY-BROKEN-7}}';
    put(
      path.join(home, '.claude.json'),
      '{"mcpServers": {"x": {"headers": {"Authorization": Bearer CANARY-BROKEN-6}}}}'
    );
    put(path.join(home, '.claude/settings.json'), settings);
    put(
      path.join(work, 'legacy-project/.mcp.json'),
      '{"mcpServers": {"reasonbook": {"args": [CANARY-BROKEN-8]}}}'
    );
    // Control: on this Node the parser's own message carries the secret.
    expect(() => JSON.parse(settings)).toThrow(/sk-CANARY/);
    for (const format of [[], ['--format', 'json']]) {
      const { out, code } = await run(format);
      expect(code).toBe(1);
      expect(out).toContain('is not valid JSON');
      expect(out).not.toMatch(/CANARY|Bearer|sk-|Unexpected token|in JSON at position/);
    }
  });

  it('prints no canary secret from an entry’s env, args, url or headers, in text or JSON', async () => {
    for (const format of [[], ['--format', 'json']]) {
      const { out, code } = await run(format);
      expect(code).toBe(1);
      expect(out).toContain('reasonbook');
      for (const canary of CANARIES) expect(out).not.toContain(canary);
    }
  });

  it('writes nothing under HOME or the projects, and runs no registry create, client, telemetry, child process or network', async () => {
    const hits: string[] = [];
    // Each watcher is restored even if a later one cannot be installed (as side-effects.test.ts does).
    const restores: Array<() => void> = [];
    const watch = (owner: Record<string, unknown>, name: string, label: string): void => {
      const original = owner[name];
      owner[name] = () => {
        hits.push(label);
        throw new Error(`doctor must not reach ${label}`);
      };
      restores.push(() => {
        owner[name] = original;
      });
    };
    const before = snapshot(home, work);
    try {
      watch(ProjectGraphRegistry as never, 'create', 'registry create');
      watch(CliTelemetry.prototype as never, 'resolve', 'telemetry');
      watch(CliTelemetry.prototype as never, 'finish', 'telemetry');
      watch(globalThis as never, 'fetch', 'network');
      watch(http, 'request', 'network');
      watch(https, 'request', 'network');
      watch(net.Socket.prototype as never, 'connect', 'network');
      for (const verb of [
        'spawn',
        'spawnSync',
        'exec',
        'execSync',
        'execFile',
        'execFileSync',
        'fork',
      ])
        watch(childProcess, verb, 'child process');
      const { code, out } = await run(['--format', 'json']);
      expect(code).toBe(1);
      expect(JSON.parse(out).findings.length).toBeGreaterThan(0);
    } finally {
      while (restores.length) restores.pop()!();
    }
    expect(hits).toEqual([]);
    const after = snapshot(home, work);
    // A read-only SQLite open may create -shm/-wal and touch an existing -shm (#1596); nothing else.
    const sqliteSide = (file: string) => /\.sqlite-(?:shm|wal)$/.test(file);
    for (const [file, state] of before) {
      expect(after.has(file)).toBe(true);
      if (!sqliteSide(file)) expect(after.get(file)).toBe(state);
    }
    expect([...after.keys()].filter((file) => !before.has(file) && !sqliteSide(file))).toEqual([]);
  });

  it('opens no store client and no telemetry by construction: its modules import neither', () => {
    for (const name of [
      'doctor',
      'doctor-read',
      'doctor-read-codex',
      'doctor-read-records',
      'doctor-checks',
      'doctor-checks-clients',
      'doctor-checks-codex',
      'doctor-checks-records',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, `../../src/cli/${name}.ts`), 'utf8');
      expect(source).not.toMatch(
        /RbookDatabaseClient|CliTelemetry|ProjectGraphRegistry\.create|os\.homedir|listRegisteredStoresReadOnly/
      );
    }
  });
});

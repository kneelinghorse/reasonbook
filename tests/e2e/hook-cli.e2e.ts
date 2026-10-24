// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — pack, install, and run the INSTALLED reasonbook bin: the MCP server with no arguments, the
// ABOUTME: hook behavior, local-only telemetry, stats export privacy, and the published file boundary.

/**
 * The bin moved from dist/index.js to dist/bin.js (design doc s93-m01, fork 1). This proves the
 * published artifact still starts the server the documented way (`npx -y @aquex/reasonbook`, which
 * runs the bin with no arguments), answers `--version`, and serves the hook verbs, and that
 * dist/index.js run directly still starts the server, as existing MCP configs do.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { seedRbookDb } from '../helpers/seedRbookDb';
import { installPackedArtifact } from './packed-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let hostDir = '';
let installedBin = '';
let installedIndex = '';
let installedTarball = '';
let configDir = '';

function artifactInventory(packageRoot: string, tarball: string): string[] {
  // npm 10 still runs directory prepare with --ignore-scripts. A file tarball needs no lifecycle.
  const pack = spawnSync('npm', ['pack', tarball, '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  expect(pack.status).toBe(0);
  const manifest = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
  return manifest[0].files.map((file) => file.path);
}

async function listTools(command: string, args: string[], cwd: string): Promise<number> {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: { ...process.env, RBOOK_CONFIG_DIR: configDir } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'hook-cli-e2e', version: '1.0.0' },
    { supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } }
  );
  await client.connect(transport);
  try {
    expect(client.getServerVersion()?.version).toBe(PKG.version);
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

describe('s93-m01 — the installed bin', () => {
  beforeAll(() => {
    const artifact = installPackedArtifact(REPO_ROOT, mkTmp);
    hostDir = artifact.hostDir;
    installedTarball = artifact.tarball;
    installedBin = artifact.binPath;
    installedIndex = artifact.serverPath;
    configDir = mkTmp('rbook-hook-e2e-config-');
  }, 240_000);

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('with no arguments the installed bin is the MCP server, with all 15 tools', async () => {
    expect(await listTools(installedBin, [], mkTmp('rbook-hook-e2e-cwd-'))).toBe(15);
  }, 60_000);

  it('s101-m04: a bare terminal invocation prints one hint and still completes an MCP handshake', async () => {
    const cwd = mkTmp('rbook-hook-e2e-terminal-');
    const preload = path.join(cwd, 'terminal.cjs');
    fs.writeFileSync(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-r', preload, installedBin],
      cwd,
      env: { ...process.env, RBOOK_CONFIG_DIR: configDir } as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client(
      { name: 'terminal-hint-e2e', version: '1.0.0' },
      { supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } }
    );
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(15);
    } finally {
      const ended = new Promise<void>((resolve) => transport.stderr?.once('end', resolve));
      await client.close();
      await ended;
    }
    expect(
      stderr
        .split('\n')
        .filter((line) => line === 'Serving MCP; use reasonbook --help for terminal commands.')
    ).toHaveLength(1);
  }, 30_000);

  it('`serve` is the same server, and node dist/index.js still starts it directly', async () => {
    expect(await listTools(installedBin, ['serve'], mkTmp('rbook-hook-e2e-cwd-'))).toBe(15);
    expect(await listTools(process.execPath, [installedIndex], mkTmp('rbook-hook-e2e-cwd-'))).toBe(
      15
    );
  }, 60_000);

  it('--version answers and exits under the installed command', () => {
    for (const bin of [installedBin]) {
      const ran = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      expect({ bin: path.basename(bin), status: ran.status, stdout: ran.stdout.trim() }).toEqual({
        bin: path.basename(bin),
        status: 0,
        stdout: `reasonbook ${PKG.version}`,
      });
    }
  });

  it('installed feedback previews without writes, then files a sanitized row without a session or mission', () => {
    const project = mkTmp('rbook-feedback-e2e-project-');
    const isolatedConfig = mkTmp('rbook-feedback-e2e-config-');
    const dbPath = seedRbookDb(project, { projectId: 'feedback-e2e' });
    const content = 'Observed friction.</content>\n<parameter name="notes">discard';
    const args = ['feedback', '--project-root', project, '--content', content, '--format=json'];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RBOOK_CONFIG_DIR: isolatedConfig,
      CLAUDE_PROJECT_DIR: '',
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.RBOOK_AGENT_ROLE;
    const before = fs.readFileSync(dbPath);
    const preview = spawnSync(installedBin, [...args, '--dry-run'], {
      cwd: hostDir,
      env: { ...env, RBOOK_AGENT_ROLE: 'review' },
      encoding: 'utf8',
    });
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      success: true,
      data: { dryRun: true, content: 'Observed friction.', projectRoot: project },
      sanitizedFields: [expect.objectContaining({ field: 'agentFeedback' })],
    });
    expect(fs.readFileSync(dbPath)).toEqual(before);

    const written = spawnSync(installedBin, args, { cwd: hostDir, env, encoding: 'utf8' });
    expect(written.status).toBe(0);
    expect(JSON.parse(written.stdout)).toMatchObject({
      success: true,
      data: { feedbackId: 1 },
      sanitizedFields: [expect.objectContaining({ field: 'agentFeedback' })],
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db
          .prepare(
            'SELECT body,tool_name,status,session_id,sprint_id,mission_id,project_id FROM agent_feedback'
          )
          .all()
      ).toEqual([
        {
          body: 'Observed friction.',
          tool_name: 'reasonbook feedback',
          status: 'open',
          session_id: null,
          sprint_id: null,
          mission_id: null,
          project_id: 'feedback-e2e',
        },
      ]);
      expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
      expect(db.prepare('SELECT id FROM missions').all()).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000);

  it('hook session-start prints SessionStart JSON in a Reasonbook project and exits 0', () => {
    const project = mkTmp('rbook-hook-e2e-project-');
    seedRbookDb(project, { projectName: 'hook e2e' });
    const ran = spawnSync(installedBin, ['hook', 'session-start'], {
      cwd: project,
      input: JSON.stringify({ session_id: 'e2e-session', source: 'startup', cwd: project }),
      env: { ...process.env, RBOOK_CONFIG_DIR: configDir, CLAUDE_PID: '777777' },
      encoding: 'utf8',
    });
    expect(ran.status).toBe(0);
    const output = JSON.parse(ran.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    expect(output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(6000);
  }, 30_000);

  // s96-m13 (build-time critic C, round 3): the digest takes a shared record's changes from
  // record-since, never from the merge, which would load zod and the whole apply path at every start.
  it('hook session-start loads neither zod nor the merge', () => {
    const project = mkTmp('rbook-hook-e2e-start-');
    seedRbookDb(project, { projectName: 'hook e2e start' });
    const preload = path.join(mkTmp('rbook-hook-e2e-start-preload-'), 'record.js');
    const out = path.join(path.dirname(preload), 'modules.json');
    fs.writeFileSync(
      preload,
      `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(require.cache))));\n`
    );
    const started = Date.now();
    const ran = spawnSync(
      process.execPath,
      ['-r', preload, installedBin, 'hook', 'session-start'],
      {
        cwd: project,
        input: JSON.stringify({ session_id: 'e2e-start', source: 'startup', cwd: project }),
        env: { ...process.env, RBOOK_CONFIG_DIR: configDir, CLAUDE_PID: '777777' },
        encoding: 'utf8',
      }
    );
    const elapsedMs = Date.now() - started;
    expect(ran.status).toBe(0);
    expect(elapsedMs).toBeLessThan(3000);
    const loaded = JSON.parse(fs.readFileSync(out, 'utf8')) as string[];
    expect(loaded.filter((f) => /[\\/]node_modules[\\/]zod[\\/]/.test(f))).toEqual([]);
    expect(loaded.filter((f) => /dist[\\/]tools[\\/]rbook[\\/]record-apply\.js$/.test(f))).toEqual(
      []
    );
    // The digest's own reader did load: a recorder that saw nothing would pass both checks above.
    expect(loaded.some((f) => /dist[\\/]tools[\\/]rbook[\\/]record-since\.js$/.test(f))).toBe(true);
  }, 30_000);

  // The m01 build critics, B2 and NB1: npx puts `npm exec` between the harness and its
  // server, so the server's parent has no link. It still writes into the harness session, found by
  // the session id it was spawned with, whether that is the first id or one after a /clear (a
  // respawn); without an id it keeps a session of its own (the control).
  it.each([
    { label: 'spawned with the first id', sessions: ['first'], spawnedWith: 'first' },
    {
      label: 'respawned after a /clear',
      sessions: ['before-clear', 'after-clear'],
      spawnedWith: 'after-clear',
    },
    { label: 'with no id (control)', sessions: ['control'], spawnedWith: null },
  ])(
    'a server started through npx, $label',
    async ({ label, sessions, spawnedWith }) => {
      const project = mkTmp('rbook-hook-e2e-npx-');
      const dbPath = seedRbookDb(project, { projectName: `hook e2e npx ${label}` });
      // This test process is the harness: its pid is CLAUDE_PID, and it stays alive throughout.
      sessions.forEach((id, index) => {
        const linked = spawnSync(installedBin, ['hook', 'session-start'], {
          cwd: project,
          input: JSON.stringify({
            session_id: `e2e-npx-${id}`,
            source: index === 0 ? 'startup' : 'clear',
            cwd: project,
          }),
          env: { ...process.env, RBOOK_CONFIG_DIR: configDir, CLAUDE_PID: String(process.pid) },
          encoding: 'utf8',
        });
        expect(linked.status).toBe(0);
      });

      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      env.RBOOK_CONFIG_DIR = configDir;
      delete env.CLAUDE_PID;
      if (spawnedWith) env.CLAUDE_CODE_SESSION_ID = `e2e-npx-${spawnedWith}`;
      else delete env.CLAUDE_CODE_SESSION_ID;
      const transport = new StdioClientTransport({
        command: 'npx',
        // The documented launch names the scoped package, which has two commands; npx must pick one.
        args: ['--offline', PKG.name],
        cwd: hostDir,
        env,
        stderr: 'pipe',
      });
      const client = new Client(
        { name: 'hook-cli-e2e-npx', version: '1.0.0' },
        { supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } }
      );
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'rbook_session',
          arguments: {
            action: 'capture',
            category: 'context',
            content: 'Written through npx.',
            projectRoot: project,
          },
        });
        // A refusal fails with its own text, so the run says why.
        if (result.isError) throw new Error(`capture refused: ${JSON.stringify(result.content)}`);
      } finally {
        await client.close();
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const holder = db
          .prepare("SELECT owner_key FROM sessions WHERE captures LIKE '%Written through npx.%'")
          .all() as Array<{ owner_key: string }>;
        expect(holder).toHaveLength(1);
        const current = `e2e-npx-${sessions[sessions.length - 1]}`;
        if (spawnedWith) expect(holder[0].owner_key).toBe(`ext:${harnessSessionHash(current)}`);
        else expect(holder[0].owner_key).toMatch(/^pid:/);
      } finally {
        db.close();
      }
    },
    60_000
  );

  // s93-m06: the INSTALLED Stop verb, with process-level stdout. Native hooks run it with no shim
  // in between, so nothing may reach stdout for any input (Claude Code charges a turn for it, #1187).
  it('hook stop prints nothing for any input, stores a trailing draft, and loads no MCP SDK or client', () => {
    const project = mkTmp('rbook-hook-e2e-stop-');
    const dbPath = seedRbookDb(project, { projectName: 'hook e2e stop' });
    const preload = path.join(mkTmp('rbook-hook-e2e-stop-preload-'), 'record.js');
    const out = path.join(path.dirname(preload), 'modules.json');
    fs.writeFileSync(
      preload,
      `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(require.cache))));\n`
    );
    const stop = (input: string) =>
      spawnSync(process.execPath, ['-r', preload, installedBin, 'hook', 'stop'], {
        cwd: project,
        input,
        env: { ...process.env, RBOOK_CONFIG_DIR: configDir, CLAUDE_PID: '777777' },
        encoding: 'utf8',
      });
    const reply =
      'I recommend one file per decision.\n\nWould record: Store each decision as its own JSON file, because diffs stay readable.';
    for (const input of [
      JSON.stringify({ session_id: 'e2e-stop', cwd: project, last_assistant_message: reply }),
      '',
      '{not json',
      '[]',
      JSON.stringify({ session_id: 'e2e-stop', cwd: path.join(project, 'missing') }),
    ]) {
      const ran = stop(input);
      expect([input.slice(0, 40), ran.status, ran.stdout]).toEqual([input.slice(0, 40), 0, '']);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE outcome = 'pending'").get() as {
            n: number;
          }
        ).n
      ).toBe(1);
    } finally {
      db.close();
    }
    const loaded = JSON.parse(fs.readFileSync(out, 'utf8')) as string[];
    expect(loaded.filter((f) => f.includes('@modelcontextprotocol'))).toEqual([]);
    expect(loaded.filter((f) => /dist[\\/]tools[\\/]rbook[\\/]client\.js$/.test(f))).toEqual([]);
  }, 60_000);

  it('hook prompt loads only better-sqlite3 and its own modules: no MCP SDK, no database client', () => {
    const project = mkTmp('rbook-hook-e2e-prompt-');
    seedRbookDb(project, { projectName: 'hook e2e prompt' });
    const preload = path.join(mkTmp('rbook-hook-e2e-preload-'), 'record.js');
    const out = path.join(path.dirname(preload), 'modules.json');
    fs.writeFileSync(
      preload,
      `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(require.cache))));\n`
    );
    const ran = spawnSync(process.execPath, ['-r', preload, installedBin, 'hook', 'prompt'], {
      cwd: project,
      input: JSON.stringify({ session_id: 'e2e-session', prompt: 'hello there', cwd: project }),
      env: { ...process.env, RBOOK_CONFIG_DIR: configDir, CLAUDE_PID: '777777' },
      encoding: 'utf8',
    });
    expect(ran.status).toBe(0);
    const loaded = JSON.parse(fs.readFileSync(out, 'utf8')) as string[];
    expect(loaded.filter((f) => f.includes('@modelcontextprotocol'))).toEqual([]);
    expect(loaded.filter((f) => /dist[\\/]tools[\\/]rbook[\\/]client\.js$/.test(f))).toEqual([]);
    expect(loaded.filter((f) => /dist[\\/]index\.js$/.test(f))).toEqual([]);
    const packages = new Set(
      loaded
        .filter((f) => f.includes(`node_modules${path.sep}`))
        .map((f) => f.split(`node_modules${path.sep}`).pop()!.split(path.sep)[0])
    );
    // Our own package, better-sqlite3 and its loader; nothing else.
    for (const name of packages) {
      expect(['@aquex', 'better-sqlite3', 'bindings', 'file-uri-to-path']).toContain(name);
    }
  }, 30_000);

  it('the installed hook records local telemetry and stats exports only aggregate evidence', () => {
    const project = mkTmp('rbook-hook-e2e-private-project-');
    const isolatedConfig = mkTmp('rbook-hook-e2e-private-config-');
    const dbPath = seedRbookDb(project, { projectName: 'private-project-sentinel' });
    const db = new Database(dbPath);
    try {
      db.prepare('INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)').run(
        'private-record-sentinel',
        new Date(Date.now() - 1000).toISOString()
      );
    } finally {
      db.close();
    }
    const before = fs.readFileSync(dbPath);
    const session = 'private-session-sentinel';
    const prompt = 'Run rbook_review() before work. private-prompt-sentinel';
    const env = {
      ...process.env,
      RBOOK_CONFIG_DIR: isolatedConfig,
      RBOOK_AMBIENT: 'off',
      CLAUDE_PROJECT_DIR: project,
    };
    const ran = spawnSync(installedBin, ['hook', 'prompt'], {
      cwd: project,
      input: JSON.stringify({ session_id: session, prompt, cwd: project }),
      env,
      encoding: 'utf8',
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('');
    // An ambient-off skip still records the prompting instrument, outside every project/package.
    const telemetryRoot = path.join(isolatedConfig, 'telemetry');
    const keys = fs.readdirSync(telemetryRoot);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{16}$/);
    const files = fs.readdirSync(path.join(telemetryRoot, keys[0]));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}\.jsonl$/);
    const telemetryFile = path.join(telemetryRoot, keys[0], files[0]);
    const text = fs.readFileSync(telemetryFile, 'utf8');
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: 'hook',
      tool: 'hook prompt',
      ambient: 'off',
      ok: true,
      session: `ext:${harnessSessionHash(session)}`,
      procedurePatternIds: ['P02', 'P03'],
    });
    const packageRoot = path.dirname(path.dirname(installedIndex));
    for (const root of [project, REPO_ROOT, packageRoot]) {
      expect(path.relative(root, telemetryFile).startsWith(`..${path.sep}`)).toBe(true);
      expect(fs.existsSync(path.join(root, 'telemetry'))).toBe(false);
    }
    for (const secret of [prompt, session, 'private-record-sentinel', 'private-project-sentinel'])
      expect(text).not.toContain(secret);

    const stats = spawnSync(installedBin, ['stats', '--export'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    expect(stats.status).toBe(0);
    const counts = JSON.parse(stats.stdout);
    expect(counts.projects).toBe(1);
    expect(counts.prompting).toMatchObject({ prompts: 1, measuredPrompts: 1, prompted: 1 });
    expect(counts.coverage.status).toBe('not-established');
    for (const secret of [
      project,
      isolatedConfig,
      prompt,
      session,
      harnessSessionHash(session),
      'private-record-sentinel',
      'private-project-sentinel',
    ])
      expect(stats.stdout).not.toContain(secret);
    expect(fs.readFileSync(dbPath)).toEqual(before);

    // Inspect the exact tarball we installed after telemetry exists. Code ships; events do not.
    const packedPaths = artifactInventory(packageRoot, installedTarball);
    expect(packedPaths).toContain('dist/tools/rbook/local-telemetry.js');
    expect(packedPaths).toContain('plugins/reasonbook/skills/feedback/SKILL.md');
    expect(packedPaths.filter((file) => /(^|\/)telemetry\/|\.jsonl$/.test(file))).toEqual([]);
  }, 30_000);
});

describe('already-packed artifact inventory', () => {
  it('reads archive bytes without running directory prepare or including later local files', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-pack-inventory-'));
    try {
      const packageRoot = path.join(temporary, 'package');
      fs.mkdirSync(packageRoot);
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'rbook-inventory-fixture',
          version: '1.0.0',
          scripts: { prepare: 'node prepare.cjs' },
        })
      );
      fs.writeFileSync(path.join(packageRoot, 'packed.js'), 'module.exports = {};');
      fs.writeFileSync(
        path.join(packageRoot, 'prepare.cjs'),
        `require('fs').writeFileSync('prepare-ran', 'yes'); process.stdout.write(".git can't be found\\n");`
      );
      const tarball = path.join(temporary, 'fixture.tgz');
      const archive = spawnSync('tar', ['-czf', tarball, '-C', temporary, 'package'], {
        encoding: 'utf8',
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      expect(archive.status).toBe(0);
      // Diverge the unpacked directory to prove the inventory reads the installed artifact itself.
      fs.unlinkSync(path.join(packageRoot, 'packed.js'));
      fs.writeFileSync(path.join(packageRoot, 'local-only.txt'), 'not shipped');

      const files = artifactInventory(packageRoot, tarball);
      expect(files).toContain('packed.js');
      expect(files).not.toContain('local-only.txt');
      expect(files).not.toContain('prepare-ran');
      expect(fs.existsSync(path.join(packageRoot, 'prepare-ran'))).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

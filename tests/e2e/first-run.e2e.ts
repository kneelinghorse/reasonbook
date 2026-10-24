// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m10 capstone — pack the tarball, install it into a temp dir, and drive
// ABOUTME: the full documented getting-started quickstart over real MCP stdio against the
// INSTALLED server. Guards the published first-run experience against silent breakage.

/**
 * First-run E2E (s77-m10).
 *
 * This is NOT a unit test — it packs the existing build, installs the tarball into
 * an isolated temp host, and speaks the Model Context Protocol over stdio to the
 * installed dist. It asserts the published artifact announces `rbook` @ the
 * package version (what siblings consume, not just the repo dist) and that every
 * documented quickstart command works end-to-end.
 *
 * Excluded from the default `npm test` (jest.config.js testPathIgnorePatterns) so the
 * heavy pack/install never runs in the unit suite or touches the coverage floors; run
 * it with `npm run test:e2e-firstrun` (its own jest.e2e.config.js) and in CI.
 *
 * s92-m07: a normal start writes two stderr lines (the version, and the project resolved at
 * startup); every other diagnostic is behind RBOOK_DEBUG=1. The stderr test below spawns its own
 * servers with a literal environment and pins that budget, with RBOOK_DEBUG as its positive control.
 *
 * @module tests/e2e/first-run.e2e
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import Database from 'better-sqlite3';
import { connectStdioServer, textOf, dataOf, type StdioHarness } from './stdio-harness';
import { installPackedArtifact } from './packed-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

// Collect every tmp dir we create so afterAll can tear them all down.
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let installedServer = ''; // absolute path to the installed dist/index.js
let hostDir = ''; // the consumer project the tarball was installed into
let projectDir = ''; // fresh project cwd for the server
let configDir = ''; // isolated RBOOK_CONFIG_DIR
let client: Client;
let transport: StdioClientTransport;

// textOf / dataOf come from the shared stdio harness (s80-m01) so the first-run
// E2E and scripts/verify-dist.ts never drift on payload extraction.

async function callOk(name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: { data?: unknown };
  };
  expect({ tool: name, isError: res.isError === true }).toEqual({ tool: name, isError: false });
  return res;
}

describe('first-run E2E: pack -> install -> drive quickstart over stdio (s77-m10)', () => {
  beforeAll(async () => {
    // 1–2. Pack the build from the preceding release gate, then install as a consumer would.
    const artifact = installPackedArtifact(REPO_ROOT, mkTmp);
    hostDir = artifact.hostDir;
    installedServer = artifact.serverPath;

    // 3. Spawn the INSTALLED server over real MCP stdio from a fresh project cwd,
    //    with an isolated config dir and RBOOK_PROJECT_ROOT deleted (auto-discovery).
    projectDir = mkTmp('rbook-e2e-project-');
    configDir = mkTmp('rbook-e2e-config-');
    const env = { ...process.env, RBOOK_CONFIG_DIR: configDir } as Record<string, string>;
    delete env.RBOOK_PROJECT_ROOT;

    // s80-m01: connect via the shared stdio bootstrap (also used by verify:dist).
    const harness = await connectStdioServer({
      serverPath: installedServer,
      cwd: projectDir,
      env,
      clientName: 'first-run-e2e',
    });
    client = harness.client;
    transport = harness.transport;
  }, 180000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('announces rbook @ the package version and exposes all 15 tools', async () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('rbook');
    expect(info?.version).toBe(PKG.version);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(15);
    const readme = fs.readFileSync(
      path.join(hostDir, 'node_modules', PKG.name, 'rbook-seed', 'README.md'),
      'utf8'
    );
    const listed = [...readme.matchAll(/^\|\s*`(rbook_[a-z_]+)`\s*\|/gm)].map((row) => row[1]);
    expect(listed.sort()).toEqual(tools.tools.map((tool) => tool.name).sort());
  });

  it('s101-m04: packed init keeps runtime files out of git and still refuses a forcibly tracked store', async () => {
    const root = mkTmp('rbook-e2e-ignore-');
    await callOk('rbook_project', { action: 'init', projectRoot: root });
    const ignore = path.join(root, 'rbook', '.gitignore');
    expect(fs.existsSync(ignore)).toBe(true);
    expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
    const runtime = [
      'rbook/db/rbook.sqlite',
      'rbook/db/rbook.sqlite-wal',
      'rbook/db/rbook.sqlite-shm',
      'rbook/db/snapshots/manual-example.sqlite',
    ];
    const ignored = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      input: runtime.join('\n') + '\n',
      encoding: 'utf8',
    });
    expect(ignored.status).toBe(0);
    expect(ignored.stdout.trim().split('\n')).toEqual(runtime);
    const policy = '# Deliberately track this project store.\n*.local\n';
    fs.writeFileSync(ignore, policy);
    await callOk('rbook_project', { action: 'init', projectRoot: root });
    expect(fs.readFileSync(ignore, 'utf8')).toBe(policy);
    expect(spawnSync('git', ['add', '-f', 'rbook/db/rbook.sqlite'], { cwd: root }).status).toBe(0);
    const shared = await client.callTool({
      name: 'rbook_project',
      arguments: { action: 'share', projectRoot: root, authorName: 'First-hour test' },
    });
    expect(shared.isError).toBe(true);
    expect(shared.structuredContent).toMatchObject({
      error: { code: 'RECORD_WRITE_REFUSED', message: expect.stringMatching(/tracks its store/) },
    });
  });

  it.each(['project_name', 'project_id'])(
    's101-m04: rejects numeric %s over MCP before it can break status',
    async (field) => {
      const root = mkTmp('rbook-e2e-identity-');
      await callOk('rbook_project', { action: 'init', projectRoot: root });
      const update = await client.callTool({
        name: 'rbook_context',
        arguments: {
          action: 'update',
          contextType: 'project_identity',
          projectRoot: root,
          fieldUpdates: [{ path: field, value: 1984 }],
        },
      });
      const status = await client.callTool({
        name: 'rbook_status',
        arguments: { projectRoot: root },
      });
      expect(update.isError).toBe(true);
      expect(update.structuredContent).toMatchObject({
        success: false,
        error: { code: 'INVALID_PARAMETER', field },
      });
      expect(status.isError).toBe(false);
    }
  );

  it('s101-m10: two installed processes agree on the default name with checkpoint sync unset', async () => {
    const root = mkTmp('rbook-e2e-concurrent-init-');
    const env = {
      HOME: mkTmp('rbook-e2e-concurrent-home-'),
      RBOOK_CONFIG_DIR: mkTmp('rbook-e2e-concurrent-config-'),
      PATH: process.env.PATH ?? path.dirname(process.execPath),
    };
    const peers: StdioHarness[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        peers.push(await connectStdioServer({ serverPath: installedServer, cwd: root, env }));
      }
      const initialized = await Promise.all(
        peers.map((peer) => peer.callOk('rbook_project', { action: 'init', projectRoot: root }))
      );
      const ids = initialized.map((result) => dataOf(result)?.projectId);
      expect(ids[0]).toEqual(expect.any(String));
      expect(ids[1]).toBe(ids[0]);
      expect(fs.existsSync(path.join(root, 'rbook', '.gitignore'))).toBe(true);
      expect(fs.readdirSync(root).filter((name) => name.toLowerCase() === 'agents.md')).toEqual([
        'AGENTS.md',
      ]);
      // m10 stores the default name together with the create-only registration guard.
      const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
      try {
        expect(
          db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get()
        ).toBe(ids[0]);
        expect(
          db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").pluck().get()
        ).toBe(path.basename(root));
        expect(
          JSON.parse(
            db
              .prepare("SELECT content FROM contexts WHERE id = 'master_context'")
              .pluck()
              .get() as string
          ).project_identity.name
        ).toBe(path.basename(root));
      } finally {
        db.close();
      }
      await peers[0].callOk('rbook_status', { projectRoot: root });
      const onboard = await peers[0].callOk('rbook_agent_onboard', { projectRoot: root });
      expect(dataOf(onboard)?.project?.name).toBe(path.basename(root));
      const review = await peers[0].callOk('rbook_review', { projectRoot: root });
      expect(textOf(review)).toContain(path.basename(root));
      // An empty brief has no per-project row; a real decision gives it an item to name.
      await peers[0].callOk('rbook_decisions', {
        action: 'record',
        projectRoot: root,
        content: 'Keep this first-hour record local until sharing is needed.',
        mode: 'autonomous',
      });
      for (const args of [['signals', '--project-root', root], ['brief']]) {
        const displayed = spawnSync(
          process.execPath,
          [path.join(path.dirname(installedServer), 'bin.js'), ...args],
          { cwd: root, env, encoding: 'utf8' }
        );
        expect({ args, status: displayed.status, stderr: displayed.stderr }).toEqual({
          args,
          status: 0,
          stderr: '',
        });
        expect(displayed.stdout).toContain(path.basename(root));
      }
    } finally {
      await Promise.all(peers.map((peer) => peer.close()));
    }
  });

  it('s92-m07: a clean-room start writes at most two stderr lines; RBOOK_DEBUG=1 brings the rest back', async () => {
    const startupStderr = async (debug: boolean): Promise<string[]> => {
      // A literal environment: nothing inherited from the developer's shell.
      const env: Record<string, string> = {
        HOME: mkTmp('rbook-e2e-quiet-home-'),
        RBOOK_CONFIG_DIR: mkTmp('rbook-e2e-quiet-config-'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        ...(debug ? { RBOOK_DEBUG: '1' } : {}),
      };
      const quietTransport = new StdioClientTransport({
        command: process.execPath,
        args: [installedServer],
        cwd: mkTmp('rbook-e2e-quiet-cwd-'),
        env,
        stderr: 'pipe',
      });
      let stderr = '';
      quietTransport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const quietClient = new Client(
        { name: 's92-m07-stderr', version: '0.0.0' },
        {
          capabilities: {},
          supportedProtocolVersions: ['2025-11-25'],
          versionNegotiation: { mode: 'legacy' },
        }
      );
      await quietClient.connect(quietTransport);
      await quietClient.listTools();
      // s98-m08 (#660 item 3): wait for the startup's last line, then count every line the server
      // wrote before it exited, rather than what had arrived after a 300 ms sleep.
      for (const until = Date.now() + 10_000; !/project: /.test(stderr) && Date.now() < until; )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const ended = new Promise<void>((resolve) =>
        quietTransport.stderr?.once('end', () => resolve())
      );
      await quietClient.close();
      await ended;
      return stderr.split('\n').filter((line) => line.trim().length > 0);
    };

    const quiet = await startupStderr(false);
    expect(quiet.length).toBeLessThanOrEqual(2);
    expect(quiet[0]).toBe(`[reasonbook] v${PKG.version} ready on stdio (15 tools)`);
    expect(quiet[1]).toMatch(/^\[reasonbook\] project: none at startup/);
    // Positive control: the diagnostics still exist; they are gated, not deleted.
    const verbose = await startupStderr(true);
    expect(verbose.length).toBeGreaterThan(10);
    expect(verbose.join('\n')).toContain('[INFO] Initializing MCP server');
  }, 60000);

  it('s92-m07: installing the package does not pull the embedding stack, and health says so', async () => {
    // @xenova/transformers is an optional peer: npm installs it only when asked.
    expect(fs.existsSync(path.join(hostDir, 'node_modules', '@xenova', 'transformers'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(hostDir, 'node_modules', 'onnxruntime-node'))).toBe(false);
    expect(fs.existsSync(path.join(hostDir, 'node_modules', 'fast-xml-parser'))).toBe(false);

    const healthProject = mkTmp('rbook-e2e-health-project-');
    await callOk('rbook_project', {
      action: 'init',
      projectRoot: healthProject,
      projectName: 'e2e-health',
    });
    const health = await callOk('rbook_db', { action: 'health', projectRoot: healthProject });
    expect(dataOf(health)?.semanticSearch).toMatchObject({
      enabled: false,
      state: 'not-installed',
    });
    expect(textOf(health)).toMatch(/Semantic search\*\*: off/);
  });

  it('`--version` on the installed dist prints reasonbook <version> and exits 0', () => {
    const res = spawnSync(process.execPath, [installedServer, '--version'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(`reasonbook ${PKG.version}`);
  });

  it('drives the documented quickstart lifecycle end-to-end', async () => {
    // Init a fresh project — the seed store must land in the project cwd.
    // s93-m12: a new project defaults to the Ledger level, where onboard hides the mission queue.
    // The documented quick starts teach sprints and missions, so they init at the Builder level,
    // and so does this; the queued-mission check below fails for a Ledger project.
    await callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDir,
      projectName: 'e2e-first-run',
      projectType: 'build',
    });
    expect(fs.existsSync(path.join(projectDir, 'rbook', 'db', 'rbook.sqlite'))).toBe(true);

    // The documented opener (m07) works against the freshly-initialized store.
    const review = await callOk('rbook_review', { projectRoot: projectDir });
    expect(textOf(review).length).toBeGreaterThan(0);

    // Cold-start onboard shows the fresh project + its name.
    const onboard1 = await callOk('rbook_agent_onboard', { projectRoot: projectDir });
    const onboard1Data = dataOf(onboard1);
    expect(onboard1Data?.project?.name).toBe('e2e-first-run');
    expect(onboard1Data?.freshProject).toBe(true);

    // Sprint -> session -> capture -> mission -> transitions -> complete.
    await callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-01',
      title: 'First sprint',
      focus: 'Ship the first feature',
      projectRoot: projectDir,
    });
    await callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'Plan sprint 01',
      sprintId: 'sprint-01',
      projectRoot: projectDir,
    });
    await callOk('rbook_session', {
      action: 'capture',
      category: 'decision',
      content: 'Use device-code auth for the dashboard handshake',
      projectRoot: projectDir,
    });
    await callOk('rbook_mission', {
      action: 'add',
      missionId: 's01-m01',
      name: 'First mission',
      sprintId: 'sprint-01',
      objective: 'Deliver the first end-to-end feature',
      successCriteria: ['Feature works', 'Tests pass'],
      projectRoot: projectDir,
    });
    // A Builder project's onboard lists the queued mission; a Ledger project's leaves it out.
    const queued = dataOf(await callOk('rbook_agent_onboard', { projectRoot: projectDir }));
    expect((queued?.pendingMissions ?? []).map((mission: { id: string }) => mission.id)).toContain(
      's01-m01'
    );
    await callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 's01-m01',
      projectRoot: projectDir,
    });
    await callOk('rbook_mission_transition', {
      action: 'complete',
      missionId: 's01-m01',
      notes: 'Shipped the feature end-to-end',
      projectRoot: projectDir,
    });
    await callOk('rbook_session', {
      action: 'complete',
      summary: 'Sprint 01 first mission shipped',
      projectRoot: projectDir,
    });

    // A second onboard reflects the completed mission + the captured decision. The
    // completed mission leaves the pending queue and shows up as real completion
    // activity (onboard doesn't echo completed-mission ids, so assert the signals it
    // actually surfaces).
    const onboard2 = await callOk('rbook_agent_onboard', { projectRoot: projectDir });
    const onboard2Data = dataOf(onboard2);
    const onboard2Text = textOf(onboard2) + JSON.stringify(onboard2Data ?? {});
    expect(onboard2Data?.contextFreshness?.latestMissionCompletionAt).toBeTruthy();
    expect(onboard2Data?.pendingMissions ?? []).toHaveLength(0);
    expect(onboard2Text.toLowerCase()).toContain('device-code auth');

    // rbook_status: 5-field health snapshot, local-only auth tier.
    const status = await callOk('rbook_status', { projectRoot: projectDir });
    const statusText = textOf(status) + JSON.stringify(dataOf(status) ?? {});
    expect(statusText).toContain('auth_tier');
    expect(statusText).toContain('none');
  });

  /**
   * s92-m10 — the clean-room scenarios, promoted from the 2026-10-06 scripted client
   * (rbook/research/2026-10-strategy/cleanroom-client/, which the public mirror excludes) and run
   * against the INSTALLED package with a literal environment. Two more clean-room assertions live
   * in this lane: two stderr lines (the s92-m07 test above) and no checkpoint upload on an
   * implicit close (implicit-sessions.e2e.ts drives the upload path with a positive control,
   * rather than asserting a zero at process exit, where a fire-and-forget upload can die unseen).
   */
  describe('s92-m10 clean-room scenarios on the installed package', () => {
    const harnesses: StdioHarness[] = [];
    let cleanHome = '';
    let cleanConfig = '';

    beforeAll(() => {
      cleanHome = mkTmp('rbook-e2e-clean-home-');
      cleanConfig = mkTmp('rbook-e2e-clean-config-');
    });

    afterAll(async () => {
      for (const harness of harnesses) await harness.close();
    });

    async function server(cwd: string): Promise<StdioHarness> {
      const harness = await connectStdioServer({
        serverPath: installedServer,
        cwd,
        env: {
          HOME: cleanHome,
          RBOOK_CONFIG_DIR: cleanConfig,
          RBOOK_CHECKPOINT_SYNC: 'off',
          PATH: process.env.PATH ?? path.dirname(process.execPath),
          NODE_ENV: 'test',
        },
        clientName: 's92-m10-clean-room',
      });
      harnesses.push(harness);
      return harness;
    }

    /** Row counts that any write to the project would change. */
    function rows(root: string): Record<string, number> {
      const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
      try {
        const count = (table: string): number =>
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        return {
          decisions: count('strategic_decisions'),
          sessions: count('sessions'),
          missions: count('missions'),
          snapshots: count('context_snapshots'),
        };
      } finally {
        db.close();
      }
    }

    it('singleton: with one registered project, calls from an unrelated folder write nothing anywhere', async () => {
      const projectA = mkTmp('rbook-e2e-clean-a-');
      const setup = await server(projectA);
      await setup.callOk('rbook_project', {
        action: 'init',
        projectRoot: projectA,
        projectName: 'Clean A',
      });
      await setup.callOk('rbook_decisions', {
        action: 'record',
        content: 'Project A decision: use Rust for the CLI.',
        projectRoot: projectA,
      });
      await setup.close();
      const before = rows(projectA);

      const elsewhere = mkTmp('rbook-e2e-clean-elsewhere-');
      const stranger = await server(elsewhere);
      const calls: Array<[string, Record<string, unknown>]> = [
        ['rbook_review', {}],
        [
          'rbook_decisions',
          { action: 'record', content: 'Project B decision: use Go for the API.' },
        ],
        ['rbook_session', { action: 'start', title: 'B work' }],
        ['rbook_session', { action: 'capture', category: 'decision', content: 'B capture' }],
      ];
      for (const [tool, args] of calls) {
        const result = await stranger.callTool(tool, args);
        expect({ tool, refused: result.isError === true }).toEqual({ tool, refused: true });
        expect(stranger.textOf(result)).toContain('No Reasonbook project in');
        expect(stranger.textOf(result)).toContain(path.basename(elsewhere));
      }
      await stranger.close();
      expect(rows(projectA)).toEqual(before);
      expect(fs.existsSync(path.join(elsewhere, 'rbook'))).toBe(false);
    });

    it('an explicit root that is not a Reasonbook project is refused by name, and nothing is written', async () => {
      const projectA = mkTmp('rbook-e2e-clean-explicit-a-');
      const a = await server(projectA);
      await a.callOk('rbook_project', { action: 'init', projectRoot: projectA, projectName: 'A' });
      const before = rows(projectA);
      const plain = mkTmp('rbook-e2e-clean-plain-');
      const result = await a.callTool('rbook_decisions', {
        action: 'record',
        content: 'This must land nowhere.',
        projectRoot: plain,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.code).toBe('RBOOK_NOT_DETECTED');
      expect(a.textOf(result)).toContain(path.basename(plain));
      expect(a.textOf(result)).toContain('rbook_project(action="init"');
      expect(rows(projectA)).toEqual(before);
      expect(fs.existsSync(path.join(plain, 'rbook'))).toBe(false);
    });

    it('a fresh project opens with the onboard flow and nothing misleading', async () => {
      const fresh = mkTmp('rbook-e2e-clean-fresh-');
      const s = await server(fresh);
      await s.callOk('rbook_project', { action: 'init', projectRoot: fresh, projectName: 'Fresh' });
      const review = await s.callOk('rbook_review', { projectRoot: fresh });
      const actions = (s.dataOf(review)?.next_actions ?? []) as Array<{ command: string }>;
      expect(actions[0]?.command).toBe('rbook_agent_onboard()');
      const said = JSON.stringify(actions) + s.textOf(review);
      for (const misleading of [
        'tierSelectionPrompt',
        // s100-m02: login, login_init or login_complete; a fresh project needs none.
        'rbook_auth(action="login',
        'rbook_message(action="whoami")',
      ]) {
        expect({ misleading, present: said.includes(misleading) }).toEqual({
          misleading,
          present: false,
        });
      }
    });

    it('record, then start, then complete: no false warning, and the recorded decision is counted', async () => {
      const root = mkTmp('rbook-e2e-clean-loop-');
      const s = await server(root);
      await s.callOk('rbook_project', { action: 'init', projectRoot: root, projectName: 'Loop' });
      await s.callOk('rbook_sprint', {
        action: 'add',
        sprintId: 'sprint-01',
        title: 'First sprint',
        focus: 'The first feature',
        projectRoot: root,
      });
      await s.callOk('rbook_mission', {
        action: 'add',
        missionId: 's01-m01',
        name: 'First mission',
        sprintId: 'sprint-01',
        objective: 'Deliver the first feature',
        projectRoot: root,
      });
      await s.callOk('rbook_decisions', {
        action: 'record',
        missionId: 's01-m01',
        content: 'Chose event sourcing for the audit trail',
        projectRoot: root,
      });
      await s.callOk('rbook_mission_transition', {
        action: 'start',
        missionId: 's01-m01',
        projectRoot: root,
      });
      const done = await s.callOk('rbook_mission_transition', {
        action: 'complete',
        missionId: 's01-m01',
        notes: 'Shipped',
        projectRoot: root,
      });
      expect(s.textOf(done)).not.toContain('No decisions captured');
      expect(s.dataOf(done)?.missionDecisionCount).toBe(1);
    });

    it('tools/list from the installed package stays under its 24,000-character ceiling', async () => {
      const s = await server(mkTmp('rbook-e2e-clean-list-'));
      const tools = await s.client.listTools();
      expect(tools.tools).toHaveLength(15);
      expect(JSON.stringify(tools.tools).length).toBeLessThanOrEqual(24_000);
    });
  });
});

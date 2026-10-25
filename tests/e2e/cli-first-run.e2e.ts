// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The packed CLI teaches the first-run workflow while sharing the MCP rules-file contract.
// ABOUTME: Both init paths fill project identity, retain learned practices, and preserve hookless setup.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installPackedArtifact } from './packed-artifact';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
}

function readAgents(root: string): string {
  return fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
}

function learnedPractices(text: string): string {
  const section = /^## Learned Practices\n([\s\S]*?)(?=^## |^---\s*$|(?![\s\S]))/m.exec(text);
  expect(section).not.toBeNull();
  return section![1].trim();
}

let artifact: ReturnType<typeof installPackedArtifact>;
let server: StdioHarness;
let env: Record<string, string>;
let shippedPractices: string;

function init(root: string, args: string[] = []): string {
  const result = spawnSync(
    process.execPath,
    [artifact.binPath, 'init', '--project-root', root, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 }
  );
  expect({
    status: result.status,
    signal: result.signal,
    error: result.error,
    stderr: result.stderr,
  }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
  return result.stdout;
}

describe('s102-m09 packed CLI first run', () => {
  beforeAll(async () => {
    artifact = installPackedArtifact(REPO_ROOT, mkTmp);
    env = {
      HOME: mkTmp('rbook-cli-init-home-'),
      RBOOK_CONFIG_DIR: mkTmp('rbook-cli-init-config-'),
      RBOOK_CHECKPOINT_SYNC: 'off',
      PATH: process.env.PATH ?? path.dirname(process.execPath),
    };
    const packageRoot = path.dirname(path.dirname(artifact.serverPath));
    shippedPractices = learnedPractices(
      fs.readFileSync(path.join(packageRoot, 'rbook-seed/templates/AGENTS.md'), 'utf8')
    );
    server = await connectStdioServer({
      serverPath: artifact.serverPath,
      cwd: mkTmp('rbook-cli-init-server-'),
      env,
      clientName: 'packed-cli-first-run',
    });
  });

  afterAll(async () => {
    await server?.close();
    for (const root of tmpDirs) fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints actionable first-run steps and the explicit remedy for a harness without hooks', () => {
    const output = init(mkTmp('rbook-cli-guidance-'), ['--name', 'First run']);
    expect(output).toContain('Reasonbook record started');
    expect(output).toMatch(/if[^\n]*harness[^\n]*no[^\n]*hooks/i);
    expect(output).toContain('reasonbook init --no-hooks');
    expect(output).toContain('rbook_review()');
    expect(output).toContain('rbook_decisions(action="record", content="...")');
    expect(output).toContain('rbook_session(action="capture", category="learning", content="...")');
    expect(output).toContain('category="next-step"');
    expect(output).toMatch(/before you stop[^\n]*unfinished[^\n]*next step/i);
  });

  it.each([
    ['ledger', 'general'],
    ['planner', 'managed'],
    ['builder', 'build'],
  ])(
    'CLI and MCP init at %s write the same filled file with all 14 learned practices',
    async (level, projectType) => {
      const cliRoot = mkTmp('rbook-cli-rules-');
      const mcpRoot = mkTmp('rbook-mcp-rules-');
      const projectName = `Shared first-run ${level} project`;
      init(cliRoot, ['--level', level, '--name', projectName]);
      await server.callOk('rbook_project', {
        action: 'init',
        projectRoot: mcpRoot,
        projectName,
        projectType,
      });
      const viaCli = readAgents(cliRoot);
      const viaMcp = readAgents(mcpRoot);
      expect(viaCli).toBe(viaMcp);
      expect(viaCli).toContain(projectName);
      // Bracketed customization prompts must not ship as instructions in a new project's rules.
      expect(viaCli).not.toMatch(/\[[^\]]+\](?!\()/);
      expect(learnedPractices(viaCli)).toBe(shippedPractices);
      expect(
        [...learnedPractices(viaCli).matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
      ).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
      const pointer = viaCli
        .split('\n')
        .filter((line) => line.startsWith("Reasonbook keeps this project's record at the "));
      expect(pointer).toHaveLength(1);
      expect(pointer[0]).toContain('`reasonbook ambient off`');
      expect(viaCli).not.toContain('<!-- Reasonbook hook-less block:');
    }
  );

  it('keeps the hookless pointer and block when a project later initializes through MCP', async () => {
    const root = mkTmp('rbook-cli-hookless-');
    const projectName = 'Hookless first run';
    init(root, ['--no-hooks', '--name', projectName]);
    const before = readAgents(root);
    expect(before).toContain('This harness runs no Reasonbook hooks');
    const block =
      /<!-- Reasonbook hook-less block:[\s\S]*?<!-- \/Reasonbook hook-less block -->/.exec(
        before
      )?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('rbook_review()');
    await server.callOk('rbook_project', { action: 'init', projectRoot: root, projectName });
    expect(readAgents(root)).toBe(before);
    expect(learnedPractices(readAgents(root))).toBe(shippedPractices);
  });
});

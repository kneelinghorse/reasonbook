// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m04 over stdio: a project the client's roots or the operator's --project-root named
// ABOUTME: gets no whoami nudge; one inferred from cwd does only when the dashboard is explicitly in use.

/**
 * The in-process tests cover the handler rule; this proves the dispatcher feeds it, from the built
 * dist/index.js with a real client advertising real roots.
 *
 * ISOLATION: HOME and RBOOK_CONFIG_DIR are throwaway directories. An empty RBOOK_PROJECT_ROOT
 * makes index's nullish .env-root fallback resolve against scratch cwd instead of the checkout;
 * the attribution check trims that empty value, so it does not itself become a whoami reason.
 * Dashboard opt-in is explicit and loopback-only, with no credentials. All attribution cases
 * enable it, so the named-project negatives cannot pass merely because the dashboard is off.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { seedRbookDb } from '../helpers/seedRbookDb';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const SERVER = path.resolve(__dirname, '../../dist/index.js');
const WHOAMI = 'rbook_message(action="whoami")';

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(opts: {
  cwd: string;
  home: string;
  dashboardOptedIn?: boolean;
  roots?: string[];
  serverArgs?: string[];
}): Promise<StdioHarness> {
  const harness = await connectStdioServer({
    serverPath: SERVER,
    cwd: opts.cwd,
    env: {
      HOME: opts.home,
      RBOOK_CONFIG_DIR: mkTmp('rbook-e2e-m04-config-'),
      RBOOK_PROJECT_ROOT: '',
      RBOOK_CHECKPOINT_SYNC: 'off',
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      NODE_ENV: 'test',
      ...(opts.dashboardOptedIn ? { RBOOK_DASHBOARD_URL: 'http://127.0.0.1:9' } : {}),
    },
    clientName: 's92-m04-honest-opener',
    ...(opts.roots ? { roots: opts.roots } : {}),
    ...(opts.serverArgs ? { serverArgs: opts.serverArgs } : {}),
  });
  cleanup.push(() => harness.close());
  return harness;
}

interface ReviewAnswer {
  commands: string[];
  resolvedBy: string;
  text: string;
}

async function review(harness: StdioHarness): Promise<ReviewAnswer> {
  const res = await harness.callOk('rbook_review', {});
  const structured = res.structuredContent as {
    data: { next_actions: Array<{ command: string }>; resolvedBy: string };
  };
  return {
    commands: structured.data.next_actions.map((a) => a.command),
    resolvedBy: structured.data.resolvedBy,
    text: harness.textOf(res),
  };
}

function freshProject(): string {
  const projectRoot = mkTmp('rbook-e2e-m04-project-');
  seedRbookDb(projectRoot, { projectName: 's92-m04 e2e' });
  return projectRoot;
}

describe('s92-m04 honest opener over stdio', () => {
  it('POSITIVE CONTROL: a project inferred from the working directory is prescribed whoami', async () => {
    const projectRoot = freshProject();
    const answer = await review(
      await connect({
        cwd: projectRoot,
        home: mkTmp('rbook-e2e-m04-home-'),
        dashboardOptedIn: true,
      })
    );
    expect(answer.resolvedBy).toBe('cwd');
    expect(answer.commands).toContain(WHOAMI);
    expect(answer.text).toContain(WHOAMI);
  });

  it('a local-only project inferred from cwd gets no whoami or login nudge', async () => {
    const answer = await review(
      await connect({ cwd: freshProject(), home: mkTmp('rbook-e2e-m04-local-home-') })
    );
    expect(answer.resolvedBy).toBe('cwd');
    expect(answer.commands).not.toContain(WHOAMI);
    expect(answer.commands).not.toContain(
      'rbook_auth(action="login_init"), then rbook_auth(action="login_complete")'
    );
    expect(answer.text).not.toContain(WHOAMI);
    expect(answer.text).not.toContain('rbook_auth(action="login');
  });

  it("a project named by the client's roots is not, and the onboard-only action stays home", async () => {
    const projectRoot = freshProject();
    const home = mkTmp('rbook-e2e-m04-home-');
    const answer = await review(
      await connect({ cwd: home, home, roots: [projectRoot], dashboardOptedIn: true })
    );
    expect(answer.resolvedBy).toBe('mcp-roots');
    expect(answer.commands).not.toContain(WHOAMI);
    expect(answer.commands[0]).toBe('rbook_agent_onboard()');
    expect(answer.text).not.toContain('tierSelectionPrompt');
  });

  it("a project named by the operator's --project-root is not either", async () => {
    const projectRoot = freshProject();
    const home = mkTmp('rbook-e2e-m04-home-');
    const answer = await review(
      await connect({
        cwd: home,
        home,
        serverArgs: ['--project-root', projectRoot],
        dashboardOptedIn: true,
      })
    );
    expect(answer.resolvedBy).toBe('server-project-root');
    expect(answer.commands).not.toContain(WHOAMI);
    expect(answer.commands[0]).toBe('rbook_agent_onboard()');
  });
});

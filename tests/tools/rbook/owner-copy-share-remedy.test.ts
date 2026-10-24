// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Owner-copy share refusals consult the actual referee before prescribing an irreversible cut.
// ABOUTME: Loopback HTTP, MCP dispatch and CLI rendering prove consent, safe remedies and intact local logs.
import * as http from 'http';
import type { AddressInfo } from 'net';
import { runShare } from '../../../src/cli/dashboard';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { shareThroughDashboard } from '../../../src/tools/rbook/record-dashboard-share';
import { recordExchanged } from '../../../src/tools/rbook/record-peers';
import { storeOpener } from '../../../src/tools/rbook/record-sync';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';

const projectId = 'owned-share-project';
const environment = ['RBOOK_DASHBOARD_SHARING', 'CMOS_DASHBOARD_SHARING'] as const;
let fixture: ReplicaFixture;
let server: http.Server | undefined;
let saved: Record<string, string | undefined>;
let requests: string[];

beforeEach(() => {
  fixture = replicaFixture('rbook-owner-share-remedy-');
  requests = [];
  saved = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  for (const key of environment) delete process.env[key];
});

afterEach(async () => {
  if (server) {
    const closing = new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server.closeAllConnections();
    await closing;
    server = undefined;
  }
  jest.restoreAllMocks();
  fixture.restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function referee(version: string | null, status = 200) {
  server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/api/projects/me') {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'No mutation endpoint exists in this fixture.' }));
      return;
    }
    response.statusCode = status;
    response.end(
      JSON.stringify(
        status === 200
          ? {
              success: true,
              data: {
                projects: [{ id: projectId, referee: { version, protocol: { record: 2 } } }],
              },
            }
          : { error: 'The referee capability lookup failed.' }
      )
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const client = new DashboardClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: 'owned-share-remedy-key',
  });
  return jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'project-scoped', matchedProjectRoot: null },
  });
}

async function copies() {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'studio', 'Owner');
  await onCopy(fixture.tmp, owner, (client) => {
    // The remedy must fail independently of the file-join last_call_at counting regression.
    recordExchanged(client, other.replicaId, { marks: {} });
    expect(
      client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
        'dashboard_project_id',
        projectId,
      ]).success
    ).toBe(true);
  });
  return { owner, other };
}

function snapshot(owner: Copy) {
  return {
    changes: read(owner, 'SELECT * FROM record_changes ORDER BY change_id'),
    peers: read(owner, 'SELECT * FROM record_peers ORDER BY replica_id'),
    metadata: read(owner, 'SELECT * FROM metadata ORDER BY key'),
  };
}

function share(owner: Copy, confirm: boolean) {
  useMachine(fixture.tmp, owner.machine);
  const dbPath = dbOf(owner.root);
  return shareThroughDashboard(
    storeOpener(dbPath),
    storeOpener(dbPath, { replicaCheck: false }),
    dbPath,
    { confirm }
  );
}

function supportedRemedy(text: string, replicaId: string) {
  expect(text).toContain(`reasonbook set-aside --replica ${replicaId}`);
  expect(text).toMatch(/preview/i);
  expect(text).toMatch(/gone/i);
  expect(text).toContain('--yes');
  expect(text).toMatch(/share again/i);
}

it.each([
  ['4.3.0', 200],
  [null, 200],
  ['invalid', 200],
  ['4.5.0-rc.1', 200],
  [null, 503],
] as const)(
  'referee %s (HTTP %s) cannot justify an irreversible cut before dashboard sharing',
  async (version, status) => {
    const { owner, other } = await copies();
    const resolve = await referee(version, status);
    const before = snapshot(owner);
    const result = await share(owner, true);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(other.replicaId);
    expect(requests).toEqual(['GET /api/projects/me']);
    expect(resolve.mock.calls.map(([root]) => root)).toContain(owner.root);
    const remedy = result.error?.suggestion ?? '';
    expect(remedy).toMatch(/Keep sharing (?:it )?directly/i);
    expect(remedy).toMatch(/cannot be undone/i);
    expect(remedy).not.toContain('reasonbook set-aside');
    if (version === '4.3.0') expect(remedy).toContain('4.3.0');
    expect(snapshot(owner)).toEqual(before);
  }
);

it.each(['4.5.0', '4.5.1'])(
  'referee %s supports a complete, consent-qualified remedy inside the CLI cap',
  async (version) => {
    const { owner, other } = await copies();
    await referee(version);
    const before = snapshot(owner);
    const result = await share(owner, true);
    expect(result.success).toBe(false);
    const remedy = result.error?.suggestion ?? '';
    expect(remedy.length).toBeLessThanOrEqual(300);
    supportedRemedy(remedy, other.replicaId);
    expect(requests).toEqual(['GET /api/projects/me']);
    expect(snapshot(owner)).toEqual(before);
  }
);

it('the dry run stays offline and makes any set-aside remedy conditional on referee 4.5.0+', async () => {
  const { owner, other } = await copies();
  const resolve = await referee('4.5.1');
  const before = snapshot(owner);
  const result = await share(owner, false);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain(other.replicaId);
  expect(requests).toEqual([]);
  expect(resolve).not.toHaveBeenCalled();
  expect(result.error?.suggestion).toMatch(/(?:if|only|requires|needs).*4\.5\.0/i);
  expect(result.error?.suggestion).toMatch(/cannot be undone/i);
  expect(snapshot(owner)).toEqual(before);
});

it('failed credential resolution preserves its cause and prescribes no irreversible cut', async () => {
  const { owner, other } = await copies();
  const resolve = await referee('4.5.1');
  resolve.mockResolvedValue({
    success: false,
    error: { code: 'OWNED_SIGN_IN_FAILURE', message: 'No key for this project.' },
  });
  const before = snapshot(owner);
  const result = await share(owner, true);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain(other.replicaId);
  expect(result.error?.suggestion).toMatch(/Keep sharing (?:it )?directly/i);
  expect(result.error?.suggestion).not.toContain('reasonbook set-aside');
  expect(JSON.stringify(result.error?.currentState)).toContain('OWNED_SIGN_IN_FAILURE');
  expect(requests).toEqual([]);
  expect(snapshot(owner)).toEqual(before);
});

it('a missing dashboard project ID gives no unsupported cut or capability request', async () => {
  const { owner, other } = await copies();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(client.execute("DELETE FROM metadata WHERE key = 'dashboard_project_id'").success).toBe(
      true
    );
  });
  const resolve = await referee('4.5.1');
  const before = snapshot(owner);
  const result = await share(owner, true);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain(other.replicaId);
  expect(result.error?.suggestion).toMatch(/Keep sharing (?:it )?directly/i);
  expect(result.error?.suggestion).not.toContain('reasonbook set-aside');
  expect(resolve).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(snapshot(owner)).toEqual(before);
});

it('MCP share confirmation consults the referee with both sharing switches unset and mutates nothing', async () => {
  const { owner, other } = await copies();
  await referee('4.3.0');
  useMachine(fixture.tmp, owner.machine);
  const before = snapshot(owner);
  const result = await call('rbook_project', {
    action: 'share',
    via: 'dashboard',
    confirm: true,
    projectRoot: owner.root,
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain(other.replicaId);
  expect(requests).toEqual(['GET /api/projects/me']);
  expect(result.error?.suggestion).toMatch(/Keep sharing (?:it )?directly/i);
  expect(result.error?.suggestion).not.toContain('reasonbook set-aside');
  expect(result.error).toMatchObject({
    currentState: {
      reason: 'owner-copies',
      replicaId: other.replicaId,
      dashboardProjectId: projectId,
      refereeVersion: '4.3.0',
    },
  });
  expect(snapshot(owner)).toEqual(before);
});

it('the actual CLI prints the whole supported command and its confirmation qualification', async () => {
  const { owner, other } = await copies();
  await referee('4.5.1');
  useMachine(fixture.tmp, owner.machine);
  const before = snapshot(owner);
  const output: string[] = [];
  const errors: string[] = [];
  const exit = await runShare(['--dashboard', '--yes', '--project-root', owner.root], {
    env: process.env,
    cwd: owner.root,
    readStdin: async () => '',
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  });
  expect(exit).toBe(1);
  expect(output).toEqual([]);
  expect(errors).toHaveLength(1);
  supportedRemedy(errors[0], other.replicaId);
  expect(errors[0]).not.toContain('…');
  expect(errors[0]).not.toContain('[object Object]');
  expect(requests).toEqual(['GET /api/projects/me']);
  expect(snapshot(owner)).toEqual(before);
});

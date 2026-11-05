// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises the current-build runner through real MCP stdio in a temporary checkout.
// ABOUTME: A mutation reaches the child only after verified build health, and every child is closed.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { harnessSessionHash, linkHarness } from '../../src/tools/rbook/harness-session';
import { seedRbookDb } from '../helpers/seedRbookDb';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'rbook-call-current.js');
const SERVER = `
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
if (process.env.CURRENT_CALL_MODE === 'session-owner') {
  require(process.env.CURRENT_CALL_SOURCE_ROOT + '/tests/helpers/ts-register.js');
}
const log = (event) => fs.appendFileSync(process.env.CURRENT_CALL_LOG, JSON.stringify(event) + '\\n');
log({ event: 'start', pid: process.pid, cmosConfigDir: process.env.CMOS_CONFIG_DIR ?? null });
// s109-m04 (#799): a close's upload, driven through the registry's own functions on a timetable.
const MODE = String(process.env.CURRENT_CALL_MODE);
const upload = MODE.startsWith('upload-') ? (() => {
  require(process.env.CURRENT_CALL_SOURCE_ROOT + '/tests/helpers/ts-register.js');
  const state = require(process.env.CURRENT_CALL_SOURCE_ROOT + '/src/intelligence/project-upload-state.ts');
  const Database = require('better-sqlite3');
  const id = process.env.CURRENT_CALL_PROJECT_ID;
  const run = (step) => {
    const db = new Database(process.env.CURRENT_CALL_REGISTRY);
    try { return step(db); } finally { db.close(); }
  };
  return {
    mark: (explicit, at = Date.now()) => run((db) => state.markUploadOwed(db, id, at, explicit)),
    claim: (explicit) => run((db) => state.claimUpload(db, id, Date.now(), explicit)),
    finish: (lease, outcome) => run((db) => state.finishUpload(db, id, lease, Date.now(), outcome)),
    reregister: () => run((db) => {
      const row = db.prepare('SELECT store_path, name FROM projects WHERE project_id = ?').get(id);
      db.prepare('DELETE FROM projects WHERE project_id = ?').run(id);
      db.prepare('INSERT INTO projects (project_id, store_path, name, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, row.store_path, row.name, Date.now(), Date.now());
    }),
  };
})() : null;
const later = (ms, step) => setTimeout(() => {
  try { step(); } catch (error) { log({ event: 'fixture-error', message: String(error) }); }
}, ms);
if (upload) process.stdin.on('end', () => log({ event: 'stdin-end' }));
let autoLease = null;
const FAILED = { success: false, error: 'File sync failed: HTTP 500' };
function startUpload() {
  if (MODE === 'upload-delivered') {
    upload.mark(true);
    const lease = upload.claim(true);
    later(1200, () => { upload.finish(lease, { success: true }); log({ event: 'upload-finished' }); });
  } else if (MODE === 'upload-old-marker') {
    later(300, () => { const lease = upload.claim(false); upload.finish(lease, { success: true }); });
  } else if (MODE === 'upload-auto-lease-success' || MODE === 'upload-auto-lease-failure') {
    upload.mark(true);
    later(300, () => {
      upload.finish(autoLease, { success: true });
      const lease = upload.claim(true);
      later(600, () => upload.finish(lease, MODE.endsWith('success') ? { success: true } : FAILED));
    });
  } else if (MODE === 'upload-fails') {
    upload.mark(true);
    const lease = upload.claim(true);
    later(300, () => upload.finish(lease, FAILED));
  } else if (MODE === 'upload-latest-write') {
    upload.mark(true);
    const lease = upload.claim(true);
    upload.mark(false);
    later(300, () => upload.finish(lease, FAILED));
  } else if (MODE === 'upload-reregistered') {
    upload.mark(true);
    upload.claim(true);
    later(300, () => upload.reregister());
  } else if (MODE === 'upload-reregistered-climbs') {
    // Critic B, F1: ordinary writes bring the new row back to the close's mark.
    upload.mark(true);
    upload.claim(true);
    later(300, () => { upload.reregister(); upload.mark(false); });
  } else if (MODE === 'upload-success-below-mark') {
    // Verifier B, round 2, N2: only the generation rule decides this: a success on the row registered
    // again, claimed below the close's mark.
    upload.mark(false);
    upload.mark(true);
    upload.claim(true);
    later(300, () => {
      upload.reregister();
      upload.mark(true);
      upload.finish(upload.claim(true), { success: true });
    });
  } else if (MODE === 'upload-busy-after-mark' || MODE === 'upload-busy-window') {
    // N5: a lock after the mark is seen is read past; N6: one through the window says so.
    const afterMark = MODE === 'upload-busy-after-mark';
    const lease = afterMark ? (upload.mark(true), upload.claim(true)) : null;
    later(afterMark ? 800 : 0, () => {
      const Database = require('better-sqlite3');
      const holder = new Database(process.env.CURRENT_CALL_REGISTRY);
      holder.pragma('locking_mode = EXCLUSIVE');
      holder.exec('BEGIN EXCLUSIVE');
      holder.prepare('UPDATE projects SET last_seen_at = last_seen_at WHERE project_id = ?').run(process.env.CURRENT_CALL_PROJECT_ID);
      later(afterMark ? 1500 : 3000, () => {
        holder.exec('COMMIT');
        holder.close();
        log({ event: 'registry-released' });
        if (lease) later(500, () => upload.finish(lease, { success: true }));
      });
    });
  } else if (MODE === 'upload-late-mark') {
    // This case advances at actual registry reads, so load cannot hide a short-lived mark.
    log({ event: 'late-upload-ready' });
  } else if (MODE === 'upload-exit-before-mark') {
    later(300, () => process.exit(0));
  } else if (MODE === 'upload-busy') {
    // The registry held so readers cannot read it for a while, then the upload succeeds.
    upload.mark(true);
    const lease = upload.claim(true);
    const Database = require('better-sqlite3');
    const holder = new Database(process.env.CURRENT_CALL_REGISTRY);
    holder.pragma('locking_mode = EXCLUSIVE');
    holder.exec('BEGIN EXCLUSIVE');
    holder.prepare('UPDATE projects SET last_seen_at = last_seen_at WHERE project_id = ?').run(process.env.CURRENT_CALL_PROJECT_ID);
    later(1500, () => {
      holder.exec('COMMIT');
      holder.close();
      log({ event: 'registry-released' });
      // Released with the mark still set, so a read after the lock can see it.
      later(1000, () => upload.finish(lease, { success: true }));
    });
  } else if (MODE === 'upload-between-polls') {
    upload.mark(true);
    later(700, () => { const lease = upload.claim(true); upload.finish(lease, { success: true }); });
  } else if (MODE === 'upload-child-exits') {
    upload.mark(true);
    upload.claim(true);
    later(300, () => process.exit(0));
  }
}
process.on('exit', () => log({ event: 'exit' }));
if (process.env.CURRENT_CALL_MODE === 'drain') {
  process.on('SIGTERM', () => { log({ event: 'signal' }); process.exit(0); });
  process.stdin.on('end', () => {
    log({ event: 'draining' });
    setTimeout(() => { log({ event: 'drained' }); process.exit(0); }, 3000);
  });
}
serveStdio(() => {
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/call', async ({ params }) => {
  const owner = process.env.CURRENT_CALL_MODE === 'session-owner'
    ? require(process.env.CURRENT_CALL_SOURCE_ROOT + '/src/tools/rbook/session-owner.ts')
        .currentSessionOwner(require('path').join(params.arguments.projectRoot, 'rbook/db/rbook.sqlite'))
    : undefined;
  log({ event: 'call', name: params.name, args: params.arguments, owner });
  if (params.name === 'rbook_agent_onboard' && MODE === 'upload-old-marker') upload.mark(true);
  if (params.name === 'rbook_agent_onboard' && MODE.startsWith('upload-auto-lease')) {
    upload.mark(false, Date.now() - 3600000);
    autoLease = upload.claim(false);
  }
  if (params.name === 'rbook_agent_onboard') {
    const mode = process.env.CURRENT_CALL_MODE;
    const health = {
      codeIsCurrent: mode !== 'stale',
      startupBuild: mode === 'missing' ? null : { buildHash: 'current-build' },
      currentBuild: { buildHash: mode === 'mismatch' ? 'other-build' : 'current-build' },
    };
    if (mode === 'empty-hash') health.startupBuild.buildHash = health.currentBuild.buildHash = '';
    if (mode === 'preflight-error') {
      return { isError: true, content: [{ type: 'text', text: 'Onboard refused' }] };
    }
    return { content: [], structuredContent: { success: true, data: { serverHealth: health } } };
  }
  if (upload) {
    startUpload();
    log({ event: 'upload-response', at: Date.now() });
    return { content: [], structuredContent: { success: true, data: { dashboardUpload: { started: true } } } };
  }
  if (process.env.CURRENT_CALL_MODE === 'transport-error') process.exit(0);
  if (process.env.CURRENT_CALL_MODE === 'refusal') {
    return { content: [], structuredContent: { success: false, error: { code: 'REFUSED', message: 'No mutation' } } };
  }
  if (process.env.CURRENT_CALL_MODE === 'unstructured') {
    return { content: [{ type: 'text', text: 'unstructured receipt' }] };
  }
  if (owner) return { content: [], structuredContent: { success: true, data: { owner } } };
  return { content: [], structuredContent: { success: true, data: { marker: process.env.CURRENT_CALL_MARKER } } };
});
return server;
}, { legacy: 'serve' });
`;

let checkout: string;
let logPath: string;
let script: string;

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-call-current-'));
  logPath = path.join(checkout, 'calls.jsonl');
  fs.mkdirSync(path.join(checkout, 'scripts'));
  fs.mkdirSync(path.join(checkout, 'dist'));
  script = path.join(checkout, 'scripts', 'rbook-call-current.js');
  fs.copyFileSync(SCRIPT, script);
  fs.writeFileSync(path.join(checkout, 'dist', 'index.js'), SERVER);
  // The helper reads the registry with the server's own modules, which the built dist holds.
  fs.mkdirSync(path.join(checkout, 'dist', 'intelligence'));
  for (const name of ['legacy-compat', 'project-upload-reader']) {
    const target = path.join(checkout, 'dist', 'intelligence', `${name}.js`);
    fs.writeFileSync(
      target,
      `require(${JSON.stringify(path.join(ROOT, 'tests/helpers/ts-register.js'))});\n` +
        `module.exports = require(${JSON.stringify(path.join(ROOT, `src/intelligence/${name}.ts`))});\n`
    );
    if (name === 'project-upload-reader')
      fs.appendFileSync(
        target,
        String.raw`
if (process.env.CURRENT_CALL_MODE === 'upload-late-mark') {
  const fs = require('fs');
  const reader = module.exports;
  const upload = require(${JSON.stringify(path.join(ROOT, 'src/intelligence/project-upload-state.ts'))});
  const Database = require('better-sqlite3');
  const log = (event) => fs.appendFileSync(process.env.CURRENT_CALL_LOG, JSON.stringify(event) + '\n');
  const write = (step) => {
    const registry = new Database(process.env.CURRENT_CALL_REGISTRY);
    try { step(registry); } finally { registry.close(); }
  };
  let phase = 0;
  let lease;
  module.exports = { ...reader, readUploadState(db, id) {
    const observed = reader.readUploadState(db, id);
    if (phase === 0 && fs.readFileSync(process.env.CURRENT_CALL_LOG, 'utf8').includes('"event":"late-upload-ready"')) {
      log({ event: 'late-mark-first-poll', explicitGeneration: observed?.explicitGeneration });
      write((registry) => {
        upload.markUploadOwed(registry, id, Date.now(), true);
        lease = upload.claimUpload(registry, id, Date.now(), true);
      });
      phase = 1;
      log({ event: 'late-mark-created' });
    } else if (phase === 1 && observed?.explicitGeneration != null) {
      log({ event: 'late-mark-observed' });
      write((registry) => upload.finishUpload(registry, id, lease, Date.now(), { success: true }));
      phase = 2;
      log({ event: 'late-mark-delivered' });
    }
    return observed;
  } };
}
`
      );
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
});

afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

interface Report {
  status: number | null;
  stdout: string;
  stderr: string;
  finishedAt: number;
}

function run(request: unknown, mode = 'fresh', env: NodeJS.ProcessEnv = {}): Promise<Report> {
  return new Promise((resolve, reject) => {
    const merged: NodeJS.ProcessEnv = {
      ...process.env,
      CURRENT_CALL_LOG: logPath,
      CURRENT_CALL_MODE: mode,
      CURRENT_CALL_MARKER: 'preserved environment',
      CURRENT_CALL_SOURCE_ROOT: ROOT,
      RBOOK_CONFIG_DIR: path.join(checkout, 'config'),
      CLAUDE_CODE_SESSION_ID: '',
      ...env,
    };
    // An undefined value removes the variable (the legacy-folder registry needs no RBOOK_CONFIG_DIR).
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    const child = spawn(process.execPath, [script], { cwd: os.tmpdir(), env: merged });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, finishedAt: Date.now() }));
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

function events(): Array<{
  event: string;
  at?: number;
  name?: string;
  pid?: number;
  args?: unknown;
  owner?: { key: string; kind: string };
}> {
  return fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}

function uploadElapsed(report: Report): number {
  const receipts = events().filter((event) => event.event === 'upload-response');
  expect(receipts).toHaveLength(1);
  expect(Number.isFinite(receipts[0].at)).toBe(true);
  // Exclude process startup, module loading and preflight, but retain response delivery,
  // the upload observation window and child shutdown in the same real-clock budget.
  const duration = report.finishedAt - receipts[0].at!;
  expect(duration).toBeGreaterThanOrEqual(0);
  return duration;
}

function request(): { name: string; arguments: { projectRoot: string; notes: string } } {
  return {
    name: 'rbook_mutation_fixture',
    arguments: { projectRoot: checkout, notes: 'literal $(do-not-execute) `text`' },
  };
}

function expectClosed(): void {
  const recorded = events();
  expect(recorded[recorded.length - 1]?.event).toBe('exit');
  const pid = recorded.find((event) => event.event === 'start')?.pid;
  expect(pid).toBeDefined();
  expect(() => process.kill(pid!, 0)).toThrow();
}

describe('scripts/rbook-call-current.js', () => {
  it('joins both helper calls to the inherited Claude conversation through the real server owner resolver', async () => {
    seedRbookDb(checkout);
    const env = {
      RBOOK_CONFIG_DIR: path.join(checkout, 'config'),
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_SESSION_ID: 'helper-conversation',
    };
    linkHarness(env.CLAUDE_CODE_SESSION_ID, 'startup', checkout, env);
    const report = await run(request(), 'session-owner', env);
    expect(report.status).toBe(0);
    expect(events().filter((event) => event.event === 'call')).toEqual([
      expect.objectContaining({
        name: 'rbook_agent_onboard',
        owner: expect.objectContaining({ key: `ext:${harnessSessionHash('helper-conversation')}` }),
      }),
      expect.objectContaining({
        name: 'rbook_mutation_fixture',
        owner: expect.objectContaining({ key: `ext:${harnessSessionHash('helper-conversation')}` }),
      }),
    ]);
    expectClosed();

    // /clear changes the hook link, while a shell can still carry its original inherited id.
    linkHarness('helper-after-clear', 'clear', checkout, env);
    const cleared = await run(request(), 'session-owner', env);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout).data.owner.key).toBe(
      `ext:${harnessSessionHash('helper-after-clear')}`
    );
  });

  it('keeps keyless Codex helper calls usable and does not borrow another project conversation', async () => {
    seedRbookDb(checkout);
    seedRbookDb(path.join(checkout, 'other'));
    const env = {
      RBOOK_CONFIG_DIR: path.join(checkout, 'config'),
      CLAUDE_PID: String(process.pid),
    };
    linkHarness('another-project-session', 'startup', path.join(checkout, 'other'), env);
    for (const session of ['', 'another-project-session']) {
      const report = await run(request(), 'session-owner', {
        ...env,
        CLAUDE_CODE_SESSION_ID: session,
      });
      expect(report.status).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        success: true,
        data: { owner: { kind: 'process', key: expect.stringMatching(/^pid:/) } },
      });
    }
  });

  it('R11 lets the server finish its three-second stdin drain without a termination signal', async () => {
    const report = await run(request(), 'drain');
    expect(report.status).toBe(0);
    expect(events().map((event) => event.event)).toEqual([
      'start',
      'call',
      'call',
      'draining',
      'drained',
      'exit',
    ]);
    expectClosed();
  });

  it('executes exactly once after verified health, preserving arguments and environment', async () => {
    const input = request();
    const report = await run(input);
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout)).toEqual({
      success: true,
      data: { marker: 'preserved environment' },
    });
    expect(events().filter((event) => event.event === 'start')).toHaveLength(1);
    expect(events().filter((event) => event.event === 'call')).toEqual([
      { event: 'call', name: 'rbook_agent_onboard', args: { projectRoot: checkout } },
      { event: 'call', name: input.name, args: input.arguments },
    ]);
    expectClosed();
  });

  it.each(['stale', 'mismatch', 'missing', 'empty-hash', 'preflight-error'])(
    'blocks mutation and closes its child when preflight is %s',
    async (mode) => {
      const report = await run(request(), mode);
      expect(report.status).toBe(1);
      expect(JSON.parse(report.stdout).success).toBe(false);
      expect(
        events()
          .filter((event) => event.event === 'call')
          .map((event) => event.name)
      ).toEqual(['rbook_agent_onboard']);
      expectClosed();
    }
  );

  it.each([
    { name: 'rbook_mutation_fixture', arguments: {} },
    { name: 'rbook_mutation_fixture', arguments: { projectRoot: ' ' } },
    { name: 'rbook_mutation_fixture', arguments: [] },
    { arguments: { projectRoot: '/explicit' } },
    '{broken JSON',
  ])('rejects malformed or unscoped input before spawning', async (input) => {
    const report = await run(input);
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout).success).toBe(false);
    expect(events()).toEqual([]);
  });

  it('prints a structured tool refusal and returns failure instead of success', async () => {
    const report = await run(request(), 'refusal');
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout)).toEqual({
      success: false,
      error: { code: 'REFUSED', message: 'No mutation' },
    });
    expectClosed();
  });

  it('retains the full response when the tool has no structured payload', async () => {
    const report = await run(request(), 'unstructured');
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout)).toEqual({
      content: [{ type: 'text', text: 'unstructured receipt' }],
    });
    expectClosed();
  });

  it('fails loudly if the transport closes before a receipt arrives', async () => {
    const report = await run(request(), 'transport-error');
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout).success).toBe(false);
    expectClosed();
  });
});

/**
 * s109-m04 (#799; settled item 11). The helper ended stdin as soon as a close answered, so the
 * server's 20-second drain interrupted a 38 MB upload at today's sizes, and the next process sent the
 * store again. A close whose answer says its upload started now keeps the server alive until the
 * upload it marked is seen delivered, for at most 120 s, keyed on the registry's upload generations,
 * and says on stderr what it saw; the last recorded outcome is information only.
 */
describe('s109-m04 (#799): a close’s upload is reported by the generation it marked', () => {
  const PROJECT = 'call-current-upload';
  const WAIT = { RBOOK_CALL_UPLOAD_CAP_MS: '3000', RBOOK_CALL_UPLOAD_MARK_MS: '1500' };

  /** The project, registered in `configDir`'s registry; the fixture drives the same file. */
  async function registered(configDir: string, withRow = true): Promise<NodeJS.ProcessEnv> {
    seedRbookDb(checkout, { projectId: PROJECT, projectName: 'Call current' });
    const graph = await ProjectGraphRegistry.create({ configDir, ephemeralRoots: [] });
    if (withRow)
      graph.register({ project_id: PROJECT, store_path: checkout, name: 'Call current' });
    ProjectGraphRegistry.resetInstance();
    return {
      ...WAIT,
      CURRENT_CALL_PROJECT_ID: PROJECT,
      CURRENT_CALL_REGISTRY: path.join(configDir, 'project-graph.sqlite'),
    };
  }
  const reported = (report: Report): string =>
    report.stderr.split('\n').find((line) => line.startsWith('Dashboard upload: ')) ?? '';
  const order = (): string[] => events().map((event) => event.event);

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    // Every timed step ran: a step that threw would leave its case passing for the wrong reason.
    expect(events().filter((event) => event.event === 'fixture-error')).toEqual([]);
  });

  it('the close’s explicit claim lands before the first read and succeeds: delivered, the server kept alive until then', async () => {
    const report = await run(
      request(),
      'upload-delivered',
      await registered(path.join(checkout, 'config'))
    );
    expect(report.status).toBe(0);
    // stdout is unchanged: the close's receipt, and only it.
    expect(JSON.parse(report.stdout)).toEqual({
      success: true,
      data: { dashboardUpload: { started: true } },
    });
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expect(order().indexOf('upload-finished')).toBeGreaterThan(-1);
    expect(order().indexOf('upload-finished')).toBeLessThan(order().indexOf('stdin-end'));
    expectClosed();
  });

  it('an automatic upload that clears an older explicit marker is never this close’s: no upload observed', async () => {
    const report = await run(
      request(),
      'upload-old-marker',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: no upload observed/);
    expect(reported(report)).not.toContain('delivered');
    expectClosed();
  });

  it.each([
    ['success', /^Dashboard upload: delivered/],
    [
      'failure',
      /^Dashboard upload: not confirmed within 3 s.*failed \(File sync failed: HTTP 500\)/,
    ],
  ])(
    'an automatic lease held when the close answers, then the close’s own claim: %s',
    async (outcome, expected) => {
      const report = await run(
        request(),
        `upload-auto-lease-${outcome}`,
        await registered(path.join(checkout, 'config'))
      );
      expect(reported(report)).toMatch(expected);
      expectClosed();
    }
  );

  it('the close’s attempt fails and its mark stays to the cap: not confirmed, with the last error as information', async () => {
    const report = await run(
      request(),
      'upload-fails',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed within 3 s/);
    expect(reported(report)).toContain('by any process: failed (File sync failed: HTTP 500)');
    expectClosed();
  });

  it('the close’s own write moves the latest write past its claim, and the attempt fails: not confirmed', async () => {
    const report = await run(
      request(),
      'upload-latest-write',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed/);
    expectClosed();
  });

  it('a registry with no row for the project: not observed', async () => {
    const report = await run(
      request(),
      'upload-no-row',
      await registered(path.join(checkout, 'config'), false)
    );
    expect(reported(report)).toMatch(
      /^Dashboard upload: not observed — the registry has no row for this project/
    );
    expectClosed();
  });

  it('a row deleted and registered again during the wait is never delivered', async () => {
    const report = await run(
      request(),
      'upload-reregistered',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed/);
    expectClosed();
  });

  it('a claim and release between two polls is found through the marker: delivered', async () => {
    const report = await run(
      request(),
      'upload-between-polls',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });

  it('no explicit mark above the generation read before the call: no upload observed', async () => {
    const report = await run(
      request(),
      'upload-no-mark',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: no upload observed/);
    expectClosed();
  });

  it('the server exiting stops the wait at once: not confirmed', async () => {
    const env = await registered(path.join(checkout, 'config'));
    const started = Date.now();
    const report = await run(request(), 'upload-child-exits', {
      ...env,
      RBOOK_CALL_UPLOAD_CAP_MS: '20000',
    });
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed — the server exited/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expectClosed();
  });

  it('a row deleted, registered again and written back up to the mark is never delivered (critic B, F1)', async () => {
    const report = await run(
      request(),
      'upload-reregistered-climbs',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed within 3 s/);
    expectClosed();
  });

  it('a mark that appears after the first poll is still the close’s: delivered', async () => {
    const report = await run(
      request(),
      'upload-late-mark',
      await registered(path.join(checkout, 'config'))
    );
    expect(report.status).toBe(0);
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    // The fixture must prove the ordering this case names, even when CPU pressure delays a poll.
    expect(order().filter((event) => event.startsWith('late-mark-'))).toEqual([
      'late-mark-first-poll',
      'late-mark-created',
      'late-mark-observed',
      'late-mark-delivered',
    ]);
    expect(events().find((event) => event.event === 'late-mark-first-poll')).toMatchObject({
      explicitGeneration: null,
    });
    expectClosed();
  });

  it('the server exiting before any mark stops the wait at once: no upload observed', async () => {
    const env = await registered(path.join(checkout, 'config'));
    const report = await run(request(), 'upload-exit-before-mark', {
      ...env,
      RBOOK_CALL_UPLOAD_MARK_MS: '8000',
    });
    expect(reported(report)).toMatch(
      /^Dashboard upload: no upload observed — .* before the server exited/
    );
    const elapsed = uploadElapsed(report);
    expect(elapsed).toBeLessThan(6000);
    expectClosed();
  });

  it('no mark ends the wait at the mark window, not at the cap', async () => {
    const env = await registered(path.join(checkout, 'config'));
    const report = await run(request(), 'upload-no-mark', {
      ...env,
      RBOOK_CALL_UPLOAD_CAP_MS: '20000',
    });
    expect(reported(report)).toMatch(/^Dashboard upload: no upload observed — .* within 1\.5 s/);
    const elapsed = uploadElapsed(report);
    expect(elapsed).toBeLessThan(10_000);
    expectClosed();
  });

  it('a registry no reader can open for a while is read again, not taken as the outcome', async () => {
    const env = await registered(path.join(checkout, 'config'));
    // Stopping at the first failed read reads "not observed — … database is locked" here.
    const report = await run(request(), 'upload-busy', {
      ...env,
      RBOOK_CALL_UPLOAD_MARK_MS: '8000',
    });
    expect(order()).toContain('registry-released');
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });

  it('a success claimed below the close’s mark, on a row registered again, is not credited (round 2, N2)', async () => {
    const report = await run(
      request(),
      'upload-success-below-mark',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(/^Dashboard upload: not confirmed within 3 s.*success\./);
    expectClosed();
  });

  it('a registry locked after the mark is seen is read again until the upload is delivered (round 2, N5)', async () => {
    const env = await registered(path.join(checkout, 'config'));
    const report = await run(request(), 'upload-busy-after-mark', {
      ...env,
      RBOOK_CALL_UPLOAD_CAP_MS: '8000',
    });
    expect(order()).toContain('registry-released');
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });

  it('a registry no read can open through the mark window says so, not that it has no row (round 2, N6)', async () => {
    const report = await run(
      request(),
      'upload-busy-window',
      await registered(path.join(checkout, 'config'))
    );
    expect(reported(report)).toMatch(
      /^Dashboard upload: not observed — the registry could not be read: database is locked\./
    );
    expectClosed();
  });

  it('a config folder only the checkout’s .env names is read as the server reads it (round 2, N3)', async () => {
    const folder = path.join(checkout, 'from-env-file');
    const env = await registered(folder);
    fs.writeFileSync(path.join(checkout, '.env'), `RBOOK_CONFIG_DIR=${folder}\n`);
    const report = await run(request(), 'upload-delivered', {
      ...env,
      RBOOK_CONFIG_DIR: undefined,
    });
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });

  it('an empty legacy CMOS_CONFIG_DIR reaches the server unchanged, so its .env still fills it (round 2, N1)', async () => {
    const folder = path.join(checkout, 'legacy-from-env-file');
    const env = await registered(folder);
    fs.writeFileSync(path.join(checkout, '.env'), `CMOS_CONFIG_DIR=${folder}\n`);
    const report = await run(request(), 'upload-delivered', {
      ...env,
      RBOOK_CONFIG_DIR: undefined,
      CMOS_CONFIG_DIR: '',
    });
    // The server got the caller's empty value, which its .env loader fills; the helper read that folder.
    expect(events().find((event) => event.event === 'start')).toMatchObject({ cmosConfigDir: '' });
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expect(fs.existsSync(path.join(checkout, 'project-graph.sqlite'))).toBe(false);
    expectClosed();
  });

  it.each([
    [
      'a relative legacy CMOS_CONFIG_DIR',
      'relcmos',
      { RBOOK_CONFIG_DIR: undefined, CMOS_CONFIG_DIR: 'relcmos' },
    ],
    ['an empty RBOOK_CONFIG_DIR', '', { RBOOK_CONFIG_DIR: '' }],
  ] as const)(
    '%s is read in the checkout, where the server runs (round 2, N4)',
    async (_what, folder, vars) => {
      const env = await registered(path.join(checkout, folder));
      const report = await run(request(), 'upload-delivered', { ...env, ...vars });
      expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
      expectClosed();
    }
  );

  it('a relative RBOOK_CONFIG_DIR is read where the server runs, in the checkout (critic B, F2)', async () => {
    const env = await registered(path.join(checkout, 'relcfg'));
    // run() starts the helper in os.tmpdir(), so a relative folder there would be another one.
    const report = await run(request(), 'upload-delivered', { ...env, RBOOK_CONFIG_DIR: 'relcfg' });
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });

  it('finds the registry in the legacy config folder when RBOOK_CONFIG_DIR is unset', async () => {
    const home = path.join(checkout, 'home');
    const env = await registered(path.join(home, '.config', 'cmos-mcp'));
    const report = await run(request(), 'upload-delivered', {
      ...env,
      HOME: home,
      RBOOK_CONFIG_DIR: undefined,
    });
    expect(reported(report)).toMatch(/^Dashboard upload: delivered/);
    expectClosed();
  });
});

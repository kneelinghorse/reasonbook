// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m01 — close measures 11 (misuse refusals by tool, action and refused field) and 12
// ABOUTME: (identity lookups over 100 ms), each with the anonymous bucket beside it as a bound.

import { afterEach, beforeEach, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runStats } from '../../src/cli/stats';
import { settingNames } from '../../src/intelligence/legacy-compat';
import {
  appendTelemetry,
  targetForStore,
  unattributedTarget,
  type TelemetryRecord,
  type TelemetryTarget,
} from '../../src/tools/rbook/local-telemetry';
import { collectTelemetryStats, exportTelemetryStats } from '../../src/tools/rbook/telemetry-stats';
import { seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let root: string;
let env: NodeJS.ProcessEnv;
let store: TelemetryTarget;
let now: number;
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const window = () => ({
  since: iso(now - 2 * day),
  until: iso(now),
  baselineSince: iso(now - 45 * day),
  baselineUntil: iso(now - 15 * day),
});

beforeEach(() => {
  now = Date.now();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-stats-misuse-'));
  root = path.join(tmp, 'private-project-name');
  store = targetForStore(seedRbookDb(root, { projectName: 'private-project-name' }))!;
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: '' };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** One MCP row as s106-m01 writes it. A legacy row passes `undefined` for both instruments. */
function row(target: TelemetryTarget, partial: Partial<TelemetryRecord> = {}): void {
  appendTelemetry(
    {
      ts: iso(now - 60_000),
      session: 'aaaaaaaaaaaaaaaa',
      surface: 'mcp',
      client: 'test/1',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
      ok: true,
      refused: null,
      failOpen: null,
      ambient: null,
      lookupMs: 3,
      refusedField: null,
      ...partial,
    },
    target,
    env
  );
}
const refusal = (refused: string, refusedField: string | undefined) => ({
  ok: false,
  refused,
  refusedField,
});
const legacy = { lookupMs: undefined, refusedField: undefined };

it('counts misuse refusals by tool, action and refused field over the inclusive close window', async () => {
  const w = window();
  row(store);
  row(store, refusal('INVALID_PARAMETER', 'content'));
  row(store, refusal('INVALID_PARAMETER', 'content'));
  // A legacy name counts as today's tool, so a rename never splits one tool's misuse in two.
  row(store, { tool: 'cmos_mission', action: 'add', ...refusal('MISSING_PARAMETER', 'missionId') });
  // An action the tool does not publish is the agent's own text, so it is counted as unknown.
  row(store, { action: 'privateaction', ...refusal('INVALID_ACTION', 'action') });
  row(store, { tool: 'rbook_privatetool', ...refusal('INVALID_PARAMETER', 'unspecified') });
  // A stored field the tool does not publish counts as unspecified, whatever code wrote it, and a
  // name only another tool publishes (rbook_learnings' category) is not this tool's parameter.
  row(store, refusal('MISSING_PARAMETER', 'privatefield'));
  row(store, refusal('MISSING_PARAMETER', 'category'));
  // Both bounds are inclusive; a millisecond outside either is not in the window.
  row(store, { ts: w.since, ...refusal('INVALID_PARAMETER', 'unknown') });
  row(store, { ts: w.until, ...refusal('INVALID_PARAMETER', 'unknown') });
  row(store, { ts: iso(Date.parse(w.since) - 1), ...refusal('INVALID_PARAMETER', 'unknown') });
  row(store, { ts: iso(Date.parse(w.until) + 1), ...refusal('INVALID_PARAMETER', 'unknown') });
  // Refusals that are not misuse, and rows from other surfaces, are not counted.
  row(store, refusal('DECISION_NOT_FOUND', 'unspecified'));
  row(store, {
    surface: 'hook',
    tool: 'hook prompt',
    action: null,
    ...refusal('INVALID_PARAMETER', 'content'),
  });
  // A row written before s106-m01 still counts as misuse; only its field is unmeasured.
  row(store, {
    tool: 'rbook_session',
    action: 'capture',
    ...refusal('INVALID_PARAMETER', undefined),
    ...legacy,
  });
  const anonymous = unattributedTarget(env);
  row(anonymous, { action: null, lookupMs: null, ...refusal('INVALID_PARAMETER', 'unknown') });
  row(anonymous, { lookupMs: null });

  const report = await collectTelemetryStats([root], w, env);
  const exported = exportTelemetryStats(report);
  expect(exported.misuse).toEqual({
    available: true,
    rows: 12,
    refusals: 10,
    unmeasuredField: 1,
    byField: [
      { tool: 'rbook_decisions', action: 'record', refusedField: 'content', refusals: 2 },
      { tool: 'rbook_decisions', action: 'record', refusedField: 'unknown', refusals: 2 },
      { tool: 'rbook_decisions', action: 'record', refusedField: 'unspecified', refusals: 2 },
      { tool: 'rbook_decisions', action: 'unknown', refusedField: 'action', refusals: 1 },
      { tool: 'rbook_mission', action: 'add', refusedField: 'missionId', refusals: 1 },
      { tool: 'rbook_session', action: 'capture', refusedField: null, refusals: 1 },
      { tool: 'unknown', action: 'unknown', refusedField: 'unspecified', refusals: 1 },
    ],
    anonymous: {
      available: true,
      rows: 2,
      refusals: 1,
      unmeasuredField: 0,
      byField: [{ tool: 'rbook_decisions', action: null, refusedField: 'unknown', refusals: 1 }],
    },
  });
  // The counting rules travel with the numbers.
  expect(Object.keys(exported.rules)).toEqual(
    expect.arrayContaining(['misuse', 'lookups', 'anonymousBound'])
  );
  const json = JSON.stringify(exported);
  for (const secret of ['private', root]) expect(json).not.toContain(secret);
});

it('counts lookups over 100 ms and keeps unmeasured and lookup-free rows out of the denominator', async () => {
  for (const lookupMs of [3, 100, 101, 4999]) row(store, { lookupMs });
  row(store, { lookupMs: null });
  row(store, legacy);
  const anonymous = unattributedTarget(env);
  // A lookup that ran out its budget and filed its row here is the bound's evidence.
  row(anonymous, { lookupMs: 5003 });
  row(anonymous, { lookupMs: null });

  const exported = exportTelemetryStats(await collectTelemetryStats([root], window(), env));
  expect(exported.lookups).toEqual({
    available: true,
    rows: 6,
    measured: 4,
    noLookup: 1,
    unmeasured: 1,
    over100: 2,
    maxMs: 4999,
    anonymous: {
      available: true,
      rows: 2,
      measured: 1,
      noLookup: 1,
      unmeasured: 0,
      over100: 1,
      maxMs: 5003,
    },
  });
});

it('reports a window of legacy rows as unmeasured, never as a measured zero', async () => {
  row(store, { ...legacy, ...refusal('INVALID_PARAMETER', undefined) });
  row(store, legacy);
  const exported = exportTelemetryStats(await collectTelemetryStats([root], window(), env));
  expect(exported.lookups).toMatchObject({ rows: 2, measured: 0, unmeasured: 2, maxMs: null });
  expect(exported.misuse).toMatchObject({ refusals: 1, unmeasuredField: 1 });
  // No anonymous row was ever written, so the bound is unavailable rather than a measured zero.
  expect(exported.misuse.anonymous).toMatchObject({ available: false, rows: 0 });
  expect(exported.lookups.anonymous).toMatchObject({ available: false, rows: 0 });
});

it("marks the store side unavailable when a pooled store's bucket was never written", async () => {
  // The other store has no telemetry at all; its zero is not a measured zero, so neither is the
  // pooled count.
  const other = path.join(tmp, 'other');
  seedRbookDb(other);
  row(store, refusal('MISSING_PARAMETER', 'decisionId'));
  const alone = exportTelemetryStats(await collectTelemetryStats([root], window(), env));
  expect(alone.misuse).toMatchObject({ available: true, refusals: 1 });
  const pooled = exportTelemetryStats(await collectTelemetryStats([root, other], window(), env));
  expect(pooled.misuse).toMatchObject({ available: false, refusals: 1 });
  expect(pooled.lookups).toMatchObject({ available: false, rows: 1 });
});

it('reads the anonymous bucket once, so pooling stores never multiplies its bound', async () => {
  const other = path.join(tmp, 'other');
  const otherStore = targetForStore(seedRbookDb(other))!;
  row(store, refusal('MISSING_PARAMETER', 'decisionId'));
  row(otherStore, refusal('MISSING_PARAMETER', 'decisionId'));
  row(unattributedTarget(env), { action: null, ...refusal('INVALID_PARAMETER', 'unknown') });
  const exported = exportTelemetryStats(await collectTelemetryStats([root, other], window(), env));
  expect(exported.misuse).toMatchObject({ rows: 2, refusals: 2 });
  expect(exported.misuse.anonymous).toMatchObject({ rows: 1, refusals: 1 });
  expect(exported.lookups.anonymous).toMatchObject({ rows: 1 });
});

it('reads the anonymous bucket from the explicit config directory when the environment names none', async () => {
  row(unattributedTarget(env), { action: null, ...refusal('INVALID_PARAMETER', 'unknown') });
  // A regression to process.env would read this test's own empty home instead.
  const names = [...settingNames('RBOOK_CONFIG_DIR'), 'HOME'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of settingNames('RBOOK_CONFIG_DIR')) delete process.env[name];
  process.env.HOME = path.join(tmp, 'home');
  let exported: ReturnType<typeof exportTelemetryStats>;
  try {
    exported = exportTelemetryStats(await collectTelemetryStats([root], window(), env));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(exported.misuse.anonymous).toMatchObject({ available: true, refusals: 1 });
});

it('prints both measures and their rules in the export the close reads', async () => {
  row(store, refusal('MISSING_PARAMETER', 'decisionId'));
  row(unattributedTarget(env), { action: null, ...refusal('INVALID_PARAMETER', 'unknown') });
  let stdout = '';
  const w = window();
  expect(
    await runStats(['--export', '--since', w.since, '--until', w.until], {
      cwd: root,
      env,
      readStdin: async () => '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    })
  ).toBe(0);
  const exported = JSON.parse(stdout);
  expect(exported.misuse).toMatchObject({ refusals: 1, anonymous: { refusals: 1 } });
  expect(exported.lookups).toMatchObject({ rows: 1, anonymous: { rows: 1 } });
  for (const rule of ['misuse', 'lookups', 'anonymousBound'])
    expect(typeof exported.rules[rule]).toBe('string');
  expect(stdout).not.toContain('private');
});

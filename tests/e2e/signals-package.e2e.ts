// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 (the signals contract's packaging) — a consumer of the packed tarball imports @aquex/reasonbook/signals under
// ABOUTME: the dashboard's compiler settings (module commonjs, node10 resolution), compiles with real types, and requires it.

/**
 * Why here: the tarball is what the dashboard installs, so the check runs against what npm packs
 * from the built dist/, in the e2e lane that builds first. The consumer's settings copy
 * referee-package.e2e.ts's, which are cmos-dashboard's own. `@ts-expect-error` lines prove the
 * types resolved: were they `any`, those directives would themselves fail the compile.
 */

import { afterAll, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installPackedArtifact } from './packed-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const CONSUMER = `import {
  buildBrief,
  classifyFeedback,
  computeSignals,
  FEEDBACK_KINDS,
  readSignals,
  renderBrief,
  SIGNAL_KINDS,
  SIGNAL_RULES,
  SIGNALS_SCHEMA,
  type Brief,
  type BriefSectionId,
  type ReadSignalsOptions,
  type SignalEntry,
  type SignalKind,
  type SignalsReport,
} from '@aquex/reasonbook/signals';

export function report(file: string, options: ReadSignalsOptions): SignalsReport {
  return readSignals(file, options);
}

export function counts(r: SignalsReport): Partial<Record<SignalKind, number | null>> {
  return Object.fromEntries(r.signals.map((entry: SignalEntry) => [entry.kind, entry.count]));
}

export const facts = {
  schema: SIGNALS_SCHEMA as 'rbook.signals/1',
  kinds: SIGNAL_KINDS as readonly string[],
  rule: SIGNAL_RULES.drafts_pending as string,
  frictionKinds: FEEDBACK_KINDS.map((kind) => kind.kind),
  sorted: classifyFeedback('cmos_review build-freshness warning').kind,
  compute: computeSignals,
};

export function brief(reports: SignalsReport[]): { text: string; data: Brief } {
  return { text: renderBrief(reports, { now: 0 }), data: buildBrief(reports, { now: 0, windowDays: 7 }) };
}

// @ts-expect-error a brief's section is one of the six
export const wrongSection: BriefSectionId = 'urgent';
// @ts-expect-error now is required: every rule runs at a given instant
export const noNow: ReadSignalsOptions = {};
// @ts-expect-error a signal's kind is one of the nine
export const wrongKind: SignalKind = 'drafts_waiting';
`;

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node10',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    noEmit: true,
    types: [],
  },
  include: ['src/**/*'],
};

it('compiles a consumer of the packed tarball under commonjs and node10, with real types, and requires it', () => {
  const artifact = installPackedArtifact(REPO_ROOT, mkTmp);
  fs.mkdirSync(path.join(artifact.hostDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(artifact.hostDir, 'src', 'use-signals.ts'), CONSUMER);
  fs.writeFileSync(path.join(artifact.hostDir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  const tsc = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', artifact.hostDir],
    { encoding: 'utf8' }
  );
  expect({ status: tsc.status, out: `${tsc.stdout}${tsc.stderr}` }).toEqual({ status: 0, out: '' });

  // At runtime Node resolves the subpath through exports; a store that is not there is reported
  // signal by signal, and loading the library starts no server.
  const now = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const s = require('@aquex/reasonbook/signals');
       const r = s.readSignals(${JSON.stringify(path.join(artifact.hostDir, 'none', 'rbook.sqlite'))}, { now: ${JSON.stringify(now)} });
       process.stdout.write(JSON.stringify({ schema: r.schema, library: r.library, computedAt: r.computedAt, kinds: r.signals.map((e) => e.kind), available: r.signals.some((e) => e.available) }));`,
    ],
    { cwd: artifact.hostDir, encoding: 'utf8', timeout: 60000 }
  );
  expect(probe.status).toBe(0);
  const version = (
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;
  expect(JSON.parse(probe.stdout)).toEqual({
    schema: 'rbook.signals/1',
    library: { name: '@aquex/reasonbook/signals', version },
    computedAt: now,
    kinds: [
      'drafts_pending',
      'next_steps_lapsing',
      'reviews_due',
      'superseded_cited',
      'missions_blocked',
      'feedback_open',
      'quiet_days',
      'constraints_expiring',
      'shared_conflicts',
    ],
    available: false,
  });
}, 600000);

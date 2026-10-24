// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A packed @aquex/reasonbook/signals consumer checks all declarations with modern module resolution.
// ABOUTME: Consumers install only Reasonbook; its public types must bring their own declaration dependencies.

/**
 * Compile the actual tarball with skipLibCheck: false under Node16 and bundler. The consumer
 * declares only Reasonbook, never @types/better-sqlite3; any required types must arrive through
 * the package's production dependencies. Negative checks reject accidental any exports.
 */

import { afterAll, beforeAll, expect, it } from '@jest/globals';
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
  unreadableReport,
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

export function compute(...args: Parameters<typeof computeSignals>): SignalsReport {
  return computeSignals(...args);
}

export const unreadable = unreadableReport({ now: 0, storePath: 'unused.sqlite',
  projectId: 'known-project', projectName: 'Known project' }, 'store unreadable');
// @ts-expect-error a supplied project id must stay typed, not widen to any
unreadableReport({ now: 0, storePath: 'unused.sqlite', projectId: 42 }, 'store unreadable');

// @ts-expect-error computeSignals requires an actual SQLite database handle
computeSignals({}, { now: 0, storePath: 'unused.sqlite' });

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

let artifact: ReturnType<typeof installPackedArtifact>;
beforeAll(() => {
  artifact = installPackedArtifact(REPO_ROOT, mkTmp);
}, 600000);

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: false,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    noEmit: true,
    types: [],
  },
  include: ['src/**/*'],
};

it.each(['node16', 'bundler'] as const)(
  '%s checks declarations and runtime',
  (resolution) => {
    const consumerPackage = JSON.parse(
      fs.readFileSync(path.join(artifact.hostDir, 'package.json'), 'utf8')
    );
    expect(Object.keys(consumerPackage.dependencies)).toEqual(['@aquex/reasonbook']);
    expect(consumerPackage.devDependencies).toBeUndefined();
    fs.mkdirSync(path.join(artifact.hostDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(artifact.hostDir, 'src', 'use-signals.ts'), CONSUMER);
    fs.writeFileSync(
      path.join(artifact.hostDir, 'tsconfig.json'),
      JSON.stringify(
        {
          ...TSCONFIG,
          compilerOptions: {
            ...TSCONFIG.compilerOptions,
            module: resolution === 'node16' ? 'Node16' : 'ESNext',
            moduleResolution: resolution,
          },
        },
        null,
        2
      )
    );
    const tsc = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', artifact.hostDir],
      { encoding: 'utf8' }
    );
    expect({ status: tsc.status, out: `${tsc.stdout}${tsc.stderr}` }).toEqual({
      status: 0,
      out: '',
    });

    // At runtime Node resolves the subpath through exports; a store that is not there is reported
    // signal by signal, and loading the library starts no server.
    const now = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const s = require('@aquex/reasonbook/signals');
       const r = s.readSignals(${JSON.stringify(path.join(artifact.hostDir, 'none', 'rbook.sqlite'))}, { now: ${JSON.stringify(now)} });
       const failed = s.unreadableReport({ now: ${JSON.stringify(now)}, storePath: 'unused.sqlite', projectId: 'known-project', projectName: 'Known project' }, 'store unreadable');
       process.stdout.write(JSON.stringify({ schema: r.schema, library: r.library, computedAt: r.computedAt, kinds: r.signals.map((e) => e.kind), available: r.signals.some((e) => e.available), unreadableProject: failed.project }));`,
      ],
      { cwd: artifact.hostDir, encoding: 'utf8', timeout: 60000 }
    );
    expect(probe.status).toBe(0);
    const version = (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(JSON.parse(probe.stdout)).toEqual({
      schema: 'rbook.signals/1',
      library: { name: '@aquex/reasonbook/signals', version },
      computedAt: now,
      unreadableProject: { id: 'known-project', name: 'Known project' },
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
  },
  600000
);

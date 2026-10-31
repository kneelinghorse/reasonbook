// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor lists setup drift on this machine and the fix for each, in the order to apply them.
// ABOUTME: It writes nothing; one GET asks npm for the latest version unless --offline is given.

import * as fs from 'fs';
import * as path from 'path';
import type { CliIo } from './core';
import { parseArgs } from './core';
import { runChecks, type DoctorFinding, type DoctorInputs } from './doctor-checks';
import { findGlobal, readClaude } from './doctor-read';
import { readCodex } from './doctor-read-codex';
import {
  findProjectRoot,
  readClientProblems,
  readConfig,
  readProject,
  storeExists,
} from './doctor-read-records';
import { LEGACY } from '../intelligence/legacy-compat';
import { defaultEphemeralRoots } from '../intelligence/resolution-policy';
import { getServerVersion } from '../server-version';
import { oneLine } from '../utils/one-line';

export const LATEST_URL = 'https://registry.npmjs.org/@aquex/reasonbook/latest';
const USAGE = 'Usage: reasonbook doctor [--offline] [--format text|json] [--project-root <root>]';

/** One GET of npm's latest-version document, bounded at 5 s; it sends nothing about this machine. */
export async function npmLatest(): Promise<string> {
  const response = await fetch(LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== 'string') throw new Error('the npm registry named no version');
  return body.version;
}

export interface DoctorSources {
  /** The latest published version; tests inject it, and --offline never asks. */
  readonly latest?: () => Promise<string>;
  readonly now?: number;
  /** Where a registered project counts as temporary; tests leave out the system temp folder. */
  readonly ephemeralRoots?: readonly string[];
}

function gather(
  io: CliIo,
  home: string,
  root: string | null,
  latest: DoctorInputs['latest'],
  ephemeralRoots: readonly string[]
): DoctorInputs {
  const config = readConfig(io.env, home);
  const roots = new Set<string>();
  const resolvedDir = config.resolved.ok ? config.resolved.value : null;
  const inUse = resolvedDir
    ? config.registries.find((registry) => path.dirname(registry.file) === resolvedDir)
    : undefined;
  // A registered root without a record is the registry check's dead row, not a project to read.
  if (inUse?.read.ok)
    for (const row of inUse.read.value.rows)
      if (!row.archived && fs.existsSync(row.storePath) && storeExists(row.storePath))
        roots.add(path.resolve(row.storePath));
  if (root) roots.add(root);
  return {
    version: getServerVersion(),
    latest,
    globals: {
      reasonbook: findGlobal(io.env, 'reasonbook'),
      legacy: findGlobal(io.env, LEGACY.command),
    },
    claude: readClaude(home),
    codex: readCodex(home),
    config,
    projects: [...roots].sort().map((project) => readProject(project)),
    clientProblems: readClientProblems(home),
    ephemeralRoots,
  };
}

/**
 * A fix or evidence shown whole and exact, since it is copied: only terminal controls and
 * direction marks are made visible, never folded or cut (s107-m03 critic, round 2).
 */
const exact = (value: string): string =>
  value.replace(
    /[\p{Cc}\u202a-\u202e\u2066-\u2069\u200b]/gu,
    (mark) => `\\u{${mark.codePointAt(0)!.toString(16)}}`
  );

function text(
  version: string,
  latest: DoctorInputs['latest'],
  findings: readonly DoctorFinding[]
): string {
  const count = (severity: DoctorFinding['severity']) =>
    findings.filter((finding) => finding.severity === severity);
  const fixes = count('fix');
  const unchecked = count('unchecked');
  const notes = count('note');
  const lines = [
    `Reasonbook doctor ${version}: ${fixes.length} to fix, ${unchecked.length} could not be checked, ${notes.length} note${notes.length === 1 ? '' : 's'}`,
    latest.version
      ? `Latest published version: ${latest.version}.`
      : `Latest published version: ${oneLine(latest.error ?? 'unknown')}.`,
  ];
  fixes.forEach((finding, i) => {
    lines.push('', `${i + 1}. ${oneLine(finding.summary)}`);
    for (const evidence of finding.evidence) lines.push(`   - ${exact(evidence)}`);
    if (finding.fix) lines.push(`   Fix: ${exact(finding.fix)}`);
  });
  if (unchecked.length) {
    lines.push('', 'Could not be checked:');
    for (const finding of unchecked)
      lines.push(`- ${oneLine(finding.summary)} ${exact(finding.evidence.join('; '))}`);
  }
  if (notes.length) {
    lines.push('', 'Notes:');
    for (const finding of notes) lines.push(`- ${oneLine(finding.summary)}`);
  }
  lines.push('', 'Nothing was written.');
  return `${lines.join('\n')}\n`;
}

/**
 * Exit 0 only when every check ran and nothing needs fixing; 1 otherwise, never 2 (Claude Code
 * reads 2 from a hook as blocking, and this CLI keeps one meaning for every verb).
 */
export async function runDoctor(
  argv: readonly string[],
  io: CliIo,
  sources: DoctorSources = {}
): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.format !== undefined && flags.format !== 'json' && flags.format !== 'text') {
    io.stderr(USAGE);
    return 1;
  }
  const root = flags['project-root'];
  if (root !== undefined && (!root.trim() || root === 'true')) {
    io.stderr('reasonbook doctor: --project-root needs a folder.');
    return 1;
  }
  const home = io.env.HOME;
  if (!home || !path.isAbsolute(home)) {
    io.stderr(
      'reasonbook doctor: HOME is not set to an absolute folder, so there is nothing to check.'
    );
    return 1;
  }
  let latest: DoctorInputs['latest'];
  if (flags.offline !== undefined) latest = { version: null, error: 'not looked up (--offline)' };
  else
    try {
      latest = { version: await (sources.latest ?? npmLatest)() };
    } catch (error) {
      latest = { version: null, error: `the lookup failed: ${(error as Error).message}` };
    }
  const inputs = gather(
    io,
    home,
    root !== undefined ? path.resolve(io.cwd, root) : findProjectRoot(io.cwd),
    latest,
    sources.ephemeralRoots ?? defaultEphemeralRoots(io.env)
  );
  const { findings, checks } = runChecks(inputs);
  const code =
    checks.every((check) => check.ran) && !findings.some((finding) => finding.severity === 'fix')
      ? 0
      : 1;
  if (flags.format === 'json') {
    const report = {
      version: inputs.version,
      checkedAt: new Date(sources.now ?? Date.now()).toISOString(),
      latest,
      findings: findings.map(({ order: _order, ...finding }) => finding),
      checks,
    };
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else io.stdout(text(inputs.version, latest, findings));
  return code;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's checks: pure functions from one read-only snapshot to findings and fixes.
// ABOUTME: Installs are checked here, clients and records in their own modules. A fix names only probed commands.

import { LEGACY } from '../intelligence/legacy-compat';
import type { ClaudeState, GlobalInstall } from './doctor-read';
import type { CodexState } from './doctor-read-codex';
import type { ConfigState, ProjectState } from './doctor-read-records';
import type { ClientProblem } from './migrate-guard';
import {
  claudeChecks,
  compareVersions,
  pluginMayRun,
  pluginServerCheck,
} from './doctor-checks-clients';
import { codexChecks } from './doctor-checks-codex';
import { recordChecks } from './doctor-checks-records';

export { compareVersions } from './doctor-checks-clients';
export { CURRENT_TOOL_SUFFIXES, stalePermissions } from './doctor-checks-records';

export interface DoctorInputs {
  readonly version: string;
  readonly latest: { readonly version: string | null; readonly error?: string };
  readonly globals: {
    readonly reasonbook: GlobalInstall | null;
    readonly legacy: GlobalInstall | null;
  };
  readonly claude: ClaudeState;
  readonly codex: CodexState;
  readonly config: ConfigState;
  readonly projects: readonly ProjectState[];
  /** What migrate's client guard refuses, before a record moves and before the config folder does. */
  readonly clientProblems: {
    readonly moving: readonly ClientProblem[];
    readonly configMove: readonly ClientProblem[];
  };
  readonly ephemeralRoots: readonly string[];
}

export interface DoctorFinding {
  readonly id: string;
  readonly scope: 'machine' | 'project';
  readonly projectRoot?: string;
  readonly severity: 'fix' | 'note' | 'unchecked';
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly fix: string | null;
  /**
   * Apply fixes in this order: 1 upgrades, 2 plugins, 3 duplicate servers, 4 permissions and what
   * migrate's client guard refuses, 5 the config folder's setting and an interrupted config move
   * (migrate resolves the config folder first), 6 project moves, 7 the config folder, 8 registry.
   */
  readonly order: number;
}

export interface DoctorCheck {
  readonly id: string;
  readonly ran: boolean;
  readonly reason?: string;
}

/** What every check shares: where findings go, and the version a fix installs. */
export interface CheckContext {
  readonly add: (finding: Omit<DoctorFinding, 'scope'>) => void;
  readonly ran: (id: string, reason?: string) => void;
  readonly unchecked: (id: string, summary: string, reason: string) => void;
  /** Whether an earlier check already added a finding with this id. */
  readonly found: (id: string) => boolean;
  /** The newer of this doctor's version and the latest published one. */
  readonly newest: string;
  readonly behind: (version: string | null) => boolean;
  /** The CLI a fix runs, pinned so it works without a global install (decision #1323). */
  readonly cli: string;
}

function installChecks(inputs: DoctorInputs, ctx: CheckContext): void {
  const { reasonbook, legacy } = inputs.globals;
  if (
    reasonbook &&
    reasonbook.packageName === '@aquex/reasonbook' &&
    ctx.behind(reasonbook.version)
  )
    ctx.add({
      id: 'global-outdated',
      severity: 'fix',
      summary: `The global reasonbook command is ${reasonbook.version}; ${ctx.newest} is current.`,
      evidence: [`reasonbook on PATH runs @aquex/reasonbook ${reasonbook.version}`],
      fix: `npm install -g @aquex/reasonbook@${ctx.newest}`,
      order: 1,
    });
  else if (reasonbook && reasonbook.packageName !== '@aquex/reasonbook')
    ctx.add({
      id: 'global-foreign',
      severity: 'note',
      summary: reasonbook.packageName
        ? `The reasonbook command on PATH runs ${reasonbook.packageName}, not @aquex/reasonbook.`
        : 'Doctor could not tell which package the reasonbook command on PATH runs.',
      evidence: [],
      fix: null,
      order: 1,
    });
  if (legacy && legacy.packageName === LEGACY.packageName)
    ctx.add({
      id: 'global-legacy',
      severity: 'fix',
      summary: `The old ${LEGACY.command} global (${legacy.version ?? 'unknown version'}) is still installed.`,
      evidence: [`${LEGACY.command} on PATH runs ${LEGACY.packageName}`],
      fix: `npm uninstall -g ${LEGACY.packageName}`,
      order: 1,
    });
  if (ctx.newest !== inputs.version)
    ctx.add({
      id: 'doctor-outdated',
      severity: 'note',
      summary: `This doctor is ${inputs.version}; ${ctx.newest} is published.`,
      evidence: ['the npm registry names the latest version'],
      fix: null,
      order: 1,
    });
  ctx.ran('installs');
}

export function runChecks(inputs: DoctorInputs): {
  findings: DoctorFinding[];
  checks: DoctorCheck[];
} {
  const findings: DoctorFinding[] = [];
  const checks: DoctorCheck[] = [];
  const newest =
    inputs.latest.version && (compareVersions(inputs.latest.version, inputs.version) ?? 0) > 0
      ? inputs.latest.version
      : inputs.version;
  // One entry per check: a check that could not run for any one file did not run.
  const mark = (check: DoctorCheck) => {
    const at = checks.findIndex((found) => found.id === check.id);
    if (at === -1) checks.push(check);
    else if (checks[at].ran && !check.ran) checks[at] = check;
  };
  const ctx: CheckContext = {
    add: (finding) =>
      findings.push({ scope: finding.projectRoot ? 'project' : 'machine', ...finding }),
    ran: (id, reason) => mark({ id, ran: true, ...(reason ? { reason } : {}) }),
    unchecked: (id, summary, reason) => {
      mark({ id, ran: false, reason });
      findings.push({
        id,
        scope: 'machine',
        severity: 'unchecked',
        summary,
        evidence: [reason],
        fix: null,
        order: 0,
      });
    },
    found: (id) => findings.some((finding) => finding.id === id),
    newest,
    behind: (version) => version !== null && (compareVersions(version, newest) ?? 0) < 0,
    cli: `npx --prefer-offline -y @aquex/reasonbook@${newest}`,
  };
  installChecks(inputs, ctx);
  // First among the plugin fixes: a config.json the plugin's server refuses is fixed before any fix
  // that relies on that server, the manual-server fix's plugin install among them (s107-m03 round 4).
  pluginServerCheck(inputs, ctx, pluginMayRun(inputs));
  claudeChecks(inputs, ctx);
  codexChecks(inputs, ctx);
  recordChecks(inputs, ctx);
  const rank = { fix: 0, unchecked: 1, note: 2 } as const;
  findings.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.order - b.order ||
      (a.projectRoot ?? '').localeCompare(b.projectRoot ?? '')
  );
  return { findings, checks };
}

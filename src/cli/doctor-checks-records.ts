// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's record checks: stale permissions, project moves, the config folder and the registry.
// ABOUTME: Pure functions over the read-only snapshot; a migrate fix carries one note that migrate needs every client closed.

import * as fs from 'fs';
import * as path from 'path';
import { LEGACY, toolNameSuffix } from '../intelligence/legacy-compat';
import {
  reconfirmDefaultCall,
  type ProjectGraphEntry,
} from '../intelligence/project-graph-registry';
import { isEphemeralStorePath } from '../intelligence/resolution-policy';
import type { CheckContext, DoctorInputs } from './doctor-checks';
import { sh } from './doctor-checks-clients';
import type { PermissionSource } from './doctor-read';
import { storeExists } from './doctor-read-records';

/** The tools a Reasonbook server answers, by suffix (pinned to the definitions by tests). */
export const CURRENT_TOOL_SUFFIXES: ReadonlySet<string> = new Set([
  'agent_onboard',
  'auth',
  'context',
  'db',
  'decisions',
  'feedback',
  'learnings',
  'message',
  'mission',
  'mission_transition',
  'project',
  'review',
  'session',
  'sprint',
  'status',
]);

/** A stale name: a Reasonbook tool permission under the old prefix, or for a tool no server answers. */
export function stalePermissions(source: PermissionSource): string[] {
  return source.names.filter((name) => {
    const suffix = toolNameSuffix(name);
    if (suffix === null) return false;
    return /(?:^|__)cmos_[a-z]/.test(name) || !CURRENT_TOOL_SUFFIXES.has(suffix);
  });
}

function permissionChecks(inputs: DoctorInputs, ctx: CheckContext): void {
  for (const reason of inputs.claude.unread)
    ctx.unchecked('permissions', 'Saved tool permissions could not be read.', reason);
  const sources = [
    ...inputs.claude.permissions,
    ...inputs.projects.flatMap((project) => project.permissions),
  ];
  for (const source of sources) {
    const stale = stalePermissions(source);
    if (stale.length)
      ctx.add({
        id: 'permissions-stale',
        severity: 'fix',
        summary: `${source.file} lists ${stale.length} Reasonbook tool name${stale.length === 1 ? '' : 's'} no server answers.`,
        evidence: stale,
        fix: `remove ${stale.length === 1 ? 'that entry' : 'those entries'} from ${source.file}`,
        order: 4,
      });
  }
  ctx.ran('permissions');
}

/** What a check's migrate fixes need: whether any runs migrate, and whether one moves a record. */
interface Moves {
  readonly migrates: boolean;
  readonly guarded: boolean;
}

function projectChecks(inputs: DoctorInputs, ctx: CheckContext): Moves {
  let migrates = false;
  let guarded = false;
  for (const project of inputs.projects) {
    const root = project.root;
    const quoted = sh(root);
    if (!project.exists) {
      ctx.unchecked(
        'projects',
        `The project folder ${root} does not exist, so it was not checked.`,
        `${root} is missing`
      );
      continue;
    }
    for (const reason of project.unread)
      ctx.unchecked(
        'projects',
        `A file in ${root} could not be read, so its servers or permissions were not checked.`,
        reason
      );
    if (project.layout === 'none')
      ctx.add({
        id: 'project-no-record',
        severity: 'note',
        projectRoot: root,
        summary: `${root} holds no Reasonbook record.`,
        evidence: [],
        fix: null,
        order: 6,
      });
    // migrate --apply refuses a record that will move while .mcp.json names the old package;
    // its documents-only pass rewrites an unpinned one, so that pass goes first.
    const rewrite = project.serverPins.some((pin) => pin.kind === 'legacy-package')
      ? `${ctx.cli} migrate --docs-only --project ${quoted}, then the same with --apply, then `
      : '';
    if (project.journal || project.lock) {
      migrates = true;
      guarded = true;
      ctx.add({
        id: 'project-move-interrupted',
        severity: 'fix',
        projectRoot: root,
        summary: `A record move in ${root} was interrupted.`,
        evidence: [
          project.journal ? '.rbook-migration.json is present' : '.rbook-migration.lock is present',
        ],
        // Recovery can roll the move back, and the move then refuses a .mcp.json naming the old
        // package until the documents pass rewrites it (s107-m03 round 4).
        fix: `${ctx.cli} migrate --apply --project ${quoted}${
          rewrite
            ? `; if that refuses because .mcp.json names the legacy package, ${rewrite}${ctx.cli} migrate --project ${quoted}, then the same with --apply`
            : ''
        }`,
        order: 6,
      });
    } else if (project.layout === 'legacy') {
      migrates = true;
      guarded = true;
      ctx.add({
        id: 'project-legacy-layout',
        severity: 'fix',
        projectRoot: root,
        summary: `${root} keeps its record in the old ${LEGACY.recordDirectory}/ layout.`,
        evidence: [
          `${LEGACY.recordDirectory}/db/${LEGACY.databaseFile}`,
          ...project.serverPins
            .filter((pin) => pin.kind === 'legacy-package')
            .map((pin) => pin.message),
        ],
        fix: `${rewrite}${ctx.cli} migrate --project ${quoted}, then the same with --apply`,
        order: 6,
      });
    } else if (project.pending) {
      migrates = true;
      ctx.add({
        id: 'project-move-pending',
        severity: 'fix',
        projectRoot: root,
        summary: `${root}'s record moved, but its documents and registration were not finished.`,
        evidence: ['.rbook-migration-pending.json is present'],
        fix: `${ctx.cli} migrate --apply --project ${quoted}`,
        order: 6,
      });
    }
    if (project.layout === 'both')
      ctx.add({
        id: 'project-both-layouts',
        severity: 'note',
        projectRoot: root,
        summary: `${root} holds both rbook/ and ${LEGACY.recordDirectory}/; Reasonbook uses rbook/.`,
        evidence: [`${LEGACY.recordDirectory}/ is not read while rbook/ exists`],
        fix: null,
        order: 6,
      });
    const pins = project.serverPins.filter((pin) => pin.kind !== 'legacy-package');
    const mcp = path.join(root, '.mcp.json');
    if (pins.length)
      ctx.add({
        id: 'project-server-pin',
        severity: 'fix',
        projectRoot: root,
        summary: `${mcp} has a server migrate refuses: an old or unreadable Reasonbook version.`,
        evidence: pins.map((pin) => pin.message),
        fix: `pin @aquex/reasonbook@${ctx.newest} in ${mcp}${
          pins.some((pin) => pin.kind === 'local-build')
            ? ', or rebuild that local build at 4.x'
            : ''
        }`,
        order: 1,
      });
  }
  ctx.ran('projects');
  return { migrates, guarded };
}

function configChecks(inputs: DoctorInputs, ctx: CheckContext): Moves {
  const { config } = inputs;
  let migrates = false;
  let guarded = false;
  if (config.emptySetting)
    ctx.add({
      id: 'config-dir-empty',
      severity: 'fix',
      summary: `${config.settingName} is set but empty, so each Reasonbook client uses the folder it starts in as its config folder.`,
      evidence: ['an empty value still counts as set, as Reasonbook reads its settings'],
      fix: `unset ${config.settingName}, or set it to the folder you mean`,
      order: 5,
    });
  else if (!config.resolved.ok) {
    migrates = true;
    guarded = true;
    // migrate --config refuses while either setting names a folder.
    const unset = config.explicit
      ? `unset RBOOK_CONFIG_DIR ${LEGACY.envPrefix}CONFIG_DIR, then `
      : '';
    ctx.add({
      id: 'config-move-interrupted',
      severity: 'fix',
      summary: 'A config folder move was interrupted, so Reasonbook refuses to open its registry.',
      evidence: [config.resolved.reason],
      fix: `${unset}${ctx.cli} migrate --config --apply`,
      order: 5,
    });
  } else if (!config.explicit && config.resolved.value === config.legacy) {
    migrates = true;
    guarded = true;
    const registry = path.join(config.legacy, 'project-graph.sqlite');
    const held = config.registries.some((found) => found.file === registry);
    // migrate --config refuses while both folders exist, so a new folder beside it goes first.
    const beside = config.currentEntries;
    const first =
      beside === null
        ? ''
        : beside.length === 0
          ? `rmdir ${sh(config.current)}, then `
          : `move ${beside.join(', ')} out of ${config.current} and remove that folder (migrate --config refuses while both folders exist), then `;
    ctx.add({
      id: 'config-legacy-folder',
      severity: 'fix',
      summary: held
        ? `The registry is still in the old config folder ${config.legacy}.`
        : `Reasonbook still reads its config from the old folder ${config.legacy}.`,
      evidence: [
        held ? registry : `${config.legacy} exists and ${config.current} does not`,
        ...(beside === null
          ? []
          : [
              `${config.current} exists${beside.length ? ` and holds ${beside.join(', ')}` : ' and is empty'}, with no registry`,
            ]),
      ],
      fix: `${first}${ctx.cli} migrate --config, then the same with --apply`,
      order: 7,
    });
  }
  const holds = (folder: string) =>
    config.registries.some((registry) => path.dirname(registry.file) === folder);
  if (holds(config.current) && holds(config.legacy))
    ctx.add({
      id: 'config-both-folders',
      severity: 'note',
      summary: `Both ${config.current} and ${config.legacy} hold a registry; Reasonbook uses ${
        config.resolved.ok ? config.resolved.value : 'neither until that is fixed'
      }.`,
      evidence: config.explicit ? [] : ['set RBOOK_CONFIG_DIR to choose one explicitly'],
      fix: null,
      order: 7,
    });
  if (config.explicit)
    ctx.add({
      id: 'config-explicit',
      severity: 'note',
      summary: `${config.settingName ?? 'RBOOK_CONFIG_DIR'} chooses ${config.explicit}.`,
      evidence: [],
      fix: null,
      order: 7,
    });
  ctx.ran('config');
  return { migrates, guarded };
}

function registryChecks(inputs: DoctorInputs, ctx: CheckContext): void {
  const { config } = inputs;
  if (!config.resolved.ok) {
    ctx.unchecked(
      'registry',
      'The registry could not be opened, so registered projects were not read.',
      config.resolved.reason
    );
    return;
  }
  const resolvedDir = config.resolved.value;
  const inUse = config.registries.find((registry) => path.dirname(registry.file) === resolvedDir);
  if (!inUse) {
    ctx.ran('registry', 'no registry in the folder Reasonbook uses');
    return;
  }
  if (!inUse.read.ok) {
    ctx.unchecked('registry', `The registry ${inUse.file} could not be read.`, inUse.read.reason);
    return;
  }
  const active = inUse.read.value.rows.filter((row) => !row.archived);
  const dead = active.filter(
    (row) =>
      !fs.existsSync(row.storePath) ||
      !storeExists(row.storePath) ||
      isEphemeralStorePath(row.storePath, inputs.ephemeralRoots)
  );
  if (dead.length)
    ctx.add({
      id: 'registry-dead-rows',
      severity: 'fix',
      summary: `${dead.length} registered project${dead.length === 1 ? ' is' : 's are'} gone, without a record, or temporary.`,
      evidence: dead.map((row) => `${row.name}: ${row.storePath}`),
      fix: 'rbook_project(action="validate", prune=true)',
      order: 8,
    });
  const { defaultId, confirmedId } = inUse.read.value;
  // A dead default is the prune's to remove; confirming it would contradict that fix.
  const entry = defaultId
    ? active.find((row) => row.projectId === defaultId && !dead.includes(row))
    : undefined;
  if (entry && confirmedId !== defaultId)
    ctx.add({
      id: 'registry-default-unconfirmed',
      severity: 'fix',
      summary: `The registry’s default project, ${entry.name}, was never confirmed, so it is not applied.`,
      evidence: [entry.storePath],
      fix: reconfirmDefaultCall({ store_path: entry.storePath } as ProjectGraphEntry),
      order: 8,
    });
  ctx.ran('registry');
}

/**
 * What migrate's client guard would refuse before the moves doctor offers, where no client finding
 * already names it: a plugin record or setting always has one, so only a file's text, a client
 * doctor does not read, or a file the guard cannot read is left (s107-m03 critic, round 2).
 */
function refusalChecks(
  inputs: DoctorInputs,
  ctx: CheckContext,
  project: boolean,
  config: boolean
): void {
  const problems = [
    ...(project || config ? inputs.clientProblems.moving : []),
    ...(config ? inputs.clientProblems.configMove : []),
  ];
  for (const problem of problems) {
    if (problem.kind === 'plugin-version' || problem.kind === 'enabled-legacy') continue;
    const codex = problem.file.endsWith(path.join('.codex', 'config.toml'));
    // config.toml's old-package text is the codex-legacy problem's; a dist/ path is not, and
    // nothing else names it (s107-m03 rounds 4 and 5).
    if (
      codex &&
      (problem.kind === 'config-build'
        ? !problem.distBuild
        : ctx.found('codex-plugin-legacy') || ctx.found('codex-server-old-package'))
    )
      continue;
    if (
      problem.kind === 'config-build' &&
      !problem.distBuild &&
      problem.file.endsWith('.claude.json') &&
      ctx.found('claude-server-old-package')
    )
      continue;
    ctx.add({
      id: 'migrate-refuses',
      severity: 'fix',
      summary:
        problem.kind === 'unreadable'
          ? `migrate cannot read ${problem.file}, so it refuses to move anything.`
          : `${problem.file} still names the old plugin or package, in a comment or anywhere else, so migrate refuses to move${problem.kind === 'config-build' ? ' the config folder' : ''}.`,
      evidence: [problem.message],
      fix:
        problem.kind === 'unreadable'
          ? `make ${problem.file} readable, valid JSON where it is JSON`
          : `remove every mention of ${LEGACY.recordDirectory}@${LEGACY.recordDirectory}, ${LEGACY.recordDirectory}-chat@${LEGACY.recordDirectory}, ${LEGACY.packageName}, ${LEGACY.command}/dist/ and any @aquex/reasonbook pin below 4.0 from ${problem.file}`,
      order: 4,
    });
  }
}

export function recordChecks(inputs: DoctorInputs, ctx: CheckContext): void {
  permissionChecks(inputs, ctx);
  const projects = projectChecks(inputs, ctx);
  const config = configChecks(inputs, ctx);
  registryChecks(inputs, ctx);
  refusalChecks(inputs, ctx, projects.guarded, config.guarded);
  if (projects.migrates || config.migrates)
    ctx.add({
      id: 'migrate-needs-quiet-machine',
      severity: 'note',
      summary:
        'migrate refuses while any Reasonbook server or hook runs on this machine: close every Claude Code, Codex and other client first.',
      evidence: [],
      fix: null,
      order: 6,
    });
}

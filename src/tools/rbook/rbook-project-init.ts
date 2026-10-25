// ABOUTME: Initializes new Reasonbook workspaces from the seed bundle and creates the SQLite DB.
// ABOUTME: Also scaffolds top-level agent guidance such as CLAUDE.md for fresh projects.

/**
 * rbook_project_init Tool
 *
 * MCP tool for initializing a new Reasonbook project structure.
 * Copies the seed files the project's level uses and creates a fresh SQLite database.
 *
 * Features:
 * - Copies the seed files its level uses (a Builder gets docs, foundational-docs and every tier guide)
 * - Creates fresh SQLite database from schema.sql
 * - Sets project metadata (name, id, tracelab link)
 * - Optionally creates initial sprint and missions
 * - Idempotent - safe to call on existing project (won't overwrite existing files)
 *
 * @module tools/rbook/rbook-project-init
 */

import { z } from 'zod';
import { SPRINT_OPEN_STATUSES, statusInSql } from './terminal-status';
import { formatCliRemedy, inertCliPath } from '../../utils/cli-remedy';
import { isSameDirectory } from '../../intelligence/resolution-policy';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { DATABASE_FILE, RECORD_DIRECTORY } from '../../intelligence/product-names';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import { RBOOK_SCHEMA, RBOOK_SCHEMA_VERSION } from './schema';
import { AUTHOR_NAMES_SINCE_KEY } from './schema-migrations';
import { rawGenesisColumns } from './genesis-columns';
import { assertJestDbPathIsolated } from './real-store-guard';
import { ProjectGraphRegistry, readStoreIdentity } from '../../intelligence/project-graph-registry';
import { RbookDetector } from '../../intelligence/rbook-detector';
import { appendWarnings } from './format-warnings';
import { RbookDatabaseClient } from './client';
import { isSharedStore } from './replica-identity';
import { replicaWriteRefusal } from './replica-check';
import {
  AGENTS_FILE_NAME,
  AMBIENT_METADATA_KEY,
  asRulesAmbient,
  describeRbookLineRefresh,
  findAgentsFile,
  LEVEL_TIERS,
  levelName,
  levelOfTier,
  readRbookLine,
  refreshRbookLine,
  rbookRulesLine,
  type RbookLineReading,
  renderAgentsMd,
  renderClaudeMd,
  type ProjectLevel,
  type RulesAmbient,
} from './rules-files';
import { readmeNote, resolveSeedPath, writeLevelFiles } from './level-files';
import { TIER_SOURCES, tierOf } from './project-level';
import { enableWal } from './sqlite-busy';

// s95-m06: the seed lookup and copy live in level-files.ts, beside each level's file list;
// re-exported here for existing importers.
export { resolveSeedPath };

// s92-m06's AGENTS_FILE_NAME and findAgentsFile live in rules-files.ts since s93-m12, beside the
// rest of the rules-file logic; re-exported here for existing importers.
export { AGENTS_FILE_NAME, findAgentsFile };

/**
 * s92-m06: write AGENTS.md to the project root unless an agents file is already there. s93-m12: the
 * seed's template rendered for this project (rules-files.ts): its Reasonbook line names the level, and the
 * hook-less block is appended only for a harness without hooks. The write is exclusive, so it never
 * overwrites a file, even one written since the check.
 */
function ensureAgentsMd(
  projectRoot: string,
  seedPath: string,
  options: { level: ProjectLevel; projectName: string; hooks: boolean; ambient: RulesAmbient }
): { name: string; written: boolean } {
  const existing = findAgentsFile(projectRoot);
  if (existing) return { name: existing, written: false };
  const template = fs.readFileSync(path.join(seedPath, 'templates', AGENTS_FILE_NAME), 'utf8');
  const rendered = renderAgentsMd(template, {
    level: options.level,
    projectName: options.projectName,
    hooks: options.hooks,
    ambient: options.ambient,
    ...(options.hooks
      ? {}
      : {
          noHooksBlock: fs.readFileSync(
            path.join(seedPath, 'templates', NO_HOOKS_TEMPLATE),
            'utf8'
          ),
        }),
  });
  try {
    fs.writeFileSync(path.join(projectRoot, AGENTS_FILE_NAME), rendered, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { name: findAgentsFile(projectRoot) ?? AGENTS_FILE_NAME, written: false };
    }
    throw error;
  }
  return { name: AGENTS_FILE_NAME, written: true };
}

/**
 * A re-init's changed name or level reaches the existing identity and master context too.
 * The current metadata name is read under the write lock; a missing context is seeded later.
 */
function syncIdentityContexts(
  db: Database.Database,
  change: { readonly syncName: boolean; readonly tier?: string },
  now: string
): void {
  const read = db.prepare('SELECT content FROM contexts WHERE id = ?');
  const write = db.prepare('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?');
  // Read and write under one write lock, so a concurrent identity write is never lost. Raw
  // better-sqlite3 statements throw on failure, so the rollback runs on any error.
  db.exec('BEGIN IMMEDIATE');
  try {
    const name = change.syncName
      ? (
          db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as
            | { value: string }
            | undefined
        )?.value
      : undefined;
    applyIdentityChange(read, write, { name, tier: change.tier }, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function applyIdentityChange(
  read: Database.Statement,
  write: Database.Statement,
  change: { readonly name?: string; readonly tier?: string },
  now: string
): void {
  const patch = (id: string, apply: (content: Record<string, unknown>) => boolean): void => {
    const row = read.get(id) as { content: string } | undefined;
    let content: unknown;
    try {
      content = row ? JSON.parse(row.content) : null;
    } catch {
      return;
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) return;
    if (apply(content as Record<string, unknown>)) write.run(JSON.stringify(content), now, id);
  };
  patch('project_identity', (identity) => {
    const before = JSON.stringify(identity);
    if (change.name !== undefined) identity.project_name = change.name;
    if (change.tier !== undefined) identity.tier = change.tier;
    if (JSON.stringify(identity) === before) return false;
    identity.updated_at = now;
    return true;
  });
  if (change.name === undefined) return;
  patch('master_context', (master) => {
    const section = master.project_identity;
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    const project = section as Record<string, unknown>;
    if (project.name === change.name) return false;
    project.name = change.name;
    return true;
  });
}

/** Init diagnostics recognize filesystem aliases that realpath alone may not collapse on macOS. */
function sameInitFolder(left: string, right: string): boolean {
  if (isSameDirectory(left, right)) return true;
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** How a Reasonbook line or a store describes the hooks. */
function hooksText(ambient: RulesAmbient): string {
  return ambient === 'on' ? 'on' : ambient === 'off' ? 'off' : 'on without the session digest';
}

/**
 * s93-m12 (the confirming critics): the warning for an agents file whose Reasonbook line says another
 * level or hooks setting than the store holds, with a remedy that works either way: re-render the
 * line to match the project, or set the project as the line says. A line edited by hand cannot be
 * re-rendered, so the warning gives the line to write instead.
 */
function rbookLineMismatch(
  reading: RbookLineReading,
  level: ProjectLevel,
  ambient: RulesAmbient,
  projectRoot: string,
  cliSource?: 'explicit' | 'cwd'
): string {
  const target = { projectRoot, resolvedBy: cliSource ?? 'explicit' } as const;
  const says =
    `${reading.level ? `the ${levelName(reading.level)} level` : 'no level'}` +
    (reading.hooks ? ` with the hooks ${hooksText(reading.ambient)}` : '');
  const is = `the ${levelName(level)} level with the hooks ${hooksText(ambient)}`;
  const toLine = reading.rendered
    ? `rbook_project(action="update", projectRoot=${inertCliPath(projectRoot)}, projectType="${LEVEL_TIERS[level]}") re-renders the line to match the project`
    : `the line was edited by hand, so write it as: ${rbookRulesLine(level, { hooks: reading.hooks, ambient })}`;
  const toProject = [
    ...(reading.level && reading.level !== level
      ? [
          cliSource
            ? `${formatCliRemedy(`init --level ${reading.level}`, target)} sets the level the line names`
            : `init with projectType="${LEVEL_TIERS[reading.level]}" sets the level the line names`,
        ]
      : []),
    ...(reading.hooks && reading.ambient !== ambient
      ? [`${formatCliRemedy(`ambient ${reading.ambient}`, target)} sets the hooks as the line says`]
      : []),
  ];
  return `${reading.name}'s Reasonbook line says ${says}, but this project is at ${is}. ${toLine}${toProject.length > 0 ? `; or ${toProject.join(', and ')}` : ''}.`;
}

/** s93-m12: the template the root CLAUDE.md is rendered from. */
const CLAUDE_TEMPLATE = 'CLAUDE-import.md';

/** s93-m12: the hook-less block `reasonbook init --no-hooks` appends to AGENTS.md. */
const NO_HOOKS_TEMPLATE = 'AGENTS-no-hooks.md';

/**
 * s93-m12: CLAUDE.md imports the agents file under the name it has at the root, and names no tool
 * prefix. Written only when the root has no CLAUDE.md.
 */
function ensureClaudeMd(projectRoot: string, seedPath: string, agentsFileName: string): boolean {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) {
    return false;
  }
  // Not named CLAUDE.md: the seed's templates are copied into every project's rbook/templates/, and
  // Claude Code loads a nested CLAUDE.md, which would import the unrendered template.
  const template = fs.readFileSync(path.join(seedPath, 'templates', CLAUDE_TEMPLATE), 'utf8');
  try {
    fs.writeFileSync(claudePath, renderClaudeMd(template, agentsFileName), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

/** Whether the root's CLAUDE.md imports the agents file (a line `@<name>`). */
function claudeMdImports(projectRoot: string, agentsFileName: string): boolean {
  try {
    return fs
      .readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8')
      .split('\n')
      .some((line) => [`@${agentsFileName}`, `@./${agentsFileName}`].includes(line.trim()));
  } catch {
    return false;
  }
}

/**
 * Initial sprint definition for project setup.
 */
export interface InitialSprint {
  id: string;
  title: string;
  focus?: string;
  status?: string;
}

/**
 * Initial mission definition for project setup.
 */
export interface InitialMission {
  id: string;
  name: string;
  sprintId?: string | null;
  objective?: string;
  successCriteria?: string[];
  deliverables?: string[];
  status?: 'Queued' | 'Current';
}

/**
 * Input parameters schema for rbook_project_init tool.
 */
export const rbookProjectInitSchema = z.object({
  /** Root directory where rbook/ will be created (required) */
  projectRoot: z.string().min(1).describe('Root directory where rbook/ will be created'),

  /** Human-readable project name */
  projectName: z.string().optional().describe('Human-readable project name'),

  /** Unique project identifier (auto-generated if not provided) */
  projectId: z
    .string()
    .optional()
    .describe('Unique project identifier (UUID or slug, auto-generated if not provided)'),

  /** Linked TraceLab project UUID for cross-referencing */
  tracelabProjectId: z
    .string()
    .optional()
    .describe('Linked TraceLab project UUID for cross-referencing'),

  /** Optional initial sprint to create */
  initialSprint: z
    .object({
      id: z.string().describe('Sprint ID (e.g., "sprint-01")'),
      title: z.string().describe('Sprint title'),
      focus: z.string().optional().describe('Sprint focus/theme'),
      status: z.string().optional().default('Active').describe('Sprint status'),
    })
    .optional()
    .describe('Optional initial sprint to create; not at the Ledger level, which keeps no sprints'),

  /** Optional initial missions to create */
  initialMissions: z
    .array(
      z.object({
        id: z.string().describe('Mission ID (e.g., "s01-m01")'),
        name: z.string().describe('Mission name'),
        sprintId: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe('Existing sprint; omitted infers the unique open sprint, null is unscheduled'),
        objective: z.string().optional().describe('Mission objective'),
        successCriteria: z.array(z.string()).optional().describe('Success criteria'),
        deliverables: z.array(z.string()).optional().describe('Expected deliverables'),
        status: z.enum(['Queued', 'Current']).optional().default('Queued'),
      })
    )
    .optional()
    .describe(
      'Optional initial missions to create; not at the Ledger level, which keeps no missions'
    ),

  /**
   * Project tier/type written to metadata at init (s93-m12: a new project defaults to general, or
   * to the level its folder's agents file already names)
   */
  projectType: z
    .enum(['general', 'managed', 'build'])
    .optional()
    .describe(
      'The level of record: general (decisions and lessons), managed (also next steps, as tasks ' +
        'in cycles) or build (sprints and missions). Written to metadata so onboarding surfaces ' +
        'the matching tier guide. Defaults to general for new projects.'
    ),
});

/**
 * Input type (before defaults applied) - use this for function parameters.
 */
export type RbookProjectInitInput = z.input<typeof rbookProjectInitSchema>;

/**
 * Output type (after defaults applied) - use this internally.
 */
export type RbookProjectInitParams = z.infer<typeof rbookProjectInitSchema>;

/**
 * Result of project initialization.
 */
/**
 * s93-m12: where init took the level from: passed (projectType, `--level`), kept from the store, the
 * Reasonbook line of the folder's agents file (a store recreated beside it, a team's committed
 * AGENTS.md), or the default for a new project (Ledger).
 */
export type InitLevelSource = 'passed' | 'stored' | 'agents-file' | 'default';

const LEVEL_SOURCE_TEXT: Readonly<Record<InitLevelSource, string>> = {
  passed: 'as asked',
  stored: 'kept from the store',
  'agents-file': "from the agents file's Reasonbook line",
  default: 'the default for a new project',
};

export interface RbookProjectInitResult {
  /** Path to the created rbook/ directory */
  rbookDirectory: string;

  /** Path to the created database */
  databasePath: string;

  /** Whether this was a new initialization or update to existing */
  isNewProject: boolean;

  /** Project ID (generated or provided) */
  projectId: string;

  /** Project name */
  projectName: string;

  /** s93-m12: the project's level after init, and where it came from. */
  level: ProjectLevel;
  levelSource: InitLevelSource;

  /** Schema version applied */
  schemaVersion: string;

  /** Files and directories created */
  created: {
    directories: string[];
    files: string[];
  };

  /** Sprint created (if any) */
  sprintCreated?: string;

  /** Missions created (if any) */
  missionsCreated?: string[];
}

/**
 * MCP Tool Definition for rbook_project_init.
 */
export const rbookProjectInitToolDefinition = {
  name: 'rbook_project_init',
  description:
    "Initialize a new Reasonbook project structure. Copies the seed files its level uses (a Builder gets the full rbook-seed: tiers, docs, templates, foundational-docs, context, schema; a Ledger or Planner gets no Builder documents) and creates a fresh SQLite database. Safe to call on existing projects (idempotent - removes no file and overwrites none, except a rbook/README.md Reasonbook wrote for another level, which is replaced with this level's).",
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Root directory where rbook/ will be created',
      },
      projectName: {
        type: 'string',
        description: 'Human-readable project name',
      },
      projectId: {
        type: 'string',
        description: 'Unique project identifier (UUID or slug, auto-generated if not provided)',
      },
      tracelabProjectId: {
        type: 'string',
        description: 'Linked TraceLab project UUID for cross-referencing',
      },
      initialSprint: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Sprint ID (e.g., "sprint-01")' },
          title: { type: 'string', description: 'Sprint title' },
          focus: { type: 'string', description: 'Sprint focus/theme' },
          status: { type: 'string', description: 'Sprint status (default: Active)' },
        },
        required: ['id', 'title'],
        description:
          'Optional initial sprint to create; not at the Ledger level, which keeps no sprints',
      },
      initialMissions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mission ID' },
            name: { type: 'string', description: 'Mission name' },
            sprintId: {
              type: ['string', 'null'],
              description:
                'Existing sprint; omitted infers the unique open sprint, null is unscheduled',
            },
            objective: { type: 'string', description: 'Mission objective' },
            successCriteria: {
              type: 'array',
              items: { type: 'string' },
              description: 'Success criteria',
            },
            deliverables: {
              type: 'array',
              items: { type: 'string' },
              description: 'Expected deliverables',
            },
            status: {
              type: 'string',
              enum: ['Queued', 'Current'],
              description: 'Initial status',
            },
          },
          required: ['id', 'name'],
        },
        description:
          'Optional initial missions to create; not at the Ledger level, which keeps no missions',
      },
    },
    required: ['projectRoot'],
    additionalProperties: false,
  },
} as const;

/**
 * s95-m06: the tier an existing store holds, read before init writes anything: null when it names
 * none, which levelOfTier reads as Builder, as onboard does; or why the store could not be read at
 * all, so init refuses rather than guess a level and write its files (the confirming critic).
 */
function readStoredTier(dbPath: string): { tier: string | null } | { error: string } {
  assertJestDbPathIsolated(dbPath);
  let db: Database.Database | undefined;
  try {
    // Init itself leaves a refused folder with a writable store as it found it (the build critic).
    // A read-only connection leaves empty -wal and -shm files beside a WAL store that had none, and
    // a read-write one that closes last deletes ones that were there, so the open matches what is
    // there (probed in the s95-m06 universe note). A store file that is itself read-only opens
    // read-only either way and can still leave the two files.
    const sidecars = fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`);
    db = new Database(dbPath, { readonly: sidecars, fileMustExist: true });
    // A store that cannot be read at all fails here; a missing table or row below just names no tier.
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { tier: storeTier(db) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/** A store's tier from a raw connection, read as every level-aware answer reads it (tierOf). */
function storeTier(db: Database.Database): string | null {
  const read = (sql: string): string | null => {
    try {
      return (db.prepare(sql).pluck().get() as string | null | undefined) ?? null;
    } catch {
      return null;
    }
  };
  const [projectType, identity, projectContext] = TIER_SOURCES.map(read);
  return tierOf(projectType, identity, projectContext);
}

/**
 * Execute the rbook_project_init tool.
 *
 * Copies the seed files the project's level uses to <projectRoot>/rbook/ and creates
 * a fresh SQLite database with project metadata.
 */
export async function rbookProjectInit(
  input: RbookProjectInitInput,
  // s93-m12: `reasonbook init --no-hooks` (a harness without hooks) appends the hook-less block to
  // AGENTS.md. Internal and non-schema: the MCP tool always writes the hooked form.
  internalOpts: { hooks?: boolean; cliSource?: 'explicit' | 'cwd' } = {}
): Promise<RbookToolResult<RbookProjectInitResult>> {
  // s93-m11 (#606 f): init takes its path literally and never infers one, so a missing projectRoot
  // gets a remedy instead of a raw schema message.
  if (typeof input.projectRoot !== 'string' || input.projectRoot.trim().length === 0) {
    return createError({
      code: RBOOK_ERROR_CODES.MISSING_PARAMETER,
      message: 'rbook_project(action="init") needs projectRoot: the folder that will hold rbook/.',
      suggestion:
        'Create the project folder first if it does not exist, then pass it as an absolute path: rbook_project(action="init", projectRoot="/path/to/project"). Init never guesses the folder.',
      field: 'projectRoot',
    });
  }

  // Parse input to apply defaults and validate
  const parseResult = rbookProjectInitSchema.safeParse(input);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `Validation error: ${firstError?.message ?? 'Unknown error'}`,
      field: firstError?.path.join('.') || undefined,
      providedValue: firstError?.path.length
        ? (input as Record<string, unknown>)[String(firstError.path[0])]
        : undefined,
    });
  }

  const params = parseResult.data;
  const {
    projectRoot,
    projectName = '',
    projectId: providedProjectId,
    tracelabProjectId = '',
    initialSprint,
    initialMissions,
    projectType,
  } = params;

  // Validate project root exists and is a directory
  if (!fs.existsSync(projectRoot)) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `Project root does not exist: ${projectRoot}`,
      suggestion: 'Provide a valid directory path where the project will be initialized.',
      field: 'projectRoot',
      providedValue: projectRoot,
    });
  }

  const projectRootStat = fs.statSync(projectRoot);
  if (!projectRootStat.isDirectory()) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `Project root is not a directory: ${projectRoot}`,
      suggestion: 'Provide a directory path, not a file path.',
      field: 'projectRoot',
      providedValue: projectRoot,
    });
  }

  // Find the seed directory
  const seedPath = resolveSeedPath();
  if (!seedPath) {
    return createError({
      code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
      message: 'Could not find rbook-seed directory. The Reasonbook package may be incomplete.',
      suggestion:
        'Ensure rbook-seed/ exists in the installed package root. If installed via npm, reinstall @aquex/reasonbook.',
    });
  }

  let rbookDir: string;
  let dbPath: string;
  try {
    const paths = resolveRecordPaths(projectRoot);
    const existing = fs.existsSync(paths.directory);
    rbookDir = existing ? paths.directory : path.join(projectRoot, RECORD_DIRECTORY);
    dbPath = existing ? paths.dbPath : path.join(rbookDir, 'db', DATABASE_FILE);
  } catch (error) {
    return createError({
      code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
      message: error instanceof Error ? error.message : String(error),
      suggestion: 'Finish or recover the migration with reasonbook migrate --apply before init.',
    });
  }
  // Whether the folder already held a Reasonbook layout; isNewProject also turns true below when only the
  // database is missing.
  const rbookExisted = fs.existsSync(rbookDir);
  let isNewProject = !rbookExisted;

  // What the folder's agents file says, read before anything is written.
  const lineReading = readRbookLine(projectRoot);

  // s95-m06: the level is settled before anything is written, because it decides which seed files
  // the project gets. The same order as the metadata write below: a passed level, else the tier an
  // existing store holds (none or an unknown one reads as Builder, as onboard reads it), else the
  // level a new store's agents file names, else a Ledger. It comes before the identity reads, whose
  // read-only opens leave -wal and -shm files, so its refusal leaves the folder as it found it.
  const storeExists = fs.existsSync(dbPath);
  const lineTier = lineReading?.level ? LEVEL_TIERS[lineReading.level] : null;
  // Probed whenever the store exists, a level passed or not: a store init cannot read is one it
  // cannot initialize, so it is refused before any file is written (the confirming critic).
  const stored = storeExists ? readStoredTier(dbPath) : null;
  if (stored && 'error' in stored) {
    return createError({
      code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
      message: `This folder's store exists but could not be read (${stored.error}), so init changed nothing.`,
      suggestion: `Make ${inertCliPath(path.dirname(dbPath))} and the store in it readable and writable; if the file is damaged, restore it from a backup or version control. Then run rbook_project(action="init", projectRoot=${inertCliPath(projectRoot)}) again.`,
    });
  }
  const fileTier = projectType ?? (stored ? stored.tier : (lineTier ?? 'general'));
  if (levelOfTier(fileTier) === 'ledger' && (initialSprint || initialMissions?.length)) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message:
        'A Ledger keeps no sprints or missions, so init was refused before it wrote anything: it was given an initial sprint or missions to create.',
      suggestion: `To start with them, init at the Builder level: rbook_project(action="init", projectRoot=${inertCliPath(projectRoot)}, projectType="build"), passing initialSprint and initialMissions as before; the Planner level (projectType="managed") keeps tasks in cycles. To keep a Ledger, init again without initialSprint and initialMissions.`,
      field: initialSprint ? 'initialSprint' : 'initialMissions',
    });
  }

  // s96-m01 (ADR s96 §3, §9): a copy of a shared record is checked before init writes anything,
  // and init seeds no sprint or mission into one: the sprint and mission tools number and record
  // them under the store's write lock.
  // The check opens the store read-only, so a refused init leaves it as it found it.
  let sharedCopy = false;
  if (storeExists) {
    const opened = await RbookDatabaseClient.create({
      dbPath,
      readonly: true,
      registerProject: false,
    });
    if (opened.success && opened.data) {
      try {
        const refused = replicaWriteRefusal(opened.data);
        if (refused) return createError(refused);
        sharedCopy = isSharedStore(opened.data);
      } finally {
        opened.data.close();
      }
    }
  }
  if (sharedCopy && (initialSprint || initialMissions?.length)) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message:
        'This project is shared, so init was refused before it wrote anything: it seeds no sprint or mission into a copy of a shared record.',
      suggestion:
        'Add the sprint with rbook_sprint(action="add") and the missions with rbook_mission(action="add"), which number and record them; init without initialSprint and initialMissions changes the rest as before.',
      field: initialSprint ? 'initialSprint' : 'initialMissions',
    });
  }

  // s93-m12 (the build critics' B1): a re-init keeps the identity the project already has, and
  // nothing is written before that is settled. The registry and the dashboard know a project by its
  // id, so an init that minted a new one refused every later write as an identity conflict. The id
  // is the store's own, else the one the registry holds for this folder when the folder already
  // holds its rbook/ layout (a store deleted and recreated through the DB_NOT_FOUND remedy, an id row
  // lost; a repository that tracks rbook/ without its database also counts), else the one passed,
  // else a new one. A folder with no rbook/ is a new project even at a registered project's old
  // path: that project moved or was deleted, and taking its id would leave two stores sharing one
  // (the second confirming critic), so its stale row is dropped at registration instead. A passed
  // id that differs from the project's is refused before the seed is copied or the schema runs.
  let graph: ProjectGraphRegistry | null = null;
  try {
    graph = await ProjectGraphRegistry.create();
  } catch {
    // Without the registry, the store's own id is all init can keep; the answer says so.
  }
  let registryProjectId: string | null = null;
  try {
    registryProjectId = graph?.getByStorePath(projectRoot) ?? null;
  } catch {
    registryProjectId = null;
  }
  const storeProjectId = readStoreIdentity(projectRoot)?.project_id ?? null;
  const reusableRegistryId = rbookExisted ? registryProjectId : null;
  const knownProjectId = storeProjectId ?? reusableRegistryId;
  // A store with no name takes the one the registry keeps for this project (a recreated store, a
  // name given only at registration), unless that is only the folder's name; never the name of a
  // registry row that holds another project's id.
  let registryName: string | undefined;
  try {
    registryName =
      reusableRegistryId && knownProjectId === reusableRegistryId
        ? graph?.get(reusableRegistryId)?.name
        : undefined;
  } catch {
    registryName = undefined;
  }
  const restoredName =
    registryName && registryName !== path.basename(path.resolve(projectRoot)) ? registryName : '';
  if (knownProjectId && providedProjectId && providedProjectId !== knownProjectId) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `This project's id is '${knownProjectId}'; init does not change it to '${providedProjectId}'.`,
      suggestion:
        'Re-run init without projectId (or with that id). A project keeps its id for life: the project registry and the dashboard know it by that id.',
      field: 'projectId',
      providedValue: providedProjectId,
    });
  }

  try {
    // s95-m06: the seed files this level gets; existing files are never overwritten or removed.
    const levelFiles = writeLevelFiles(projectRoot, fileTier, seedPath);
    const createdDirs = [...levelFiles.directories];
    const createdFiles = [...levelFiles.files];

    // Create fresh SQLite database if it doesn't exist
    const dbExisted = fs.existsSync(dbPath);
    if (!dbExisted) {
      isNewProject = true;
      const dbDir = path.join(rbookDir, 'db');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    // Sprint 70 m01: this raw open takes a caller-supplied projectRoot and is
    // WRITE-capable (creates/initializes the store), so a test calling
    // rbookProjectInit with the repo root would mutate the real dogfood store.
    // Guard it like the RbookDatabaseClient chokepoint. No-op outside Jest. (#754)
    assertJestDbPathIsolated(dbPath);
    const db = new Database(dbPath);

    try {
      enableWal(db, 5000);

      // Execute schema (all CREATE IF NOT EXISTS, safe on existing DB)
      db.exec(RBOOK_SCHEMA);
      // s96-m02: a new store records authors from its first row (ADR s96 §10).
      if (isNewProject)
        db.prepare(
          `INSERT OR IGNORE INTO metadata (key, value) VALUES ('${AUTHOR_NAMES_SINCE_KEY}', ?)`
        ).run(String(Date.now()));

      // Set project metadata
      const now = new Date().toISOString();
      const updateMetadata = db.prepare(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
      );

      const readMetadata = db.prepare('SELECT value FROM metadata WHERE key = ?');
      const stored = (key: string): string | undefined =>
        (readMetadata.get(key) as { value: string } | undefined)?.value;

      // A concurrent init can claim the id after this read. Only fill an absent or blank row,
      // then use the stored winner; replacing it would leave the two callers with different ids.
      const storedProjectId = stored('project_id')?.trim() || null;
      let projectId =
        storedProjectId ?? knownProjectId ?? (providedProjectId || crypto.randomUUID());
      if (!storedProjectId) {
        db.prepare(
          `INSERT INTO metadata (key, value) VALUES ('project_id', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE metadata.value IS NULL OR trim(metadata.value) = ''`
        ).run(projectId);
        projectId = stored('project_id')?.trim() || projectId;
      }
      if (providedProjectId && providedProjectId !== projectId) {
        db.close();
        return createError({
          code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
          message: `This project's id is '${projectId}'; init does not change it to '${providedProjectId}'.`,
          suggestion:
            'Re-run init without projectId (or with that id). A project keeps its id for life: the project registry and the dashboard know it by that id.',
          field: 'projectId',
          providedValue: providedProjectId,
        });
      }
      // A supplied name still wins; otherwise preserve a stored name or fill an unnamed store
      // from the registry, then its folder. Claim only the blank value we read, so a concurrent
      // explicit name is never replaced by the default. Shared identities change only through
      // the recorded paths, so an implicit default never changes a shared copy.
      let nameChanged = Boolean(projectName);
      if (projectName) {
        updateMetadata.run('project_name', projectName);
      } else if (!sharedCopy) {
        const previousName = stored('project_name');
        if (!previousName?.trim()) {
          nameChanged =
            db
              .prepare(
                `INSERT INTO metadata (key, value) VALUES ('project_name', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE metadata.value IS NULL OR metadata.value = ?`
              )
              .run(restoredName || path.basename(path.resolve(projectRoot)), previousName ?? '')
              .changes > 0;
        }
      }
      // A harmless shared re-init must not introduce an absent recorded identity key.
      if (tracelabProjectId || (!sharedCopy && stored('tracelab_project_id') === undefined)) {
        updateMetadata.run('tracelab_project_id', tracelabProjectId);
      }
      const currentSchemaVersion = (
        readMetadata.get('schema_version') as { value: string } | undefined
      )?.value;
      const currentVersionParts = /^(\d+)\.(\d+)$/.exec(currentSchemaVersion ?? '');
      const bundledVersionParts = /^(\d+)\.(\d+)$/.exec(RBOOK_SCHEMA_VERSION)!;
      const currentVersionIsLower =
        !currentVersionParts ||
        Number(currentVersionParts[1]) < Number(bundledVersionParts[1]) ||
        (Number(currentVersionParts[1]) === Number(bundledVersionParts[1]) &&
          Number(currentVersionParts[2]) < Number(bundledVersionParts[2]));
      if (currentVersionIsLower) {
        // The read is only a fast path. Re-check the row in the mutation so a concurrent init or
        // migration cannot raise the label between these statements and then be overwritten here.
        db.prepare(
          `INSERT OR REPLACE INTO metadata (key, value)
           SELECT ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM metadata
             WHERE key = ?
               AND value <> ''
               AND value NOT GLOB '*[^0-9.]*'
               AND length(value) - length(replace(value, '.', '')) = 1
               AND instr(value, '.') > 1
               AND instr(value, '.') < length(value)
               AND (
                 CAST(substr(value, 1, instr(value, '.') - 1) AS INTEGER) > ${Number(bundledVersionParts[1])}
                 OR (
                   CAST(substr(value, 1, instr(value, '.') - 1) AS INTEGER) = ${Number(bundledVersionParts[1])}
                   AND CAST(substr(value, instr(value, '.') + 1) AS INTEGER) >= ${Number(bundledVersionParts[2])}
                 )
               )
           )`
        ).run('schema_version', RBOOK_SCHEMA_VERSION, 'schema_version');
      }

      // s83-m05: persist the tier/type so onboard's tierSelectionPrompt and
      // getProjectType read the operator's choice. An explicit projectType always
      // wins. s93-m12 (#1185): a brand-new project with no explicit choice is a Ledger
      // ('general'), a stranger's default; getProjectType still reads a store with no
      // row at all as 'build', the tier such a store has always had. An idempotent
      // re-init WITHOUT projectType leaves any existing project_type row untouched
      // so a later rbook_project(update) is not clobbered.
      // s93-m12 (the confirming critics): with no level passed, a new store takes the level its
      // folder's agents file names in its Reasonbook line (a store recreated beside the file, or a team's
      // committed AGENTS.md), so the store and the file agree; with no such line a new project is a
      // Ledger. The answer names the chosen level; the line cannot establish a hook preference.
      const lineLevel = dbExisted ? null : (lineReading?.level ?? null);
      let levelSource: InitLevelSource = 'stored';
      if (projectType) {
        updateMetadata.run('project_type', projectType);
        levelSource = 'passed';
      } else if (lineLevel) {
        updateMetadata.run('project_type', LEVEL_TIERS[lineLevel]);
        levelSource = 'agents-file';
      } else if (isNewProject) {
        updateMetadata.run('project_type', 'general');
        levelSource = 'default';
      }
      // A committed agents file cannot prove this operator's hook preference, even when a
      // registry id survives git clean or re-cloning into the same folder. A recreated store
      // keeps the hooks on; the mismatch below offers an explicit, project-scoped opt-out.

      if (isNewProject) {
        updateMetadata.run('created_at', now);
      }
      // A re-init that renames the project, fills an old missing name, or changes its level says
      // so wherever the identity is kept, not only in metadata.
      if (dbExisted && (nameChanged || projectType)) {
        syncIdentityContexts(db, { syncName: nameChanged, tier: projectType }, now);
      }

      // Initialize contexts if they don't exist
      const existingProjectContext = db
        .prepare('SELECT id FROM contexts WHERE id = ?')
        .get('project_context');

      if (!existingProjectContext) {
        // Read from the seed's context file
        const seedProjectContext = path.join(seedPath, 'context', 'project_context.json');
        let contextContent = '{}';
        if (fs.existsSync(seedProjectContext)) {
          contextContent = fs.readFileSync(seedProjectContext, 'utf-8');
        }

        db.prepare(
          'INSERT OR IGNORE INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
        ).run('project_context', 'rbook/context/project_context.json', contextContent, now);
      }

      const existingMasterContext = db
        .prepare('SELECT id FROM contexts WHERE id = ?')
        .get('master_context');

      if (!existingMasterContext) {
        // Read from the seed's context file and inject project name
        const seedMasterContext = path.join(seedPath, 'context', 'master_context.json');
        let masterObj: Record<string, unknown> = {};
        if (fs.existsSync(seedMasterContext)) {
          try {
            masterObj = JSON.parse(fs.readFileSync(seedMasterContext, 'utf-8'));
          } catch {
            masterObj = {};
          }
        }
        // Read the winning name under the same lock as the insert: a concurrent explicit
        // rename must not leave a newly seeded context carrying an earlier default.
        db.transaction(() => {
          masterObj.project_identity = {
            name: stored('project_name') ?? '',
            description: '',
            status: 'active_development',
          };
          db.prepare(
            'INSERT OR IGNORE INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
          ).run(
            'master_context',
            'rbook/context/master_context.json',
            JSON.stringify(masterObj),
            now
          );
        }).immediate();
      }

      // Create initial sprint if provided
      let sprintCreated: string | undefined;
      if (initialSprint) {
        const existingSprint = db
          .prepare('SELECT id FROM sprints WHERE id = ?')
          .get(initialSprint.id);

        if (!existingSprint) {
          // s96-m01: stamped here, so every copy of this store gives the row one stable id.
          const g = rawGenesisColumns(db, 'sprints', projectId);
          db.prepare(
            `INSERT INTO sprints (id, title, focus, status, start_date${g.columns.length ? `, ${g.columns.join(', ')}` : ''})
             VALUES (?, ?, ?, ?, ?${g.columns.length ? `, ${g.placeholders}` : ''})`
          ).run(
            initialSprint.id,
            initialSprint.title,
            initialSprint.focus || null,
            initialSprint.status || 'Active',
            now.split('T')[0],
            ...g.values
          );
          sprintCreated = initialSprint.id;
        }
      }

      // Create initial missions if provided
      const missionsCreated: string[] = [];
      const missionWarnings: string[] = [];
      if (initialMissions && initialMissions.length > 0) {
        // s96-m01: the stamp's columns shape the statement; each mission takes its own stamp below.
        const g = rawGenesisColumns(db, 'missions', projectId);
        const insertMission = db.prepare(
          `INSERT OR IGNORE INTO missions
           (id, sprint_id, name, status, objective, success_criteria, deliverables${g.columns.length ? `, ${g.columns.join(', ')}` : ''})
           VALUES (?, ?, ?, ?, ?, ?, ?${g.columns.length ? `, ${g.placeholders}` : ''})`
        );

        for (const mission of initialMissions) {
          let assignedSprintId = mission.sprintId?.trim() ?? null;
          if (mission.sprintId === undefined) {
            const open = db
              .prepare(
                `SELECT id FROM sprints WHERE ${statusInSql('status', SPRINT_OPEN_STATUSES)}`
              )
              .all() as { id: string }[];
            if (open.length === 1) assignedSprintId = open[0].id;
            else if (open.length > 1)
              missionWarnings.push(
                `Multiple sprints are open; mission '${mission.id}' is unscheduled.`
              );
          }
          if (
            assignedSprintId !== null &&
            !db.prepare('SELECT id FROM sprints WHERE id=?').get(assignedSprintId)
          ) {
            throw new Error(
              `Sprint '${assignedSprintId}' does not exist for mission '${mission.id}'.`
            );
          }
          // s96-m01: each mission is stamped at its insert, as the sprint above is.
          const stamp = rawGenesisColumns(db, 'missions', projectId);
          const result = insertMission.run(
            mission.id,
            assignedSprintId,
            mission.name,
            mission.status || 'Queued',
            mission.objective || null,
            mission.successCriteria ? JSON.stringify(mission.successCriteria) : null,
            mission.deliverables ? JSON.stringify(mission.deliverables) : null,
            ...stamp.values
          );

          if (result.changes > 0) {
            missionsCreated.push(mission.id);
          }
        }
      }

      if (!dbExisted) {
        createdFiles.push(path.relative(rbookDir, dbPath));
      }

      const storedSchemaVersion = (
        readMetadata.get('schema_version') as { value: string } | undefined
      )?.value;
      // s93-m12: the rules files name the project's level, so they are written once the tier is
      // stored: the one asked for, or the one an existing store already has.
      // s95-m06: read as readProjectTier reads it (trimmed, else the identity's tier), so the rules
      // files name the level whose files init just wrote.
      const storedTier = storeTier(db);
      const storedName = stored('project_name');
      const storedAmbient = asRulesAmbient(stored(AMBIENT_METADATA_KEY));
      db.close();

      const agents = ensureAgentsMd(projectRoot, seedPath, {
        level: levelOfTier(storedTier),
        projectName: storedName || path.basename(projectRoot),
        hooks: internalOpts.hooks !== false,
        ambient: storedAmbient,
      });
      if (agents.written) createdFiles.push(path.join('..', AGENTS_FILE_NAME));
      // s93-m12 (the build critic): what init leaves undone is said, never silently skipped.
      const rulesWarnings: string[] = [];
      // s95-m06 (the build critic): a README replaced for the level is said, as update says it.
      const readme = readmeNote(levelFiles);
      if (readme) rulesWarnings.push(readme);
      // s93-m12 (the confirming critics): a re-init that passes a level moves an existing agents
      // file's Reasonbook line with it, as rbook_project(action="update") does, and says so, or says what
      // it left (a line edited by hand, a read-only file). Without a level, a line that names
      // another level or hooks setting than the store holds is pointed out, not changed.
      const storedLevel = levelOfTier(storedTier);
      if (!agents.written && projectType) {
        const note = describeRbookLineRefresh(
          refreshRbookLine(projectRoot, { level: storedLevel, ambient: storedAmbient })
        );
        if (note) rulesWarnings.push(note);
      } else if (
        !agents.written &&
        lineReading &&
        (lineReading.level !== storedLevel ||
          (lineReading.hooks && lineReading.ambient !== storedAmbient))
      ) {
        rulesWarnings.push(
          rbookLineMismatch(
            lineReading,
            storedLevel,
            storedAmbient,
            projectRoot,
            internalOpts.cliSource
          )
        );
      }
      if (!storeProjectId && reusableRegistryId && projectId === reusableRegistryId) {
        rulesWarnings.push(
          `This folder had no stored id, so init took back the id the project registry holds for it ('${projectId}'), as for a store that was deleted and recreated. If a project that moved elsewhere still uses that id, its writes will now be refused: to give this folder its own id instead, delete rbook/db/rbook.sqlite here, run rbook_project(action="unregister", projectRoot="${projectRoot}"), and init again.`
        );
      }
      if (!graph) {
        rulesWarnings.push(
          `The project registry could not be read, so init neither checked the id it holds for this folder nor registered the project. Once it can be read, rbook_project(action="register", projectRoot="${projectRoot}") registers it; if the registry holds another id for this folder, that register is refused, and rbook_project(action="unregister", projectRoot="${projectRoot}") must come first.`
        );
      }
      if (storeProjectId && registryProjectId && storeProjectId !== registryProjectId) {
        rulesWarnings.push(
          `This store's project id is '${storeProjectId}', but the project registry holds '${registryProjectId}' for this folder, so writes here are refused as an identity conflict until they agree. If '${registryProjectId}' belonged to a project that has moved away, rbook_project(action="unregister", projectRoot="${projectRoot}") and then rbook_project(action="register", projectRoot="${projectRoot}") register this folder under '${storeProjectId}'.`
        );
      }
      if (!agents.written && internalOpts.hooks === false) {
        rulesWarnings.push(
          `${agents.name} already exists, so the hook-less block was not added; append rbook/templates/${NO_HOOKS_TEMPLATE} to it by hand.`
        );
      }
      if (ensureClaudeMd(projectRoot, seedPath, agents.name)) {
        createdFiles.push(path.join('..', 'CLAUDE.md'));
      } else if (!claudeMdImports(projectRoot, agents.name)) {
        rulesWarnings.push(
          `CLAUDE.md does not import ${agents.name}, so Claude Code does not read it; add the line "@${agents.name}" to CLAUDE.md.`
        );
      }

      const result: RbookProjectInitResult = {
        rbookDirectory: rbookDir,
        databasePath: dbPath,
        isNewProject,
        projectId,
        projectName: projectName || storedName || '(not set)',
        level: storedLevel,
        levelSource,
        schemaVersion: storedSchemaVersion ?? RBOOK_SCHEMA_VERSION,
        created: {
          directories: createdDirs,
          files: createdFiles,
        },
        sprintCreated,
        missionsCreated: missionsCreated.length > 0 ? missionsCreated : undefined,
      };

      // Auto-register the project into the project-graph registry (s79-m02, the
      // sole discovery store). Clear the detector cache first so a stale negative
      // result (from any pre-init tool call on this path) doesn't cause registration
      // to fail. The store was just created with a UUID project_id, so registerStore
      // reuses that id. (s80-m02: no JSON mirror to re-derive — graph is the source.)
      const warnings: string[] = [...rulesWarnings, ...missionWarnings];
      if (graph) {
        try {
          RbookDetector.getInstance().clearCache(projectRoot);
          // A new project at a registered project's old path: that project moved or was deleted,
          // so its row goes. By id, not by path: the registry's default, if it was that project,
          // points at it again when it registers at its new path on its next write.
          if (!rbookExisted && registryProjectId && registryProjectId !== projectId) {
            graph.unregister(registryProjectId);
            warnings.push(
              `The project registry held '${registryProjectId}' for this folder, a project that has since moved or been deleted; that entry was dropped, and the project registers again wherever it is on its next write.`
            );
          }
          graph.registerStore(projectRoot, {
            name: projectName || undefined,
            confirmedCopy: sharedCopy,
          });
          // s93-m11 (#606 f): the same warning register gives for a temporary folder.
          if (graph.isEphemeral(path.resolve(projectRoot))) {
            warnings.push(
              `${path.resolve(projectRoot)} is in an ephemeral location; rbook_project(action="validate", prune=true) archives it even while the store exists.`
            );
          }
        } catch (registrationError) {
          // Init succeeded; registration did not, and the answer says so, with a remedy only where
          // one works: a store copied from another project carries that project's id, which the
          // registry keeps at one place (the fourth confirming critic).
          const message =
            registrationError instanceof Error
              ? registrationError.message
              : String(registrationError);
          let original: string | undefined;
          if (message.startsWith('Project identity collision:')) {
            try {
              original = graph.get(projectId)?.store_path;
            } catch {
              // Registration has already failed; a second registry read must not undo init.
            }
          }
          const sameFolder = original && sameInitFolder(original, projectRoot);
          warnings.push(
            sameFolder
              ? `The registry path ${inertCliPath(original!)} and ${inertCliPath(projectRoot)} name the same physical folder; this is a path alias, not a copied project. Registration did not finish (${inertCliPath(message)}); retry rbook_project(action="register", projectRoot=${inertCliPath(original!)}).`
              : original
                ? `This store holds the id '${projectId}' of the project at ${inertCliPath(original)}: it is a copy of that project, so it was not registered here, and writes here are refused while that project stays registered. ${fs.existsSync(original) ? 'Reasonbook keeps one place per project, so a copy of a live project cannot be registered beside it.' : `That folder no longer exists: rbook_project(action="unregister", projectRoot=${inertCliPath(original)}) and then rbook_project(action="register", projectRoot=${inertCliPath(projectRoot)}) register the project here.`}`
                : `The project was not registered (${inertCliPath(message)}); rbook_project(action="register", projectRoot=${inertCliPath(projectRoot)}) registers it.`
          );
        }
      }

      return createSuccess(result, warnings);
    } catch (dbError) {
      db.close();
      throw dbError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createError({
      code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
      message: `Failed to initialize Reasonbook project: ${message}`,
      suggestion: 'Check file permissions and ensure the directory is writable.',
    });
  }
}

/**
 * Format initialization result for LLM readability.
 */
export function formatProjectInitForLLM(result: RbookToolResult<RbookProjectInitResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Reasonbook Project Initialization Failed',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    data.isNewProject ? 'Reasonbook Project Initialized' : 'Reasonbook Project Updated',
    '',
    `**Project ID**: ${data.projectId}`,
    `**Project Name**: ${data.projectName}`,
    `**Level**: ${levelName(data.level)} (${LEVEL_SOURCE_TEXT[data.levelSource]})`,
    `**Schema Version**: ${data.schemaVersion}`,
    '',
    `**Database**: ${data.databasePath}`,
  ];

  if (data.created.directories.length > 0 || data.created.files.length > 0) {
    lines.push('');
    lines.push('**Created**:');
    data.created.directories.forEach((dir) => lines.push(`  - ${dir}`));
    data.created.files.forEach((file) => lines.push(`  - ${file}`));
  }

  if (data.sprintCreated) {
    lines.push('');
    lines.push(`**Initial Sprint**: ${data.sprintCreated}`);
  }

  if (data.missionsCreated && data.missionsCreated.length > 0) {
    lines.push('');
    lines.push('**Initial Missions**:');
    data.missionsCreated.forEach((m) => lines.push(`  - ${m}`));
  }

  lines.push('');
  lines.push('Next: Run rbook_agent_onboard to get project context');

  appendWarnings(lines, result);

  return lines.join('\n');
}

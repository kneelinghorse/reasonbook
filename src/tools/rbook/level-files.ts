// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m06 — the seed files each level gets: Ledger and Planner get no Builder documents.
// ABOUTME: Writes only missing files, and replaces a README only while it is exactly what Reasonbook wrote.

import * as fs from 'fs';
import * as path from 'path';
import { LEGACY, resolveRecordPaths } from '../../intelligence/legacy-compat';
import { RECORD_DIRECTORY } from '../../intelligence/product-names';

import { levelName, levelOfTier, PROJECT_LEVELS, type ProjectLevel } from './rules-files';

/**
 * Resolve the path to the rbook-seed directory: `<package root>/rbook-seed/`, found from `dist/` or
 * `src/` at any of the depths these modules are compiled to.
 */
export function resolveSeedPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../rbook-seed'), // from dist/tools/rbook or src/tools/rbook
    path.resolve(__dirname, '../../rbook-seed'), // from dist/tools or src/tools
    path.resolve(__dirname, '../rbook-seed'), // from dist or src
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'db', 'schema.sql'))) return candidate;
  }
  return null;
}

/** The README a lower level gets in place of the seed's own, which describes the Builder seed. */
const LEVEL_README: Readonly<Partial<Record<ProjectLevel, string>>> = {
  ledger: 'templates/README-ledger.md',
  planner: 'templates/README-planner.md',
};

// npm omits .gitignore files, so this source ships under a non-dotfile name.
const IGNORE_TEMPLATE = 'templates/gitignore-rbook';

function readmeSource(seedPath: string, level: ProjectLevel): string {
  return path.join(seedPath, LEVEL_README[level] ?? 'README.md');
}

/**
 * Whether a seed file (a path relative to the seed root, with forward slashes) belongs in a project
 * at this level. The seed's quick starts, guides and templates teach sprints and missions (#1219), so
 * only a Builder gets them, and the Builder guide (tiers/build.md) is one of them. The README templates
 * are sources: they are rendered to rbook/README.md, never copied as themselves.
 */
export function seedFileForLevel(level: ProjectLevel, rel: string): boolean {
  if (rel === 'README.md' || rel === IGNORE_TEMPLATE || /^templates\/README-[a-z]+\.md$/.test(rel))
    return false;
  if (level === 'builder') return true;
  if (
    rel.startsWith('docs/') ||
    rel.startsWith('foundational-docs/') ||
    rel === 'tiers/build.md' ||
    rel === 'templates/PROJECT-README-template.md'
  ) {
    return false;
  }
  return level === 'planner' || rel !== 'tiers/managed.md';
}

/** What a level's write created, relative to rbook/: filled as it goes, so a failure still says. */
export interface CreatedFiles {
  readonly directories: string[];
  readonly files: string[];
}

/**
 * Recursively copy the seed files `include` accepts, in name order, skipping files that already
 * exist at the destination. Records the created directories and files (relative to `relativeTo`)
 * in `created` as it goes.
 */
export function copySeedDir(
  srcDir: string,
  destDir: string,
  relativeTo: string,
  include: (rel: string) => boolean = () => true,
  seedRoot: string = srcDir,
  created: CreatedFiles = { directories: [], files: [] }
): CreatedFiles {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    created.directories.push(path.relative(relativeTo, destDir) + '/');
  }

  const entries = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    // Skip .DS_Store, __pycache__, and SQLite runtime artifacts (we create the DB fresh).
    // -wal and -shm are runtime artifacts of WAL mode that have no business in a seed —
    // when they leak through, sqlite can recover stale state into the new DB.
    if (
      entry.name === '.DS_Store' ||
      entry.name === '__pycache__' ||
      [LEGACY.databaseFile, 'rbook.sqlite'].some((database) =>
        [database, `${database}-wal`, `${database}-shm`].includes(entry.name)
      )
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      // A folder none of whose files this level gets is not created for it.
      if (!includesAny(srcPath, include, seedRoot)) continue;
      copySeedDir(srcPath, destPath, relativeTo, include, seedRoot, created);
    } else if (include(seedRel(seedRoot, srcPath)) && !fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
      created.files.push(path.relative(relativeTo, destPath));
    }
  }

  return created;
}

function seedRel(seedRoot: string, file: string): string {
  return path.relative(seedRoot, file).split(path.sep).join('/');
}

function includesAny(dir: string, include: (rel: string) => boolean, seedRoot: string): boolean {
  return fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
    if (e.name === '.DS_Store' || e.name === '__pycache__') return false;
    const full = path.join(dir, e.name);
    return e.isDirectory()
      ? includesAny(full, include, seedRoot)
      : include(seedRel(seedRoot, full));
  });
}

/** Create `file` only if nothing is there; false when a file already is (a race included). */
function writeExclusive(file: string, text: string): boolean {
  try {
    fs.writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** What happened to rbook/README.md. */
export type LevelReadme = 'written' | 'replaced' | 'kept';

export interface LevelFiles {
  readonly level: ProjectLevel;
  /** Created directories and files, relative to rbook/. */
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly readme: LevelReadme;
}

/**
 * Write the files a project at this tier gets that it does not have yet. Never deletes a file and
 * never overwrites one, with one exception: a rbook/README.md that is byte for byte the README Reasonbook
 * writes for another level is replaced by this level's, so a change of level, up or down, does not
 * leave a README that describes the level the project left. An unknown or missing tier reads as
 * Builder. `created` records what was written as it goes, so a caller can report it after a failure.
 */
export function writeLevelFiles(
  projectRoot: string,
  tier: string | null | undefined,
  seedPath: string,
  created: CreatedFiles = { directories: [], files: [] }
): LevelFiles {
  const level = levelOfTier(tier);
  const resolved = resolveRecordPaths(projectRoot);
  const rbookDir = fs.existsSync(resolved.directory)
    ? resolved.directory
    : path.join(projectRoot, RECORD_DIRECTORY);
  copySeedDir(
    seedPath,
    rbookDir,
    rbookDir,
    (rel) => seedFileForLevel(level, rel),
    seedPath,
    created
  );

  if (
    writeExclusive(
      path.join(rbookDir, '.gitignore'),
      fs.readFileSync(path.join(seedPath, IGNORE_TEMPLATE), 'utf8')
    )
  ) {
    created.files.push('.gitignore');
  }

  const readmeText = fs.readFileSync(readmeSource(seedPath, level), 'utf8');
  const readmePath = path.join(rbookDir, 'README.md');
  let readme: LevelReadme;
  if (writeExclusive(readmePath, readmeText)) {
    readme = 'written';
    created.files.push('README.md');
  } else {
    const current = fs.readFileSync(readmePath, 'utf8');
    const another = PROJECT_LEVELS.some(
      (other) =>
        other !== level && current === fs.readFileSync(readmeSource(seedPath, other), 'utf8')
    );
    if (another && current !== readmeText) {
      fs.writeFileSync(readmePath, readmeText);
      readme = 'replaced';
    } else {
      readme = 'kept';
    }
  }
  return { level, directories: created.directories, files: created.files, readme };
}

/** The answer's note when rbook/README.md was replaced for the new level, else null. */
export function readmeNote(files: LevelFiles): string | null {
  return files.readme === 'replaced'
    ? `rbook/README.md was the unedited README Reasonbook writes for another level, so it was replaced with the ${levelName(files.level)} level's.`
    : null;
}

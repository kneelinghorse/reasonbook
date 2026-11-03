// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps every ignored file ignored through a move off cmos/: anchored rbook/ twins of the ignore lines
// ABOUTME: naming the folder, judged before the rename by each file's deciding rule, in the move and its dry run.
import fs from 'fs';
import path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';
import {
  folderOnDisk,
  git,
  gitContext,
  literal,
  nulPaths,
  runGit,
  stagedEntries,
  type GitContext,
} from './migrate-git';
import { assertIgnoreSourcesOutside } from './migrate-ignore-sources';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STORE = new RegExp(`db/${escape(LEGACY.databaseFile)}`, 'i');
/** The lines migrate appends to the record's own .gitignore, as 4.10.0 did (migrate-store.ts:265-276). */
const MIGRATE_LINES = [
  'db/*.sqlite',
  'db/*.sqlite-wal',
  'db/*.sqlite-shm',
  'db/snapshots/pre-migrate-*.sqlite',
];

/**
 * migrate's edit of the record's own .gitignore, one function wherever it is applied: the working
 * tree, the dry run's temporary repository and the index blob. A negation keeps its words: rewritten,
 * !db/cmos.sqlite.bak would re-include every db/*.sqlite.bak (round 8, note 1). db/snapshots/ joins,
 * as the seed has it, only when no file under it is tracked (settled item 8).
 */
export function recordIgnoreEdit(original: string, trackedSnapshots: boolean): string {
  let updated = original
    .split('\n')
    .map((line) =>
      line.startsWith('!') ? line : line.split(`db/${LEGACY.databaseFile}`).join('db/*.sqlite')
    )
    .join('\n');
  // Last matching rule wins: an earlier copy may be followed by a negation.
  for (const pattern of [...MIGRATE_LINES, ...(trackedSnapshots ? [] : ['db/snapshots/'])])
    updated += `${updated && !updated.endsWith('\n') ? '\n' : ''}${pattern}\n`;
  return updated;
}

/**
 * A .gitignore's text with an anchored rbook/ twin after each line naming the record folder at rel,
 * its path from the file's folder: after an optional ! and an optional / or **\/, the folder followed
 * by / or the line's end. The original stays, so another folder named cmos keeps its rules; the twin
 * keeps a !, is anchored to the file's folder, and a line naming the store gets a second twin with
 * the store's new name. A twin already present right after its line is not added again (settled
 * item 8); one elsewhere in the file does not count, since rules apply in order (build critic B,
 * round 1, note 3).
 */
export function twinsOf(
  text: string,
  rel: string,
  ignorecase: boolean
): { text: string; added: string[] } {
  // Critic B round 1: the text is read as latin1, so rel is matched and written as its UTF-8 bytes.
  rel = Buffer.from(rel, 'utf8').toString('latin1');
  const predicate = new RegExp(
    `^(!?)(?:/|\\*\\*/)?${escape(rel)}(/|$)(.*)$`,
    ignorecase ? 'i' : ''
  );
  const anchor = [...rel.split('/').slice(0, -1), 'rbook'].join('/');
  const lines = text.split('\n');
  const out: string[] = [];
  const added: string[] = [];
  for (const [index, line] of lines.entries()) {
    out.push(line);
    // git skips a UTF-8 byte-order mark before the first line.
    const match = predicate.exec(index === 0 ? line.replace(/^\u00ef\u00bb\u00bf/, '') : line);
    if (!match) continue;
    const [, bang, slash, rest] = match;
    const forms = [`${bang}/${anchor}${slash}${rest}`];
    if (STORE.test(rest))
      forms.push(`${bang}/${anchor}${slash}${rest.replace(STORE, 'db/rbook.sqlite')}`);
    const following = lines.slice(index + 1, index + 1 + forms.length);
    for (const form of forms)
      if (!following.includes(form)) {
        out.push(form);
        added.push(form);
      }
  }
  return { text: out.join('\n'), added };
}

export interface ChainFile {
  readonly file: string;
  /** Its folder from the top level, with a trailing slash, or ''. */
  readonly dirRel: string;
  /** The record folder's path from its folder. */
  readonly rel: string;
  /** Read as latin1, so every byte comes back as it was; null when it is not a regular file. */
  readonly before: string | null;
  readonly after: string | null;
  readonly added: string[];
}

export interface IgnorePlan {
  readonly git: GitContext | null;
  /** The old folder's spelling on disk. */
  readonly folder: string;
  readonly trackedSnapshots: boolean;
  /** The project root's .gitignore and each above it to the top level, never a subfolder's. */
  readonly chain: readonly ChainFile[];
  readonly left: string[];
}

function chainOf(root: string, folder: string, context: GitContext | null): ChainFile[] {
  const read = (file: string, dirRel: string, rel: string): ChainFile | null => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) return { file, dirRel, rel, before: null, after: null, added: [] };
    const before = fs.readFileSync(file, 'latin1');
    const twins = twinsOf(before, rel, context?.ignorecase ?? false);
    return { file, dirRel, rel, before, after: twins.text, added: twins.added };
  };
  if (!context)
    return [read(path.join(root, '.gitignore'), '', folder)].filter(Boolean) as ChainFile[];
  const chain: ChainFile[] = [];
  for (let dirRel = context.prefix; ; dirRel = dirRel.replace(/[^/]+\/$/, '')) {
    const link = read(
      path.join(context.top, dirRel, '.gitignore'),
      dirRel,
      context.prefix.slice(dirRel.length) + folder
    );
    if (link) chain.push(link);
    if (!dirRel) break;
  }
  return chain;
}

/**
 * What a move off the old folder does to git's ignore rules, read before any write. It refuses a
 * folder holding a submodule (A4, note 5) and an ignore source git reads from a file inside the
 * folder, which the rename would take away (round 8, B1); a git that cannot run in a work tree
 * refuses inside gitContext.
 */
export function planIgnores(
  root: string,
  env: NodeJS.ProcessEnv,
  /**
   * A retry, after the folder moved: the twins only, under the old folder's spelling the marker kept;
   * the refusals are for a move still to make, and would stop the index step it owes.
   */
  retry?: { readonly folder: string }
): IgnorePlan {
  const folder = retry?.folder ?? folderOnDisk(root);
  const context = gitContext(root, env);
  const chain = chainOf(root, folder, context);
  const left: string[] = [];
  for (const link of chain)
    if (link.before === null && link.added.length === 0 && fs.lstatSync(link.file).isSymbolicLink())
      left.push(
        `${link.file} is a symlink, which git does not read as a .gitignore; migrate did not write through it.`
      );
  if (!context || retry) return { git: context, folder, trackedSnapshots: false, chain, left };
  const old = context.prefix + folder;
  const staged = stagedEntries(context, literal(old));
  const gitlink = staged.find((entry) => entry.mode === '160000');
  if (gitlink)
    throw new Error(
      `Refusing migration because ${old}/ holds a submodule, ${gitlink.path}: renaming its folder would break the submodule's link to its repository, and no retry could finish the move. Move the submodule out of the record folder first; nothing was moved.`
    );
  assertIgnoreSourcesOutside(context, root, folder, left);
  const trackedSnapshots = staged.some((entry) => entry.path.startsWith(`${old}/db/snapshots/`));
  if (trackedSnapshots)
    left.push(
      `${old}/db/snapshots/ holds tracked files, so migrate did not add db/snapshots/ to the record's .gitignore; its own backups stay ignored by db/snapshots/pre-migrate-*.sqlite.`
    );
  else {
    // The seed's line hides snapshots git sees now; they are named (build critic B, round 1, note 5).
    const visible = nulPaths(
      git(
        context.top,
        ['ls-files', '-o', '--exclude-standard', '-z', '--', literal(`${old}/db/snapshots`)],
        context.env
      )
    );
    if (visible.length)
      left.push(
        `migrate adds db/snapshots/ to the record's .gitignore, as the seed has it, so ${visible.length} untracked file(s) git sees there now become ignored: ${visible.slice(0, 10).join(', ')}${visible.length > 10 ? ', …' : ''}. Track any you mean to keep in git before you commit.`
      );
  }
  // s109-m01: SQLite deletes a WAL store's -wal and -shm when the move takes it out of WAL, and the
  // moved store's come back under its new name; one of this Mac's repositories tracks them.
  const sidecars = staged.filter((entry) =>
    ['-wal', '-shm'].some((suffix) => entry.path === `${old}/db/${LEGACY.databaseFile}${suffix}`)
  );
  if (sidecars.length)
    left.push(
      `git tracks the store's SQLite sidecars (${sidecars.map((entry) => entry.path).join(', ')}), which SQLite deletes when the move takes the store out of WAL, so the next git commit -a or git add -A records their deletion. Stop tracking them with git rm --cached; the moved record's .gitignore ignores the new ones.`
    );
  return { git: context, folder, trackedSnapshots, chain, left };
}

/**
 * Verifier B round 2: a .gitignore is replaced whole, through a temporary file renamed over it with its
 * mode, so a process killed mid-write leaves its old bytes or its new ones, never an empty file.
 */
function replaceFile(file: string, text: string): void {
  // A file the owner cannot write still refuses, as an in-place write would.
  fs.accessSync(file, fs.constants.W_OK);
  const temporary = `${file}.rbook-${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'latin1');
  fs.chmodSync(temporary, fs.statSync(file).mode & 0o7777);
  fs.renameSync(temporary, file);
}

export interface WrittenTwins {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Writes the twins planned for each regular .gitignore, after comparing it with what the plan read,
 * so a concurrent edit is never written over (settled item 8).
 */
export function writeTwins(plan: IgnorePlan): WrittenTwins[] {
  const due = plan.chain.filter(
    (link): link is ChainFile & { before: string; after: string } =>
      link.before !== null && link.after !== null && link.added.length > 0
  );
  // Every file is compared before any is written, so a refusal leaves none twinned (build critic B,
  // round 1, note 4).
  for (const link of due)
    if (fs.readFileSync(link.file, 'latin1') !== link.before)
      throw new Error(
        `${link.file} changed while migrate was moving the record; nothing was moved. Retry once it is saved.`
      );
  const written: WrittenTwins[] = [];
  try {
    for (const link of due) {
      replaceFile(link.file, link.after);
      written.push({ file: link.file, before: link.before, after: link.after });
    }
  } catch (error) {
    // A write that fails puts back the files written before it (round-2 verifier B, note 3); the
    // refusal keeps its own cause and names any file it could not put back (round 3, note 2).
    let left: string[];
    try {
      left = restoreTwins(written);
    } catch (restore) {
      left = [`migrate could not put back the files it had twinned: ${(restore as Error).message}`];
    }
    throw left.length ? new Error([(error as Error).message, ...left].join(' ')) : error;
  }
  return written;
}

/** A twin as the owner reads it: the file's bytes, which are UTF-8, decoded. */
export const shown = (line: string): string => Buffer.from(line, 'latin1').toString('utf8');

/** Puts back each file's bytes from before its twins, unless it changed since; returns what was left. */
export function restoreTwins(written: readonly WrittenTwins[]): string[] {
  const left: string[] = [];
  for (const { file, before, after } of written) {
    if (fs.readFileSync(file, 'latin1') === after) replaceFile(file, before);
    else
      left.push(
        `${file} changed after migrate added its rbook/ lines, so migrate left it as it is; remove those lines, since the record did not move.`
      );
  }
  return left;
}

const toNul = (paths: readonly string[]) => (paths.length ? `${paths.join('\0')}\0` : '');

/** The record folder's path from the top level, mapped to its new one; the store gets its new name. */
function mapNew(file: string, prefix: string, old: string): string {
  const rel = file.slice(old.length + 1);
  return `${prefix}rbook/${rel === `db/${LEGACY.databaseFile}` ? 'db/rbook.sqlite' : rel}`;
}

/**
 * The deciding-rule backstop (settled item 8): of the ignored untracked files under the old folder,
 * one whose deciding rule sits in a .gitignore inside the folder moves with it and stays ignored;
 * any other must be ignored at its new path by the rules there. A file whose rule -v cannot name
 * counts as outside. The store is also judged by its new name under the old folder, where the
 * record's own rules apply. `where` holds the rules: the live tree, or the dry run's repository.
 */
export function judge(
  where: string,
  context: GitContext,
  old: string,
  listed: readonly string[]
): string[] {
  const verbose = runGit(
    where,
    ['check-ignore', '-v', '--no-index', '--stdin', '-z'],
    context.env,
    toNul(listed)
  );
  if (verbose.status !== 0 && verbose.status !== 1)
    throw new Error(`git check-ignore failed in ${where}: ${verbose.stderr.trim().split('\n')[0]}`);
  const fields = Buffer.from(verbose.stdout, 'latin1').toString('utf8').split('\0');
  const source = new Map<string, string>();
  for (let i = 0; i + 3 < fields.length; i += 4) source.set(fields[i + 3], fields[i]);
  const fold = (text: string) => (context.ignorecase ? text.toLowerCase() : text);
  const inside = (file: string) => {
    const rule = source.get(file);
    return rule !== undefined && fold(rule).startsWith(fold(`${old}/`));
  };
  const moved = listed
    .filter((file) => !inside(file))
    .map((file) => mapNew(file, context.prefix, old));
  const ignored = (paths: readonly string[]) => {
    const run = runGit(
      where,
      ['check-ignore', '--no-index', '--stdin', '-z'],
      context.env,
      toNul(paths)
    );
    if (run.status !== 0 && run.status !== 1)
      throw new Error(`git check-ignore failed in ${where}: ${run.stderr.trim().split('\n')[0]}`);
    return new Set(nulPaths(run.stdout));
  };
  const still = ignored(moved);
  const named = moved.filter((file) => !still.has(file));
  if (
    listed.includes(`${old}/db/${LEGACY.databaseFile}`) &&
    !ignored([`${old}/db/rbook.sqlite`]).size
  )
    named.push(`${context.prefix}rbook/db/rbook.sqlite`);
  return named;
}

/** The ignored untracked files under the old folder now, by the live repository's rules. */
export function ignoredNow(context: GitContext, old: string): string[] {
  return nulPaths(
    git(
      context.top,
      ['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', literal(old)],
      context.env
    )
  );
}

/**
 * The files the backstop judges: those ignored before migrate writes anything, as the dry run lists
 * them. Listed after migrate's own .gitignore write, a file that write un-ignores would go unjudged:
 * in a sparse checkout it shadows the index's copy of the record's rules.
 */
export function listIgnored(plan: IgnorePlan): string[] {
  return plan.git ? ignoredNow(plan.git, plan.git.prefix + plan.folder) : [];
}

/**
 * Whether git sees an untracked file under the project root: in a work tree and not ignored. A git
 * that cannot answer reads as seeing it, so the warning is given rather than dropped.
 */
export function visibleToGit(plan: IgnorePlan, relToRoot: string): boolean {
  if (!plan.git) return false;
  try {
    // check-ignore takes paths, not pathspecs.
    const answer = runGit(
      plan.git.top,
      ['check-ignore', '-q', '--', `${plan.git.prefix}${relToRoot}`],
      plan.git.env
    );
    return answer.status !== 0;
  } catch {
    return true;
  }
}

/** The refusal for a move that would make ignored files visible, naming up to 10. */
export function exposureRefusal(named: readonly string[]): string {
  return `Refusing migration because the move would make ${named.length} ignored file(s) visible to git: ${named
    .slice(0, 10)
    .join(
      ', '
    )}${named.length > 10 ? ', …' : ''}. Add an rbook/ rule for them beside the one that ignores them now, then retry; nothing was moved.`;
}

/** The move's backstop, on the live tree after migrate's writes and before the rename. */
export function liveBackstop(plan: IgnorePlan, listed: readonly string[]): string[] {
  if (!plan.git) return [];
  return judge(plan.git.top, plan.git, plan.git.prefix + plan.folder, listed);
}

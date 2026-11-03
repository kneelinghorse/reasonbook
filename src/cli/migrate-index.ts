// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Records a committed move in git's index as git mv does: exactly the tracked entries under the old
// ABOUTME: folder are renamed, with migrate's ignore edits in their blobs; the working tree is never touched.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { LEGACY } from '../intelligence/legacy-compat';
import {
  git,
  gitContext,
  gitPath,
  literal,
  nulPaths,
  stagedEntries,
  type GitContext,
  type IndexEntry,
} from './migrate-git';
import { recordIgnoreEdit, twinsOf } from './migrate-ignore';

export interface IndexOutcome {
  /** True once git's index holds every tracked file under its new path, or there is no work tree. */
  readonly done: boolean;
  /** Why the step waits, when it does. */
  readonly pending: string[];
  readonly left: string[];
}

const REGULAR = new Set(['100644', '100755']);

/** Entries under a pathspec that carry skip-worktree, assume-unchanged or intent-to-add. */
function flagged(context: GitContext, spec: string): string[] {
  const found: string[] = [];
  for (const line of nulPaths(
    git(context.top, ['ls-files', '-v', '-z', '--full-name', '--', spec], context.env)
  )) {
    const tag = line[0];
    if (tag === 'S') found.push(`${line.slice(2)} (skip-worktree)`);
    else if (tag >= 'a' && tag <= 'z') found.push(`${line.slice(2)} (assume-unchanged)`);
  }
  // git ls-files --debug prints each entry's flags; 0x20000000 is CE_INTENT_TO_ADD.
  let current = '';
  for (const line of Buffer.from(
    git(context.top, ['ls-files', '--debug', '--full-name', '--', spec], context.env),
    'latin1'
  )
    .toString('utf8')
    .split('\n')) {
    if (line && !/^\s/.test(line)) current = line;
    const flags = /flags: ([0-9a-f]+)/.exec(line);
    if (flags && (parseInt(flags[1], 16) & 0x20000000) !== 0)
      found.push(`${current} (intent-to-add)`);
  }
  return found;
}

/** Why the index step cannot run now (settled item 9); empty when it can. */
function pendingStates(context: GitContext, old: string, staged: readonly IndexEntry[]): string[] {
  const reasons: string[] = [];
  const lock = gitPath(context, 'index.lock');
  if (fs.existsSync(lock))
    reasons.push(
      `the index is locked by ${lock}, which blocks every git command there; if no git command is running, remove it`
    );
  for (const [name, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase or am'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ])
    if (fs.existsSync(gitPath(context, name))) reasons.push(`${what} is in progress`);
  if (staged.some((entry) => entry.stage !== '0'))
    reasons.push(`an entry under ${old}/ has a merge conflict`);
  // git mv keeps these flags, and --index-info would drop them (A3, B2).
  const marked = flagged(context, literal(old));
  if (marked.length) reasons.push(`${marked[0]} is flagged in the index`);
  return reasons;
}

const blob = (context: GitContext, sha: string) =>
  git(context.top, ['cat-file', 'blob', sha], context.env);
const store = (context: GitContext, text: string) =>
  git(
    context.top,
    ['hash-object', '-w', '--stdin'],
    context.env,
    Buffer.from(text, 'latin1')
  ).trim();

/**
 * After both renames commit, renames exactly the tracked entries under the old folder in git's index
 * (settled item 9). Every entry keeps its mode and blob, except the ignore files migrate edits, whose
 * blobs carry the edit: the record's own .gitignore its lines, and the root's and every ancestor's
 * their twins, each only for one stage-0, regular-file, unflagged entry. The whole input is built
 * first and given to update-index from a file, every addition before every removal, so a cut leaves
 * both paths, never neither; a retry adds only what is missing and never overwrites a new path.
 */
export function recordMoveInIndex(
  root: string,
  env: NodeJS.ProcessEnv,
  folder: string = LEGACY.recordDirectory,
  /** The run that renamed the folder: no entry of this step's can be at the new path yet. */
  firstRun = false
): IndexOutcome {
  let context: GitContext | null;
  try {
    context = gitContext(root, env);
  } catch (error) {
    return waiting([`git cannot run (${(error as Error).message})`], LEGACY.recordDirectory, root);
  }
  if (!context) return { done: true, pending: [], left: [] };
  const old = context.prefix + folder;
  const staged = stagedEntries(context, literal(old));
  const pending = pendingStates(context, old, staged);
  if (pending.length) return waiting(pending, old, root);

  const format = git(
    context.top,
    ['rev-parse', '--show-object-format'],
    context.env,
    undefined,
    [0, 128]
  ).trim();
  const zero = '0'.repeat(format === 'sha256' ? 64 : 40);
  const present = new Set(
    nulPaths(
      git(
        context.top,
        ['ls-files', '-z', '--full-name', '--', literal(`${context.prefix}rbook`)],
        context.env
      )
    )
  );
  // Index entries already at the new name on the run that moved (a deleted tracked file named rbook,
  // stale rbook/ entries) would be replaced or kept by update-index, staging more than the move, so
  // the step waits and names them (build critic B, round 1, note 1).
  if (firstRun && present.size)
    return waiting(
      [
        // Round-2 verifier B, note 4: a sparse checkout keeps tracked entries off disk, so the advice
        // to remove one is only for an entry that is stale.
        `the index already held ${present.size} entr${present.size > 1 ? 'ies' : 'y'} at the new folder's name before the move, such as ${[...present][0]}; remove any that are stale from the index (git rm --cached), move any you keep (a sparse checkout may keep them off disk) to another folder in git, and retry`,
      ],
      old,
      root
    );
  const trackedSnapshots = staged.some((entry) => entry.path.startsWith(`${old}/db/snapshots/`));
  const additions: string[] = [];
  const removals: string[] = [];
  const left: string[] = [];
  for (const entry of staged) {
    const rel = entry.path.slice(old.length + 1);
    const target = `${context.prefix}rbook/${rel === `db/${LEGACY.databaseFile}` ? 'db/rbook.sqlite' : rel}`;
    let sha = entry.sha;
    if (rel === '.gitignore') {
      if (REGULAR.has(entry.mode)) {
        sha = store(context, recordIgnoreEdit(blob(context, entry.sha), trackedSnapshots));
        left.push(`${target}: the index carries migrate's lines.`);
      } else
        left.push(
          `${target}: migrate's lines are in the working tree only (mode ${entry.mode}); commit them, and do not restore the working tree before you do.`
        );
    }
    if (!present.has(target)) additions.push(`${entry.mode} ${sha} 0\t${target}`);
    removals.push(`0 ${zero}\t${entry.path}`);
  }
  for (let dirRel = context.prefix; ; dirRel = dirRel.replace(/[^/]+\/$/, '')) {
    const file = `${dirRel}.gitignore`;
    const rel = context.prefix.slice(dirRel.length) + folder;
    const entries = stagedEntries(context, literal(file)).filter((entry) => entry.path === file);
    if (entries.length) {
      const [entry] = entries;
      const why = [
        ...(entries.length > 1 || entry.stage !== '0'
          ? [
              'it has a merge conflict; keep the /rbook/ lines when you resolve it, since git checkout --theirs or --ours drops them',
            ]
          : []),
        ...(REGULAR.has(entry.mode) ? [] : [`mode ${entry.mode}`]),
        ...flagged(context, literal(file)).map((flag) => flag.slice(file.length + 1)),
      ];
      const twins = why.length ? null : twinsOf(blob(context, entry.sha), rel, context.ignorecase);
      if (twins?.added.length) {
        additions.push(`${entry.mode} ${store(context, twins.text)} 0\t${file}`);
        left.push(`${file}: the index carries its rbook/ lines.`);
      } else if (why.length)
        left.push(
          `${file}: its rbook/ lines are in the working tree only (${why.join('; ')}); commit them, and do not restore the working tree before you do.`
        );
    }
    if (!dirRel) break;
  }
  const lines = [...additions, ...removals];
  if (lines.length) {
    const input = path.join(os.tmpdir(), `rbook-migrate-index-${process.pid}-${randomUUID()}`);
    fs.writeFileSync(input, `${lines.join('\0')}\0`, { mode: 0o600 });
    const fd = fs.openSync(input, 'r');
    try {
      git(context.top, ['update-index', '-z', '--index-info'], context.env, fd);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(input, { force: true });
    }
  }
  // When the disk said CMOS and the index cmos/, the entries are still there by another case (A4, note 6).
  if (context.ignorecase) {
    const remaining = nulPaths(
      git(
        context.top,
        ['ls-files', '-z', '--full-name', '--', `:(icase,literal)${old}`],
        context.env
      )
    );
    if (remaining.length)
      return waiting(
        [
          `git's index names ${remaining.length} entries under the old folder in another case, such as ${remaining[0]}`,
        ],
        old,
        root
      );
  }
  return {
    done: true,
    pending: [],
    left: [
      `Git's index records the move as renames. Commit the root .gitignore with the move, and do not stash, reset or restore the index before you commit: git reset or git restore --staged brings back the deletions an ordinary commit would make.`,
      ...left,
    ],
  };
}

function waiting(pending: string[], old: string, root: string): IndexOutcome {
  return {
    done: false,
    pending,
    left: [
      `Git's index still lists the record under ${old}/ because ${pending.join('; ')}. Until reasonbook migrate --apply --project ${JSON.stringify(root)} records the move there, do not commit with git add -A or git commit -a: git sees the move as deletions plus new files, and such a commit drops every tracked file the new folder's rules ignore.`,
    ],
  };
}

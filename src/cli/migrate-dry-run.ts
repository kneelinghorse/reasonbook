// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The dry run's backstop, which writes nothing to see: a temporary repository holds every ignore source
// ABOUTME: the move will have, as the move will write it, and both answers of the deciding-rule check are read there.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { git, gitPath } from './migrate-git';
import { configuredExcludes } from './migrate-ignore-sources';
import { ignoredNow, judge, recordIgnoreEdit, type IgnorePlan } from './migrate-ignore';

/** Every regular-file .gitignore on disk inside a folder, self-ignoring ones included (A7, note 1). */
function nestedIgnores(folder: string, rel = ''): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== '.git') found.push(...nestedIgnores(folder, next));
    } else if (entry.name === '.gitignore' && entry.isFile()) found.push(next);
  }
  return found;
}

/**
 * The dry run's backstop, which writes nothing to see (settled item 8): a temporary repository holds
 * every ignore source the move will have, as the move will write it, with the live repository's
 * info/exclude, resolved core.excludesFile and effective core.ignorecase; its git runs in the live
 * environment, so git's default excludes file is the same. Both answers are read there.
 */
export function dryBackstop(root: string, plan: IgnorePlan): string[] {
  const context = plan.git;
  if (!context) return [];
  const old = context.prefix + plan.folder;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-dry-'));
  try {
    const template = path.join(scratch, 'template');
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(template);
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', `--template=${template}`], context.env);
    git(repo, ['config', 'core.ignorecase', context.ignorecase ? 'true' : 'false'], context.env);
    const excludes = configuredExcludes(context);
    if (excludes) git(repo, ['config', 'core.excludesFile', excludes], context.env);
    const exclude = gitPath(context, 'info/exclude');
    if (fs.existsSync(exclude)) {
      fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
      fs.copyFileSync(exclude, path.join(repo, '.git', 'info', 'exclude'));
    }
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text, 'latin1');
    };
    for (const link of plan.chain)
      if (link.after !== null) put(`${link.dirRel}.gitignore`, link.after);
    const record = path.join(root, plan.folder);
    for (const rel of nestedIgnores(record))
      if (rel !== '.gitignore')
        put(`${old}/${rel}`, fs.readFileSync(path.join(record, rel), 'latin1'));
    const own = path.join(record, '.gitignore');
    const stat = fs.lstatSync(own, { throwIfNoEntry: false });
    // The move writes migrate's lines into a regular file or a new one, never through a link.
    if (!stat || stat.isFile())
      put(
        `${old}/.gitignore`,
        recordIgnoreEdit(stat ? fs.readFileSync(own, 'latin1') : '', plan.trackedSnapshots)
      );
    return judge(repo, context, old, ignoredNow(context, old));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

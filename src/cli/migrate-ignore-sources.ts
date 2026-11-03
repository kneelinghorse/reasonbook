// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Refuses a move whose ignore rules git reads from a source the rename takes away or brings in: one reached
// ABOUTME: through the record folder, or one inside the rbook/ folder the move creates (round 8, B1; build rounds 1-2).
import fs from 'fs';
import path from 'path';
import { git, gitPath, type GitContext } from './migrate-git';

/** git's default excludes file: $XDG_CONFIG_HOME/git/ignore, else ~/.config/git/ignore. */
export function defaultExcludes(env: NodeJS.ProcessEnv): string | null {
  // Verifier B round 2: joined as git joins it, so a .. in the variable is walked as git opens it.
  if (env.XDG_CONFIG_HOME) return `${env.XDG_CONFIG_HOME}${path.sep}git${path.sep}ignore`;
  return env.HOME ? `${env.HOME}${path.sep}.config${path.sep}git${path.sep}ignore` : null;
}

/** core.excludesFile as the live repository resolves it: a relative value from the top level (round 8, note 2). */
export function configuredExcludes(context: GitContext): string | null {
  const value = Buffer.from(
    git(
      context.top,
      ['config', '--path', '--get', 'core.excludesFile'],
      context.env,
      undefined,
      [0, 1]
    ).trim(),
    'latin1'
  ).toString('utf8');
  return value ? path.resolve(context.top, value) : null;
}

export const realPath = (file: string): string | null => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
};

/**
 * Critic B (build round 1): whether opening file by name passes through folder (a real path): the
 * file inside it, or a link or a `..` on the way. After the folder's rename that name reads nothing.
 * The path is walked as given, so `cmos/../x` and a link stored in the folder both count.
 */
export function passesThrough(
  file: string,
  folder: string,
  depth = 0,
  /** Verifier B round 2: asked about the first missing component, which the move may create. */
  missing?: (at: string) => boolean
): boolean {
  const inside = (p: string) => p === folder || p.startsWith(folder + path.sep);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    const stat = fs.lstatSync(next, { throwIfNoEntry: false });
    if (!stat) return missing?.(next) ?? false;
    if (stat.isSymbolicLink()) {
      if (depth > 40) return true;
      const target = fs.readlinkSync(next);
      if (
        passesThrough(
          path.isAbsolute(target) ? target : `${current}${path.sep}${target}`,
          folder,
          depth + 1,
          missing
        )
      )
        return true;
    }
    current = realPath(next) ?? next;
    if (inside(current)) return true;
  }
  return false;
}

/** The file a config key's effective value comes from, as git names it, or null (round 1, B1). */
export function configOrigin(context: GitContext, key: string): string | null {
  const out = Buffer.from(
    // Verifier B round 2: -z, so git does not C-quote a name holding a non-ASCII byte.
    git(
      context.top,
      ['config', '--show-origin', '-z', '--get', key],
      context.env,
      undefined,
      [0, 1]
    ),
    'latin1'
  ).toString('utf8');
  const match = /^file:([^\0]*)\0/.exec(out);
  if (!match) return null;
  return path.isAbsolute(match[1]) ? match[1] : `${context.top}${path.sep}${match[1]}`;
}

/** A config path value as git expands it, ~/ and ~user/ included (verifier B round 3). */
function interpolated(context: GitContext, value: string): string {
  return Buffer.from(
    git(
      context.top,
      ['-c', `rbook.include=${value}`, 'config', '--path', '--get', 'rbook.include'],
      context.env
    ).replace(/\n$/, ''),
    'latin1'
  ).toString('utf8');
}

/** core.excludesFile's value as git opens it, from the top level, without normalizing `..`. */
export function excludesAsOpened(context: GitContext): string | null {
  const value = Buffer.from(
    git(
      context.top,
      ['config', '--path', '--get', 'core.excludesFile'],
      context.env,
      undefined,
      [0, 1]
    ).trim(),
    'latin1'
  ).toString('utf8');
  return value ? (path.isAbsolute(value) ? value : `${context.top}${path.sep}${value}`) : null;
}

/**
 * Refuses an ignore source git reads through the record folder, which the rename would take away
 * (round 8, B1; build critic B, round 1, B1), or from inside the rbook/ folder the move creates (note
 * 8); names the lines in info/exclude and core.excludesFile that name the folder, which migrate leaves
 * as they are (settled item 8).
 */
export function assertIgnoreSourcesOutside(
  context: GitContext,
  root: string,
  folder: string,
  left: string[]
): void {
  const old = context.prefix + folder;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const record = realPath(path.join(root, folder));
  const sources: Array<[string, string | null]> = [
    ['info/exclude', gitPath(context, 'info/exclude')],
    ['core.excludesFile', configuredExcludes(context) ?? defaultExcludes(context.env)],
  ];
  for (const [name, file] of sources) {
    const real = file ? realPath(file) : null;
    if (record && real && (real === record || real.startsWith(record + path.sep)))
      throw new Error(
        `Refusing migration because git reads ${name} from ${real}, inside the record folder: after the rename that file would apply nowhere, and the files it ignores would become visible to git. Move it out of ${folder}/ first; nothing was moved.`
      );
    // Lines naming the folder there are left as they are, and said (settled item 8).
    // The file's bytes are matched against the folder's UTF-8 bytes, and shown decoded (round-2
    // verifier B, note 7).
    const text = real && fs.statSync(real).isFile() ? fs.readFileSync(real, 'latin1') : '';
    const bytes = Buffer.from(old, 'utf8').toString('latin1');
    const named = text
      .split('\n')
      .filter((line) =>
        new RegExp(`^!?(?:/|\\*\\*/)?${escape(bytes)}(?:/|$)`, context.ignorecase ? 'i' : '').test(
          line
        )
      )
      .map((line) => Buffer.from(line, 'latin1').toString('utf8'));
    if (named.length)
      left.push(
        `${real} names ${old}/ in ${named.length} line(s) that migrate does not edit (${named.join(', ')}); add an rbook/ line beside each if those files should stay ignored.`
      );
  }
  // Critic B round 1: the name git opens, walked as given, and the config files that set the keys.
  const opened: Array<[string, string | null]> = [
    ['info/exclude', gitPath(context, 'info/exclude')],
    ['core.excludesFile', excludesAsOpened(context) ?? defaultExcludes(context.env)],
    ['the config setting core.excludesFile', configOrigin(context, 'core.excludesFile')],
    ['the config setting core.ignorecase', configOrigin(context, 'core.ignorecase')],
    // Verifier B round 3: on macOS this key decides which spelling of a name git matches.
    ['the config setting core.precomposeUnicode', configOrigin(context, 'core.precomposeUnicode')],
  ];
  // The reverse (build critic B, round 1, note 8): a name inside the folder the move creates reads
  // nothing now and the moved file after, whose rules would then hide files git sees today.
  const created = [path.join(root, 'rbook'), path.join(context.top, context.prefix, 'rbook')];
  // Verifier B round 3: a case-insensitive disk opens RBOOK/ as rbook/ whatever core.ignorecase says.
  const base = path.basename(record ?? folder);
  const swapped = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
  const caseless =
    context.ignorecase ||
    (record !== null && realPath(path.join(path.dirname(record), swapped)) !== null);
  const fold = (p: string) => (caseless ? p.toLowerCase() : p);
  const createdReal = [root, path.join(context.top, context.prefix)].map((p) =>
    fold(path.join(realPath(p) ?? p, 'rbook'))
  );
  const reachesCreated = (file: string) =>
    passesThrough(file, '\0', 0, (at) =>
      createdReal.some((c) => fold(at) === c || fold(at).startsWith(c + path.sep))
    );
  for (const [name, file] of opened) {
    if (record && file && passesThrough(file, record))
      throw new Error(
        `Refusing migration because git reads ${name} from ${file}, through the record folder: after the rename that file would apply nowhere, and the files it ignores would become visible to git. Move it out of ${folder}/ first; nothing was moved.`
      );
    const lexical = file ? path.resolve(file) : null;
    if (
      lexical &&
      (created.some((folder) => lexical === folder || lexical.startsWith(folder + path.sep)) ||
        (file !== null && reachesCreated(file)))
    )
      throw new Error(
        `Refusing migration because git would read ${name} from ${file}, inside the rbook/ folder the move creates: after the move its rules would start to apply, and files git sees now would become ignored. Point it elsewhere first; nothing was moved.`
      );
  }
  // Verifier B round 2: a config file read through the record that includes another one (an include
  // of an include), and an include or global config file inside the rbook/ folder the move creates,
  // whose settings would start to apply after the move.
  const inCreated = (file: string) =>
    created.some((folder) => {
      const lexical = path.resolve(file);
      return lexical === folder || lexical.startsWith(folder + path.sep);
    });
  const list = Buffer.from(
    git(context.top, ['config', '--show-origin', '--list', '-z'], context.env, undefined, [0, 1]),
    'latin1'
  )
    .toString('utf8')
    .split('\0');
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (!/^include(if\..*)?\.path\n/.test(list[i + 1])) continue;
    // Verifier B round 3: an include given on the command line has no file, and its target counts.
    const named = list[i].startsWith('file:') ? list[i].slice('file:'.length) : null;
    const from =
      named === null
        ? 'the command line'
        : path.isAbsolute(named)
          ? named
          : `${context.top}${path.sep}${named}`;
    const raw = list[i + 1].slice(list[i + 1].indexOf('\n') + 1);
    // The target as git opens it: ~/ and ~user/ expanded by git itself, and a relative one joined to
    // the including file's name without normalizing, so a .. after a link is walked as git walks it.
    const value = raw.startsWith('~') ? interpolated(context, raw) : raw;
    const target =
      named === null || path.isAbsolute(value) ? value : `${path.dirname(from)}${path.sep}${value}`;
    if (record && named !== null && passesThrough(from, record))
      throw new Error(
        `Refusing migration because git reads a config include from ${from}, through the record folder: after the rename it would include nothing, and the ignore settings it brings in would stop applying. Move it out of ${folder}/ first; nothing was moved.`
      );
    if (inCreated(target) || reachesCreated(target))
      throw new Error(
        `Refusing migration because ${from} includes ${target}, inside the rbook/ folder the move creates: after the move its settings would start to apply and change which files git ignores. Point it elsewhere first; nothing was moved.`
      );
  }
  const xdg = context.env.XDG_CONFIG_HOME;
  const home = context.env.HOME;
  const join = (...parts: string[]) => parts.join(path.sep);
  for (const file of [
    context.env.GIT_CONFIG_GLOBAL,
    context.env.GIT_CONFIG_SYSTEM,
    // Verifier B round 3: joined as git joins them, git's default global files, and the
    // repository's own config files, any of which a link into rbook/ would bring in too.
    xdg ? join(xdg, 'git', 'config') : home ? join(home, '.config', 'git', 'config') : undefined,
    home ? join(home, '.gitconfig') : undefined,
    gitPath(context, 'config'),
    gitPath(context, 'config.worktree'),
  ])
    if (file && (inCreated(file) || reachesCreated(file)))
      throw new Error(
        `Refusing migration because git would read its config from ${file}, inside the rbook/ folder the move creates: after the move its settings would start to apply and change which files git ignores. Point it elsewhere first; nothing was moved.`
      );
}

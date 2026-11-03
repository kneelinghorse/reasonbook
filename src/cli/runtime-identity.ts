// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Identifies what a running process runs from its command line and the manifests on disk, for the move's
// ABOUTME: check of runtimes from before 4.0: every entry point and global command on the line is judged (s109-m01).
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot inspect ${file}: ${(error as Error).message}`);
  }
}

export const ENTRY =
  /(?:^|\/)(?:dist\/(?:index|bin|cli)\.js|(?:server|hooks)\/(?:run|install-worker|installing-server|disabled-server)\.mjs)$/;
export const MODERN = /^(?:[4-9]|\d{2,})\./;

export type Manifest =
  | {
      readonly file: string;
      readonly reasonbook: boolean;
      readonly legacy: boolean;
      readonly version: unknown;
    }
  | { readonly unreadable: string };

const PLUGIN_NAMES = [
  'reasonbook',
  'reasonbook-chat',
  LEGACY.recordDirectory,
  `${LEGACY.recordDirectory}-chat`,
];
const LEGACY_PLUGIN_NAMES = [LEGACY.recordDirectory, `${LEGACY.recordDirectory}-chat`];

/** The first manifest at or above a runtime's file, package before plugin, as the walk has read it. */
export function runtimeManifest(file: string): Manifest | null {
  let directory = path.dirname(file);
  for (let depth = 0; depth < 5 && path.isAbsolute(directory); depth++) {
    for (const [relative, names, legacy, ownOnly] of [
      ['package.json', ['@aquex/reasonbook', LEGACY.packageName], [LEGACY.packageName], false],
      ['.claude-plugin/plugin.json', PLUGIN_NAMES, LEGACY_PLUGIN_NAMES, false],
      // s108-m05: the chat plugin kept its manifest at its root before 4.7.0 (round 1). Read there, a
      // manifest identifies only a Reasonbook plugin; another product's leaves the walk going.
      ['plugin.json', PLUGIN_NAMES, LEGACY_PLUGIN_NAMES, true],
    ] as const) {
      const manifest = path.join(directory, relative);
      let text: string | null;
      // s109-m01 (#914): an existing root plugin.json that cannot be read or parsed refuses too; the
      // walk went past one and found a 4.x package above a 3.5.0 chat plugin.
      try {
        text = read(manifest);
      } catch {
        return { unreadable: `${manifest} could not be read` };
      }
      if (text === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Never the parser's message: it quotes the file's text.
        return { unreadable: `${manifest} is not valid JSON` };
      }
      const { name, version } = (parsed && typeof parsed === 'object' ? parsed : {}) as {
        name?: unknown;
        version?: unknown;
      };
      const reasonbook = (names as readonly unknown[]).includes(name);
      if (ownOnly && !reasonbook) continue;
      return {
        file: manifest,
        reasonbook,
        legacy: (legacy as readonly unknown[]).includes(name),
        version,
      };
    }
    directory = path.dirname(directory);
  }
  return null;
}

/** An option's value given as --flag=value, which is the word to judge (s109-m01). */
const valueOf = (word: string): string => /^--?[^=\s/]+=(.*)$/.exec(word)?.[1] ?? word;

/**
 * Every entry point on a command line (s109-m01, #914): node runs each one --require, -r or --import
 * names, so the first alone no longer decides. ps joins a process's arguments with spaces, so a path
 * holding one comes back in pieces; the pieces before it are joined back while that names a file
 * (round 1).
 */
export function entriesOf(words: readonly string[]): string[] {
  const entries: string[] = [];
  words.forEach((word, at) => {
    if (!ENTRY.test(valueOf(word))) return;
    if (path.isAbsolute(valueOf(word))) return entries.push(valueOf(word));
    for (let start = at - 1; start > 0; start--) {
      const joined = valueOf(words.slice(start, at + 1).join(' '));
      if (path.isAbsolute(joined))
        return entries.push(fs.existsSync(joined) ? joined : valueOf(word));
    }
    entries.push(valueOf(word));
  });
  return entries;
}

/**
 * The global command is a link to the package's bin, so its manifest is read where it points; one
 * that cannot be resolved is read where it is. s109-m01: every such word is judged, but a folder
 * named reasonbook, given as data, is not one.
 */
export function commandTargets(words: readonly string[]): string[] {
  return words.flatMap((word) => {
    // The legacy command too: one linked to a 3.5.0 bin, preloaded before a 4.x entry, passed when
    // only its name was read (build critic A, note 7).
    if (!path.isAbsolute(word) || !['reasonbook', LEGACY.command].includes(path.basename(word)))
      return [];
    let target: string;
    try {
      target = fs.realpathSync.native(word);
    } catch {
      return [word];
    }
    return fs.statSync(target).isDirectory() ? [] : [target];
  });
}

/** s109-m01 (#914): node, nodejs, node22, node-22, bun and deno run an entry as node does. */
export const INTERPRETER = /^(?:node|nodejs|node-?\d+(?:\.\d+)*|bun|deno|reasonbook|npx)$/;

/**
 * The program a ps line runs, as its name: the first word, or a path holding spaces, which ps
 * splits, rejoined while it names a file (s109-m01, #914), as an entry point is.
 */
export function programOf(words: readonly string[]): string {
  const first = path.basename(words[0]);
  if (INTERPRETER.test(first) || first === LEGACY.command || !path.isAbsolute(words[0]))
    return first;
  for (let end = 1; end < words.length; end++) {
    const joined = words.slice(0, end + 1).join(' ');
    const name = path.basename(joined);
    if ((INTERPRETER.test(name) || name === LEGACY.command) && fs.existsSync(joined)) return name;
  }
  return first;
}

/**
 * E1 Part B: an entry in a plugin cache folder that no longer exists is an app still running a
 * plugin it has since updated and deleted, as Codex's launcher did after 4.9.0 gave way to 4.10.0.
 */
export function deletedPlugin(file: string): string {
  return /[\\/]plugins[\\/]cache[\\/]/.test(file) && !fs.existsSync(path.dirname(file))
    ? ' Its plugin folder no longer exists: restart the app that updated its plugin, such as Codex or Claude Code, so it runs the installed one.'
    : '';
}

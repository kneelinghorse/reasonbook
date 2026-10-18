// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The per-line rules migrate uses to rename old CMOS names in a project's documents: an old
// ABOUTME: name stays where it is history, and is renamed where it still runs or names the old tooling.
import * as path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';

export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The CLI's verbs (src/cli.ts usage): the old command is renamed only where it runs one. */
const COMMAND_VERBS = [
  'hook',
  'review',
  'relevant',
  'decisions',
  'capture',
  'feedback',
  'session',
  'ambient',
  'init',
  'spin-out',
  'migrate',
  'profile',
  'stats',
  'drafts',
  'serve',
];
const VERBS = COMMAND_VERBS.join('|');
/**
 * A package runner runs a package, and the unscoped name `reasonbook` on npm belongs to someone
 * else, so the old command it runs becomes the scoped package; run directly, it becomes the command.
 */
const NEW_PACKAGE = '@aquex/reasonbook';
const NEW_COMMAND = 'reasonbook';
const OLD_COMMAND = escape(LEGACY.command);
const RUNNER = '\\b(?:npx|bunx|pnpm\\s+dlx|yarn\\s+dlx)\\s+(?:-\\S+\\s+)*';
/**
 * Where a shell runs a word: a line start, a prompt or a list marker; a backtick or a quote; `run`,
 * `sudo` or a setting assigned before it; or a shell operator.
 */
const COMMAND_POSITION =
  '(?:^\\s*(?:[$>]\\s+|(?:[-*+]|\\d+[.)])\\s+)?|[`\'"]|\\b[Rr]un\\s+|\\bsudo\\s+|' +
  '\\b[A-Z_][A-Z0-9_]*=\\S*\\s+|(?:&&|\\|\\||[;|(])\\s*)';
const RUN_BY_POSITION = `(?<=${COMMAND_POSITION})`;
const BEFORE_A_VERB = `(?=\\s+(?:${VERBS})\\b|\\s+--?[a-z])`;
const COMMAND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`(?<=${RUNNER})${OLD_COMMAND}(?![\\w/.-])`, 'g'), NEW_PACKAGE],
  // An MCP server entry quoted in a document, as the 3.x README wrote it.
  [new RegExp(`(?<="command"\\s*:\\s*")${OLD_COMMAND}(?=[\\s"])`, 'g'), NEW_COMMAND],
  [new RegExp(`(?<="(?:-y|--yes)"\\s*,\\s*")${OLD_COMMAND}(?=["@])`, 'g'), NEW_PACKAGE],
  [new RegExp(`${RUN_BY_POSITION}${OLD_COMMAND}${BEFORE_A_VERB}`, 'g'), NEW_COMMAND],
];
/** The new command in use on the line, which makes the old one beside it a note. */
const NEW_COMMAND_IN_USE = new RegExp(
  `${RUN_BY_POSITION}${NEW_COMMAND}${BEFORE_A_VERB}|${RUNNER}${escape(NEW_PACKAGE)}`
);
/** Extensions that make `cmos_context.py` a file, while `cmos_session.capture` stays a tool. */
const FILE_EXTENSIONS =
  'py|pyi|ipynb|mjs|cjs|jsx?|tsx?|sh|bash|zsh|json|jsonl|mdx?|ya?ml|sql|sqlite|db|txt|toml|csv|' +
  'tsv|html?|css|scss|xml|ini|cfg|conf|log|lock|env|png|jpe?g|gif|svg|pdf|zip|gz|tgz|rs|go|rb|' +
  'java|kt|swift|c|h|cpp|hpp|cs|php|vue|svelte|xlsx?|docx?';
const OLD_TOOL = escape(LEGACY.toolPrefix);
const TOOL = new RegExp(
  // s96-m11: never a file or folder name (Meridian's cmos_context.py, a cmos_bridge/ path), or a
  // segment of a path; the tool glob cmos_* is a tool.
  `(?<![/\\\\.])\\b${OLD_TOOL}(?=[a-z*])(?![\\w*-]*(?:\\.(?:${FILE_EXTENSIONS})\\b|/))`,
  'g'
);
/** Tools written as alternatives, `cmos_review/cmos_status`, rather than as a path. */
const TOOL_ALTERNATIVES = new RegExp(
  `\\b${OLD_TOOL}[a-z][\\w*]*(?:/${OLD_TOOL}[a-z][\\w*]*)+(?![\\w*-]*(?:\\.(?:${FILE_EXTENSIONS})\\b|/))`,
  'g'
);
/**
 * The old package on a line about deprecation, unless an install names it: a note such as
 * "`@aquex/cmos-mcp` (deprecated)" stays, while "npm i -g @aquex/cmos-mcp" is still renamed.
 */
const PACKAGE_NOT_INSTALLED = new RegExp(
  `(?<!\\b(?:install|add|i)\\s+(?:-\\S+\\s+)*\`?)${escape(LEGACY.packageName)}`,
  'g'
);
/** A bare folder name: not followed by more of a name, or by a dot that starts a file name. */
const BARE = '(?![\\w-]|\\.\\w)';
const IN_WORDS = '(?![\\w./-])(?=\\s+(?:root|folder|directory)\\b)';
const OLD_FOLDER = new RegExp(
  `(?<![\\w./-])${escape(LEGACY.recordDirectory)}(?:/${BARE}|${IN_WORDS})`,
  'g'
);
const NEW_FOLDER = new RegExp(`(?<![\\w./-])rbook(?:/${BARE}|${IN_WORDS})`);
const RECORD_PATH = new RegExp(
  `(?<![\\w./-])${escape(LEGACY.recordDirectory)}/[\\w./-]*[\\w/-]|` +
    `(?<![\\w./-])${escape(LEGACY.databaseFile)}\\b`,
  'g'
);

function movedPath(text: string): string {
  return text
    .replace(new RegExp(`^${escape(LEGACY.recordDirectory)}/`), 'rbook/')
    .replace(new RegExp(`(?<![\\w.-])${escape(LEGACY.databaseFile)}\\b`, 'g'), 'rbook.sqlite');
}

/** The line names this token whole: not inside a longer name, such as rbook_review_log. */
function namesToken(line: string, token: string): boolean {
  return new RegExp(`(?<![\\w./-])${escape(token)}(?![\\w-])`).test(line);
}

/** A private-use character the line does not hold, so a kept span cannot meet the line's own. */
function markerFor(line: string): string {
  for (let code = 0xe001; code <= 0xf8ff; code++)
    if (!line.includes(String.fromCharCode(code))) return String.fromCharCode(code);
  throw new Error('Migration found no free placeholder character for a line.');
}

/**
 * s96-m11 (#651): rename the old names a line still uses for the old tooling. A name stays when it
 * is history rather than use:
 * - after "formerly", and anywhere in a parenthesis that opens with it;
 * - beside its own new form on the line (a mapping or a transition note): a tool, setting, record
 *   path or folder, the command, and the package and address;
 * - the package after an uninstall, or on a line about deprecation unless an install names it
 *   (a negated install, "do not install", is advice about the old package and keeps it);
 * - as a host, a file or folder name, or a project slug, including one an option names.
 * The command is renamed only where it runs: after a package runner (to the scoped package), in a
 * quoted server entry, or at a command position before one of its verbs or a flag. The cases are the
 * lines 4.0.1 rewrote wrongly in cmos-dashboard, aquex.ai and Meridian, and the build critic's
 * (tests/cli/migrate-docs-rules.test.ts). Lines are migrated one at a time, so a note that spans
 * lines is read line by line.
 */
function migrateLine(line: string, moved: boolean): string {
  const marker = markerFor(line);
  const kept: string[] = [];
  const keep = (text: string): string => `${marker}${kept.push(text) - 1}${marker}`;
  const keepBesideNew = (pattern: RegExp, renamed: (old: string) => string) => (text: string) =>
    text.replace(pattern, (old) => (namesToken(line, renamed(old)) ? keep(old) : old));
  let updated = line
    .replace(/\(formerly\b[^)]*\)/gi, keep)
    .replace(new RegExp(`\\bformerly\\s+[\`'"(]?[@\\w/]*cmos[\\w@./:-]*`, 'gi'), keep)
    .replace(
      new RegExp(
        `\\b(?:uninstall|unlink|remove|rm|un|r)\\s+(?:-\\S+\\s+)*${escape(LEGACY.packageName)}`,
        'g'
      ),
      keep
    )
    .replace(new RegExp(`(?<!${RUNNER})--[\\w-]+[ =]${OLD_COMMAND}(?![\\w/.@-])`, 'g'), keep);
  if (NEW_COMMAND_IN_USE.test(line))
    updated = updated.replace(new RegExp(`(?<![\\w/@-])${OLD_COMMAND}(?![\\w/-])`, 'g'), keep);
  if (line.includes('rbook://'))
    updated = updated.split(LEGACY.addressScheme).join(keep(LEGACY.addressScheme));
  if (line.includes(NEW_PACKAGE))
    updated = updated.split(LEGACY.packageName).join(keep(LEGACY.packageName));
  else if (/\bdeprecat/i.test(line))
    // A negated install ("Do not install @aquex/cmos-mcp; it is deprecated") is advice about it.
    updated = /\b(?:not|never|avoid|no longer)\b|n't\b/i.test(line)
      ? updated.split(LEGACY.packageName).join(keep(LEGACY.packageName))
      : updated.replace(PACKAGE_NOT_INSTALLED, keep);
  updated = keepBesideNew(
    new RegExp(`\\b${OLD_TOOL}[a-z0-9_*]+`, 'g'),
    (old) => `rbook_${old.slice(LEGACY.toolPrefix.length)}`
  )(updated);
  updated = keepBesideNew(
    new RegExp(`\\b${escape(LEGACY.envPrefix)}[A-Z0-9_]+`, 'g'),
    (old) => `RBOOK_${old.slice(LEGACY.envPrefix.length)}`
  )(updated);
  if (moved) {
    if (NEW_FOLDER.test(line)) updated = updated.replace(OLD_FOLDER, keep);
    updated = keepBesideNew(RECORD_PATH, movedPath)(updated);
  }
  updated = updated
    .replace(TOOL_ALTERNATIVES, (tools) => tools.split(LEGACY.toolPrefix).join('rbook_'))
    .replace(TOOL, 'rbook_')
    .replace(new RegExp(`\\b${escape(LEGACY.envPrefix)}(?=[A-Z])`, 'g'), 'RBOOK_')
    .split(LEGACY.addressScheme)
    .join('rbook://')
    .split(LEGACY.packageName)
    .join(NEW_PACKAGE);
  for (const [pattern, replacement] of COMMAND_RULES)
    updated = updated.replace(pattern, replacement);
  if (moved) {
    updated = updated
      .replace(new RegExp(`(?<![\\w.-])${escape(LEGACY.recordDirectory)}/(?!/)`, 'g'), 'rbook/')
      .replace(
        new RegExp(`(?<=(?:^|[\\s(\\[\`'"])\\./)${escape(LEGACY.recordDirectory)}${BARE}`, 'g'),
        'rbook'
      )
      // The folder named in words: "normalises from cmos root" in older record READMEs.
      .replace(
        new RegExp(`(?<![\\w./-])${escape(LEGACY.recordDirectory)}${IN_WORDS}`, 'g'),
        'rbook'
      )
      .replace(new RegExp(`(?<![\\w.-])${escape(LEGACY.databaseFile)}\\b`, 'g'), 'rbook.sqlite');
  }
  return updated.replace(
    new RegExp(`${marker}(\\d+)${marker}`, 'g'),
    (_whole, index: string) => kept[Number(index)]
  );
}

export function migrateIdentifiers(text: string, moved: boolean): string {
  return text
    .split('\n')
    .map((line) => migrateLine(line, moved))
    .join('\n');
}

/**
 * s96-m11: a line that kept the record folder or a path into it, because it names the new form
 * too. It may describe the move as still to come, which the move makes false, so migrate lists it.
 */
export function namesRecordMove(line: string): boolean {
  if (NEW_FOLDER.test(line) && new RegExp(OLD_FOLDER.source).test(line)) return true;
  return (line.match(RECORD_PATH) ?? []).some((old) => namesToken(line, movedPath(old)));
}

/**
 * s96-m11: in a checkout of the old package, a Markdown link into the record folder only points at
 * files, so it follows them: inline and reference links, and link text that is itself such a path.
 */
export function moveRecordLinks(text: string): string {
  const folder = escape(LEGACY.recordDirectory);
  return text.replace(
    new RegExp(
      `(?<=\\]\\((?:\\./)?)${folder}/|(?<=^\\s*\\[[^\\]]+\\]:\\s*(?:\\./)?)${folder}/|` +
        `(?<=\\[)${folder}/(?=[^\\]]*\\]\\()`,
      'gm'
    ),
    'rbook/'
  );
}

/**
 * s96-m11: .mcp.json values are renamed, and the setting names an `env` block holds; server names
 * are keys and stay, but for the standard entry planDocumentEdits moves. An exact "cmos-mcp" is
 * renamed only as a command or the package npx runs; anywhere else it is a name, such as a slug.
 */
export function migrateJsonValues(value: unknown, moved: boolean, key?: string): unknown {
  if (typeof value === 'string') {
    if (value !== LEGACY.command) return migrateIdentifiers(value, moved);
    return key === 'command' ? NEW_COMMAND : value;
  }
  if (Array.isArray(value)) return value.map((item) => migrateJsonValues(item, moved));
  if (!value || typeof value !== 'object') return value;
  const entry = value as Record<string, unknown>;
  const runsNpx =
    typeof entry.command === 'string' &&
    path.basename(entry.command).replace(/\.cmd$/i, '') === 'npx';
  return Object.fromEntries(
    Object.entries(entry).map(([name, item]) => {
      if (name === 'args' && runsNpx && Array.isArray(item)) {
        const at = item.findIndex((arg) => typeof arg !== 'string' || !arg.startsWith('-'));
        return [
          name,
          item.map((arg, index) =>
            index === at && arg === LEGACY.command ? NEW_PACKAGE : migrateJsonValues(arg, moved)
          ),
        ];
      }
      if (name === 'env' && item && typeof item === 'object' && !Array.isArray(item))
        return [name, migrateSettings(item as Record<string, unknown>, moved)];
      return [name, migrateJsonValues(item, moved, name)];
    })
  );
}

/** Setting names in an `env` block are renamed, unless the new name is already set there. */
function migrateSettings(settings: Record<string, unknown>, moved: boolean): unknown {
  return Object.fromEntries(
    Object.entries(settings).map(([setting, text]) => {
      const renamed = setting.replace(
        new RegExp(`^${escape(LEGACY.envPrefix)}(?=[A-Z])`),
        'RBOOK_'
      );
      return [renamed in settings ? setting : renamed, migrateJsonValues(text, moved)];
    })
  );
}

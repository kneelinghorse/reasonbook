#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The reasonbook bin routes a command word to dist/cli.js before any server module loads.
// ABOUTME: Server --version reads package metadata directly; other server routes load the MCP entry.

/**
 * WHY A SEPARATE BIN. dist/index.js loads about 165 modules, the MCP SDK included, before it does
 * anything, and a hook has under a second (design doc m01: 1.11 s for the review closure cold under
 * load, against 0.04 s for better-sqlite3 alone). So the verbs never load the server: this file
 * requires nothing at the top, and each branch requires only its own entry. dist/index.js still
 * starts the server when run directly, as existing MCP configs do.
 */

/** The verbs the CLI answers. Anything else (no argument, a flag, `serve`) is the MCP server. */
export const CLI_VERBS: ReadonlySet<string> = new Set([
  'hook',
  'init',
  'review',
  'relevant',
  'capture',
  'session',
  'ambient',
  'profile',
  'config',
  'repair',
  'stats',
  'feedback',
  'drafts',
  'migrate',
  'sync',
  'join',
  'copy',
  'handover',
  'recover',
]);

export type BinRoute =
  | { readonly kind: 'cli'; readonly argv: readonly string[] }
  | { readonly kind: 'server'; readonly argv: readonly string[] };

/** The server flag that takes a value; every other server flag stands alone. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--project-root', '--project']);

/**
 * Where a command line goes. The server takes flags only, so the first word that is not a flag
 * (or a flag's value) decides: none, or `serve`, is the server; anything else is the CLI, verb
 * first, with any flags written before it moved after it. A word the CLI does not know is a usage
 * error there, never a server started inside a mistyped hook (the m01 build critic).
 */
export function routeArgv(argv: readonly string[]): BinRoute {
  let at = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      at = i;
      break;
    }
  }
  if (at === -1) return { kind: 'server', argv };
  const before = argv.slice(0, at);
  const after = argv.slice(at + 1);
  if (argv[at] === 'serve') return { kind: 'server', argv: [...before, ...after] };
  return { kind: 'cli', argv: [argv[at], ...after, ...before] };
}

if (require.main === module) {
  const target = routeArgv(process.argv.slice(2));
  if (target.kind === 'cli') {
    void import('./cli').then((cli) => cli.main(target.argv));
  } else if (target.argv.includes('--version')) {
    // Match runServer's version precedence without loading its SDK, env loader, or database tools.
    void import('./server-version').then(({ getServerVersion }) => {
      process.stdout.write(`reasonbook ${getServerVersion()}\n`);
      process.exit(0);
    });
  } else {
    void import('./index').then((server) => server.runServer(target.argv));
  }
}

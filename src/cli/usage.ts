// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pure CLI usage and accepted options, available before loading a command or the server.
// ABOUTME: Reject unknown options and stray words without changing the argv handlers receive.

import { boundErrorValue } from '../tools/rbook/error-bounds';

const ROOT = ['project-root'];
const ROUTE = ['ssh', 'remote-root', 'node', 'bin', 'config-dir'];
const OPTIONS: Readonly<
  Record<string, { readonly values: readonly string[]; readonly switches?: readonly string[] }>
> = {
  init: { values: [...ROOT, 'level', 'name'], switches: ['no-hooks'] },
  review: { values: [...ROOT, 'format'] },
  relevant: { values: [...ROOT, 'query', 'limit', 'format'] },
  decisions: {
    values: [
      ...ROOT,
      'session-id',
      'content',
      'context',
      'consequences',
      'mode',
      'domain',
      'alternatives',
      'deciders',
      'mission',
      'sprint',
      'format',
    ],
  },
  capture: { values: [...ROOT, 'session-id', 'category', 'content', 'mission', 'format'] },
  session: { values: [...ROOT, 'session-id'] },
  ambient: { values: ROOT },
  profile: { values: ROOT },
  config: { values: ROOT },
  repair: { values: ROOT, switches: ['guard'] },
  stats: {
    values: [...ROOT, 'since', 'until', 'baseline-since', 'baseline-until', 'include-project'],
    switches: ['export'],
  },
  feedback: { values: [...ROOT, 'content', 'format'], switches: ['dry-run'] },
  drafts: { values: [...ROOT, 'format'], switches: ['all'] },
  migrate: { values: [...ROOT, 'project'], switches: ['apply', 'docs-only', 'config'] },
  sync: {
    values: [...ROOT, ...ROUTE, 'bundle-out', 'bundle-in', 'for'],
    switches: ['serve', 'confirm-owner', 'join', 'auto'],
  },
  join: {
    values: [
      ...ROOT,
      ...ROUTE,
      'dashboard',
      'into',
      'member',
      'request-out',
      'answer',
      'out',
      'apply',
    ],
  },
  copy: { values: [...ROOT, 'to'] },
  handover: { values: [...ROOT, ...ROUTE] },
  recover: { values: [...ROOT, ...ROUTE, 'members', 'routes', 'drop'] },
  share: { values: ROOT, switches: ['dashboard', 'yes'] },
  move: { values: [...ROOT, 'to'] },
  'set-aside': { values: [...ROOT, 'replica'], switches: ['yes'] },
  import: { values: [...ROOT, 'from', 'include'], switches: ['apply'] },
  signals: { values: [...ROOT, 'format'] },
  brief: { values: ['days', 'format'] },
  'spin-out': {
    values: ['from', 'to', 'sprint', 'missions', 'decisions', 'learnings', 'next-steps'],
    switches: ['apply'],
  },
  doctor: { values: [...ROOT, 'format'], switches: ['offline'] },
  serve: { values: ROOT, switches: ['version', 'whoami'] },
};

/** Name checks only: handlers keep their established value, duplicate and subcommand checks. */
export function firstUnknownOption(verb: string, argv: readonly string[]): string | null {
  // Unknown verbs keep their own usage refusal; hooks deliberately accept future harness options.
  if (!Object.prototype.hasOwnProperty.call(OPTIONS, verb)) return null;
  const options = OPTIONS[verb];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') continue;
    const option = arg.split('=', 1)[0];
    const name = option.slice(2);
    if (
      !option.startsWith('--') ||
      (!options.values.includes(name) && !options.switches?.includes(name))
    )
      return option;
    // Match parseArgs' value boundary; never reinterpret a short-dash value or rewrite it.
    if (
      options.values.includes(name) &&
      !arg.includes('=') &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith('--')
    )
      i += 1;
  }
  return null;
}

const POSITIONAL_LIMIT: Readonly<Record<string, number>> = {
  decisions: 1,
  session: 1,
  ambient: 1,
  profile: 1,
  drafts: 1,
};
const LIKELY_FLAG: Readonly<Record<string, string>> = {
  init: 'name',
  relevant: 'query',
  decisions: 'content',
  capture: 'content',
  feedback: 'content',
  session: 'session-id',
  move: 'to',
  copy: 'to',
  'set-aside': 'replica',
  import: 'from',
  join: 'dashboard',
  handover: 'ssh',
  recover: 'members',
  brief: 'days',
  'spin-out': 'from',
};

/** Options consume only their declared value; a switch must never swallow a stray project name. */
export function unexpectedArgument(verb: string, argv: readonly string[]): string | null {
  if (!Object.prototype.hasOwnProperty.call(OPTIONS, verb)) return null;
  const options = OPTIONS[verb];
  const words: Array<{ value: string; precedingFlag?: string }> = [];
  let lastValueFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=', 1)[0];
      lastValueFlag = undefined;
      if (options.values.includes(name)) {
        lastValueFlag = name;
        if (!arg.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
      }
    } else {
      words.push({ value: arg, precedingFlag: lastValueFlag });
      lastValueFlag = undefined;
    }
  }
  // Author names intentionally accept several words; the config handler validates its action.
  const limit =
    verb === 'config'
      ? words[0]?.value === 'author'
        ? Infinity
        : 1
      : (POSITIONAL_LIMIT[verb] ?? 0);
  if (words.length <= limit) return null;
  const word = boundErrorValue(words[limit].value.replace(/[\r\n]/g, ' '));
  const level = verb === 'init' && ['ledger', 'planner', 'builder'].includes(words[limit].value);
  const hint =
    words[limit].precedingFlag ??
    (level ? 'level' : LIKELY_FLAG[verb]) ??
    (limit ? 'help' : 'project-root');
  return `unexpected argument ${JSON.stringify(word)}. Use --${hint}${hint === 'help' ? ' for usage' : ' for this value; quote values containing spaces'}.`;
}

export const USAGE =
  'Usage: reasonbook <verb> …\n' +
  '  hook <session-start|prompt|stop|pre-compact|session-end> [--format claude|text] [--hook-source <source>]\n' +
  '       [--harness claude|codex|cursor|devin|copilot|vscode]\n' +
  '  review --format=context        the record digest, for an agent\n' +
  '  relevant --query <text>        decisions and learnings that match, as previews\n' +
  '  decisions record --session-id <id> --content <headline> [--context <why>] [--mode autonomous]\n' +
  '  capture --session-id <id> --category <c> --content <text>\n' +
  '  feedback --content <text> [--dry-run] [--format json]\n' +
  '                                 file friction now, without a session or mission\n' +
  '  session ensure|close --session-id <id>\n' +
  '  ambient [on|off|digest-off]    how present Reasonbook is in this project\n' +
  '  init [--level ledger|planner|builder] [--no-hooks] [--name <n>]\n' +
  '                                 start a Reasonbook record here: AGENTS.md, CLAUDE.md and the store\n' +
  '  spin-out --from <root> --to <folder> (--sprint <id>|--missions <ids>) [--apply]\n' +
  '                                 preview or copy selected work into its own project\n' +
  '  migrate [--apply] [--docs-only] [--project <root>] [--config]\n' +
  '                                 preview or apply the Reasonbook rename\n' +
  '  doctor [--offline] [--format json] [--project-root <root>]\n' +
  '                                 list setup drift and the fix for each; writes nothing\n' +
  '  profile show                   the operator profile every project reads\n' +
  '  config author [<name>]         the author name your records carry, or where it comes from\n' +
  '  repair --guard [--project-root <root>]\n' +
  "                                 rebuild a shared record's write guard\n" +
  '  sync [--bundle-out <file>|--bundle-in <file>|--confirm-owner]\n' +
  "                                 exchange with the shared record's other copies\n" +
  '  join --ssh <host> --remote-root <folder> --member <name>\n' +
  "                                 join a copy to the shared record, from the owner's copy\n" +
  '  join --dashboard <address> [--into <folder>]\n' +
  '                                 join a project shared with you through the dashboard\n' +
  '  share --dashboard [--yes]       share this project through the dashboard, after a dry run\n' +
  '  move --to owner                move a project shared through the dashboard back here\n' +
  '  set-aside --replica <id> [--yes] preview or set aside one gone copy, on the authority copy\n' +
  '  copy --to <folder>             a safe copy of this store, made while the server runs\n' +
  '  handover --ssh <host> --remote-root <folder>\n' +
  "                                 hand the owner's copy over to the owner's other copy\n" +
  '  recover --members <names> (--ssh <host> --remote-root <folder>|--routes <file>)\n' +
  "                                 make this copy the owner's when the owner's copy is lost\n" +
  '  import --from <folder> [--apply] [--include <table>:<id>,...]\n' +
  '                                 bring in a copy made before the project was shared\n' +
  '  stats [--export]               local usage measurements, as counts\n' +
  '  drafts list [--all] [--format json]\n' +
  '                                 drafted records awaiting the operator\n' +
  '  signals [--project-root <dir>] [--format json]\n' +
  '                                 what needs a person in each project on this machine, as counts\n' +
  '  brief [--days 1..365] [--format md|json]\n' +
  "                                 the weekly brief over this machine's projects\n" +
  '  serve                          run the MCP server (the default with no verb)\n' +
  'Use -h or --help for usage; --version prints the installed version; --whoami explains server attribution.\n' +
  'Other verbs take --project-root <dir>; brief covers all registered projects and refuses it.\n' +
  'spin-out requires --from and --to explicitly.\n' +
  'Use the migration guide when upgrading an existing installation.\n';

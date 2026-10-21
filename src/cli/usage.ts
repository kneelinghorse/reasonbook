// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The usage text reasonbook prints for an unknown or missing verb: every verb and its main options,
// ABOUTME: one line each, with a second line where a verb's purpose needs saying.

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
  '  brief [--days 7] [--format md|json]\n' +
  "                                 the weekly brief over this machine's projects\n" +
  '  serve                          run the MCP server (the default with no verb)\n' +
  'Other verbs take --project-root <dir>; spin-out requires --from and --to explicitly.\n' +
  'Use the migration guide when upgrading an existing installation.\n';

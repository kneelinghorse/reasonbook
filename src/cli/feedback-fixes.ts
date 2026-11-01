// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook feedback resolve-fixed [--apply] and reopen-fixed --rule <id> (s108-m04): resolve, in this project's
// ABOUTME: own store only, the feedback rows a shipped release fixed, and undo what a rule resolved. Dry run by default.

import { oneLine, resolveCliProject, type CliIo } from './core';
import { observeCliResult } from './telemetry';
import { withClient } from '../tools/rbook/client';
import { createError } from '../tools/rbook/errors';
import {
  applyFeedbackFixes,
  planFeedbackFixes,
  reopenableRules,
  reopenFeedbackFixes,
  type FeedbackFixPlan,
} from '../tools/rbook/feedback-fix-apply';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import type { RbookToolResult } from '../tools/rbook/types';

export type FeedbackFixCommand = 'resolve-fixed' | 'reopen-fixed';

function planText(plan: FeedbackFixPlan, applied: readonly number[] | null): string {
  const lines = [
    applied === null
      ? `Dry run: ${plan.rows.length} feedback ${plan.rows.length === 1 ? 'row' : 'rows'} would be resolved as fixed by a shipped release. Nothing was changed; --apply resolves them.`
      : `Resolved ${applied.length} feedback ${applied.length === 1 ? 'row' : 'rows'} as fixed by a shipped release; reopen-fixed --rule <id> undoes a rule's.`,
    'By rule, each counted alone (fixed, and partly fixed, which stays open):',
    ...plan.perRule.map(
      (rule) =>
        `  ${rule.rule} (fixed in ${rule.fixedIn}): ${rule.fixed} fixed, ${rule.partly} partly`
    ),
    ...plan.rows.map(
      (row) =>
        `  #${row.id} ${row.rule}@${row.revision} (${row.fixedIn}): ${oneLine(row.firstSentence)}`
    ),
    ...(plan.held.length
      ? [
          `Left for a person: ${plan.held.length} fixed ${plan.held.length === 1 ? 'row is' : 'rows are'} triaged or carry a note, which an apply never overwrites: ${plan.held.map((row) => `#${row.id}`).join(', ')}.`,
        ]
      : []),
    `Counting rule: ${plan.rule}.`,
  ];
  return `${lines.join('\n')}\n`;
}

export async function runFeedbackFixes(
  command: FeedbackFixCommand,
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  const finish = (result: RbookToolResult<unknown>, text: () => string): number => {
    observeCliResult(io, 'feedback', {}, result);
    if (flags.format === 'json') io.stdout(`${JSON.stringify(result)}\n`);
    else if (!result.success)
      io.stderr(
        oneLine(
          `reasonbook feedback ${command}: ${result.error?.message ?? 'Nothing was changed.'} ${result.error?.suggestion ?? ''}`
        )
      );
    else io.stdout(text());
    for (const warning of result.warnings ?? [])
      if (flags.format !== 'json') io.stdout(`Warning: ${oneLine(warning)}\n`);
    return result.success ? 0 : 1;
  };
  const apply = command === 'resolve-fixed' ? flags.apply === 'true' : true;
  const rule = flags.rule;
  // --rule would otherwise be read past: an apply resolves every shipped rule's rows.
  if (command === 'resolve-fixed' && rule !== undefined)
    return finish(
      createError({
        code: 'INVALID_PARAMETER',
        message:
          'resolve-fixed applies every shipped rule, and takes no --rule; nothing was changed.',
        suggestion:
          "Run resolve-fixed without --rule, and see each rule's rows in its dry run; --rule names a rule for reopen-fixed.",
      }),
      () => ''
    );
  // --dry-run would otherwise be read past: resolve-fixed is a dry run unless --apply, and a
  // reopen has none.
  if (flags['dry-run'] === 'true' && apply)
    return finish(
      createError({
        code: 'INVALID_PARAMETER',
        message: `${command === 'reopen-fixed' ? 'reopen-fixed has no dry run' : '--dry-run and --apply contradict each other'}; nothing was changed.`,
        suggestion:
          'For a dry run, run resolve-fixed without --apply: it lists the rows an apply would resolve, and the rows a reopen could give back carry fix_rule.',
      }),
      () => ''
    );
  if (command === 'reopen-fixed' && (!rule?.trim() || rule === 'true'))
    return finish(
      createError({
        code: 'INVALID_PARAMETER',
        message: 'reopen-fixed needs the rule whose rows to reopen.',
        suggestion:
          "Pass --rule <id>, as a resolved row's fix_rule names it (for example completion.decisions-advisory).",
      }),
      () => ''
    );
  if (apply && isReadOnlyAgentSession(io.env))
    return finish(
      createError({
        code: 'READ_ONLY_AGENT',
        message: 'RBOOK_AGENT_ROLE=review permits only reads; nothing was changed.',
        suggestion: 'Run it from a write-enabled session, or drop --apply for the dry run.',
      }),
      () => ''
    );
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store')
    return finish(
      createError({
        code: 'RBOOK_NOT_DETECTED',
        message:
          resolution.kind === 'store-missing'
            ? `The Reasonbook store is missing: ${resolution.dbPath}.`
            : `No Reasonbook project at ${resolution.kind === 'none' ? resolution.workingDir : resolution.dir}.`,
        suggestion:
          'Pass --project-root <dir> for an existing Reasonbook project; only its own store is changed.',
      }),
      () => ''
    );
  const options = { projectRoot: resolution.projectRoot, registerProject: false } as const;
  if (command === 'reopen-fixed') {
    // A misspelled rule would reopen nothing and say so as a success.
    const known = await withClient(reopenableRules, { ...options, readonly: true });
    if (known.success && !known.data!.includes(rule!.trim()))
      return finish(
        createError({
          code: 'INVALID_PARAMETER',
          message: `No shipped rule and no resolved row here has the rule id ${oneLine(rule!.trim())}; nothing was changed.`,
          suggestion: `Pass one of: ${known.data!.join(', ')}.`,
        }),
        () => ''
      );
    const result = await withClient((client) => reopenFeedbackFixes(client, rule!.trim()), options);
    return finish(result, () => {
      const data = result.data!;
      return `Reopened ${data.reopened.length} feedback ${data.reopened.length === 1 ? 'row' : 'rows'} rule ${data.rule} had resolved${data.kept.length ? `; left ${data.kept.length} it could not confirm unchanged since its apply (a person changed them, or the ledger no longer names them)` : ''}.\n`;
    });
  }
  if (!apply) {
    // The dry run opens the store read-only, so it cannot write even by accident.
    const result = await withClient(planFeedbackFixes, { ...options, readonly: true });
    return finish(result, () => planText(result.data!, null));
  }
  const result = await withClient((client) => applyFeedbackFixes(client), options);
  return finish(result, () => planText(result.data!, result.data!.resolved));
}

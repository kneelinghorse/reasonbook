// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Present digest v2 to MCP without duplicating it inside the legacy 4096-byte structured payload.
// ABOUTME: The shared local core is stable; bounded portfolio text follows its pointer and warnings stay explicit.

import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import {
  rbookReview,
  formatReviewForLLM,
  type RbookReviewParams,
  type RbookReviewResult,
  type PortfolioSection,
} from './rbook-review';
import { renderDigestV2 } from './digest-v2';
import { personSignalsPhrase } from './portfolio-signals';
import { readDigestV2 } from './digest-v2-store';
import { createError } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { readDashboardUploadStatus } from './dashboard-upload-scheduler';
import type { RenderedContext } from './rendered-context';
import type { RbookToolResult } from './types';

export interface ReviewPresentation {
  readonly result: RbookToolResult<RbookReviewResult>;
  readonly context: RenderedContext | null;
  readonly text: string;
}

/** Portfolio counts describe durable state; no latency, relative drift age or mutable mtime oracle. */
export function formatReviewPresentation(
  context: RenderedContext,
  portfolio: PortfolioSection | null,
  local: string | null
): string {
  if (!portfolio) return context.text;
  const lines = [
    context.text,
    '',
    `Portfolio: ${portfolio.activeMissions.count} active missions across ${portfolio.projects} stores; ` +
      `${portfolio.reachable} reachable, ${portfolio.silent} silent, ${portfolio.unmigrated} un-migrated, ${portfolio.unreadable} unreadable.`,
  ];
  for (const row of portfolio.activeMissions.top.slice(0, 5)) {
    const name = row.name.replace(/\s+/g, ' ');
    const short = name.length > 100 ? `${name.slice(0, 99)}…` : name;
    lines.push(`  ${row.id}: ${frameInlineIfForeign(short, row.projectId, local)}`);
  }
  // s97-m01: what needs a person in the other projects, as counts beside each framed name.
  const signals = portfolio.signals;
  if (signals) {
    const projects = signals.projects === 1 ? 'project' : 'projects';
    if (signals.projects > 0)
      lines.push(`Needs a person in ${signals.projects} other ${projects}:`);
    for (const item of signals.top) {
      const name = frameInlineIfForeign(item.name, item.projectId, local);
      lines.push(`  ${name}: ${personSignalsPhrase(item)}`);
    }
    if (signals.unread)
      lines.push(
        `Some signals could not be read in ${signals.unread} other ${signals.unread === 1 ? 'project' : 'projects'}.`
      );
  }
  return lines.join('\n');
}

/** A deliberately explicit bundle: no non-enumerable caches, and no I/O inside the formatter. */
export async function rbookReviewPresentation(
  params: RbookReviewParams,
  options: Parameters<typeof rbookReview>[1] = {}
): Promise<ReviewPresentation> {
  const result = await rbookReview(params, options);
  if (!result.success || !result.data)
    return { result, context: null, text: formatReviewForLLM(result) };
  try {
    const root = params.projectRoot ?? result.data.projectRoot;
    if (!root) throw new Error('Resolved project root is unavailable for the digest.');
    const upload = await readDashboardUploadStatus(root);
    const presented = upload ? attachWarnings(result, [upload]) : result;
    const model = await readDigestV2(root);
    const context = renderDigestV2(model, { projectRoot: root, resolvedBy: options.resolvedBy });
    const lines = [formatReviewPresentation(context, result.data.portfolio, model.localProjectId)];
    // Preserve the existing action policy (including ambiguous-address whoami) without injecting
    // its dynamic descriptions or commands into the stable local hook/CLI core.
    if (result.data.next_actions.length) {
      lines.push('', 'Next actions:');
      for (const action of result.data.next_actions.slice(0, 3)) lines.push(`  ${action.command}`);
    }
    appendWarnings(lines, presented);
    return { result: presented, context, text: lines.join('\n') };
  } catch (error) {
    const failed = createError<RbookReviewResult>({
      code: 'DB_QUERY_FAILED',
      message: error instanceof Error ? error.message : 'The local digest could not be read.',
      suggestion: 'Check rbook_db(action="health") for this project, then retry the review.',
    });
    return { result: failed, context: null, text: formatReviewForLLM(failed) };
  }
}

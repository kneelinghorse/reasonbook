// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Present local and fleet feedback with explicit count coverage and source boundaries.
// ABOUTME: Warnings stay visible even when no rows match, and foreign prose never escapes its frame.

import type { RbookToolResult } from './types';
import type {
  RbookFeedbackAction,
  RbookFeedbackBulkResult,
  RbookFeedbackResult,
  RbookFeedbackListResult,
  RbookFeedbackMutationResult,
} from './rbook-feedback';
import { FEEDBACK_KINDS_RULE } from '../../signals/feedback-kinds';

/** s97-m07: every kind, zeros included, then unclassified, with the rule that sorted them. */
function kindLine(data: RbookFeedbackListResult): string | null {
  if (!data.countsByKind) return null;
  const counts = Object.entries(data.countsByKind)
    .map(([kind, n]) => `${kind}=${n}`)
    .join(', ');
  return `By kind: ${counts} (${FEEDBACK_KINDS_RULE}).`;
}

/**
 * The feedback answer itself. Split out of formatFeedbackForLLM in s86-m02 so the envelope
 * warnings channel renders from one tail instead of once per branch.
 */
export function renderFeedbackBody(
  action: RbookFeedbackAction,
  result: RbookToolResult<RbookFeedbackResult>
): string {
  if (!result.success || !result.data) {
    const err = result.error;
    return `❌ rbook_feedback(${action}) failed: ${err?.message ?? 'Unknown error'}${err?.suggestion ? `\n  Suggestion: ${err.suggestion}` : ''}`;
  }
  if (action === 'list') {
    const d = result.data as RbookFeedbackListResult;
    if (d.fleet) return renderFleetFeedback(d);
    if (d.entries.length === 0) {
      return `No agent feedback matching filter (limit ${d.limit}).`;
    }
    const head = `Agent feedback — ${d.entries.length} of ${d.totalCount} entries (limit ${d.limit}).`;
    const byTool = Object.entries(d.countsByTool)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const byStatus = Object.entries(d.countsByStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const meta = `By tool: ${byTool || '(none)'} | All statuses: ${byStatus || '(none)'}`;
    const kinds = kindLine(d);
    const lines = d.entries.slice(0, 10).map((e) => {
      const snippet = e.body.length > 140 ? `${e.body.slice(0, 137)}…` : e.body;
      return `  #${e.id} [${e.status}] (${e.kind}) ${e.toolName} @ ${e.createdAt}\n    ${snippet}`;
    });
    const more = d.entries.length > 10 ? `\n  ... ${d.entries.length - 10} more` : '';
    return `${head}\n${meta}${kinds ? `\n${kinds}` : ''}\n${lines.join('\n')}${more}`;
  }
  if ('resolved' in result.data) {
    const bulk = result.data as RbookFeedbackBulkResult;
    return `${bulk.message}${bulk.resolutionNote ? `\n  Note: ${bulk.resolutionNote}` : ''}`;
  }
  const m = result.data as RbookFeedbackMutationResult;
  const noteLine = m.resolutionNote ? `\n  Note: ${m.resolutionNote}` : '';
  return `${m.message}${noteLine}`;
}

function renderFleetFeedback(data: RbookFeedbackListResult): string {
  const coverage = data.fleet!;
  const lines = [
    `Fleet feedback (${coverage.complete ? 'complete' : 'partial'} coverage): ${data.entries.length} of ${data.totalCount} matching rows, global limit ${data.limit}.`,
    'Counts include every matching row without deduplication; unavailable stores are excluded.',
    ...(kindLine(data) ? [kindLine(data)!] : []),
    ...coverage.stores.map(
      (store) =>
        `  ${store.projectId}: ${store.state === 'unavailable' ? 'unavailable' : `${store.totalCount} matching${store.state === 'absent' ? ' (no feedback table)' : ''}`}`
    ),
    'For a sibling disposition, send that project an explicitly authorized message; never write its store.',
  ];
  for (const entry of data.entries) {
    lines.push(`  ${entry.sourceProjectId} feedback #${entry.id} (${entry.kind})`, entry.body);
    if (entry.resolutionNote) lines.push(entry.resolutionNote);
  }
  return lines.join('\n');
}

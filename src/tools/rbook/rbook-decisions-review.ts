/**
 * rbook_decisions review action
 *
 * Returns stale and approaching-stale decisions with per-decision
 * staleness scores and suggested lifecycle actions (archive/confirm/review),
 * and (s93-m11) the learnings past the review age or marked stale, each with its age.
 * Read-only — does not mutate the database (read-classified since s93-m11, so a review-role
 * agent can run the remedy the opener names).
 *
 * @module tools/rbook/rbook-decisions-review
 */

import { withClientValidated } from './client';
import type { RbookToolResult } from './types';
import {
  reviewDecisionStaleness,
  type DecisionReviewResult,
  type StaleDecisionDetail,
} from './staleness-detection';
import { buildUntaggedDecisionAdvisory } from './untagged-advisory';
import { appendWarnings } from './format-warnings';
import {
  nextPageCall,
  pageFacts,
  pageRequest,
  REREAD_AFTER_ACTING,
  shownLine,
} from './answer-page';
import { PREVIEW_MAX_CHARS } from './text-preview';

/**
 * s106-m03: a registered store's review was 258,332 characters, every candidate on one answer,
 * and 10 of each list still 20,128. A page holds pageSize decisions and pageSize learnings; every
 * count covers all of them.
 */
export const REVIEW_PAGE_SIZE = 8;

export interface RbookDecisionsReviewResult extends DecisionReviewResult {
  /** Decisions needing attention in all; `decisions` holds this page's, most stale first. */
  decisionCount: number;
  /** Learnings needing review in all; `learnings` holds this page's. */
  learningCount: number;
  /** Every candidate decision by its suggested action, not only this page's. */
  countsByAction: Record<StaleDecisionDetail['suggestedAction'], number>;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next page, or null on the last page. */
  nextPageCall: string | null;
  /** While a page follows: archiving or confirming moves the later rows up; re-read first. */
  pageNote: string | null;
}

export interface RbookDecisionsReviewParams {
  /** Include decisions approaching staleness (default true) */
  includeApproaching?: boolean;
  /** s106-m03: page of decisions and learnings, 1-based */
  page?: number;
  /** s106-m03: decisions and learnings per page (default REVIEW_PAGE_SIZE) */
  pageSize?: number;
  /** Optional project root */
  projectRoot?: string;
}

export async function rbookDecisionsReview(
  params: RbookDecisionsReviewParams
): Promise<RbookToolResult<RbookDecisionsReviewResult>> {
  return withClientValidated(
    (client) => {
      const result = reviewDecisionStaleness(client, {
        includeApproaching: params.includeApproaching ?? true,
      });

      // s85-m03: staleness-detection.ts filters `sprint_id IS NOT NULL` when choosing
      // candidates, so an untagged active decision can NEVER be flagged stale. After m03
      // that set grows with normal use on a store with no open sprint, so report it rather
      // than let triage silently shrink.
      const untagged = buildUntaggedDecisionAdvisory(client);

      const request = pageRequest(params.page, params.pageSize, REVIEW_PAGE_SIZE);
      const longest = Math.max(result.decisions.length, result.learnings.length);
      const facts = pageFacts(
        request,
        Math.min(request.pageSize, Math.max(0, longest - request.offset)),
        longest
      );
      const countsByAction = { archive: 0, review: 0, confirm: 0 };
      for (const decision of result.decisions) countsByAction[decision.suggestedAction] += 1;
      const slice = <T>(rows: readonly T[]): T[] =>
        rows.slice(request.offset, request.offset + request.pageSize);

      return {
        success: true as const,
        data: {
          ...result,
          decisions: slice(result.decisions),
          learnings: slice(result.learnings),
          decisionCount: result.decisions.length,
          learningCount: result.learnings.length,
          countsByAction,
          page: facts.page,
          pageSize: facts.pageSize,
          hasMore: facts.hasMore,
          nextPage: facts.nextPage,
          nextPageCall: nextPageCall(facts.nextPage, 'rbook_decisions', {
            action: 'review',
            includeApproaching: params.includeApproaching,
            pageSize: params.pageSize,
            projectRoot: params.projectRoot,
          }),
          pageNote: facts.nextPage === null ? null : REREAD_AFTER_ACTING,
        },
        ...(untagged ? { warnings: [untagged] } : {}),
      };
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatDecisionsReviewForLLM(
  result: RbookToolResult<RbookDecisionsReviewResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to review decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const learnings = data.learnings ?? [];
  const lines: string[] = [];

  lines.push('📋 **Decision Lifecycle Review**');
  lines.push('');
  lines.push(
    `Active: ${data.totalActive} | Stale: ${data.totalStale} | Threshold: ${data.threshold} sprints | Current Sprint: ${data.currentSprintNumber ?? 'unknown'}`
  );

  if (data.decisionCount === 0 && data.learningCount === 0) {
    lines.push('');
    lines.push('✅ No decisions or learnings need attention.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  // s106-m03: counts cover every candidate; the rows below are this page's.
  const pageOf = (totalCount: number) => ({
    page: data.page,
    pageSize: data.pageSize,
    totalCount,
  });
  lines.push('');
  if (data.decisionCount === 0) {
    lines.push('✅ No decisions need attention.');
  } else {
    const all = data.countsByAction;
    lines.push(
      `**${data.decisionCount} decision(s) need attention** (archive ${all.archive}, review ${all.review}, confirm ${all.confirm}). ${shownLine(pageOf(data.decisionCount), data.decisions.length, 'decisions')}.`
    );
  }
  lines.push('');

  // Group by suggested action
  const byAction = {
    archive: data.decisions.filter((d) => d.suggestedAction === 'archive'),
    review: data.decisions.filter((d) => d.suggestedAction === 'review'),
    confirm: data.decisions.filter((d) => d.suggestedAction === 'confirm'),
  };

  if (byAction.archive.length > 0) {
    lines.push(`**🗄️ Suggested: Archive (${byAction.archive.length})**`);
    for (const d of byAction.archive) {
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} — ${d.text}`);
    }
    lines.push(
      `  → this page's ${byAction.archive.length}: rbook_decisions(action="batch_update", decisionIds=[${byAction.archive.map((d) => d.id).join(',')}], status="archived")`
    );
    lines.push('');
  }

  if (byAction.review.length > 0) {
    lines.push(`**🔍 Suggested: Review (${byAction.review.length})**`);
    for (const d of byAction.review) {
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} — ${d.text}`);
    }
    lines.push('');
  }

  if (byAction.confirm.length > 0) {
    lines.push(`**✅ Suggested: Confirm (${byAction.confirm.length})**`);
    for (const d of byAction.confirm) {
      const tag = d.hasEvidence ? '(has evidence)' : '(referenced)';
      lines.push(`  #${d.id} [${d.sprintId}] score=${d.stalenessScore} ${tag} — ${d.text}`);
    }
    lines.push('');
  }

  const cut = data.decisions.find((d) => d.truncated);
  if (cut) {
    lines.push(
      `Decision previews are cut at ${PREVIEW_MAX_CHARS} characters; read one whole with rbook_decisions(action="show", decisionId=${cut.id}).`
    );
    lines.push('');
  }

  if (data.learningCount > 0) {
    lines.push(
      `**📚 Learnings: ${shownLine(pageOf(data.learningCount), learnings.length, 'learnings').replace(/^S/, 's')}**`
    );
    for (const l of learnings) {
      const age = l.sprintAge === null ? 'age unknown' : `${l.sprintAge} sprints old`;
      lines.push(`  #${l.id} [${l.sprintId ?? 'no sprint'}] ${l.status}, ${age} — ${l.text}`);
    }
    lines.push(
      '  → still holds: rbook_learnings(action="reaffirm", learningId=…) records the review; ' +
        'no longer holds: rbook_learnings(action="update", learningId=…, status="archived"); ' +
        'show reads one in full.'
    );
    lines.push('');
  }

  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);
  if (data.pageNote) lines.push(data.pageNote);

  appendWarnings(lines, result);

  return lines.join('\n');
}

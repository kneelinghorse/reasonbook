// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Summarizes persisted session-capture blobs for close-time audit receipts.
// ABOUTME: Treats malformed capture state as unknown so diagnostics never invent a zero.

import type { RbookDatabaseClient } from './client';
import { computeContentHash, SAME_TEXT_SQL } from './schema-migrations';

/**
 * Parse a stored session capture blob for diagnostic receipts.
 *
 * A malformed or non-array value is unknown rather than zero: zero would claim
 * that no deferred work exists when the stored value could not be inspected.
 */
export interface SessionCaptureSummary {
  captureCount: number | null;
  deferredCaptureCount: number | null;
  malformed: boolean;
}

/**
 * s100-m03 (#712): a next step captured since 4.2.1 is written when captured, so it waits for nothing.
 * `hasNextStepRow` says whether a next-step capture's content already has its row; without it every
 * next-step capture counts as deferred, as before.
 */
export function summarizeSessionCaptures(
  rawCaptures: string | null,
  hasNextStepRow: (content: string) => boolean = () => false
): SessionCaptureSummary {
  if (rawCaptures === null) {
    return { captureCount: null, deferredCaptureCount: null, malformed: true };
  }

  try {
    const captures: unknown = JSON.parse(rawCaptures);
    if (!Array.isArray(captures)) {
      return { captureCount: null, deferredCaptureCount: null, malformed: true };
    }

    const deferredCaptureCount = captures.filter((capture) => {
      if (typeof capture !== 'object' || capture === null || !('category' in capture)) {
        return false;
      }
      const { category, content } = capture as { category?: unknown; content?: unknown };
      if (category === 'context') return true;
      return (
        category === 'next-step' && !hasNextStepRow(typeof content === 'string' ? content : '')
      );
    }).length;

    return {
      captureCount: captures.length,
      deferredCaptureCount,
      malformed: false,
    };
  } catch {
    return { captureCount: null, deferredCaptureCount: null, malformed: true };
  }
}

/** s100-m03: the close's dedup key, (content_hash, session_id), as a lookup for a session's captures. */
export function nextStepRowLookup(
  client: RbookDatabaseClient,
  sessionId: string
): (content: string) => boolean {
  return (content) => {
    const text = content.trim();
    const found = client.getOne<{ id: number }>(
      `SELECT id FROM next_steps WHERE ${SAME_TEXT_SQL} AND session_id = ?`,
      [computeContentHash(text, 'next-step'), text, sessionId]
    );
    // A read that fails counts the capture as deferred, which it may be.
    return found.success && !!found.data;
  };
}

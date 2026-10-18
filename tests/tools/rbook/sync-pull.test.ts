// ABOUTME: Preserve public formatter compatibility after retiring dashboard pull.
// ABOUTME: Direct and dispatch retirement behavior is covered by legacy-sync-retired.test.ts.
import { expect, it } from '@jest/globals';
import { formatSyncPullForLLM } from '../../../src/tools/rbook/sync-pull';
const SLUG = 'test-project';

it('shows migration warnings and the recovery suggestion when pull refuses', () => {
  const formatted = formatSyncPullForLLM({
    success: false,
    error: {
      code: 'DB_QUERY_FAILED',
      message: 'Migration refused',
      suggestion: 'Inspect schema',
    },
    warnings: ['Foreign FTS definition is preserved'],
  });
  expect(formatted).toContain('Migration refused');
  expect(formatted).toContain('Foreign FTS definition is preserved');
  expect(formatted).toContain('Inspect schema');
});

it('formats a successful pull for the LLM', () => {
  const formatted = formatSyncPullForLLM({
    success: true,
    data: {
      slug: SLUG,
      fromCursor: 0,
      toCursor: 5,
      pages: 1,
      received: 5,
      inserted: 4,
      duplicates: 1,
      transitionsApplied: 0,
      transitionsSkipped: 0,
      transitionsDeferred: 2,
      skippedMissingProvenance: 0,
      skippedUnknownType: 0,
      failed: 0,
      insertedByType: { decision_captured: 4 },
      message: 'ok',
    },
  });
  expect(formatted).toContain('PULL complete');
  expect(formatted).toContain('decision_captured:4');
  expect(formatted).toContain('deferred');
});

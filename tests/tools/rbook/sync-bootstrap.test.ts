// ABOUTME: Preserve public formatter compatibility after retiring dashboard clone.
// ABOUTME: Direct and dispatch retirement behavior is covered by legacy-sync-retired.test.ts.
import { expect, it } from '@jest/globals';
import { formatSyncBootstrapForLLM } from '../../../src/tools/rbook/sync-bootstrap';
const SLUG = 'test-project';

it('shows migration warnings and the recovery suggestion when clone refuses', () => {
  const formatted = formatSyncBootstrapForLLM({
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

it('formats a successful clone for the LLM', () => {
  const formatted = formatSyncBootstrapForLLM({
    success: true,
    data: {
      slug: SLUG,
      projectId: 'proj-shared',
      cursorSeeded: 42,
      inserted: 7,
      duplicates: 0,
      failed: 0,
      insertedByType: { sprint_added: 1, mission_added: 2 },
      contextsEnsured: 1,
      message: 'ok',
    },
  });
  expect(formatted).toContain('Clone complete');
  expect(formatted).toContain('Cursor seeded: 42');
  expect(formatted).toContain('mission_added:2');
});

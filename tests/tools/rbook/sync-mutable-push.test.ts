// ABOUTME: Dashboard mutable push remains callable only to return the retirement remedy.
// ABOUTME: Supplying an authenticated client and skipPull cannot bypass that boundary.
import { expect, it, jest } from '@jest/globals';
import {
  pushMutableStatus,
  formatPushMutableStatusForLLM,
} from '../../../src/tools/rbook/sync-mutable-push';
import type { DashboardClient } from '../../../src/tools/rbook/dashboard-client';

it('refuses even with a supplied client and skipPull', async () => {
  const push = jest.fn();
  const result = await pushMutableStatus({
    projectRoot: '/missing/retired-store',
    missionId: 'm1',
    status: 'Queued',
    skipPull: true,
    client: { pushMutableEvent: push } as unknown as DashboardClient,
  });
  expect(result).toMatchObject({
    success: false,
    error: { code: 'LEGACY_SYNC_RETIRED', suggestion: expect.stringContaining('reasonbook sync') },
  });
  expect(push).not.toHaveBeenCalled();
  expect(formatPushMutableStatusForLLM(result)).toContain('reasonbook sync');
});

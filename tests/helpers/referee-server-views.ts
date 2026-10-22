// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keep the reference host's ordinary read-only view map outside its route dispatcher.
// ABOUTME: Each unchanged library view still runs through the host's authorized serialized route.
import type { RefereeLocation, RefereeOutcome } from '../../src/referee';
import type { RefereeEngine } from './referee-server-state';

export function refereeViews(
  engine: RefereeEngine,
  url: URL
): Record<string, (location: RefereeLocation) => Promise<RefereeOutcome<unknown>>> {
  return {
    members: engine.members,
    changes: (location) =>
      engine.recentChanges(location, { sinceChangeId: url.searchParams.get('since') }),
    conflicts: engine.conflicts,
    peers: engine.peers,
    waiting: engine.waiting,
  };
}

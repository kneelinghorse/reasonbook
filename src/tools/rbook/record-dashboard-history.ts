// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Former referee provenance comes from exact retained dashboard routes and applied recovery chains.
// ABOUTME: A preceding SSH handover, dashboard registration ID or display address is never such proof.
import type { RbookDatabaseClient } from './client';
import { authorityValue } from './record-authority';
import { isDashboardRoute, type DashboardRoute } from './record-dashboard-route';
import { endDashboardRoute, peerHealth, rememberPeer } from './record-peers';
import { mergeContext } from './record-standing';
import type { Hello } from './record-exchange';
import { recordedProjectId } from './replica-identity';

/** A successful same-record exchange may follow the current referee before held moves are confirmed. */
export function rememberDashboardAuthority(
  client: RbookDatabaseClient,
  route: DashboardRoute,
  remote: Hello
): void {
  if (remote.projectId !== recordedProjectId(client) || remote.replicaId !== remote.authority)
    return;
  const matching = peerHealth(client).filter(
    (peer) =>
      isDashboardRoute(peer.route) &&
      peer.route.url === route.url &&
      peer.route.projectId === route.projectId
  );
  if (!matching.length) return;
  for (const peer of matching)
    if (peer.replicaId !== remote.replicaId) endDashboardRoute(client, peer.replicaId);
  const { ended: _ended, ...active } = route;
  rememberPeer(client, remote.replicaId, { route: active });
}

/** Applied referees bound to this exact dashboard project, including their recovery predecessors. */
export function formerDashboardReferees(
  client: RbookDatabaseClient,
  route: DashboardRoute
): string[] {
  const ctx = mergeContext(client);
  const proved = new Set<string>();
  for (const peer of peerHealth(client)) {
    if (
      !isDashboardRoute(peer.route) ||
      peer.route.url !== route.url ||
      peer.route.projectId !== route.projectId
    )
      continue;
    let term = ctx.terms.find((candidate) => candidate.replicaId === peer.replicaId);
    while (term && !proved.has(term.replicaId)) {
      proved.add(term.replicaId);
      if (!term.change) break;
      const value = authorityValue(term.change);
      if (value.move !== 'recovery') break;
      term = ctx.terms.find((candidate) => candidate.replicaId === value.previous);
    }
  }
  return [...proved];
}

/** Compare released semver capabilities; an equal prerelease has not shipped the required contract. */
export function libraryAtLeast(version: string | null, minimum: string): boolean {
  const parsed = version?.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!parsed) return false;
  const need = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const value = Number(parsed[index + 1]);
    if (!Number.isSafeInteger(value)) return false;
    if (value !== need[index]) return value > need[index];
  }
  return !parsed[4];
}

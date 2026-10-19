// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The route a copy keeps to a dashboard that referees its project (s97-m10, design §R2), apart from the peer
// ABOUTME: that calls it, so the peer table, the SSH far end and the referee library read it without a network client.

/** How a copy reaches its project's referee on a dashboard: routed by registry project id, never by slug (D2). */
export interface DashboardRoute {
  readonly kind: 'dashboard';
  /** The dashboard's address, such as https://reasonbook.ai. */
  readonly url: string;
  /** The project's id in the dashboard's registry (user_projects.id). */
  readonly projectId: string;
}

export function isDashboardRoute(route: unknown): route is DashboardRoute {
  return (
    typeof route === 'object' &&
    route !== null &&
    (route as { kind?: unknown }).kind === 'dashboard' &&
    typeof (route as { url?: unknown }).url === 'string' &&
    typeof (route as { projectId?: unknown }).projectId === 'string'
  );
}

/** The dashboard as a person knows it: its host. */
export function dashboardName(route: DashboardRoute): string {
  try {
    return `the dashboard (${new URL(route.url).host})`;
  } catch {
    return 'the dashboard';
  }
}

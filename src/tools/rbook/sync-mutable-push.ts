// ABOUTME: Retains the retired dashboard mutable-push signature for callers until compatibility removal.
// ABOUTME: A call refuses before its former internal pull, lock, local rewrite or remote event push.

import type { DashboardClient, MutableConflict } from './dashboard-client';
import type { RbookToolResult } from './types';
import type { MutableFieldScope } from './sync-mutable';
import { appendWarnings } from './format-warnings';
import { legacySyncRefusal } from './legacy-sync-refusal';

export interface PushMutableStatusParams {
  projectRoot?: string;
  /** Dashboard slug to push to. Defaults to metadata.dashboard_slug. */
  slug?: string;
  /**
   * The mutable scope being pushed (Sprint 72 m01). Defaults to 'mission_active' — the
   * frozen Sprint 71 mission path.
   */
  fieldScope?: MutableFieldScope;
  /**
   * The entity whose mutable field changed: a mission id, a sprint id, or the
   * `PROJECT_IDENTITY_ENTITY_ID` sentinel for project_identity. Defaults to `missionId`
   * for the mission scope.
   */
  entityId?: string;
  /** Mission-path alias for `entityId` (the Sprint 71 m04 call shape). */
  missionId?: string;
  /** The new value (mission/sprint status, or the project name). */
  status: string;
  /** Skip the pre-push pull (when the caller already pulled this cycle). Default false. */
  skipPull?: boolean;
  /** Injectable clock (ms) for deterministic tests. Defaults to Date.now(). */
  now?: number;
  /** Injectable DashboardClient (tests). Defaults to fromEnvForProject resolution. */
  client?: DashboardClient;
}

export interface PushMutableStatusResult {
  fieldScope: MutableFieldScope;
  entityId: string;
  pushedStatus: string;
  /** The fresh per-edit ordering stamped on the pushed event. */
  occurredAt: number;
  originSeq: number;
  pulledBeforePush: boolean;
  /** The broker's inline LWW conflict, when one was recorded. */
  conflict: MutableConflict | null;
  /** True when OUR push was the LWW loser (the broker kept a newer value). */
  superseded: boolean;
  /** The status the local row holds after converging to the LWW winner. */
  localStatus: string;
  message: string;
}

export async function pushMutableStatus(
  _params: PushMutableStatusParams
): Promise<RbookToolResult<PushMutableStatusResult>> {
  return legacySyncRefusal('Dashboard mutable event push');
}

export function formatPushMutableStatusForLLM(
  result: RbookToolResult<PushMutableStatusResult>
): string {
  if (!result.success) {
    const lines = [`Mutable push failed: ${result.error?.message ?? 'Unknown error'}`];
    if (result.error?.suggestion) lines.push(`Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const d = result.data!;
  const lines = [
    `Mutable push (${d.fieldScope})`,
    '',
    d.message,
    '',
    `Entity: ${d.entityId} | Pushed: ${d.pushedStatus} | Local now: ${d.localStatus}`,
    `Ordering: occurredAt=${d.occurredAt}, originSeq=${d.originSeq} | ` +
      `Pulled-before-push: ${d.pulledBeforePush ? 'yes' : 'no'}`,
  ];
  if (d.conflict) {
    lines.push(
      d.superseded
        ? `⚠ Superseded — restore your value: conflict ${d.conflict.id} (was '${d.conflict.supersededValue}').`
        : `Conflict ${d.conflict.id}: you won; '${d.conflict.supersededValue}' was superseded.`
    );
  }
  appendWarnings(lines, result);

  return lines.join('\n');
}

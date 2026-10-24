// ABOUTME: Detect sprint carry-forwards and route them as dashboard backlog requests.
// ABOUTME: Publication requires the local store's registered sender identity.

/**
 * rbook_sprint carry_forward action
 *
 * Detects carry-forward items (blocked missions, sync gaps) from a completed
 * or active sprint and sends backlog_request messages to a target project
 * via the dashboard messaging API.
 *
 * Read-only on the Reasonbook database — sends messages via DashboardClient.
 *
 * @module tools/rbook/rbook-sprint-carry-forward
 */

import { withClientAsync, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { DashboardClient } from './dashboard-client';
import {
  assertSenderIdentityValid,
  getLocalSenderProjectId,
  SenderAttributionIncompleteError,
} from './sender-identity';
import { appendWarnings } from './format-warnings';
import { normalizeAddressScheme } from '../../intelligence/legacy-compat';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single carry-forward item detected from the sprint.
 */
export interface CarryForwardItem {
  type:
    | 'blocked_mission'
    | 'null_sprint_sessions'
    | 'null_session_decisions'
    | 'pending_next_steps';
  description: string;
  count: number;
  missionId?: string;
}

/**
 * Result of sending a single backlog_request.
 */
export interface CarryForwardSendResult {
  item: CarryForwardItem;
  sent: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Full carry_forward action result.
 */
export interface SprintCarryForwardResult {
  sprintId: string;
  targetAddress: string;
  items: CarryForwardItem[];
  sendResults: CarryForwardSendResult[];
  totalDetected: number;
  totalSent: number;
  totalFailed: number;
}

export interface RbookSprintCarryForwardParams {
  /** Sprint ID to detect carry-forwards for */
  sprintId: string;
  /** Target rbook:// address for backlog_request messages */
  targetAddress: string;
  /** Whether to actually send messages (false = dry run, default true) */
  send?: boolean;
  /** Optional project root */
  projectRoot?: string;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect all carry-forward items for a sprint.
 * Queries blocked missions, sessions with null sprint_id, decisions with null author_session_id.
 */
function detectCarryForwards(client: RbookDatabaseClient, sprintId: string): CarryForwardItem[] {
  const items: CarryForwardItem[] = [];

  // 1. Blocked missions in this sprint
  const blockedResult = client.getMany<{
    id: string;
    name: string;
    notes: string | null;
  }>(
    `SELECT id, name, notes FROM missions
     WHERE sprint_id = ? AND status = 'Blocked'
     ORDER BY rowid ASC`,
    [sprintId]
  );

  if (blockedResult.success && blockedResult.data) {
    for (const m of blockedResult.data) {
      items.push({
        type: 'blocked_mission',
        description: `${m.id}: ${m.name} — ${m.notes ?? 'No details'}`,
        count: 1,
        missionId: m.id,
      });
    }
  }

  // 2. (REMOVED in s85-m03) The `null_sprint_sessions` item type.
  //
  //    It ran a GLOBAL `SELECT COUNT(*) FROM sessions WHERE sprint_id IS NULL` and pushed an
  //    item reading "N session(s) with null sprint_id require dashboard event processor
  //    update". With send=true that emitted a cross-project backlog_request asking a sibling
  //    team to fix a dashboard bug that does not exist.
  //
  //    Its stated cause is now factually false: after s85-m03 a NULL sprint_id is the CORRECT,
  //    intended record for a session started when no sprint is open — not a sync gap. Leaving
  //    it would turn every honest NULL into a false defect report, and the count would climb
  //    with normal use.
  //
  //    Deliberately NOT replaced with a sprint-scoped variant (e.g. inferring the sprint via
  //    session_missions): that would reintroduce exactly the guessing this mission removed.
  //    The untagged count is surfaced instead as a non-blocking advisory on rbook_sprint(retro),
  //    rbook_sprint(complete) and rbook_decisions(review).

  // 3. Decisions with null author session (dashboard sync gap). s69-m04 renamed
  //    session_id → author_session_id; resolve the live column name so the
  //    detector works on both migrated and snapshot-restored (legacy) stores.
  const decisionCols = client.getMany<{ name: string }>(
    "PRAGMA table_info('strategic_decisions')",
    []
  );
  const sessionCol =
    decisionCols.success && decisionCols.data?.some((c) => c.name === 'author_session_id')
      ? 'author_session_id'
      : 'session_id';
  const nullSessionDecisions = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM strategic_decisions WHERE ${sessionCol} IS NULL`
  );
  if (
    nullSessionDecisions.success &&
    nullSessionDecisions.data &&
    nullSessionDecisions.data.count > 0
  ) {
    items.push({
      type: 'null_session_decisions',
      description: `${nullSessionDecisions.data.count} decision(s) with null author_session_id require dashboard event processor update`,
      count: nullSessionDecisions.data.count,
    });
  }

  // 4. Pending next-steps from this sprint (carry to next sprint)
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='next_steps'`
  );
  if (tableCheck.success && tableCheck.data) {
    const pendingSteps = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM next_steps WHERE sprint_id = ? AND status = 'pending'`,
      [sprintId]
    );
    if (pendingSteps.success && pendingSteps.data && pendingSteps.data.count > 0) {
      items.push({
        type: 'pending_next_steps',
        description: `${pendingSteps.data.count} pending next-step(s) from ${sprintId} need resolution (complete/carry/drop)`,
        count: pendingSteps.data.count,
      });
    }
  }

  return items;
}

// ─── Message Sending ──────────────────────────────────────────────────────────

/**
 * Build a backlog_request summary for a carry-forward item.
 */
function buildSummary(item: CarryForwardItem): string {
  switch (item.type) {
    case 'blocked_mission':
      return `Carry-forward: blocked mission ${item.missionId}`;
    case 'null_sprint_sessions':
      return `Sync gap: ${item.count} sessions with null sprint_id`;
    case 'null_session_decisions':
      return `Sync gap: ${item.count} decisions with null author_session_id`;
    case 'pending_next_steps':
      return `Carry-forward: ${item.count} pending next-step(s)`;
  }
}

/**
 * Build the message body for a carry-forward item.
 */
function buildBody(item: CarryForwardItem, sprintId: string): string {
  const lines: string[] = [];
  lines.push(`Source sprint: ${sprintId}`);
  lines.push(`Type: ${item.type}`);
  lines.push(`Description: ${item.description}`);

  if (item.type === 'null_sprint_sessions') {
    lines.push('');
    lines.push(
      'Action needed: Update dashboard event processor to backfill sprint_id for sessions.'
    );
  } else if (item.type === 'null_session_decisions') {
    lines.push('');
    lines.push(
      'Action needed: Update dashboard event processor to backfill author_session_id for decisions.'
    );
  } else if (item.type === 'blocked_mission') {
    lines.push('');
    lines.push('Action needed: Unblock or reschedule this mission in the next sprint.');
  } else if (item.type === 'pending_next_steps') {
    lines.push('');
    lines.push('Action needed: Review pending next-steps and complete, carry, or drop them.');
  }

  return lines.join('\n');
}

/**
 * Send backlog_request messages for carry-forward items.
 */
async function sendCarryForwardMessages(
  items: CarryForwardItem[],
  targetAddress: string,
  sprintId: string,
  senderProjectId: string | undefined,
  projectRoot: string | undefined
): Promise<CarryForwardSendResult[]> {
  // s87-m05 — `fromEnvForProject(projectRoot)`. This function ALREADY RECEIVES `projectRoot` (the
  // parameter two lines up) and threw it away, resolving a user-scoped client instead. Third of
  // the three identical `fromEnv()` sites this mission fixes, under the same standing rule
  // (#580); leaving it would have been the "fixed two of three identical sites" this sprint is
  // named against.
  const clientResult = await DashboardClient.fromEnvForProject(projectRoot);
  if (!clientResult.success || !clientResult.data) {
    // All items fail with the same error
    return items.map((item) => ({
      item,
      sent: false,
      error: clientResult.error?.message ?? 'Dashboard not configured',
    }));
  }

  const client = clientResult.data.client;

  // Sprint 53: resolve senderProjectId from the local project identity, NEVER
  // `projects[0]`. See sender-identity.ts for the full rationale.
  let resolvedSenderProjectId = senderProjectId;
  let senderAddress: string | undefined;
  if (!resolvedSenderProjectId) {
    const resolved = await getLocalSenderProjectId(client, projectRoot);
    resolvedSenderProjectId = resolved.senderProjectId;
    senderAddress = resolved.identity.rbookAddress ?? undefined;
    try {
      assertSenderIdentityValid(resolved.identity, resolvedSenderProjectId);
    } catch (error) {
      if (!(error instanceof SenderAttributionIncompleteError)) throw error;
      return items.map((item) => ({
        item,
        sent: false,
        error: `${error.message} Register this store before sending carry-forwards.`,
      }));
    }
  }

  const results: CarryForwardSendResult[] = [];

  for (const item of items) {
    const sendResult = await client.sendMessage({
      targetAddress,
      type: 'backlog_request',
      summary: buildSummary(item),
      body: buildBody(item, sprintId),
      senderProjectId: resolvedSenderProjectId,
      senderAddress,
    });

    if (sendResult.success && sendResult.data) {
      results.push({
        item,
        sent: true,
        // s87-m05 — the same absent key as rbook-message.ts:996. This site read `.id` too, so a
        // carry-forward receipt recorded `undefined` for every message it actually sent.
        messageId: sendResult.data.messageId,
      });
    } else {
      results.push({
        item,
        sent: false,
        error: sendResult.error?.message ?? 'Unknown send error',
      });
    }
  }

  return results;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function rbookSprintCarryForward(
  params: RbookSprintCarryForwardParams
): Promise<RbookToolResult<SprintCarryForwardResult>> {
  if (!params.sprintId) {
    return createError(RbookErrors.missingParameter('sprintId'));
  }
  if (!params.targetAddress) {
    return createError(RbookErrors.missingParameter('targetAddress'));
  }

  // Accept saved legacy addresses and keep every public/send-client field on the current scheme.
  const targetAddress = normalizeAddressScheme(params.targetAddress);
  const addressRegex = /^rbook:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/;
  if (!addressRegex.test(targetAddress)) {
    return createError(
      RbookErrors.invalidParameter('targetAddress', params.targetAddress, [
        'rbook://username/project-name',
      ])
    );
  }

  // Detect carry-forwards from the database
  return withClientAsync(
    async (client) => {
      // Verify sprint exists
      const sprintRow = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        params.sprintId,
      ]);
      if (!sprintRow.success || !sprintRow.data) {
        return createError<SprintCarryForwardResult>({
          code: 'SPRINT_NOT_FOUND',
          message: `Sprint '${params.sprintId}' not found`,
          suggestion: 'Use rbook_sprint(action="list") to find valid sprint IDs',
        });
      }

      const items = detectCarryForwards(client, params.sprintId);

      // Dry run mode — just return detected items without sending
      const shouldSend = params.send !== false;

      let sendResults: CarryForwardSendResult[];
      if (shouldSend && items.length > 0) {
        sendResults = await sendCarryForwardMessages(
          items,
          targetAddress,
          params.sprintId,
          undefined,
          params.projectRoot
        );
      } else {
        sendResults = items.map((item) => ({
          item,
          sent: false,
          error: shouldSend ? undefined : 'Dry run — send=false',
        }));
      }

      const totalSent = sendResults.filter((r) => r.sent).length;
      const totalFailed = sendResults.filter((r) => !r.sent && params.send !== false).length;

      return createSuccess<SprintCarryForwardResult>({
        sprintId: params.sprintId,
        targetAddress,
        items,
        sendResults,
        totalDetected: items.length,
        totalSent,
        totalFailed,
      });
    },
    // carry_forward mutates the dashboard, but its local Reasonbook access is an identity/read probe.
    // Do not mint a new local project_id before sender resolution has interpreted the existing
    // dashboard_project_id + rbook_address linkage.
    { projectRoot: params.projectRoot, registerProject: false }
  );
}

// ─── LLM Formatter ────────────────────────────────────────────────────────────

export function formatSprintCarryForwardForLLM(
  result: RbookToolResult<SprintCarryForwardResult>
): string {
  if (!result.success || !result.data) {
    return [
      'Failed to process carry-forwards',
      '',
      `Error: ${result.error?.message ?? 'Unknown error'}`,
      result.error?.suggestion ? `Suggestion: ${result.error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = result.data;
  const lines: string[] = [];

  lines.push(`**Carry-Forward Routing** — ${d.sprintId} → ${d.targetAddress}`);
  lines.push('');

  if (d.items.length === 0) {
    lines.push('No carry-forward items detected.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  lines.push(`Detected ${d.totalDetected} item(s):`);
  for (const item of d.items) {
    const icon =
      item.type === 'blocked_mission'
        ? 'B'
        : item.type === 'null_sprint_sessions'
          ? 'S'
          : item.type === 'pending_next_steps'
            ? 'N'
            : 'D';
    lines.push(`  [${icon}] ${item.description}`);
  }

  lines.push('');
  lines.push(`Sent: ${d.totalSent} | Failed: ${d.totalFailed}`);

  if (d.sendResults.some((r) => r.sent)) {
    lines.push('');
    lines.push('**Messages sent:**');
    for (const r of d.sendResults.filter((r) => r.sent)) {
      lines.push(`  ${r.item.type}: ${r.messageId}`);
    }
  }

  if (d.sendResults.some((r) => !r.sent && r.error)) {
    lines.push('');
    lines.push('**Errors:**');
    for (const r of d.sendResults.filter((r) => !r.sent && r.error)) {
      lines.push(`  ${r.item.type}: ${r.error}`);
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

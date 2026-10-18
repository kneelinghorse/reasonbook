// ABOUTME: rbook_message tool — cross-project messaging via cmos-dashboard REST API.
// ABOUTME: Supports backlog_request, question, status_update, info_push, intel_request, intel_alert.

/**
 * rbook_message Tool
 *
 * Consolidated messaging tool with action parameter support.
 * Actions: send, list (byte-capped summaries), get (full body by id), respond, ack, directory, whoami.
 * Calls the cmos-dashboard REST API via DashboardClient.
 *
 * @module tools/rbook/rbook-message
 */

import { normalizeAddressScheme } from '../../intelligence/legacy-compat';
import { getSetting } from '../../intelligence/legacy-compat';
import { z } from 'zod';
import path from 'path';
import { ADDRESS_REMEDY, isProjectAddress } from '../../intelligence/project-address';
import { createError, createSuccess, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  foreignDescriptor,
  frameForeignInline,
  UNTRUSTED_CONTENT_CONTRACT,
  type ProvenanceDescriptor,
} from '../../intelligence/provenance-frame';
import { computeAuthState, type AuthState } from '../../auth/auth-state';
import {
  DashboardClient,
  type DashboardMessage,
  type DirectoryProject,
  type ResolveAddressResult,
} from './dashboard-client';
import type { KeySource } from '../../intelligence/credential-store';
import { RBOOK_PROJECT_ROOT_ENV } from './client';
import {
  assertSenderIdentityValid,
  readLocalSenderIdentity,
  resolveLocalSenderProjectId,
  SenderAttributionIncompleteError,
} from './sender-identity';
import {
  resolveSenderContext,
  SenderResolutionError,
  SERVER_INSTALL_ROOT,
  validateProject,
  type ResolutionCandidate,
  type SenderContext,
  type SenderResolutionSource,
} from '../../intelligence/sender-context';
import { appendWarnings } from './format-warnings';
import {
  ProjectGraphRegistry,
  reconfirmDefaultCall,
  unappliedDefaultNotice,
} from '../../intelligence/project-graph-registry';
import { getServerProjectRoot } from '../../intelligence/resolution-policy';

// ─── Constants ───────────────────────────────────────────────────────────────

export const RBOOK_MESSAGE_ACTIONS = [
  'send',
  'list',
  'get',
  'respond',
  'ack',
  'directory',
  'whoami',
] as const;
export type RbookMessageAction = (typeof RBOOK_MESSAGE_ACTIONS)[number];

/**
 * s86-m04 — which published parameter applies to which action (see action-params.ts).
 *
 * `projectRoot` is on every action because `rbookMessage` consumes it once, before the switch, to
 * resolve the dashboard client for all of them (rbook-message.ts:1175) — and `whoami` reads it
 * directly on the early-return path above that. Like rbook_auth, this router is pass-through, so
 * these lists are the keys each handler actually reads, not the keys it receives.
 */
export const RBOOK_MESSAGE_ACTION_PARAMS: ActionParamMap<RbookMessageAction, RbookMessageParams> = {
  send: [
    'action',
    'targetAddress',
    'type',
    'summary',
    'body',
    'senderProjectId',
    'evidence',
    'projectRoot',
  ],
  list: ['action', 'tab', 'status', 'limit', 'offset', 'projectRoot'],
  get: ['action', 'messageId', 'projectRoot'],
  respond: ['action', 'messageId', 'respondStatus', 'notes', 'projectRoot'],
  ack: ['action', 'messageId', 'projectRoot'],
  directory: ['action', 'projectRoot'],
  whoami: ['action', 'projectRoot'],
};

export const VALID_MESSAGE_TYPES = [
  'backlog_request',
  'question',
  'status_update',
  'info_push',
  'intel_request',
  'intel_alert',
] as const;
export type MessageType = (typeof VALID_MESSAGE_TYPES)[number];

export const VALID_MESSAGE_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'replied',
  'acknowledged',
] as const;
export type MessageStatus = (typeof VALID_MESSAGE_STATUSES)[number];

export const VALID_RESPOND_STATUSES = ['accepted', 'declined', 'replied'] as const;
export type RespondStatus = (typeof VALID_RESPOND_STATUSES)[number];

export const VALID_MESSAGE_TABS = ['inbox', 'sent'] as const;
export type MessageTab = (typeof VALID_MESSAGE_TABS)[number];

/**
 * Message type to ActivityPub verb/object mapping.
 */
export const MESSAGE_TYPE_MAP: Record<MessageType, { verb: string; object: string }> = {
  backlog_request: { verb: 'create', object: 'mission' },
  question: { verb: 'ask', object: 'note' },
  status_update: { verb: 'update', object: 'mission' },
  info_push: { verb: 'add', object: 'reference' },
  intel_request: { verb: 'request', object: 'intelligence' },
  intel_alert: { verb: 'notify', object: 'intelligence' },
};

/** Regex for validating rbook:// addresses. */
const RBOOK_ADDRESS_REGEX = /^rbook:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/;

/** Regex for validating UUID format. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Result Types ────────────────────────────────────────────────────────────

export interface MessageSendResult {
  /**
   * s87-m05 — OPTIONAL. The send SUCCEEDS and the receipt is what was wrong: this field read
   * the wrong key — one the dashboard has never returned on the send route — so the rendered
   * answer said "Message sent successfully" and then "ID: undefined". The send was real; the
   * receipt was the lie.
   *
   * Omitted rather than emitted empty when absent, and the envelope carries a warning naming the
   * absence and pointing at `rbook_message(action="list", tab="sent")`. NOT a hard failure — the
   * message landed, and refusing would be a worse answer than the one being fixed. NOT silence
   * either: silence about a missing receipt is the same defect one notch quieter.
   */
  messageId?: string;
  targetAddress: string;
  status: string;
  summary: string;
  verb: string;
  object: string;
  /** Canonical rbook:// address of the sender, included when project_identity has a non-unknown address. */
  senderAddress?: string;
  /** Dashboard-reported delivery/routing status (e.g. "queued", "delivered"). Absent when the dashboard has not yet exposed an ACK surface. */
  deliveryStatus?: string;
  /** s86-m07: who the address ACTUALLY resolved to, from the pre-send resolve the handler was
   *  already making and throwing away. Conditional-include, so a resolve body without these
   *  keys reproduces the pre-m07 bytes exactly. `targetProjectName` is the display name — the
   *  discriminator that distinguishes 'cmos-mcp' from 'CMOS-MCP Pro'. */
  targetProjectId?: string;
  targetProjectName?: string;
}

/** s78-m05: a DashboardMessage plus an additive {source, trust:'foreign'} descriptor.
 *  All original fields (incl. `body`) are preserved for wire-contract compatibility;
 *  the descriptor signals to consumers that summary/body are untrusted foreign content.
 *  s80-m05: this is the BODY-ON-GET shape (rbook_message get) — the list shape is the
 *  byte-capped {@link MessageSummary} instead. */
export type FramedMessage = DashboardMessage & { provenance?: ProvenanceDescriptor };

/**
 * s80-m05 — the byte-capped list-row shape. The former `rbook_message(list)` spread the
 * WHOLE dashboard row (`{...msg}` incl. `payload.body` ~69% / `responseNotes` ~21% /
 * `evidence`), producing a ~410KB / 250-message overflow (#15/#346). This shape KEEPS
 * the light identity + attribution fields and DROPS the heavy body/notes/evidence —
 * those come via `rbook_message(get, messageId)`. Attribution uses the fields the
 * dashboard actually populates (probe 2026-07-09): `senderProject`/`senderDisplayName`
 * on inbox, `targetProject`/`targetMissionId` on sent.
 */
export interface MessageSummary {
  id: string;
  type: string;
  verb?: string;
  objectType?: string;
  status: string;
  summary: string;
  createdAt: string;
  respondedAt?: string | null;
  /** Inbox attribution. `senderProject` is the RAW slug post-cutover (addressable key, non-lossy);
   *  `senderProjectName` is the display NAME twin. Both kept — slug addresses, name labels. */
  senderProject?: string | null;
  senderProjectName?: string | null;
  senderDisplayName?: string | null;
  /** Sent attribution. `targetProject` is the RAW slug post-cutover; `targetProjectName` the NAME twin. */
  targetProject?: string | null;
  targetProjectName?: string | null;
  targetMissionId?: string | null;
  // s84-m01: additive identity UUIDs, conditionally included when the row carries them
  // (lean pre-cutover rows omit them — no null-wall). Distinct from the slug/name fields above.
  senderUserId?: string | null;
  senderProjectId?: string | null;
  targetUserId?: string | null;
  targetProjectId?: string | null;
  /** Additive foreign-content descriptor; `source` is the labeled sender (not "unknown"). */
  provenance?: ProvenanceDescriptor;
}

export interface MessageListResult {
  messages: MessageSummary[];
  /**
   * s86-m07 — RENAMED from `unreadCount`, because that name asserted a scope this number does
   * not have. The dashboard's `unreadCount` is USER-WIDE across every project the caller owns,
   * while `totalCount` and `messages` are scoped to this call's credential, tab and filters.
   * Printed side by side under one name they produced a header that read "0 total, 7 unread"
   * against an empty pending inbox — a badge that names no project and can never clear, which
   * is how two Stage1 defect reports sat unread through a whole sprint.
   */
  unreadCountUserWide: number;
  /**
   * s86-m07 — the count this view can actually vouch for: returned rows with status 'pending'.
   * On the inbox tab that is "unread by me"; on the sent tab it is "not yet responded to by the
   * recipient". Client-computed from the rows in `messages`, so it never exceeds what was read.
   */
  unreadInThisView: number;
  totalCount: number;
  tab: string;
  statusFilter: string | null;
  /** s84-m02: SQL-side pagination (dashboard m05). `offset` echoes the requested page
   *  start (absent when not paginating); `returnedCount` is the page size the dashboard
   *  reported (absent on a pre-cutover dashboard that does not echo it). */
  offset?: number;
  returnedCount?: number;
  /** s80-m05: non-fatal advisories (e.g. sent-tab is user-scoped across all projects). */
  warnings?: string[];
}

/** s80-m05 — the body-on-get result: the full framed message (body + notes + evidence). */
export interface MessageGetResult {
  message: FramedMessage;
}

export interface MessageRespondResult {
  messageId: string;
  previousStatus: string;
  currentStatus: string;
  respondedAt: string;
}

/** Sprint 72 m04 — mirrors the dashboard /ack response verbatim (pending→acknowledged). */
export interface MessageAckResult {
  messageId: string;
  previousStatus: string;
  status: string;
  ackedAt: string;
}

/** s78-m05: a DirectoryProject plus an additive provenance descriptor. Row content comes from
 *  other users' project registrations and is untrusted foreign content.
 *  s86-m07: plus `ambiguousWith` — computed here, never sent by the dashboard. */
export type FramedDirectoryProject = DirectoryProject & {
  provenance?: ProvenanceDescriptor;
  /**
   * s86-m07 — addresses under the SAME owner whose slug is a strict prefix of, or strictly
   * prefixed by, this row's slug. NON-WIRE: computed client-side from the directory payload.
   * Present only when non-empty.
   */
  ambiguousWith?: string[];
};

export interface MessageDirectoryResult {
  projects: FramedDirectoryProject[];
  totalCount: number;
}

export interface MessageWhoamiResult {
  resolved: {
    requestedAddress?: string;
    projectRoot: string | null;
    source: SenderResolutionSource | null;
    dashboardProjectId: string | null;
    rbookAddress: string | null;
    healed?: { previous: string; next: string };
  };
  candidates: ResolutionCandidate[];
  serverInstall: {
    root: string;
    /**
     * Whether the server's install root is the project this call resolved to. s92-m01 retired the
     * cwd-vs-install-root guard: a cwd equal to the install root resolves by cwd when it holds a
     * store (this repository resolves to itself), so this is now a fact about the resolution, not
     * a fallback risk.
     */
    wouldHaveBeenUsed: boolean;
    envRbookProjectRoot: string | null;
  };
  /** s92-m01 — the `--project-root` this server was started with, if any. */
  serverProjectRoot?: string | null;
  /**
   * s92-m01 — the registry default, if one is set. `applied` is false for a default written
   * before 3.2.0 and never re-confirmed with setAsDefault; resolution never uses it.
   */
  registryDefault?: {
    projectId: string;
    name: string;
    storePath: string;
    applied: boolean;
  } | null;
  wouldAttributeAs: {
    senderProjectId: string | null;
    senderAddress: string | null;
  };
  /**
   * Sprint 57 m04 — diagnostic auth state from the local credential store
   * + the most recent dashboard deliveryAck. Always present so agents can
   * self-diagnose without calling rbook_auth(action=list).
   */
  authState?: AuthState;
}

export type RbookMessageResult =
  | MessageSendResult
  | MessageListResult
  | MessageGetResult
  | MessageRespondResult
  | MessageAckResult
  | MessageDirectoryResult
  | MessageWhoamiResult;

// ─── Zod Schema ──────────────────────────────────────────────────────────────

export const rbookMessageSchema = z
  .object({
    action: z
      .enum(RBOOK_MESSAGE_ACTIONS)
      .describe('Message action: send | list | get | respond | ack | directory | whoami'),
    // send params
    targetAddress: z
      .string()
      .optional()
      .describe('rbook:// address of the recipient (required for send)'),
    type: z
      .enum(VALID_MESSAGE_TYPES)
      .optional()
      .describe(
        'Message type: backlog_request | question | status_update | info_push | intel_request | intel_alert (required for send)'
      ),
    summary: z
      .string()
      .optional()
      .describe('Short description displayed in inbox list (required for send)'),
    body: z.string().optional().describe('Full message content'),
    senderProjectId: z
      .string()
      .optional()
      .describe(
        "Sender's project UUID. Resolved from local metadata.dashboard_project_id when omitted; falls back to matching local rbook_address against /api/projects/me. Agents should leave this unset — it is authoritatively resolved from the cwd's project identity."
      ),
    evidence: z
      .array(z.object({ type: z.string(), id: z.string() }))
      .optional()
      .describe('TraceLab evidence references [{type, id}]'),
    // list params
    tab: z.enum(VALID_MESSAGE_TABS).optional().describe('inbox (default) or sent'),
    status: z
      .enum(VALID_MESSAGE_STATUSES)
      .optional()
      .describe('Filter by message status for list action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max messages to return (default 20)'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pagination offset for list. Omit for page 0.'),
    // respond params
    messageId: z
      .string()
      .optional()
      .describe('UUID of the message to fetch (get), respond to (respond), or acknowledge (ack)'),
    respondStatus: z
      .enum(VALID_RESPOND_STATUSES)
      .optional()
      .describe('Response status: accepted | declined | replied (required for respond)'),
    notes: z.string().optional().describe('Response notes'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookMessageParams = z.infer<typeof rbookMessageSchema>;

interface InternalRbookMessageParams extends RbookMessageParams {
  /**
   * @internal MCP-boundary seam: the roots the CLIENT advertised, read by src/index.ts from the
   * transport (`getClientProjectRoots()`) and passed inward to resolve the sender. An agent cannot
   * supply it — it describes the caller, not the request — so it is deliberately absent from the
   * rbook_message inputSchema. Same seam, same reason, as rbook_agent_onboard's `advertisedRoots`.
   */
  advertisedRoots?: readonly string[];
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const rbookMessageToolDefinition = {
  name: 'rbook_message',
  description:
    'Agent messaging tool for cross-project communication via cmos-dashboard. ' +
    'Actions: send (send message to another project), list (byte-capped inbox/sent summaries), ' +
    'get (full body + notes + evidence for one message by id), ' +
    'respond (accept/decline/reply to a message), ack (mark a pending message read/acknowledged), ' +
    'directory (discover addressable projects), whoami (diagnose sender attribution). ' +
    'Send auto-detects senderProjectId, normalizes addresses (spaces→hyphens, lowercase), ' +
    'and validates target against the project directory before sending. ' +
    'Needs a dashboard sign-in: run rbook_auth(action="login_init"), then login_complete. ' +
    UNTRUSTED_CONTENT_CONTRACT,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_MESSAGE_ACTIONS],
        description: 'Message action: send | list | get | respond | ack | directory | whoami',
      },
      targetAddress: {
        type: 'string',
        description:
          'rbook:// address of the recipient. Format: rbook://username/project-name[/mission-id]',
      },
      type: {
        type: 'string',
        enum: [...VALID_MESSAGE_TYPES],
        description:
          'Message type: backlog_request | question | status_update | info_push | intel_request | intel_alert',
      },
      summary: {
        type: 'string',
        description: 'Short description displayed in inbox list',
      },
      body: { type: 'string', description: 'Full message content' },
      senderProjectId: {
        type: 'string',
        description:
          "Sender's project UUID. Resolved from local metadata.dashboard_project_id when omitted; falls back to matching local rbook_address against /api/projects/me. Agents typically do not need to pass this.",
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Evidence type' },
            id: { type: 'string', description: 'Evidence identifier' },
          },
          required: ['type', 'id'],
        },
        description: 'TraceLab evidence references [{type, id}]',
      },
      tab: {
        type: 'string',
        enum: [...VALID_MESSAGE_TABS],
        description: 'inbox (default) or sent',
      },
      status: {
        type: 'string',
        enum: [...VALID_MESSAGE_STATUSES],
        description: 'Filter by message status for list action',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Max messages to return (default 20)',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Pagination offset for list. Omit for page 0.',
      },
      messageId: {
        type: 'string',
        description: 'UUID of the message to respond to (respond) or acknowledge (ack)',
      },
      respondStatus: {
        type: 'string',
        enum: [...VALID_RESPOND_STATUSES],
        description: 'Response status: accepted | declined | replied',
      },
      notes: { type: 'string', description: 'Response notes' },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

// ─── Action Type Guard ───────────────────────────────────────────────────────

function isMessageAction(value: string): value is RbookMessageAction {
  return (RBOOK_MESSAGE_ACTIONS as readonly string[]).includes(value);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a rbook:// address: lowercase, replace spaces with hyphens,
 * collapse multiple hyphens, trim whitespace from segments.
 * Handles input like "rbook://Derek/Reasonbook Dashboard" → "rbook://derek/cmos-dashboard".
 */
function normalizeAddress(address: string): string {
  address = normalizeAddressScheme(address);
  if (!address.startsWith('rbook://')) return address;
  const body = address.slice('rbook://'.length);
  const normalized = body.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  return `rbook://${normalized}`;
}

function normalizeOptionalEnvPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function formatCandidateLine(candidate: ResolutionCandidate): string {
  const status = candidate.accepted ? '✓' : '✗';
  const location = candidate.projectRoot ? ` ${candidate.projectRoot}` : '';
  const rejectReason =
    !candidate.accepted && candidate.rejectReason ? ` — ${candidate.rejectReason}` : '';
  return `  ${status} ${candidate.source}${location}${rejectReason}`;
}

function resolvedFromContext(context: SenderContext | undefined): MessageWhoamiResult['resolved'] {
  if (!context) {
    return {
      projectRoot: null,
      source: null,
      dashboardProjectId: null,
      rbookAddress: null,
    };
  }

  return {
    projectRoot: context.projectRoot,
    ...(context.requestedAddress ? { requestedAddress: context.requestedAddress } : {}),
    source: context.source,
    dashboardProjectId: context.dashboardProjectId,
    rbookAddress: context.rbookAddress,
    ...(context.healed ? { healed: context.healed } : {}),
  };
}

/**
 * s87-m05 (#1015) — THE PARAMETER IS RENAMED BECAUSE THE OLD NAME LIED, and the rename is half
 * the fix rather than cosmetics.
 *
 * This took `relaxedContext`, and the caller passed the variable of that name — which is assigned
 * ONLY inside `if (!strictContext)`. So on the SUCCESS path it was always `undefined`, while
 * `resolvedContext` a few lines up held the very resolution these guards ask about. Two
 * consequences, in opposite directions:
 *
 *   FALSE POSITIVE — the "No MCP roots were advertised and no local Reasonbook database was resolved"
 *   warning fired alongside a fully resolved payload. Pre-proven nine times over in this repo's
 *   own signed-off artifact: rbook/docs/attribution-rebuild-verification.md carries it beside a
 *   resolved root, dashboard project id and address on nine rows.
 *
 *   TRUE NEGATIVE — the "Healed stale rbook_address" notice reads `.healed` off the same
 *   undefined, so it has been SILENTLY DROPPED on every strict-success path since sprint-53.
 *   `resolveSenderContext`'s accept() sets `healed` on any accepted candidate regardless of
 *   `requireSenderIdentity`, and validateProject heals by default — so a store whose
 *   `rbook://unknown/*` address is healed and then accepted by STRICT resolution should have
 *   reported it, and never did.
 *
 * Passing `resolvedContext` fixes both. Renaming the parameter is what stops the `.healed` read
 * below referring to a name that no longer describes what it holds — the half-fix #1015
 * explicitly warns against.
 *
 * TWO QUALIFICATIONS, carried from #1015 so this is not overclaimed: it is a SPRINT-53 defect
 * (1f45f7e, 2026-04-16, never edited) present byte-for-byte in the v1.0.1 dist, so it does NOT
 * distinguish binaries and is not evidence of drift; and it fires ONLY when the client advertises
 * no roots, because src/index.ts early-returns for whoami passing `mcpRoots: advertisedRoots`.
 * The related "forward mcpRoots at :1390" hardening is a production NO-OP and is DROPPED — #546
 * records the CLI/MCP roots split as intentional. Do not revive it.
 */
function buildWhoamiWarnings(
  strictError: SenderResolutionError | undefined,
  resolvedContext: SenderContext | undefined,
  envRbookProjectRoot: string | null,
  mcpRoots?: readonly string[]
): string[] {
  const warnings: string[] = [];

  if (envRbookProjectRoot) {
    warnings.push(
      `${RBOOK_PROJECT_ROOT_ENV} is set to ${envRbookProjectRoot}. It does not select a project for tool calls; the server reads it only to find its own .env.`
    );
  }

  if ((!mcpRoots || mcpRoots.length === 0) && !resolvedContext?.projectRoot) {
    warnings.push(
      'No MCP roots were advertised and no local Reasonbook database was resolved; diagnosis is limited to cwd/registry inspection.'
    );
  }

  if (resolvedContext?.healed?.preview) {
    warnings.push(
      `Stale rbook_address ${resolvedContext.healed.previous || '(empty)'}: the next write repairs it ` +
        `to ${resolvedContext.healed.next} before it resolves, so a send would resolve as shown. ` +
        'whoami reports it without writing.'
    );
  } else if (resolvedContext?.healed) {
    warnings.push(
      `Healed stale rbook_address from ${resolvedContext.healed.previous} to ${resolvedContext.healed.next}.`
    );
  }

  if (strictError) {
    warnings.push(
      'Next outbound send would fail-closed until sender identity resolves authoritatively.'
    );
  }

  return warnings;
}

export interface MessageWhoamiOptions {
  explicitProjectRoot?: string;
  mcpRoots?: readonly string[];
  cwdOverride?: string;
  serverInstallRootOverride?: string;
}

export async function getWhoamiDiagnostics(
  options: MessageWhoamiOptions = {}
): Promise<RbookToolResult<MessageWhoamiResult>> {
  const serverInstallRoot = path.resolve(options.serverInstallRootOverride ?? SERVER_INSTALL_ROOT);
  const envRbookProjectRoot = normalizeOptionalEnvPath(getSetting(RBOOK_PROJECT_ROOT_ENV));

  let strictContext: SenderContext | undefined;
  let strictError: SenderResolutionError | undefined;
  try {
    // s93-m11: whoami is a diagnostic, from a call or from `cmos-mcp --whoami`, so it never repairs
    // the address. It resolves with the address the next write would store (heal: 'preview'), so
    // its verdict on a send matches what the send, which repairs it first, will do.
    strictContext = await resolveSenderContext({
      explicitProjectRoot: options.explicitProjectRoot,
      mcpRoots: options.mcpRoots,
      requireSenderIdentity: true,
      cwdOverride: options.cwdOverride,
      serverInstallRootOverride: options.serverInstallRootOverride,
      heal: 'preview',
    });
  } catch (err) {
    if (err instanceof SenderResolutionError) {
      strictError = err;
    } else {
      throw err;
    }
  }

  let relaxedContext: SenderContext | undefined;
  let relaxedError: SenderResolutionError | undefined;
  if (!strictContext) {
    try {
      relaxedContext = await resolveSenderContext({
        explicitProjectRoot: options.explicitProjectRoot,
        mcpRoots: options.mcpRoots,
        requireSenderIdentity: false,
        cwdOverride: options.cwdOverride,
        serverInstallRootOverride: options.serverInstallRootOverride,
        heal: 'preview',
      });
    } catch (err) {
      if (err instanceof SenderResolutionError) {
        relaxedError = err;
      } else {
        throw err;
      }
    }
  }

  const resolvedContext = strictContext ?? relaxedContext;
  const candidates =
    strictContext?.candidates ??
    strictError?.candidates ??
    relaxedContext?.candidates ??
    relaxedError?.candidates ??
    [];

  // Sprint 57 m04: attach the local credential store + last deliveryAck snapshot
  // so agents see auth state without a separate rbook_auth(action=list) call.
  // Best-effort — never fail whoami because credential-store I/O hiccupped.
  let authState: AuthState | undefined;
  try {
    const authProjectRoot =
      resolvedContext?.projectRoot ??
      (options.explicitProjectRoot && !isProjectAddress(options.explicitProjectRoot)
        ? options.explicitProjectRoot
        : undefined);
    authState = await computeAuthState(authProjectRoot ? { projectRoot: authProjectRoot } : {});
  } catch {
    authState = undefined;
  }

  const serverInstall = {
    root: serverInstallRoot,
    wouldHaveBeenUsed:
      resolvedContext !== undefined &&
      path.resolve(resolvedContext.projectRoot) === serverInstallRoot,
    envRbookProjectRoot,
  };

  // s92-m01: show the registry default and whether resolution may use it. Best-effort — a
  // registry hiccup never fails whoami.
  let registryDefault: MessageWhoamiResult['registryDefault'] = null;
  let defaultNotice: string | null = null;
  try {
    const status = (await ProjectGraphRegistry.create()).getDefaultStatus();
    if (status.entry) {
      registryDefault = {
        projectId: status.entry.project_id,
        name: status.entry.name,
        storePath: status.entry.store_path,
        applied: status.applied,
      };
    }
    const notice = unappliedDefaultNotice(status);
    defaultNotice =
      notice && status.entry ? `${notice}: ${reconfirmDefaultCall(status.entry)}` : null;
  } catch {
    registryDefault = null;
  }

  const data: MessageWhoamiResult = {
    resolved: resolvedFromContext(resolvedContext),
    candidates: [...candidates],
    serverInstall,
    serverProjectRoot: getServerProjectRoot() ?? null,
    registryDefault,
    wouldAttributeAs: {
      senderProjectId: strictContext?.dashboardProjectId ?? null,
      senderAddress: strictContext?.rbookAddress ?? null,
    },
    ...(authState ? { authState } : {}),
  };

  const warnings = buildWhoamiWarnings(
    strictError,
    // s87-m05 (#1015) — THE ONE ARGUMENT. This passed `relaxedContext`, which is assigned only
    // inside `if (!strictContext)` above, so on every successful resolution it was `undefined`
    // while `resolvedContext` held the answer.
    resolvedContext,
    envRbookProjectRoot,
    options.mcpRoots
  );
  if (authState?.warning) {
    warnings.push(authState.warning);
  }
  if (defaultNotice) {
    warnings.push(defaultNotice);
  }

  if (strictContext) {
    return createSuccess<MessageWhoamiResult>(data, warnings);
  }

  return {
    success: false,
    data,
    error:
      strictError?.code === 'PROJECT_ADDRESS_UNRESOLVABLE'
        ? { code: strictError.code, message: strictError.message, suggestion: ADDRESS_REMEDY }
        : RbookErrors.senderUnresolvable(
            strictError?.message ??
              'Could not authoritatively resolve sender context for the next outbound send.',
            strictError?.code
          ),
    warnings,
  };
}

// ─── s86-m07: the address-ambiguity rule ─────────────────────────────────────

/**
 * The slug a directory row is addressed by. Prefers the dashboard's own `slug`; falls back to
 * the address path so a lean row (pre-cutover, slug absent) still participates in the rule
 * rather than being silently excluded from it.
 */
function slugOfProject(project: DirectoryProject): string {
  if (project.slug) return project.slug;
  const parts = project.address.replace('rbook://', '').split('/');
  return parts[1] ?? '';
}

/**
 * s86-m07 — the ambiguity relation, stated as a RULE over the payload rather than a list of
 * known-colliding names: two slugs are prefix siblings when one is a STRICT prefix of the other.
 *
 * STRICT ON BOTH SIDES IS LOAD-BEARING. Equal slugs under one owner are a duplicate
 * registration, not an ambiguity — the operator has one name that resolves one way, and
 * flagging it would report a different defect under this one's wording.
 *
 * WHY PREFIX, AND NOT DORMANCY (fork f15, closed at plan time — do not re-open). The sender did
 * not pick the dead address for lack of an activity timestamp; they picked it because two
 * addresses were indistinguishable and the dead one looked MORE correct (npm package
 * @aquex/cmos-mcp, repo kneelinghorse/cmos-mcp, tool prefix rbook_*). Dormancy is also
 * unbuildable at the time: /api/projects/{id}/identity reported status "active_development" for
 * the dormant project, `createdAt` is the REGISTRATION date (it would flag every healthy
 * long-lived project), and a sent-history approximation is sender-scoped and silent on first
 * contact. This predicate needs nothing from the dashboard and fires on exactly the case that
 * bit us.
 *
 * s87-m05 — ONE CLAUSE HERE EXPIRED, AND THE RULING DID NOT. The clause "no dashboard endpoint
 * carries last-activity" is no longer true: `lastActivityAt` now exists. THE FORK STAYS CLOSED
 * ANYWAY, on the ground that never depended on buildability — #1011 item 8: the sender did not
 * pick a dead address for want of an activity timestamp, they picked it because two addresses
 * were INDISTINGUISHABLE and the dead one looked more correct. A dormancy signal would not have
 * changed that.
 *
 * The expired clause is REPLACED rather than deleted, deliberately. Removing a refutation without
 * putting the surviving reason in its place is how a settled fork gets re-opened two sprints
 * later by someone who reads only that the stated objection is gone.
 */
function isPrefixSibling(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Addresses under `owner` whose slug is a prefix sibling of `slug`, deduplicated. */
function prefixSiblingAddresses(
  projects: readonly DirectoryProject[],
  owner: string,
  slug: string
): string[] {
  const out = new Set<string>();
  for (const candidate of projects) {
    if (candidate.owner !== owner) continue;
    if (isPrefixSibling(slugOfProject(candidate), slug)) out.add(candidate.address);
  }
  return [...out];
}

/** `{owner, slug}` of a validated rbook:// address. */
function addressParts(address: string): { owner: string; slug: string } {
  const parts = address.replace('rbook://', '').split('/');
  return { owner: parts[0] ?? '', slug: parts[1] ?? '' };
}

/**
 * s86-m07 — the directory rows the SEND path reads for its ambiguity advisory, memoized per
 * dashboard ORIGIN.
 *
 * WHY MEMOIZED RATHER THAN FETCHED PER SEND. The relation is defined over OTHER projects'
 * slugs, so no local pre-filter can decide "this send cannot collide" without the directory —
 * a per-send fetch would add a third round-trip to every send (resolve + directory + post).
 * Keyed by ORIGIN and not by client instance because `rbookMessage` builds a fresh
 * DashboardClient per call, so an instance key would never hit; the route is `/public`, so two
 * credentials against one origin see the same rows. The TTL is deliberately short: a stale
 * sibling claim is a lie of the same family this mission exists to remove.
 */
const DIRECTORY_CACHE_TTL_MS = 60_000;
const directoryCache = new Map<string, { fetchedAt: number; projects: DirectoryProject[] }>();

/** Test hook: drop the memo so one case cannot inherit another's directory. */
export function __resetDirectoryCacheForTesting(): void {
  directoryCache.clear();
}

async function loadDirectoryForAmbiguity(client: DashboardClient): Promise<DirectoryProject[]> {
  const origin = client.dashboardOrigin;
  const hit = directoryCache.get(origin);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < DIRECTORY_CACHE_TTL_MS) return hit.projects;

  // A lookup failure is NOT a send failure: by the time this runs the message is DELIVERED, so
  // a throw here would report a sent message as a failed tool call and invite a double-send.
  // Say nothing about ambiguity rather than inventing a claim or losing an accepted send. The
  // catch covers a transport throw and any caller whose client does not answer in the envelope
  // shape — deliberately broad, because nothing about an advisory is worth a lost receipt.
  let projects: DirectoryProject[];
  try {
    const result = await client.listDirectory();
    if (!result?.success || !result.data) return [];
    projects = result.data.projects;
  } catch {
    return [];
  }

  directoryCache.set(origin, { fetchedAt: now, projects });
  return projects;
}

/** `'CMOS-MCP Pro' (rbook://derek/cmos-mcp-pro)` — name when the directory knows one, address always. */
function labelForAddress(projects: readonly DirectoryProject[], address: string): string {
  const match = projects.find(
    (p) => normalizeAddressScheme(p.address) === normalizeAddressScheme(address)
  );
  return match?.name ? `'${match.name}' (${address})` : address;
}

/**
 * s86-m07 — the NON-BLOCKING send advisory. Returns the warnings to ride the envelope; never
 * an error, and no caller may turn a non-empty return into a failed send. The message is
 * already delivered when this runs.
 */
async function buildTargetAmbiguityWarnings(
  client: DashboardClient,
  targetAddress: string,
  resolved: ResolveAddressResult['resolved'] | undefined
): Promise<string[]> {
  const warnings: string[] = [];
  const typed = addressParts(targetAddress);
  const resolvedSlug = resolved?.projectSlug;
  const resolvedName = resolved?.projectName;
  const resolvedId = resolved?.projectId;
  const idSuffix = resolvedId ? ` (${resolvedId})` : '';

  // (a) The dashboard resolved the address to a project the caller did not name. Free — this
  //     needs nothing beyond the resolve response handleSend was already discarding.
  if (resolvedSlug && typed.slug && resolvedSlug !== typed.slug) {
    warnings.push(
      `target address names '${typed.slug}' but resolves to project '${resolvedName ?? resolvedSlug}'${idSuffix} — confirm this is the intended recipient.`
    );
  }

  // (b) The resolved target shares a slug prefix with another project under the same owner.
  const slug = resolvedSlug ?? typed.slug;
  if (!slug || !typed.owner) return warnings;

  const projects = await loadDirectoryForAmbiguity(client);
  const siblings = prefixSiblingAddresses(projects, typed.owner, slug);
  if (siblings.length > 0) {
    const rendered = siblings.map((address) => labelForAddress(projects, address)).join(', ');
    warnings.push(
      `target resolves to project '${resolvedName ?? slug}'${idSuffix}, which shares a slug prefix with ${rendered} — confirm this is the intended recipient.`
    );
  }

  return warnings;
}

/**
 * Fetch the project directory and return addresses that are close matches
 * to the given target. Uses simple substring matching on address components.
 */
async function getSuggestedAddresses(
  client: DashboardClient,
  targetAddress: string
): Promise<string[]> {
  const dirResult = await client.listDirectory();
  if (!dirResult.success || !dirResult.data?.projects) {
    return [];
  }

  // Extract the project slug from the target (e.g. "cmos-dashboard" from "rbook://derek/cmos-dashboard")
  const parts = targetAddress.replace('rbook://', '').split('/');
  const targetSlug = parts[1] ?? '';
  const targetOwner = parts[0] ?? '';

  return dirResult.data.projects
    .filter((p) => {
      const addr = p.address;
      const addrParts = addr.replace('rbook://', '').split('/');
      const slug = addrParts[1] ?? '';
      const owner = addrParts[0] ?? '';
      // Match on same owner, or slug contains/is-contained-by target slug
      return owner === targetOwner || slug.includes(targetSlug) || targetSlug.includes(slug);
    })
    .slice(0, 5)
    .map((p) => p.address);
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

async function handleSend(
  params: InternalRbookMessageParams,
  client: DashboardClient
): Promise<RbookToolResult<MessageSendResult>> {
  // Validate required params
  if (!params.targetAddress) {
    return createError(RbookErrors.missingParameter('targetAddress'));
  }
  if (!params.type) {
    return createError(RbookErrors.missingParameter('type'));
  }
  if (!params.summary) {
    return createError(RbookErrors.missingParameter('summary'));
  }

  // Normalize address: lowercase, spaces → hyphens
  const targetAddress = normalizeAddress(params.targetAddress);

  // Validate rbook:// address format (after normalization)
  if (!RBOOK_ADDRESS_REGEX.test(normalizeAddressScheme(targetAddress))) {
    return createError(
      RbookErrors.invalidParameter('targetAddress', params.targetAddress, [
        'rbook://username/project-name',
        'rbook://username/project-name/mission-id',
      ])
    );
  }

  // Pre-send address resolution — validate target exists
  const resolveResult = await client.resolveAddress({ address: targetAddress });
  if (!resolveResult.success) {
    // On 404, try to suggest close matches from directory
    if (resolveResult.error?.code === 'DASHBOARD_NOT_FOUND') {
      const suggestions = await getSuggestedAddresses(client, targetAddress);
      const hint =
        suggestions.length > 0
          ? `Did you mean: ${suggestions.join(', ')}?`
          : 'Use rbook_message action="directory" to see all addressable projects.';
      return createError(
        RbookErrors.dashboardNotFound(
          targetAddress,
          `Address '${targetAddress}' not found in project directory`,
          hint
        )
      );
    }
    // For other errors (auth, network), pass through
    return createError<MessageSendResult>(resolveResult.error!);
  }

  // Sprint 53 m02: the dispatcher already ran `resolveSenderContext` with
  // `requireSenderIdentity=true` and passed the resolved projectRoot through in
  // `params.projectRoot`, so `readLocalSenderIdentity` opens the right DB. The
  // `assertSenderIdentityValid` call below is defense-in-depth — if any future
  // caller bypasses the dispatcher boundary and invokes `handleSend` directly
  // with an unresolvable project, we fail-closed here with
  // `SENDER_ATTRIBUTION_INCOMPLETE` rather than silently publishing a null sender.
  // (The dispatcher's `SENDER_UNRESOLVABLE` and this layer's
  // `SENDER_ATTRIBUTION_INCOMPLETE` are distinct so operators can tell which
  // gate rejected the send.)
  const localIdentity = await readLocalSenderIdentity(params.projectRoot);
  const senderProjectId =
    params.senderProjectId ?? (await resolveLocalSenderProjectId(client, localIdentity));
  const senderAddress = localIdentity.rbookAddress ?? undefined;

  try {
    assertSenderIdentityValid(localIdentity, senderProjectId);
  } catch (err) {
    if (err instanceof SenderAttributionIncompleteError) {
      return createError<MessageSendResult>({
        code: err.code,
        message: err.message,
        suggestion:
          'The dispatcher should have caught this via resolveSenderContext — report the call site so ' +
          'it can be routed through the audited boundary. Verify Reasonbook DB has a UUID ' +
          'metadata.dashboard_project_id and a canonical project_identity.rbook_address.',
      });
    }
    throw err;
  }

  if (senderAddress && params.advertisedRoots && params.advertisedRoots.length > 0) {
    let matchedAdvertisedRoot = false;
    for (const root of params.advertisedRoots) {
      const validation = await validateProject(root, { heal: false });
      if (validation.rbookAddress === senderAddress) {
        matchedAdvertisedRoot = true;
        break;
      }
    }

    if (!matchedAdvertisedRoot) {
      return createError<MessageSendResult>({
        code: 'SENDER_ATTRIBUTION_MISMATCH',
        message: `Resolved sender address '${senderAddress}' does not match any advertised MCP root.`,
        suggestion:
          'Verify the MCP client is advertising the intended workspace roots and that the local sender identity belongs to one of them before retrying the send.',
      });
    }
  }

  // Map type to verb/object
  const mapping = MESSAGE_TYPE_MAP[params.type];

  const result = await client.sendMessage({
    targetAddress,
    type: params.type,
    summary: params.summary,
    body: params.body,
    evidence: params.evidence,
    senderProjectId,
    senderAddress,
  });

  if (!result.success) {
    return createError<MessageSendResult>(result.error!);
  }

  const response = result.data!;
  // s87-m05 — TOLERANT READ, and the fallback is deliberate rather than leftover.
  //
  // `messageId` is what the route returns, proven three ways: the dashboard route source, its own
  // e2e assertions, and `git log -S` placing the key in the FIRST commit of the messaging API.
  // The `??` arm costs one token and covers the one residue nobody has closed — UA-8, whether the
  // DEPLOYED dashboard matches this checkout byte-for-byte, which was never verified.
  //
  // NOTE FOR A FUTURE SWEEP: fork f1 REQUIRES this fallback, while m05's criterion 1 asks for a
  // grep of `response.id` across src/ to return zero. Those cannot both hold. f1 governs while
  // UA-8 is open; the criterion's INTENT — that no site treats `.id` as the answer — is satisfied,
  // because `messageId` is read first and `.id` is only ever a fallback. Cut the fallback when a
  // live 201 from the deployed instance confirms the key, not before.
  const messageId = response.messageId ?? response.id;
  const out: MessageSendResult = {
    targetAddress,
    status: response.status ?? 'pending',
    summary: params.summary,
    verb: mapping.verb,
    object: mapping.object,
  };
  // Echo the address we sent — useful for callers that want to verify attribution
  // without opening the DB themselves. Only included when we actually sent one.
  if (messageId) out.messageId = messageId;
  if (senderAddress) out.senderAddress = senderAddress;
  // Forward dashboard-reported routing/delivery status when present. Absence here
  // is expected today and does not imply failure; see DashboardMessage.deliveryStatus.
  if (response.deliveryStatus) out.deliveryStatus = response.deliveryStatus;

  // s86-m07: report WHO the address resolved to. `resolveAddress` was already being called
  // above purely as a boolean gate and its body thrown away, while it carries the one field
  // that tells 'cmos-mcp' from 'CMOS-MCP Pro'. Conditional-include so a resolve body without
  // these keys reproduces the pre-m07 bytes.
  const resolved = resolveResult.data?.resolved;
  if (resolved?.projectId) out.targetProjectId = resolved.projectId;
  if (resolved?.projectName) out.targetProjectName = resolved.projectName;

  // s86-m07: the collision advisory rides the ENVELOPE (createSuccess's second argument) and
  // is rendered by formatSendForLLM via appendWarnings. It NEVER blocks: the send above has
  // already succeeded and no branch below can turn it into success:false.
  const warnings = await buildTargetAmbiguityWarnings(client, targetAddress, resolved);

  // s87-m05 — SAY SO WHEN THE RECEIPT IS MISSING. The send succeeded; only the id is absent.
  // Neither of the two easy answers is right: hard-failing would turn a delivered message into an
  // error, and staying silent is the same defect one notch quieter than printing `ID: undefined`.
  // The warning names the absence and points at the surface that can still find the message.
  if (!out.messageId) {
    warnings.push(
      'Message sent, but the dashboard returned no message id, so this receipt carries none. ' +
        'The send itself succeeded — confirm it with rbook_message(action="list", tab="sent").'
    );
  }
  return createSuccess<MessageSendResult>(out, warnings);
}

/** A foreign source is a validated address or address part, never an arbitrary display name. */
export function attributionSource(msg: DashboardMessage, tab: string): string | undefined {
  const addresses = tab === 'sent' ? [msg.to] : [msg.senderAddress, msg.from];
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue;
    const address = normalizeAddressScheme(raw);
    if (RBOOK_ADDRESS_REGEX.test(address)) return address;
  }
  const parts =
    tab === 'sent'
      ? [msg.targetProject, msg.targetProjectId, msg.to_project_id]
      : [msg.senderProject, msg.senderProjectId, msg.from_project_id];
  return parts.find(
    (part): part is string => typeof part === 'string' && /^[a-zA-Z0-9_-]+$/.test(part)
  );
}

/**
 * s80-m05 — map a raw dashboard row to the byte-capped {@link MessageSummary}. KEEPS the
 * light identity + attribution fields; DROPS the heavy `payload.body` / `responseNotes` /
 * `evidence` (those come via `rbook_message(get, messageId)`). Provenance `source` is the
 * labeled sender/recipient, not a misleading "unknown source".
 */
export function mapToMessageSummary(msg: DashboardMessage, tab: string): MessageSummary {
  const summary: MessageSummary = {
    id: msg.id,
    type: msg.type,
    verb: msg.verb,
    objectType: msg.objectType,
    status: msg.status,
    summary: msg.summary,
    createdAt: msg.createdAt,
    respondedAt: msg.respondedAt ?? null,
    provenance: foreignDescriptor(attributionSource(msg, tab)),
    // s84-m01: pass through the 4 additive identity UUIDs when the row carries them.
    // Conditional-include (not `?? null`) so a lean pre-cutover row stays byte-identical
    // to 2.3.0 — no null-wall of absent keys. All 4 ride every post-cutover row (both tabs).
    ...(msg.senderUserId != null ? { senderUserId: msg.senderUserId } : {}),
    ...(msg.senderProjectId != null ? { senderProjectId: msg.senderProjectId } : {}),
    ...(msg.targetUserId != null ? { targetUserId: msg.targetUserId } : {}),
    ...(msg.targetProjectId != null ? { targetProjectId: msg.targetProjectId } : {}),
  };
  if (tab === 'sent') {
    summary.targetProject = msg.targetProject ?? null; // RAW slug post-cutover (addressable key)
    summary.targetMissionId = msg.targetMissionId ?? null;
    // s84-m01: display NAME twin, conditional so a pre-cutover row (no *Name) stays byte-identical.
    if (msg.targetProjectName != null) summary.targetProjectName = msg.targetProjectName;
  } else {
    summary.senderProject = msg.senderProject ?? null; // RAW slug post-cutover
    summary.senderDisplayName = msg.senderDisplayName ?? null;
    if (msg.senderProjectName != null) summary.senderProjectName = msg.senderProjectName;
  }
  return summary;
}

async function handleList(
  params: RbookMessageParams,
  client: DashboardClient,
  keySource: KeySource
): Promise<RbookToolResult<MessageListResult>> {
  const tab = params.tab ?? 'inbox';
  const limit = params.limit ?? 20;

  const result = await client.listMessages({
    tab,
    status: params.status,
    limit,
    // s84-m02: only forward offset when the caller paginated, so omitting it reproduces
    // 2.3.0's exact call args (the client always sends an explicit limit; leave its
    // documented default at 20 — do NOT silently retune to the dashboard's 50).
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  });

  if (!result.success) {
    return createError<MessageListResult>(result.error!);
  }

  // s80-m05: byte-capped summaries — full body/notes/evidence come via `get`. The
  // summary + provenance are inbound foreign content (untrusted DATA, not instructions).
  const messages = result.data!.messages.map((msg) => mapToMessageSummary(msg, tab));

  // s86-m07: the count this answer can vouch for — the rows it actually returned.
  const unreadInThisView = messages.filter((msg) => msg.status === 'pending').length;
  const unreadCountUserWide = result.data!.unreadCount;

  // s80-m05: the sent tab is user-scoped across every project the operator owns; the
  // dashboard does not yet scope it by project key. Surface that as a non-fatal warning
  // rather than silently over-returning (row-count project-pin is best-effort).
  const warnings: string[] = [];
  if (tab === 'sent') {
    warnings.push(
      'sent is user-scoped across all your projects; per-project attribution is pending dashboard support.'
    );
  }
  // s86-m07: the two numbers above answer different questions, and the old shared name said
  // otherwise. Discriminate BY RULE over the 5-member KeySource union rather than testing
  // `=== 'user-scoped'`: 'legacy-env', 'password-fallback' and 'none' are user-wide too, so an
  // equality test would under-warn on three of the four non-project arms.
  if (keySource !== 'project-scoped') {
    warnings.push(
      `this ${tab} view was read with a ${keySource} credential, so it is not scoped to one project: ` +
        `unreadCountUserWide (${unreadCountUserWide}) counts unread across every project you own, while ` +
        `unreadInThisView (${unreadInThisView}) counts only the rows this call returned.`
    );
  }

  return createSuccess<MessageListResult>({
    messages,
    unreadCountUserWide,
    unreadInThisView,
    totalCount: result.data!.totalCount,
    tab,
    statusFilter: params.status ?? null,
    // s84-m02: echo the requested offset + the dashboard-reported page size when present.
    // Both conditional so a non-paginated pre-cutover call reproduces 2.3.0's result shape.
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(result.data!.returnedCount !== undefined
      ? { returnedCount: result.data!.returnedCount }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * s84-m02 — error codes where the read-one attempt surfaces DIRECTLY instead of falling
 * back to the paging scan. These are auth/authz/config walls that paging would only
 * re-hit (masking them as a misleading MESSAGE_NOT_FOUND); a 403 in particular is the
 * recipient-authorization signal, not token expiry. Everything else — a route-absent 404,
 * transport/5xx failure, or a non-message 2xx body — falls through to paging.
 */
const GET_SURFACE_DIRECTLY_CODES = new Set<string>([
  'DASHBOARD_AUTH_FAILED',
  'DASHBOARD_FORBIDDEN',
  'DASHBOARD_UPGRADE_REQUIRED',
  'DASHBOARD_NOT_CONFIGURED',
]);

/**
 * s84-m02 (critic Rev3 hardening) — is `data` the clean single message row we asked for?
 * Guards the read-one fast path against framing a `{data:null}` / empty / HTML-SPA-shell
 * body: requires a non-null object whose `id` exactly matches the requested id. Anything
 * else falls through to the paging scan rather than framing `undefined`/garbage.
 */
function isCleanSingleMessage(data: unknown, expectedId: string): data is DashboardMessage {
  return typeof data === 'object' && data !== null && (data as { id?: unknown }).id === expectedId;
}

async function handleGet(
  params: RbookMessageParams,
  client: DashboardClient
): Promise<RbookToolResult<MessageGetResult>> {
  if (!params.messageId) {
    return createError<MessageGetResult>(RbookErrors.missingParameter('messageId'));
  }
  if (!UUID_REGEX.test(params.messageId)) {
    return createError<MessageGetResult>(
      RbookErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  // Read-one supplies the full body, but deployed dashboards omit identity ids there.
  // Recover those only from the same id in the paginated list; never infer them from names.
  const one = await client.getMessageById(params.messageId);
  if (!one.success && GET_SURFACE_DIRECTLY_CODES.has(one.error?.code ?? '')) {
    return createError<MessageGetResult>(one.error!);
  }
  let found =
    one.success && isCleanSingleMessage(one.data, params.messageId) ? { ...one.data } : undefined;
  const identities = [
    'senderUserId',
    'senderProjectId',
    'targetUserId',
    'targetProjectId',
  ] as const;
  let sourceTab = 'inbox';
  const FETCH_LIMIT = 100;
  let lastError: NonNullable<RbookToolResult<MessageGetResult>['error']> | undefined;
  if (!found || identities.some((key) => found![key] === undefined)) {
    tabs: for (const tab of ['inbox', 'sent'] as const) {
      let offset = 0;
      const seen = new Set<string>();
      for (;;) {
        const result = await client.listMessages({
          tab,
          limit: FETCH_LIMIT,
          ...(offset ? { offset } : {}),
        });
        if (!result.success) {
          lastError = result.error!;
          break;
        }
        const { messages, totalCount } = result.data!;
        const listed = messages.find((m) => m.id === params.messageId);
        if (listed) {
          if (found) {
            for (const key of identities)
              if (
                found[key] === undefined &&
                (typeof listed[key] === 'string' || listed[key] === null)
              )
                found[key] = listed[key];
          } else {
            found = listed;
            sourceTab = tab;
          }
          break tabs;
        }
        // A legacy endpoint may ignore offset. Stop on empty or repeated pages as well as the end.
        if (!messages.length || messages.every((message) => seen.has(message.id))) break;
        for (const message of messages) seen.add(message.id);
        offset += messages.length;
        if (!Number.isFinite(totalCount) || offset >= totalCount) break;
      }
    }
  }
  if (found) {
    const source = attributionSource(found, sourceTab) ?? attributionSource(found, 'sent');
    const missing = identities.filter((key) => found![key] === undefined);
    const warnings = missing.length
      ? [
          `The dashboard did not supply message identity fields: ${missing.join(', ')}. The exact message is returned; identity could not be recovered from its list entry.`,
        ]
      : undefined;
    return createSuccess<MessageGetResult>(
      { message: { ...found, provenance: foreignDescriptor(source) } },
      warnings
    );
  }

  // Not found on any tab that we could read. If a tab fetch actually FAILED, surface
  // that transport error (the search was incomplete) rather than a misleading not-found.
  if (lastError) {
    return createError<MessageGetResult>(lastError);
  }
  return createError<MessageGetResult>({
    code: 'MESSAGE_NOT_FOUND',
    message: `Message ${params.messageId} was not found in the available inbox or sent pages.`,
    suggestion:
      'Check the message id and dashboard access. A dashboard that does not support offset pagination may only expose its newest page.',
  });
}

async function handleRespond(
  params: RbookMessageParams,
  client: DashboardClient
): Promise<RbookToolResult<MessageRespondResult>> {
  // Validate required params
  if (!params.messageId) {
    return createError(RbookErrors.missingParameter('messageId'));
  }
  if (!params.respondStatus) {
    return createError(RbookErrors.missingParameter('respondStatus'));
  }

  // Validate UUID format
  if (!UUID_REGEX.test(params.messageId)) {
    return createError(
      RbookErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  const result = await client.respondToMessage({
    messageId: params.messageId,
    status: params.respondStatus,
    notes: params.notes,
  });

  if (!result.success) {
    return createError<MessageRespondResult>(result.error!);
  }

  return createSuccess<MessageRespondResult>({
    messageId: params.messageId,
    previousStatus: 'pending',
    currentStatus: params.respondStatus,
    respondedAt: result.data!.updatedAt ?? new Date().toISOString(),
  });
}

/**
 * Acknowledge (mark-read) a pending message (Sprint 72 m04). A status-only round-trip to
 * the dashboard's POST /api/messages/:id/ack (LIVE, migration 031) — modeled on
 * handleRespond. Returns the dashboard's data verbatim ({messageId, previousStatus,
 * status, ackedAt}); do NOT hardcode previousStatus. 404/403/409 surface as structured
 * RbookErrors via the client's request error mapping (parity with respond).
 */
async function handleAck(
  params: RbookMessageParams,
  client: DashboardClient
): Promise<RbookToolResult<MessageAckResult>> {
  if (!params.messageId) {
    return createError(RbookErrors.missingParameter('messageId'));
  }
  if (!UUID_REGEX.test(params.messageId)) {
    return createError(
      RbookErrors.invalidParameter('messageId', params.messageId, [
        'UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ])
    );
  }

  const result = await client.ackMessage({ messageId: params.messageId });
  if (!result.success) {
    return createError<MessageAckResult>(result.error!);
  }

  // Return the dashboard's data verbatim (previousStatus is authoritative, not hardcoded).
  return createSuccess<MessageAckResult>(result.data!);
}

async function handleDirectory(
  _params: RbookMessageParams,
  client: DashboardClient
): Promise<RbookToolResult<MessageDirectoryResult>> {
  const result = await client.listDirectory();

  if (!result.success) {
    return createError<MessageDirectoryResult>(result.error!);
  }

  const projects = result.data!.projects;
  const warnings: string[] = [];

  // s86-m07: before this join the ternary below framed every row — including the operator's own
  // project — as trust:'foreign', because the one signal that says "this address is yours" was
  // absent from the payload being read. This second call belongs to the discovery-only
  // `directory` action, where doubling latency is acceptable; it must NOT be added to the send
  // path.
  //
  // s87-m05 — THE ORIGINAL WORDING WAS REFUTED. It said the directory route "NEVER returns
  // isOwner" and that /api/projects/me "is the only route that carries it". Measured against the
  // deployed dashboard, the directory route does return it. The join is KEPT regardless: it is
  // correct today, and dropping it would be a latency optimisation rather than a truth fix. Only
  // the claim about what the route can never do is removed.
  const mine = await client.getMyProjects();
  let ownedIds: Set<string> | null = null;
  if (mine.success && mine.data) {
    ownedIds = new Set(mine.data.projects.map((p) => p.id).filter((id) => id.length > 0));
  } else {
    // Do not fail the directory call, and do not silently reclassify every row as foreign
    // without saying so — a swallowed failure here is the defect class this mission fixes.
    warnings.push(
      `ownership signal degraded: GET /api/projects/me failed (${mine.error?.message ?? 'unknown error'}), ` +
        `so isOwner is unset on every row below and none is claimed as yours. The directory rows themselves are unaffected.`
    );
  }

  // s78-m05: directory rows are authored by other users — tag each with a foreign-provenance
  // descriptor (own-project entries stay 'local').
  const framedProjects: FramedDirectoryProject[] = projects.map((p) => {
    const isOwner = ownedIds ? ownedIds.has(p.id) : p.isOwner;
    const ambiguousWith = prefixSiblingAddresses(projects, p.owner, slugOfProject(p));
    return {
      ...p,
      // Conditional-include: an unknown ownership stays ABSENT rather than becoming `false`,
      // which would assert "not yours" on a degraded signal.
      ...(isOwner !== undefined ? { isOwner } : {}),
      ...(ambiguousWith.length > 0 ? { ambiguousWith } : {}),
      provenance: isOwner
        ? { source: p.address, trust: 'local' as const }
        : foreignDescriptor(RBOOK_ADDRESS_REGEX.test(p.address) ? p.address : undefined),
    };
  });

  return createSuccess<MessageDirectoryResult>(
    {
      projects: framedProjects,
      totalCount: result.data!.totalCount,
    },
    warnings
  );
}

async function handleWhoami(
  params: RbookMessageParams
): Promise<RbookToolResult<MessageWhoamiResult>> {
  return getWhoamiDiagnostics({ explicitProjectRoot: params.projectRoot });
}

// ─── Main Dispatcher ─────────────────────────────────────────────────────────

/**
 * Consolidated rbook_message tool.
 * Creates a DashboardClient from env and dispatches to action handlers.
 */
export async function rbookMessage(
  params: InternalRbookMessageParams
): Promise<RbookToolResult<RbookMessageResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isMessageAction(actionValue)) {
    return createError<RbookMessageResult>(
      RbookErrors.invalidAction('rbook_message', actionValue, RBOOK_MESSAGE_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookMessageToolDefinition.inputSchema,
    RBOOK_MESSAGE_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookMessageResult>(wrongTypedParam);

  if (actionValue === 'whoami') {
    return handleWhoami(params);
  }

  // Create client via the credential-store-aware factory so device-code-minted
  // user-scoped keys (Sprint 57) reach the messaging surface. The legacy fromEnv()
  // factory only consults env-var auth and silently 401s when only a user-scoped
  // key in the credential store is available.
  const clientResult = await DashboardClient.fromEnvForProject(params.projectRoot);
  if (!clientResult.success) {
    return createError<RbookMessageResult>(clientResult.error!);
  }

  const client = clientResult.data!.client;
  // s86-m07: `keySource` was resolved here and discarded. `list` is the one action whose answer
  // asserts a SCOPE, so it is the one handler that receives it — the other five are unchanged.
  const keySource = clientResult.data!.keySource;

  switch (actionValue) {
    case 'send':
      return handleSend(params, client);
    case 'list':
      return handleList(params, client, keySource);
    case 'get':
      return handleGet(params, client);
    case 'respond':
      return handleRespond(params, client);
    case 'ack':
      return handleAck(params, client);
    case 'directory':
      return handleDirectory(params, client);
  }
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

function formatSendForLLM(result: RbookToolResult<MessageSendResult>): string {
  if (!result.success) {
    return `Failed to send message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [
    `Message sent successfully`,
    // s87-m05 — rendered ONLY when present. It used to print `ID: undefined` on every send.
    ...(d.messageId ? [`  ID: ${d.messageId}`] : []),
    `  To: ${d.targetAddress}`,
    `  Summary: ${d.summary}`,
    `  Type: ${d.verb}/${d.object}`,
    `  Status: ${d.status}`,
  ];
  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatListForLLM(result: RbookToolResult<MessageListResult>): string {
  if (!result.success) {
    return `Failed to list messages: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  // s86-m07: two numbers, two labels. The old single-name header could read "0 total, 7 unread"
  // — a sentence that contradicts itself in seven characters.
  const lines = [
    `Messages (${d.tab}) — ${d.totalCount} total, ${d.unreadInThisView} unread in this view, ` +
      `${d.unreadCountUserWide} unread user-wide (all your projects)`,
  ];

  if (d.statusFilter) {
    lines[0] += ` (filtered: ${d.statusFilter})`;
  }

  for (const w of d.warnings ?? []) {
    lines.push(`  ⚠ ${w}`);
  }

  if (d.messages.length === 0) {
    lines.push('  No messages');
  } else {
    for (const msg of d.messages) {
      // s78-m05: the summary is inbound foreign content — render it inside an untrusted
      // fence labeled with the sender, never as a bare instruction-looking line. s80-m05:
      // the label comes from the populated senderProject/targetProject (was "unknown sender").
      const src =
        msg.provenance?.source ??
        msg.senderProjectName ??
        msg.senderProject ??
        msg.senderDisplayName ??
        msg.targetProjectName ??
        msg.targetProject ??
        'unknown sender';
      lines.push(`  [${msg.status}] (${msg.id}) ${frameForeignInline(msg.summary, src)}`);
    }
  }
  lines.push('  (use rbook_message get, messageId=<id> for the full body)');

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatGetForLLM(result: RbookToolResult<MessageGetResult>): string {
  if (!result.success) {
    return `Failed to get message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }
  const m = result.data!.message;
  const src =
    m.provenance?.source ??
    m.senderProjectName ??
    m.senderProject ??
    m.senderDisplayName ??
    'unknown sender';
  const body = m.payload?.body ?? m.body ?? '(no body)';
  const lines = [
    `Message ${m.id} [${m.status}]`,
    `  Type: ${m.verb ?? m.type}/${m.objectType ?? ''}`,
    `  Summary: ${frameForeignInline(m.summary, src)}`,
    `  Body:`,
    frameForeignInline(body, src),
  ];
  if (m.responseNotes) lines.push(`  Response notes: ${frameForeignInline(m.responseNotes, src)}`);
  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatRespondForLLM(result: RbookToolResult<MessageRespondResult>): string {
  if (!result.success) {
    return `Failed to respond to message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [
    `Response recorded`,
    `  Message: ${d.messageId}`,
    `  Status: ${d.previousStatus} → ${d.currentStatus}`,
    `  Responded at: ${d.respondedAt}`,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatAckForLLM(result: RbookToolResult<MessageAckResult>): string {
  if (!result.success) {
    return `Failed to acknowledge message: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [
    `Message acknowledged`,
    `  Message: ${d.messageId}`,
    `  Status: ${d.previousStatus} → ${d.status}`,
    `  Acked at: ${d.ackedAt}`,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatDirectoryForLLM(result: RbookToolResult<MessageDirectoryResult>): string {
  if (!result.success) {
    return `Failed to list project directory: ${result.error?.message ?? 'Unknown error'}\n${result.error?.suggestion ?? ''}`;
  }

  const d = result.data!;
  const lines = [`Project Directory — ${d.totalCount} addressable project(s)`];

  if (d.projects.length === 0) {
    lines.push('  No projects found');
  } else {
    for (const p of d.projects) {
      // s86-m07: no description branch — GET /api/projects/directory/public returns no
      // description for any row, so the old renderer was dead code guarding a dead field.
      const source = RBOOK_ADDRESS_REGEX.test(p.address) ? p.address : undefined;
      const address = source ?? frameForeignInline(p.address, source);
      const label = p.ownerDisplayName
        ? ` — ${frameForeignInline(p.ownerDisplayName, source)}`
        : '';
      // createdAt is the REGISTRATION date. Labeled as such, never as activity or freshness.
      const registered = p.createdAt ? `, registered ${p.createdAt}` : '';
      const mine = p.isOwner ? ', yours' : '';
      lines.push(`  ${address} (${p.id})${label}${registered}${mine}`);
      if (p.ambiguousWith && p.ambiguousWith.length > 0) {
        lines.push(`      AMBIGUOUS with ${p.ambiguousWith.join(', ')}`);
      }
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatWhoamiForLLM(result: RbookToolResult<MessageWhoamiResult>): string {
  const d = result.data;
  const lines = ['Attribution diagnosis'];

  if (result.success) {
    const sender = d?.wouldAttributeAs.senderAddress ?? 'unknown sender';
    const senderId = d?.wouldAttributeAs.senderProjectId
      ? ` (${d.wouldAttributeAs.senderProjectId})`
      : '';
    lines.push(`  Next outbound send would attribute as: ${sender}${senderId}`);
  } else {
    lines.push('  Next outbound send would fail closed');
    if (result.error?.message) {
      lines.push(`  Error: ${result.error.message}`);
    }
  }

  lines.push(`  Resolved root: ${d?.resolved.projectRoot ?? 'none'}`);
  lines.push(`  Source: ${d?.resolved.source ?? 'none'}`);
  lines.push(`  Dashboard project ID: ${d?.resolved.dashboardProjectId ?? 'none'}`);
  lines.push(`  Reasonbook address: ${d?.resolved.rbookAddress ?? 'none'}`);
  if (d?.resolved.healed) {
    lines.push(`  Healed address: ${d.resolved.healed.previous} -> ${d.resolved.healed.next}`);
  }
  lines.push(`  Server install root: ${d?.serverInstall.root ?? SERVER_INSTALL_ROOT}`);
  lines.push(
    `  Install root is the resolved project: ${d?.serverInstall.wouldHaveBeenUsed ? 'yes' : 'no'}`
  );
  lines.push(`  ${RBOOK_PROJECT_ROOT_ENV}: ${d?.serverInstall.envRbookProjectRoot ?? 'unset'}`);
  lines.push(`  --project-root: ${d?.serverProjectRoot ?? 'not set'}`);
  if (d?.registryDefault) {
    lines.push(
      `  Registry default: ${d.registryDefault.name} (${d.registryDefault.applied ? 'applied to contextless calls' : 'not applied'})`
    );
  }

  appendWarnings(lines, result);

  lines.push('Candidate trace:');
  if (!d || d.candidates.length === 0) {
    lines.push('  No candidates recorded');
  } else {
    for (const candidate of d.candidates) {
      lines.push(formatCandidateLine(candidate));
    }
  }

  return lines.join('\n');
}

export function formatMessageForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookMessageResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['Failed to execute rbook_message', '', `Error: ${result.error.message}`];

    if (availableActions.length > 0) {
      lines.push('', `Available actions: ${availableActions.join(', ')}`);
    }

    if (result.error.suggestion) {
      lines.push('', `Suggestion: ${result.error.suggestion}`);
    }

    return lines.join('\n');
  }

  switch (action) {
    case 'send':
      return formatSendForLLM(result as RbookToolResult<MessageSendResult>);
    case 'list':
      return formatListForLLM(result as RbookToolResult<MessageListResult>);
    case 'get':
      return formatGetForLLM(result as RbookToolResult<MessageGetResult>);
    case 'respond':
      return formatRespondForLLM(result as RbookToolResult<MessageRespondResult>);
    case 'ack':
      return formatAckForLLM(result as RbookToolResult<MessageAckResult>);
    case 'directory':
      return formatDirectoryForLLM(result as RbookToolResult<MessageDirectoryResult>);
    case 'whoami':
      return formatWhoamiForLLM(result as RbookToolResult<MessageWhoamiResult>);
    default: {
      if (!result.success) return 'Failed to execute rbook_message';
      const lines = ['Message action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}

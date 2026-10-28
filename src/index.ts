#!/usr/bin/env node

// ABOUTME: Main MCP server entry point, including tool dispatch and startup diagnostics.
// ABOUTME: Runs an attribution self-test at boot so sender-resolution regressions surface immediately.

/**
 * Mission Protocol v2 MCP Server
 *
 * Main entry point for the MCP server that exposes domain discovery tools.
 * Uses stdio transport for Claude Desktop integration.
 *
 * @module index
 */

import { isDirectoryEdition, directoryCallError } from './edition';
import { getSetting, settingIsOff } from './intelligence/legacy-compat';
import * as fs from 'fs';
import * as path from 'path';
import { getServerVersion } from './server-version';
import { debugEnabled, debugLog } from './debug-log';
import {
  createServerShutdown,
  installStderrPipeGuard,
  type ShutdownBounds,
} from './server-shutdown';
import { isProjectAddress } from './intelligence/project-address';
import { currentCodexRequest, withCodexRequest } from './codex-request-context';

export { getServerVersion };

installStderrPipeGuard();

// Load .env if present (before any other imports that read process.env).
// Resolve project root from: env var → directory containing this script.
// Legacy/non-product empty values remain fillable for IDE spawns. A new RBOOK_
// setting's empty value is an explicit clear and must survive the .env loader.
const __projectRoot = getSetting('RBOOK_PROJECT_ROOT') ?? path.resolve(__dirname, '..');
const envPath = path.join(__projectRoot, '.env');
const directoryEdition = isDirectoryEdition();
try {
  if (!directoryEdition && fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    let loaded = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === 'RBOOK_EDITION') continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key.startsWith('RBOOK_') ? process.env[key] === undefined : !process.env[key]) {
        process.env[key] = value;
        loaded++;
      }
    }
    // s92-m07: diagnostics, behind RBOOK_DEBUG (checked after loading, so the .env can set it).
    if (debugEnabled())
      process.stderr.write(`[env-loader] loaded ${loaded} vars from ${envPath}\n`);
  } else if (!directoryEdition && debugEnabled()) {
    process.stderr.write(`[env-loader] .env not found at ${envPath}\n`);
  }
} catch (err) {
  process.stderr.write(
    `[env-loader] failed to load ${envPath}: ${err instanceof Error ? err.message : String(err)}\n`
  );
}
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import {
  Server,
  ProtocolError,
  CallToolResult,
  ProtocolErrorCode,
  type Tool,
} from '@modelcontextprotocol/server';
import { RbookDetector } from './intelligence/rbook-detector';
import {
  withServerRequest,
  clientProjectRootsForCall,
  clearClientProjectRoots,
  clientLabelForRequest,
} from './server-request-context';
import {
  ProjectGraphRegistry,
  reconfirmDefaultCall,
  unappliedDefaultNotice,
} from './intelligence/project-graph-registry';
import {
  resolveSenderContext,
  SenderResolutionError,
  SERVER_INSTALL_ROOT,
  type ResolvedBy,
  type SenderContext,
} from './intelligence/sender-context';
import {
  findEnclosingStore,
  getServerProjectRoot,
  parseProjectRootArg,
  PROJECT_ROOT_ARG,
  setServerProjectRoot,
} from './intelligence/resolution-policy';
import {
  assertReadOnlyAgentAllowed,
  isReadOnlyAgentSession,
  ReadOnlyAgentGuardError,
} from './tools/rbook/read-only-agent-guard';
import { classifyAction } from './tools/rbook/action-taxonomy';
import { toolEffectMetadata } from './tools/rbook/tool-effects';
import {
  captureToolCall,
  setToolProjectResolution,
  currentToolCallActionMode,
  currentWrittenStores,
  projectIdentityDisclosuresForError,
  recordStoreUpkeepNote,
  currentSharedStores,
  unwrapCapturedToolCallError,
} from './tools/rbook/tool-call-context';
import {
  noteTelemetryProject,
  noteTelemetryPresentedIds,
  withMcpTelemetry,
} from './tools/rbook/telemetry-call';
import { boundErrorFields, boundErrorValue } from './tools/rbook/error-bounds';
import { rbookReviewPresentation } from './tools/rbook/review-presentation';
import {
  runFirstWriteMaintenance,
  storeNeedsFirstWriteMaintenance,
} from './tools/rbook/first-write-maintenance';
import { sharedRecordNoticesAt } from './tools/rbook/record-notices';
import { observeSharedSync } from './tools/rbook/record-sync-scheduler';
import {
  markDashboardUploadOwed,
  observeDashboardUploadProject,
  stopDashboardUploadScheduler,
} from './tools/rbook/dashboard-upload-scheduler';
import {
  cleanupActiveUploadCopies,
  drainDashboardUploads,
  interruptDashboardUploads,
} from './tools/rbook/dashboard-upload';
import { RBOOK_CHECKPOINT_SYNC_ENV } from './tools/rbook/checkpoint-backfill';
import { RBOOK_TOOL_SCHEMAS } from './tools/rbook/tool-schemas';
import { validateRbookArguments } from './tools/rbook/tool-validation';
import {
  RBOOK_TOOL_DEFINITIONS,
  // Consolidated entity tools (Sprint 24)
  rbookMission,
  formatMissionForLLM,
  rbookMissionTransition,
  formatMissionTransitionForLLM,
  rbookSprint,
  formatSprintForLLM,
  rbookContext,
  formatContextForLLM,
  rbookSession,
  formatSessionForLLM,
  rbookDecisions,
  formatDecisionsForLLM,
  rbookLearnings,
  formatLearningsForLLM,
  rbookFeedback,
  formatFeedbackForLLM,
  rbookStatus,
  formatStatusForLLM,
  rbookAuth,
  formatAuthForLLM,
  rbookDb,
  formatDbForLLM,
  rbookProject,
  formatProjectForLLM,
  // Messaging tool (Sprint 28)
  rbookMessage,
  formatMessageForLLM,
  getWhoamiDiagnostics,
  // Agent utility tools
  rbookAgentOnboard,
  formatAgentOnboardForLLM,
  // Utility
  resolveProjectRoot,
  RBOOK_PROJECT_ROOT_ENV,
  RBOOK_ERROR_CODES,
  RbookErrors,
} from './tools/rbook';
import type {
  RbookToolError,
  RbookMissionParams,
  RbookMissionTransitionParams,
  RbookSprintParams,
  RbookContextParams,
  RbookSessionParams,
  RbookDecisionsParams,
  RbookLearningsParams,
  RbookFeedbackParams,
  RbookStatusParams,
  RbookAuthParams,
  RbookDbParams,
  RbookProjectParams,
  RbookAgentOnboardParams,
  RbookMessageParams,
  RbookReviewParams,
} from './tools/rbook';
import { findWrongTypedStringParam } from './tools/rbook/param-type-guard';
import { classifySenderResolutionError } from './tools/rbook/sender-refusal';
import { directoryWire } from './tools/rbook/directory-wire';
import { toWireDefinition } from './tools/rbook/wire-definition';
import { getServerInstructions } from './server-instructions';
import { registerRbookPromptHandlers } from './server-prompts';
import { closeOwnImplicitSessions } from './tools/rbook/implicit-session-lifecycle';
import { findUnknownTopLevelParam } from './tools/rbook/unknown-param-guard';
import { TokenCounter } from './intelligence/token-counters';
import { SupportedModel } from './intelligence/types';
import { RBOOK_SCHEMA_VERSION } from './tools/rbook/schema';
import { ErrorHandler } from './errors/handler';
import { ErrorLogger } from './errors/logger';
import type { JsonValue } from './errors/types';
import { initServerHealth, getServerHealth } from './server-health';
import {
  runStartupProjectKeyRecovery,
  runStartupCredentialCheck,
} from './auth/project-key-capture';

/**
 * MCP Server Configuration — one truthful identity (s77-m04). The server NAME is
 * the literal 'rbook' (not the retired 'mission-protocol', nor the scoped
 * '@aquex/reasonbook'); the version is sourced from package.json.
 */
const SERVER_CONFIG = {
  name: 'rbook',
  version: getServerVersion(),
} as const;

/**
 * Main server instance
 */
function createProtocolServer(): Server {
  return new Server(
    {
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        experimental: { 'codex/sandbox-state-meta': {} },
      },
      // s92-m08: the loop, for every client, without a rules file.
      instructions: getServerInstructions(),
      cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } },
    }
  );
}
let server = createProtocolServer();
let stdioHandle: StdioServerHandle | undefined;

const errorLogger = new ErrorLogger();
ErrorHandler.useLogger(errorLogger);

/**
 * Mission Protocol server context shared across handlers
 */
export interface MissionProtocolContext {
  defaultModel: SupportedModel;
  tokenCounter: TokenCounter;
  /** Whether Reasonbook is detected in the project */
  rbookDetected: boolean;
  /** Path to Reasonbook database if detected */
  rbookDatabasePath?: string;
  /** Client's project root from MCP roots (set after connection) */
  clientProjectRoot?: string;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
}

/**
 * Get tool definitions for the MCP surface.
 *
 * @returns Array of Reasonbook tool definitions
 */
/**
 * What tools/list sends: every published definition in its fixed, declared order, with the short
 * wire text (s92-m08). The full text stays on RBOOK_TOOL_DEFINITIONS and in TOOL_REFERENCE.md.
 */
export function getToolDefinitions(): ToolDefinition[] {
  const local = isDirectoryEdition();
  const definitions = (RBOOK_TOOL_DEFINITIONS as unknown as ToolDefinition[]).map((definition) => ({
    ...toWireDefinition(definition),
    ...toolEffectMetadata(definition.name),
  }));
  return local ? directoryWire(definitions) : definitions;
}

/**
 * Parameters whose malformed JSON type can throw before a Reasonbook handler gets a chance to return
 * its normal structured validation error. This boundary list is intentionally unconditional:
 * every published tool accepts `projectRoot` as a string, and resolution reads it before the
 * action router for most tools.
 */
export const PREFLIGHT_PARAMS = ['projectRoot'] as const;

interface PublishedSchemaProperty {
  readonly enum?: readonly unknown[];
}

interface PublishedToolSchema {
  readonly properties?: Readonly<Record<string, PublishedSchemaProperty | undefined>>;
}

/** Return a known, schema-derived refusal before sender resolution; unknown tools pass through. */
function preflightMissionProtocolTool(name: string, args: unknown): RbookToolError | null {
  const definition = (
    isDirectoryEdition()
      ? getToolDefinitions()
      : (RBOOK_TOOL_DEFINITIONS as readonly ToolDefinition[])
  ).find((candidate) => candidate.name === name);
  if (!definition) return null;

  const actionProperty = (definition.inputSchema as PublishedToolSchema).properties?.['action'];
  const availableActions = actionProperty?.enum;
  if (Array.isArray(availableActions)) {
    const providedAction =
      args && typeof args === 'object' ? (args as Record<string, unknown>)['action'] : undefined;
    if (!availableActions.includes(providedAction)) {
      return RbookErrors.invalidAction(name, providedAction, availableActions.map(String));
    }
  }

  const wrongTyped = findWrongTypedStringParam(definition.inputSchema, PREFLIGHT_PARAMS, args);
  if (wrongTyped) return wrongTyped;

  // s91-m02: precedence is action, then projectRoot type, then unknown top-level keys.
  return findUnknownTopLevelParam(name, definition.inputSchema, args);
}

export function summarizeValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => summarizeValue(item)) as JsonValue;
  }
  if (typeof value === 'object') {
    return '[object]';
  }
  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 197)}…`;
  }
  return value as JsonValue;
}

export function sanitizeArgs(args: unknown): Record<string, JsonValue> | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 10);
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, value] of entries) {
    sanitized[key] = summarizeValue(value);
  }
  return sanitized;
}

export async function buildMissionProtocolContext(options?: {
  defaultModel?: SupportedModel;
}): Promise<MissionProtocolContext> {
  const defaultModel = options?.defaultModel ?? 'claude';

  // Initialize token counter for intelligence tools
  const tokenCounter = new TokenCounter();

  // Detect Reasonbook in the project (respects RBOOK_PROJECT_ROOT env var)
  const projectRoot = resolveProjectRoot();
  const detector = RbookDetector.getInstance({ cacheTtlMs: 60_000 });
  const rbookResult = await detector.detect(projectRoot);
  const rbookDetected = rbookResult.hasRbookDirectory && rbookResult.hasDatabase;

  return {
    defaultModel,
    tokenCounter,
    rbookDetected,
    rbookDatabasePath: rbookResult.databasePath,
  };
}

let contextBuilder: typeof buildMissionProtocolContext = buildMissionProtocolContext;
let whoamiCliRunner: typeof runWhoamiCli = runWhoamiCli;
// s92-m07: the second startup line; replaceable so a test never resolves the real working directory.
let startupProjectDescriber: () => Promise<string> = describeStartupProject;
let startupAttributionSelfTestRunner: typeof runStartupAttributionSelfTest =
  runStartupAttributionSelfTest;

interface StartupAttributionSelfTestResult {
  projectRoot: string | null;
  source: SenderContext['source'] | null;
  errorCode: string | null;
  warning: string | null;
}

/**
 * Get ALL client project roots from MCP roots.
 *
 * Sprint 53 m02: changed from `Promise<string | undefined>` (first root only) to
 * `Promise<string[]>` so `resolveSenderContext` can walk every advertised root and
 * pick the one that owns a valid `dashboard_project_id`. The former first-only
 * behavior silently mis-attributed whenever the client advertised multiple roots
 * in a different order than the operator expected.
 *
 * @returns Array of file-system paths. Empty when the client advertises no roots
 *   or does not support the roots capability.
 */
async function getClientProjectRoots(explicitRoot?: string): Promise<string[]> {
  return clientProjectRootsForCall(server, explicitRoot, probeClientRoots);
}

/**
 * Ask the client for its roots, uncached. s93-m11 (#606 b): only a client that declared the roots
 * capability is asked. A client that never declared it may never answer roots/list, and the first
 * Reasonbook call then stalled until the request timed out (60 s).
 */
export async function probeClientRoots(
  target: Pick<Server, 'listRoots' | 'getClientCapabilities'>
): Promise<string[]> {
  if (!target.getClientCapabilities()?.roots) {
    debugLog('[DEBUG] Client did not declare the roots capability; roots/list not sent');
    return [];
  }

  const roots: string[] = [];
  try {
    const rootsResult = await target.listRoots();
    if (rootsResult.roots && rootsResult.roots.length > 0) {
      for (const root of rootsResult.roots) {
        if (root.uri.startsWith('file://')) {
          roots.push(decodeURIComponent(root.uri.slice(7)));
        }
      }
      if (roots.length > 0) {
        debugLog(`[INFO] Client project roots from MCP roots: ${roots.join(', ')}`);
      }
    }
  } catch (error) {
    // Client may not support roots - this is fine, fall back to other methods
    debugLog(
      `[DEBUG] Could not get client roots: ${error instanceof Error ? error.message : 'unknown'}`
    );
  }

  return roots;
}

/**
 * Resolve the sender context for a dispatched tool call.
 *
 * Sprint 53 m02: replaces the old `resolveRbookProjectRoot` (which silently fell
 * back to `RBOOK_PROJECT_ROOT` env) with the single audited boundary from
 * `src/intelligence/sender-context.ts`. Every dispatcher case now flows through
 * this function. `RBOOK_PROJECT_ROOT` is no longer consulted at tool dispatch
 * time — it is retained only for `.env` bootstrap at src/index.ts:17 so the
 * server can locate its own environment file.
 *
 * @param explicitRoot - `params.projectRoot` from the tool call, if any
 * @param options.requireSenderIdentity - Pass `true` for any call that will hit
 *   the dashboard with authoritative attribution (today: rbook_message send;
 *   Sprint 53 m04 adds checkpoint-backfill, registerProject, purge). Defaults to
 *   `false` for local-DB ops.
 * @throws SenderResolutionError when no candidate produces an acceptable project.
 */
async function resolveToolSenderContext(
  explicitRoot: string | undefined,
  options: { requireSenderIdentity?: boolean } = {}
): Promise<SenderContext> {
  const mcpRoots = await getClientProjectRoots(explicitRoot);
  const resolved = await resolveSenderContext({
    explicitProjectRoot: explicitRoot,
    mcpRoots,
    requireSenderIdentity: options.requireSenderIdentity ?? false,
  });
  setToolProjectResolution({ projectRoot: resolved.projectRoot, resolvedBy: resolved.source });
  noteTelemetryProject(resolved.projectRoot);
  await observeDashboardUploadProject(resolved.projectRoot);
  // s96-m13: a copy of a shared record with a route syncs on its own timer, under its own switch.
  observeSharedSync(resolved.projectRoot);
  return resolved;
}

/**
 * s93-m11 — run a dispatched call, then this process's first-write upkeep (the staleness repair, a
 * pending blob migration and an index rebuild; see first-write-maintenance.ts) for each store the
 * call really wrote: a write-classified call that answered without error and changed a row there
 * for its caller. A report that is only classified as a write (a decisions review), a lazy repair
 * made on the way (the address heal, the identity seed, the schema label: asLazyRepair), a refusal,
 * and every read never reach it. Onboard never does, even with feedback: it makes no status write
 * (m11 fork 4). Its lines ride the answer.
 */
async function executeWithStoreUpkeep(
  name: string,
  args: unknown,
  context: MissionProtocolContext
): Promise<CallToolResult> {
  const result = await executeMissionProtocolTool(name, args, context);
  // s96-m12: an answer from a copy of a shared record names its fields in conflict and any id two
  // copies created (ADR s96 §3, §5), so no one acts on a provisional value unknowingly. The review's
  // digest has its own shared-record section, and rbook_db conflicts lists the same, so neither
  // says it twice.
  if (
    name !== 'rbook_review' &&
    !(name === 'rbook_db' && (args as { action?: unknown } | null)?.action === 'conflicts')
  )
    for (const dbPath of currentSharedStores())
      for (const note of await sharedRecordNoticesAt(dbPath, args)) recordStoreUpkeepNote(note);
  if (
    result.isError !== true &&
    name !== 'rbook_agent_onboard' &&
    currentToolCallActionMode() === 'write' &&
    !isReadOnlyAgentSession()
  ) {
    for (const dbPath of currentWrittenStores()) {
      // A file the call wrote and no longer has, such as one a fresh copy was built in before it
      // was renamed or sent, is no project's store (s97-m14 live test).
      if (!fs.existsSync(dbPath)) continue;
      // <root>/rbook/db/rbook.sqlite → <root>
      const root = path.resolve(dbPath, '..', '..', '..');
      if (storeNeedsFirstWriteMaintenance(root)) {
        for (const note of await runFirstWriteMaintenance(root)) recordStoreUpkeepNote(note);
      }
      // Every caller write owes an upload, including later writes after upkeep has run.
      // The scheduler persists only the registry mark here; it never waits for the upload.
      if (!settingIsOff(RBOOK_CHECKPOINT_SYNC_ENV)) {
        await markDashboardUploadOwed(root);
      }
    }
  }
  return result;
}

/**
 * s92-m04 — whether the project was NAMED rather than inferred: an explicit projectRoot, the
 * client's roots, or the operator's --project-root. A named project is not ambiguous for want of
 * advertised roots, so onboard and the review opener stop prescribing whoami for it.
 */
function callerNamedProject(explicitRoot: unknown, source: ResolvedBy): boolean {
  return (
    typeof explicitRoot === 'string' ||
    source === 'explicit' ||
    source === 'client-cwd' ||
    source === 'mcp-roots' ||
    source === 'server-project-root'
  );
}

/**
 * s92-m01 — which store a call touched and how it was chosen. Stamped onto every success
 * payload so an agent never has to infer the project from context.
 */
export interface ResolutionStamp {
  readonly projectRoot: string | null;
  readonly projectAddress?: string;
  readonly resolvedBy: ResolvedBy;
  /** Rendered instead of the plain "resolved by" label when the route needs saying out loud. */
  readonly note?: string;
}

/** A call that touched no single project store: a portfolio, registry or dashboard-only action. */
const NO_PROJECT: ResolutionStamp = { projectRoot: null, resolvedBy: 'none' };

function stampOf(ctx: SenderContext | null): ResolutionStamp {
  if (!ctx) return NO_PROJECT;
  // The client advertised workspace roots, none of them is inside a Reasonbook project, and the
  // server's working directory answered instead. That is the documented order, but the caller
  // may be working in one of those roots — say so rather than resolve silently.
  const rootsSkipped =
    ctx.source === 'cwd' &&
    ctx.candidates.some((candidate) => candidate.source === 'mcp-roots' && !candidate.accepted);
  return rootsSkipped
    ? {
        projectRoot: ctx.projectRoot,
        resolvedBy: ctx.source,
        note: "resolved by the server's working directory — the client's MCP roots hold no Reasonbook project",
      }
    : {
        projectRoot: ctx.projectRoot,
        resolvedBy: ctx.source,
        ...(ctx.requestedAddress ? { projectAddress: ctx.requestedAddress } : {}),
      };
}

/**
 * The sources an agent may not expect, so the answer says them out loud. `explicit` (the caller
 * named it) and `cwd` (the caller is standing in it) stay silent.
 */
const RESOLVED_BY_LABELS: Partial<Record<ResolvedBy, string>> = {
  'client-cwd': "the client's working folder",
  'mcp-roots': "the client's MCP roots",
  'server-project-root': "--project-root in this server's config",
  'registry-default': 'the registry default project',
};

/**
 * A project root as it may appear on the answer's first line: unchanged when it is an ordinary
 * path; JSON-encoded, bounded and with backticks escaped when it holds a control character, a
 * backtick or a line separator, so a crafted folder name cannot break out of the line (s93-m11).
 */
function inertProjectRoot(projectRoot: string): string {
  const unsafe = [...projectRoot].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || ch === '`';
  });
  if (!unsafe) return projectRoot;
  const bounded =
    projectRoot.length > 320
      ? `${projectRoot.slice(0, 320)}… [truncated; original length=${projectRoot.length}]`
      : projectRoot;
  return JSON.stringify(bounded)
    .replace(/`/g, '\\u0060')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build the MCP answer for a Reasonbook tool result. On success, `projectRoot` and `resolvedBy` are
 * added to `data` (a handler's own `projectRoot` is kept), and one line names the project. s93-m11
 * (#606 c): the line is rendered on every answer that touched a project, as the server
 * instructions promise; how the project was chosen is added when it was inferred rather than named.
 */
export function buildResolvedToolResult(
  result: { success: boolean; data?: unknown },
  formatted: string,
  stamp: ResolutionStamp
): CallToolResult {
  if (stamp.projectRoot) noteTelemetryProject(stamp.projectRoot);
  const structured: Record<string, unknown> = { ...result };
  let text = formatted;
  if (result.success) {
    const data = result.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      structured.data = {
        ...record,
        projectRoot:
          typeof record.projectRoot === 'string' ? record.projectRoot : stamp.projectRoot,
        resolvedBy: stamp.resolvedBy,
        ...(stamp.projectAddress ? { projectAddress: stamp.projectAddress } : {}),
      };
    } else {
      structured.projectRoot = stamp.projectRoot;
      structured.resolvedBy = stamp.resolvedBy;
      if (stamp.projectAddress) structured.projectAddress = stamp.projectAddress;
    }
  }
  // s93-m11 (#606 c): every text answer names the project it touched, an error included: a call
  // refused after resolution still ran against that store. The structured envelope of an error is
  // left as the handler built it.
  const displayRoot = (value: string) =>
    inertProjectRoot(result.success ? value : boundErrorValue(value));
  const label = RESOLVED_BY_LABELS[stamp.resolvedBy];
  const rawReason = stamp.note ?? (label ? `resolved by ${label}` : null);
  const reason = rawReason && !result.success ? boundErrorValue(rawReason) : rawReason;
  if (stamp.projectRoot) {
    text = `Project: ${stamp.projectAddress ? `${displayRoot(stamp.projectAddress)} — ` : ''}${displayRoot(stamp.projectRoot)}${reason ? ` (${reason})` : ''}\n\n${formatted}`;
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: result.success === false,
  };
}

/** whoami reports resolution itself; its stamp is the local project its resolution found. */
function whoamiStamp(result: {
  data?: {
    resolved?: { projectRoot: string | null; source: ResolvedBy | null; requestedAddress?: string };
  };
}): ResolutionStamp {
  const resolved = result.data?.resolved;
  return resolved?.projectRoot && resolved.source
    ? {
        projectRoot: resolved.projectRoot,
        resolvedBy: resolved.source,
        ...(resolved.requestedAddress ? { projectAddress: resolved.requestedAddress } : {}),
      }
    : NO_PROJECT;
}

/**
 * Resolve a project for an action that can run without one (a user-level dashboard action):
 * use the caller's project when one resolves, and run project-free when none does. An explicit
 * projectRoot is still final — naming a folder that is not a Reasonbook project is refused.
 */
async function resolveOptionalSenderContext(
  explicitRoot: string | undefined
): Promise<SenderContext | null> {
  if (explicitRoot !== undefined) return resolveToolSenderContext(explicitRoot);
  try {
    return await resolveToolSenderContext(undefined);
  } catch (error) {
    if (error instanceof SenderResolutionError && !currentCodexRequest()) return null;
    throw error;
  }
}

/**
 * Register tool handlers
 */
export function registerToolHandlers(
  context: MissionProtocolContext,
  serverInstance?: Server
): void {
  const targetServer = serverInstance || server;
  // Listen for roots changes and clear cache
  targetServer.setNotificationHandler('notifications/roots/list_changed', async () => {
    debugLog(`[INFO] Client roots changed, clearing cache`);
    clearClientProjectRoots(targetServer);
  });

  // List available tools (includes Reasonbook tools when detected)
  targetServer.setRequestHandler('tools/list', async () => {
    return {
      tools: getToolDefinitions(),
    };
  });

  // Handle tool execution
  targetServer.setRequestHandler('tools/call', async (request, requestContext) => {
    const { name, arguments: args } = request.params;
    const client = clientLabelForRequest(targetServer, requestContext);
    return withCodexRequest(request.params._meta, () =>
      withServerRequest(targetServer, requestContext, () =>
        withMcpTelemetry(
          {
            name,
            args,
            mode: classifyAction(name, extractActionArg(args)),
            client,
          },
          async () => {
            try {
              if (!context) {
                throw new ProtocolError(
                  ProtocolErrorCode.InternalError,
                  'Server context not initialized'
                );
              }

              // Establish the outer request carrier here so failures retain this call's disclosures.
              // executeMissionProtocolTool sees the active ALS context and runs its switch directly.
              const actionMode = classifyAction(name, extractActionArg(args));
              const captured = await captureToolCall(actionMode, () =>
                executeWithStoreUpkeep(name, args, context)
              );
              return attachStoreUpkeepNotes(
                attachProjectIdentityDisclosures(
                  captured.value,
                  captured.projectIdentityDisclosures
                ),
                captured.storeUpkeepNotes
              );
            } catch (error) {
              const originalError = unwrapCapturedToolCallError(error);
              if (originalError instanceof SenderResolutionError) {
                return attachProjectIdentityDisclosures(
                  buildKnownToolErrorResult(
                    await classifySenderResolutionError(
                      originalError,
                      refusalMode(classifyAction(name, extractActionArg(args)))
                    )
                  ),
                  projectIdentityDisclosuresForError(error)
                );
              }
              // Sprint 74 m03: a tool HANDLER that throws an unhandled exception (a
              // write-path crash — e.g. rbook_sprint(complete)/rbook_session(capture)
              // hitting a store-specific failure) is a tool-EXECUTION failure, not a
              // protocol error. Surface it as a structured RbookToolResult error
              // (code + real message + suggestion) returned as an isError result —
              // never a bare JSON-RPC -32603 that swallows the cause (aquex.ai aa124685).
              // Genuine protocol errors (ProtocolError: unknown tool, uninitialized context)
              // keep their JSON-RPC error shape — they already carry a clear message.
              if (originalError instanceof ProtocolError) {
                throw originalError;
              }
              return attachProjectIdentityDisclosures(
                buildToolExecutionErrorResult(name, args, originalError),
                projectIdentityDisclosuresForError(error)
              );
            }
          }
        )
      )
    );
  });
}

/**
 * Sprint 74 m03 — convert an unhandled tool-handler exception into a structured
 * RbookToolResult error returned as an `isError` tool result, so the caller sees a
 * real `{code, message, suggestion}` instead of a bare JSON-RPC -32603 that hides
 * the cause. Logs the underlying error (via ErrorHandler.handle, never re-throws)
 * to keep the correlationId trail, then surfaces the REAL exception message —
 * NOT the generic userMessage that toPublicError would substitute.
 */
export function buildToolExecutionErrorResult(
  toolName: string,
  args: unknown,
  error: unknown
): CallToolResult {
  const reportableError =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  const sanitizedArgs = sanitizeArgs(args);
  const data: Record<string, JsonValue> = { tool: toolName };
  if (sanitizedArgs) {
    data.args = sanitizedArgs;
  }

  const missionError = ErrorHandler.handle(
    reportableError,
    'server.execute_tool',
    { module: 'server', data },
    { rethrow: false, userMessage: 'Tool execution failed. Please check inputs and try again.' }
  );

  const correlationId = missionError.context?.correlationId;
  const correlationSuffix =
    typeof correlationId === 'string' && correlationId.length > 0
      ? ` (correlationId=${correlationId})`
      : '';
  const detail =
    typeof missionError.message === 'string' && missionError.message.trim().length > 0
      ? missionError.message.trim()
      : 'unexpected internal error';

  const structuredError: RbookToolError = {
    code: RBOOK_ERROR_CODES.TOOL_EXECUTION_ERROR,
    message: `The '${toolName}' tool failed with an unhandled internal error: ${detail}`,
    // s89-m08 CLASS 3. This used to open "This is an internal error, not an input-validation
    // problem". That is a UNIVERSAL claim about the CAUSE, made by a catch-all boundary that
    // has only an unhandled exception and a correlationId and cannot know it — and it was
    // measurably FALSE for the whole wrong-typed-parameter class (42 triples), where the cause
    // was exactly an input-validation problem. It also prescribed "retry the call", a loop with
    // no exit for any deterministic fault. Say only what this frame knows.
    suggestion: `Cause unclassified. If this repeats with the same inputs, capture the inputs and report this${correlationSuffix}.`,
  };
  return buildKnownToolErrorResult(structuredError);
}

/**
 * Render a refusal whose cause is already known. Unlike the catch-all execution-error boundary,
 * this helper performs no logging and creates no correlation id: expected client/setup faults are
 * not internal incidents.
 */
export function buildKnownToolErrorResult(error: RbookToolError): CallToolResult {
  const structured = boundErrorFields({ success: false as const, error });
  error = structured.error;
  const suggestion = error.suggestion ? `\nSuggestion: ${error.suggestion}` : '';
  const text =
    `Tool execution error [${error.code}]: ${error.message}${suggestion}\n\n` +
    JSON.stringify(structured, null, 2);

  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: true,
  };
}

/** s92-m01: a refusal tells a read how to read and anything else how to write. */
function refusalMode(actionMode: string | undefined): 'read' | 'write' {
  return actionMode === 'read' ? 'read' : 'write';
}

/** Best-effort read of the `action` discriminator from a tool's args, for the
 *  read-only-agent guard. Returns undefined for action-less tools or malformed args. */
function extractActionArg(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'action' in args) {
    const value = (args as { action?: unknown }).action;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

// s92-m01: `classifySenderResolutionError` moved to `tools/rbook/sender-refusal.ts` so the suggestion
// oracle can drive it in-process; re-exported here for existing importers.
export { classifySenderResolutionError };

/** Attach request-local fallback-identity disclosures to both MCP answer channels. */
function attachProjectIdentityDisclosures(
  result: CallToolResult,
  disclosures: readonly string[]
): CallToolResult {
  if (disclosures.length === 0) return result;

  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  const existingWarnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const warnings = [...new Set([...existingWarnings, ...disclosures])];
  const section =
    `Project identity disclosure${disclosures.length === 1 ? '' : 's'}:\n` +
    disclosures.map((disclosure) => `- ${disclosure}`).join('\n');
  const content = [...result.content];
  const textIndex = content.findIndex((part) => part.type === 'text');
  if (textIndex >= 0) {
    const part = content[textIndex];
    if (part.type === 'text') {
      content[textIndex] = { ...part, text: `${part.text}\n\n${section}` };
    }
  } else {
    content.push({ type: 'text', text: section });
  }

  return {
    ...result,
    content,
    structuredContent: { ...structured, warnings },
  };
}

/** s93-m11 — store upkeep this call performed, under its own heading on the answer. */
function attachStoreUpkeepNotes(result: CallToolResult, notes: readonly string[]): CallToolResult {
  if (notes.length === 0) return result;
  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  const existingWarnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const warnings = [...new Set([...existingWarnings, ...notes])];
  const section = `Store upkeep:\n${notes.map((note) => `- ${note}`).join('\n')}`;
  const content = [...result.content];
  const textIndex = content.findIndex((part) => part.type === 'text');
  if (textIndex >= 0) {
    const part = content[textIndex];
    if (part.type === 'text') {
      content[textIndex] = { ...part, text: `${part.text}\n\n${section}` };
    }
  } else {
    content.push({ type: 'text', text: section });
  }
  return { ...result, content, structuredContent: { ...structured, warnings } };
}

export async function executeMissionProtocolTool(
  name: string,
  args: unknown,
  _context: MissionProtocolContext
): Promise<CallToolResult> {
  const editionError = directoryCallError(name, args);
  if (editionError) return buildKnownToolErrorResult(editionError);
  // s88-m08: establish one concurrency-safe request context before resolution or DB open. The
  // recursive call sees the active context and executes the existing switch unchanged; keeping
  // the switch in this exported function preserves the static router-param audit's reach.
  if (currentToolCallActionMode() === undefined) {
    const actionMode = classifyAction(name, extractActionArg(args));
    try {
      const captured = await captureToolCall(actionMode, () =>
        executeWithStoreUpkeep(name, args, _context)
      );
      return attachStoreUpkeepNotes(
        attachProjectIdentityDisclosures(captured.value, captured.projectIdentityDisclosures),
        captured.storeUpkeepNotes
      );
    } catch (error) {
      const originalError = unwrapCapturedToolCallError(error);
      if (originalError instanceof SenderResolutionError) {
        return attachProjectIdentityDisclosures(
          buildKnownToolErrorResult(
            await classifySenderResolutionError(originalError, refusalMode(actionMode))
          ),
          projectIdentityDisclosuresForError(error)
        );
      }
      // Direct callers retain the established protocol error instanceof/code contract. Known sender
      // setup refusals above are the deliberate exception: they now use the same structured
      // result and disclosure carrier as the registered CallTool boundary.
      throw originalError;
    }
  }

  // Client/schema failures and protocol method lookup precede the authorization guard: neither can
  // mutate state, and they retain INVALID_ACTION / MethodNotFound even in a review-role process.
  const definitionExists = (RBOOK_TOOL_DEFINITIONS as readonly ToolDefinition[]).some(
    (definition) => definition.name === name
  );
  if (!definitionExists) {
    throw new ProtocolError(
      ProtocolErrorCode.MethodNotFound,
      boundErrorValue(`Unknown tool: ${name}`)
    );
  }

  const preflightError = preflightMissionProtocolTool(name, args);
  if (preflightError) {
    return buildKnownToolErrorResult(preflightError);
  }

  // Whole-schema checking follows action, projectRoot type and unknown-key precedence. The
  // normalized arguments (not the original nulls or zod's stripped output) reach every handler.
  const schema = RBOOK_TOOL_SCHEMAS[name];
  if (!schema) throw new Error(`No input schema for published tool: ${name}`);
  const checked = validateRbookArguments(schema, args);
  if (!checked.success) return buildKnownToolErrorResult(checked.error!);
  args = checked.data!;

  // Sprint 78 m04 (FORK-5): read-only review-agent guard. It still runs before the switch and any
  // resolveToolSenderContext / DB open, so a blocked valid write opens no DB and mutates no row.
  // Strict no-op unless RBOOK_AGENT_ROLE=review; then write-classified calls are hard-rejected.
  try {
    assertReadOnlyAgentAllowed(name, extractActionArg(args));
  } catch (error) {
    if (error instanceof ReadOnlyAgentGuardError) {
      return buildToolExecutionErrorResult(name, args, error);
    }
    throw error;
  }

  switch (name) {
    // ========================================
    // Reasonbook Tools (always available, return graceful error if not detected)
    // ========================================

    // Consolidated DB admin tool (Sprint 24)
    case 'rbook_db': {
      const params = args as RbookDbParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookDb({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatDbForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated mission CRUD tool (Sprint 24)
    case 'rbook_mission': {
      const params = args as RbookMissionParams;

      // s79-m04/m05 — no per-handler fan-out. rbook_mission(status) with no
      // projectRoot resolves to the sender; "active missions across the portfolio"
      // is served by acrossProjects=true (the graph-backed queryAcrossStores),
      // which must NOT require a resolvable LOCAL store.
      // s92-m01: ONLY that portfolio read skips the local requirement (the local project is
      // still used, when one resolves, to label rows local or foreign). Every other action
      // resolves normally, so the flag can never redirect a write: add/update with
      // acrossProjects=true used to drop an explicit projectRoot and write the cwd project.
      const portfolioRead = params.acrossProjects === true && params.action === 'status';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      let result = await rbookMission({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatMissionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated mission transition tool (Sprint 24)
    case 'rbook_mission_transition': {
      const params = args as RbookMissionTransitionParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookMissionTransition({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatMissionTransitionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated context tool (Sprint 24)
    case 'rbook_context': {
      const params = args as RbookContextParams;

      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookContext({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatContextForLLM(params.action, result, params.contextType);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated session tool (Sprint 24)
    case 'rbook_session': {
      const params = args as RbookSessionParams;

      // s79-m04 — rbook_session(list) with no projectRoot pins to the sender (no
      // §5.4 named portfolio query; documented deviation from the master-plan wording).
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookSession({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatSessionForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Consolidated decisions tool (Sprint 24)
    case 'rbook_decisions': {
      const params = args as RbookDecisionsParams;
      // s69-m06: the acrossProjects (list) path discovers stores via the project-graph
      // registry, NOT the sender root — so it must NOT require a resolvable LOCAL store
      // at the boundary. resolveToolSenderContext throws when no local store resolves,
      // which is the NORMAL case for a portfolio query run from a neutral directory
      // (and the registry-singleton fallback only accepts a 1-project registry, never a
      // real multi-project portfolio). Skip resolution for that path; rbookDecisionsList
      // ignores projectRoot on the acrossProjects branch anyway.
      // s92-m01: only list is the portfolio read. record/update/search with acrossProjects=true
      // used to skip resolution too, drop an explicit projectRoot and write the cwd project.
      const portfolioRead = params.acrossProjects === true && params.action === 'list';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      let result = await rbookDecisions({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatDecisionsForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated learnings tool (Sprint 38)
    case 'rbook_learnings': {
      const params = args as RbookLearningsParams;
      // s79-m05: acrossProjects (list) is a graph-backed portfolio query — skip
      // local-root resolution (mirrors rbook_decisions / rbook_mission).
      // s92-m01: only list is the portfolio read; every other action resolves normally.
      const portfolioRead = params.acrossProjects === true && params.action === 'list';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      let result = await rbookLearnings({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatLearningsForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Consolidated feedback tool (Sprint 56 m03)
    case 'rbook_feedback': {
      const params = args as RbookFeedbackParams;
      const portfolioRead = params.acrossProjects === true && params.action === 'list';
      const ctx = portfolioRead
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      let result = await rbookFeedback({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatFeedbackForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, portfolioRead ? NO_PROJECT : stampOf(ctx));
    }

    // Credential lifecycle (Sprint 57 m03)
    case 'rbook_auth': {
      const params = args as RbookAuthParams;
      // s92-m01: login, list and logout are USER-level — they need a dashboard credential, not a
      // project. Once the registry-singleton auto-pick was removed they would otherwise refuse from
      // any non-Reasonbook folder, so they use the caller's project when one resolves and run
      // project-free when none does. revoke takes the same route: with a keyId it needs no
      // project, and without one its handler refuses "revoke requires either keyId or
      // projectRoot". rotate and reissue act on a project's key and still require one. An
      // explicit projectRoot is final on every route.
      const userLevel =
        params.action === 'login_init' ||
        params.action === 'login_complete' ||
        params.action === 'login' ||
        params.action === 'list' ||
        params.action === 'logout' ||
        params.action === 'revoke';
      const ctx = userLevel
        ? await resolveOptionalSenderContext(params.projectRoot)
        : await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx?.projectRoot;
      let result = await rbookAuth({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatAuthForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // At-a-glance status payload (Sprint 62 m06)
    case 'rbook_status': {
      const params = args as RbookStatusParams;
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookStatus({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatStatusForLLM(result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Sprint tools
    case 'rbook_sprint': {
      const params = args as RbookSprintParams;

      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookSprint({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatSprintForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    case 'rbook_agent_onboard': {
      const params = args as RbookAgentOnboardParams;
      const advertisedRoots = await getClientProjectRoots(params.projectRoot);
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      let result = await rbookAgentOnboard({
        ...params,
        projectRoot,
        advertisedRoots,
        callerProvidedProjectRoot: callerNamedProject(params.projectRoot, ctx.source),
      });
      result = boundErrorFields(result);
      const formatted = formatAgentOnboardForLLM(result);

      return buildResolvedToolResult(result, formatted, stampOf(ctx));
    }

    // Bundled session-opener digest (Sprint 64 m03).
    // Project-scoped by design — does NOT walk the project registry.
    case 'rbook_review': {
      const params = args as RbookReviewParams;
      const advertisedRoots = await getClientProjectRoots(params.projectRoot);
      const ctx = await resolveToolSenderContext(params.projectRoot);
      const projectRoot = ctx.projectRoot;
      // s92-m01: the digest carries projectRoot/resolvedBy inside its own 4KB budget.
      // s92-m04: the roots and "the caller named the project" reach the nested onboard, so a
      // project the client or operator named is not reported as ambiguous (the whoami nudge).
      const result = await rbookReviewPresentation(
        { ...params, projectRoot },
        {
          resolvedBy: ctx.source,
          advertisedRoots,
          callerProvidedProjectRoot: callerNamedProject(params.projectRoot, ctx.source),
        }
      );
      noteTelemetryPresentedIds(result.context?.returnedIds ?? []);
      return buildResolvedToolResult(result.result, result.text, stampOf(ctx));
    }

    // Consolidated message tool (Sprint 28)
    case 'rbook_message': {
      const params = args as RbookMessageParams;
      const advertisedRoots = await getClientProjectRoots(params.projectRoot);

      if (params.action === 'whoami') {
        let result = await getWhoamiDiagnostics({
          explicitProjectRoot: params.projectRoot,
          mcpRoots: advertisedRoots,
        });
        result = boundErrorFields(result);
        const formatted = formatMessageForLLM(params.action, result);

        // whoami reports resolution itself; its stamp is the relaxed (local) resolution it found.
        return buildResolvedToolResult(result, formatted, whoamiStamp(result));
      }

      // Sprint 53 m02: `send` must resolve through the audited boundary with
      // `requireSenderIdentity=true`. The former path bypassed root resolution
      // entirely (see sprint-53-attribution-rebuild.md §Verified Root Cause #2)
      // and was the structural source of the cross-project attribution P0. Non-send actions
      // (list/respond/directory) hit the dashboard directly and don't need a
      // local project identity, so they skip resolution.
      let projectRoot: string | undefined;
      let stamp: ResolutionStamp = NO_PROJECT;
      if (params.action === 'send') {
        const ctx = await resolveSenderContext({
          explicitProjectRoot: params.projectRoot,
          mcpRoots: advertisedRoots,
          requireSenderIdentity: true,
        });
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      } else if (params.projectRoot != null) {
        // s92-m01: an explicit projectRoot is final on every action. The dashboard-only actions
        // used to pass it through unchecked (and a non-Reasonbook folder would have been reported as
        // the project the call used). Null, like omission, does not name an explicit root.
        const ctx = await resolveToolSenderContext(params.projectRoot);
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      } else if (params.action === 'list') {
        // s80-m05: best-effort project-pin for LIST only — resolve the sender RELAXED so
        // a project-scoped credential (when one exists) scopes the dashboard query and
        // trims the payload. A read must NEVER fail closed, so an unresolvable sender
        // fails OPEN: leave projectRoot undefined and fall through to user-scoped auth.
        // NB: `get` is deliberately NOT pinned — pinning would narrow its client-side
        // paging to one project, hiding a valid messageId from another of the operator's
        // projects (s80-m05 review). get uses user-scoped (widest) visibility.
        try {
          const ctx = await resolveSenderContext({
            explicitProjectRoot: params.projectRoot,
            mcpRoots: advertisedRoots,
            requireSenderIdentity: false,
          });
          projectRoot = ctx.projectRoot;
          stamp = stampOf(ctx);
        } catch (error) {
          // A caller-named Codex folder is final, including a malformed/missing field. The
          // historical contextless inbox fallback must not widen a refused Codex request.
          if (currentCodexRequest()) throw error;
          // fail-open — user-scoped auth returns the operator's full inbox
        }
      }
      let result = await rbookMessage({ ...params, projectRoot, advertisedRoots });
      result = boundErrorFields(result);
      const formatted = formatMessageForLLM(params.action, result);

      return buildResolvedToolResult(result, formatted, stamp);
    }

    // Consolidated project tool (Sprint 24)
    case 'rbook_project': {
      const params = args as RbookProjectParams;
      // init/register/unregister take a literal user-supplied path (destination for a new
      // workspace, a path to register, a path to forget). Routing through resolveToolSenderContext
      // would substitute the caller's own project: before s92-m01 an unregister of a deleted
      // project fell through to the cwd project and unregistered THAT. The action handlers
      // validate the path themselves and reject empty/missing input.
      // s97-m11: a join through the dashboard names the empty folder it joins into, likewise.
      const isLiteralPathAction =
        params.action === 'init' ||
        params.action === 'register' ||
        params.action === 'unregister' ||
        (params.action === 'join' && params.via === 'dashboard');
      // list/validate/prune/sweep read or tidy the registry itself and never open a project store,
      // so they do not need — and must not refuse for lack of — a resolvable local project.
      const isRegistryAction =
        params.action === 'list' ||
        params.action === 'validate' ||
        params.action === 'prune' ||
        params.action === 'sweep';
      let stamp: ResolutionStamp = NO_PROJECT;
      let projectRoot: string | undefined = params.projectRoot;
      if (isLiteralPathAction) {
        if (typeof projectRoot === 'string' && isProjectAddress(projectRoot)) {
          const action = typeof params.action === 'string' ? params.action : '';
          const result = boundErrorFields({
            success: false,
            error: {
              code: 'PROJECT_FOLDER_REQUIRED',
              message: `rbook_project(action="${action}") requires a filesystem folder, not a project address.`,
              suggestion:
                'Pass projectRoot as a project folder. Call rbook_project(action="list") to find an existing project path.',
            },
          });
          return buildResolvedToolResult(result, formatProjectForLLM(action, result), NO_PROJECT);
        }
        if (typeof projectRoot === 'string' && projectRoot.trim() !== '') {
          stamp = { projectRoot: path.resolve(projectRoot), resolvedBy: 'explicit' };
        }
      } else if (!isRegistryAction) {
        const ctx = await resolveToolSenderContext(params.projectRoot);
        projectRoot = ctx.projectRoot;
        stamp = stampOf(ctx);
      }
      let result = await rbookProject({ ...params, projectRoot });
      result = boundErrorFields(result);
      const formatted = formatProjectForLLM(params.action, result, {
        validate: params.validate,
      });

      return buildResolvedToolResult(result, formatted, stamp);
    }

    default:
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        boundErrorValue(`Unknown tool: ${name}`)
      );
  }
}

async function runWhoamiCli(): Promise<number> {
  const result = await getWhoamiDiagnostics();
  console.log(formatMessageForLLM('whoami', result));
  return result.success ? 0 : 1;
}

/**
 * Registry prune result emitted by the startup hook.
 */
interface StartupRegistryPruneResult {
  /** Total entries before the prune (null on failure before load). */
  totalBefore: number | null;
  /** Entries removed (stale directory or missing Reasonbook database). */
  pruned: number;
  /** Remaining entries after prune. */
  remaining: number | null;
  /** Error message when the prune could not run; null on success. */
  error: string | null;
}

/**
 * Walk the registry, drop entries whose `projectRoot` no longer contains a
 * Reasonbook database, and emit a concise log line so the operator can see drift.
 *
 * Sprint 56 m01: registry pollution was blowing the fanout response cap on
 * read surfaces. Auto-prune at boot keeps the registry bounded by live
 * projects without requiring a manual `rbook_project(action="validate")`.
 */
async function runStartupRegistryPrune(): Promise<StartupRegistryPruneResult> {
  try {
    // s79-m03 — prune/archive against the project-graph registry (rows whose
    // store's rbook/db/rbook.sqlite vanished). s80-m02: the graph is the single
    // discovery source — no JSON mirror to re-derive.
    const graph = await ProjectGraphRegistry.create();
    const before = graph.list().length;
    const pruned = graph.pruneMissingStores();
    const remaining = graph.list().length;
    return { totalBefore: before, pruned, remaining, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { totalBefore: null, pruned: 0, remaining: null, error: message };
  }
}

let startupRegistryPruneRunner: typeof runStartupRegistryPrune = runStartupRegistryPrune;

// Sprint 57 m02: startup recovery for partial-failure auto-issue. Non-fatal.
/** Result of the s78-m06 startup topology diagnostic. */
export interface StartupTopologyResult {
  /** True when the ambiguous-attribution topology was detected and warned. */
  warned: boolean;
  /** Whether RBOOK_PROJECT_ROOT is pinned (non-empty). */
  projectRootPinned: boolean;
  /** Registered project count consulted for the ambiguity check. */
  registryProjectCount: number;
}

/**
 * s78-m06 topology diagnostic. WARNs ONLY in the single ambiguous-attribution
 * topology: a global MCP entry with RBOOK_PROJECT_ROOT pinned to one repo WHILE more
 * than one project is registered — the config where one env pins .env bootstrap +
 * fallback attribution to a single repo that every sibling session shares. Silent for
 * the safe cases (local per-project server, or a single registered project). Pure so
 * it is unit-testable without booting.
 */
export function evaluateStartupTopology(
  projectRootEnv: string | undefined,
  registryProjectCount: number
): StartupTopologyResult {
  const projectRootPinned = (projectRootEnv ?? '').trim().length > 0;
  return {
    warned: projectRootPinned && registryProjectCount > 1,
    projectRootPinned,
    registryProjectCount,
  };
}

let startupProjectKeyRecoveryRunner: typeof runStartupProjectKeyRecovery =
  runStartupProjectKeyRecovery;

// Sprint 58 m02: startup credential-store empty-check. Non-fatal.
let startupCredentialCheckRunner: typeof runStartupCredentialCheck = runStartupCredentialCheck;

/**
 * Sprint 62 m02: detect a `.env` file accidentally bundled inside the npm
 * tarball. Defends against the worst-case "shipped credentials to npm" leak.
 *
 * Detection: only fires when the running script lives under a `node_modules`
 * path (i.e. installed from npm), to avoid false positives on dev tree where
 * a `.env` file is normal. Logs a [WARN] — never throws — so a misconfig
 * doesn't break startup.
 *
 * Exported for unit testing.
 */
export interface BundledEnvCheckResult {
  installedFromNpm: boolean;
  envFilePath: string | null;
  envFileBundled: boolean;
}

export function runStartupBundledEnvCheck(
  serverInstallRoot: string = SERVER_INSTALL_ROOT
): BundledEnvCheckResult {
  const installedFromNpm = serverInstallRoot.includes(`${path.sep}node_modules${path.sep}`);
  if (!installedFromNpm) {
    return { installedFromNpm: false, envFilePath: null, envFileBundled: false };
  }
  const envFilePath = path.join(serverInstallRoot, '.env');
  const envFileBundled = fs.existsSync(envFilePath);
  return { installedFromNpm: true, envFilePath, envFileBundled };
}

let startupBundledEnvCheckRunner: typeof runStartupBundledEnvCheck = runStartupBundledEnvCheck;

async function runStartupAttributionSelfTest(): Promise<StartupAttributionSelfTestResult> {
  // s92-m01: the cwd-vs-install-root guard is retired (fork 1), so this self-test no longer warns
  // when the install root resolves: a cwd equal to the install root resolves by cwd when it holds a
  // store, which is the intended route for work in this repository.
  try {
    // s93-m11: a startup diagnostic, not a call, so it never repairs the address; it resolves with
    // the address the next write would store, as that write would (heal: 'preview').
    const resolved = await resolveSenderContext({
      requireSenderIdentity: true,
      heal: 'preview',
    });
    return {
      projectRoot: resolved.projectRoot,
      source: resolved.source,
      errorCode: null,
      warning: null,
    };
  } catch (error) {
    if (error instanceof SenderResolutionError) {
      return {
        projectRoot: null,
        source: null,
        errorCode: error.code,
        warning: null,
      };
    }

    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      projectRoot: null,
      source: null,
      errorCode: 'SELF_TEST_FAILED',
      warning: `Startup attribution self-test failed unexpectedly: ${message}`,
    };
  }
}

/**
 * Initialize server components
 */
async function initializeServer(): Promise<MissionProtocolContext> {
  try {
    debugLog(`[INFO] Initializing MCP server...`);
    const context = await contextBuilder();
    debugLog(`[INFO] Reasonbook bundled seed schema version: ${RBOOK_SCHEMA_VERSION}`);
    debugLog(`[INFO] Default intelligence model: ${context.defaultModel}`);

    // Sprint 53 m02 / m04: startup diagnostic for attribution. `SERVER_INSTALL_ROOT`
    // is the one path that must never be the *implicit* sender for another project;
    // operators see it here so they can verify before debugging misrouted sends.
    const envProjectRoot = getSetting(RBOOK_PROJECT_ROOT_ENV);
    debugLog(`[INFO] Server install root: ${SERVER_INSTALL_ROOT}`);
    debugLog(
      `[INFO] Sender attribution diagnostics: Server install root: ${SERVER_INSTALL_ROOT}. ` +
        `${RBOOK_PROJECT_ROOT_ENV} env: ${envProjectRoot ?? 'unset'}. Roots support: probed on first call.`
    );
    if (envProjectRoot && !isDirectoryEdition()) {
      console.error(
        `[WARN] ${RBOOK_PROJECT_ROOT_ENV}=${envProjectRoot} is set. It does not select a project for ` +
          `tool calls; the server reads it only to find its own .env. If you relied on ` +
          `this env to pin attribution, pass projectRoot explicitly or ensure your MCP client advertises ` +
          `roots. Every outbound send will fail-closed rather than silently attribute to the server's ` +
          `own project.`
      );
    } else if (!envProjectRoot) {
      debugLog(`[INFO] ${RBOOK_PROJECT_ROOT_ENV} env: unset (it does not select a project).`);
    }
    const registryPrune = await startupRegistryPruneRunner();
    if (registryPrune.error) {
      console.error(
        `[WARN] Registry prune skipped: ${registryPrune.error} — continuing startup with unpruned registry.`
      );
    } else if (registryPrune.pruned > 0) {
      debugLog(
        `[INFO] pruned ${registryPrune.pruned} stale entries from project registry (${registryPrune.remaining} remaining)`
      );
    } else {
      debugLog(
        `[INFO] Project registry healthy: ${registryPrune.remaining ?? 0} entries, no stale entries pruned`
      );
    }

    // s92-m01: say which defaults a contextless call can use, and which it cannot.
    const serverProjectRoot = getServerProjectRoot();
    if (serverProjectRoot) {
      const configured = findEnclosingStore(serverProjectRoot);
      if (configured?.hasDatabase && configured.root === serverProjectRoot) {
        debugLog(
          `[INFO] ${PROJECT_ROOT_ARG}: ${serverProjectRoot} (used for calls with no project context)`
        );
      } else {
        console.error(
          `[WARN] ${PROJECT_ROOT_ARG}: ${serverProjectRoot} holds no Reasonbook database; calls with no project context will be refused until it does.`
        );
      }
    }
    try {
      const status = (await ProjectGraphRegistry.create()).getDefaultStatus();
      const notice = unappliedDefaultNotice(status);
      if (notice && status.entry) {
        // Stays visible (s92-m07): an upgrader must re-confirm a pre-3.2.0 default, and this line,
        // whoami and rbook_review are where they learn it.
        console.error(`[INFO] ${notice}: ${reconfirmDefaultCall(status.entry)}`);
      }
    } catch {
      // Best-effort: the registry prune above already reported an unreadable registry.
    }

    const attributionSelfTest = await startupAttributionSelfTestRunner();
    if (attributionSelfTest.projectRoot && attributionSelfTest.source) {
      debugLog(
        `[INFO] Sender attribution self-test: ${attributionSelfTest.source} -> ${attributionSelfTest.projectRoot}`
      );
    } else {
      debugLog(
        `[INFO] Sender attribution self-test: unresolved (${attributionSelfTest.errorCode ?? 'unknown'})`
      );
    }
    if (attributionSelfTest.warning) {
      console.error(`[P0] Sender attribution self-test warning: ${attributionSelfTest.warning}`);
    }

    if (!isDirectoryEdition()) {
      // Sprint 57 m02: partial-failure recovery for projects registered on the
      // dashboard but with no local project key. Non-fatal — startup continues
      // regardless of the outcome.
      try {
        const recoveryRoot = attributionSelfTest.projectRoot ?? undefined;
        const recovery = await startupProjectKeyRecoveryRunner({
          ...(recoveryRoot ? { projectRoot: recoveryRoot } : {}),
        });
        if (recovery.status === 'recovered') {
          debugLog(`[INFO] Project key recovery: ${recovery.message}`);
        } else if (recovery.status === 'error') {
          console.error(`[WARN] Project key recovery: ${recovery.message}`);
        } else if (
          // s86-m06: both attribution-failure statuses are WARN, not INFO. In either
          // one, auto-recovery is structurally impossible until the operator acts —
          // that is not information. The single status they replaced was logged at
          // INFO and named a cause ("run device code") that is false in one of them.
          recovery.status === 'skipped-no-user-scoped-key' ||
          recovery.status === 'skipped-unattributable-credential'
          // s87-m07 — VERIFIED, NOT CHANGED. This mission's critic pass proposed adding `'error'`
          // here, on the belief that the internal-inconsistency status fell through to [INFO]. It
          // does not: `error` is already routed to [WARN] by the branch above, so the new producer
          // this mission adds (the typed-unreachable null-client branch) is correctly logged. The
          // check is recorded rather than the non-change being silent.
        ) {
          console.error(`[WARN] Project key recovery: ${recovery.status} — ${recovery.message}`);
        } else {
          debugLog(`[INFO] Project key recovery: ${recovery.status} — ${recovery.message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(
          `[WARN] Project key recovery hook threw (non-fatal): ${message}. Continuing startup.`
        );
      }

      // Sprint 58 m02: surface an empty credential store with a one-line
      // [WARN] pointing at rbook_auth(action="login_init"). Makes the "just nothing
      // happens" first-run state audible. Non-fatal.
      try {
        await startupCredentialCheckRunner();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(
          `[WARN] Startup credential check threw (non-fatal): ${message}. Continuing startup.`
        );
      }
    }
    // Sprint 78 m06: topology diagnostic. WARN only in the ambiguous-attribution
    // config — RBOOK_PROJECT_ROOT pinned while >1 project is registered. Non-fatal.
    try {
      const topology = evaluateStartupTopology(
        getSetting(RBOOK_PROJECT_ROOT_ENV),
        registryPrune.remaining ?? 0
      );
      if (topology.warned && !isDirectoryEdition()) {
        console.error(
          `[WARN] reasonbook: ${RBOOK_PROJECT_ROOT_ENV}=${getSetting(RBOOK_PROJECT_ROOT_ENV)} is pinned ` +
            `while ${topology.registryProjectCount} projects are registered. A single global MCP entry ` +
            `with this env pins .env bootstrap (and any dashboard key that .env holds) to one repo ` +
            `that every sibling session shares. Prefer a project-local server, or pass projectRoot ` +
            `explicitly per call. ` +
            `See SECURITY.md "Sanctioned deployment shape".`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `[WARN] Startup topology diagnostic threw (non-fatal): ${message}. Continuing startup.`
      );
    }

    if (!isDirectoryEdition()) {
      // Sprint 62 m02: detect a .env file accidentally bundled inside the npm
      // package — protects against accidental credential leaks to the registry.
      // Non-fatal; only fires when running from a node_modules install.
      try {
        const bundledEnv = startupBundledEnvCheckRunner();
        if (bundledEnv.envFileBundled && bundledEnv.envFilePath) {
          console.error(
            `[WARN] reasonbook: a .env file was found inside the installed package at ${bundledEnv.envFilePath}. ` +
              `This may contain credentials that should not have been published. ` +
              `Inspect the file, treat any contained secrets as compromised, and report the issue at ` +
              `https://github.com/kneelinghorse/reasonbook/issues. The server will continue running.`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error(
          `[WARN] Startup bundled-env check threw (non-fatal): ${message}. Continuing startup.`
        );
      }
    }

    // s77-m03: the boot-time tokenizer preload + health log was removed. The
    // Claude (@xenova) tokenizer now loads lazily on first count(); Gemini is a
    // heuristic. No startup preload, no '[INFO] Tokenizer preload status' line.
    // Initialize server health tracking (build staleness detection)
    initServerHealth();
    const serverHealth = getServerHealth();
    debugLog(
      `[INFO] Server health: pid=${serverHealth.pid} build=${serverHealth.startupBuild?.buildHash.slice(0, 12) ?? 'none'}…`
    );

    debugLog(`[INFO] Server components initialized successfully`);

    return context;
  } catch (error) {
    const missionError = ErrorHandler.handle(
      error,
      'server.initialize',
      {
        module: 'server',
      },
      {
        rethrow: false,
        userMessage: 'Failed to initialize Mission Protocol server components.',
      }
    );
    throw missionError;
  }
}

/**
 * s92-m07: the second startup line. It names the project a call with no projectRoot and no MCP
 * roots would use, through the same resolution such a call runs. A client's roots arrive only after
 * initialize, so they can still name another project.
 */
async function describeStartupProject(): Promise<string> {
  try {
    // s93-m11: a startup line, not a call, so it never repairs the address (heal: 'preview').
    const ctx = await resolveSenderContext({ requireSenderIdentity: false, heal: 'preview' });
    const how =
      ctx.source === 'cwd'
        ? 'the working directory'
        : (RESOLVED_BY_LABELS[ctx.source] ?? ctx.source);
    return `project: ${ctx.projectRoot} (from ${how})`;
  } catch (error) {
    if (error instanceof SenderResolutionError) {
      return (
        'project: none at startup; each call names one with projectRoot, ' +
        "the client's MCP roots, or a working directory inside a project"
      );
    }
    return `project: not resolved at startup (${error instanceof Error ? error.message : 'unknown error'})`;
  }
}

/**
 * Main entry point. `argv` is the arguments after the program (`process.argv.slice(2)` when run as
 * `node dist/index.js`; dist/bin.js passes what follows `serve`, or every argument when no CLI
 * verb was named).
 */
async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    // s77-m04: --version / --help short-circuit in main() BEFORE initializeServer()
    // and server.connect() (mirror the --whoami branch) — else they would hang the
    // stdio server for every MCP host. Both print to stdout and exit 0.
    if (argv.includes('--version')) {
      process.stdout.write(`reasonbook ${getServerVersion()}\n`);
      process.exit(0);
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(
        `reasonbook ${getServerVersion()} — the MCP server for Reasonbook, a project record over SQLite.\n\n` +
          `Usage:\n` +
          `  reasonbook              Run the MCP server over stdio (default; also: reasonbook serve).\n` +
          `  reasonbook --version    Print the version and exit.\n` +
          `  reasonbook --help       Print this help and exit.\n` +
          `  reasonbook --whoami     Print sender-attribution diagnostics and exit.\n` +
          `  reasonbook ${PROJECT_ROOT_ARG} <dir>\n` +
          `                        Use <dir> for calls that carry no project context (no projectRoot,\n` +
          `                        no MCP roots, and a working directory of /, $HOME or the install\n` +
          `                        root) — the Claude Desktop recipe. Set it per server config.\n\n` +
          `The server speaks the Model Context Protocol on stdio; launch it from an MCP\n` +
          `host (Claude Code, Claude Desktop, Cursor, VS Code), not directly.\n`
      );
      return process.exit(0);
    }

    const { firstUnknownOption } = await import('./cli/usage');
    if (firstUnknownOption('serve', argv)) {
      process.stderr.write('reasonbook: unknown option. Use reasonbook --help for usage.\n');
      return process.exit(1);
    }

    // s92-m01: record --project-root before anything resolves (whoami included).
    setServerProjectRoot(parseProjectRootArg(argv));

    if (argv.includes('--whoami')) {
      const exitCode = await whoamiCliRunner();
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    // Initialize all server components
    const context = await initializeServer();

    // Each era opening gets a fresh instance; application startup runs once per process.
    stdioHandle = serveStdio(
      () => {
        server = createProtocolServer();
        registerToolHandlers(context, server);
        registerRbookPromptHandlers(server);
        return server;
      },
      { legacy: 'serve', onerror: (error) => console.error(`[WARN] MCP stdio: ${error.message}`) }
    );

    // A disconnected stdio client ends this server's lifetime, including any pending upload.
    process.stdin.once('end', () => {
      void shutdownServer('stdin close');
    });

    debugLog(`[INFO] ${SERVER_CONFIG.name} MCP server running on stdio`);
    debugLog(`[INFO] Server: ${SERVER_CONFIG.name} v${SERVER_CONFIG.version}`);
    const totalTools = getToolDefinitions().length;
    debugLog(`[INFO] ${totalTools} tools registered`);
    if (context.rbookDetected) {
      debugLog(
        `[INFO] Reasonbook detected, ${RBOOK_TOOL_DEFINITIONS.length} Reasonbook tools enabled`
      );
      debugLog(`[INFO] Reasonbook database: ${context.rbookDatabasePath}`);
    }

    // s92-m07: the two lines a normal start writes. Everything above is behind RBOOK_DEBUG=1.
    console.error(`[reasonbook] v${SERVER_CONFIG.version} ready on stdio (${totalTools} tools)`);
    console.error(`[reasonbook] ${await startupProjectDescriber()}`);
  } catch (error) {
    const missionError = ErrorHandler.handle(
      error,
      'server.startup',
      {
        module: 'server',
        data: {
          stage: 'startup',
        },
      },
      {
        rethrow: false,
        userMessage: 'Mission Protocol server startup failed.',
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const correlationFragment = publicError.correlationId
      ? ` (correlationId=${publicError.correlationId})`
      : '';
    console.error(`[FATAL] Server startup failed${correlationFragment}: ${publicError.message}`);
    process.exit(1);
  }
}

export const __test__ = {
  setShutdownBounds: (bounds: ShutdownBounds) => {
    shutdownServer = makeShutdownServer(bounds);
  },
  registerToolHandlers,
  initializeServer,
  main,
  runWhoamiCli,
  get server() {
    return server;
  },
  createProtocolServer,
  setContextBuilder: (builder: typeof buildMissionProtocolContext) => {
    contextBuilder = builder;
  },
  resetContextBuilder: () => {
    contextBuilder = buildMissionProtocolContext;
  },
  setWhoamiCliRunner: (runner: typeof runWhoamiCli) => {
    whoamiCliRunner = runner;
  },
  resetWhoamiCliRunner: () => {
    whoamiCliRunner = runWhoamiCli;
  },
  setStartupProjectDescriber: (describer: () => Promise<string>) => {
    startupProjectDescriber = describer;
  },
  resetStartupProjectDescriber: () => {
    startupProjectDescriber = describeStartupProject;
  },
  setStartupAttributionSelfTestRunner: (runner: typeof runStartupAttributionSelfTest) => {
    startupAttributionSelfTestRunner = runner;
  },
  resetStartupAttributionSelfTestRunner: () => {
    startupAttributionSelfTestRunner = runStartupAttributionSelfTest;
  },
  runStartupRegistryPrune,
  setStartupRegistryPruneRunner: (runner: typeof runStartupRegistryPrune) => {
    startupRegistryPruneRunner = runner;
  },
  resetStartupRegistryPruneRunner: () => {
    startupRegistryPruneRunner = runStartupRegistryPrune;
  },
  setStartupProjectKeyRecoveryRunner: (runner: typeof runStartupProjectKeyRecovery) => {
    startupProjectKeyRecoveryRunner = runner;
  },
  resetStartupProjectKeyRecoveryRunner: () => {
    startupProjectKeyRecoveryRunner = runStartupProjectKeyRecovery;
  },
  setStartupCredentialCheckRunner: (runner: typeof runStartupCredentialCheck) => {
    startupCredentialCheckRunner = runner;
  },
  resetStartupCredentialCheckRunner: () => {
    startupCredentialCheckRunner = runStartupCredentialCheck;
  },
  runStartupBundledEnvCheck,
  setStartupBundledEnvCheckRunner: (runner: typeof runStartupBundledEnvCheck) => {
    startupBundledEnvCheckRunner = runner;
  },
  resetStartupBundledEnvCheckRunner: () => {
    startupBundledEnvCheckRunner = runStartupBundledEnvCheck;
  },
};

function makeShutdownServer(bounds?: ShutdownBounds): (reason: string) => Promise<void> {
  return createServerShutdown(
    {
      stop: stopDashboardUploadScheduler,
      drain: drainDashboardUploads,
      interrupt: interruptDashboardUploads,
      cleanup: cleanupActiveUploadCopies,
      close: async () => {
        await closeOwnImplicitSessions().catch(() => undefined);
        await (stdioHandle ? stdioHandle.close() : server.close());
      },
      exit: () => process.exit(0),
      report: (error) =>
        ErrorHandler.handle(
          error,
          'server.shutdown',
          {
            module: 'server',
          },
          {
            rethrow: false,
            userMessage: 'Graceful shutdown encountered an issue.',
          }
        ),
    },
    bounds
  );
}

let shutdownServer = makeShutdownServer();

process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('SIGTERM', () => shutdownServer('SIGTERM'));

/**
 * s93-m01 — start the MCP server (or answer a server flag) with these arguments. dist/bin.js, the
 * package's bin, calls this for no verb, `serve` and the server flags; `node dist/index.js` still
 * starts the server directly, as existing configs do.
 */
export function runServer(argv: readonly string[] = process.argv.slice(2)): void {
  main(argv).catch((error) => {
    const missionError = ErrorHandler.handle(
      error,
      'server.unhandled',
      {
        module: 'server',
      },
      {
        rethrow: false,
        userMessage: 'Mission Protocol encountered an unrecoverable error.',
      }
    );
    const publicError = ErrorHandler.toPublicError(missionError);
    const correlationFragment = publicError.correlationId
      ? ` (correlationId=${publicError.correlationId})`
      : '';
    console.error(`[FATAL] Unhandled error${correlationFragment}: ${publicError.message}`);
    process.exit(1);
  });
}

// Start the server
if (require.main === module) {
  runServer();
}

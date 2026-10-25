/**
 * Reasonbook Error Codes
 *
 * Standardized error codes for all Reasonbook tools.
 * Each code maps to a consistent error pattern with actionable suggestions.
 *
 * @module tools/rbook/errors
 */

import { normalizeMissionStatus } from './terminal-status';
import type { RbookToolError, RbookToolResult, MissionStatus, SanitizedFieldReport } from './types';

/**
 * Reasonbook-specific error codes.
 * Naming convention: ENTITY_ERROR_TYPE
 */
export const RBOOK_ERROR_CODES = {
  // Database errors
  DB_NOT_FOUND: 'DB_NOT_FOUND',
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  DB_SCHEMA_MISMATCH: 'DB_SCHEMA_MISMATCH',

  // Mission errors
  MISSION_NOT_FOUND: 'MISSION_NOT_FOUND',
  MISSION_INVALID_STATE: 'MISSION_INVALID_STATE',
  MISSION_INVALID_TRANSITION: 'MISSION_INVALID_TRANSITION',
  MISSION_ALREADY_COMPLETED: 'MISSION_ALREADY_COMPLETED',
  MISSION_ALREADY_BLOCKED: 'MISSION_ALREADY_BLOCKED',

  // Context errors
  CONTEXT_NOT_FOUND: 'CONTEXT_NOT_FOUND',
  CONTEXT_INVALID_TYPE: 'CONTEXT_INVALID_TYPE',
  CONTEXT_PARSE_ERROR: 'CONTEXT_PARSE_ERROR',
  CONTEXT_CONDENSATION_FAILED: 'CONTEXT_CONDENSATION_FAILED',

  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_ACTIVE: 'SESSION_ALREADY_ACTIVE',
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  SESSION_INVALID_TYPE: 'SESSION_INVALID_TYPE',

  // Sprint errors
  SPRINT_NOT_FOUND: 'SPRINT_NOT_FOUND',
  SPRINT_ID_EXISTS: 'SPRINT_ID_EXISTS',
  SPRINT_ALREADY_COMPLETED: 'SPRINT_ALREADY_COMPLETED',
  SPRINT_NOT_READY: 'SPRINT_NOT_READY',

  // Validation errors
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  INVALID_ACTION: 'INVALID_ACTION',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  PROJECT_ID_MISMATCH: 'PROJECT_ID_MISMATCH',

  // Snapshot errors
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  SNAPSHOT_CREATION_FAILED: 'SNAPSHOT_CREATION_FAILED',
  SNAPSHOT_RESTORE_FAILED: 'SNAPSHOT_RESTORE_FAILED',

  // Reasonbook detection errors
  RBOOK_NOT_DETECTED: 'RBOOK_NOT_DETECTED',
  SENDER_UNRESOLVABLE: 'SENDER_UNRESOLVABLE',

  // Dashboard errors (Sprint 28)
  DASHBOARD_UNREACHABLE: 'DASHBOARD_UNREACHABLE',
  DASHBOARD_AUTH_FAILED: 'DASHBOARD_AUTH_FAILED',
  // s84-m02: a 403 is an AUTHZ denial (e.g. "not the recipient"), distinct from a 401
  // token-expiry (DASHBOARD_AUTH_FAILED). Split out so the shared request() no longer
  // clears the cached token on a forbidden — clearing poisoned apiKey auth (Bearer null).
  DASHBOARD_FORBIDDEN: 'DASHBOARD_FORBIDDEN',
  DASHBOARD_NOT_FOUND: 'DASHBOARD_NOT_FOUND',
  DASHBOARD_ERROR: 'DASHBOARD_ERROR',
  DASHBOARD_NOT_CONFIGURED: 'DASHBOARD_NOT_CONFIGURED',
  DASHBOARD_UPGRADE_REQUIRED: 'DASHBOARD_UPGRADE_REQUIRED',

  // Device code flow errors (Sprint 58 m01)
  DEVICE_CODE_EXPIRED: 'DEVICE_CODE_EXPIRED',
  DEVICE_CODE_ACCESS_DENIED: 'DEVICE_CODE_ACCESS_DENIED',

  // Drafted records (s93-m06): a fromDraft that names no draft, one already answered or expired,
  // and a constraint, rule or profile draft recorded without the operator's words in this session.
  DRAFT_NOT_FOUND: 'DRAFT_NOT_FOUND',
  DRAFT_NOT_PENDING: 'DRAFT_NOT_PENDING',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',

  // Unhandled tool-execution exception surfaced at the MCP dispatch boundary (Sprint 74 m03).
  // A handler threw instead of returning a {success:false} envelope; the boundary wraps it
  // as a structured error rather than leaking a bare JSON-RPC -32603 to the caller.
  TOOL_EXECUTION_ERROR: 'TOOL_EXECUTION_ERROR',
} as const;

export type RbookErrorCode = (typeof RBOOK_ERROR_CODES)[keyof typeof RBOOK_ERROR_CODES];

/**
 * Valid mission statuses for validation.
 */
export const VALID_MISSION_STATUSES: MissionStatus[] = [
  'Queued',
  'Current',
  'In Progress',
  'Completed',
  'Blocked',
  'Dropped',
  'Deferred',
];

/**
 * Valid state transitions for missions.
 */
export const VALID_STATE_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  Queued: ['Current', 'In Progress', 'Blocked', 'Dropped', 'Deferred'],
  Current: ['In Progress', 'Blocked', 'Dropped', 'Deferred'],
  'In Progress': ['Completed', 'Blocked', 'Dropped', 'Deferred'],
  Completed: [], // Terminal state
  Blocked: ['In Progress', 'Current', 'Queued', 'Dropped', 'Deferred'],
  Dropped: [], // Terminal state — soft parked, cannot be re-activated
  Deferred: ['Queued', 'Current', 'Dropped'], // Temporarily parked — can re-queue or drop
};

/**
 * s87-m01 — the ONE guarded read of {@link VALID_STATE_TRANSITIONS}. Every dynamic lookup in the
 * mission-transition family goes through here so the next handler cannot reintroduce the crash.
 *
 * WHY A HELPER AND NOT SIX `?? []` FALLBACKS. s86-m08 added exactly one `?? []`, at
 * `rbook-mission-update.ts`, and recorded in #1004 that the crash was fixed. It was not: the throw
 * simply moved into `missionInvalidTransition`, the factory that handler calls, and the other five
 * handlers were never touched. Six scattered fallbacks are six chances to forget the seventh
 * (D-4, #1023).
 *
 * WHY `hasOwnProperty` AND NOT A BARE INDEX. Modelled on `rbook-mission-move.ts`, which found this
 * first: a bare index falls through to `Object.prototype`, so a mission stored with status
 * `'constructor'` resolves to a truthy function and passes a fail-loud guard, while `'toString'`
 * is refused as "a terminal status" — which is not true of anything. Statuses come from the STORE,
 * and the store already proves unvalidated ones land there: this repo's own store holds mission
 * B1.1 at status `'Archived'`, which is not a member of {@link VALID_MISSION_STATUSES}.
 *
 * Returns `undefined` — never `[]` — for an unrecognized status, because the two are different
 * claims. `[]` means "recognized, and terminal"; `undefined` means "not recognized, so whether it
 * can be worked is unknown". Collapsing them is how a refusal comes to say `Mission is in terminal
 * state 'Archived'` about a status the state machine has never heard of.
 */
export function transitionsFrom(currentStatus: string): MissionStatus[] | undefined {
  currentStatus = normalizeMissionStatus(currentStatus);
  return Object.prototype.hasOwnProperty.call(VALID_STATE_TRANSITIONS, currentStatus)
    ? (VALID_STATE_TRANSITIONS[currentStatus as MissionStatus] as MissionStatus[])
    : undefined;
}

/**
 * Valid session types matching rbook/docs/archive/session-management-guide.md.
 */
export const VALID_SESSION_TYPES = [
  'onboarding',
  'planning',
  'review',
  'research',
  'check-in',
  'custom',
] as const;

export type SessionType = (typeof VALID_SESSION_TYPES)[number];

/**
 * Valid context types.
 */
export const VALID_CONTEXT_TYPES = ['project_context', 'master_context'] as const;

export type ContextType = (typeof VALID_CONTEXT_TYPES)[number];

/**
 * Create a standardized error result.
 */
export function createError<T = unknown>(error: RbookToolError): RbookToolResult<T> {
  return {
    success: false,
    error,
  };
}

/**
 * Create a success result.
 */
export function createSuccess<T>(
  data: T,
  warnings?: string[],
  sanitizedFields?: SanitizedFieldReport[]
): RbookToolResult<T> {
  const result: RbookToolResult<T> = {
    success: true,
    data,
  };
  if (warnings && warnings.length > 0) {
    result.warnings = warnings;
  }
  if (sanitizedFields && sanitizedFields.length > 0) {
    result.sanitizedFields = sanitizedFields;
  }
  return result;
}

/**
 * Attach sanitizedFields to an already-constructed result, preserving the rest
 * of the shape. No-op when the sanitization surfaced nothing.
 *
 * Useful for wrapping existing handlers where restructuring createSuccess call
 * sites would be invasive — the handler computes its result, then calls this.
 */
export function withSanitizedFields<T>(
  result: RbookToolResult<T>,
  sanitizedFields: SanitizedFieldReport[] | undefined
): RbookToolResult<T> {
  if (!sanitizedFields || sanitizedFields.length === 0) {
    return result;
  }
  return { ...result, sanitizedFields };
}

/**
 * Error factory functions for common error patterns.
 */
export const RbookErrors = {
  dbNotFound(path: string, projectRoot: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DB_NOT_FOUND,
      message: `Reasonbook database not found at '${path}'`,
      // Keep the repair on the same project root that produced this refusal.
      suggestion: `Initialize the project with rbook_project(action="init", projectRoot=${JSON.stringify(projectRoot)}), or restore its rbook/db/rbook.sqlite file.`,
    };
  },

  dbConnectionFailed(path: string, reason: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
      message: `Failed to connect to database at '${path}': ${reason}`,
      suggestion: 'Check file permissions and ensure the database is not locked',
    };
  },

  missionNotFound(missionId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.MISSION_NOT_FOUND,
      message: `Mission '${missionId}' not found`,
      suggestion: 'Use rbook_mission(action="list") to see available missions',
    };
  },

  /**
   * s87-m01 — a status this map has never heard of gets its OWN refusal, not a guess.
   *
   * `missionInvalidTransition` below answers "you cannot go from A to B". That is a claim about a
   * state machine that knows A. When the stored status is not a key at all, the honest answer is a
   * different one, and it is the one `rbook-mission-move.ts` already gives.
   */
  missionUnrecognizedStatus(missionId: string, currentStatus: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
      message: `Mission '${missionId}' has unrecognized status '${currentStatus}', so whether it can still be worked is unknown — refusing to guess.`,
      currentState: currentStatus,
      validValues: Object.keys(VALID_STATE_TRANSITIONS),
      suggestion: `Set a recognized status first — rbook_mission(action="update", missionId="${missionId}", fields={"status":"Queued"}) — then retry. If that update also refuses, the row's status is outside VALID_MISSION_STATUSES entirely and needs a store-level repair; do not drop the mission to work around it, since Dropped is terminal.`,
    };
  },

  missionInvalidTransition(
    missionId: string,
    currentStatus: MissionStatus,
    targetStatus: MissionStatus
  ): RbookToolError {
    // s87-m01: TOTAL, not partial. `currentStatus` is typed `MissionStatus` and is not one —
    // it is read from the store. Before this guard the next line threw
    // `Cannot read properties of undefined (reading 'length')` for every caller, and the MCP
    // boundary turned that into "This is an internal error … retry the call": a loop with no exit.
    const validTransitions = transitionsFrom(currentStatus);
    if (validTransitions === undefined) {
      return RbookErrors.missionUnrecognizedStatus(missionId, currentStatus);
    }
    return {
      code: RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION,
      message: `Cannot transition mission '${missionId}' from '${currentStatus}' to '${targetStatus}'`,
      currentState: currentStatus,
      validTransitions,
      suggestion:
        validTransitions.length > 0
          ? `Valid transitions from '${currentStatus}': ${validTransitions.join(', ')}`
          : currentStatus === 'Completed'
            ? `Completed cannot change through ordinary status updates. To correct a mistaken completion in an open sprint, use rbook_mission_transition(action="reopen", missionId="${missionId}", reason="why the completion was mistaken"). Other fields remain editable.`
            : `'${currentStatus}' is a terminal status: no status transition out of it is permitted. Other fields can still be edited with rbook_mission(action="update").`,
    };
  },

  contextNotFound(contextType: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND,
      message: `Context '${contextType}' not found`,
      // s89-m08: this used to prescribe `rbook_context(action="view")` "to list available contexts".
      // The oracle executed that from the state this error is raised in and it returned the SAME
      // CONTEXT_NOT_FOUND — a remedy that reproduces the refusal. There is no listing action:
      // `view` reads ONE context and needs the very row that is missing. The recognized types are
      // already carried in `validValues`, so say what is true and prescribe nothing that loops.
      suggestion:
        'The recognized context types are listed in validValues. If the type is right, then this ' +
        'store has no row for it and the row must be recreated before it can be read.',
      validValues: VALID_CONTEXT_TYPES as unknown as string[],
    };
  },

  invalidParameter(field: string, providedValue: unknown, validValues?: string[]): RbookToolError {
    const error: RbookToolError = {
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `Invalid value for parameter '${field}'`,
      field,
      providedValue,
    };
    if (validValues) {
      error.validValues = validValues;
      error.suggestion = `Valid values: ${validValues.join(', ')}`;
    }
    return error;
  },

  invalidAction(
    tool: string,
    providedValue: unknown,
    availableActions: readonly string[]
  ): RbookToolError {
    const normalizedValue = typeof providedValue === 'string' ? providedValue.trim() : '';

    return {
      code: RBOOK_ERROR_CODES.INVALID_ACTION,
      message: normalizedValue
        ? `Action '${normalizedValue}' is not supported for ${tool}`
        : `Action is required for ${tool}`,
      suggestion: `Use one of the available actions: ${availableActions.join(', ')}`,
      field: 'action',
      providedValue,
      validValues: [...availableActions],
      availableActions: [...availableActions],
      available_actions: [...availableActions],
    };
  },

  missingParameter(field: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.MISSING_PARAMETER,
      message: `Required parameter '${field}' is missing`,
      field,
      suggestion: `Please provide a value for '${field}'`,
    };
  },

  sessionNotFound(sessionId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.SESSION_NOT_FOUND,
      message: `Session '${sessionId}' not found`,
      suggestion: 'Use rbook_session(action="list") to see available sessions',
    };
  },

  sessionNotActive(sessionId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.SESSION_NOT_ACTIVE,
      message: `Session '${sessionId}' is not active`,
      suggestion: 'Only active sessions can be captured to or completed',
    };
  },

  rbookNotDetected(searchPath: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED,
      message: `Reasonbook directory not found starting from '${searchPath}'`,
      suggestion: `Initialize it with rbook_project(action="init", projectRoot=${JSON.stringify(searchPath)}), or navigate to a Reasonbook-enabled project.`,
    };
  },

  senderUnresolvable(
    message: string,
    code: string = RBOOK_ERROR_CODES.SENDER_UNRESOLVABLE
  ): RbookToolError {
    return {
      code,
      message,
      suggestion:
        'Pass projectRoot explicitly, run from a directory with rbook/db/rbook.sqlite, or ensure the local Reasonbook DB has a UUID metadata.dashboard_project_id and canonical project_identity.rbook_address.',
    };
  },

  snapshotNotFound(snapshotId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.SNAPSHOT_NOT_FOUND,
      message: `Snapshot '${snapshotId}' not found`,
      suggestion: 'Use rbook_db(action="snapshot") to create a new snapshot',
    };
  },

  sprintNotFound(sprintId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.SPRINT_NOT_FOUND,
      message: `Sprint '${sprintId}' not found`,
      suggestion: 'Use rbook_sprint with action="list" to see available sprints',
    };
  },

  sprintIdExists(sprintId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.SPRINT_ID_EXISTS,
      message: `Sprint '${sprintId}' already exists`,
      suggestion:
        'Choose a different sprint ID or use rbook_sprint with action="update" to modify it',
    };
  },

  // s86-m05 — the `buildStale` factory was DELETED here, along with the BUILD_STALE code
  // constant above. It built the error the s70-m02 enforced gate returned at sprint close; the
  // s74 review retired that gate and build-freshness became advisory, leaving the factory with
  // no caller in the tree and no test enumerating its code. Its `suggestion` told operators to
  // "pass forceComplete:true to override" — a param the same package publishes as a no-op, so
  // the one string still reachable by a reader prescribed a remedy that does nothing.
  // `buildStaleAdvisory` in rbook-sprint-complete.ts is a DIFFERENT, LIVE function that produces
  // the advisory warning; it is not affected. Recorded for the 2.6.0 CHANGELOG's Removed
  // section: unreachable surface, not a working capability.

  dashboardUnreachable(url: string, reason: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_UNREACHABLE,
      message: `Dashboard unreachable at '${url}': ${reason}`,
      suggestion:
        'Ensure the cmos-dashboard is running and RBOOK_DASHBOARD_URL is correctly configured',
    };
  },

  dashboardAuthFailed(url: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_AUTH_FAILED,
      message: `Authentication failed for dashboard at '${url}'`,
      // s86-m06 — the old suggestion told EVERY dashboard auth failure to verify
      // RBOOK_DASHBOARD_USER / RBOOK_DASHBOARD_PASSWORD. Device code has been the
      // default bootstrap since s57, so for most installs that named credentials
      // they do not have and never mentioned the key that actually authenticated.
      // This wording covers the arms that exist without asserting which one fired
      // — all four call sites are inside the shared request paths, which do not
      // know how their credential was resolved.
      suggestion:
        'Check which credential is in play with rbook_auth(action="list"); if the key was revoked or expired, run rbook_auth(action="login_init") + login_complete for a fresh user-scoped key, or rbook_auth(action="reissue", projectRoot=…) for a project-scoped one. Legacy installs: verify RBOOK_DASHBOARD_API_KEY, or the RBOOK_DASHBOARD_USER + RBOOK_DASHBOARD_PASSWORD pair if you authenticate that way.',
    };
  },

  /**
   * s84-m02 — a 403 Forbidden: the caller authenticated but is not authorized for
   * this resource (e.g. respond/ack on a message where they are not the recipient,
   * or an owner-gated route hit by a non-owner member after the dashboard m04
   * cutover returns 403 not 404). Distinct from DASHBOARD_AUTH_FAILED (401 token
   * expiry) so the client does NOT clear its cached token on a forbidden.
   */
  dashboardForbidden(resource: string, detail?: string, hint?: string): RbookToolError {
    const message = detail
      ? `Dashboard 403 on ${resource}: ${detail}`
      : `Dashboard access forbidden: ${resource}`;
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_FORBIDDEN,
      message,
      suggestion:
        hint ??
        'You are authenticated but not authorized for this resource — verify you own or are the recipient of the target, or that the target id/address is correct.',
    };
  },

  dashboardNotFound(resource: string, detail?: string, hint?: string): RbookToolError {
    const message = detail
      ? `Dashboard 404 on ${resource}: ${detail}`
      : `Dashboard resource not found: ${resource}`;
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_NOT_FOUND,
      message,
      suggestion: hint ?? 'Verify the resource ID or address is correct',
    };
  },

  dashboardError(message: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_ERROR,
      message: `Dashboard error: ${message}`,
      suggestion: 'Check the dashboard logs for more details',
    };
  },

  dashboardNotConfigured(): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_NOT_CONFIGURED,
      message:
        'This feature requires a dashboard account. Sign up at https://reasonbook.ai/register to enable sync, messaging, and cross-project features.',
      suggestion:
        'Sign in with rbook_auth(action="login_init"), then login_complete; the dashboard URL defaults to https://reasonbook.ai. Local-only Reasonbook works without this.',
    };
  },

  dashboardUpgradeRequired(detail?: string): RbookToolError {
    const detailSuffix = detail ? `: ${detail}` : '';
    return {
      code: RBOOK_ERROR_CODES.DASHBOARD_UPGRADE_REQUIRED,
      message: `This feature requires a paid dashboard tier${detailSuffix}. Upgrade at https://reasonbook.ai/register to access it.`,
      suggestion:
        'Visit https://reasonbook.ai/register to view tier options and upgrade. Local-only Reasonbook features remain unaffected.',
    };
  },

  /**
   * s92-m01 — the refusal for a call that names no usable Reasonbook project. Resolution never routes
   * such a call to another project, so the answer has to say where the caller is and how to name
   * a project: create one here, pass one explicitly, or (only for a server with no project context)
   * configure a default. One site, three situations — see {@link NoProjectForCallDetails}.
   */
  noProjectForCall(details: NoProjectForCallDetails): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED,
      message: noProjectMessage(details),
      suggestion: noProjectSuggestion(details),
    };
  },

  /**
   * s92-m03 — a capture or complete named another running process's implicit session. That process
   * is still writing to it; it closes when that process ends, or after 12 idle hours.
   */
  sessionOwnedByAnotherProcess(sessionId: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `Session '${sessionId}' is the implicit session of another running process; this call did not change it.`,
      field: 'sessionId',
      providedValue: sessionId,
      suggestion:
        'Leave sessionId out to use your own session. That session closes by itself when its process ends, or after 12 idle hours.',
    };
  },

  /** s92-m08 — show named a decision or learning id that this project does not hold. */
  recordNotFound(kind: 'decision' | 'learning', id: number): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `No ${kind} #${id} in this project.`,
      field: kind === 'decision' ? 'decisionId' : 'learningId',
      providedValue: id,
      suggestion: `Search or list the ${kind}s to find its id; an id from another project is not valid here.`,
    };
  },

  /** s93-m11 — a since/until bound that is not a date or time stored times can be compared with. */
  invalidTimeBound(field: 'since' | 'until', value: string): RbookToolError {
    return {
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `${field} "${value}" is not a date or time Reasonbook can compare stored times with.`,
      field,
      providedValue: value,
      suggestion:
        'Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO date-time such as 2026-10-08T14:00:00Z. A year or a month covers the whole period.',
    };
  },
};

/**
 * s92-m01 — the three situations in which a call names no usable Reasonbook project.
 * - `not-a-project`: the caller is in a real working folder (`dir`) that is not a Reasonbook project.
 * - `inside-project`: an explicit projectRoot (`dir`) is not a project root but lies inside the
 *   project at `enclosingStore` — creating a project there would nest one inside another.
 * - `contextless`: the server's working directory (`dir`) carries no project context and no
 *   default applies; `unappliedDefault` names a pre-3.2.0 default that exists but is not applied.
 */
export interface NoProjectForCallDetails {
  readonly situation: 'not-a-project' | 'inside-project' | 'contextless';
  readonly dir: string;
  readonly mode: 'read' | 'write';
  readonly enclosingStore?: string;
  readonly unappliedDefault?: { readonly name: string; readonly storePath: string } | null;
}

function noProjectMessage(details: NoProjectForCallDetails): string {
  switch (details.situation) {
    case 'inside-project':
      return `'${details.dir}' is not a Reasonbook project root: it is inside the Reasonbook project at '${details.enclosingStore}'.`;
    case 'contextless': {
      const base =
        `No Reasonbook project for this call: the server's working directory '${details.dir}' carries ` +
        'no project context, no projectRoot was passed, and no default applies.';
      return details.unappliedDefault
        ? `${base} The registry default '${details.unappliedDefault.name}' was set before 3.2.0 and is not applied until it is re-confirmed.`
        : base;
    }
    case 'not-a-project':
      return `No Reasonbook project in '${details.dir}'. ${
        details.mode === 'write' ? 'Nothing was written.' : 'There is nothing to read here.'
      }`;
  }
}

function noProjectSuggestion(details: NoProjectForCallDetails): string {
  const init = `rbook_project(action="init", projectRoot=${JSON.stringify(details.dir)})`;
  switch (details.situation) {
    case 'inside-project':
      return `Pass projectRoot=${JSON.stringify(details.enclosingStore)}.`;
    case 'contextless': {
      const base =
        'Pass projectRoot set to a Reasonbook project, or add "--project-root", "<project dir>" to this ' +
        "server's args in its MCP config.";
      return details.unappliedDefault
        ? `${base} To apply the registry default, re-confirm it: rbook_project(action="register", projectRoot=${JSON.stringify(details.unappliedDefault.storePath)}, setAsDefault=true).`
        : `${base} A machine-wide default is the other option: register a project with setAsDefault set to true.`;
    }
    case 'not-a-project':
      return details.mode === 'write'
        ? `To keep a record for this folder, create a project: ${init}. To write to an existing project instead, pass its path as projectRoot.`
        : `Pass projectRoot set to an existing Reasonbook project to read it, or create one here with ${init}.`;
  }
}

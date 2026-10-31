// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Observes the MCP dispatch boundary once, including refusals and protocol exceptions.
// ABOUTME: Request-local project resolution prevents concurrent calls from mixing telemetry files.

import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';
import {
  appendTelemetry,
  targetForStore,
  unattributedTarget,
  type TelemetryTarget,
} from './local-telemetry';
import { currentSessionOwner } from './session-owner';
import { processBusyTimeout } from './sqlite-busy';
import { returnedIds, usedIds } from './telemetry-extract';

const scope = new AsyncLocalStorage<{ projectRoot?: string; presentedIds?: readonly string[] }>();

/** Additional typed local IDs in the actual v2 presentation, beside the legacy structured fields. */
export function noteTelemetryPresentedIds(ids: readonly string[]): void {
  const current = scope.getStore();
  if (current) current.presentedIds = ids;
}

/** Called only after the dispatcher resolves a project; this is not a second resolution pass. */
export function noteTelemetryProject(projectRoot: string): void {
  const current = scope.getStore();
  if (current) current.projectRoot = projectRoot;
}

interface Observation {
  readonly name: string;
  readonly args: unknown;
  readonly mode: 'read' | 'write';
  readonly client: string | null;
  /** s106-m01: the tool's published parameter names, the only names a refusal row may record. */
  readonly parameters?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

type McpResult = { isError?: boolean; structuredContent?: unknown };

/**
 * s106-m01 (design settled item 3): the parameter a refusal names, for close measure 11. A name the
 * tool publishes is kept. An unknown-parameter refusal names the agent's own key, so a supplied key
 * the tool does not publish is `unknown`. Anything else is `unspecified`: no field, a dotted schema
 * path, or a constant such as `arguments`. The agent's own text is never returned.
 */
function refusedFieldOf(
  error: unknown,
  params: Readonly<Record<string, unknown>>,
  parameters: readonly string[]
): string {
  const { code, field } = (error !== null && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    field?: unknown;
  };
  if (typeof field !== 'string') return 'unspecified';
  if (parameters.includes(field)) return field;
  return code === 'INVALID_PARAMETER' && Object.prototype.hasOwnProperty.call(params, field)
    ? 'unknown'
    : 'unspecified';
}

/** Never changes the tool's result or exception, including when observation itself fails. */
export async function withMcpTelemetry<T extends McpResult>(
  observation: Observation,
  operation: () => Promise<T>
): Promise<T> {
  const local: { projectRoot?: string; presentedIds?: readonly string[] } = {};
  const ts = new Date().toISOString();
  let result: T | undefined;
  let failed = false;
  let protocol = false;
  return scope.run(local, async () => {
    try {
      result = await operation();
      return result;
    } catch (error) {
      failed = true;
      protocol = error !== null && typeof error === 'object' && 'code' in error;
      throw error;
    } finally {
      try {
        const params =
          observation.args && typeof observation.args === 'object'
            ? (observation.args as Record<string, unknown>)
            : {};
        const env = observation.env ?? process.env;
        // Before-resolution refusals can still name a valid explicit store. Never infer cwd or
        // registry attribution here. Project-free calls get a separate, anonymous bucket.
        const root =
          local.projectRoot ??
          (params.acrossProjects !== true && typeof params.projectRoot === 'string'
            ? params.projectRoot
            : undefined);
        // s105-m03: as tolerant of a held store as the call it observes, which waits the store
        // client's own default budget (client.ts); a 100 ms lookup filed its row as unattributed.
        // s106-m01: the row carries the lookup's own time, so that wait is measured, not inferred.
        const dbPath = root ? resolveRecordPaths(root).dbPath : null;
        const started = performance.now();
        const found = dbPath ? targetForStore(dbPath, processBusyTimeout() ?? 5000) : null;
        const lookupMs = dbPath ? Math.round(performance.now() - started) : null;
        const target: TelemetryTarget = found ?? unattributedTarget(env);
        const payload = result?.structuredContent;
        const structured =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : undefined;
        const ok = !failed && result?.isError !== true && structured?.success !== false;
        const error = structured?.error as { code?: string } | undefined;
        // A Codex owner lookup reads the draft runtime with its own short budget. If that throws
        // (the runtime held), the row loses its session, not its place: before s105-m03 the whole
        // append was skipped and the row was lost from every bucket.
        let session: string | null = null;
        try {
          session = currentSessionOwner(target.dbPath).key;
        } catch {
          // The row is still recorded; only who made the call is unknown.
        }
        appendTelemetry(
          {
            ts,
            session,
            surface: 'mcp',
            client: observation.client,
            tool: observation.name,
            action: typeof params.action === 'string' ? params.action : null,
            mode: observation.mode,
            ok,
            refused: ok
              ? null
              : (error?.code ?? (protocol ? 'PROTOCOL_ERROR' : 'TOOL_EXECUTION_ERROR')),
            refusedField: ok
              ? null
              : refusedFieldOf(structured?.error, params, observation.parameters ?? []),
            lookupMs,
            failOpen: null,
            ambient: null,
            idsReturned: ok
              ? [
                  ...new Set([
                    ...returnedIds(observation.name, params, structured?.data),
                    ...(local.presentedIds ?? []),
                  ]),
                ]
              : [],
            idsCited: ok ? usedIds(observation.name, params, observation.mode, structured) : [],
          },
          target,
          env
        );
      } catch {
        // Best-effort instrumentation must never break an otherwise valid call.
      }
    }
  });
}

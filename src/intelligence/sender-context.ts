// ABOUTME: resolveSenderContext — the single audited boundary that answers
// ABOUTME: "which local project is this tool call about?" (Sprint 53; s92-m01 resolution safety).

/**
 * Sender Context Resolution (Sprint 53 m01; rewritten s92-m01)
 *
 * Every recurrence of cross-project mis-attribution has had the same shape: when the caller's
 * project was unclear, the server picked one anyway. Sprint 53 removed the `RBOOK_PROJECT_ROOT`
 * fallback; s92-m01 removes the rest — the registry-singleton auto-pick (the clean-room run wrote
 * a decision and a session from an uninitialised folder B into the only registered project A,
 * learning #387) and the fall-through from a rejected explicit root to the cwd project.
 *
 * THE RULE: never act on a project the caller did not name. The chain SELECTS one store by
 * detection, in priority order, and the selected store is final — when it fails the acceptance
 * bar, the call is refused; it never falls through to a different project.
 *
 *   1. Explicit `explicitProjectRoot` — always final. A folder with no Reasonbook store is refused.
 *   2. MCP client roots — the first advertised root inside a Reasonbook store (walked up like the cwd).
 *   3. cwd walk-up — the nearest enclosing directory holding a Reasonbook store, `rbook/db/` (see
 *      `findEnclosingStore`), including when the cwd is the server's own install root.
 *   4. Defaults, for a CONTEXTLESS call only (no explicit root, no MCP roots, no store on the
 *      walk-up, and a cwd of `/`, `$HOME` or the install root): the server's `--project-root`,
 *      then a registry default an operator CONFIRMED with `setAsDefault`. A default written before
 *      3.2.0 is never applied until re-confirmed.
 *   5. Otherwise throw `SenderResolutionError` with the full candidate trace.
 *
 * The `RBOOK_PROJECT_ROOT` env var is NOT consulted here — it is retained only as a
 * bootstrap hint at `src/index.ts` so the server can locate its own `.env`.
 *
 * @module intelligence/sender-context
 */

import path from 'path';
import { currentCodexRequest } from '../codex-request-context';

import {
  backfillUnknownRbookAddress,
  getProjectIdentity,
  previewUnknownRbookAddressHeal,
  readProjectIdentity,
} from '../tools/rbook/project-identity';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import { withClientAsync } from '../tools/rbook/client';
import { asLazyRepair, callMayWrite } from '../tools/rbook/tool-call-context';
import { RbookDetector } from './rbook-detector';
import { ProjectGraphRegistry } from './project-graph-registry';
import { isProjectAddress, resolveRegisteredAddress } from './project-address';
import {
  SERVER_INSTALL_ROOT,
  findEnclosingStore,
  getServerProjectRoot,
  isContextlessDirectory,
} from './resolution-policy';

/**
 * The directory where the compiled server binary lives (one level above `dist/intelligence`).
 * Defined in `resolution-policy.ts` and re-exported here for existing importers. Since s92-m01 it
 * is no longer a guard: a cwd equal to it resolves by cwd when it holds a store (this repository
 * resolves to itself), and counts as contextless when it does not (an npm install directory).
 */
export { SERVER_INSTALL_ROOT };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Candidate source labels, ordered highest-to-lowest priority. */
export type SenderResolutionSource =
  | 'explicit'
  | 'client-cwd'
  | 'mcp-roots'
  | 'cwd'
  | 'server-project-root'
  | 'registry-default';

/**
 * How a project was chosen for a tool call, as reported on every success payload (s92-m01).
 * `none` means the call touched no single project store (a portfolio, registry or
 * dashboard-only action).
 */
export type ResolvedBy = SenderResolutionSource | 'none';

/**
 * One step in the priority chain. Every attempted source is recorded, whether
 * accepted or rejected, so `SenderResolutionError.candidates` gives operators a
 * complete audit trail (echoed by `rbook_message(action='whoami')` in m03).
 */
export interface ResolutionCandidate {
  readonly source: SenderResolutionSource;
  readonly projectRoot?: string;
  readonly accepted: boolean;
  readonly rejectReason?: string;
}

/**
 * Output of `validateProject` — the fact-gathering layer used by the resolver.
 *
 * `hasValidSenderIdentity` encodes the fail-closed rule: a project is only a
 * valid implicit sender when it owns a UUID `dashboard_project_id` AND a non-stale
 * canonical `rbook_address` (neither empty nor `rbook://unknown/*`). A one-shot
 * heal via `backfillUnknownRbookAddress` is attempted before rejection.
 */
export interface ValidateProjectResult {
  readonly hasDatabase: boolean;
  readonly dashboardProjectId: string | null;
  readonly rbookAddress: string | null;
  readonly healed?: AddressHeal;
  readonly hasValidSenderIdentity: boolean;
  readonly rejectReason?: string;
}

/**
 * A rbook://unknown/* address repaired for this resolution. s93-m11: `preview` marks one computed
 * without writing (heal: 'preview'): the address the next write will store, which a diagnostic
 * resolves with so that it predicts what that write does.
 */
export interface AddressHeal {
  readonly previous: string;
  readonly next: string;
  readonly preview?: true;
}

/** Resolved sender identity plus the full audit trail. */
export interface SenderContext {
  readonly projectRoot: string;
  readonly requestedAddress?: string;
  readonly source: SenderResolutionSource;
  readonly dashboardProjectId: string | null;
  readonly rbookAddress: string | null;
  readonly healed?: AddressHeal;
  readonly candidates: ReadonlyArray<ResolutionCandidate>;
}

/**
 * Options for `resolveSenderContext`.
 *
 * The `*Override` fields exist for tests; production callers only need
 * `explicitProjectRoot`, `mcpRoots`, and `requireSenderIdentity`.
 */
export interface ResolveSenderContextOptions {
  /** Caller-supplied project root (step 1). */
  readonly explicitProjectRoot?: string;
  /** MCP client roots from `server.listRoots()` (step 2). Paths, not `file://` URIs. */
  readonly mcpRoots?: readonly string[];
  /**
   * Whether the caller needs a validated sender identity (UUID + canonical address)
   * to proceed. Defaults to `true` — the safe choice for any tool that mutates
   * dashboard state. Set `false` only for read-only local-DB ops that just need
   * a project root.
   */
  readonly requireSenderIdentity?: boolean;
  readonly cwdOverride?: string;
  readonly registryOverride?: ProjectGraphRegistry;
  readonly serverInstallRootOverride?: string;
  /** Test seam for `$HOME` (the walk-up ceiling and the contextless test). */
  readonly homeDirOverride?: string;
  /**
   * Test seam for the server's `--project-root`. `null` means "started without one"; omitted
   * reads the value `src/index.ts` recorded at startup.
   */
  readonly serverProjectRootOverride?: string | null;
  /**
   * s93-m11 — whether the selected store's rbook://unknown/* address may be repaired. Omitted:
   * only when the call may write (a read-classified call never writes the record, decision
   * #1182). `'preview'` resolves with the address the next write would store and writes nothing:
   * a diagnostic (whoami, the startup lines) predicts what a write-classified call would do.
   */
  readonly heal?: boolean | 'preview';
}

/**
 * Why resolution refused (s92-m01), so the dispatcher can name the right remedy:
 * - `selected-store-rejected`: a store was selected (explicit root, MCP root, cwd walk-up or a
 *   default) and failed the acceptance bar — no Reasonbook database, unreadable, or no valid sender
 *   identity. The call names that store and never falls through to another.
 * - `no-project-here`: the caller is in a real working folder that is not a Reasonbook project.
 * - `contextless-no-default`: the server has no project context and no default applies.
 */
export type SenderResolutionOutcome =
  | 'selected-store-rejected'
  | 'no-project-here'
  | 'contextless-no-default';

/** A registry default that exists but is not applied (written before 3.2.0, never confirmed). */
export interface UnappliedRegistryDefault {
  readonly projectId: string;
  readonly name: string;
  readonly storePath: string;
}

/**
 * Thrown when no candidate in the priority chain produced a project that satisfied
 * the caller's acceptance bar. Carries the full candidate trace for operator
 * debugging — exposed via `rbook_message(action='whoami')`.
 */
export class SenderResolutionError extends Error {
  readonly code: string;
  readonly candidates: ReadonlyArray<ResolutionCandidate>;
  /** s92-m01: why resolution refused; drives the refusal's remedy. */
  readonly outcome: SenderResolutionOutcome;
  /** s92-m01: the folder the refusal names — the caller's working folder or the selected store. */
  readonly workingDir: string | null;
  /** s92-m01: a registry default that exists but was not applied, when one is relevant. */
  readonly unappliedDefault: UnappliedRegistryDefault | null;

  constructor(
    message: string,
    candidates: ReadonlyArray<ResolutionCandidate>,
    code = 'SENDER_UNRESOLVABLE',
    details: {
      outcome?: SenderResolutionOutcome;
      workingDir?: string | null;
      unappliedDefault?: UnappliedRegistryDefault | null;
    } = {}
  ) {
    super(message);
    this.name = 'SenderResolutionError';
    this.code = code;
    this.candidates = candidates;
    this.outcome = details.outcome ?? 'selected-store-rejected';
    this.workingDir = details.workingDir ?? null;
    this.unappliedDefault = details.unappliedDefault ?? null;
  }
}

/**
 * Read the sender-identity facts for a given project root.
 *
 * Opens the Reasonbook SQLite for `projectRoot` (via `withClientAsync({ projectRoot })`,
 * which bypasses the env-based fallback because the projectRoot is explicit),
 * reads `metadata.dashboard_project_id` and `project_identity.rbook_address`, and
 * attempts a one-shot heal when the address is `rbook://unknown/*` and an owner
 * exists in metadata.
 *
 * Returns the gathered facts plus `hasValidSenderIdentity`, the resolver-facing
 * acceptance verdict.
 */
export async function validateProject(
  projectRoot: string,
  options: { heal?: boolean | 'preview' } = {}
): Promise<ValidateProjectResult> {
  // s93-m11: the repair is a write, so a read-classified call (or the review role) never runs it.
  const heal = options.heal ?? callMayWrite();
  const resolved = path.resolve(projectRoot);

  const detector = RbookDetector.getInstance();
  const detection = await detector.detect(resolved, { forceRefresh: true });
  if (!detection.hasDatabase || !detection.databasePath) {
    return {
      hasDatabase: false,
      dashboardProjectId: null,
      rbookAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: 'no Reasonbook database at projectRoot',
    };
  }

  try {
    const result = await withClientAsync(
      async (db: RbookDatabaseClient) => {
        const pidRow = db.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'dashboard_project_id'"
        );
        const rawProjectId = pidRow.success && pidRow.data?.value ? pidRow.data.value.trim() : '';
        const dashboardProjectId = rawProjectId.length > 0 ? rawProjectId : null;

        // s93-m11: only a call that may heal may seed a missing identity row; a read, a preview and
        // an explicit heal:false derive it in memory and write nothing, even outside a dispatched
        // call (whoami from the CLI, the startup lines).
        // s110-m01 (critic round 3, W1): a preview predicts what a send will store, so its address is
        // checked against the other registered projects as the send's write checks it.
        let identity =
          heal === true
            ? getProjectIdentity(db)
            : readProjectIdentity(db, { checkTaken: heal === 'preview' });
        let rbookAddress = identity?.rbook_address?.trim() ?? '';
        const initialStale = !rbookAddress || rbookAddress.startsWith('rbook://unknown/');

        let healed: AddressHeal | undefined;
        // s110-m01: when the address a heal would build breaks the address rule, nothing is healed,
        // and the rejection says why.
        let healRefused: string | undefined;
        if (initialStale && heal === 'preview') {
          const preview = previewUnknownRbookAddressHeal(db);
          healRefused = preview.refused;
          if (preview.next) {
            healed = { previous: preview.previous ?? '', next: preview.next, preview: true };
            rbookAddress = preview.next;
          }
        } else if (initialStale && heal) {
          // A lazy repair, not the caller's write: it never starts first-write upkeep.
          const outcome = asLazyRepair(() => backfillUnknownRbookAddress(db));
          healRefused = outcome.refused;
          if (outcome.rewritten && outcome.next && outcome.next !== outcome.previous) {
            healed = {
              previous: outcome.previous ?? '',
              next: outcome.next,
            };
            identity = getProjectIdentity(db);
            rbookAddress = identity?.rbook_address?.trim() ?? '';
          }
        }

        const hasCanonicalAddress =
          rbookAddress.length > 0 && !rbookAddress.startsWith('rbook://unknown/');
        const hasValidUuid = dashboardProjectId !== null && UUID_REGEX.test(dashboardProjectId);
        const hasValidSenderIdentity = hasValidUuid && hasCanonicalAddress;

        let rejectReason: string | undefined;
        if (!hasValidUuid) {
          rejectReason = 'dashboard_project_id missing or not a UUID';
        } else if (!hasCanonicalAddress) {
          rejectReason = healRefused
            ? `project_identity.rbook_address is empty or rbook://unknown/*. ${healRefused}`
            : 'project_identity.rbook_address is empty or rbook://unknown/*';
        }

        const payload: ValidateProjectResult = {
          hasDatabase: true,
          dashboardProjectId,
          rbookAddress: hasCanonicalAddress ? rbookAddress : null,
          healed,
          hasValidSenderIdentity,
          rejectReason,
        };
        return { success: true, data: payload };
      },
      // Candidate validation is observation, even when the enclosing tool call is a write.
      // Without this override, a write request with several rejected MCP roots would mint an
      // identity into every candidate before the resolver selected one.
      { projectRoot: resolved, registerProject: false }
    );

    if (result.success && result.data) {
      return result.data;
    }
    return {
      hasDatabase: true,
      dashboardProjectId: null,
      rbookAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: 'failed to open Reasonbook database',
    };
  } catch (err) {
    return {
      hasDatabase: true,
      dashboardProjectId: null,
      rbookAddress: null,
      hasValidSenderIdentity: false,
      rejectReason: `DB read error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

/**
 * Resolve the sender context for an outbound tool call.
 *
 * Walks the priority chain described in the module header. Every attempted
 * candidate is recorded in the returned `candidates` array (or in the thrown
 * `SenderResolutionError.candidates` when resolution fails), so operators can
 * see exactly what the server tried and why each option was rejected.
 *
 * @throws SenderResolutionError when no candidate is acceptable.
 */
export async function resolveSenderContext(
  opts: ResolveSenderContextOptions = {}
): Promise<SenderContext> {
  const candidates: ResolutionCandidate[] = [];
  const requireSenderIdentity = opts.requireSenderIdentity ?? true;
  const installRoot = path.resolve(opts.serverInstallRootOverride ?? SERVER_INSTALL_ROOT);
  const homeDir = opts.homeDirOverride;

  const isAcceptable = (v: ValidateProjectResult): boolean =>
    requireSenderIdentity ? v.hasValidSenderIdentity : v.hasDatabase;

  const accept = (
    source: SenderResolutionSource,
    projectRoot: string,
    v: ValidateProjectResult
  ): SenderContext => {
    candidates.push({ source, projectRoot, accepted: true });
    return {
      projectRoot,
      source,
      dashboardProjectId: v.dashboardProjectId,
      rbookAddress: v.rbookAddress,
      healed: v.healed,
      candidates,
    };
  };

  /**
   * The selected store is final: accept it, or refuse naming it. Never fall through — a rejected
   * selection that continued down the chain is how `projectRoot=/B` from cwd A used to write A.
   */
  const settle = async (
    source: SenderResolutionSource,
    projectRoot: string
  ): Promise<SenderContext> => {
    const validation = await validateProject(
      projectRoot,
      opts.heal === undefined ? {} : { heal: opts.heal }
    );
    if (isAcceptable(validation)) return accept(source, projectRoot, validation);
    candidates.push({
      source,
      projectRoot,
      accepted: false,
      rejectReason: validation.rejectReason ?? `${source} project not acceptable`,
    });
    throw new SenderResolutionError(
      `The ${describeSource(source)} '${projectRoot}' was selected for this call and cannot be ` +
        `used: ${validation.rejectReason ?? 'not acceptable'}. Resolution does not fall back to ` +
        'another project.',
      candidates,
      undefined,
      { outcome: 'selected-store-rejected', workingDir: projectRoot }
    );
  };

  // ─── Step 1: explicit — always final ───────────────────────────────────
  if (opts.explicitProjectRoot) {
    if (isProjectAddress(opts.explicitProjectRoot)) {
      let selected: ReturnType<typeof resolveRegisteredAddress>;
      try {
        const registry = opts.registryOverride ?? (await ProjectGraphRegistry.create());
        selected = resolveRegisteredAddress(opts.explicitProjectRoot, registry);
      } catch (error) {
        selected = {
          error: `Registered project scan failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if ('error' in selected) {
        throw new SenderResolutionError(selected.error, candidates, 'PROJECT_ADDRESS_UNRESOLVABLE');
      }
      return {
        ...(await settle('explicit', selected.projectRoot)),
        requestedAddress: opts.explicitProjectRoot,
      };
    }
    return settle('explicit', path.resolve(opts.explicitProjectRoot));
  }

  // A Codex call names its own folder, independently of the plugin server's launch directory.
  // A missing/changed opaque field refuses rather than silently routing to the server's store.
  const codex = currentCodexRequest();
  if (codex) {
    if (codex.error || !codex.cwd) {
      throw new SenderResolutionError(
        `${codex.error ?? 'Codex did not provide a working folder.'} Pass projectRoot explicitly.`,
        [{ source: 'client-cwd', accepted: false, rejectReason: codex.error }],
        'CODEX_CONTEXT_REQUIRED'
      );
    }
    const enclosing = findEnclosingStore(codex.cwd, { homeDir });
    if (enclosing) return settle('client-cwd', enclosing.root);
    candidates.push({
      source: 'client-cwd',
      projectRoot: codex.cwd,
      accepted: false,
      rejectReason: 'no Reasonbook database at projectRoot',
    });
    if (!isContextlessDirectory(codex.cwd, { homeDir, installRoot })) {
      throw new SenderResolutionError(
        `No Reasonbook project in the client's working folder '${codex.cwd}'. Pass projectRoot explicitly.`,
        candidates,
        undefined,
        { outcome: 'no-project-here', workingDir: codex.cwd }
      );
    }
  }

  // ─── Step 2: MCP client roots — the first root inside a store ──────────
  // Each advertised root is walked up exactly like the cwd (a workspace opened on a subfolder of
  // a project is that project), and a store whose database is gone is still selected and refused
  // by name rather than skipped.
  const mcpRoots = (opts.mcpRoots ?? []).map((root) => path.resolve(root));
  for (const root of mcpRoots) {
    const enclosing = findEnclosingStore(root, { homeDir });
    if (enclosing) return settle('mcp-roots', enclosing.root);
    candidates.push({
      source: 'mcp-roots',
      projectRoot: root,
      accepted: false,
      rejectReason: 'no Reasonbook database at projectRoot',
    });
  }

  // ─── Step 3: cwd walk-up — the nearest enclosing store ─────────────────
  const cwd = path.resolve(codex?.cwd ?? opts.cwdOverride ?? process.cwd());
  const enclosing = findEnclosingStore(cwd, { homeDir });
  if (enclosing) return settle('cwd', enclosing.root);
  candidates.push({
    source: 'cwd',
    projectRoot: cwd,
    accepted: false,
    rejectReason: 'no Reasonbook database at projectRoot',
  });

  // ─── Step 4: defaults — contextless calls only ─────────────────────────
  const contextless =
    mcpRoots.length === 0 && isContextlessDirectory(cwd, { homeDir, installRoot });
  if (!contextless) {
    // A real working folder that is not a Reasonbook project. Name the folder the client advertised
    // when it advertised one; otherwise the server's cwd.
    throw new SenderResolutionError(
      `No Reasonbook project in '${mcpRoots[0] ?? cwd}'. No projectRoot was passed and no enclosing ` +
        'folder holds rbook/db/rbook.sqlite.',
      candidates,
      undefined,
      { outcome: 'no-project-here', workingDir: mcpRoots[0] ?? cwd }
    );
  }

  const serverProjectRoot =
    opts.serverProjectRootOverride === undefined
      ? getServerProjectRoot()
      : (opts.serverProjectRootOverride ?? undefined);
  if (serverProjectRoot) {
    return settle('server-project-root', path.resolve(serverProjectRoot));
  }

  let unappliedDefault: UnappliedRegistryDefault | null = null;
  try {
    const registry = opts.registryOverride ?? (await ProjectGraphRegistry.create());
    const status = registry.getDefaultStatus();
    if (status.entry && status.applied) {
      return settle('registry-default', path.resolve(status.entry.store_path));
    }
    if (status.entry) {
      unappliedDefault = {
        projectId: status.entry.project_id,
        name: status.entry.name,
        storePath: status.entry.store_path,
      };
    }
    candidates.push({
      source: 'registry-default',
      projectRoot: status.entry?.store_path,
      accepted: false,
      rejectReason: status.entry
        ? `registry default '${status.entry.name}' is not applied: it was set before 3.2.0 and never re-confirmed with setAsDefault`
        : 'no registry default is set',
    });
  } catch (err) {
    if (err instanceof SenderResolutionError) throw err;
    candidates.push({
      source: 'registry-default',
      accepted: false,
      rejectReason: `registry error: ${err instanceof Error ? err.message : 'unknown'}`,
    });
  }

  // ─── Step 5: fail closed ────────────────────────────────────────────────
  throw new SenderResolutionError(
    `No Reasonbook project for this call: the server's working directory '${cwd}' carries no project ` +
      'context, no projectRoot was passed, and no default applies.',
    candidates,
    undefined,
    { outcome: 'contextless-no-default', workingDir: cwd, unappliedDefault }
  );
}

/** Human wording for a candidate source, used in refusals. */
export function describeSource(source: SenderResolutionSource): string {
  switch (source) {
    case 'explicit':
      return 'projectRoot you passed';
    case 'client-cwd':
      return "project enclosing the client's working folder";
    case 'mcp-roots':
      return 'MCP root';
    case 'cwd':
      return 'project enclosing the working directory';
    case 'server-project-root':
      return "--project-root in this server's config";
    case 'registry-default':
      return 'registry default project';
  }
}

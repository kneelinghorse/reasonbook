// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s80-m01 — the graph-native project-root resolver, relocated out of the
// ABOUTME: doomed JSON project-registry.ts. Reads/writes ONLY ProjectGraphRegistry.

/**
 * Project-root resolution (s80-m01).
 *
 * `resolveProjectRootEnhanced` is the 4-step priority chain the tool clients fall
 * back to when no explicit `projectRoot`/`dbPath` is supplied. It was carved out of
 * `intelligence/project-registry.ts` in Sprint 80 so the resolver reads/writes ONLY
 * the authoritative {@link ProjectGraphRegistry} — the JSON `ProjectRegistry` and
 * its derivation layer are deleted in s80-m02. That relocation also dissolves the
 * former module cycle (the resolver used to lazy-`import()` the graph registry to
 * avoid `project-registry.ts` ↔ `project-graph-registry.ts` recursion); a static
 * import is safe now that the resolver no longer lives in `project-registry.ts`.
 *
 * @module intelligence/project-resolution
 */

import path from 'path';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { currentToolCallActionMode } from '../tools/rbook/tool-call-context';
import { RbookDetector } from './rbook-detector';
import { ProjectGraphRegistry } from './project-graph-registry';
import {
  findEnclosingStore,
  getServerProjectRoot,
  isContextlessDirectory,
} from './resolution-policy';

/**
 * Authoritative registration half of the resolve/register split.
 *
 * Kept beside the graph-backed resolver so tool clients do not import portfolio fan-out
 * machinery directly. Callers must establish that the target contains a Reasonbook database before
 * invoking this write primitive.
 */
export async function registerResolvedProjectStore(
  projectRoot: string,
  options: {
    name?: string;
    setAsDefault?: boolean;
    requireStoredIdentity?: boolean;
    confirmedCopy?: boolean;
  } = {}
) {
  const graph = await ProjectGraphRegistry.create();
  return graph.registerStore(projectRoot, options);
}

/**
 * Result of project root resolution
 */
export interface ProjectResolutionResult {
  /** Resolved project root path */
  projectRoot: string;

  /** How the project root was resolved */
  source: 'explicit' | 'env' | 'auto-discover' | 'registry' | 'cwd' | 'server-project-root';

  /** Whether a new project was auto-registered */
  autoRegistered?: boolean;

  /** Human-readable explanation */
  message: string;
}

/**
 * Error thrown when project resolution fails
 */
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

/**
 * Resolve project root with a 4-step priority chain.
 *
 * Priority (s92-m01 — the same rules as `resolveSenderContext`, minus MCP roots, which only the
 * dispatcher can see):
 * 1. Explicit parameter
 * 2. cwd walk-up — the nearest enclosing directory holding a Reasonbook store (`rbook/db/`)
 * 3. Defaults, only when the cwd is contextless (`/`, `$HOME`, the install root): the server's
 *    `--project-root`, then a registry default an operator confirmed with `setAsDefault`
 * 4. Error with actionable guidance
 *
 * @deprecated Use `resolveSenderContext` from `src/intelligence/sender-context.ts`
 *   for any dispatcher or dashboard-bound call site. This function remains
 *   available for direct `RbookDatabaseClient.create` fallbacks and for tests,
 *   but should not be called from tool dispatchers. Sprint 53 m02 removed the
 *   former Step 2 (`RBOOK_PROJECT_ROOT` env var) because it was the structural
 *   source of cross-project mis-attribution (Sprint 32 / 52 / 53 P0s).
 *
 * @param explicitRoot - Explicitly provided project root
 * @param options - Resolution options
 * @returns Resolution result with source and path
 * @throws ProjectResolutionError if no project can be resolved
 */
export async function resolveProjectRootEnhanced(
  explicitRoot?: string,
  options: { autoRegister?: boolean; silent?: boolean } = {}
): Promise<ProjectResolutionResult> {
  const { autoRegister = true, silent = false } = options;
  const registrationAllowed =
    autoRegister && currentToolCallActionMode() !== 'read' && !isReadOnlyAgentSession();

  // Step 1: Explicit parameter
  if (explicitRoot) {
    const resolvedPath = path.resolve(explicitRoot);
    return {
      projectRoot: resolvedPath,
      source: 'explicit',
      message: `Using explicitly provided project root: ${resolvedPath}`,
    };
  }

  // Step 2 (removed): RBOOK_PROJECT_ROOT env-var fallback. See Sprint 53 m02
  // rationale in the function docblock. The env var is still read at
  // `src/index.ts:17` for .env bootstrap but is never consulted here.

  // Step 3: Auto-discover from cwd — s92-m01: the nearest enclosing store (`rbook/db/`), not just
  // cwd itself. A store whose database file is gone still ends the walk; the caller's client
  // detection then refuses with DB_NOT_FOUND for that root rather than this resolver routing
  // elsewhere.
  const cwd = process.cwd();
  const detector = RbookDetector.getInstance();
  const enclosing = findEnclosingStore(cwd);

  if (enclosing) {
    const storeRoot = enclosing.root;
    const result: ProjectResolutionResult = {
      projectRoot: storeRoot,
      source: 'auto-discover',
      message: `Auto-discovered Reasonbook project at: ${storeRoot}`,
    };
    if (!enclosing.hasDatabase) return result;

    // Auto-register if enabled AND this is not a read/review call. s88-m08: discovery may add/touch
    // a store that ALREADY records an identity, but it must never mint one. Identity minting
    // belongs to the write-registration path in RbookDatabaseClient / rbook_project(register),
    // before a handler transaction exists. `touchOrRegisterFromStore` returns null for an
    // identity-less store, leaving the selected store/row unchanged. (s80-m02: the graph is the
    // single discovery source; no JSON mirror remains.)
    if (registrationAllowed) {
      try {
        const graph = await ProjectGraphRegistry.create();
        const existingId = graph.getByStorePath(storeRoot);
        if (!existingId) {
          const registered = graph.touchOrRegisterFromStore(storeRoot);
          if (registered) {
            result.autoRegistered = true;
            if (!silent) {
              console.error(`[Reasonbook] Auto-registered project: ${storeRoot}`);
            }
          }
        } else {
          graph.touch(existingId);
        }
      } catch {
        // Ignore registry errors during auto-discovery
      }
    }

    return result;
  }

  // Step 3: Defaults — s92-m01: ONLY for a contextless cwd. A store-less working folder is a real
  // folder that is not a Reasonbook project; defaulting it to another project is the defect m01 removes.
  if (isContextlessDirectory(cwd)) {
    const serverProjectRoot = getServerProjectRoot();
    if (serverProjectRoot) {
      return {
        projectRoot: serverProjectRoot,
        source: 'server-project-root',
        message: `Using --project-root from this server's config: ${serverProjectRoot}`,
      };
    }
    try {
      const graph = await ProjectGraphRegistry.create();
      const { entry: defaultProject, applied } = graph.getDefaultStatus();

      if (defaultProject && applied) {
        // Verify the default project still has Reasonbook
        const defaultDetection = await detector.detect(defaultProject.store_path, {
          forceRefresh: true,
        });
        if (defaultDetection.hasRbookDirectory && defaultDetection.hasDatabase) {
          // Read/review calls may open/ensure the graph schema to resolve the default, but never
          // touch or register a project row. A write/direct caller may refresh last_seen_at.
          if (registrationAllowed) graph.touch(defaultProject.project_id);
          return {
            projectRoot: defaultProject.store_path,
            source: 'registry',
            message: `Using default project from registry: ${defaultProject.name ?? defaultProject.store_path}`,
          };
        }
      }
    } catch {
      // Ignore registry errors
    }
  }

  // Step 4: Error with actionable guidance. A default only ever applies to a contextless cwd, so
  // only that case is offered one; from a real working folder the remedies are init or a path.
  const defaultOptions = isContextlessDirectory(cwd)
    ? `
  4. Start the server with --project-root <dir> in its MCP config, or confirm a default: rbook_project(action="register", projectRoot="<path>", setAsDefault=true)`
    : '';
  throw new ProjectResolutionError(
    `No Reasonbook project in '${cwd}'. Could not resolve project root.`,
    `Options:
  1. Create a project here: rbook_project(action="init", projectRoot=${JSON.stringify(cwd)})
  2. Run from a directory containing rbook/db/rbook.sqlite
  3. Provide projectRoot parameter explicitly${defaultOptions}`
  );
}

/**
 * Backward-compatible wrapper that returns just the path
 *
 * For existing code that expects a string return type.
 *
 * @param explicitRoot - Explicitly provided project root
 * @returns Resolved project root path
 * @throws ProjectResolutionError if no project can be resolved
 */
export async function resolveProjectRootPath(explicitRoot?: string): Promise<string> {
  const result = await resolveProjectRootEnhanced(explicitRoot);
  return result.projectRoot;
}

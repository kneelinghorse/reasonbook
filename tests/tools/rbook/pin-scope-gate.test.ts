// ABOUTME: s80-m04 pin-scope gate — every pin-only read stays scoped to the sender.
// ABOUTME: Only ratified portfolio readers fan out; upload state stays keyed to its caller's project.

/**
 * Sprint 80 m04 — pin-scope convergence gate.
 *
 * s79's fan-out deletion left every local read dispatch-pinned to its sender (index.ts
 * runs `resolveToolSenderContext` per case; a neutral multi-project dir fails CLOSED via
 * `SenderResolutionError`). This gate LOCKS that: no `src/tools/rbook` handler may import
 * the cross-store machinery (`queryAcrossStores` / the named `cross-store-queries` /
 * `ProjectGraphRegistry`) — which is how a read would fan out across projects — EXCEPT
 * the explicitly ratified portfolio surfaces:
 *
 *   Ratified `acrossProjects` reads (the 3 named §5.4 queries plus s93-m08 feedback):
 *     - rbook-decisions-list.ts   (rbook_decisions list, acrossProjects)
 *     - rbook-learnings-list.ts   (rbook_learnings list, acrossProjects)
 *     - rbook-mission-status.ts   (rbook_mission status, acrossProjects)
 *     - feedback-fleet.ts        (rbook_feedback list, acrossProjects; digest count)
 *   Ratified always-on portfolio digests:
 *     - rbook-review.ts           (≤4KB portfolio section, s79-m06 / decision #672)
 *     - rbook-agent-onboard.ts    (portfolio rollup; write-classified, not a pin-only read)
 *     - portfolio-signals.ts      (the signals fan-out the review and `reasonbook signals` share,
 *                                  s97-m01, ratified with sprint 100's design, #1546)
 *   Portfolio-by-design registry management (NOT pin-only reads — they ARE the registry):
 *     - rbook-project-list.ts / -register / -unregister / -init / -validate / -sweep
 *   Single-project upload state (registry only; cross-store query imports remain forbidden):
 *     - dashboard-upload.ts / dashboard-upload-scheduler.ts
 *
 * Any OTHER handler importing the machinery is an offender: a pin-only read (session
 * list/search, sprint list/show, mission list/show, decisions/learnings search, context
 * view/history/search, db health) must never fan out. Feedback's default list stays local;
 * its explicit acrossProjects arm and bounded digest count use the ratified fleet helper.
 *
 * @module tests/tools/rbook/pin-scope-gate
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { readDashboardUploadStatus } from '../../../src/tools/rbook/dashboard-upload-scheduler';

const HANDLER_DIR = path.resolve(__dirname, '../../../src/tools/rbook');

/** Handler files ALLOWED to import the cross-store machinery (repo-relative basename). */
const ALLOWLIST = new Set<string>([
  // Ratified acrossProjects reads (the 3 named §5.4 queries plus s93-m08 feedback).
  'rbook-decisions-list.ts',
  'rbook-learnings-list.ts',
  'rbook-mission-status.ts',
  'feedback-fleet.ts',
  // Ratified always-on portfolio digests.
  'rbook-review.ts',
  'rbook-agent-onboard.ts',
  // s97-m01: the signals fan-out the review's portfolio and `reasonbook signals` share (#1546).
  'portfolio-signals.ts',
  // Portfolio-by-design registry management (they manage the graph registry itself).
  'rbook-project-list.ts',
  'rbook-project-register.ts',
  'rbook-project-unregister.ts',
  'rbook-project-init.ts',
  'rbook-project-validate.ts',
  'rbook-project-sweep.ts',
  // s88-m08: restore is an explicit destructive, single-project WRITE. After replacing the
  // pinned store, it reconciles that store's identity with its one graph row or rolls both
  // back. It never reads/fans out across portfolio stores.
  'rbook-db-restore.ts',
  // s92-m01: whoami diagnoses RESOLUTION, and resolution's last step is the registry default.
  // It reads that one registry_meta key (plus its row) to say whether a contextless call could
  // use it — "registry default: X — not applied". It opens no other project's store and never
  // fans out.
  'rbook-message.ts',
]);

// s94-m10: the old checkpoint registry write moved into these helpers. Both verify the written
// store's own id/path; status maps the requested root to one registry row and opens no sibling DB.
// Permit only the registry import, never the cross-store query machinery allowed above.
const SINGLE_PROJECT_UPLOAD_STATE = new Set([
  'dashboard-upload.ts',
  'dashboard-upload-scheduler.ts',
]);

// s96-m01: a copy of a shared record checks its own binding, and the same project's other copies on
// this machine. They read the registry, and, to tell a live second copy from a move, the project id
// of the folder a binding names (readStoreIdentity): only copies of this same project, never another
// project's store or the cross-store queries. Unlike the upload helpers, they open that one sibling
// file read-only; the exception permits the registry import and nothing more.
// s96-m03: the share step binds the new copy in this machine's registry, and retires that binding
// if its transaction fails; it reads no other project.
const SINGLE_PROJECT_REPLICA = new Set([
  'replica-identity.ts',
  'replica-check.ts',
  'record-share.ts',
  // s96-m13: a recovery reads and retires this machine's binding of the lost owner copy (ADR s96 §8).
  'record-recovery.ts',
  // s98-m15: extracted recovery write step; its registry type is passed only to reidentifyReplica
  // to check, retire and bind copies of the same recorded project, never to query another project.
  'record-recovery-core.ts',
]);

// Matches an import from the cross-store fan-out modules OR the project-graph registry —
// the machinery a pin-only read would use to escape its sender scope.
const CROSS_STORE_IMPORT =
  /from\s+['"][^'"]*\/(cross-store-query|cross-store-queries|project-graph-registry)['"]/;
const CROSS_STORE_QUERY_IMPORT = /from\s+['"][^'"]*\/(cross-store-query|cross-store-queries)['"]/;

function violatesScope(name: string, content: string): boolean {
  if (ALLOWLIST.has(name)) return false;
  if (SINGLE_PROJECT_UPLOAD_STATE.has(name) || SINGLE_PROJECT_REPLICA.has(name))
    return CROSS_STORE_QUERY_IMPORT.test(content);
  return CROSS_STORE_IMPORT.test(content);
}

/** The ratified acrossProjects handlers must genuinely import the canonical query machinery. */
const RATIFIED_ACROSS_PROJECTS = [
  'rbook-decisions-list.ts',
  'rbook-learnings-list.ts',
  'rbook-mission-status.ts',
  'feedback-fleet.ts',
];

function listHandlerFiles(): string[] {
  return fs
    .readdirSync(HANDLER_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
    .map((e) => e.name);
}

describe('pin-scope convergence gate (Sprint 80 m04)', () => {
  it('no pin-only read handler imports the cross-store machinery outside the ratified set', () => {
    const offenders: string[] = [];
    for (const name of listHandlerFiles()) {
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      if (violatesScope(name, content)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a replica module cannot gain portfolio queries under its registry-only exception', () => {
    for (const name of SINGLE_PROJECT_REPLICA) {
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      expect(violatesScope(name, content)).toBe(false);
      for (const specifier of ['cross-store-query', 'cross-store-queries']) {
        const fanOut = `import { queryAcrossStores } from '../../intelligence/${specifier}';`;
        expect(violatesScope(name, fanOut)).toBe(true);
        expect(violatesScope(name, content + '\n' + fanOut)).toBe(true);
      }
    }
  });

  it('an upload helper cannot gain portfolio queries under its registry-only exception', () => {
    for (const name of SINGLE_PROJECT_UPLOAD_STATE) {
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      expect(content).toMatch(/from ['"].*\/project-graph-registry['"]/);
      expect(violatesScope(name, content)).toBe(false);
      const mutant =
        content + '\nimport { queryAcrossStores } from "../../intelligence/cross-store-query";';
      expect(violatesScope(name, mutant)).toBe(true);
    }
  });

  it('upload status reads only the requested root and never falls back to another project', async () => {
    const getByStorePath = jest.fn((root: string) =>
      root === '/missing/pinned-project' ? 'pinned' : null
    );
    const readUploadState = jest.fn(() => ({ lastSyncedAt: null, firstOwedAt: null }));
    const create = jest.spyOn(ProjectGraphRegistry, 'create').mockResolvedValue({
      getByStorePath,
      readUploadState,
    } as unknown as ProjectGraphRegistry);
    try {
      // These roots deliberately have no database. A presentation read needs only its registry row.
      expect(await readDashboardUploadStatus('/missing/pinned-project')).toBe(
        'Dashboard upload: last success never.'
      );
      expect(await readDashboardUploadStatus('/missing/other-project')).toBeNull();
      expect(getByStorePath.mock.calls).toEqual([
        ['/missing/pinned-project'],
        ['/missing/other-project'],
      ]);
      expect(readUploadState.mock.calls).toEqual([['pinned']]);
    } finally {
      create.mockRestore();
    }
  });

  it('the ratified acrossProjects handlers still import a cross-store query (keeps the list honest)', () => {
    for (const name of RATIFIED_ACROSS_PROJECTS) {
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      const importsCrossStore =
        /from\s+['"][^'"]*\/(cross-store-query|cross-store-queries)['"]/.test(content);
      expect({ file: name, importsCrossStore }).toEqual({ file: name, importsCrossStore: true });
    }
  });
});

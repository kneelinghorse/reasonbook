// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s80-m01 — the verify:dist answer-shape release gate. Drives the BUILT
// ABOUTME: dist/index.js over MCP stdio (no pack/install) and asserts s80 invariants.

/**
 * verify:dist (s80-m01 scaffold, grown across m01–m07).
 *
 * This is the committed answer-shape release gate — it speaks MCP over stdio to the
 * repo's freshly-built `dist/index.js` and asserts the standing invariants (server
 * identity, the 15-tool line) plus the sprint's answer-shape deltas. It reuses the
 * shared stdio bootstrap (`tests/e2e/stdio-harness.ts`) with the first-run E2E so the
 * two never drift on transport wiring, but — unlike first-run — it does NOT pack/install
 * (fast, run against the working `dist/`). Kept OUT of the coverage-gated default jest
 * suite; run explicitly with `npm run verify:dist` (after `npm run build`).
 *
 * Exit 0 = all checks passed; exit 1 = at least one failed (details on stderr).
 *
 * @module scripts/verify-dist
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { LEGACY, resolveRecordPaths } from '../dist/intelligence/legacy-compat';
import { connectStdioServer, textOf } from '../tests/e2e/stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_SERVER = path.join(REPO_ROOT, 'dist', 'index.js');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

/**
 * The `sprint_summary` definition as it stood BEFORE s86-m08 — read verbatim from the live store
 * on 2026-08-12, while that store was still un-migrated.
 *
 * Kept here as a FIXTURE, not as a spec: it exists so the real-store migration proof below can
 * downgrade its tmpdir copy to a known pre-migration state on every run instead of depending on
 * some store somewhere still being old. Nothing reads it as the current contract — the live
 * definition is `SPRINT_SUMMARY_VIEW_SQL` in src/tools/rbook/schema.ts, and the whole point of the
 * check is that the shipped dist replaces THIS with THAT.
 *
 * Its distinguishing property, and the one the assertion turns on: `total_missions` is a bare
 * `COUNT(m.id)` with no status filter, so Deferred and Dropped missions sit in the denominator —
 * the defect s86-m08 fixed — and there is no `parked_missions` column at all.
 */
const PRE_S86M08_SPRINT_SUMMARY_SQL = `CREATE VIEW sprint_summary AS
SELECT
  s.id AS sprint_id,
  s.title,
  s.status,
  s.focus,
  s.start_date,
  s.end_date,
  COUNT(m.id) AS total_missions,
  COUNT(CASE WHEN m.status = 'Completed' THEN 1 END) AS completed_missions,
  COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
  COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
  (
    SELECT COUNT(DISTINCT sd.id)
    FROM strategic_decisions sd
    WHERE sd.sprint_id = s.id
  ) AS decisions_count
FROM sprints s
LEFT JOIN missions m ON m.sprint_id = s.id
GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date`;

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST_SERVER)) {
    console.error(`verify:dist — ${DIST_SERVER} not found. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const projectDir = mkTmp('rbook-verify-project-');
  const configDir = mkTmp('rbook-verify-config-');
  const env = {
    ...process.env,
    RBOOK_CONFIG_DIR: configDir,
    RBOOK_CHECKPOINT_SYNC: 'off',
    [`${LEGACY.envPrefix}CONFIG_DIR`]: configDir,
  } as Record<string, string>;
  delete env.RBOOK_PROJECT_ROOT;
  delete env[`${LEGACY.envPrefix}PROJECT_ROOT`];

  const h = await connectStdioServer({
    serverPath: DIST_SERVER,
    cwd: projectDir,
    env,
    clientName: 'verify-dist',
  });

  try {
    // --- Standing invariants (every sprint) ---
    const info = h.client.getServerVersion();
    check('server announces rbook', info?.name === 'rbook', `got ${info?.name}`);
    check(
      `server version === ${PKG.version}`,
      info?.version === PKG.version,
      `got ${info?.version}`
    );

    const tools = await h.client.listTools();
    check('exposes exactly 15 tools', tools.tools.length === 15, `got ${tools.tools.length}`);

    // s80-m05: rbook_message(get) shipped as an ACTION (not a tool — 15-tool line holds).
    // The byte-cap + body-on-get BEHAVIOR is covered by unit tests (the isolated verify:dist
    // env has no dashboard auth); here we assert the action reached the built dist schema.
    const messageTool = tools.tools.find((t) => t.name === 'rbook_message');
    const messageActions =
      (messageTool?.inputSchema?.properties as { action?: { enum?: string[] } })?.action?.enum ??
      [];
    check(
      'rbook_message advertises the get action (body-on-get)',
      messageActions.includes('get'),
      `actions=${messageActions.join(',')}`
    );

    // --- s80-m01: the dist is drivable end-to-end against a fresh graph-only store ---
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDir,
      projectName: 'verify-dist',
      projectType: 'build', // The store-root tier probe below specifically edits build.md.
    });
    check(
      'rbook_project(init) writes the seed store',
      fs.existsSync(path.join(projectDir, 'rbook', 'db', 'rbook.sqlite'))
    );
    // s92-m06: init writes an uppercase AGENTS.md at the project root from the shipped template.
    // A directory listing, not existsSync: a case-insensitive filesystem would accept agents.md.
    check(
      's92-m06: the shipped init writes AGENTS.md at the project root, from the shipped template',
      fs.readdirSync(projectDir).includes('AGENTS.md') &&
        fs
          .readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')
          .includes('Hard Operating Rules'),
      fs.readdirSync(projectDir).join(',')
    );

    // s80-m02: init registers into the project-graph registry (single source) and
    // writes NO legacy project-registry.json.
    check(
      'init writes the project-graph registry',
      fs.existsSync(path.join(configDir, 'project-graph.sqlite'))
    );
    check(
      'init writes NO legacy project-registry.json',
      !fs.existsSync(path.join(configDir, 'project-registry.json'))
    );

    const review = await h.callOk('rbook_review', { projectRoot: projectDir });
    check('rbook_review returns a non-empty digest', textOf(review).length > 0);

    // A legacy 401 row is read without a migration or a network probe in the digest path.
    const uploadRegistry = new Database(path.join(configDir, 'project-graph.sqlite'));
    try {
      uploadRegistry
        .prepare(
          `UPDATE projects SET upload_blocked=1,
        upload_last_error='HTTP 401', upload_last_attempt_at=? WHERE store_path=?`
        )
        .run(Date.now(), projectDir);
      const pausedReview = await h.callOk('rbook_review', { projectRoot: projectDir });
      const pausedText = textOf(pausedReview);
      const pausedData = h.dataOf(pausedReview) as { digestSizeBytes?: number };
      check(
        's101-m01: built review includes upload attention exactly once within its budget',
        (pausedText.match(/Dashboard upload:/g) ?? []).length === 1 &&
          pausedText.includes('reason auth') &&
          typeof pausedData.digestSizeBytes === 'number' &&
          pausedData.digestSizeBytes <= 4096,
        `digestSizeBytes=${pausedData.digestSizeBytes}`
      );
    } finally {
      uploadRegistry
        .prepare(
          `UPDATE projects SET upload_blocked=0,
        upload_last_error=NULL, upload_last_attempt_at=NULL WHERE store_path=?`
        )
        .run(projectDir);
      uploadRegistry.close();
    }

    // --- s80-m04: a pin-only read pins to the sender; a neutral multi-project dir
    //     fails CLOSED (never fans out). Register a 2nd project so the registry is
    //     multi-project (sender-context auto-picks ONLY a size-1 registry).
    const projectDir2 = mkTmp('rbook-verify-project2-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDir2,
      projectName: 'verify-dist-2',
    });

    // s80-m06: with a multi-project registry, rbook_review carries a strict-partition
    // portfolio (reachable + silent + unmigrated + unreadable === projects) within budget.
    const review2 = h.dataOf(await h.callOk('rbook_review', { projectRoot: projectDir })) as {
      portfolio?: {
        projects: number;
        reachable: number;
        silent: number;
        unmigrated: number;
        unreadable: number;
      } | null;
      digestSizeBytes?: number;
    };
    const pf = review2?.portfolio;
    check(
      'rbook_review portfolio is a strict partition (reachable+silent+unmigrated+unreadable === projects)',
      !!pf && pf.reachable + pf.silent + pf.unmigrated + pf.unreadable === pf.projects,
      `portfolio=${JSON.stringify(pf)}`
    );

    // s80-m07: the self-capture guard is wired into onboard but must NOT false-fire on a
    // fresh store (no decisions/learnings/missions yet → Signal B null → no advisory).
    const onboardData = h.dataOf(
      await h.callOk('rbook_agent_onboard', { projectRoot: projectDir })
    ) as { selfCapture?: { fires?: boolean } };
    check(
      'self-capture guard is present and does not false-fire on a fresh store',
      onboardData?.selfCapture != null && onboardData.selfCapture.fires === false,
      `selfCapture=${JSON.stringify(onboardData?.selfCapture)}`
    );
    check(
      'rbook_review digest stays within the 4KB budget',
      typeof review2?.digestSizeBytes === 'number' && review2.digestSizeBytes <= 4096,
      `digestSizeBytes=${review2?.digestSizeBytes}`
    );

    // --- s81-m03: the "unsynced" drift class must NOT false-fire on a fresh store
    //     (last_synced_at is NULL = no-signal; it never fabricates a positive). The
    //     partition-sum + budget checks above already prove the overlay never inflates
    //     the partition or the digest.
    const driftStale =
      (
        review2 as {
          portfolio?: { drift?: { stale?: Array<{ reason?: string }> } | null };
        }
      )?.portfolio?.drift?.stale ?? [];
    check(
      's81-m03: no false "unsynced" drift on a fresh store (NULL last_synced_at = no-signal)',
      Array.isArray(driftStale) && !driftStale.some((d) => /unsynced/i.test(d?.reason ?? '')),
      `drift=${JSON.stringify(driftStale)}`
    );

    // --- s90-m05: rbook_sprint(complete) carries the whole-ledger next_steps survey receipt.
    //     Drive a minimal empty-sprint close on a fresh project and assert both the new shape and
    //     removal of the old provenance-as-delivery reconciliation fields in the shipped dist.
    const projectDir3 = mkTmp('rbook-verify-m06-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDir3,
      projectName: 'verify-m06',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      projectRoot: projectDir3,
      sprintId: 'sv-1',
      title: 'SV1',
      focus: 'verify',
    });
    const implicitCapture = h.dataOf(
      await h.callOk('rbook_session', {
        action: 'capture',
        category: 'context',
        content: 'Concurrent implicit work remains visible during sprint close.',
        projectRoot: projectDir3,
      })
    ) as { sessionId?: string };
    const closeReply = await h.callOk('rbook_sprint', {
      action: 'complete',
      projectRoot: projectDir3,
      sprintId: 'sv-1',
      summary: 'verify:dist reconcile-receipt shape',
    });
    const closeData = h.dataOf(closeReply) as Record<string, unknown>;
    const uploadReceipt = closeData.dashboardUpload as
      | { started?: boolean; why?: string }
      | undefined;
    check(
      's101-m01: built close reports the disabled upload in both channels',
      uploadReceipt?.started === false &&
        uploadReceipt.why === 'off' &&
        h.textOf(closeReply).includes('Dashboard upload: not started (off)'),
      JSON.stringify(uploadReceipt)
    );
    check(
      's98-m13: built sprint close names active implicit sessions beside direct sprint membership',
      typeof implicitCapture.sessionId === 'string' &&
        Array.isArray(closeData.activeSessionsAtClose) &&
        Array.isArray(closeData.implicitSessionsAtClose) &&
        closeData.implicitSessionsAtClose.some(
          (session: { id?: string }) => session.id === implicitCapture.sessionId
        ),
      `implicitSessionsAtClose=${JSON.stringify(closeData.implicitSessionsAtClose)}`
    );
    const nextStepsSurvey = closeData?.nextStepsSurvey as
      | {
          available?: unknown;
          totalPending?: unknown;
          groups?: Record<string, unknown> | null;
        }
      | undefined;
    const surveyGroups = nextStepsSurvey?.groups;
    check(
      's90-m05: rbook_sprint(complete) returns the whole-ledger next_steps survey shape',
      nextStepsSurvey?.available === true &&
        nextStepsSurvey.totalPending === 0 &&
        surveyGroups !== null &&
        typeof surveyGroups === 'object' &&
        Array.isArray(surveyGroups.closingSprintWithMissionProvenance) &&
        Array.isArray(surveyGroups.closingSprintWithoutMissionProvenance) &&
        Array.isArray(surveyGroups.otherSprintProvenance) &&
        Array.isArray(surveyGroups.noSprintProvenance) &&
        !Object.prototype.hasOwnProperty.call(closeData, 'nextStepsReconciled') &&
        !Object.prototype.hasOwnProperty.call(closeData, 'nextStepsCarried') &&
        !Object.prototype.hasOwnProperty.call(closeData, 'pendingFlagged'),
      `receipt=${JSON.stringify({
        survey: nextStepsSurvey,
        oldFields: {
          nextStepsReconciled: closeData?.nextStepsReconciled,
          nextStepsCarried: closeData?.nextStepsCarried,
          pendingFlagged: closeData?.pendingFlagged,
        },
      })}`
    );

    // --- s83-m05: tiers that work for strangers ---
    // (a) Auto-discovery (NO projectRoot): onboard must resolve tiers from the RESOLVED
    //     store root (dirname^3 of the connected DB path), not the server install dir.
    //     The server runs with cwd=projectDir and RBOOK_PROJECT_ROOT deleted, so this is
    //     the real npm-consumer path. Asserting tierConfig != null alone is NOT enough —
    //     the always-present bundled rbook-seed/tiers fallback would satisfy that even if
    //     the onboard fix were reverted. So stamp a unique label into projectDir's OWN
    //     build.md and assert onboard echoes it: a regression to raw params.projectRoot
    //     (undefined on auto-discovery) would fall back to the seed and miss the marker.
    const storeBuildTier = path.join(projectDir, 'rbook', 'tiers', 'build.md');
    const originalTier = fs.readFileSync(storeBuildTier, 'utf8');
    const storeMarker = 'StoreRootMarker-s83m05';
    fs.writeFileSync(storeBuildTier, originalTier.replace(/^label:.*$/m, `label: ${storeMarker}`));
    let onboardNoRoot: { tierConfig?: { tier?: string; label?: string } | null };
    try {
      onboardNoRoot = h.dataOf(await h.callOk('rbook_agent_onboard', {})) as typeof onboardNoRoot;
    } finally {
      fs.writeFileSync(storeBuildTier, originalTier);
    }
    check(
      's83-m05: auto-discovery onboard (no projectRoot) reads tiers from the resolved STORE root, not the seed',
      onboardNoRoot?.tierConfig?.label === storeMarker,
      `tierConfig=${JSON.stringify(onboardNoRoot?.tierConfig)}`
    );

    // (b) rbook_project(init, projectType=managed) writes the tier and onboard surfaces
    //     the managed first-session flow (sprintZeroReady + a Managed prompt).
    const managedDir = mkTmp('rbook-verify-managed-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: managedDir,
      projectName: 'verify-managed',
      projectType: 'managed',
    });
    const managedOnboard = h.dataOf(
      await h.callOk('rbook_agent_onboard', { projectRoot: managedDir })
    ) as {
      project?: { projectType?: string };
      sprintZeroReady?: boolean;
      tierSelectionPrompt?: string;
    };
    check(
      's83-m05: init(projectType=managed) is read back as the managed tier on onboard',
      managedOnboard?.project?.projectType === 'managed',
      `projectType=${managedOnboard?.project?.projectType}`
    );
    // s95-m06: the prompt names the level the operator chose (Planner is the managed tier).
    check(
      's83-m05: managed fresh project surfaces sprintZeroReady + a Planner prompt',
      managedOnboard?.sprintZeroReady === true &&
        /fresh Reasonbook Planner project/.test(managedOnboard?.tierSelectionPrompt ?? ''),
      `sprintZeroReady=${managedOnboard?.sprintZeroReady}; prompt=${(
        managedOnboard?.tierSelectionPrompt ?? ''
      ).slice(0, 60)}`
    );

    // --- s83-m06: project_id-aware retrieval trust. Over stdio we can only prove the
    //     framing PLUMBING shipped (result carries localProjectId) and that a LOCAL row
    //     is NOT false-framed. The foreign-row positive-fire lives in the jest
    //     provenance-surfaces suite — a foreign row can only enter a store via
    //     sync-merge/pull, which isn't reachable over plain MCP stdio.
    const m06Dir = mkTmp('rbook-verify-m06frame-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: m06Dir,
      projectName: 'verify-m06frame',
    });
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'plan',
      projectRoot: m06Dir,
    });
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'decision',
      content: 'Adopt widget-sqlite-retrieval as the local decision',
      projectRoot: m06Dir,
    });
    const dsearchRes = await h.callOk('rbook_decisions', {
      action: 'search',
      query: 'widget sqlite retrieval',
      projectRoot: m06Dir,
    });
    const dsearch = h.dataOf(dsearchRes) as { localProjectId?: string | null };
    const dsearchText = h.textOf(dsearchRes);
    check(
      's83-m06: decisions(search) result carries localProjectId (framing plumbing shipped)',
      typeof dsearch?.localProjectId === 'string' && (dsearch.localProjectId ?? '').length > 0,
      `localProjectId=${dsearch?.localProjectId}`
    );
    check(
      's83-m06: a LOCAL decision renders BARE (no untrusted fence — no false-framing)',
      dsearchText.includes('widget-sqlite-retrieval') && !dsearchText.includes('[UNTRUSTED DATA'),
      `text=${dsearchText.slice(0, 140)}`
    );
    // The review-closure surfaces (onboard recentDecisions, context-view) also ship the
    // plumbing and must NOT false-frame the local decision.
    const m06Onboard = h.dataOf(await h.callOk('rbook_agent_onboard', { projectRoot: m06Dir })) as {
      localProjectId?: string | null;
    };
    check(
      's83-m06: rbook_agent_onboard result carries localProjectId (recentDecisions framing plumbing)',
      typeof m06Onboard?.localProjectId === 'string' &&
        (m06Onboard.localProjectId ?? '').length > 0,
      `localProjectId=${m06Onboard?.localProjectId}`
    );
    const m06ViewText = h.textOf(
      await h.callOk('rbook_context', { action: 'view', projectRoot: m06Dir })
    );
    check(
      's83-m06: rbook_context(view) renders the LOCAL decision BARE (no false-framing)',
      m06ViewText.includes('widget-sqlite-retrieval') && !m06ViewText.includes('[UNTRUSTED DATA'),
      `text=${m06ViewText.slice(0, 140)}`
    );

    // --- s84 answer shapes (this release's deltas). Only what is provable over PLAIN stdio:
    //     the verify:dist env has no dashboard auth, so anything requiring a live dashboard
    //     round-trip stays owned by the jest suites and is asserted here at the SCHEMA level.
    const s84Dir = mkTmp('rbook-verify-s84-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: s84Dir,
      projectName: 'verify-s84',
    });

    // (a) s84-m02: SQL-side pagination reached the built schema. The behavior (offset echo +
    //     returnedCount) needs a dashboard; the INPUT contract is provable here.
    const messageProps = (messageTool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    check(
      's84-m02: rbook_message advertises the offset pagination param',
      Object.prototype.hasOwnProperty.call(messageProps, 'offset'),
      `props=${Object.keys(messageProps).join(',')}`
    );

    // (b) s84-m05: an EVERGREEN constraint is excluded from staleness review end-to-end.
    //     Drivable on a fresh store: capture two constraints, flag one evergreen, and assert
    //     review returns the other and not it. This is the positive fire for the flag.
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 's84 constraints',
      projectRoot: s84Dir,
    });
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'constraint',
      content: 'Institutional rule: the review digest stays under 4KB',
      projectRoot: s84Dir,
    });
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'constraint',
      content: 'Temporary rule: deploy freeze until the release lands',
      projectRoot: s84Dir,
    });
    const listedConstraints = h.dataOf(
      await h.callOk('rbook_context', {
        action: 'constraints',
        constraintAction: 'list',
        projectRoot: s84Dir,
      })
    ) as { items?: Array<{ id: number; content: string; evergreen?: boolean }> };
    const constraintItems = listedConstraints?.items ?? [];
    const institutional = constraintItems.find((c) => /Institutional rule/.test(c.content));
    const temporary = constraintItems.find((c) => /Temporary rule/.test(c.content));
    check(
      's84-m05: constraints(list) returns both captured constraints, evergreen false by default',
      constraintItems.length === 2 &&
        institutional != null &&
        constraintItems.every((c) => c.evergreen === false),
      `items=${JSON.stringify(constraintItems)}`
    );

    if (institutional && temporary) {
      await h.callOk('rbook_context', {
        action: 'constraints',
        constraintAction: 'reaffirm',
        constraintId: institutional.id,
        evergreen: true,
        projectRoot: s84Dir,
      });
      const relisted = h.dataOf(
        await h.callOk('rbook_context', {
          action: 'constraints',
          constraintAction: 'list',
          projectRoot: s84Dir,
        })
      ) as { items?: Array<{ id: number; evergreen?: boolean }> };
      const flagById = new Map((relisted?.items ?? []).map((c) => [c.id, c.evergreen]));
      check(
        's84-m05: reaffirm(evergreen=true) durably flags ONLY the targeted constraint',
        flagById.get(institutional.id) === true && flagById.get(temporary.id) === false,
        `flags=${JSON.stringify([...flagById])}`
      );

      // The EXCLUSION leg is deliberately NOT asserted here, and the reason matters: it is
      // not provable over plain stdio on a fresh store. A seconds-old no-expiry constraint
      // scores 20 (the no-expiry bonus alone) and never reaches the 50 review floor, so a
      // review here returns nothing for BOTH rows and absence would prove nothing. Driving
      // the threshold below the elapsed age would fix that, but `stalenessThresholdDays` is
      // `.int().positive()` in zod, and the smallest legal value (1 day) still scores a
      // seconds-old row at 20. Backdating `created_at` is the only way, which needs direct
      // DB access — so the exclusion leg is owned by
      // tests/tools/rbook/constraint-staleness.test.ts ("evergreen=true durably drops the
      // constraint off review + banner"), which seeds a 90-day-old constraint and asserts
      // flagged-before / absent-after plus a PRAGMA positive-fire on the column.
      // What stdio CAN prove — and does, above — is that the flag reaches the built dist,
      // persists, and targets exactly one row.
      const reviewed = h.dataOf(
        await h.callOk('rbook_context', {
          action: 'constraints',
          constraintAction: 'review',
          projectRoot: s84Dir,
        })
      ) as { reviewItems?: Array<{ id: number }> };
      check(
        's84-m05: review runs clean on a fresh store (neither young constraint is stale)',
        Array.isArray(reviewed?.reviewItems) && reviewed.reviewItems.length === 0,
        `reviewItems=${JSON.stringify(reviewed?.reviewItems)}`
      );
    }

    // (c) s84-m04: rbook_context(history) surfaces contentPruned per row. On a fresh store
    //     nothing is tombstoned, so the assertion is that the FIELD ships and reads false —
    //     a regression that dropped the column mapping would surface as undefined.
    await h.callOk('rbook_context', {
      action: 'snapshot',
      projectRoot: s84Dir,
      source: 'verify-dist',
    });
    const history = h.dataOf(
      await h.callOk('rbook_context', { action: 'history', projectRoot: s84Dir })
    ) as { snapshots?: Array<{ contentPruned?: boolean }> };
    const snaps = history?.snapshots ?? [];
    check(
      's84-m04: rbook_context(history) surfaces contentPruned per row (false on a fresh store)',
      snaps.length > 0 && snaps.every((s) => s.contentPruned === false),
      `snapshots=${JSON.stringify(snaps.map((s) => s.contentPruned))}`
    );

    // --- s85-m03: write-side sprint tagging. On a store whose only sprint is Completed, a
    //     session start must persist sprint_id NULL, report advisorySprintId, and warn —
    //     while DISPLAY still names the Completed sprint. Fully drivable over stdio.
    const m03Dir = mkTmp('rbook-verify-m03-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: m03Dir,
      projectName: 'verify-m03',
      projectType: 'build', // This fixture verifies Builder's sprint display, not the init default.
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      projectRoot: m03Dir,
      sprintId: 'sp-closed',
      title: 'Closed sprint',
      focus: 'verify',
    });
    await h.callOk('rbook_sprint', {
      action: 'complete',
      projectRoot: m03Dir,
      sprintId: 'sp-closed',
      summary: 'closed so nothing is open',
    });

    const m03Start = await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m03',
      projectRoot: m03Dir,
    });
    const m03Data = h.dataOf(m03Start) as {
      sprintId?: string | null;
      sprintAutoTagged?: boolean;
      advisorySprintId?: string | null;
    };
    check(
      's85-m03: session start on an all-Completed store persists sprintId NULL',
      m03Data?.sprintId === null && m03Data?.sprintAutoTagged === false,
      `sprintId=${JSON.stringify(m03Data?.sprintId)} autoTagged=${m03Data?.sprintAutoTagged}`
    );
    check(
      's85-m03: the read-resolved sprint rides advisorySprintId, NOT sprintId',
      m03Data?.advisorySprintId === 'sp-closed',
      `advisorySprintId=${JSON.stringify(m03Data?.advisorySprintId)}`
    );
    // warnings ride the RbookToolResult envelope in structuredContent (dataOf returns only
    // `.data`), while the text part is the LLM-formatted view.
    const m03Warnings = ((m03Start as { structuredContent?: { warnings?: string[] } })
      .structuredContent?.warnings ?? []) as string[];
    check(
      's85-m03: session start warns that the session is recorded untagged',
      m03Warnings.some((w) => /sprint_id NULL/.test(w)),
      `warnings=${JSON.stringify(m03Warnings)}`
    );
    check(
      's85-m03: the LLM view says "none open — recorded untagged" rather than omitting the sprint line',
      /none open — recorded untagged/.test(h.textOf(m03Start)),
      h.textOf(m03Start).slice(0, 160)
    );

    // Display is deliberately unchanged — onboard still NAMES the Completed sprint.
    const m03Onboard = h.dataOf(await h.callOk('rbook_agent_onboard', { projectRoot: m03Dir })) as {
      currentSprint?: { id?: string } | null;
    };
    check(
      's85-m03: DISPLAY unchanged — onboard still names the Completed sprint',
      m03Onboard?.currentSprint?.id === 'sp-closed',
      `currentSprint=${JSON.stringify(m03Onboard?.currentSprint?.id)}`
    );

    // --- s85-m04 (#487): the WHOLE mission_id path over stdio, not the handler. The router
    //     at rbook-session.ts forwards `missionId` to complete; if that one line regresses,
    //     every handler test still passes and this check is the one that fails.
    const m04Dir = mkTmp('rbook-verify-m04-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: m04Dir,
      projectName: 'verify-m04',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      projectRoot: m04Dir,
      sprintId: 'sp-m04',
      title: 'm04',
      focus: 'verify',
    });
    await h.callOk('rbook_mission', {
      action: 'add',
      projectRoot: m04Dir,
      missionId: 'mv-1',
      name: 'Verify mission',
      sprintId: 'sp-m04',
    });
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m04',
      projectRoot: m04Dir,
    });
    await h.callOk('rbook_session', {
      action: 'complete',
      summary: 'verify m04 close',
      missionId: 'mv-1',
      decisions: ['verify-dist decision stamped to mv-1'],
      nextSteps: ['verify-dist next step stamped to mv-1'],
      projectRoot: m04Dir,
    });

    const m04Decisions = h.dataOf(
      await h.callOk('rbook_decisions', {
        action: 'list',
        missionId: 'mv-1',
        projectRoot: m04Dir,
      })
    ) as { decisions?: Array<{ decision?: string; missionId?: string | null }> };
    check(
      's85-m04: complete(missionId) -> decisions(list, missionId) round-trips the stamped row',
      (m04Decisions?.decisions ?? []).length === 1 &&
        m04Decisions.decisions?.[0]?.missionId === 'mv-1',
      `decisions=${JSON.stringify(m04Decisions?.decisions)}`
    );

    const m04Steps = h.dataOf(
      await h.callOk('rbook_context', {
        action: 'next_steps',
        nextStepAction: 'list',
        missionId: 'mv-1',
        projectRoot: m04Dir,
      })
    ) as { items?: Array<{ missionId?: string | null }> };
    check(
      's85-m04: complete(missionId) also stamps next_steps, and the filter finds it',
      (m04Steps?.items ?? []).length === 1 && m04Steps.items?.[0]?.missionId === 'mv-1',
      `items=${JSON.stringify(m04Steps?.items)}`
    );

    // A mission with nothing stamped returns none rather than everything — proves the
    // predicate is applied rather than ignored.
    const m04Empty = h.dataOf(
      await h.callOk('rbook_decisions', {
        action: 'list',
        missionId: 'mv-absent',
        projectRoot: m04Dir,
      })
    ) as { decisions?: unknown[] };
    check(
      's85-m04: the missionId filter EXCLUDES rather than being ignored',
      (m04Empty?.decisions ?? []).length === 0,
      `decisions=${JSON.stringify(m04Empty?.decisions)}`
    );

    // --- s86-m02: the ENVELOPE warnings channel (RbookToolResult.warnings) has to be readable
    //     in content[0].text, not just present in structuredContent. Before this mission 57 of
    //     76 leaf formatters never rendered it, so a warning could ship fully populated and
    //     stay invisible to every agent — which is exactly how s85-m04's own missionId advisory
    //     shipped invisible in 2.5.0. Checking structuredContent.warnings ALONE is what let that
    //     happen, so each check below asserts BOTH sides and the text side is the load-bearing one.
    const m02Dir = mkTmp('rbook-verify-s86m02-');
    // s95-m06: a Builder, because the advisory names open missions and a Ledger keeps none. These
    // checks are about how warnings render, not about levels.
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: m02Dir,
      name: 's86-m02 verify',
      projectType: 'build',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sp-open',
      title: 'Open sprint',
      focus: 'verify the warnings channel',
      projectRoot: m02Dir,
    });
    await h.callOk('rbook_mission', {
      action: 'add',
      missionId: 'wm-1',
      name: 'An open mission',
      objective: 'exist, so the missionId advisory has something to name',
      sprintId: 'sp-open',
      projectRoot: m02Dir,
    });
    await h.callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 'wm-1',
      projectRoot: m02Dir,
    });
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m02',
      projectRoot: m02Dir,
    });

    // DISPATCHER-rendered: index.ts calls formatSessionForLLM, which delegates to the
    // formatSessionCaptureForLLM leaf. The advisory is built in rbook-session-capture.ts and
    // handed to createSuccess; until s86-m02 the leaf never read result.warnings.
    const m02Capture = await h.callOk('rbook_session', {
      action: 'capture',
      category: 'decision',
      content: 'A decision captured with no missionId while a mission is open.',
      projectRoot: m02Dir,
    });
    const m02CaptureWarnings = ((m02Capture as { structuredContent?: { warnings?: string[] } })
      .structuredContent?.warnings ?? []) as string[];
    const m02CaptureText = h.textOf(m02Capture);
    check(
      's86-m02: the s85-m04 missionId advisory is present in the envelope',
      m02CaptureWarnings.some((w) => /without a missionId/.test(w)),
      `warnings=${JSON.stringify(m02CaptureWarnings)}`
    );
    check(
      's86-m02: ...and is now READABLE in content[0].text — invisible since 2.5.0 (dispatcher-rendered)',
      /without a missionId/.test(m02CaptureText) && /Warnings:/.test(m02CaptureText),
      m02CaptureText.slice(-400)
    );
    check(
      's86-m02: the advisory renders EXACTLY once, not once per layer',
      m02CaptureText.split('will not appear in').length - 1 === 1,
      m02CaptureText.slice(-400)
    );

    // LEAF-rendered with NO dispatcher in the path: index.ts calls formatAgentOnboardForLLM
    // directly (index.ts:727). The two paths can drop the render independently, so both are
    // checked. Trigger is an orphaned sprint — deterministic and offline; the auth/sync warnings
    // that would exercise rbook_review's envelope need a reachable dashboard, so they are not
    // provable in this gate and are deliberately not asserted here rather than asserted vacuously.
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sp-orphan',
      title: 'Sprint with no missions',
      focus: 'trigger an orphan warning',
      projectRoot: m02Dir,
    });
    const m02Onboard = await h.callOk('rbook_agent_onboard', { projectRoot: m02Dir });
    const m02OnboardWarnings = ((m02Onboard as { structuredContent?: { warnings?: string[] } })
      .structuredContent?.warnings ?? []) as string[];
    const m02OnboardText = h.textOf(m02Onboard);
    check(
      's86-m02: rbook_agent_onboard carries an envelope warning (orphaned sprint)',
      m02OnboardWarnings.some((w) => /orphaned sprint/.test(w)),
      `warnings=${JSON.stringify(m02OnboardWarnings)}`
    );
    check(
      's86-m02: ...readable in content[0].text via the shared helper (leaf-rendered, no dispatcher)',
      m02OnboardWarnings.every((w) => m02OnboardText.includes(w)) &&
        /\nWarnings:\n/.test(m02OnboardText),
      `text tail=${m02OnboardText.slice(-300)}`
    );
    check(
      's86-m02: each envelope warning renders exactly once on the onboard answer',
      m02OnboardWarnings.every((w) => m02OnboardText.split(w).length - 1 === 1),
      `text tail=${m02OnboardText.slice(-300)}`
    );

    // --- s86-m02b: a write the database REJECTED must reach the answer TEXT.
    //
    //     m02 made the envelope channel renderable; m02b routes real write failures into it.
    //     s94-m06 makes decision/learning record+capture+link units atomic, so required failure
    //     now returns a structured refusal and rolls back the capture. Both channels are asserted over
    //     stdio against the BUILT dist, because handler-only testing is exactly what let
    //     statusFilter, expiresAt and agentFeedback all ship dead. The failures are forced at the
    //     DATABASE (a dangling FK, a RAISE trigger) rather than by stubbing anything, so this
    //     also proves the SQL matches the store — a mock cannot do that.
    const m02bDir = mkTmp('rbook-verify-s86m02b-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: m02bDir,
      name: 's86-m02b verify',
    });
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m02b',
      projectRoot: m02bDir,
    });

    const m02bDb = path.join(m02bDir, 'rbook', 'db', 'rbook.sqlite');
    let m02bMasterContext: Record<string, unknown>;
    const m02bAtomicState = () => {
      const db = new Database(m02bDb, { readonly: true });
      try {
        const count = (table: string, where = '') =>
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
        const hasLinks = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_links'")
          .get();
        return {
          sessions: db.prepare('SELECT id,status,captures FROM sessions ORDER BY id').all(),
          decisions: count('strategic_decisions'),
          links: hasLinks ? count('record_links') : 0,
          captureEvents: count('session_events', "WHERE action='capture'"),
        };
      } finally {
        db.close();
      }
    };
    {
      // `strategic_decisions.context_id` is NOT NULL DEFAULT 'master_context' with an FK to
      // contexts(id). The capture INSERT never names the column, so every decision row takes
      // that default — remove the parent row and the next decision INSERT fails the FK.
      const db = new Database(m02bDb);
      try {
        db.pragma('foreign_keys = ON');
        m02bMasterContext = db
          .prepare("SELECT * FROM contexts WHERE id='master_context'")
          .get() as Record<string, unknown>;
        db.prepare(`DELETE FROM contexts WHERE id = 'master_context'`).run();
        // A RAISE trigger fails the session_events insert without touching anything else,
        // which is the Tier-2 (envelope) half of the same proof.
        db.exec(
          `CREATE TRIGGER verify_m02b_no_events BEFORE INSERT ON session_events
           BEGIN SELECT RAISE(ABORT, 'verify-dist forced session_events failure'); END;`
        );
      } finally {
        db.close();
      }
    }

    const m02bBefore = m02bAtomicState();
    const m02bCaptureParams = {
      action: 'capture',
      category: 'decision',
      content: 's86-m02b — this decision INSERT is expected to fail its FK',
      projectRoot: m02bDir,
    };
    const m02bCapture = await h.callTool('rbook_session', m02bCaptureParams);
    const m02bCaptureText = h.textOf(m02bCapture);
    const m02bEnvelope = m02bCapture.structuredContent as
      | {
          success?: boolean;
          data?: unknown;
          error?: { code?: string; message?: string; suggestion?: string };
          warnings?: string[];
        }
      | undefined;
    check(
      's94-m06: a rejected decision INSERT refuses the required atomic unit',
      m02bCapture.isError === true &&
        m02bEnvelope?.success === false &&
        m02bEnvelope.data === undefined,
      `envelope=${JSON.stringify(m02bEnvelope)}`
    );
    check(
      's94-m06: the structured refusal names the DB failure and rollback remedy',
      m02bEnvelope?.error?.code === 'DB_QUERY_FAILED' &&
        /FOREIGN KEY|constraint/i.test(m02bEnvelope.error.message ?? '') &&
        /rolled back/i.test(m02bEnvelope.error.suggestion ?? ''),
      `error=${JSON.stringify(m02bEnvelope?.error)}`
    );
    check(
      's94-m06: content[0].text discloses failed capture, the DB error and rollback',
      /Failed to capture/i.test(m02bCaptureText) &&
        /FOREIGN KEY|constraint/i.test(m02bCaptureText) &&
        /rolled back/i.test(m02bCaptureText),
      m02bCaptureText.slice(-500)
    );
    check(
      's94-m06: rejected capture preserves session status/captures, canonical records, links and events',
      JSON.stringify(m02bAtomicState()) === JSON.stringify(m02bBefore),
      `before=${JSON.stringify(m02bBefore)} after=${JSON.stringify(m02bAtomicState())}`
    );
    check(
      's86-m02b: the "Extraction skipped" lie is gone from that answer',
      !/Extraction skipped/.test(m02bCaptureText),
      m02bCaptureText.slice(-500)
    );
    check(
      's86-m02b: the Tier-2 envelope carries the session_events failure in the SAME answer',
      (m02bEnvelope?.warnings ?? []).some(
        (warning) =>
          warning.includes('capture event logging failed') &&
          warning.includes('verify-dist forced session_events failure')
      ) &&
        /Warnings:/.test(m02bCaptureText) &&
        /capture event logging failed/.test(m02bCaptureText) &&
        /verify-dist forced session_events failure/.test(m02bCaptureText),
      m02bCaptureText.slice(-500)
    );

    // The same request must work when both database faults are removed; rollback must not
    // leave a duplicate capture that makes the retry appear successful without a new record.
    {
      const db = new Database(m02bDb);
      try {
        const columns = Object.keys(m02bMasterContext!);
        db.prepare(
          `INSERT INTO contexts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
        ).run(...columns.map((column) => m02bMasterContext[column]));
        db.exec('DROP TRIGGER verify_m02b_no_events');
      } finally {
        db.close();
      }
    }
    const m02bRetry = await h.callOk('rbook_session', m02bCaptureParams);
    const m02bAfterRetry = m02bAtomicState();
    const m02bRetryData = h.dataOf(m02bRetry) as {
      decisionExtractionCount?: number;
      decisionId?: number;
    };
    check(
      's94-m06: repaired-store positive control commits exactly one canonical record and capture event',
      m02bRetryData?.decisionExtractionCount === 1 &&
        typeof m02bRetryData.decisionId === 'number' &&
        m02bAfterRetry.decisions === m02bBefore.decisions + 1 &&
        m02bAfterRetry.captureEvents === m02bBefore.captureEvents + 1 &&
        (m02bAfterRetry.sessions as Array<{ captures: string | null }>).reduce(
          (n, row) => n + (JSON.parse(row.captures ?? '[]') as unknown[]).length,
          0
        ) === 1 &&
        !/capture event logging failed|Decision Extraction.*FAILED/.test(h.textOf(m02bRetry)),
      `state=${JSON.stringify(m02bAfterRetry)} data=${JSON.stringify(m02bRetryData)}`
    );

    // Mode (i): from a REAL project cwd, a pin-only read (mission list, no projectRoot)
    // resolves to the sender and succeeds — scoped, not fanned out.
    const pinnedRead = await h.callTool('rbook_mission', { action: 'list' });
    check(
      'pin-only read from a real cwd resolves to the sender (not isError)',
      pinnedRead.isError !== true
    );

    // Mode (ii): from a NEUTRAL dir with a multi-project registry, the same read fails
    // CLOSED (SenderResolutionError) rather than walking every project.
    const neutralDir = mkTmp('rbook-verify-neutral-');
    const h2 = await connectStdioServer({
      serverPath: DIST_SERVER,
      cwd: neutralDir,
      env,
      clientName: 'verify-dist-neutral',
    });
    try {
      const neutralRead = await h2.callTool('rbook_mission', { action: 'list' });
      check(
        'pin-only read from a neutral multi-project dir fails CLOSED (isError, no fan-out)',
        neutralRead.isError === true,
        `isError=${neutralRead.isError}; text=${h2.textOf(neutralRead).slice(0, 120)}`
      );
    } finally {
      await h2.close();
    }

    // --- s86-m03: the four newly-reachable params, VERIFIED OVER THE WIRE ---------------
    //
    // THIS SECTION EXISTS BECAUSE ITS ABSENCE IS WHAT LET THREE OF THEM SHIP DEAD. `statusFilter`,
    // `expiresAt` and `agentFeedback` were all accepted by their handlers the whole time — every
    // handler-level test was green. What none of them exercised was the consolidated router, which
    // dropped the key on the way through. Driving the BUILT dist over stdio is the only check that
    // covers declaration, dispatch, forwarding and persistence at once.
    const distTools = await h.client.listTools();
    const propsOf = (tool: string) =>
      (distTools.tools.find((t) => t.name === tool)?.inputSchema?.properties ?? {}) as Record<
        string,
        { enum?: unknown[]; items?: { enum?: unknown[] } }
      >;

    const ctxProps = propsOf('rbook_context');
    const sessProps = propsOf('rbook_session');
    check('dist advertises rbook_context.statusFilter', ctxProps.statusFilter !== undefined);
    check('dist advertises rbook_session.expiresAt', sessProps.expiresAt !== undefined);
    check('dist advertises rbook_session.agentFeedback', sessProps.agentFeedback !== undefined);
    // NO ENUM on either surface — the filter spans two tables whose live status vocabularies
    // differ, and stores hold an out-of-enum 'stale' (set explicitly, or by servers before 3.3.0,
    // which wrote it on their own). A closed enum would manufacture, in
    // brand-new surface, the published-enum-forbids-a-value-the-server-writes defect s86 fixes.
    check(
      'statusFilter is published WITHOUT an enum (fleet-wide status vocabularies differ)',
      ctxProps.statusFilter?.enum === undefined && ctxProps.statusFilter?.items?.enum === undefined
    );

    const distDb = path.join(projectDir, 'rbook', 'db', 'rbook.sqlite');
    const readDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(distDb, { readonly: true });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const writeDb = (fn: (db: Database.Database) => void): void => {
      const db = new Database(distDb);
      try {
        fn(db);
      } finally {
        db.close();
      }
    };

    await h.callOk('rbook_session', {
      action: 'start',
      title: 's86-m03 dist verification',
      projectRoot: projectDir,
    });

    // (1) evergreen on reaffirm — the motivating defect. Read the COLUMN back, never the response:
    // asserting on the response passes against this bug forever.
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 's86-m03 dist verification learning',
      projectRoot: projectDir,
    });
    const learningId = readDb(
      (db) =>
        (
          db
            .prepare(`SELECT id FROM learnings WHERE content LIKE '%dist verification learning%'`)
            .get() as { id: number } | undefined
        )?.id
    );
    check('dist: a learning was captured to reaffirm', learningId !== undefined);
    if (learningId !== undefined) {
      await h.callOk('rbook_learnings', {
        action: 'reaffirm',
        learningId,
        evergreen: true,
        projectRoot: projectDir,
      });
      const ever = readDb(
        (db) =>
          (
            db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(learningId) as {
              evergreen: number;
            }
          ).evergreen
      );
      check('dist: rbook_learnings(reaffirm, evergreen=true) writes evergreen=1', ever === 1);
    }

    // (2) expiresAt — read constraints.expires_at back.
    const EXPIRY = '2027-03-20T00:00:00.000Z';
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'constraint',
      content: 's86-m03 dist verification constraint',
      expiresAt: EXPIRY,
      projectRoot: projectDir,
    });
    const expiresAt = readDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT expires_at FROM constraints WHERE content LIKE '%dist verification constraint%'`
            )
            .get() as { expires_at: string | null } | undefined
        )?.expires_at
    );
    check(
      `dist: rbook_session(capture).expiresAt persists to constraints.expires_at`,
      expiresAt === EXPIRY
    );

    // (3) statusFilter — a decision the ['active'] default cannot reach becomes reachable.
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'decision',
      content: 's86-m03 zzdistprobe decision for the status filter',
      projectRoot: projectDir,
    });
    writeDb((db) =>
      db
        .prepare(
          `UPDATE strategic_decisions SET status = 'superseded' WHERE decision_text LIKE '%zzdistprobe%'`
        )
        .run()
    );
    const countHits = (res: { structuredContent?: { data?: unknown } }): number =>
      ((res.structuredContent?.data as { results?: unknown[] })?.results ?? []).length;
    const defaultSearch = await h.callOk('rbook_context', {
      action: 'search',
      query: 'zzdistprobe',
      searchTypes: ['decision'],
      projectRoot: projectDir,
    });
    const filteredSearch = await h.callOk('rbook_context', {
      action: 'search',
      query: 'zzdistprobe',
      searchTypes: ['decision'],
      statusFilter: ['superseded'],
      projectRoot: projectDir,
    });
    check(
      'dist: the ["active"] default still hides a superseded decision',
      countHits(defaultSearch) === 0,
      `got ${countHits(defaultSearch)} hits`
    );
    check(
      'dist: rbook_context(search).statusFilter=["superseded"] reaches it',
      countHits(filteredSearch) > 0,
      `got ${countHits(filteredSearch)} hits`
    );

    // (4) agentFeedback — the row must carry the REGISTERED tool name, not the retired one.
    await h.callOk('rbook_session', {
      action: 'complete',
      summary: 's86-m03 dist verification close',
      agentFeedback: 's86-m03 dist verification feedback',
      projectRoot: projectDir,
    });
    const fbRows = readDb(
      (db) =>
        db
          .prepare(
            `SELECT tool_name FROM agent_feedback WHERE body LIKE '%dist verification feedback%'`
          )
          .all() as Array<{ tool_name: string }>
    );
    check('dist: rbook_session(complete).agentFeedback files exactly one row', fbRows.length === 1);
    check(
      "dist: that row's tool_name is the REGISTERED 'rbook_session' (not the retired rbook_session_complete)",
      fbRows[0]?.tool_name === 'rbook_session',
      `got ${fbRows[0]?.tool_name}`
    );

    // --- s86-m04 Part A: the published schema states what the server does ----------------
    //
    // ALL THREE OF THESE ARE WIRE-LEVEL CLAIMS, so they are checked at the wire. The published
    // JSON inputSchema is the ONLY enforcement any consumer ever sees — the consolidated zod
    // schemas are never parsed at runtime — so a parity fix that is green in a unit test but
    // absent from `tools/list` would have fixed nothing that matters.
    const m04Tools = await h.client.listTools();
    const m04Props = (tool: string) =>
      (m04Tools.tools.find((t) => t.name === tool)?.inputSchema?.properties ?? {}) as Record<
        string,
        { type?: string; enum?: string[]; items?: { type?: string } }
      >;

    check(
      'dist: rbook_decisions.decisionId publishes integer (was number)',
      m04Props('rbook_decisions').decisionId?.type === 'integer',
      `got ${m04Props('rbook_decisions').decisionId?.type}`
    );
    check(
      'dist: rbook_decisions.decisionIds items publish integer (array elements too)',
      m04Props('rbook_decisions').decisionIds?.items?.type === 'integer',
      `got ${m04Props('rbook_decisions').decisionIds?.items?.type}`
    );
    check(
      'dist: rbook_context.recencyWeight STILL publishes number (a blanket replace would break it)',
      m04Props('rbook_context').recencyWeight?.type === 'number',
      `got ${m04Props('rbook_context').recencyWeight?.type}`
    );
    check(
      "dist: rbook_learnings.status publishes 'stale' — a value stores hold (explicit, or written by servers before 3.3.0)",
      (m04Props('rbook_learnings').status?.enum ?? []).includes('stale'),
      `got [${m04Props('rbook_learnings').status?.enum}]`
    );
    check(
      'dist: rbook_learnings.category publishes NO enum (the column has no CHECK)',
      m04Props('rbook_learnings').category?.enum === undefined,
      `got [${m04Props('rbook_learnings').category?.enum}]`
    );

    // s86-m04 proved this was accepted by the server despite the published integer constraint.
    // s98-m09 now parses the whole schema at dispatch; pin the changed built-server behavior.
    const floatPage = await h.callTool('rbook_learnings', {
      action: 'list',
      pageSize: 2.5,
      projectRoot: projectDir,
    });
    console.log(
      `  … OBSERVED (s86-m04 CORRECTION 4 probe) rbook_learnings(list, pageSize=2.5): ` +
        `isError=${floatPage.isError === true}; text="${textOf(floatPage).slice(0, 160).replace(/\n/g, ' ')}"`
    );
    check(
      'dist: a non-integer pageSize is rejected by whole-schema server validation',
      floatPage.isError === true &&
        (floatPage.structuredContent as { error?: { code?: string; field?: string } })?.error
          ?.code === 'INVALID_PARAMETER' &&
        (floatPage.structuredContent as { error?: { field?: string } })?.error?.field ===
          'pageSize',
      'Expected INVALID_PARAMETER naming pageSize before its handler runs'
    );

    // REAL-STORE POSITIVE FIRE on a tmpdir COPY. The widened enum has to work against the live
    // table's actual constraint set — NOT NULL project_id/stable_event_id/occurred_at/origin_seq
    // plus an event_type CHECK — which the seeded fixture does not reproduce.
    const liveDb = resolveRecordPaths(REPO_ROOT).dbPath;
    if (fs.existsSync(liveDb)) {
      const liveBefore = fs.statSync(liveDb);
      const copyRoot = mkTmp('rbook-verify-m04-realstore-');
      const copyDbDir = path.join(copyRoot, 'rbook', 'db');
      fs.mkdirSync(copyDbDir, { recursive: true });
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(`${liveDb}${suffix}`)) {
          fs.copyFileSync(`${liveDb}${suffix}`, path.join(copyDbDir, `rbook.sqlite${suffix}`));
        }
      }
      const copyDb = path.join(copyDbDir, 'rbook.sqlite');
      const db = new Database(copyDb);
      try {
        const projectId = (
          db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
            | { value: string }
            | undefined
        )?.value;
        db.prepare(
          `INSERT INTO learnings (content, status, created_at, evergreen, project_id,
                                  stable_event_id, occurred_at, origin_seq, event_type, schema_version)
           VALUES (?, 'stale', ?, 0, ?, ?, ?, ?, 'learning_captured', 1)`
        ).run(
          's86-m04 zzstaleprobe learning',
          new Date().toISOString(),
          projectId ?? 'cmos-mcp-pro',
          'M04STALEPROBE00000000000000'.slice(0, 26),
          Date.now(),
          999999
        );
        // s93-m11: the copy no longer carries stale decisions of its own once the first-write
        // repair has restored the live store's flagger-written rows, so seed one, stamped as an
        // explicit status update stamps it (a row the repair would leave alone too).
        const reviewColumn = (
          db.prepare(`PRAGMA table_info('strategic_decisions')`).all() as Array<{ name: string }>
        ).some((c) => c.name === 'last_reviewed_at');
        db.prepare(
          `INSERT INTO strategic_decisions (decision_text, status, created_at, project_id,
                                            stable_event_id, occurred_at, origin_seq, event_type,
                                            schema_version${reviewColumn ? ', last_reviewed_at' : ''})
           VALUES (?, 'stale', ?, ?, ?, ?, ?, 'decision_captured', 1${reviewColumn ? ', ?' : ''})`
        ).run(
          's93-m11 zzstaleprobe decision',
          new Date().toISOString(),
          projectId ?? 'cmos-mcp-pro',
          'M11STALEPROBE00000000000000'.slice(0, 26),
          Date.now(),
          999998,
          ...(reviewColumn ? [new Date().toISOString()] : [])
        );
      } finally {
        db.close();
      }

      const staleLearnings = await h.callOk('rbook_learnings', {
        action: 'list',
        status: 'stale',
        projectRoot: copyRoot,
      });
      check(
        "dist: rbook_learnings(list, status='stale') returns the real-store row the enum used to forbid",
        textOf(staleLearnings).includes('zzstaleprobe'),
        `text=${textOf(staleLearnings).slice(0, 160)}`
      );

      const staleDecisions = await h.callOk('rbook_decisions', {
        action: 'list',
        status: 'stale',
        projectRoot: copyRoot,
      });
      const staleDecisionData = staleDecisions.structuredContent?.data as
        | { decisions?: unknown[] }
        | undefined;
      check(
        "dist: rbook_decisions(list, status='stale') returns the stale decision the copy was seeded with",
        textOf(staleDecisions).includes('zzstaleprobe'),
        `got ${(staleDecisionData?.decisions ?? []).length}: ${textOf(staleDecisions).slice(0, 160)}`
      );

      // s86-m09: this compared the live store's size to ITSELF, two stat calls apart — it could
      // not fail, so it was a green light about nothing. Compare against the reading taken
      // BEFORE the fire, and on mtime as well as size (a same-size overwrite is still a write).
      const liveAfter = fs.statSync(liveDb);
      check(
        'the LIVE store was not written to by the m04 fire',
        liveAfter.size === liveBefore.size && liveAfter.mtimeMs === liveBefore.mtimeMs,
        `before=${liveBefore.size}b@${liveBefore.mtimeMs} after=${liveAfter.size}b@${liveAfter.mtimeMs}`
      );
    }

    // --- s86-m08 / m09: the move ACTION, the parked denominator, and the view migration -----
    //
    //     m08 added an action to an existing tool and changed two READ actions' numbers. m09
    //     owns proving the SHIPPED artifact does both — over stdio, against the BUILT dist,
    //     because a handler-only test proves the SQL compiles, not that the wire advertises it
    //     or that it runs against a real store's columns.
    {
      const m08Props = (tool: string): Record<string, { enum?: string[] }> =>
        ((tools.tools.find((t) => t.name === tool)?.inputSchema?.properties ?? {}) as Record<
          string,
          { enum?: string[] }
        >) ?? {};

      // (1) THE ACTION IS ON THE WIRE. A move implemented but unadvertised is a capability no
      //     MCP host can reach — the exact shape of the three params that shipped dead.
      const missionActions = m08Props('rbook_mission').action?.enum ?? [];
      check(
        "s86-m08: dist advertises rbook_mission(action='move') on the wire",
        missionActions.includes('move'),
        `got [${missionActions.join(',')}]`
      );
      check(
        's86-m08: adding the move action did NOT add a 16th tool',
        tools.tools.length === 15,
        `got ${tools.tools.length}`
      );

      const m08Dir = mkTmp('rbook-verify-s86m08-');
      await h.callOk('rbook_project', {
        action: 'init',
        projectRoot: m08Dir,
        name: 's86-m08 verify',
      });
      for (const [sprintId, title] of [
        ['sp-from', 'Origin sprint'],
        ['sp-to', 'Destination sprint'],
      ]) {
        await h.callOk('rbook_sprint', {
          action: 'add',
          sprintId,
          title,
          focus: 'verify the move + the parked denominator',
          projectRoot: m08Dir,
        });
      }
      for (const [missionId, name] of [
        ['mv-live', 'A mission that stays live'],
        ['mv-parked', 'A mission that gets parked'],
        ['mv-moved', 'A mission that gets moved'],
      ]) {
        await h.callOk('rbook_mission', {
          action: 'add',
          missionId,
          name,
          objective: 'exist so the denominator has something to count',
          sprintId: 'sp-from',
          projectRoot: m08Dir,
        });
      }

      // (2) THE MOVE ACTUALLY MOVES — asserted on the COLUMN, not the answer. An answer-only
      //     assertion passes against a handler that reports a move it never wrote.
      await h.callOk('rbook_mission', {
        action: 'move',
        missionId: 'mv-moved',
        toSprintId: 'sp-to',
        reason: 'verify:dist — the supported re-bind',
        projectRoot: m08Dir,
      });
      const m08Db = path.join(m08Dir, 'rbook', 'db', 'rbook.sqlite');
      const readM08 = <T>(fn: (db: Database.Database) => T): T => {
        const db = new Database(m08Db, { readonly: true });
        try {
          return fn(db);
        } finally {
          db.close();
        }
      };
      check(
        's86-m08: rbook_mission(move) rewrote missions.sprint_id to the destination',
        readM08(
          (db) =>
            (
              db.prepare(`SELECT sprint_id FROM missions WHERE id = 'mv-moved'`).get() as {
                sprint_id: string;
              }
            ).sprint_id
        ) === 'sp-to'
      );

      // (3) THE PARKED DENOMINATOR, on BOTH read actions. Deferring a mission must REMOVE it
      //     from totalMissions and surface it as parkedMissions — the whole point is that a
      //     sprint stops being punished in its own denominator for parking work honestly.
      await h.callOk('rbook_mission_transition', {
        action: 'defer',
        missionId: 'mv-parked',
        reason: 'verify:dist — park it so the denominator has something to exclude',
        projectRoot: m08Dir,
      });

      const m08List = await h.callOk('rbook_sprint', { action: 'list', projectRoot: m08Dir });
      const listRow = (
        ((m08List.structuredContent?.data as { sprints?: Array<Record<string, unknown>> })
          ?.sprints ?? []) as Array<Record<string, unknown>>
      ).find((s) => s.id === 'sp-from');
      check(
        's86-m08: rbook_sprint(list) carries parkedMissions and EXCLUDES the parked row from totalMissions',
        listRow?.totalMissions === 1 && listRow?.parkedMissions === 1,
        `total=${String(listRow?.totalMissions)} parked=${String(listRow?.parkedMissions)} (expected 1/1)`
      );

      const m08Show = await h.callOk('rbook_sprint', {
        action: 'show',
        sprintId: 'sp-from',
        projectRoot: m08Dir,
      });
      // The show payload is FLAT (rbook-sprint-show.ts:236-257) — the counts sit on `data`
      // itself, not under a nested `sprint` key as the list rows do.
      const showSprint = m08Show.structuredContent?.data as Record<string, unknown> | undefined;
      check(
        's86-m08: rbook_sprint(show) reports the SAME corrected pair — the two actions cannot drift',
        showSprint?.totalMissions === 1 && showSprint?.parkedMissions === 1,
        `total=${String(showSprint?.totalMissions)} parked=${String(showSprint?.parkedMissions)} (expected 1/1)`
      );

      // (4) The FOURTH newly-reachable param's ANSWER shape. The column write is asserted at
      //     (1) in the m03 block above; this is the published response contract beside it —
      //     a caller must be able to see whether the flag actually moved.
      await h.callOk('rbook_session', {
        action: 'start',
        type: 'planning',
        title: 'verify m08/m09',
        projectRoot: m08Dir,
      });
      await h.callOk('rbook_session', {
        action: 'capture',
        category: 'learning',
        content: 's86-m09 reaffirm answer-shape learning',
        projectRoot: m08Dir,
      });
      const m08LearningId = readM08(
        (db) =>
          (
            db
              .prepare(`SELECT id FROM learnings WHERE content LIKE '%reaffirm answer-shape%'`)
              .get() as { id: number } | undefined
          )?.id
      );
      if (m08LearningId !== undefined) {
        const reaffirmed = await h.callOk('rbook_learnings', {
          action: 'reaffirm',
          learningId: m08LearningId,
          evergreen: true,
          projectRoot: m08Dir,
        });
        const rd = reaffirmed.structuredContent?.data as
          | { previousEvergreen?: boolean; newEvergreen?: boolean }
          | undefined;
        check(
          's86-m03: rbook_learnings(reaffirm) reports previousEvergreen/newEvergreen so a caller sees the transition',
          rd?.previousEvergreen === false && rd?.newEvergreen === true,
          `previous=${String(rd?.previousEvergreen)} new=${String(rd?.newEvergreen)}`
        );
      }

      // (5) REAL-STORE POSITIVE FIRE for the view MIGRATION (agents.md Process Hardening #4,
      //     and m09 criterion 10). A tmpdir COPY of the live store still carries the OLD
      //     sprint_summary definition; driving the SHIPPED dist over stdio must upgrade it.
      //     A seeded fixture cannot prove this — it is created with the new view already.
      const liveForView = resolveRecordPaths(REPO_ROOT).dbPath;
      if (fs.existsSync(liveForView)) {
        // Read BEFORE the fire — comparing an after-reading to another after-reading is a check
        // that cannot fail, which is what the m04 block above shipped until this mission.
        const liveViewBefore = fs.statSync(liveForView);
        const viewRoot = mkTmp('rbook-verify-m09-viewmigration-');
        const viewDbDir = path.join(viewRoot, 'rbook', 'db');
        fs.mkdirSync(viewDbDir, { recursive: true });
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(`${liveForView}${suffix}`)) {
            fs.copyFileSync(
              `${liveForView}${suffix}`,
              path.join(viewDbDir, `rbook.sqlite${suffix}`)
            );
          }
        }
        const viewDb = path.join(viewDbDir, 'rbook.sqlite');
        const viewSql = (): string | undefined => {
          const db = new Database(viewDb, { readonly: true });
          try {
            return (
              db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sprint_summary'`).get() as
                | { sql: string }
                | undefined
            )?.sql;
          } finally {
            db.close();
          }
        };

        // DOWNGRADE THE COPY DETERMINISTICALLY, rather than depending on the live store still
        // being un-migrated.
        //
        // THIS IS A ONE-SHOT-PROOF BUG THE s86-m09 BUILD CRITIC CAUGHT IN THIS BLOCK. The first
        // version derived the "was old" precondition from whatever DDL the live store happened to
        // carry. That was true only until the live store got migrated — and s86-m09's OWN close
        // migrates it, because `ensureSprintSummaryView` upgrades the view on the first
        // rbook_sprint(list|show|analytics) against any writable store and criterion 21 requires
        // exactly that read. So the gate would have gone green once and then RED FOREVER, on the
        // repo's load-bearing release check, for a reason no future reader could have guessed.
        //
        // The proposition under test is "the SHIPPED dist upgrades a sprint_summary that lacks
        // parked_missions". That does not need a store that is accidentally old — it needs one
        // that is DEFINITELY old. So install the pre-s86-m08 definition on the COPY (never the
        // live store) and prove the migration on every future run.
        {
          const db = new Database(viewDb);
          try {
            db.exec('DROP VIEW IF EXISTS sprint_summary');
            db.exec(PRE_S86M08_SPRINT_SUMMARY_SQL);
          } finally {
            db.close();
          }
        }

        const beforeSql = viewSql();
        const wasOld = beforeSql !== undefined && !beforeSql.includes('parked_missions');
        check(
          's86-m09: the real-store COPY carries the OLD sprint_summary (no parked_missions) before the run',
          wasOld,
          `sql=${(beforeSql ?? 'MISSING').slice(0, 120)}`
        );

        await h.callOk('rbook_sprint', { action: 'analytics', projectRoot: viewRoot });
        await h.callOk('rbook_sprint', { action: 'list', projectRoot: viewRoot });

        let parkedReadable = false;
        let parkedDetail = '';
        try {
          const db = new Database(viewDb, { readonly: true });
          try {
            db.prepare('SELECT parked_missions FROM sprint_summary LIMIT 1').get();
            parkedReadable = true;
          } finally {
            db.close();
          }
        } catch (err) {
          parkedDetail = String(err);
        }
        check(
          's86-m09: after driving the BUILT dist, SELECT parked_missions FROM sprint_summary succeeds on that copy',
          wasOld && parkedReadable,
          parkedDetail
        );

        // …and the upgraded store still opens READ-ONLY through the same dist. The migration
        // performs DROP VIEW / CREATE VIEW; a read-only open must not attempt it and must not
        // throw. (This is the shipped client, required out of dist/ — not the source tree.)
        let readonlyOk = false;
        let readonlyDetail = '';
        try {
          const { RbookDatabaseClient } = require(
            path.join(REPO_ROOT, 'dist', 'tools', 'rbook', 'client.js')
          ) as {
            RbookDatabaseClient: {
              create: (o: {
                dbPath: string;
                readonly: boolean;
              }) => Promise<{ success: boolean; data?: { close: () => void } }>;
            };
          };
          const res = await RbookDatabaseClient.create({ dbPath: viewDb, readonly: true });
          readonlyOk = res.success === true;
          res.data?.close();
        } catch (err) {
          readonlyDetail = String(err);
        }
        check(
          's86-m09: opening the same upgraded copy READ-ONLY through the shipped dist does not throw',
          readonlyOk,
          readonlyDetail
        );

        const liveViewAfter = fs.statSync(liveForView);
        check(
          's86-m09: the LIVE store was not written to by the view-migration fire',
          liveViewAfter.size === liveViewBefore.size &&
            liveViewAfter.mtimeMs === liveViewBefore.mtimeMs,
          `before=${liveViewBefore.size}b@${liveViewBefore.mtimeMs} ` +
            `after=${liveViewAfter.size}b@${liveViewAfter.mtimeMs}`
        );
      }
    }

    // --- s86-m04 Part B: ACTION_PARAMS, checked against the COMPILED barrel ---------------
    //
    // The renderer reads RBOOK_ACTION_PARAMS from dist (scripts/generate-tool-reference.js), so a
    // map that exists in src and not in the build would produce a TOOL_REFERENCE.md that silently
    // reverted — except it cannot, because the renderer throws. This asserts the compiled side
    // directly, and asserts the thing that must NOT have changed: the wire payload.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const distBarrel = require(path.join(REPO_ROOT, 'dist', 'tools', 'rbook', 'index.js')) as {
      RBOOK_ACTION_PARAMS?: Record<string, Record<string, readonly string[]>>;
    };
    const distMaps = distBarrel.RBOOK_ACTION_PARAMS ?? {};
    const wireActionBearing = m04Tools.tools.filter((t) =>
      Array.isArray(
        (t.inputSchema?.properties as { action?: { enum?: unknown[] } } | undefined)?.action?.enum
      )
    );
    check(
      'dist barrel exports RBOOK_ACTION_PARAMS for exactly the action-bearing tools on the wire',
      Object.keys(distMaps).sort().join(',') ===
        wireActionBearing
          .map((t) => t.name)
          .sort()
          .join(','),
      `barrel=[${Object.keys(distMaps).sort()}] wire=[${wireActionBearing.map((t) => t.name).sort()}]`
    );
    check(
      'every action advertised on the wire has an ACTION_PARAMS list in the compiled barrel',
      wireActionBearing.every((t) => {
        const actions = ((t.inputSchema?.properties as { action?: { enum?: string[] } }).action
          ?.enum ?? []) as string[];
        return actions.every((a) => Array.isArray(distMaps[t.name]?.[a]));
      })
    );
    // THE PAYLOAD MUST NOT HAVE MOVED. ACTION_PARAMS is documentation input, so it lives beside
    // the definitions rather than on them; putting it ON a definition would ship a non-MCP key to
    // every host.
    //
    // CHECKED AT THE SOURCE OF THE LEAK, NOT AT THE CLIENT (build-time critic finding). The MCP
    // SDK parses `tools/list` through a zod schema that STRIPS unknown keys, so asserting the
    // absence of `actionParams` on `client.listTools()` output is unfalsifiable — it would hold
    // even if every definition carried the key. The compiled definition objects are where such a
    // key would exist, so that is where the negative is asserted.
    const distDefs = (
      require(path.join(REPO_ROOT, 'dist', 'tools', 'rbook', 'index.js')) as {
        RBOOK_TOOL_DEFINITIONS: Array<Record<string, unknown>>;
      }
    ).RBOOK_TOOL_DEFINITIONS;
    const MCP_TOOL_KEYS = new Set(['name', 'description', 'inputSchema', 'annotations', 'title']);
    const strayKeys = distDefs.flatMap((d) =>
      Object.keys(d)
        .filter((k) => !MCP_TOOL_KEYS.has(k))
        .map((k) => `${String(d.name)}.${k}`)
    );
    check(
      'no compiled tool definition carries a non-MCP key (ACTION_PARAMS stayed beside them)',
      strayKeys.length === 0,
      `stray=[${strayKeys.join(', ')}]`
    );
    // …and the falsifiability of THAT check, demonstrated rather than asserted: the same rule run
    // over a definition that DOES carry the key must report it.
    check(
      'that rule is falsifiable — it reports a planted non-MCP key',
      Object.keys({ ...distDefs[0], actionParams: {} }).filter((k) => !MCP_TOOL_KEYS.has(k))
        .length === 1
    );

    // ─── s87-m01: the mission-transition crash must not ship ────────────────────────────────
    //
    // THIS IS THE ONLY CHECK THAT SEES THE PUBLISHED ARTIFACT. 2.6.0 shipped a `TypeError` in
    // `dist/tools/rbook/errors.js`: `VALID_STATE_TRANSITIONS[currentStatus]` followed by an
    // unguarded `.length`, reached by six handlers, thrown for any stored status outside the
    // published enum — and this repo's own store holds mission B1.1 at status 'Archived'. The
    // in-process matrix in `tests/tools/rbook/remedy-reachability.test.ts` drives `src/`; only
    // this drives what npm receives.
    const RBOOK_DIST = path.join(REPO_ROOT, 'dist', 'tools', 'rbook');
    const distJs = fs
      .readdirSync(RBOOK_DIST)
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(RBOOK_DIST, f), 'utf8') }));

    // (a) EVERY dynamic lookup resolves through the shared guarded helper. A literal index
    //     (`VALID_STATE_TRANSITIONS['Blocked']`) is safe by construction and stays allowed; a
    //     variable index is the crash, and it may exist ONLY inside `transitionsFrom` itself.
    const dynamicIndexers = distJs
      .flatMap(({ file, text }) =>
        [...text.matchAll(/VALID_STATE_TRANSITIONS\[([^\]]*)\]/g)].map((m) => ({
          file,
          index: m[1].trim(),
        }))
      )
      .filter((h) => !/^['"`]/.test(h.index))
      .filter((h) => h.file !== 'errors.js');
    check(
      's87-m01: no dynamic VALID_STATE_TRANSITIONS index outside the shared guard',
      dynamicIndexers.length === 0,
      `unguarded=[${dynamicIndexers.map((h) => `${h.file}[${h.index}]`).join(', ')}]`
    );

    // (b) The helper is actually WIRED, at every site that used to carry the bare index. Named
    //     files, not a count — a count alone passes if six calls land in one file.
    const HELPER_CALLERS = [
      'rbook-mission-start.js',
      'rbook-mission-complete.js',
      'rbook-mission-block.js',
      'rbook-mission-drop.js',
      'rbook-mission-defer.js',
      'rbook-mission-update.js',
      'rbook-mission-move.js',
    ];
    // Matched against the COMPILED form: tsc emits a cross-module call as
    // `(0, errors_1.transitionsFrom)(currentStatus)`, so a bare `transitionsFrom(` substring
    // finds nothing and this check would have reported every handler missing while the guard was
    // in fact wired — a gate failing for a reason that has nothing to do with the code.
    const HELPER_CALL_RE = /\btransitionsFrom\s*\)?\s*\(/;
    const missingHelper = HELPER_CALLERS.filter(
      (f) => !HELPER_CALL_RE.test(distJs.find((d) => d.file === f)?.text ?? '')
    );
    check(
      `s87-m01: the shared guard is called in all ${HELPER_CALLERS.length} compiled handlers`,
      missingHelper.length === 0,
      `missing=[${missingHelper.join(', ')}]`
    );

    // (c) The corpus floor. Without it (a) passes trivially on a dist that lost the constant
    //     entirely — the vacuous-gate failure this sprint is named against.
    const totalLookupSites = distJs.reduce(
      (n, { text }) => n + [...text.matchAll(/VALID_STATE_TRANSITIONS\[/g)].length,
      0
    );
    check(
      's87-m01: the compiled lookup corpus is non-empty (floor 2: the guard + the literal index)',
      totalLookupSites >= 2,
      `sites=${totalLookupSites}`
    );

    // (d) THE BEHAVIOUR, over stdio, against the built server. Force an out-of-enum status into a
    //     real store the way import and peer-merge paths do, then drive every transition. Each
    //     must return a structured refusal that NAMES the status — not a TOOL_EXECUTION_ERROR
    //     telling the operator to retry a call that can never succeed.
    const projectDirM01 = mkTmp('rbook-verify-s87m01-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDirM01,
      projectName: 'verify-s87m01',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-m01',
      title: 'verify s87-m01',
      projectRoot: projectDirM01,
    });
    await h.callOk('rbook_mission', {
      action: 'add',
      missionId: 'vm-01',
      name: 'verify s87-m01 mission',
      sprintId: 'sprint-m01',
      projectRoot: projectDirM01,
    });
    const m01Db = new Database(path.join(projectDirM01, 'rbook', 'db', 'rbook.sqlite'));
    const forced = m01Db
      .prepare(`UPDATE missions SET status = 'Archived' WHERE id = 'vm-01'`)
      .run().changes;
    m01Db.close();
    check(
      's87-m01: the out-of-enum precondition was ESTABLISHED, not inherited',
      forced === 1,
      `changes=${forced}`
    );

    for (const action of ['start', 'complete', 'block', 'drop', 'defer'] as const) {
      const res = await h.callTool('rbook_mission_transition', {
        action,
        missionId: 'vm-01',
        reason: 'verify:dist s87-m01 probe',
        blockers: ['probe'],
        resolution: 'probe',
        projectRoot: projectDirM01,
      });
      const text = textOf(res);
      check(
        `s87-m01: rbook_mission_transition(${action}) on an out-of-enum status refuses, never crashes`,
        !/TOOL_EXECUTION_ERROR|internal error/i.test(text) && /unrecognized status/i.test(text),
        text.slice(0, 240)
      );
    }
    const updRes = await h.callTool('rbook_mission', {
      action: 'update',
      missionId: 'vm-01',
      fields: { status: 'Queued' },
      projectRoot: projectDirM01,
    });
    const updText = textOf(updRes);
    check(
      's94-m05: explicit update repairs an unknown mission status to Queued',
      updRes.isError !== true &&
        (h.dataOf(updRes) as { previousStatus?: string; currentStatus?: string })
          ?.previousStatus === 'Archived' &&
        (h.dataOf(updRes) as { currentStatus?: string })?.currentStatus === 'Queued' &&
        !/TOOL_EXECUTION_ERROR|internal error/i.test(updText),
      updText.slice(0, 400)
    );
    {
      const db = new Database(path.join(projectDirM01, 'rbook', 'db', 'rbook.sqlite'), {
        readonly: true,
      });
      try {
        const mission = db.prepare("SELECT status FROM missions WHERE id='vm-01'").get() as {
          status: string;
        };
        const history = db
          .prepare("SELECT raw_event FROM session_events WHERE mission='vm-01' AND action='update'")
          .all() as Array<{ raw_event: string }>;
        check(
          's94-m05: repair persists the requested status and its exact historical transition once',
          mission.status === 'Queued' &&
            history.length === 1 &&
            history.some((row) => {
              const event = JSON.parse(row.raw_event) as {
                previousStatus?: string;
                newStatus?: string;
              };
              return event.previousStatus === 'Archived' && event.newStatus === 'Queued';
            }),
          `status=${mission.status} history=${JSON.stringify(history)}`
        );
      } finally {
        db.close();
      }
    }

    // ─── s87-m08: the sprint's other answer-shape deltas, on the BUILT artifact ──────────────
    //
    // Each assertion below was proven RED by the stash recipe before it was accepted (stash the
    // src/ fix → rebuild → `npm run verify:dist` fails on THAT NAMED assertion → unstash →
    // rebuild → green). An assertion never seen red is not evidence, and this file is the only
    // gate that reads what npm actually receives.

    // s87-m02 — the close ENUMERATES what it archived and hands back an undo handle.
    const projectDirM02 = mkTmp('rbook-verify-s87m02-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDirM02,
      projectName: 'verify-s87m02',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-m02',
      title: 'verify s87-m02',
      projectRoot: projectDirM02,
    });
    // Seed one decision bound to the sprint so the close has something to archive — the assertion
    // must not pass by there being nothing to name. Minted through the SHIPPED writer
    // (mission complete → decisions[]) rather than by raw INSERT, so every NOT NULL column is
    // filled the way production fills it and the row is one the close can really see.
    await h.callOk('rbook_mission', {
      action: 'add',
      missionId: 'm02-probe',
      name: 'verify-dist archival probe',
      sprintId: 'sprint-m02',
      projectRoot: projectDirM02,
    });
    await h.callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 'm02-probe',
      projectRoot: projectDirM02,
    });
    await h.callOk('rbook_mission_transition', {
      action: 'complete',
      missionId: 'm02-probe',
      notes: 'verify:dist archival probe',
      decisions: ['verify-dist seeded decision for the s87-m02 archival disclosure gate'],
      projectRoot: projectDirM02,
    });

    const m02Db = new Database(path.join(projectDirM02, 'rbook', 'db', 'rbook.sqlite'));
    const seededRow = m02Db
      .prepare(
        `SELECT id FROM strategic_decisions
          WHERE status = 'active'
            AND (sprint_id = 'sprint-m02' OR mission_id = 'm02-probe')
          ORDER BY id DESC LIMIT 1`
      )
      .get() as { id: number } | undefined;
    m02Db.close();
    check(
      's87-m02: the probe really seeded an archivable decision (precondition, established not assumed)',
      typeof seededRow?.id === 'number',
      'no active decision bound to sprint-m02 — the archival assertion below would be vacuous'
    );
    const seededDecisionId = Number(seededRow?.id);

    // s92-m05: archival is opt-in since 3.2.0 (decision #1160), so this probe opts in.
    const closeRes = await h.callOk('rbook_sprint', {
      action: 'complete',
      sprintId: 'sprint-m02',
      summary: 'verify:dist s87-m02 probe',
      archive: true,
      projectRoot: projectDirM02,
    });
    const m02CloseData = h.dataOf(closeRes) as {
      lifecycle?: {
        archivedDecisionIds?: number[];
        decisionsArchived?: number;
        preCloseSnapshotId?: string | null;
      };
    } | null;
    const lifecycle = m02CloseData?.lifecycle;
    check(
      's87-m02: the shipped close returns archivedDecisionIds naming the row it archived',
      Array.isArray(lifecycle?.archivedDecisionIds) &&
        lifecycle.archivedDecisionIds.includes(seededDecisionId),
      `archivedDecisionIds=${JSON.stringify(lifecycle?.archivedDecisionIds)} seeded=${seededDecisionId}`
    );
    check(
      's87-m02: the enumerated ids and the reported count are the same fact',
      Array.isArray(lifecycle?.archivedDecisionIds) &&
        lifecycle.archivedDecisionIds.length === lifecycle?.decisionsArchived,
      `ids=${lifecycle?.archivedDecisionIds?.length} count=${lifecycle?.decisionsArchived}`
    );
    check(
      's87-m02: the shipped close returns a pre-close snapshot handle',
      typeof lifecycle?.preCloseSnapshotId === 'string' && lifecycle.preCloseSnapshotId.length > 0,
      `preCloseSnapshotId=${String(lifecycle?.preCloseSnapshotId)}`
    );
    check(
      's87-m02: the RENDERED close line names ids, not only a count',
      /Archived: \d+ decisions \(#\d+/.test(textOf(closeRes)),
      textOf(closeRes)
        .split('\n')
        .filter((l) => l.startsWith('Archived:'))
        .join(' | ')
    );

    // s92-m05 — a DEFAULT close keeps the sprint's decisions active (operator Q1, decision #1160).
    // Seeded through the same shipped writer as the s87-m02 probe, in a store of its own.
    const projectDirM05 = mkTmp('rbook-verify-s92m05-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDirM05,
      projectName: 'verify-s92m05',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-m05',
      title: 'verify s92-m05',
      projectRoot: projectDirM05,
    });
    await h.callOk('rbook_mission', {
      action: 'add',
      missionId: 'm05-probe',
      name: 'verify-dist keeps-record probe',
      sprintId: 'sprint-m05',
      projectRoot: projectDirM05,
    });
    await h.callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 'm05-probe',
      projectRoot: projectDirM05,
    });
    await h.callOk('rbook_mission_transition', {
      action: 'complete',
      missionId: 'm05-probe',
      notes: 'verify:dist keeps-record probe',
      decisions: ['verify-dist seeded decision for the s92-m05 keeps-record gate'],
      projectRoot: projectDirM05,
    });
    const activeM05Decisions = (): number[] => {
      const db = new Database(path.join(projectDirM05, 'rbook', 'db', 'rbook.sqlite'));
      try {
        return (
          db
            .prepare(
              `SELECT id FROM strategic_decisions
                WHERE status = 'active'
                  AND (sprint_id = 'sprint-m05' OR mission_id = 'm05-probe')
                ORDER BY id`
            )
            .all() as Array<{ id: number }>
        ).map((row) => row.id);
      } finally {
        db.close();
      }
    };
    const keptBefore = activeM05Decisions();
    check(
      's92-m05: the probe really seeded a decision a 3.1.0 close would archive (precondition)',
      keptBefore.length > 0,
      'no active decision bound to sprint-m05 — the keeps-record assertions below would be vacuous'
    );
    const defaultCloseRes = await h.callOk('rbook_sprint', {
      action: 'complete',
      sprintId: 'sprint-m05',
      summary: 'verify:dist s92-m05 probe',
      projectRoot: projectDirM05,
    });
    const m05Lifecycle = (
      h.dataOf(defaultCloseRes) as {
        lifecycle?: { archived?: boolean; archivedDecisionIds?: number[] };
      } | null
    )?.lifecycle;
    check(
      's92-m05: the shipped default close reports archived: false and names no archived id',
      m05Lifecycle?.archived === false &&
        Array.isArray(m05Lifecycle.archivedDecisionIds) &&
        m05Lifecycle.archivedDecisionIds.length === 0,
      `archived=${String(m05Lifecycle?.archived)} ids=${JSON.stringify(m05Lifecycle?.archivedDecisionIds)}`
    );
    const keptAfter = activeM05Decisions();
    check(
      "s92-m05: the shipped default close leaves the sprint's decisions active",
      JSON.stringify(keptAfter) === JSON.stringify(keptBefore),
      `before=${JSON.stringify(keptBefore)} after=${JSON.stringify(keptAfter)}`
    );

    // s92-m04 — the recommended order (record, then start, then complete) is not told "No decisions
    // captured", and the receipt reports the mission's true count. 3.1.0 counted only decisions[].
    const projectDirM04 = mkTmp('rbook-verify-s92m04-');
    await h.callOk('rbook_project', {
      action: 'init',
      projectRoot: projectDirM04,
      projectName: 'verify-s92m04',
    });
    await h.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-m04',
      title: 'verify s92-m04',
      projectRoot: projectDirM04,
    });
    await h.callOk('rbook_mission', {
      action: 'add',
      missionId: 'm04-probe',
      name: 'verify-dist recorded-decisions probe',
      sprintId: 'sprint-m04',
      projectRoot: projectDirM04,
    });
    for (const content of [
      'verify-dist s92-m04: recorded before the mission started',
      'verify-dist s92-m04: a second recorded decision',
    ]) {
      await h.callOk('rbook_decisions', {
        action: 'record',
        content,
        missionId: 'm04-probe',
        projectRoot: projectDirM04,
      });
    }
    await h.callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 'm04-probe',
      projectRoot: projectDirM04,
    });
    const m04Complete = await h.callOk('rbook_mission_transition', {
      action: 'complete',
      missionId: 'm04-probe',
      notes: 'verify:dist recorded-decisions probe',
      projectRoot: projectDirM04,
    });
    const m04Data = h.dataOf(m04Complete) as { missionDecisionCount?: number } | null;
    check(
      "s92-m04: record, then start, then complete is not told 'No decisions captured'",
      !textOf(m04Complete).includes('No decisions captured'),
      textOf(m04Complete)
        .split('\n')
        .filter((l) => /decision/i.test(l))
        .join(' | ')
    );
    check(
      "s92-m04: the completion receipt reports the mission's recorded decisions",
      m04Data?.missionDecisionCount === 2 &&
        textOf(m04Complete).includes('Decisions recorded for this mission: 2'),
      `missionDecisionCount=${String(m04Data?.missionDecisionCount)}`
    );

    // s92-m07 — search drops only superseded rows (R1), and health names the semantic-search state.
    for (const content of [
      'verify-dist s92-m07: quarantine the retired ledger shard, archived later',
      'verify-dist s92-m07: quarantine the ledger shard in memory, superseded later',
    ]) {
      await h.callOk('rbook_decisions', { action: 'record', content, projectRoot: projectDirM04 });
    }
    {
      const db = new Database(path.join(projectDirM04, 'rbook', 'db', 'rbook.sqlite'));
      try {
        db.prepare(
          `UPDATE strategic_decisions SET status = 'archived' WHERE decision_text LIKE '%archived later'`
        ).run();
        db.prepare(
          `UPDATE strategic_decisions SET status = 'superseded' WHERE decision_text LIKE '%superseded later'`
        ).run();
      } finally {
        db.close();
      }
    }
    const m07Search = await h.callOk('rbook_context', {
      action: 'search',
      query: 'quarantine ledger shard',
      projectRoot: projectDirM04,
    });
    const m07Hits =
      (h.dataOf(m07Search) as { results?: Array<{ status: string | null; text: string }> } | null)
        ?.results ?? [];
    check(
      's92-m07: the shipped search returns an archived decision, marked archived, and no superseded one',
      m07Hits.some((hit) => hit.status === 'archived' && hit.text.includes('archived later')) &&
        !m07Hits.some((hit) => hit.status === 'superseded') &&
        textOf(m07Search).includes(', archived'),
      JSON.stringify(m07Hits.map((hit) => hit.status))
    );
    // s92-m09 — a session close's persist copies store no content, and the shipped prune dry-runs
    // with bytes per context, then applies without deleting a row.
    await h.callOk('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'verify s92-m09',
      projectRoot: projectDirM04,
    });
    await h.callOk('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'verify-dist s92-m09 persist-copy probe',
      projectRoot: projectDirM04,
    });
    await h.callOk('rbook_session', {
      action: 'complete',
      summary: 'verify:dist s92-m09',
      projectRoot: projectDirM04,
    });
    const m09Db = path.join(projectDirM04, 'rbook', 'db', 'rbook.sqlite');
    const m09Copies = (() => {
      const db = new Database(m09Db, { readonly: true });
      try {
        return db
          .prepare(
            `SELECT content, content_pruned_at FROM context_snapshots WHERE source LIKE 'session_complete:%'`
          )
          .all() as Array<{ content: string; content_pruned_at: string | null }>;
      } finally {
        db.close();
      }
    })();
    check(
      's92-m09: the shipped session close writes content-less, stamped persist copies',
      m09Copies.length > 0 &&
        m09Copies.every((row) => row.content === '' && row.content_pruned_at !== null),
      JSON.stringify(m09Copies.map((row) => [row.content.length, row.content_pruned_at !== null]))
    );
    const m09Dry = await h.callOk('rbook_db', {
      action: 'prune_snapshots',
      keepLast: 0,
      projectRoot: projectDirM04,
    });
    const m09DryData = h.dataOf(m09Dry) as {
      applied?: boolean;
      perContext?: Array<{ bytes?: number }>;
    } | null;
    check(
      's92-m09: the shipped prune dry run reports bytes per context and changes nothing',
      m09DryData?.applied === false &&
        Array.isArray(m09DryData.perContext) &&
        m09DryData.perContext.length > 0 &&
        m09DryData.perContext.every((c) => typeof c.bytes === 'number') &&
        textOf(m09Dry).includes('confirm=true'),
      JSON.stringify(m09DryData?.perContext)
    );
    const rowCount = (): number => {
      const db = new Database(m09Db, { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM context_snapshots').get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const rowsBefore = rowCount();
    const m09Apply = await h.callOk('rbook_db', {
      action: 'prune_snapshots',
      keepLast: 0,
      confirm: true,
      projectRoot: projectDirM04,
    });
    const m09ApplyData = h.dataOf(m09Apply) as {
      applied?: boolean;
      dbSnapshotId?: string | null;
      tombstoned?: number;
      prunable?: number;
    } | null;
    check(
      's92-m09: the shipped prune applies behind a database snapshot and keeps every row',
      m09ApplyData?.applied === true &&
        rowCount() === rowsBefore &&
        (m09ApplyData.prunable === 0 || typeof m09ApplyData.dbSnapshotId === 'string'),
      JSON.stringify(m09ApplyData)
    );
    // s92-m09 (the blocking critic's B2) — a named snapshot of content an update copy already
    // holds gets its own row in the shipped build, so a prune that reclaims the copy keeps the name.
    const m09Update = await h.callOk('rbook_context', {
      action: 'update',
      mode: 'manual',
      contextType: 'master_context',
      arrayUpdates: { context_notes: ['verify-dist s92-m09 protected dedup'] },
      projectRoot: projectDirM04,
    });
    const m09UpdateId = (h.dataOf(m09Update) as { snapshotId?: number | null } | null)?.snapshotId;
    const m09Named = await h.callOk('rbook_context', {
      action: 'snapshot',
      contextType: 'master_context',
      source: 'verify-dist named save point',
      projectRoot: projectDirM04,
    });
    const m09NamedData = h.dataOf(m09Named) as { snapshotId?: number; isNew?: boolean } | null;
    check(
      's92-m09: the shipped named snapshot gets its own row when only an update copy holds its content',
      typeof m09UpdateId === 'number' &&
        m09NamedData?.isNew === true &&
        m09NamedData.snapshotId !== m09UpdateId,
      JSON.stringify({ m09UpdateId, m09NamedData })
    );

    const m07Health = await h.callOk('rbook_db', { action: 'health', projectRoot: projectDirM04 });
    const m07Semantic = (
      h.dataOf(m07Health) as { semanticSearch?: { enabled?: boolean; state?: string } } | null
    )?.semanticSearch;
    check(
      's92-m07: the shipped health check reports the semantic-search state',
      typeof m07Semantic?.enabled === 'boolean' &&
        ['loaded', 'installed', 'not-installed', 'failed'].includes(m07Semantic?.state ?? '') &&
        /Semantic search\*\*: (on|off) — /.test(textOf(m07Health)),
      JSON.stringify(m07Semantic)
    );

    // s87-m03 — the drift reason says what the mechanism measures. Asserted on the SHIPPED
    // strings rather than on a live fleet, because a one-project verify:dist store degrades
    // `portfolio` to null and would make a behavioural assertion vacuous.
    /**
     * READ THE CODE, NOT THE PROSE.
     *
     * The first draft of the two m03 checks below searched the whole compiled file and PASSED on
     * a comment — `// "freshness unknown" path.` — while the emitted string literal had been
     * replaced. A gate that reports on a sentence nobody executes is the exact defect this sprint
     * exists to close, committed inside the sprint's own gate; it was caught by the red phase, not
     * by review. So every source-level assertion here reads comment-stripped code.
     *
     * Whole-line stripping only: a trailing `//` inside a string literal (a URL) must not truncate
     * the code around it, and every comment occurrence that fooled the draft was on its own line.
     */
    const codeOf = (rel: string): string =>
      fs
        .readFileSync(path.join(REPO_ROOT, 'dist', 'tools', 'rbook', rel), 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');

    const reviewSrc = codeOf('rbook-review.js');
    check(
      's87-m03: the shipped drift reason says "no new Reasonbook rows", never "no Reasonbook write"',
      reviewSrc.includes('no new Reasonbook rows in') &&
        !reviewSrc.includes('no Reasonbook write in'),
      `rows=${reviewSrc.includes('no new Reasonbook rows in')} writes=${reviewSrc.includes('no Reasonbook write in')}`
    );
    check(
      's87-m03: the shipped drift classifier reports freshness-unknown rather than guessing',
      reviewSrc.includes('freshness unknown — no readable row stamps'),
      'the probe-null path must not be silently absent from dist — and the bare phrase is not ' +
        'enough, since it also occurs in prose'
    );

    // s87-m05 — a send with no messageId renders no `ID: undefined`. Asserted on the compiled
    // renderer: the verify:dist environment has no dashboard auth, so a live send is not available
    // and a behavioural probe here would assert nothing.
    const messageSrc = codeOf('rbook-message.js');
    // Every line that renders the id must carry its own guard. Stated this way rather than as
    // "the guarded form is present" because the guarded and unguarded forms differ only by a
    // prefix — an assertion that merely finds `${d.messageId}` passes on the broken code too.
    const idRenderLines = messageSrc.split('\n').filter((l) => /ID: \$\{[^}]*messageId/.test(l));
    check(
      's87-m05: every shipped ID-render line is guarded — no unconditional `ID: undefined`',
      idRenderLines.length > 0 && idRenderLines.every((l) => /messageId\s*\?/.test(l)),
      idRenderLines.length === 0
        ? 'no ID render line found at all — the assertion would be vacuous'
        : idRenderLines.map((l) => l.trim()).join(' || ')
    );
    check(
      's87-m05: the shipped send reads the key the dashboard actually returns',
      messageSrc.includes('response.messageId'),
      'reading only response.id yields undefined on the send route'
    );

    // ── s89-m08: ARC F ITEM 1 — the wrong-typed published string parameter, ASSERTED ON THE
    //     ARTIFACT, not just on the in-process routers (s87-m01 hole 8).
    //
    //     RED against the SHIPPED 2.8.0 artifact, measured over stdio: `rbook_mission(action="show",
    //     missionId: 12345)` returned isError with code TOOL_EXECUTION_ERROR, the message
    //     "params.missionId.trim is not a function", and the suggestion "This is an internal error,
    //     not an input-validation problem — retry the call". Both halves were false: the cause WAS
    //     input validation, and "retry the call" is a loop with no exit. 42 (tool, action,
    //     declared-string-parameter) triples crashed this way (decision #1117).
    //
    //     The in-process gate is tests/tools/rbook/suggestion-oracle.test.ts; this is the dist leg.
    for (const [tool, args, field] of [
      ['rbook_mission', { action: 'show', missionId: 12345 }, 'missionId'],
      ['rbook_mission_transition', { action: 'start', missionId: 12345 }, 'missionId'],
      ['rbook_sprint', { action: 'show', sprintId: 12345 }, 'sprintId'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const wrongTyped = await h.callTool(tool, { ...args, projectRoot: projectDir });
      const envelope = (
        wrongTyped as { structuredContent?: { error?: { code?: string; field?: string } } }
      ).structuredContent?.error;
      const text = textOf(wrongTyped);
      check(
        `s89-m08: dist ${tool} refuses a wrong-typed ${field} as INVALID_PARAMETER naming the field`,
        envelope?.code === 'INVALID_PARAMETER' && envelope.field === field,
        `got code=${envelope?.code} field=${envelope?.field}; text="${text.slice(0, 160).replace(/\n/g, ' ')}"`
      );
      check(
        `s89-m08: dist ${tool} no longer answers a wrong-typed ${field} with a .trim crash`,
        !text.includes('.trim is not a function'),
        text.slice(0, 200).replace(/\n/g, ' ')
      );
      check(
        `s89-m08: dist ${tool} never claims "not an input-validation problem" for this input`,
        !text.includes('not an input-validation problem'),
        text.slice(0, 200).replace(/\n/g, ' ')
      );
    }

    // The catch-all boundary's own string must not reassert a cause it cannot know, ANYWHERE in
    // the shipped bundle — asserted on the compiled bytes so a reverted src/ reword is caught.
    check(
      's89-m08: the shipped bundle contains no "not an input-validation problem" claim',
      !codeOf('../../index.js').includes('not an input-validation problem'),
      'the catch-all boundary still asserts a cause it has no way to determine'
    );
  } finally {
    await h.close();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures > 0) {
    console.error(`\nverify:dist FAILED — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nverify:dist PASSED — all answer-shape checks green.');
}

main().catch((err) => {
  console.error('verify:dist crashed:', err);
  process.exit(1);
});

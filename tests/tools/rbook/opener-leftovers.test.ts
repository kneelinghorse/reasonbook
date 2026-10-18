// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — the opener and answer leftovers the sprint-92 review found on 3.2.0 (#606 b, d,
// ABOUTME: e, f, h), each proven against the real code. (a), (c), (g) and (i) are pinned where they live.

/**
 * Where the others live: (a) whoami gated on dashboard use — honest-opener.test.ts and
 * rbook-agent-onboard.test.ts; (c) every answer names its project — index.preflight.test.ts and
 * resolution-safety-dispatch.test.ts, and an error answer here; (g) list never prunes, the opener writes no owner metadata —
 * reads-never-write.test.ts and rbook-project.test.ts; (i) quiet shutdown — index.runtime.test.ts.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  probeClientRoots,
} from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  rbookAgentOnboard,
  formatAgentOnboardForLLM,
} from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookMissionTransition } from '../../../src/tools/rbook/rbook-mission-transition';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { deriveDrift, driftContentProbe } from '../../../src/tools/rbook/rbook-review';
import { withClient } from '../../../src/tools/rbook/client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import {
  ensureAuthorNameColumns,
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from '../../../src/tools/rbook/schema-migrations';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  RbookDetector.resetInstance();
});

describe('(b) roots/list goes only to a client that declared the roots capability', () => {
  it('a client without the capability is never asked, so a first call cannot stall on it', async () => {
    const listRoots = jest.fn(async () => ({ roots: [{ uri: 'file:///repos/a' }] }));
    const roots = await probeClientRoots({
      getClientCapabilities: () => ({}),
      listRoots,
    } as never);
    expect(listRoots).not.toHaveBeenCalled();
    expect(roots).toEqual([]);
  });

  it('POSITIVE CONTROL: a client that declared roots is asked, and its file roots are read', async () => {
    const listRoots = jest.fn(async () => ({
      roots: [{ uri: 'file:///repos/a' }, { uri: 'https://not-a-file' }],
    }));
    const roots = await probeClientRoots({
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots,
    } as never);
    expect(listRoots).toHaveBeenCalledTimes(1);
    expect(roots).toEqual(['/repos/a']);
  });
});

describe('(c) an error answer names the project too', () => {
  it('a show of a decision the project does not hold opens with the Project line', async () => {
    // The contract critic's probe: the first line used to be "❌ Failed to show decision".
    const projectRoot = tmp('rbook-s93m11-c-');
    seedRbookDb(projectRoot, { projectName: 'leftover c' });
    reidentifyRbookTestStore(projectRoot);
    const context = await buildMissionProtocolContext();
    const result = await executeMissionProtocolTool(
      'rbook_decisions',
      { action: 'show', decisionId: 99999, projectRoot },
      context
    );
    expect(result.isError).toBe(true);
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    const [first, blank, third] = text.split('\n');
    expect(first).toBe(`Project: ${path.resolve(projectRoot)}`);
    expect(blank).toBe('');
    expect(third).toMatch(/^❌/);
  });
});

describe('(d) onboard text never points at a field only the structured payload carries', () => {
  it('a fresh project is told to follow the tierSelectionPrompt, and the text shows it', async () => {
    const root = tmp('rbook-s93m11-d-');
    seedRbookDb(root, { projectName: 'fresh' });
    reidentifyRbookTestStore(root);
    const onboard = await rbookAgentOnboard({ projectRoot: root, callerProvidedProjectRoot: true });
    expect(onboard.data!.tierSelectionPrompt).toBeDefined();
    const text = formatAgentOnboardForLLM(onboard);
    expect(text).toContain('Follow the tierSelectionPrompt');
    expect(text).toContain(onboard.data!.tierSelectionPrompt!);
  });
});

describe('(e) a project with no history is not drifting', () => {
  const store = { project_id: 'new', store_path: '/nowhere', name: 'new project' };

  it('the probe reads an empty store as no history, and drift leaves it out', () => {
    const root = tmp('rbook-s93m11-e-');
    const dbPath = seedRbookDb(root, { projectName: 'new project' });
    const db = new Database(dbPath, { readonly: true });
    let probed: ReturnType<typeof driftContentProbe>;
    try {
      probed = driftContentProbe(db);
    } finally {
      db.close();
    }
    expect(probed).toBe('no-history');

    const partition = deriveDrift([store], [], () => null, Date.now(), new Map([['new', probed]]));
    expect(partition).toMatchObject({ reachable: 1, silent: 0, drift: null });
  });

  it('POSITIVE CONTROL: a store with rows but no readable stamp is still reported as unknown', () => {
    const root = tmp('rbook-s93m11-e2-');
    const dbPath = seedRbookDb(root, { projectName: 'unstamped' });
    const write = new Database(dbPath);
    write
      .prepare("INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'One', 'Active')")
      .run();
    write.close();
    const db = new Database(dbPath, { readonly: true });
    let probed: ReturnType<typeof driftContentProbe>;
    try {
      probed = driftContentProbe(db);
    } finally {
      db.close();
    }
    expect(probed).toBeNull();
    const partition = deriveDrift([store], [], () => null, Date.now(), new Map([['new', probed]]));
    expect(partition.drift?.stale[0].reason).toMatch(/freshness unknown/);
  });
});

describe('(f) init names its remedy and warns on a temporary folder', () => {
  it('without projectRoot it refuses with the call to make, not a schema message', async () => {
    const refused = await rbookProjectInit({} as never);
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('MISSING_PARAMETER');
    expect(refused.error?.suggestion).toContain('rbook_project(action="init", projectRoot=');
    expect(refused.error?.message).not.toMatch(/Validation error|Required/);
  });

  it('in the OS temp folder it warns, as register does, that a validate prune archives it', async () => {
    const root = tmp('rbook-s93m11-f-');
    const init = await rbookProjectInit({ projectRoot: root, projectName: 'scratch' } as never);
    expect(init.success).toBe(true);
    expect(init.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('is in an ephemeral location')])
    );
  });
});

describe('(h) a failed learnings count says so', () => {
  it('omits the count and warns, instead of nudging as though none were recorded', async () => {
    const root = tmp('rbook-s93m11-h-');
    const dbPath = seedRbookDb(root, { projectName: 'counts' });
    reidentifyRbookTestStore(root);
    const db = new Database(dbPath);
    try {
      db.prepare(
        "INSERT INTO sprints (id, title, status) VALUES ('sprint-h', 'H', 'Active')"
      ).run();
      db.prepare(
        "INSERT INTO missions (id, sprint_id, name, status) VALUES ('h-m01', 'sprint-h', 'H', 'In Progress')"
      ).run();
    } finally {
      db.close();
    }
    // Migrate first, so the lazy migrations are done before learnings stops being a table.
    await withClient(
      (client) => {
        ensureFirehoseEventColumns(client);
        ensureAuthorNamespaceColumns(client);
        ensureAuthorNameColumns(client);
        return createSuccess(null);
      },
      { projectRoot: root }
    );
    const swap = new Database(dbPath);
    try {
      // The count's reader: learnings becomes a view with no mission_id, so the count fails.
      swap.exec('ALTER TABLE learnings RENAME TO learnings_backing');
      swap.exec('CREATE VIEW learnings AS SELECT id, content FROM learnings_backing');
    } finally {
      swap.close();
    }

    const completed = await rbookMissionTransition({
      action: 'complete',
      missionId: 'h-m01',
      notes: 'done',
      projectRoot: root,
    });
    expect(completed.success).toBe(true);
    expect((completed.data as { learningCount?: number }).learningCount).toBeUndefined();
    const warnings = completed.warnings ?? [];
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Could not count this mission's learnings")])
    );
    expect(warnings.join('\n')).not.toContain('No learnings captured for this mission');
  });
});

describe('(#600) a stale server shows where sessions open', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const health =
    require('../../../src/server-health') as typeof import('../../../src/server-health');
  const { rbookReview } =
    require('../../../src/tools/rbook/rbook-review') as typeof import('../../../src/tools/rbook/rbook-review');
  /* eslint-enable @typescript-eslint/no-require-imports */

  afterEach(() => {
    health.resetServerHealth();
  });

  /** A checkout whose dist/ was rebuilt after the server started, holding its own store. */
  function staleCheckout(): string {
    const root = tmp('rbook-s93m11-600-');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'restart-session-server.sh'), '#!/bin/sh\n');
    const manifest = (hash: string): string =>
      JSON.stringify({ buildHash: hash, buildTime: new Date().toISOString(), fileCount: 1 });
    fs.writeFileSync(path.join(root, 'dist', '.build-manifest.json'), manifest('a'.repeat(64)));
    health.initServerHealth(root);
    fs.writeFileSync(path.join(root, 'dist', '.build-manifest.json'), manifest('b'.repeat(64)));
    seedRbookDb(root, { projectName: 'server checkout' });
    reidentifyRbookTestStore(root);
    return root;
  }

  it("in the server's own checkout, the opener's actions and text name the restart script", async () => {
    const root = staleCheckout();
    const review = await rbookReview({ projectRoot: root }, { callerProvidedProjectRoot: true });
    expect(review.data!.next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'scripts/restart-session-server.sh', priority: 0 }),
      ])
    );
    const { formatReviewForLLM } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src/tools/rbook/rbook-review') as typeof import('../../../src/tools/rbook/rbook-review');
    expect(formatReviewForLLM(review)).toContain('scripts/restart-session-server.sh');

    // The contract critic: onboard's stale-server warning still said "Start a new IDE/host session
    // or reconnect" beside the action naming the script. The warning now states the fact only.
    const onboard = formatAgentOnboardForLLM(await rbookAgentOnboard({ projectRoot: root }));
    expect(onboard).toContain('scripts/restart-session-server.sh');
    expect(onboard).toContain('running stale code');
    expect(onboard).not.toContain('IDE/host session');
  });

  it('in any other project the remedy is to restart the MCP server, never the script', async () => {
    staleCheckout();
    const other = tmp('rbook-s93m11-600-other-');
    seedRbookDb(other, { projectName: 'sibling' });
    reidentifyRbookTestStore(other);
    const onboard = await rbookAgentOnboard({
      projectRoot: other,
      callerProvidedProjectRoot: true,
    });
    const commands = onboard.data!.suggestedActions.map((a) => a.command);
    expect(commands).toContain(
      'Restart the MCP server (the host starts it again on the current build)'
    );
    expect(commands).not.toContain('scripts/restart-session-server.sh');
  });

  it('POSITIVE CONTROL: a current server prescribes no restart at all', async () => {
    const root = tmp('rbook-s93m11-600-current-');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(
      path.join(root, 'dist', '.build-manifest.json'),
      JSON.stringify({
        buildHash: 'c'.repeat(64),
        buildTime: new Date().toISOString(),
        fileCount: 1,
      })
    );
    health.initServerHealth(root);
    seedRbookDb(root, { projectName: 'current' });
    reidentifyRbookTestStore(root);
    const onboard = await rbookAgentOnboard({ projectRoot: root, callerProvidedProjectRoot: true });
    expect(onboard.data!.suggestedActions.map((a) => a.command).join('\n')).not.toMatch(
      /restart|reconnect/i
    );
  });
});

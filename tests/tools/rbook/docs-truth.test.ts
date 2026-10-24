// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m06 — the behaviours behind docs that are true for a stranger: AGENTS.md at init,
// ABOUTME: a general-tier review with no mission talk, and the shipped claims the audit refuted.

/**
 * The universe is published in rbook/docs/s92-m06-docs-truth.md (practice 8). These tests pin the
 * items that changed behaviour or a tool definition, and the cross-document claims a reader could
 * act on: Node 20, the snapshot sentence, the full-file upload, and what `DASHBOARD_NOT_CONFIGURED`
 * means. Prose tokens are kept honest by tests/docs/shipped-prose-truth.test.ts and internal
 * references by tests/docs/internal-references.test.ts.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RBOOK_TOOL_DEFINITIONS } from '../../../src/tools/rbook';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookReview, formatReviewForLLM } from '../../../src/tools/rbook/rbook-review';
import { RbookErrors } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  createSeededRbookProject,
  reidentifyRbookTestStore,
  type SeededRbookProject,
} from '../../helpers/seedRbookDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  RbookDetector.resetInstance();
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rbook-s92m06-${label}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Exact-case names in a directory: a case-insensitive filesystem cannot answer this by existsSync. */
const namesIn = (dir: string): string[] => fs.readdirSync(dir);

// ─── AGENTS.md ───────────────────────────────────────────────────────────────

describe('s92-m06 — init writes an uppercase AGENTS.md', () => {
  it('a new project gets AGENTS.md at its root, and CLAUDE.md points at it', async () => {
    const root = tempRoot('agents');
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(namesIn(root)).toContain('AGENTS.md');
    expect(namesIn(root)).not.toContain('agents.md');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('Hard Operating Rules');
    expect(namesIn(path.join(root, 'rbook', 'templates'))).toContain('AGENTS.md');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('`AGENTS.md`');
    expect(result.data?.created.files ?? []).toContain(path.join('..', 'AGENTS.md'));
  });

  it('an existing lowercase agents.md is detected and left alone; no second file is written', async () => {
    const root = tempRoot('lower');
    fs.writeFileSync(path.join(root, 'agents.md'), '# our own rules\n');
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(namesIn(root).filter((n) => n.toLowerCase() === 'agents.md')).toEqual(['agents.md']);
    expect(fs.readFileSync(path.join(root, 'agents.md'), 'utf8')).toBe('# our own rules\n');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('`agents.md`');
  });

  it('any casing counts, and a second init keeps an edited AGENTS.md', async () => {
    const mixed = tempRoot('mixed');
    fs.writeFileSync(path.join(mixed, 'Agents.md'), 'mixed case\n');
    await rbookProjectInit({ projectRoot: mixed });
    expect(namesIn(mixed).filter((n) => n.toLowerCase() === 'agents.md')).toEqual(['Agents.md']);

    const root = tempRoot('again');
    await rbookProjectInit({ projectRoot: root });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'edited\n');
    RbookDetector.resetInstance();
    await rbookProjectInit({ projectRoot: root });
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('edited\n');
  });

  it('the shipped template is uppercase and says where it belongs', () => {
    expect(namesIn(path.join(REPO_ROOT, 'rbook-seed', 'templates'))).toContain('AGENTS.md');
    expect(namesIn(path.join(REPO_ROOT, 'rbook-seed', 'templates'))).not.toContain('agents.md');
    expect(read('rbook-seed/templates/AGENTS.md')).toContain('project-root/AGENTS.md');
  });
});

// ─── The general tier ────────────────────────────────────────────────────────

async function seeded(tier: string): Promise<SeededRbookProject> {
  const project = await createSeededRbookProject({ tier }, `rbook-s92m06-${tier}-`);
  cleanups.push(() => project.cleanup());
  reidentifyRbookTestStore(project.projectRoot);
  return project;
}

describe('s92-m06 — review tells a general-tier project nothing about missions', () => {
  it('a general-tier project with no work gets no work-queue line and no add-missions advice', async () => {
    const { projectRoot } = await seeded('general');
    const review = await rbookReview({ projectRoot }, { callerProvidedProjectRoot: true });
    expect(review.success).toBe(true);
    expect(review.data!.project.tier).toBe('general');
    expect(review.data!.workQueue.nextAction).toBe('Nothing in progress.');
    const text = formatReviewForLLM(review);
    expect(text).not.toContain('Work queue');
    expect(text).not.toMatch(/Add new missions|missions? in queue/);
  });

  it('POSITIVE CONTROL: a build-tier project still sees its work queue and the add-missions advice', async () => {
    const { projectRoot } = await seeded('build');
    const review = await rbookReview({ projectRoot }, { callerProvidedProjectRoot: true });
    const text = formatReviewForLLM(review);
    expect(text).toContain('Work queue — InProgress:0');
    expect(review.data!.workQueue.nextAction).toContain('Add new missions');
  });
});

// ─── Tool definitions fixed at their source ──────────────────────────────────

function definition(name: string): Record<string, unknown> {
  const found = (RBOOK_TOOL_DEFINITIONS as unknown as Array<Record<string, unknown>>).find(
    (d) => d.name === name
  );
  expect(found).toBeDefined();
  return found!;
}

describe('s92-m06 — tool definitions say what the code does', () => {
  it('rbook_message names the device-code sign-in, not password environment variables', () => {
    const text = String(definition('rbook_message').description);
    expect(text).not.toMatch(/RBOOK_DASHBOARD_(USER|PASSWORD)/);
    expect(text).toContain('rbook_auth(action="login_init")');
  });

  it('maxSnapshots is described as the retention cap it is', () => {
    const props = (
      definition('rbook_db').inputSchema as { properties: Record<string, { description: string }> }
    ).properties;
    expect(props.maxSnapshots.description).toMatch(/keep/);
    expect(props.maxSnapshots.description).toMatch(/deletes the oldest/);
    expect(props.maxSnapshots.description).not.toMatch(/to list/);
  });

  it('DASHBOARD_NOT_CONFIGURED says it needs a sign-in, not a URL (the URL has a default)', () => {
    const error = RbookErrors.dashboardNotConfigured();
    expect(error.suggestion).not.toMatch(/Set RBOOK_DASHBOARD_URL/);
    expect(error.suggestion).toContain('rbook_auth(action="login_init")');
  });
});

// ─── Claims a reader could act on ────────────────────────────────────────────

describe('s92-m06 — the shipped documents agree with the code and with each other', () => {
  it('Node 20: engines and every doc that states a Node version', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe('>=20');
    for (const rel of ['README.md', 'docs/getting-started.md']) {
      expect({ rel, says18: /Node(\.js)? 18|18\+|18 or newer/.test(read(rel)) }).toEqual({
        rel,
        says18: false,
      });
      expect(read(rel)).toMatch(/Node\.js 20/);
    }
  });

  it('no shipped document says backups are manual only, or that nothing snapshots before destruction', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/getting-started.md']) {
      const text = read(rel);
      expect({
        rel,
        manualOnly: /manual only|no automatic snapshot|nothing does it for you/i.test(text),
      }).toEqual({ rel, manualOnly: false });
    }
    for (const rel of ['README.md', 'SECURITY.md']) {
      const text = read(rel);
      expect(text).toContain('pre-restore');
      expect(text).toMatch(/before\s+and\s+after/);
    }
  });

  it('SECURITY.md states the whole-file upload at each close and the switch that stops it', () => {
    const security = read('SECURITY.md');
    expect(security).toMatch(/entire SQLite file|whole SQLite file/);
    expect(security).toContain('RBOOK_CHECKPOINT_SYNC=off');
    expect(read('README.md')).toContain('RBOOK_CHECKPOINT_SYNC');
  });

  it('all three network disclosures name automatic writes, due times and the local-only opt-out', () => {
    for (const rel of ['README.md', 'SECURITY.md', 'docs/getting-started.md']) {
      const text = read(rel).replace(/\s+/g, ' ');
      // A reader must be able to decide whether background uploads fit their project before
      // enabling credentials. Completion-only wording would hide m10's new network trigger.
      expect({ rel, writes: /registered project.*(?:MCP|tool).*write/i.test(text) }).toEqual({
        rel,
        writes: true,
      });
      expect(text).toContain('5 quiet minutes');
      expect(text).toContain('30 minutes');
      expect(text).toContain('60 seconds');
      expect(text).toMatch(/whole.*SQLite.*snapshot|snapshot.*whole.*SQLite/i);
      // A transient authentication outage must not be described as a permanent pause.
      expect(text).toContain('Authentication failures are rechecked before pausing');
      expect(text).toMatch(/hourly probe(?:s)?.*resum(?:e|es) uploads/);
      expect(text).toMatch(/Tier and confirmed forbidden responses.*until.*explicit/);
      expect(text).toContain('Confirmed deletion or replacement holds');
      expect(text).toContain('RBOOK_CHECKPOINT_SYNC=off');
      expect(text).toContain('rbook_status');
      expect(text).toMatch(/process.exit closes do not upload/i);
      expect(text).not.toContain('Sync is checkpoint-driven, not continuous');
    }
  });

  it('getting-started no longer says register issues a key or that an empty URL breaks sign-in', () => {
    const guide = read('docs/getting-started.md');
    expect(guide).not.toMatch(/auto-issued on first registration/);
    expect(guide).not.toMatch(/`RBOOK_DASHBOARD_URL` is empty/);
    expect(guide).toContain('No Reasonbook project in');
  });

  it('README no longer calls snapshots immutable or onboard a no-database entry point', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/context snapshots, and mission history are immutable/);
    expect(readme).not.toMatch(/when there's no database yet/);
    expect(readme).toContain('rbook_project(action="init"');
  });
});

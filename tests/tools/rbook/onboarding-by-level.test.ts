// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m06 — a project gets the files and the words of its level: Ledger and Planner get no
// ABOUTME: Builder documents or sprint labels, moving up adds files without overwriting, and nothing is lost.

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { rbookProjectInit, resolveSeedPath } from '../../../src/tools/rbook/rbook-project-init';
import {
  rbookProjectUpdate,
  formatProjectUpdateForLLM,
} from '../../../src/tools/rbook/rbook-project-update';
import {
  rbookDecisionsRecord,
  formatDecisionsRecordForLLM,
} from '../../../src/tools/rbook/rbook-decisions-record';
import { rbookSessionCapture } from '../../../src/tools/rbook/rbook-session-capture';
import {
  rbookSessionStart,
  formatSessionStartForLLM,
} from '../../../src/tools/rbook/rbook-session-start';
import {
  rbookAgentOnboard,
  formatAgentOnboardForLLM,
} from '../../../src/tools/rbook/rbook-agent-onboard';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { rbookRulesLine } from '../../../src/tools/rbook/rules-files';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';

type Tier = 'general' | 'managed' | 'build';

/** Sprint and mission words as a reader meets them; `missionId` and `sprint_id` are not words. */
const SPRINT_WORDS = /(?<![A-Za-z_])(sprints?|missions?)(?![A-Za-z_])/gi;

/**
 * The Builder documents (rbook/research/2026-10-s99-probes/s95-m06-universe.md): the seed's quick
 * starts, guides and templates teach sprints and missions (#1219), and the Builder guide is one of them.
 */
const BUILDER_ONLY = (rel: string): boolean =>
  rel.startsWith('rbook/docs/') ||
  rel.startsWith('rbook/foundational-docs/') ||
  rel === 'rbook/tiers/build.md' ||
  rel === 'rbook/templates/PROJECT-README-template.md';
const PLANNER_AND_UP = (rel: string): boolean => rel === 'rbook/tiers/managed.md';

let roots: string[] = [];

beforeEach(() => {
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-level-'));
  roots.push(root);
  return root;
}

async function initAt(projectType?: Tier, root = newRoot()): Promise<string> {
  const result = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Level Test',
    ...(projectType ? { projectType } : {}),
  });
  expect(result.success).toBe(true);
  return root;
}

/** Every file under the project root, as posix paths; the database's runtime files are left out. */
function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.filter((rel) => !/^rbook\/db\/rbook\.sqlite(-wal|-shm)?$/.test(rel)).sort();
}

/** The seed files a level is meant to get, under rbook/, before any README rendering. */
function seedFiles(): string[] {
  const seed = resolveSeedPath()!;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.DS_Store') continue;
      if (entry.isDirectory()) walk(full);
      else out.push(`rbook/${path.relative(seed, full).split(path.sep).join('/')}`);
    }
  };
  walk(seed);
  return out
    .filter((rel) => !/^rbook\/templates\/README-[a-z]+\.md$/.test(rel))
    .map((rel) => (rel === 'rbook/templates/gitignore-rbook' ? 'rbook/.gitignore' : rel));
}

function dbPathOf(root: string): string {
  return path.join(root, 'rbook', 'db', 'rbook.sqlite');
}

function storedTier(root: string): string | undefined {
  const db = new Database(dbPathOf(root), { readonly: true });
  try {
    return (
      db.prepare(`SELECT value FROM metadata WHERE key = 'project_type'`).get() as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
}

/** Run SQL against a project's store, then forget what the detector cached about it. */
function writeStore(root: string, ...statements: Array<[string, ...unknown[]]>): void {
  const db = new Database(dbPathOf(root));
  try {
    for (const [sql, ...args] of statements) db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
}

function rowCounts(root: string): Record<string, number> {
  const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ])
    );
  } finally {
    db.close();
  }
}

describe('s95-m06: the files a level gets', () => {
  it('a Ledger gets no Builder document and no Planner guide, and no sprint or mission rows', async () => {
    const root = await initAt('general');
    const written = files(root);
    expect(written.filter(BUILDER_ONLY)).toEqual([]);
    expect(written.filter(PLANNER_AND_UP)).toEqual([]);
    const expected = seedFiles().filter((rel) => !BUILDER_ONLY(rel) && !PLANNER_AND_UP(rel));
    expect(written).toEqual([...expected, 'AGENTS.md', 'CLAUDE.md'].sort());
    const counts = rowCounts(root);
    expect({ sprints: counts.sprints, missions: counts.missions }).toEqual({
      sprints: 0,
      missions: 0,
    });
  });

  it('a new project with no level passed is a Ledger and gets the Ledger files', async () => {
    const root = await initAt(undefined);
    expect(files(root)).toEqual(files(await initAt('general')));
  });

  it('a Planner adds its own guide and still gets no Builder document', async () => {
    const written = files(await initAt('managed'));
    expect(written.filter(BUILDER_ONLY)).toEqual([]);
    expect(written).toContain('rbook/tiers/managed.md');
  });

  it('a Builder gets the whole seed, with the seed README as rbook/README.md', async () => {
    const root = await initAt('build');
    expect(files(root)).toEqual([...seedFiles(), 'AGENTS.md', 'CLAUDE.md'].sort());
    expect(fs.readFileSync(path.join(root, 'rbook', 'README.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(resolveSeedPath()!, 'README.md'), 'utf8')
    );
  });

  it('a Ledger or Planner README names its level and no file the level omits', async () => {
    for (const [tier, name] of [
      ['general', 'Ledger'],
      ['managed', 'Planner'],
    ] as const) {
      const readme = fs.readFileSync(path.join(await initAt(tier), 'rbook', 'README.md'), 'utf8');
      expect(readme).toContain(name);
      expect(readme).not.toMatch(/(?<![A-Za-z])(sprints?|missions?)(?![A-Za-z])/i);
    }
  });

  it('a Ledger init refuses an initial sprint or missions before writing anything', async () => {
    const root = newRoot();
    const result = await rbookProjectInit({
      projectRoot: root,
      projectType: 'general',
      initialSprint: { id: 'sprint-01', title: 'Sprint 1' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
    expect(result.error?.suggestion).toContain('projectType="build"');
    expect(result.error?.suggestion).toContain(
      'passing initialSprint and initialMissions as before'
    );
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);

    const unlevelled = newRoot();
    const second = await rbookProjectInit({
      projectRoot: unlevelled,
      initialMissions: [{ id: 'm1', name: 'One' }],
    });
    expect(second.success).toBe(false);
    expect(fs.existsSync(path.join(unlevelled, 'rbook'))).toBe(false);
  });

  it('a re-init with no level refuses initial work when the store is a Ledger, and leaves the folder as it was', async () => {
    const root = await initAt('general');
    const db = dbPathOf(root);
    // Every file's bytes, except SQLite's shared-memory index, which any reader may touch; its
    // presence still counts.
    const folder = (): Record<string, string> =>
      Object.fromEntries(
        files(root)
          .concat(
            ['', '-wal', '-shm']
              .map((suffix) => `rbook/db/rbook.sqlite${suffix}`)
              .filter((rel) => fs.existsSync(path.join(root, rel)))
          )
          .map((rel) => [
            rel,
            rel.endsWith('-shm')
              ? 'present'
              : crypto
                  .createHash('sha256')
                  .update(fs.readFileSync(path.join(root, rel)))
                  .digest('hex'),
          ])
      );
    // With and without the -wal and -shm files a reader can leave beside the store.
    for (const readonly of [false, true]) {
      const reader = new Database(db, { readonly });
      reader.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      reader.close();
      RbookDetector.resetInstance();
      expect(fs.existsSync(`${db}-wal`)).toBe(readonly);
      const before = folder();
      const result = await rbookProjectInit({
        projectRoot: root,
        initialMissions: [{ id: 'm1', name: 'One' }],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.suggestion).toContain('initialSprint and initialMissions');
      expect(folder()).toEqual(before);
    }
  });

  it('no file any level writes names a rbook/ path that level omits', async () => {
    const missing: string[] = [];
    for (const tier of ['general', 'managed', 'build'] as const) {
      const root = await initAt(tier);
      for (const rel of files(root)) {
        if (rel.endsWith('.sqlite') || rel.endsWith('.gitignore')) continue;
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        for (const m of text.matchAll(/(?<![A-Za-z0-9_./-])\/?(rbook\/[A-Za-z0-9_./-]+)/g)) {
          const target = m[1].replace(/[.,;:)]+$/, '');
          if (/[{<]/.test(target) || target === 'rbook/') continue;
          if (!fs.existsSync(path.join(root, target))) missing.push(`${tier}: ${rel} → ${target}`);
        }
        // rbook/README.md names its neighbours relative to rbook/ (`tiers/general.md`). Other files
        // under rbook/ do not: the project README template's `docs/roadmap.md` is the project's own.
        if (rel === 'rbook/README.md') {
          for (const m of text.matchAll(
            /`((?:db|context|tiers|templates|docs|foundational-docs)\/[A-Za-z0-9_./-]*)`/g
          )) {
            if (!fs.existsSync(path.join(root, 'rbook', m[1])))
              missing.push(`${tier}: ${rel} → rbook/${m[1]}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('s95-m06: changing level', () => {
  it('moving up writes the missing files, keeps edited ones, and loses no row', async () => {
    const root = await initAt('general');
    const guide = path.join(root, 'rbook', 'tiers', 'general.md');
    fs.writeFileSync(guide, '# edited by the team\n');
    const before = rowCounts(root);

    const up = await rbookProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect(up.success).toBe(true);

    expect(files(root)).toEqual([...seedFiles(), 'AGENTS.md', 'CLAUDE.md'].sort());
    expect(fs.readFileSync(guide, 'utf8')).toBe('# edited by the team\n');
    // The README Reasonbook wrote for the Ledger is replaced by the Builder one, since nobody edited it.
    expect(fs.readFileSync(path.join(root, 'rbook', 'README.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(resolveSeedPath()!, 'README.md'), 'utf8')
    );
    const after = rowCounts(root);
    for (const [table, n] of Object.entries(before)) {
      expect([table, after[table] >= n]).toEqual([table, true]);
    }
  });

  it('moving up keeps a README the team edited', async () => {
    const root = await initAt('general');
    const readme = path.join(root, 'rbook', 'README.md');
    fs.writeFileSync(readme, '# our own notes\n');
    expect((await rbookProjectUpdate({ projectRoot: root, projectType: 'managed' })).success).toBe(
      true
    );
    expect(fs.readFileSync(readme, 'utf8')).toBe('# our own notes\n');
    expect(fs.existsSync(path.join(root, 'rbook', 'tiers', 'managed.md'))).toBe(true);
  });

  it('moving down removes no file and loses no row', async () => {
    const root = await initAt('build');
    const beforeFiles = files(root);
    const before = rowCounts(root);
    expect((await rbookProjectUpdate({ projectRoot: root, projectType: 'general' })).success).toBe(
      true
    );
    expect(files(root)).toEqual(beforeFiles);
    const after = rowCounts(root);
    for (const [table, n] of Object.entries(before)) {
      expect([table, after[table] >= n]).toEqual([table, true]);
    }
  });

  it('moving down gives an unedited README the lower level, keeps an edited one, and says which', async () => {
    const sha = (file: string): string =>
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const root = await initAt('build');
    const readme = path.join(root, 'rbook', 'README.md');

    const down = await rbookProjectUpdate({ projectRoot: root, projectType: 'general' });
    expect(down.success).toBe(true);
    expect(sha(readme)).toBe(sha(path.join(resolveSeedPath()!, 'templates', 'README-ledger.md')));
    expect(formatProjectUpdateForLLM(down)).toContain(
      "rbook/README.md was the unedited README Reasonbook writes for another level, so it was replaced with the Ledger level's."
    );
    expect(formatProjectUpdateForLLM(down)).not.toContain('none overwritten');

    fs.writeFileSync(readme, '# ours\n');
    const up = await rbookProjectUpdate({ projectRoot: root, projectType: 'managed' });
    expect(up.success).toBe(true);
    expect(fs.readFileSync(readme, 'utf8')).toBe('# ours\n');
    expect(formatProjectUpdateForLLM(up)).not.toContain('rbook/README.md');
  });

  it('a re-init at another level says the README changed with it', async () => {
    const root = await initAt('general');
    const reinit = await rbookProjectInit({ projectRoot: root, projectType: 'build' });
    expect(reinit.success).toBe(true);
    expect(reinit.warnings).toContain(
      "rbook/README.md was the unedited README Reasonbook writes for another level, so it was replaced with the Builder level's."
    );
  });

  it('a level change whose files cannot be written still changes the level and says how to finish', async () => {
    const root = await initAt('general');
    // A file where a Builder folder goes, so the copy fails on any platform and as root. The copy
    // walks in name order, so docs/ is written before foundational-docs/ fails.
    const blocker = path.join(root, 'rbook', 'foundational-docs');
    fs.writeFileSync(blocker, 'not a folder\n');

    const up = await rbookProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect(up.success).toBe(true);
    expect(up.data?.updated).toEqual({ project_type: 'build' });
    expect(storedTier(root)).toBe('build');
    const answer = formatProjectUpdateForLLM(up);
    expect(answer).toContain('The level changed, but its files could not all be written');
    // What was written before the failure is reported, every file of it (the confirming critic).
    const written = up.data?.filesWritten ?? [];
    expect(written).toContain(path.join('docs', 'README.md'));
    const onDisk = files(root)
      .filter(BUILDER_ONLY)
      .map((rel) => path.join(...rel.split('/').slice(1)));
    expect(onDisk.filter((rel) => !written.includes(rel))).toEqual([]);
    expect(answer).toContain(`The ${written.length} written before that are listed`);

    fs.rmSync(blocker);
    const again = await rbookProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect(again.success).toBe(true);
    // The rerun writes what is still missing; the two answers together name every new file.
    expect(again.data?.filesWritten).toEqual(
      expect.arrayContaining([path.join('foundational-docs', 'roadmap_template.md')])
    );
    expect(again.data?.filesWritten).not.toContain(path.join('docs', 'README.md'));
    const reported = [...written, ...(again.data?.filesWritten ?? [])];
    expect(
      files(root)
        .filter(BUILDER_ONLY)
        .map((rel) => path.join(...rel.split('/').slice(1)))
        .filter((rel) => !reported.includes(rel))
    ).toEqual([]);
    expect(files(root)).toEqual([...seedFiles(), 'AGENTS.md', 'CLAUDE.md'].sort());
  });

  it('a store with no level row or an unknown one reads as Builder and gets the Builder files', async () => {
    for (const stored of [null, 'tracker'] as const) {
      const root = await initAt('general');
      const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
      if (stored === null) db.prepare(`DELETE FROM metadata WHERE key = 'project_type'`).run();
      else db.prepare(`UPDATE metadata SET value = ? WHERE key = 'project_type'`).run(stored);
      db.close();
      RbookDetector.resetInstance();
      // Re-init with no level keeps the stored tier; a missing or unknown one is Builder.
      expect((await rbookProjectInit({ projectRoot: root })).success).toBe(true);
      expect(files(root)).toEqual(expect.arrayContaining(seedFiles()));
    }
  });
});

describe('s95-m06: what each level shows', () => {
  async function storeWithOpenSprint(tier: Tier): Promise<string> {
    const root = await initAt('build');
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    db.prepare(`UPDATE metadata SET value = ? WHERE key = 'project_type'`).run(tier);
    db.prepare(
      `INSERT INTO sprints (id, title, status) VALUES ('sprint-7', 'Week seven', 'Active')`
    ).run();
    db.close();
    RbookDetector.resetInstance();
    return root;
  }

  it('the digest names no sprint at Ledger, a cycle at Planner and a sprint at Builder', async () => {
    const text = async (root: string) => renderDigestV2(await readDigestV2(root)).text;
    for (const tier of ['general', 'managed'] as const) {
      const root = await initAt(tier);
      expect(await text(root)).not.toMatch(/sprint/i);
    }
    expect(await text(await storeWithOpenSprint('general'))).not.toMatch(/sprint/i);
    const planner = await text(await storeWithOpenSprint('managed'));
    expect(planner).toContain('Cycle sprint-7');
    expect(planner).not.toMatch(/Sprint sprint-7/);
    expect(await text(await storeWithOpenSprint('build'))).toContain('Sprint sprint-7');
    expect(await text(await initAt('build'))).toContain('— no sprint');
  });

  it('session start shows no sprint or mission words at Ledger and Planner, and keeps them at Builder', async () => {
    for (const tier of ['general', 'managed'] as const) {
      const root = await initAt(tier);
      const result = await rbookSessionStart({ projectRoot: root, title: 'probe', type: 'custom' });
      expect(result.success).toBe(true);
      const hits = formatSessionStartForLLM(result).match(
        /(?<![A-Za-z])(sprints?|missions?)(?![A-Za-z])/gi
      );
      expect({ tier, hits }).toEqual({ tier, hits: null });
    }
    const builder = await initAt('build');
    const shown = formatSessionStartForLLM(
      await rbookSessionStart({ projectRoot: builder, title: 'probe', type: 'custom' })
    );
    expect(shown).toContain('**Sprint**: none open');
    expect(shown).toContain('missions_added=');
  });

  it("onboard's fresh-project suggestion speaks the project's level", async () => {
    const suggestion = async (tier: Tier) =>
      ((await rbookAgentOnboard({ projectRoot: await initAt(tier) })).data?.suggestedActions ?? [])
        .map((a) => a.action)
        .find((a) => a.startsWith('Fresh project detected'));
    expect(await suggestion('general')).not.toMatch(/mission|task/i);
    expect(await suggestion('managed')).not.toMatch(/mission/i);
    expect(await suggestion('build')).toContain('no active missions');
  });
});

describe('s95-m06: day-two answers speak the level (the build critic)', () => {
  /** A store at this tier with an open sprint and an in-progress mission, as a moved project keeps. */
  async function storeWithOpenWork(tier: Tier): Promise<string> {
    const root = await initAt('build');
    writeStore(
      root,
      [`UPDATE metadata SET value = ? WHERE key = 'project_type'`, tier],
      [`INSERT INTO sprints (id, title, status) VALUES ('w7', 'Week seven', 'Active')`],
      [
        `INSERT INTO missions (id, name, status, sprint_id) VALUES ('m-1', 'First', 'In Progress', 'w7')`,
      ]
    );
    return root;
  }

  async function recorded(root: string, missionId?: string): Promise<string> {
    const result = await rbookDecisionsRecord({
      projectRoot: root,
      content: 'We keep the record in SQLite because it travels with the project.',
      ...(missionId ? { missionId } : {}),
    });
    expect(result.success).toBe(true);
    return formatDecisionsRecordForLLM(result);
  }

  it('recording a decision names a sprint and mission at Builder, a cycle and task at Planner, neither at Ledger', async () => {
    const builder = await recorded(await storeWithOpenWork('build'), 'm-1');
    expect(builder).toContain('**Sprint**: w7');
    expect(builder).toContain('**Mission**: m-1');

    const planner = await recorded(await storeWithOpenWork('managed'), 'm-1');
    expect(planner).toContain('**Cycle**: w7');
    expect(planner).toContain('**Task**: m-1');
    expect(planner.match(SPRINT_WORDS)).toBeNull();

    expect((await recorded(await storeWithOpenWork('general'))).match(SPRINT_WORDS)).toBeNull();
  });

  it('a decision recorded with no open sprint is warned about only at Builder', async () => {
    expect(await recorded(await initAt('build'))).toContain('(none — no open sprint)');
    for (const tier of ['general', 'managed'] as const) {
      const text = await recorded(await initAt(tier));
      expect({ tier, hits: text.match(SPRINT_WORDS) }).toEqual({ tier, hits: null });
    }
  });

  it('a capture without a missionId asks for the mission at Builder, the task at Planner, and nothing at Ledger', async () => {
    const warning = async (tier: Tier): Promise<string | undefined> => {
      const result = await rbookSessionCapture({
        projectRoot: await storeWithOpenWork(tier),
        category: 'learning',
        content: 'A lesson worth keeping across conversations.',
      });
      expect(result.success).toBe(true);
      return result.warnings?.find((w) => w.includes('without a missionId'));
    };
    expect(await warning('build')).toContain('1 mission(s) are open: m-1 (In Progress)');
    const planner = await warning('managed');
    expect(planner).toContain('1 task(s) are open: m-1 (In Progress)');
    expect(planner).toContain('which task this belongs to');
    expect(planner!.match(SPRINT_WORDS)).toBeNull();
    expect(await warning('general')).toBeUndefined();
  });

  it("onboard's work suggestions say task at Planner and mission at Builder", async () => {
    const actions = async (tier: Tier): Promise<string[]> =>
      (
        (await rbookAgentOnboard({ projectRoot: await storeWithOpenWork(tier) })).data
          ?.suggestedActions ?? []
      ).map((a) => a.action);
    expect(await actions('managed')).toContain('Continue in-progress task: m-1 (First)');
    expect(await actions('build')).toContain('Continue in-progress mission: m-1 (First)');
  });

  it('a level kept only in the identity row, or padded with spaces, reads the same everywhere', async () => {
    // No project_type row: the identity's tier decides, for the answers and for init's files.
    const identityOnly = await storeWithOpenWork('build');
    writeStore(
      identityOnly,
      [`DELETE FROM metadata WHERE key = 'project_type'`],
      [
        `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', 'rbook', ?, ?)`,
        JSON.stringify({ tier: 'general' }),
        new Date().toISOString(),
      ]
    );
    expect((await recorded(identityOnly)).match(SPRINT_WORDS)).toBeNull();
    const refused = await rbookProjectInit({
      projectRoot: identityOnly,
      initialSprint: { id: 'w8', title: 'Week eight' },
    });
    expect(refused.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
    expect((await rbookProjectInit({ projectRoot: identityOnly })).data?.level).toBe('ledger');

    const padded = await storeWithOpenWork('build');
    writeStore(padded, [`UPDATE metadata SET value = ' managed ' WHERE key = 'project_type'`]);
    expect(await recorded(padded, 'm-1')).toContain('**Cycle**: w7');
    expect(renderDigestV2(await readDigestV2(padded)).text).toContain('Cycle w7');
    const started = await rbookSessionStart({
      projectRoot: padded,
      title: 'probe',
      type: 'custom',
    });
    expect(formatSessionStartForLLM(started)).toContain('**Cycle**: w7');
    expect((await rbookProjectInit({ projectRoot: padded })).data?.level).toBe('planner');
  });

  it("onboard names the store's level even when the level's guide lost its frontmatter", async () => {
    const root = await initAt('general');
    fs.writeFileSync(path.join(root, 'rbook', 'tiers', 'general.md'), '# edited by the team\n');
    const onboard = await rbookAgentOnboard({ projectRoot: root });
    expect(formatAgentOnboardForLLM(onboard)).toContain('Level: Ledger (general)');
    const fresh = onboard.data?.suggestedActions.find((a) =>
      a.action.startsWith('Fresh project detected')
    );
    expect(fresh?.action).toBe('Fresh project detected. Begin first-session setup.');
  });
});

describe("s95-m06: the confirming critic's fold", () => {
  async function cli(argv: string[], cwd: string): Promise<number> {
    const io: CliIo = {
      env: process.env,
      cwd,
      readStdin: async () => '',
      stdout: () => {},
      stderr: () => {},
    };
    return runCli(argv, io);
  }

  it('init refuses a store it cannot read, before writing any file', async () => {
    const root = await initAt('general');
    fs.writeFileSync(dbPathOf(root), 'not a database, and not readable as one\n');
    const folder = (): Record<string, string> =>
      Object.fromEntries(
        files(root)
          .concat(['rbook/db/rbook.sqlite'])
          .map((rel) => [
            rel,
            crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(root, rel)))
              .digest('hex'),
          ])
      );
    const before = folder();
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_CONNECTION_FAILED);
    expect(result.error?.message).toContain('changed nothing');
    expect(result.error?.suggestion).toContain('restore it from a backup or version control');
    // No level guessed: no Builder document written and the Ledger README kept.
    expect(folder()).toEqual(before);
    // A passed level changes nothing about that: the store still cannot be initialized.
    const leveled = await rbookProjectInit({ projectRoot: root, projectType: 'build' });
    expect(leveled.error?.code).toBe(RBOOK_ERROR_CODES.DB_CONNECTION_FAILED);
    expect(folder()).toEqual(before);
  });

  it('the identity row outranks a legacy project_context tier', async () => {
    const root = await initAt('build');
    writeStore(
      root,
      [`DELETE FROM metadata WHERE key = 'project_type'`],
      [
        `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', 'rbook', ?, ?)`,
        JSON.stringify({ tier: 'managed' }),
        new Date().toISOString(),
      ],
      [
        `UPDATE contexts SET content = json_set(content, '$.tier', 'general') WHERE id = 'project_context'`,
      ]
    );
    expect(renderDigestV2(await readDigestV2(root)).text.split('\n\n')[0]).toContain('(Planner)');
  });

  it('init reads a legacy project_context tier as every answer does', async () => {
    const root = await initAt('build');
    fs.rmSync(path.join(root, 'rbook', 'docs'), { recursive: true });
    writeStore(
      root,
      [`DELETE FROM metadata WHERE key = 'project_type'`],
      [`DELETE FROM contexts WHERE id = 'project_identity'`],
      [
        `UPDATE contexts SET content = json_set(content, '$.tier', 'general') WHERE id = 'project_context'`,
      ]
    );
    const reinit = await rbookProjectInit({ projectRoot: root });
    expect(reinit.data?.level).toBe('ledger');
    // A Ledger gets no Builder document back.
    expect(fs.existsSync(path.join(root, 'rbook', 'docs'))).toBe(false);
  });

  it('a README written for the level is reported with the other files', async () => {
    const root = await initAt('general');
    fs.rmSync(path.join(root, 'rbook', 'README.md'));
    const up = await rbookProjectUpdate({ projectRoot: root, projectType: 'managed' });
    expect(up.data?.filesWritten).toContain('README.md');
  });

  it('the ambient command names the level as every answer reads it', async () => {
    const root = await initAt('build');
    writeStore(root, [`UPDATE metadata SET value = ' managed ' WHERE key = 'project_type'`]);
    expect(await cli(['ambient', 'off'], root)).toBe(0);
    const line = fs
      .readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
      .split('\n')
      .find((l) => l === rbookRulesLine('planner', { hooks: true, ambient: 'off' }));
    expect(line).toBeDefined();
  });

  it('a legacy project_context tier still names the level, before and after the identity row exists', async () => {
    const root = await initAt('build');
    writeStore(
      root,
      [`DELETE FROM metadata WHERE key = 'project_type'`],
      [`DELETE FROM contexts WHERE id = 'project_identity'`],
      [
        `UPDATE contexts SET content = json_set(content, '$.tier', 'general') WHERE id = 'project_context'`,
      ]
    );
    const projectLine = async (): Promise<string> =>
      renderDigestV2(await readDigestV2(root)).text.split('\n\n')[0];
    expect(await projectLine()).toContain('(Ledger)');
    // A write creates the identity row, seeded from the same legacy tier; the level does not flip.
    expect((await recordAt(root)).match(SPRINT_WORDS)).toBeNull();
    expect(await projectLine()).toContain('(Ledger)');
  });

  it('an empty stored tier falls back to the identity row, and onboard reads it the same way', async () => {
    const root = await initAt('build');
    writeStore(
      root,
      [`UPDATE metadata SET value = '' WHERE key = 'project_type'`],
      [
        `INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', 'rbook', ?, ?)`,
        JSON.stringify({ tier: 'general' }),
        new Date().toISOString(),
      ]
    );
    const onboard = await rbookAgentOnboard({ projectRoot: root });
    expect(onboard.data?.project.projectType).toBe('general');
    expect(formatAgentOnboardForLLM(onboard)).toContain('Level: Ledger (general)');
  });

  it("a Ledger's record answer never says cycle, even with a sprint open", async () => {
    const root = await initAt('build');
    writeStore(
      root,
      [`UPDATE metadata SET value = 'general' WHERE key = 'project_type'`],
      [`INSERT INTO sprints (id, title, status) VALUES ('w9', 'Week nine', 'Active')`]
    );
    const text = await recordAt(root);
    expect(text).not.toMatch(/Cycle|Sprint|Task|Mission/);
  });

  it('a Planner with no open work is offered its open tasks', async () => {
    const root = await initAt('managed');
    // Not a fresh project: it has a brief, so onboard offers its queue, not first-session setup.
    writeStore(root, [
      `UPDATE contexts SET content = json_set(content, '$.project_brief', 'PROJECT BRIEF: a gala') WHERE id = 'master_context'`,
    ]);
    const actions = (
      (await rbookAgentOnboard({ projectRoot: root })).data?.suggestedActions ?? []
    ).map((a) => a.action);
    expect(actions).toContain('View open tasks');
    expect(actions).not.toContain('View mission queue');
  });

  it("a new store takes the level its folder's agents file names", async () => {
    const planner = await initAt('managed');
    const root = newRoot();
    fs.copyFileSync(path.join(planner, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
    const init = await rbookProjectInit({ projectRoot: root });
    expect(init.data?.level).toBe('planner');
    expect(fs.existsSync(path.join(root, 'rbook', 'tiers', 'managed.md'))).toBe(true);
    expect(files(root).filter(BUILDER_ONLY)).toEqual([]);
  });
});

/** Record a decision in this project and return the answer as an agent reads it. */
async function recordAt(root: string): Promise<string> {
  const result = await rbookDecisionsRecord({
    projectRoot: root,
    content: 'We keep the record in SQLite because it travels with the project.',
  });
  expect(result.success).toBe(true);
  return formatDecisionsRecordForLLM(result);
}

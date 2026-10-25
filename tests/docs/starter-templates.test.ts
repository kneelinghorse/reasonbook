// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m05 — each starter template matches init apart from the filled project name, so a copied template
// ABOUTME: never disagrees with init, and no template carries this repository's own agents.md rules.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import { rbookRulesLine, LEVEL_TIERS, PROJECT_LEVELS } from '../../src/tools/rbook/rules-files';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Tracked files only: a checkout may hold ignored local folders under templates/. */
const tracked = execFileSync('git', ['ls-files', 'templates'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort();

describe('s95-m05: the starter templates', () => {
  const savedConfigDir = process.env.RBOOK_CONFIG_DIR;
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-templates-'));
    process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('each level has only its README and the two files it starts with', () => {
    expect(tracked).toEqual(
      PROJECT_LEVELS.flatMap((level) =>
        ['AGENTS.md', 'CLAUDE.md', 'README.md'].map((file) => `templates/${level}/${file}`)
      ).sort()
    );
  });

  it.each(PROJECT_LEVELS)(
    '%s: AGENTS.md and CLAUDE.md are what init writes at that level',
    async (level) => {
      const root = path.join(tmp, level);
      fs.mkdirSync(root);
      const result = await rbookProjectInit({ projectRoot: root, projectType: LEVEL_TIERS[level] });
      expect(result.success).toBe(true);
      const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
      expect(agents).toContain(`- **Name:** ${level}`);
      expect(agents).not.toMatch(/\[[^\]]+\](?!\()/);
      for (const file of FILES) {
        const same =
          fs.readFileSync(path.join(root, file), 'utf8') ===
          read(`templates/${level}/${file}`).replace(
            '- **Name:** This project',
            `- **Name:** ${level}`
          );
        expect({ level, file, same }).toEqual({ level, file, same: true });
      }
    }
  );

  it.each(PROJECT_LEVELS)(
    '%s: init keeps a copied template as it is, without a warning about it',
    async (level) => {
      // The template's README promises this: copy the two files, run init at the level, keep them.
      const root = path.join(tmp, `copied-${level}`);
      fs.mkdirSync(root);
      for (const file of FILES)
        fs.copyFileSync(path.join(REPO_ROOT, 'templates', level, file), path.join(root, file));
      const result = await rbookProjectInit({ projectRoot: root, projectType: LEVEL_TIERS[level] });
      expect(result.success).toBe(true);
      for (const file of FILES) {
        const kept =
          fs.readFileSync(path.join(root, file), 'utf8') === read(`templates/${level}/${file}`);
        expect({ level, file, kept }).toEqual({ level, file, kept: true });
      }
      expect((result.warnings ?? []).filter((warning) => warning.includes('AGENTS.md'))).toEqual(
        []
      );
    }
  );

  it.each(PROJECT_LEVELS)('%s: its README starts the record at its own level', (level) => {
    const readme = read(`templates/${level}/README.md`);
    expect(readme).toContain(`cp templates/${level}/AGENTS.md templates/${level}/CLAUDE.md `);
    expect(readme).toContain(`reasonbook init --level ${level}`);
    expect(readme).toContain('reasonbook review --format=context');
  });
});

/**
 * The template predicate (s95-m05): no template line longer than 40 characters may come from this
 * repository's agents.md unless the seed's AGENTS.md has it too, so the owner's own setup never
 * becomes a template. The record line init renders is the seed's line with the level filled in; this
 * repository carries the Builder rendering because it is a Builder, so rendered lines count as seed
 * lines. agents.md is private (the mirror removes it), so the public mirror skips this, printed.
 */
const PRIVATE = requiresPrivateEvidence({
  reason: "the template predicate reads this repository's agents.md, which the mirror removes",
  paths: { agents: 'agents.md' },
});

PRIVATE.describe('s95-m05: the template predicate', () => {
  it("no template line over 40 characters comes from this repository's agents.md", () => {
    const own = new Set(
      fs
        .readFileSync(PRIVATE.paths.agents, 'utf8')
        .split('\n')
        .filter((line) => line.length > 40)
    );
    const allowed = new Set([
      ...read('rbook-seed/templates/AGENTS.md').split('\n'),
      ...PROJECT_LEVELS.map((level) => rbookRulesLine(level)),
    ]);
    const hits = tracked
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) =>
        read(file)
          .split('\n')
          .map((line, index) => ({ file, line: index + 1, text: line }))
      )
      .filter(({ text }) => own.has(text) && !allowed.has(text));
    expect(hits).toEqual([]);
    // Non-vacuity: the predicate does meet a shared line, and passes it only as a rendered one.
    expect(own.has(rbookRulesLine('builder'))).toBe(true);
    expect(read('templates/builder/AGENTS.md').split('\n')).toContain(rbookRulesLine('builder'));
  });
});

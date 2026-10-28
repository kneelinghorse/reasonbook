// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The chat package must be portable, complete, and free of developer-only workflow instructions.
// ABOUTME: Adversarial lint examples prove the instruction boundary while documenting its lexical limits.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { inspectNpmPack } from '../docs/npm-pack-inspection';

const ROOT = path.resolve(__dirname, '../..');
const PLUGIN = 'plugins/reasonbook-chat';
const SKILLS = ['capture-notes', 'catch-up', 'next-up', 'propose-decision', 'recall', 'setup'];
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file: string) => JSON.parse(read(file));

function files(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    expect(fs.lstatSync(path.join(ROOT, file)).isSymbolicLink()).toBe(false);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/**
 * Scope: every UTF-8 instruction file under the chat skills directory, including frontmatter.
 * False negatives: prose describing program execution without a command token, filesystem names
 * without slashes, and MCP tool names that wrap a shell. These require semantic reviewer judgment.
 * rbook:// addresses are selectors, not paths, and are the only slash-bearing exception.
 * s99-m02: Reasonbook is the product's name in prose; lowercase reasonbook is its command.
 */
function chatViolations(source: string): string[] {
  const text = source.replace(/rbook:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/g, 'PROJECT_ADDRESS');
  const violations: string[] = [];
  if (/\b(?:cmos-mcp|node|npx|npm)\b/i.test(text) || /\breasonbook\b/.test(text))
    violations.push('shell token');
  if (/\bhooks?\b|\b(?:SessionStart|UserPromptSubmit|PreCompact|SessionEnd)\b/i.test(text))
    violations.push('hook reference');
  if (text.includes('--project-root')) violations.push('CLI option');
  if (/(?:^|[\s("'`])(?:\.{1,2}|~)?[\\/]|[a-zA-Z]:[\\/]|\b[\w.-]+[\\/][\w.-]+/m.test(text))
    violations.push('filesystem path');
  if (
    [...text.matchAll(/`([^`\n]+)`/g)].some(
      (match) => /\s/.test(match[1]) && !/^rbook_[a-z_]+\(/.test(match[1])
    )
  )
    violations.push('backticked command');
  if (/```(?:sh|shell|bash|zsh|console)\b/i.test(text)) violations.push('shell block');
  return violations;
}

describe('portable chat plugin', () => {
  it('omits developer-only forwarding fields so portable hosts discover the server', () => {
    // Codex drops this portable MCP file when the developer manifest's env_vars field is present.
    expect(json(`${PLUGIN}/mcp.json`).mcpServers.rbook).not.toHaveProperty('env_vars');
  });

  it('declares a portable entry, setup onboarding and exactly one shared stdio server', () => {
    const manifest = json(`${PLUGIN}/plugin.json`);
    expect(manifest).toMatchObject({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'reasonbook-chat',
      version: json('package.json').version,
      extensions: {
        'com.openai': {
          onboardingSkill: './skills/setup/SKILL.md',
          interface: { displayName: 'Reasonbook', category: 'Productivity' },
        },
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/"hooks"/);
    expect(fs.existsSync(path.join(ROOT, PLUGIN, 'hooks'))).toBe(false);
    expect(json(`${PLUGIN}/mcp.json`)).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        rbook: {
          type: 'stdio',
          command: './server/launch.sh',
          args: ['serve', '--install-root', 'shared'],
          cwd: './',
        },
      },
    });
  });

  it('selects the local edition and exposes a contained Claude server and square app icons', () => {
    expect(read(`${PLUGIN}/EDITION`)).toBe('directory\n');
    const claude = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(claude.version).toBe(json('package.json').version);
    expect(claude.mcpServers.rbook).toEqual({
      command: '${CLAUDE_PLUGIN_ROOT}/server/launch.sh',
      args: ['serve', '--install-root', 'shared'],
    });
    expect(claude).not.toHaveProperty('hooks');
    const ui = json(`${PLUGIN}/plugin.json`).extensions['com.openai'].interface;
    for (const field of ['logo', 'composerIcon']) {
      expect(ui[field]).toMatch(/^\.\/assets\/[^/]+\.svg$/);
      const svg = read(`${PLUGIN}/${ui[field].slice(2)}`);
      expect(svg).toMatch(/width="128" height="128" viewBox="0 0 128 128"/);
      expect(svg).not.toMatch(/script|href=|foreignObject/);
    }
  });

  it('keeps requested records without extracting conversation excerpts', () => {
    for (const file of files(`${PLUGIN}/skills`)) {
      expect(read(file)).not.toMatch(/approval words|actual words|user's words/i);
    }
    expect(read(`${PLUGIN}/skills/propose-decision/SKILL.md`)).toContain(
      'the user approved it in this conversation'
    );
  });

  it('copies the complete bootstrap closure byte-for-byte so chat cannot diverge from developer installs', () => {
    const canonical = fs
      .readdirSync(path.join(ROOT, 'plugins/reasonbook/hooks'))
      .filter((name) => /\.(?:mjs|sh)$/.test(name))
      .sort();
    expect(fs.readdirSync(path.join(ROOT, PLUGIN, 'server')).sort()).toEqual(canonical);
    // The portable loader executes a contained relative command directly.
    expect(fs.statSync(path.join(ROOT, PLUGIN, 'server/launch.sh')).mode & 0o111).toBe(0o111);
    for (const name of canonical) {
      expect(read(`${PLUGIN}/server/${name}`)).toBe(read(`plugins/reasonbook/hooks/${name}`));
    }
  });

  it('ships distinct discoverable chat skills and keeps every instruction within the MCP-only boundary', () => {
    expect(fs.readdirSync(path.join(ROOT, PLUGIN, 'skills')).sort()).toEqual(SKILLS);
    const developerNames = fs.readdirSync(path.join(ROOT, 'plugins/reasonbook/skills'));
    for (const name of SKILLS) {
      const source = read(`${PLUGIN}/skills/${name}/SKILL.md`);
      const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source);
      expect(frontmatter).not.toBeNull();
      const metadata = parseYaml(frontmatter![1]);
      expect(metadata.name).toBe(name);
      expect(metadata.description.trim().length).toBeGreaterThan(20);
      expect(developerNames).not.toContain(name);
    }
    for (const file of files(`${PLUGIN}/skills`)) {
      expect({ file, violations: chatViolations(read(file)) }).toEqual({ file, violations: [] });
    }
  });

  it('packs the entire independent chat subtree in the real npm tarball', () => {
    const packed = inspectNpmPack(ROOT).files;
    expect(files(PLUGIN).filter((file) => !packed.has(file))).toEqual([]);
  }, 30_000);
});

describe('chat instruction lint', () => {
  it.each([
    'npx cmos-mcp',
    'reasonbook ambient off',
    'npx @aquex/reasonbook@3.6.0',
    'npm install',
    'node program',
    '`git status`',
    '```sh\necho hi\n```',
    ['', 'Users', 'person', 'project'].join('/'),
    '/',
    './',
    '../',
    '~/',
    './project',
    '../project',
    '~/project',
    'folder/project',
    'C:\\project',
    'folder\\project',
    '\\\\server\\share',
    'A Stop hook records it.',
    'SessionStart does it.',
    '--project-root',
  ])('rejects an instruction that introduces a developer surface: %s', (source) => {
    expect(chatViolations(source).length).toBeGreaterThan(0);
  });

  it('permits address selection and MCP calls without broad slash or code exceptions', () => {
    expect(
      chatViolations(
        'Use rbook://owner/project with `rbook_review(projectRoot="rbook://owner/project")`.'
      )
    ).toEqual([]);
    expect(
      chatViolations('Call `rbook_decisions(action="record", content="the choice")`.')
    ).toEqual([]);
  });
});

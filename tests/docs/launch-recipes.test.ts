// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 — every documented launch recipe pins the package version and runs npx with
// ABOUTME: --prefer-offline, and the pinned version is this release, so a copied config cannot float.

/**
 * An unpinned `npx -y @aquex/cmos-mcp` can resolve the package against the registry on every
 * launch; the first-run study measured 35-49 s cold starts under load, and an unpinned config
 * silently moves to whatever was published last. The recipes now pin one version and prefer the
 * npm cache, or recommend the global install.
 *
 * THE VERSION RULE: the pin equals package.json's version, except while a release is being prepared
 * (CHANGELOG.md opens with "## Unreleased"), when the pin may be the release being prepared and so
 * may run ahead of package.json.
 */

import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS = ['README.md', 'docs/getting-started.md'];
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * s97-m13 (#701): the pages a person copies a launch from are not only the two above. A recipe line
 * holds a pinned spec (`@aquex/reasonbook@…`), runs or installs the package (npx, bunx, pnpm dlx or
 * add, yarn dlx or add, bun add, npm exec, x, install, i or add), or names it in a JSON args array;
 * a subpath such as `@aquex/reasonbook/referee` is an import, not a launch.
 * SCOPE: every tracked Markdown page that holds one, found from `git ls-files`, so a new page is
 * read without editing a list. FALSE NEGATIVES, NAMED: the project's own records under rbook/ (plans,
 * probes, and the release runbook, whose commands take the version from variables) and CHANGELOG.md
 * (what each release said) are left by design; a command split across lines, a launcher not named
 * above, and a recipe outside Markdown are not read.
 */
const RECIPE_LINE =
  /@aquex\/reasonbook@|\b(?:npx|bunx|pnpm\s+(?:dlx|add)|yarn\s+(?:dlx|(?:global\s+)?add)|bun\s+add|npm\s+(?:exec|x|install|i|add))\b[^\n]*@aquex\/reasonbook(?!\/)|"args":\s*\[[^\]]*"@aquex\/reasonbook/;

function recipePages(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((rel) => rel && !rel.startsWith('rbook/') && rel !== 'CHANGELOG.md')
    .filter((rel) =>
      read(rel)
        .split('\n')
        .some((line) => RECIPE_LINE.test(line))
    );
}

/** Every recipe line of every recipe page, as `page:line: text`. */
function recipeLines(): Array<{ where: string; text: string }> {
  return recipePages().flatMap((page) =>
    read(page)
      .split('\n')
      .map((text, i) => ({ where: `${page}:${i + 1}`, text }))
      .filter(({ text }) => RECIPE_LINE.test(text))
  );
}

/** Package specs in commands and configs; the badge and npm page URLs are links, not launches. */
function packageSpecs(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.includes('img.shields.io') && !line.includes('npmjs.com/package'))
    .flatMap((line) => line.match(/@aquex\/reasonbook(@[^\s"'`,\]]*)?/g) ?? []);
}

function parseSemver(value: string): { core: bigint[]; pre: string[] } | undefined {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) return undefined;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return undefined;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid release version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1)
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length)
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const numericLeft = /^\d+$/.test(left);
    const numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function isExactPackageSpec(spec: string): boolean {
  const prefix = '@aquex/reasonbook@';
  return spec.startsWith(prefix) && parseSemver(spec.slice(prefix.length)) !== undefined;
}

describe('s92-m07 — launch recipes', () => {
  it('accepts exact stable and prerelease pins, but refuses ranges, tags and malformed versions', () => {
    for (const version of ['3.2.0', '3.3.0-rc.1', '3.3.0-rc.1+build.2']) {
      expect(isExactPackageSpec(`@aquex/reasonbook@${version}`)).toBe(true);
    }
    for (const spec of [
      '@aquex/reasonbook',
      '@aquex/reasonbook@latest',
      '@aquex/reasonbook@^3.3.0',
      '@aquex/reasonbook@~3.3.0',
      '@aquex/reasonbook@3.3.x',
      '@aquex/reasonbook@3.03.0',
      '@aquex/reasonbook@3.3.0-rc.01',
      '@aquex/reasonbook@3.3.0-',
      '@aquex/cmos-mcp@3.3.0',
    ]) {
      expect(isExactPackageSpec(spec)).toBe(false);
    }
  });

  it('orders prereleases for the existing Unreleased-ahead exception without treating another RC as equal', () => {
    expect(compareSemver('3.3.0-rc.1', '3.3.0-rc.1')).toBe(0);
    expect(compareSemver('3.2.0', '3.3.0-rc.1')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.1', '3.3.0-rc.2')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.2', '3.3.0-rc.10')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.10', '3.3.0')).toBeLessThan(0);
    expect(compareSemver('3.3.0', '3.3.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('3.3.0-alpha.1', '3.3.0-alpha.beta')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc', '3.3.0-rc.1')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.1+build.1', '3.3.0-rc.1+build.2')).toBe(0);
  });

  it('pin an exact version in every command and config', () => {
    const unpinned: string[] = [];
    for (const doc of DOCS) {
      for (const spec of packageSpecs(read(doc))) {
        if (!isExactPackageSpec(spec)) unpinned.push(`${doc}: ${spec}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('run npx with --prefer-offline wherever npx launches the package', () => {
    const offenders: string[] = [];
    for (const doc of DOCS) {
      const text = read(doc);
      // Shell form: an npx command line that names the package.
      for (const line of text.split('\n')) {
        if (
          /\bnpx\b/.test(line) &&
          line.includes('@aquex/reasonbook') &&
          !line.includes('--prefer-offline')
        ) {
          offenders.push(`${doc}: ${line.trim()}`);
        }
      }
      // JSON form: "command": "npx" followed by an args array naming the package.
      const configs = text.match(/"command":\s*"npx",\s*"args":\s*\[[^\]]*\]/g) ?? [];
      for (const config of configs) {
        if (!config.includes('"--prefer-offline"'))
          offenders.push(`${doc}: ${config.replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: both forms are present in the docs this gate reads.
    expect(DOCS.some((doc) => /"command":\s*"npx"/.test(read(doc)))).toBe(true);
    expect(DOCS.some((doc) => /^npx .*@aquex\/reasonbook/m.test(read(doc)))).toBe(true);
  });

  it('pin one version, and that version is this release', () => {
    const pins = new Set(
      DOCS.flatMap((doc) => packageSpecs(read(doc))).map((spec) => spec.split('@').pop()!)
    );
    expect(pins.size).toBe(1);
    const [pin] = [...pins];
    const preparing = /^## Unreleased\b/m.test(read('CHANGELOG.md'));
    if (pin !== PKG_VERSION) {
      expect({
        pin,
        pkg: PKG_VERSION,
        preparing,
        ahead: compareSemver(pin, PKG_VERSION) > 0,
      }).toEqual({
        pin,
        pkg: PKG_VERSION,
        preparing: true,
        ahead: true,
      });
    }
  });

  it('reads every tracked page with a launch recipe (s97-m13)', () => {
    const pages = recipePages();
    // Non-vacuity: the pages the sprint-96 review found outside the two above are read.
    for (const page of [
      ...DOCS,
      'docs/harnesses.md',
      'docs/migrating-from-cmos.md',
      'docs/trust.md',
      'plugins/reasonbook/README.md',
    ])
      expect({ page, read: pages.includes(page) }).toEqual({ page, read: true });
    expect(RECIPE_LINE.test('Import it from `@aquex/reasonbook/referee`.')).toBe(false);
    expect(RECIPE_LINE.test('| npm package | `@aquex/cmos-mcp` | `@aquex/reasonbook` |')).toBe(
      false
    );
  });

  it('pin this release, exactly, in every recipe line of those pages (s97-m13)', () => {
    const preparing = /^## Unreleased\b/m.test(read('CHANGELOG.md'));
    const off = recipeLines().flatMap(({ where, text }) =>
      packageSpecs(text)
        .filter((spec) => !spec.startsWith('@aquex/reasonbook/'))
        .filter((spec) => {
          if (!isExactPackageSpec(spec)) return true;
          const pin = spec.split('@').pop()!;
          return pin !== PKG_VERSION && !(preparing && compareSemver(pin, PKG_VERSION) > 0);
        })
        .map((spec) => `${where}: ${spec}`)
    );
    expect(off).toEqual([]);
  });

  it('run npx with --prefer-offline in every recipe line of those pages (s97-m13)', () => {
    const offenders = recipeLines()
      .filter(({ text }) => /\bnpx\b/.test(text) && !text.includes('--prefer-offline'))
      .map(({ where, text }) => `${where}: ${text.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('recommend the global install as well', () => {
    for (const doc of DOCS) {
      expect(read(doc)).toContain(`npm install -g @aquex/reasonbook@`);
    }
  });

  it('name the former package only to uninstall it (s99-m02)', () => {
    // The pins above follow the new name, so an install or launch of @aquex/cmos-mcp would pass
    // them unseen. Remove a global old package so an obsolete launcher cannot remain on PATH;
    // the uninstall instruction is the one place the former package belongs.
    const strays = DOCS.flatMap((doc) =>
      read(doc)
        .split('\n')
        .filter(
          (line) =>
            line.includes('@aquex/cmos-mcp') && !line.includes('npm uninstall -g @aquex/cmos-mcp')
        )
        .map((line) => `${doc}: ${line.trim()}`)
    );
    expect(strays).toEqual([]);
    for (const doc of DOCS) expect(read(doc)).toContain('npm uninstall -g @aquex/cmos-mcp');
  });

  it('never run the unscoped reasonbook package (s99-m02)', () => {
    // `npx reasonbook` fetches an unrelated 2017 package, not this one. Scope: the public pages and
    // the shipped skills; shell lines that run it through npx, npm exec, npm x, bunx, pnpm dlx or
    // yarn dlx (directly or with --package / -p), lines that install it with npm, pnpm, yarn or bun,
    // and any JSON args array holding the bare name. Holes: a command split across lines, other
    // launchers and installers, and text outside these files (the server's own remedies are pinned
    // by their tests).
    const pages = [
      ...DOCS,
      'docs/harnesses.md',
      'docs/trust.md',
      'SECURITY.md',
      'plugins/reasonbook/README.md',
      'rbook-seed/README.md',
      'rbook-seed/docs/getting-started.md',
      ...['plugins/reasonbook/skills', 'plugins/reasonbook-chat/skills'].flatMap((dir) =>
        fs.readdirSync(path.join(REPO_ROOT, dir)).map((name) => `${dir}/${name}/SKILL.md`)
      ),
    ];
    const shell =
      /\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+(?:exec|x))(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+reasonbook\b|(?:--package[= ]|\s-p\s+)reasonbook\b|\b(?:npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+(?:global\s+)?add|bun\s+add)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+reasonbook(?:@\S*)?(?![\w/-])/;
    const config = /"args":\s*\[[^\]]*"reasonbook(?:@[^"]*)?"/g;
    for (const line of [
      'npx -y reasonbook serve',
      'npm exec reasonbook',
      'bunx reasonbook',
      'pnpm dlx reasonbook init',
      'npx --package=reasonbook reasonbook',
      'npx -p reasonbook init',
      'npm x reasonbook',
      'npm install -g reasonbook',
      'npm i reasonbook@latest',
      'pnpm add -g reasonbook',
      'yarn global add reasonbook',
      'bun add -g reasonbook',
    ])
      expect({ line, flagged: shell.test(line) }).toEqual({ line, flagged: true });
    for (const line of [
      'npx --prefer-offline -y @aquex/reasonbook@3.6.0 serve',
      'npm install -g @aquex/reasonbook@3.6.0',
      'npm uninstall -g @aquex/cmos-mcp',
    ])
      expect({ line, flagged: shell.test(line) }).toEqual({ line, flagged: false });
    expect(shell.test('npm install -g @aquex/reasonbook@3.6.0 && reasonbook --version')).toBe(
      false
    );
    expect('"command": "npx",\n  "args": ["-y", "reasonbook@3.6.0"]'.match(config)).toHaveLength(1);
    expect('{ "args": ["exec", "reasonbook"], "command": "npm" }'.match(config)).toHaveLength(1);
    expect(
      '"args": ["--prefer-offline", "-y", "@aquex/reasonbook@3.6.0"]'.match(config)
    ).toBeNull();
    const offenders = pages.flatMap((page) => {
      const text = read(page);
      return [
        ...text.split('\n').filter((line) => shell.test(line)),
        ...(text.match(config) ?? []),
      ].map((hit) => `${page}: ${hit.replace(/\s+/g, ' ').trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});

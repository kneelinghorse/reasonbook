// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves DOCS_ONLY=1 mirrors a documentation change after a release without moving its tag.
// ABOUTME: Uses local Git fixtures: a code change since the tag is refused and the remote stays unchanged.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Why: the public README's demo GIF loads from public main, so a re-recorded demo must reach main
// between releases. The release tag names what npm shipped; moving it, or publishing unreleased
// code to main under it, would make the public tree disagree with the published package.

const root = path.resolve(__dirname, '../..');
const fixtures: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Reasonbook Test',
  GIT_AUTHOR_EMAIL: 'rbook-test@example.invalid',
  GIT_COMMITTER_NAME: 'Reasonbook Test',
  GIT_COMMITTER_EMAIL: 'rbook-test@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/** A private source released as v1.2.3 and mirrored once, so public main and its tag agree. */
function released() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-mirror-docs-'));
  fixtures.push(dir);
  const source = path.join(dir, 'source');
  const publicSeed = path.join(dir, 'public-seed');
  const remote = path.join(dir, 'public.git');
  const scratch = path.join(dir, 'scratch');
  for (const name of [source, publicSeed, scratch]) fs.mkdirSync(name);
  git(publicSeed, 'init', '-q', '-b', 'main');
  write(publicSeed, 'README.md', 'previous public tree\n');
  git(publicSeed, 'add', '.');
  git(publicSeed, 'commit', '-qm', 'public fixture');
  git(dir, 'clone', '-q', '--bare', publicSeed, remote);
  git(source, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(
    path.join(root, 'scripts/mirror-to-public.sh'),
    path.join(source, 'scripts/mirror-to-public.sh')
  );
  write(source, 'package.json', JSON.stringify({ version: '1.2.3' }));
  write(source, 'README.md', 'released readme\n');
  write(source, 'docs/demo/README.md', 'old demo\n');
  write(source, 'src/index.ts', 'export const released = true;\n');
  write(source, 'plugins/reasonbook/skills/build/SKILL.md', 'released build instructions\n');
  git(source, 'config', 'diff.renames', 'true');
  write(source, 'rbook/private.txt', 'PRIVATE fixture bytes\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'release');
  git(source, 'tag', 'v1.2.3');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/mirror-to-public.sh', 'v1.2.3'], {
      cwd: source,
      env: { ...gitEnv, TMPDIR: scratch, PUBLIC_REMOTE: remote, PUBLIC_BRANCH: 'main', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  const first = run();
  if (first.status !== 0) throw new Error(`release mirror failed: ${first.stdout}${first.stderr}`);
  const ref = (name: string) => git(remote, 'rev-parse', name);
  const commit = (rel: string, text: string) => {
    write(source, rel, text);
    git(source, 'add', '.');
    git(source, 'commit', '-qm', `change ${rel}`);
  };
  return { source, remote, run, ref, commit };
}

afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

it('pushes a documentation change to public main and leaves the release tag where npm shipped it', () => {
  const f = released();
  const tagBefore = f.ref('refs/tags/v1.2.3^{commit}');
  f.commit('docs/demo/README.md', 'new demo, re-recorded\n');
  f.commit('plugins/reasonbook/README.md', 'plugin readme\n');
  f.commit(
    'scripts/mirror-to-public.sh',
    fs.readFileSync(path.join(root, 'scripts/mirror-to-public.sh'), 'utf8') + '\n'
  );
  f.commit('rbook/notes.md', 'private notes never reach public\n');

  const ran = f.run({ DOCS_ONLY: '1' });
  expect({ status: ran.status, out: ran.stdout + ran.stderr }).toMatchObject({ status: 0 });
  expect(f.ref('refs/tags/v1.2.3^{commit}')).toBe(tagBefore);
  expect(git(f.remote, 'show', 'main:docs/demo/README.md')).toBe('new demo, re-recorded');
  expect(git(f.remote, 'log', '-1', '--format=%s', 'main')).toBe(
    'docs: update the v1.2.3 public tree'
  );
  expect(git(f.remote, 'merge-base', '--is-ancestor', tagBefore, 'main')).toBe('');
});

it.each([
  ['src/index.ts', 'export const released = false;\n'],
  // A skill is Markdown, but marketplace installs read it from public main.
  ['plugins/reasonbook/skills/build/SKILL.md', 'unreleased instructions\n'],
])('refuses %s changed since the tag, so nothing unreleased reaches installs', (rel, text) => {
  const f = released();
  const mainBefore = f.ref('main');
  f.commit('docs/demo/README.md', 'new demo, re-recorded\n');
  f.commit(rel, text);

  const ran = f.run({ DOCS_ONLY: '1' });
  expect(ran.status).toBe(1);
  expect(ran.stdout + ran.stderr).toContain(`${rel} changed since v1.2.3 and installs run it`);
  expect(f.ref('main')).toBe(mainBefore);
});

it('changes nothing remote on a docs-only dry run', () => {
  const f = released();
  const mainBefore = f.ref('main');
  f.commit('docs/demo/README.md', 'new demo, re-recorded\n');
  const ran = f.run({ DOCS_ONLY: '1', DRY_RUN: '1' });
  expect(ran.status).toBe(0);
  expect(f.ref('main')).toBe(mainBefore);
});

it('refuses a skill renamed into docs because installs still lose its original path', () => {
  const f = released();
  const main = f.ref('main');
  const tag = f.ref('refs/tags/v1.2.3^{commit}');
  const skill = 'plugins/reasonbook/skills/build/SKILL.md';
  git(f.source, 'mv', skill, 'docs/moved-skill.md');
  git(f.source, 'commit', '-qm', 'move installed instructions into docs');
  expect(git(f.source, 'diff', '--name-status', 'v1.2.3', 'HEAD')).toContain('R100');
  const ran = f.run({ DOCS_ONLY: '1' });
  expect(ran.status).toBe(1);
  expect(ran.stdout + ran.stderr).toContain(`${skill} changed since v1.2.3 and installs run it`);
  expect(f.ref('main')).toBe(main);
  expect(f.ref('refs/tags/v1.2.3^{commit}')).toBe(tag);
  expect(git(f.remote, 'show', `main:${skill}`)).toBe('released build instructions');
});

it('allows a documentation-only rename while preserving the released tag', () => {
  const f = released();
  const tag = f.ref('refs/tags/v1.2.3^{commit}');
  git(f.source, 'mv', 'docs/demo/README.md', 'docs/demo/renamed.md');
  git(f.source, 'commit', '-qm', 'rename documentation');
  expect(f.run({ DOCS_ONLY: '1' }).status).toBe(0);
  expect(git(f.remote, 'show', 'main:docs/demo/renamed.md')).toBe('old demo');
  expect(f.ref('refs/tags/v1.2.3^{commit}')).toBe(tag);
});

it('still refuses an install rename when a tracked filename also names the release tag', () => {
  const f = released();
  const main = f.ref('main');
  const tag = f.ref('refs/tags/v1.2.3^{commit}');
  const skill = 'plugins/reasonbook/skills/build/SKILL.md';
  git(f.source, 'mv', skill, 'docs/moved-skill.md');
  f.commit('v1.2.3', 'ambiguous revision and filename');
  const result = f.run({ DOCS_ONLY: '1' });
  expect(result.status).toBe(1);
  expect(f.ref('main')).toBe(main);
  expect(f.ref('refs/tags/v1.2.3^{commit}')).toBe(tag);
});

it('stops before publishing when the changed-path census fails', () => {
  const f = released();
  const main = f.ref('main');
  const tag = f.ref('refs/tags/v1.2.3^{commit}');
  f.commit('docs/demo/README.md', 'allowed docs edit');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(path.dirname(f.source), 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = diff ]; then exit 42; fi\nexec '${realGit.replace(/'/g, "'\\''")}' "$@"\n`,
    { mode: 0o755 }
  );
  const result = f.run({ DOCS_ONLY: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  expect(result.status).toBe(42);
  expect(f.ref('main')).toBe(main);
  expect(f.ref('refs/tags/v1.2.3^{commit}')).toBe(tag);
});

it('without DOCS_ONLY, still refuses to mirror a tree the release tag does not name', () => {
  const f = released();
  const mainBefore = f.ref('main');
  f.commit('docs/demo/README.md', 'new demo, re-recorded\n');
  const ran = f.run();
  expect(ran.status).toBe(1);
  expect(ran.stdout + ran.stderr).toContain('public tag v1.2.3 resolves to');
  expect(f.ref('main')).toBe(mainBefore);
});

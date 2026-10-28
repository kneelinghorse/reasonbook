// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retains only a leak-checked public dry-run checkout for real marketplace installation tests.
// ABOUTME: Uses local Git fixtures to prove cleanup, committed-source authority and zero remote mutation.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

function fixture(leak = false, shellFault = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-mirror-retain-'));
  fixtures.push(dir);
  const source = path.join(dir, 'source');
  const publicSeed = path.join(dir, 'public-seed');
  const remote = path.join(dir, 'public.git');
  const scratch = path.join(dir, 'scratch');
  for (const name of [source, publicSeed, scratch]) fs.mkdirSync(name);
  git(publicSeed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(publicSeed, 'README.md'), 'previous public tree\n');
  git(publicSeed, 'add', '.');
  git(publicSeed, 'commit', '-qm', 'public fixture');
  git(dir, 'clone', '-q', '--bare', publicSeed, remote);
  git(source, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(
    path.join(root, 'scripts/mirror-to-public.sh'),
    path.join(source, 'scripts/mirror-to-public.sh')
  );
  if (shellFault) {
    const script = path.join(source, 'scripts/mirror-to-public.sh');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('\n', `\n${shellFault}\n`));
  }
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(source, 'README.md'), 'committed public content\n');
  fs.mkdirSync(path.join(source, 'rbook'));
  fs.writeFileSync(path.join(source, 'rbook', 'private.txt'), 'PRIVATE fixture bytes\n');
  fs.mkdirSync(path.join(source, '.claude-plugin'));
  fs.writeFileSync(path.join(source, '.claude-plugin', 'marketplace.json'), '{}\n');
  fs.mkdirSync(path.join(source, 'plugins', 'reasonbook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'plugins', 'reasonbook', 'plugin.txt'), 'public plugin\n');
  fs.mkdirSync(path.join(source, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(source, '.agents', 'plugins', 'marketplace.json'), '{}\n');
  fs.mkdirSync(path.join(source, 'plugins', 'reasonbook-chat'), { recursive: true });
  fs.writeFileSync(path.join(source, 'plugins', 'reasonbook-chat', 'plugin.json'), '{}\n');
  if (leak) fs.writeFileSync(path.join(source, 'accidental.sqlite'), 'must trip guard\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'private fixture');
  const refs = () => git(remote, 'show-ref');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/mirror-to-public.sh', 'v1.2.3'], {
      cwd: source,
      env: {
        ...gitEnv,
        TMPDIR: scratch,
        PUBLIC_REMOTE: remote,
        PUBLIC_BRANCH: 'main',
        DRY_RUN: '1',
        DRY_RUN_KEEP: '0',
        ...env,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
  return { source, scratch, refs, run };
}

afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

it('retains only the sanitized public checkout and leaves remote refs unchanged', () => {
  const f = fixture();
  const before = f.refs();
  const ran = f.run({ DRY_RUN_KEEP: '1' });
  expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });
  const retained = /^DRY_RUN_TREE=(.+)$/m.exec(ran.stdout)?.[1];
  expect(retained).toBeDefined();
  const tree = retained!;
  expect(fs.readFileSync(path.join(tree, 'README.md'), 'utf8')).toBe('committed public content\n');
  expect(fs.existsSync(path.join(tree, '.claude-plugin', 'marketplace.json'))).toBe(true);
  expect(fs.existsSync(path.join(tree, 'plugins', 'reasonbook', 'plugin.txt'))).toBe(true);
  expect(fs.existsSync(path.join(tree, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  expect(fs.existsSync(path.join(tree, 'plugins', 'reasonbook-chat', 'plugin.json'))).toBe(true);
  expect(fs.existsSync(path.join(tree, 'rbook'))).toBe(false);
  expect(git(tree, 'status', '--porcelain')).toBe('');
  expect(git(tree, 'rev-parse', 'v1.2.3^{commit}')).toBe(git(tree, 'rev-parse', 'HEAD'));
  expect(fs.readdirSync(f.scratch)).toEqual([path.basename(path.dirname(tree))]);
  expect(fs.readdirSync(path.dirname(tree))).toEqual(['public']);
  expect(f.refs()).toBe(before);
});

it('keeps default dry runs ephemeral and still refuses an uncommitted source', () => {
  const f = fixture();
  const before = f.refs();
  expect(f.run().status).toBe(0);
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  fs.writeFileSync(path.join(f.source, 'README.md'), 'uncommitted content\n');
  const dirty = f.run({ DRY_RUN_KEEP: '1' });
  expect(dirty.status).toBe(1);
  expect(dirty.stdout).toContain('working tree is dirty');
  expect(dirty.stdout).not.toContain('DRY_RUN_TREE=');
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

it('retains nothing after a leak-guard failure', () => {
  const f = fixture(true);
  const before = f.refs();
  const ran = f.run({ DRY_RUN_KEEP: '1' });
  expect(ran.status).toBe(1);
  expect(ran.stdout).toContain('ABORT: private content present');
  expect(ran.stdout).not.toContain('DRY_RUN_TREE=');
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

it.each(['rbook/', 'cmos/', 'analysis/'])(
  'refuses a nested JSON quotation from excluded %s source without exposing its text',
  (prefix) => {
    const f = fixture();
    const before = f.refs();
    fs.writeFileSync(
      path.join(f.source, 'quoted.json'),
      JSON.stringify({
        nested: [{ file: `${prefix}private.md`, text: 'PRIVATE QUOTATION WITNESS' }],
      })
    );
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-qm', 'plant private quotation');
    const ran = f.run({ DRY_RUN_KEEP: '1' });
    expect(ran.status).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('quoted private source');
    expect(ran.stdout + ran.stderr).not.toContain('PRIVATE QUOTATION WITNESS');
    expect(ran.stdout).not.toContain('DRY_RUN_TREE=');
    expect(fs.readdirSync(f.scratch)).toEqual([]);
    expect(f.refs()).toBe(before);
  }
);

it.each([
  ['/', 'Users', 'private-person', 'project'].join('/').replace('//', '/'),
  ['/', 'home', 'private-person', 'project'].join('/').replace('//', '/'),
  ['C:', 'Users', 'private-person', 'project'].join('\\'),
  ['/', 'Users', '…actual-person', 'project'].join('/').replace('//', '/'),
])('refuses a literal home path %s without retaining or publishing it', (home) => {
  const f = fixture();
  const before = f.refs();
  fs.writeFileSync(path.join(f.source, 'home.txt'), home);
  git(f.source, 'add', '.');
  git(f.source, 'commit', '-qm', 'plant home path');
  const ran = f.run({ DRY_RUN_KEEP: '1' });
  expect(ran.status).toBe(1);
  expect(ran.stdout + ran.stderr).toContain('absolute home path');
  expect(ran.stdout + ran.stderr).not.toContain(home);
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

it('allows public-source quotations, seed paths and private provenance without quoted text', () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.source, 'public.json'),
    JSON.stringify([
      { file: 'src/index.ts', text: 'public source witness' },
      { file: 'rbook-seed/docs/README.md', text: 'public seed witness' },
      { file: 'rbook/private.md', line: 3, lineSha256: 'hash-only-provenance' },
    ])
  );
  git(f.source, 'add', '.');
  git(f.source, 'commit', '-qm', 'retain public and hash-only evidence');
  expect(f.run().status).toBe(0);
});

it.each(['…', '...'])(
  'allows prose punctuation after an explicit %s home placeholder',
  (ellipsis) => {
    const f = fixture();
    const example = ['/', 'Users', `${ellipsis},`].join('/').replace('//', '/');
    fs.writeFileSync(path.join(f.source, 'example.txt'), `Example ${example} so no home is named.`);
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-qm', 'document a placeholder path');
    expect(f.run().status).toBe(0);
  }
);

it('cleans both temporary roots when the final retention move fails', () => {
  const f = fixture();
  const before = f.refs();
  const bin = path.join(path.dirname(f.source), 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  const ran = f.run({ DRY_RUN_KEEP: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  expect(ran.status).toBe(42);
  expect(ran.stdout).not.toContain('DRY_RUN_TREE=');
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

it('refuses retention outside dry-run mode before any remote mutation', () => {
  const f = fixture();
  const before = f.refs();
  const ran = f.run({ DRY_RUN: '0', DRY_RUN_KEEP: '1' });
  expect(ran.status).toBe(1);
  expect(`${ran.stdout}${ran.stderr}`).toContain('DRY_RUN_KEEP requires DRY_RUN=1');
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

it('cleans retained content if the final path receipt cannot be emitted', () => {
  const f = fixture(
    false,
    'echo() { case "${1:-}" in DRY_RUN_TREE=*) return 42;; esac; builtin echo "$@"; }'
  );
  const before = f.refs();
  const ran = f.run({ DRY_RUN_KEEP: '1' });
  expect(ran.status).toBe(42);
  expect(ran.stdout).not.toContain('DRY_RUN_TREE=');
  expect(fs.readdirSync(f.scratch)).toEqual([]);
  expect(f.refs()).toBe(before);
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rejects oversized outgoing history even when its file was deleted before release.
// ABOUTME: Real local Git objects prove the exact boundary and exclude already published blobs.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const script = path.resolve(__dirname, '../../scripts/check-outgoing-blobs.js');
let root: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Blob Test',
  GIT_COMMITTER_NAME: 'Blob Test',
  GIT_AUTHOR_EMAIL: 'blob@example.invalid',
  GIT_COMMITTER_EMAIL: 'blob@example.invalid',
};
function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  }).trim();
}
function commit(message: string): string {
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}
function run(boundary: string) {
  return spawnSync(process.execPath, [script, '--boundary', boundary, '--candidate', 'HEAD'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-outgoing-blobs-'));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'published boundary');
  commit('published');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('allows exactly 100 MiB but rejects a larger blob deleted at HEAD, counting each object once', () => {
  const boundary = git('rev-parse', 'HEAD');
  const large = path.join(root, 'candidate.bin');
  fs.closeSync(fs.openSync(large, 'w'));
  fs.truncateSync(large, 104857600);
  commit('exact boundary');
  const exact = run(boundary);
  expect({ status: exact.status, stderr: exact.stderr }).toMatchObject({ status: 0 });
  expect(JSON.parse(exact.stdout)).toMatchObject({
    success: true,
    thresholdBytes: 104857600,
    blobCount: 1,
    offenders: [],
  });
  fs.truncateSync(large, 104857601);
  commit('too large');
  const oid = git('rev-parse', 'HEAD:candidate.bin');
  fs.unlinkSync(large);
  commit('delete before release');
  const rejected = run(boundary);
  expect(rejected.status).toBe(1);
  expect(JSON.parse(rejected.stdout)).toMatchObject({
    success: false,
    boundary,
    candidate: git('rev-parse', 'HEAD'),
    blobCount: 2,
    offenders: [{ oid, bytes: 104857601 }],
  });
  // The predicate is outgoing reachability, not a policy over already-published history.
  expect(run('HEAD').status).toBe(0);
});

it('fails closed when the published boundary cannot be resolved', () => {
  const result = run('refs/remotes/missing/main');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Cannot inspect outgoing blobs');
});

it('fails closed on shallow history rather than certifying an incomplete object set', () => {
  fs.writeFileSync(path.join(root, '.git/shallow'), `${git('rev-parse', 'HEAD')}\n`);
  const result = run('HEAD');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('shallow');
});

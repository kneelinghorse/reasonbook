// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Tracked source names none of the operator's private projects (s107-m01, #793).
// ABOUTME: Its pattern is s101-m05's published one, read from that sweep, so no name enters this file.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** s101-m05's project-name pattern (tests/sweeps/s101-m05/before.json), already public. */
function publishedPattern(): RegExp {
  const sweep = path.join(REPO_ROOT, 'tests/sweeps/s101-m05/before.json');
  const literal = JSON.parse(fs.readFileSync(sweep, 'utf8')).patterns.projectNames as string;
  const parts = /^\/(.+)\/([a-z]*)$/.exec(literal);
  if (!parts) throw new Error(`s101-m05's projectNames is not a regex literal: ${literal}`);
  return new RegExp(parts[1], parts[2]);
}

/** Each line the pattern matches, as path:line. A file that is not UTF-8 text fails the check. */
function namedLines(files: ReadonlyArray<{ file: string; bytes: Buffer }>, pattern: RegExp) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return files.flatMap(({ file, bytes }) => {
    if (bytes.includes(0)) throw new Error(`${file} holds a NUL byte; this check reads text only`);
    return decoder
      .decode(bytes)
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}`] : []));
  });
}

describe('tracked source names no private project (s107-m01, #793)', () => {
  const pattern = publishedPattern();

  it('finds no line under src that the published project-name pattern matches', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const read = files.map((file) => ({
      file,
      bytes: fs.readFileSync(path.join(REPO_ROOT, file)),
    }));
    expect(namedLines(read, pattern)).toEqual([]);
  });

  it('fails when a name comes back, in any letter case', () => {
    // The fixture takes its name from the published pattern, so no name is written here.
    const name = pattern.source.split('|')[0];
    expect(name).toMatch(/^[a-z0-9]+$/);
    const fixture = `export const clean = 1;\n// measured on ${name.toUpperCase()}'s store\n`;
    expect(
      namedLines([{ file: 'src/fixture.ts', bytes: Buffer.from(fixture, 'utf8') }], pattern)
    ).toEqual(['src/fixture.ts:2']);
  });
});

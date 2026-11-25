// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises help through the packaged command's real entry and CLI parser.
// ABOUTME: A settlement request containing operands must receive its own usage error.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../helpers/upload-server-source';

const repo = path.resolve(__dirname, '../..');
let bin: string;
let fixture: string;
let loader: string;

beforeAll(() => {
  const packaged = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).bin
    .reasonbook;
  const entry = packaged.replace('./dist/', 'src/').replace(/\.js$/, '.ts');
  bin = path.join(repo, entry);
  fixture = prepareUploadServerSources(repo, [entry, 'src/cli.ts']);
  loader = path.join(fixture, 'bin-loader.cjs');
  fs.writeFileSync(loader, uploadServerSourceLoader(fixture));
});
afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

function run(argv: string[]) {
  const result = spawnSync(process.execPath, ['--require', loader, bin, ...argv], {
    cwd: fixture,
    env: { ...process.env, RBOOK_CONFIG_DIR: path.join(fixture, 'config') },
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

it.each(['--help', '-h'])('answers standalone %s through the installed entry', (flag) => {
  const result = run(['drafts', 'settle', flag]);
  expect(result).toMatchObject({
    status: 0,
    stdout: expect.stringContaining('Usage: reasonbook'),
    stderr: '',
  });
});

it.each([
  ['drafts', 'settle', '--help', '--dry-run'],
  ['drafts', 'settle', '--draft', 'P1', '-h'],
  ['--help', 'drafts', 'settle', '--decision', '7'],
  ['drafts', 'settle', '--draft', 'P1', '--decision', '7', '--project-root', '-h'],
])('rejects mixed help and settlement operands in %j', (...argv) => {
  const result = run(argv);
  expect(result).toMatchObject({
    status: 1,
    stdout: '',
    stderr: expect.stringMatching(/drafts settle --draft/),
  });
});

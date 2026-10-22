// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Runs the real bin compiled into a temporary install to prove version probes stay lightweight.
// ABOUTME: Denies imports outside the version dependency boundary and preserves argument semantics.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

let fixture: string;
let bin: string;
let guard: string;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-bin-version-')));
  const output = path.join(fixture, 'dist');
  fs.mkdirSync(output);
  // Compile only the tested entry and its lightweight helper, never the real dist/ tree.
  for (const name of ['bin', 'server-version', 'cli/usage']) {
    const source = path.resolve(__dirname, `../../src/${name}.ts`);
    const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    });
    fs.mkdirSync(path.dirname(path.join(output, `${name}.js`)), { recursive: true });
    fs.writeFileSync(path.join(output, `${name}.js`), compiled.outputText);
  }
  // A CLI probe records what the real router passed; loading it is allowed only for those tests.
  fs.writeFileSync(
    path.join(output, 'cli.js'),
    'exports.main = argv => process.stdout.write(JSON.stringify(argv) + "\\n");'
  );
  bin = path.join(output, 'bin.js');
  guard = path.join(fixture, 'deny.cjs');
  fs.writeFileSync(
    guard,
    `const Module = require('module');
const fs = require('fs');
const path = require('path');
const allowed = new Set(['fs', 'path', 'module', path.join(__dirname, 'dist/bin.js'), './server-version', './cli/usage']);
if (process.env.VERSION_TEST_ALLOW_CLI === '1') allowed.add('./cli');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (!allowed.has(request)) throw new Error('DEPENDENCY_DENIED: ' + request);
  return originalLoad.call(this, request, parent, isMain);
};
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'unlinkSync']) {
  fs[name] = () => { throw new Error('WRITE_DENIED: ' + name); };
}
`
  );
});

afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

function run(argv: string[], allowCli = false) {
  return spawnSync(process.execPath, ['--require', guard, bin, ...argv], {
    cwd: fixture,
    env: { ...process.env, VERSION_TEST_ALLOW_CLI: allowCli ? '1' : '0' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function setPackage(content: string | undefined) {
  const file = path.join(fixture, 'package.json');
  if (content === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
}

describe('the bin answers server --version without loading the server', () => {
  it.each([
    ['--version'],
    ['serve', '--version'],
    ['--version', 'serve'],
    ['--help', '--version'],
    ['--project-root', '/an/uninitialized/project', '--version'],
    // Preserve runServer's includes('--version') behavior, even in a value position.
    ['--project-root', '--version'],
  ])('prints the package version with argument sequence %j', (...argv) => {
    setPackage(JSON.stringify({ version: '3.3.0-rc.1' }));
    const result = run(argv);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('reasonbook 3.3.0-rc.1\n');
  });

  it.each([undefined, '{}', '{"version":""}', '{"version":42}'])(
    'preserves the fallback when the package content is %s',
    (content) => {
      setPackage(content);
      const result = run(['--version']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('reasonbook 2.0.0\n');
    }
  );

  it('preserves the reader fallback for malformed JSON after Node resolves the module', () => {
    // Node itself refuses malformed install metadata before loading a bin. Exercise the reader's
    // existing catch independently, after loading the helper from a valid CommonJS package.
    setPackage('{}');
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        guard,
        '-e',
        "const { getServerVersion } = require('./server-version'); " +
          "require('fs').readFileSync = () => '{'; process.stdout.write(getServerVersion());",
      ],
      { cwd: path.dirname(bin), encoding: 'utf8', timeout: 5000 }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('2.0.0');
  });

  it.each([
    [
      ['review', '--version'],
      ['review', '--version'],
    ],
    [
      ['misspelled', '--version'],
      ['misspelled', '--version'],
    ],
    [
      ['--version', 'hook', 'prompt'],
      ['hook', 'prompt', '--version'],
    ],
  ])('leaves CLI routing intact for %j', (argv, expected) => {
    const result = run(argv, true);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it.each([[], ['serve']])('still attempts the server for non-version arguments %j', (...argv) => {
    const result = run(argv);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEPENDENCY_DENIED: ./index');
  });

  it.each([
    ['--help'],
    ['-h'],
    ['serve', '--help'],
    ['serve', '-h'],
    ['init', '--help'],
    ['init', '-h'],
    ['hook', 'prompt', '--help'],
    ['--project-root', '/uninitialized/project', '--help'],
  ])('help %j is a zero-write, no-server usage exit', (...argv) => {
    const result = run(argv);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: reasonbook');
    expect(result.stdout).toContain('init');
  });

  it.each([['--f9-unknown'], ['-v'], ['serve', '--f9-unknown=value']])(
    'unsupported server options %j never load the server',
    (...argv) => {
      const result = run(argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/unknown option.*--help/i);
      expect(result.stderr).not.toContain('DEPENDENCY_DENIED');
    }
  );

  it.each([
    ["require('./index')", 'DEPENDENCY_DENIED: ./index'],
    ["require('@modelcontextprotocol/server')", 'DEPENDENCY_DENIED: @modelcontextprotocol'],
    ["require('./tools/rbook/client')", 'DEPENDENCY_DENIED: ./tools/rbook/client'],
    ["require('fs').writeFileSync('forbidden', 'data')", 'WRITE_DENIED: writeFileSync'],
  ])('the child guard catches forbidden work: %s', (code, refusal) => {
    const result = spawnSync(process.execPath, ['--require', guard, '-e', code], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
    expect(fs.existsSync(path.join(fixture, 'forbidden'))).toBe(false);
  });
});

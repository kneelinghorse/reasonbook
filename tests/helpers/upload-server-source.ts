// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Compiles source once for real upload-shutdown server children without touching dist.
// ABOUTME: Cached source remains content-keyed so each fixture executes the candidate it exercises.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * s98-m08 (#733): load the TypeScript source, compiled once per test file. Each child used to
 * transpile src/index.ts and its imports itself inside its 25 s budget, and under two concurrent
 * full suites that alone spent it ("Upload did not start"). The children now read what the warm-up
 * below compiled, keyed by path and content, so the budget covers starting and uploading only.
 */
export const uploadServerSourceLoader = (compiled: string): string => `const fs = require('fs');
const crypto = require('crypto');
const ts = require(${JSON.stringify(require.resolve('typescript'))});
require.extensions['.ts'] = (module, file) => {
  const source = fs.readFileSync(file, 'utf8');
  const key = crypto.createHash('sha256').update(file).update(source).digest('hex');
  const cached = require('path').join(${JSON.stringify(compiled)}, key + '.js');
  let output;
  try {
    output = fs.readFileSync(cached, 'utf8');
  } catch {
    output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText;
    fs.writeFileSync(cached + '.' + process.pid, output);
    fs.renameSync(cached + '.' + process.pid, cached);
  }
  module._compile(output, file);
};
`;

export function prepareUploadServerSources(repo: string): string {
  const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-shutdown-compiled-'));
  const warm = spawnSync(
    process.execPath,
    [
      '-e',
      `${uploadServerSourceLoader(compiled)}
for (const file of ['src/index.ts', 'src/tools/rbook/dashboard-client.ts', 'src/tools/rbook/dashboard-upload.ts'])
  require(require('path').join(${JSON.stringify(repo)}, file));`,
    ],
    {
      encoding: 'utf8',
      timeout: 150_000,
      env: {
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        RBOOK_CONFIG_DIR: path.join(compiled, 'config'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        RBOOK_SHARED_SYNC: 'off',
      },
    }
  );
  if (warm.status !== 0 || warm.signal !== null || warm.stderr !== '') {
    fs.rmSync(compiled, { recursive: true, force: true });
    throw new Error(
      JSON.stringify({ status: warm.status, signal: warm.signal, stderr: warm.stderr })
    );
  }
  return compiled;
}

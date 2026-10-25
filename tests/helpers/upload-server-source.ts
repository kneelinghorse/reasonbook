// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reuses run-owned compiled bytes for isolated application fixtures without touching dist.
// ABOUTME: Keys include source, compiler and options; failed warm-ups preserve bounded diagnostics.

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const UPLOAD_SOURCE_CACHE_ENV = 'JEST_RECORD_UPLOAD_SOURCE_CACHE';
const cacheMarker = 'source-cache.json';
const compilerPath = require.resolve('typescript');
const compilerOptions = { module: 'CommonJS', target: 'ES2022', esModuleInterop: true };
const defaultEntries = [
  'src/index.ts',
  'src/tools/rbook/dashboard-client.ts',
  'src/tools/rbook/dashboard-upload.ts',
];

// Only compiled bytes are shared. Each application import still runs in its own child/config.
export const uploadServerSourceLoader = (compiled: string): string => {
  const compilerIdentity = createHash('sha256')
    .update(fs.readFileSync(compilerPath))
    .update(JSON.stringify(compilerOptions))
    .digest('hex');
  return `const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
let sourceCache = ${JSON.stringify(compiled)};
try { sourceCache = JSON.parse(fs.readFileSync(path.join(sourceCache, ${JSON.stringify(cacheMarker)}), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
require.extensions['.ts'] = (module, file) => {
  const source = fs.readFileSync(file, 'utf8');
  const key = crypto.createHash('sha256').update(JSON.stringify([file, source, ${JSON.stringify(compilerIdentity)}])).digest('hex');
  const cached = path.join(sourceCache, key + '.js');
  let output;
  try {
    output = fs.readFileSync(cached, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const ts = require(${JSON.stringify(compilerPath)});
    output = ts.transpileModule(source, {
      compilerOptions: { ...${JSON.stringify(compilerOptions)},
        module: ts.ModuleKind[${JSON.stringify(compilerOptions.module)}],
        target: ts.ScriptTarget[${JSON.stringify(compilerOptions.target)}] }
    }).outputText;
    const temporary = cached + '.' + process.pid + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(temporary, output);
      fs.renameSync(temporary, cached);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  module._compile(output, file);
};
`;
};

export function prepareUploadServerSources(
  repo: string,
  entries: readonly string[] = defaultEntries
): string {
  const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-shutdown-compiled-'));
  try {
    const shared = process.env[UPLOAD_SOURCE_CACHE_ENV];
    if (shared) fs.writeFileSync(path.join(compiled, cacheMarker), JSON.stringify(shared));
    warmSources(repo, entries, compiled, shared ?? compiled);
    return compiled;
  } catch (error) {
    fs.rmSync(compiled, { recursive: true, force: true });
    throw error;
  }
}

/** Runs inside Jest globalSetup, before workers and inside the load gate's existing clock. */
export function prepareUploadServerRunCache(repo: string): string {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-jest-source-cache-'));
  try {
    warmSources(
      repo,
      [
        ...defaultEntries,
        'src/cli.ts',
        'src/tools/rbook/rbook-decisions.ts',
        'src/intelligence/embedding-pipeline.ts',
        'src/tools/rbook/rbook-mission-start.ts',
      ],
      cache,
      cache
    );
    fs.rmSync(path.join(cache, 'config'), { recursive: true, force: true });
    return cache;
  } catch (error) {
    // Jest may not call globalTeardown when globalSetup itself fails.
    fs.rmSync(cache, { recursive: true, force: true });
    throw error;
  }
}

function warmSources(
  repo: string,
  entries: readonly string[],
  compiled: string,
  cache: string
): void {
  const started = Date.now();
  const warm = spawnSync(
    process.execPath,
    [
      '-e',
      `${uploadServerSourceLoader(compiled)}
for (const file of ${JSON.stringify(entries)})
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
  if (warm.error || warm.status !== 0 || warm.signal !== null || warm.stderr !== '') {
    const error = warm.error as NodeJS.ErrnoException | undefined;
    const stdout = warm.stdout ?? '';
    const stderr = warm.stderr ?? '';
    let cacheEntries: number | null = null;
    let cacheReadError: { code?: string; message: string } | undefined;
    try {
      cacheEntries = fs.readdirSync(cache).filter((file) => file.endsWith('.js')).length;
    } catch (failure) {
      const detail = failure as NodeJS.ErrnoException;
      cacheReadError = { code: detail.code, message: detail.message };
    }
    throw new Error(
      JSON.stringify({
        status: warm.status,
        signal: warm.signal,
        pid: warm.pid,
        elapsedMs: Date.now() - started,
        error: error
          ? {
              name: error.name,
              message: error.message,
              code: error.code,
              errno: error.errno,
              syscall: error.syscall,
              path: error.path,
            }
          : null,
        cacheEntries,
        cacheReadError,
        stdout: stdout.slice(-8192),
        stderr: stderr.slice(-8192),
        stdoutTruncated: stdout.length > 8192,
        stderrTruncated: stderr.length > 8192,
      })
    );
  }
}

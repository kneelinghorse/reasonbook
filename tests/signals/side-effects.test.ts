// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — the signals library has no side effects of its own: a read starts no timer, network call, child process,
// ABOUTME: project discovery, sqlite-vec load or embedder and writes no byte; importing it loads none of the client's machinery.
import * as net from 'net';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';

import { readSignals } from '../../src/signals';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import {
  setEmbedderForTesting,
  setTransformersLoaderForTesting,
} from '../../src/intelligence/embedding-pipeline';
import { ensureProposalsTable, insertDraft, rawRunner } from '../../src/tools/rbook/proposals';

/* eslint-disable @typescript-eslint/no-require-imports */
const childProcess = require('child_process') as Record<string, unknown>;
const dns = require('dns') as Record<string, unknown>;
const http = require('http') as Record<string, unknown>;
const https = require('https') as Record<string, unknown>;
const resolution = require('../../src/intelligence/project-resolution') as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-require-imports */

const REPO = path.resolve(__dirname, '..', '..');
const hits: string[] = [];
let inside = false;
jest.mock('sqlite-vec', () => {
  const actual = jest.requireActual<typeof import('sqlite-vec')>('sqlite-vec');
  return {
    ...actual,
    load: (db: unknown) => {
      if (inside) hits.push('sqlite-vec load');
      return actual.load(db as never);
    },
  };
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const restores: Array<() => void> = [];
function watch(owner: Record<string, unknown>, name: string, label: string): void {
  const original = owner[name] as (...args: unknown[]) => unknown;
  owner[name] = function (this: unknown, ...args: unknown[]) {
    if (inside) hits.push(label);
    return original.apply(this, args);
  };
  restores.push(() => {
    owner[name] = original;
  });
}

function storeWithRows(): { dbPath: string; runtimeDir: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-signals-side-')));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'rbook.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'old-schemas', 'schema-3.0.0.sql'),
      'utf8'
    )
  );
  db.exec("INSERT INTO metadata (key, value) VALUES ('project_id', 'side-effects')");
  const run = rawRunner(db);
  ensureProposalsTable(run);
  insertDraft(run, {
    text: 'A draft.',
    kind: 'decision',
    sourceSession: null,
    assistantExcerpt: null,
    evidence: [],
    outsideContent: null,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const runtimeDir = path.join(dir, 'runtime', 'drafts');
  fs.mkdirSync(runtimeDir, { recursive: true });
  return { dbPath, runtimeDir };
}

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the signals library has no side effects of its own (s97-m01)', () => {
  it('reads a store with no timer, network, child process, discovery, vector load or embedder, and writes nothing', () => {
    const { dbPath, runtimeDir } = storeWithRows();
    const cwd = process.cwd();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-signals-side-cwd-'));
    tmpDirs.push(empty);
    process.chdir(empty);
    const root = process.env.RBOOK_PROJECT_ROOT;
    delete process.env.RBOOK_PROJECT_ROOT;
    watch(globalThis as never, 'setTimeout', 'timer');
    watch(globalThis as never, 'setInterval', 'timer');
    watch(globalThis as never, 'setImmediate', 'timer');
    watch(globalThis as never, 'fetch', 'network');
    watch(net.Socket.prototype as never, 'connect', 'network');
    watch(http, 'request', 'network');
    watch(https, 'request', 'network');
    watch(dns, 'lookup', 'network');
    for (const verb of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ])
      watch(childProcess, verb, 'child process');
    watch(RbookDetector.prototype as never, 'detect', 'project discovery');
    watch(resolution, 'resolveProjectRootEnhanced', 'project discovery');
    setEmbedderForTesting(async () => {
      if (inside) hits.push('embedder');
      return new Float32Array(384);
    });
    setTransformersLoaderForTesting(async () => {
      if (inside) hits.push('model download');
      throw new Error('no model in tests');
    });
    const before = sha(dbPath);
    try {
      inside = true;
      const report = readSignals(dbPath, { now: Date.now(), draftRuntimeDir: runtimeDir });
      inside = false;
      expect(report.signals.find((entry) => entry.kind === 'drafts_pending')?.count).toBe(1);
    } finally {
      inside = false;
      while (restores.length) restores.pop()!();
      setEmbedderForTesting(null);
      setTransformersLoaderForTesting(null);
      process.chdir(cwd);
      if (root !== undefined) process.env.RBOOK_PROJECT_ROOT = root;
    }
    expect(hits).toEqual([]);
    expect(sha(dbPath)).toBe(before);
    // A missing runtime file is reported, never created.
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });

  it('loads none of the client’s machinery when imported, and starts nothing', () => {
    // A fresh process imports the library alone and reports every module it loaded and every
    // timer, socket or child process started while it did.
    const probe = `
      const { builtinModules } = require('module');
      const counts = { timer: 0, network: 0, child: 0 };
      for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
        const original = global[name];
        global[name] = (...args) => { counts.timer += 1; return original(...args); };
      }
      const net = require('net');
      const connect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (...args) { counts.network += 1; return connect.apply(this, args); };
      const cp = require('child_process');
      for (const verb of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = cp[verb];
        cp[verb] = (...args) => { counts.child += 1; return original(...args); };
      }
      require(${JSON.stringify(path.join(REPO, 'tests', 'helpers', 'ts-register.js'))});
      const before = new Set(Object.keys(require.cache));
      require(${JSON.stringify(path.join(REPO, 'src', 'signals', 'index.ts'))});
      const loaded = Object.keys(require.cache).filter((file) => !before.has(file));
      process.stdout.write(JSON.stringify({ counts, loaded }));
    `;
    const ran = spawnSync(process.execPath, ['-e', probe], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(ran.status).toBe(0);
    const { counts, loaded } = JSON.parse(ran.stdout) as {
      counts: Record<string, number>;
      loaded: string[];
    };
    expect(counts).toEqual({ timer: 0, network: 0, child: 0 });
    const ours = loaded
      .filter((file) => file.startsWith(path.join(REPO, 'src')))
      .map((file) => path.relative(REPO, file))
      .sort();
    const outside = loaded.filter(
      (file) =>
        !file.startsWith(path.join(REPO, 'src')) &&
        !/node_modules[\\/]better-sqlite3[\\/]|node_modules[\\/](bindings|file-uri-to-path)[\\/]/.test(
          file
        )
    );
    // The library's own files and the leaf modules whose rules it reuses: nothing of the server,
    // the client, discovery, embeddings or the network.
    expect(ours).toEqual(
      [
        'src/intelligence/legacy-compat.ts',
        'src/intelligence/product-names.ts',
        'src/server-version.ts',
        'src/signals/brief.ts',
        'src/signals/brief-text.ts',
        'src/signals/feedback-kinds.ts',
        'src/signals/index.ts',
        'src/signals/read-signals.ts',
        'src/signals/report.ts',
        'src/signals/rules-activity.ts',
        'src/signals/rules-records.ts',
        'src/signals/store-read.ts',
        'src/tools/rbook/decision-citations.ts',
        'src/tools/rbook/draft-grammar.ts',
        'src/tools/rbook/errors.ts',
        'src/tools/rbook/keyword-extraction.ts',
        'src/tools/rbook/next-step-lease.ts',
        'src/tools/rbook/proposals.ts',
        'src/tools/rbook/record-link-extractor.ts',
        'src/tools/rbook/record-link-reader.ts',
        'src/tools/rbook/record-link-schema.ts',
        'src/tools/rbook/record-link-store.ts',
        'src/tools/rbook/store-key.ts',
        'src/tools/rbook/stored-time.ts',
        'src/tools/rbook/terminal-status.ts',
        'src/utils/one-line.ts',
        'src/utils/project-display-name.ts',
      ].sort()
    );
    expect(outside).toEqual([]);
  });
});

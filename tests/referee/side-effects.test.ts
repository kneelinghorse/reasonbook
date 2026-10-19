// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R1, "no side effects of its own") — every referee call runs with no sqlite-vec load, embedder,
// ABOUTME: timer, network connection, child process or working-folder discovery; a test that fails on the first one.
import * as net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getEmbedder,
  setEmbedderForTesting,
  setTransformersLoaderForTesting,
} from '../../src/intelligence/embedding-pipeline';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import {
  conflicts,
  exportSnapshot,
  members,
  migrate,
  peer,
  peers,
  recentChanges,
  remove,
  waiting,
  type RefereeLocation,
  type RefereeOutcome,
} from '../../src/referee';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  inside,
  joinedReferee,
  joinThroughReferee,
  syncWithReferee,
} from '../helpers/referee-fixture';
import { onCopy, type Copy } from '../helpers/shared-copies';
import { admitSuccessor } from '../../src/tools/rbook/record-admit-successor';

// The modules themselves, not import namespaces, whose bindings cannot be replaced.
/* eslint-disable @typescript-eslint/no-require-imports */
const childProcess = require('child_process') as Record<string, unknown>;
const dns = require('dns') as Record<string, unknown>;
const http = require('http') as Record<string, unknown>;
const https = require('https') as Record<string, unknown>;
const resolution = require('../../src/intelligence/project-resolution') as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-require-imports */

const mockHits: string[] = [];
jest.mock('sqlite-vec', () => {
  const actual = jest.requireActual<typeof import('sqlite-vec')>('sqlite-vec');
  return {
    ...actual,
    load: (db: unknown) => {
      if (require('../helpers/referee-fixture').inside.referee) mockHits.push('sqlite-vec load');
      return actual.load(db as never);
    },
  };
});

let fixture: ReplicaFixture;
let cwd: string;
const restores: Array<() => void> = [];

/** Wrap `owner[name]` so a call made while a referee call runs is recorded as that side effect. */
function watch(owner: Record<string, unknown>, name: string, label: string): void {
  const original = owner[name] as (...args: unknown[]) => unknown;
  owner[name] = function (this: unknown, ...args: unknown[]) {
    if (inside.referee) mockHits.push(label);
    return original.apply(this, args);
  };
  restores.push(() => {
    owner[name] = original;
  });
}

beforeEach(() => {
  fixture = replicaFixture('rbook-side-');
  mockHits.length = 0;
  // No working folder to discover: the library is run from an empty folder with no project root set.
  cwd = process.cwd();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-side-cwd-'));
  process.chdir(empty);
  restores.push(() => {
    process.chdir(cwd);
    fs.rmSync(empty, { recursive: true, force: true });
  });
  const root = process.env.RBOOK_PROJECT_ROOT;
  delete process.env.RBOOK_PROJECT_ROOT;
  restores.push(() => {
    if (root !== undefined) process.env.RBOOK_PROJECT_ROOT = root;
  });
  watch(globalThis as never, 'setTimeout', 'timer');
  watch(globalThis as never, 'setInterval', 'timer');
  watch(globalThis as never, 'setImmediate', 'timer');
  watch(globalThis as never, 'fetch', 'network');
  watch(net.Socket.prototype as never, 'connect', 'network');
  watch(http, 'request', 'network');
  watch(https, 'request', 'network');
  watch(dns, 'lookup', 'network');
  for (const verb of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    watch(childProcess, verb, 'child process');
  watch(RbookDetector.prototype as never, 'detect', 'project discovery');
  watch(resolution, 'resolveProjectRootEnhanced', 'project discovery');
  setEmbedderForTesting(async () => {
    if (inside.referee) mockHits.push('embedder');
    return new Float32Array(384);
  });
  setTransformersLoaderForTesting(async () => {
    if (inside.referee) mockHits.push('model download');
    throw new Error('no model in tests');
  });
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  setEmbedderForTesting(null);
  setTransformersLoaderForTesting(null);
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

describe('the referee library has no side effects of its own (s97-m09)', () => {
  it('runs a handover in, a join, exchanges, every view, a copy, a removal and a migration with none', async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this, to be embedded on copies.',
    });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    const views: Array<(location: RefereeLocation) => Promise<RefereeOutcome<unknown>>> = [
      members,
      (location) => recentChanges(location),
      conflicts,
      peers,
      waiting,
      migrate,
    ];
    for (const view of views)
      expect((await ask(hosted.referee, (location) => view(location))).error).toBeUndefined();
    const exported = path.join(fixture.tmp, 'export', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(exported), { recursive: true });
    expect(
      (await ask(hosted.referee, (location) => exportSnapshot(location, exported))).error
    ).toBeUndefined();
    // The successor and report calls run under the same watch: a new identity for Darryl's copy,
    // his report of an exchange, and the referee taking a fresh block while it is still a member.
    const d = await callerOf(fixture.tmp, darryl, 'acct-darryl');
    expect(
      (
        await ask(hosted.referee, (location) =>
          peer(location, 'admitSuccessor', { replicaId: d.replicaId }, d)
        )
      ).error
    ).toBeUndefined();
    expect(
      (
        await ask(hosted.referee, (location) =>
          peer(
            location,
            'exchanged',
            { replicaId: d.replicaId, marks: { [d.replicaId]: 1 }, digest: null },
            d
          )
        )
      ).error
    ).toBeUndefined();
    const second = await joinedReferee(fixture.tmp, { name: 'second' });
    await syncWithReferee(fixture.tmp, second, second.owner, second.ownerAccount);
    const admitted = await onCopy(fixture.tmp, second.owner, (client) =>
      admitSuccessor(client, { replicaId: second.refereeReplica, sameId: true })
    );
    await syncWithReferee(fixture.tmp, second, second.owner, second.ownerAccount);
    const relay = await callerOf(fixture.tmp, second.owner, second.ownerAccount);
    expect(
      (
        await ask(second.referee, (location) =>
          peer(
            location,
            'takeSuccessor',
            { successor: admitted.data, reason: 'block', authorityReceived: null },
            relay
          )
        )
      ).error
    ).toBeUndefined();
    expect(
      (await ask(hosted.referee, (location) => remove(location, { accountId: 'acct-darryl' })))
        .error
    ).toBeUndefined();
    // The copies, outside the library, embed what they merged: the watch tells them apart.
    expect(mockHits).toEqual([]);
  }, 240000);

  it('the watch itself fires: a vec load, the embedder, a timer and a connection inside a referee call are caught', async () => {
    const store = path.join(fixture.tmp, 'watched.sqlite');
    inside.referee = true;
    try {
      const opened = await RbookDatabaseClient.create({ dbPath: store, registerProject: false });
      opened.data?.close();
      await (
        await getEmbedder()
      )('a text');
      setTimeout(() => undefined, 0);
      await fetch('http://127.0.0.1:9/').catch(() => undefined);
    } finally {
      inside.referee = false;
    }
    expect(new Set(mockHits)).toEqual(new Set(['sqlite-vec load', 'embedder', 'timer', 'network']));
  }, 30000);
});

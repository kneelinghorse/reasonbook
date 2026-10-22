// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery contributions are scrubbed, switch-gated and accepted once per recovery and copy.
// ABOUTME: Lost acknowledgements retry safely, malformed offers send nothing, and local MCP writes continue.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import Database from 'better-sqlite3';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import * as copies from '../../../src/tools/rbook/record-fresh-copy';
import { rememberPeer } from '../../../src/tools/rbook/record-peers';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { storeOpener, syncPeers } from '../../../src/tools/rbook/record-sync';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, type Copy } from '../../helpers/shared-copies';

const route = {
  kind: 'dashboard' as const,
  url: 'http://127.0.0.1:54321',
  projectId: 'dashboard-id',
};
let fixture: ReplicaFixture;
let copy: Copy;
let saved: Record<string, string | undefined>;
let offer: Record<string, unknown>;
let uploads: Array<{ recoveryId: string; replicaId: string; file: string }>;
let rejectReceipt: boolean;
let uploadRefusal: { status: number; body: unknown } | undefined;
beforeEach(async () => {
  saved = Object.fromEntries(
    ['RBOOK_SHARED_SYNC', 'RBOOK_DASHBOARD_SHARING', 'RBOOK_DASHBOARD_URL'].map((key) => [
      key,
      process.env[key],
    ])
  );
  process.env.RBOOK_SHARED_SYNC = 'on';
  process.env.RBOOK_DASHBOARD_SHARING = 'on';
  process.env.RBOOK_DASHBOARD_URL = route.url;
  fixture = replicaFixture('rbook-recovery-client-');
  copy = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, copy, (client) => rememberPeer(client, copy.replicaId, { route }));
  offer = {
    recoveryId: 'recovery-one',
    projectId: route.projectId,
    state: 'collecting',
    lostHead: { replicaId: copy.replicaId, seq: 0, hash: null },
  };
  uploads = [];
  rejectReceipt = false;
  uploadRefusal = undefined;
  const client = {
    relayPeerCall: async () => ({
      success: true,
      data: {
        status: 409,
        body: {
          success: false,
          error: {
            code: offer.state === 'cancelled' ? 'REFEREE_NEEDS_RECOVERY' : 'REFEREE_RECOVERING',
            message: 'The dashboard is recovering.',
            suggestion: 'Keep writing locally.',
            currentState: offer,
          },
        },
      },
    }),
    relayRecoveryCopy: async (
      _projectId: string,
      upload: { recoveryId: string; replicaId: string; file: string }
    ) => {
      uploads.push(upload);
      expect(fs.existsSync(upload.file)).toBe(true);
      const db = new Database(upload.file, { readonly: true });
      try {
        expect(
          (db.prepare('SELECT count(*) AS n FROM record_changes').get() as { n: number }).n
        ).toBeGreaterThan(0);
        expect(
          db.prepare("SELECT value FROM metadata WHERE key = 'replica_dashboard_recovery'").get()
        ).toBeUndefined();
      } finally {
        db.close();
      }
      if (uploadRefusal) return { success: true, data: uploadRefusal };
      return {
        success: true,
        data: {
          status: 200,
          body: {
            success: true,
            data: {
              recoveryId: upload.recoveryId,
              replicaId: upload.replicaId,
              projectId: rejectReceipt ? 'wrong-project' : route.projectId,
              state: 'collecting',
            },
          },
        },
      };
    },
  } as unknown as DashboardClient;
  jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'user-scoped', matchedProjectRoot: null },
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function sync() {
  useMachine(fixture.tmp, copy.machine);
  return syncPeers(storeOpener(dbOf(copy.root)), {
    unchecked: storeOpener(dbOf(copy.root), { replicaCheck: false }),
    projectRoot: copy.root,
  });
}

it('uploads once across separate syncs, cleans the snapshot and keeps MCP writes available', async () => {
  await sync();
  expect(uploads).toHaveLength(1);
  expect(fs.existsSync(uploads[0].file)).toBe(false);
  const wrote = await call('rbook_decisions', {
    action: 'record',
    content: 'Work continues while the referee is recovering.',
    projectRoot: copy.root,
  });
  expect(wrote.success).toBe(true);
  await sync();
  expect(uploads).toHaveLength(1);
  const review = await onCopy(fixture.tmp, copy, (client) => sharedRecordReview(client));
  expect(JSON.stringify(review)).toMatch(/recovery.*collecting.*uploaded/i);
});

it.each(['RBOOK_SHARED_SYNC', 'RBOOK_DASHBOARD_SHARING'])(
  '%s off prevents both snapshot creation and recovery upload in a manual sync',
  async (key) => {
    process.env[key] = 'OFF';
    const built = jest.spyOn(copies, 'buildFreshCopy');
    await sync();
    expect(uploads).toHaveLength(0);
    expect(built).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await onCopy(fixture.tmp, copy, (client) => sharedRecordReview(client)))
    ).toContain(key);
  }
);

it('rejects an offer for another dashboard project or referee before building a copy', async () => {
  const built = jest.spyOn(copies, 'buildFreshCopy');
  offer.projectId = 'another-project';
  await sync();
  offer.projectId = route.projectId;
  offer.lostHead = { replicaId: 'another-referee', seq: 0, hash: null };
  await sync();
  expect(uploads).toHaveLength(0);
  expect(built).not.toHaveBeenCalled();
});

it('never stores an unrelated upload receipt as success, so a retry can obtain the real receipt', async () => {
  rejectReceipt = true;
  await sync();
  rejectReceipt = false;
  await sync();
  expect(uploads).toHaveLength(2);
  await sync();
  expect(uploads).toHaveLength(2);
});

it('a cancelled recovery updates review without uploading again or restarting it', async () => {
  await sync();
  offer.state = 'cancelled';
  await sync();
  expect(uploads).toHaveLength(1);
  const review = JSON.stringify(
    await onCopy(fixture.tmp, copy, (client) => sharedRecordReview(client))
  );
  expect(review).toMatch(/recovery cancelled/);
  expect(review).not.toMatch(/recovery collecting/);
});

it('a new recovery may receive a new contribution while the prior receipt stays deduplicated', async () => {
  await sync();
  offer.recoveryId = 'recovery-two';
  await sync();
  expect(uploads).toHaveLength(2);
  offer.recoveryId = 'recovery-one';
  await sync();
  expect(uploads).toHaveLength(2);
});

it('accepts the empty chain hash only for a newly hosted zero-sequence referee', async () => {
  offer.lostHead = { replicaId: copy.replicaId, seq: 1, hash: '' };
  await sync();
  expect(uploads).toHaveLength(0);
  offer.lostHead = { replicaId: copy.replicaId, seq: 0, hash: '' };
  await sync();
  expect(uploads).toHaveLength(1);
});

it.each([
  {
    status: 413,
    body: { success: false, error: 'The recovery copy is too large.', limit: 4096 },
    expected: ['HTTP 413', '4096 bytes', 'too large', 'upload limit'],
  },
  {
    status: 503,
    body: {
      success: false,
      error: {
        message: 'The recovery volume is unavailable.',
        suggestion: 'Retry after storage is restored.',
      },
    },
    expected: ['HTTP 503', 'volume is unavailable', 'Retry after storage is restored'],
  },
])(
  'preserves an HTTP $status upload refusal and retries only without an accepted receipt',
  async ({ status, body, expected }) => {
    uploadRefusal = { status, body };
    const answer = await sync();
    const review = JSON.stringify(await onCopy(fixture.tmp, copy, sharedRecordReview));
    for (const text of expected) {
      expect(answer.error?.message).toContain(text);
      expect(review).toContain(text);
    }
    expect(answer.error?.message).not.toContain('did not return a receipt');
    expect(fs.existsSync(uploads[0].file)).toBe(false);
    uploadRefusal = undefined;
    await sync();
    expect(uploads).toHaveLength(2);
    await sync();
    expect(uploads).toHaveLength(2);
  }
);

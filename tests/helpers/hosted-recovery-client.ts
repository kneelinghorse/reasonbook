// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercise hosted recovery through real MCP clients and a separate reference-server process.
// ABOUTME: Own each test's stores, credentials, server and environment, with explicit teardown.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { __resetSharedSyncScheduler } from '../../src/tools/rbook/record-sync-scheduler';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import { request, spawnRefereeServer, type RunningServer } from './referee-http';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from './replica-fixture';
import { onCopy, type Copy } from './shared-copies';
import { reidentifyRbookTestStore } from './seedRbookDb';

export const RECOVERY_PROJECT = 'proj-recovery';
const ADDRESS = 'rbook://owner/recovery';
export const RECOVERY_TOKENS = { owner: 'token-owner', darryl: 'token-darryl', erin: 'token-erin' };
const ACCOUNTS = { owner: 'acct-owner', darryl: 'acct-darryl', erin: 'acct-erin' };
type Person = keyof typeof RECOVERY_TOKENS;

export const required = <T>(result: RbookToolResult<T>): T => {
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data as T;
};

export interface RecoveryClientFixture {
  readonly fixture: ReplicaFixture;
  readonly server: RunningServer;
  readonly owner: Copy;
  join(name: Exclude<Person, 'owner'>): Promise<Copy>;
  tool<T = unknown>(
    copy: Copy,
    name: string,
    args: Record<string, unknown>
  ): Promise<RbookToolResult<T>>;
  sync(copy: Copy, confirmOwner?: boolean): Promise<RbookToolResult<unknown>>;
  control<T>(action: 'snapshot' | 'lose'): Promise<T>;
  replica(copy: Copy): Promise<string>;
  dispose(): Promise<void>;
}

/** Optional bytes come from a committed private-store fixture, never the live database file. */
export async function recoveryClients(source?: Buffer): Promise<RecoveryClientFixture> {
  const keys = ['RBOOK_DASHBOARD_URL', 'RBOOK_SHARED_SYNC', 'RBOOK_DASHBOARD_SHARING'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.RBOOK_SHARED_SYNC;
  process.env.RBOOK_DASHBOARD_SHARING = 'on';
  const fixture = replicaFixture('rbook-recovery-e2e-');
  let server: RunningServer | undefined;
  const dispose = async () => {
    try {
      await server?.stop();
    } finally {
      __resetSharedSyncScheduler();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      fixture.restore();
    }
  };
  try {
    server = await spawnRefereeServer(path.join(fixture.tmp, 'server'), {
      root: path.join(fixture.tmp, 'volume'),
      accounts: Object.fromEntries(
        Object.entries(RECOVERY_TOKENS).map(([name, token]) => [token, ACCOUNTS[name as Person]])
      ),
      projects: { [RECOVERY_PROJECT]: { ownerAccountId: ACCOUNTS.owner } },
      addresses: { 'owner/recovery': RECOVERY_PROJECT },
    });
    process.env.RBOOK_DASHBOARD_URL = server.url;
    const tool = async <T>(copy: Copy, name: string, args: Record<string, unknown>) => {
      useMachine(fixture.tmp, copy.machine);
      try {
        return (await call(name, { ...args, projectRoot: copy.root })) as RbookToolResult<T>;
      } finally {
        __resetSharedSyncScheduler();
      }
    };
    const signIn = async (copy: Copy, name: Person) => {
      useMachine(fixture.tmp, copy.machine);
      const now = new Date().toISOString();
      await (
        await CredentialStore.create()
      ).upsertUserScopedKey(`key-${name}`, {
        key: RECOVERY_TOKENS[name],
        label: name,
        issuedAt: now,
        lastUsedAt: now,
      });
      writeUserAuthor(name === 'owner' ? 'Owner' : name);
    };
    const root = path.join(fixture.tmp, 'owner');
    if (source) {
      fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
      fs.writeFileSync(dbOf(root), source);
      reidentifyRbookTestStore(root, 'p-shared');
    } else project(fixture.tmp, 'owner');
    const db = new Database(dbOf(root));
    try {
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES('dashboard_project_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(RECOVERY_PROJECT);
    } finally {
      db.close();
    }
    const owner: Copy = { name: 'owner', root, machine: 'machine-owner', replicaId: '', block: 0 };
    await signIn(owner, 'owner');
    required(
      await tool(owner, 'rbook_project', { action: 'share', via: 'dashboard', confirm: true })
    );
    const active = server;
    return {
      fixture,
      server: active,
      owner,
      tool,
      dispose,
      sync: (copy, confirmOwner = false) =>
        tool(copy, 'rbook_project', {
          action: 'sync',
          ...(confirmOwner ? { confirmOwner: true } : {}),
        }),
      replica: (copy) =>
        onCopy(
          fixture.tmp,
          copy,
          (client) => readReplicaIdentity(client, { fresh: true })!.replicaId,
          { replicaCheck: false }
        ),
      control: async <T>(action: 'snapshot' | 'lose') => {
        const response = await request<T>(
          active,
          `/api/test/projects/${RECOVERY_PROJECT}/recovery/${action}`,
          { token: RECOVERY_TOKENS.owner, json: {} }
        );
        return required(response.body);
      },
      join: async (name) => {
        required(
          (
            await request(active, `/api/test/projects/${RECOVERY_PROJECT}/shares`, {
              token: RECOVERY_TOKENS.owner,
              json: { accountId: ACCOUNTS[name], name, role: 'editor' },
            })
          ).body
        );
        const copy: Copy = {
          name,
          root: path.join(fixture.tmp, name),
          machine: `machine-${name}`,
          replicaId: '',
          block: -1,
        };
        await signIn(copy, name);
        required(
          await tool(copy, 'rbook_project', { action: 'join', via: 'dashboard', project: ADDRESS })
        );
        return copy;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

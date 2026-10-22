// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Refuse peer work when authority or authenticated membership cannot be established.
// ABOUTME: Preserve invalid cache state across restart until fresh membership permits reconciliation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { members as listHostedMembers, type RefereeOutcome } from '../../src/referee';
import { ask, hostProject } from '../helpers/referee-fixture';
import { replicaFixture } from '../helpers/replica-fixture';
import { reconcileCarriedMembers } from '../helpers/referee-server-members';
import { createHostState, type RefereeEngine } from '../helpers/referee-server-state';

const carried = [
  { memberId: 'owner', name: 'Owner', role: 'owner', accountId: 'owner-account' },
  { memberId: 'member', name: 'Member', role: 'editor', accountId: 'member-account' },
];
const head = { replicaId: 'referee', seq: 2, hash: 'head-2' };
const refreshError = {
  code: 'REFEREE_FAILED',
  message: 'Injected membership read failure',
  suggestion: 'Retry the membership read.',
};
const good = (data: unknown): RefereeOutcome<unknown> => ({
  result: { success: true, data },
  head,
});
const failed = () => ({ result: { success: false, error: refreshError }, head: null });

function cacheFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rbook-member-cache-'));
  const config = {
    root,
    accounts: {},
    projects: { project: { ownerAccountId: 'owner-account' } },
  };
  const events: string[] = [];
  let listed = carried.map((member) => ({ ...member }));
  const members = jest.fn(async () => {
    events.push('members');
    return good(listed);
  });
  const peer = jest.fn(async (_location, method: string) => {
    events.push(method);
    return good(
      method === 'hello' ? { replicaId: 'referee', authority: 'referee', pending: null } : {}
    );
  });
  const remove = jest.fn(async () => {
    events.push('remove');
    listed = listed.map((member) =>
      member.memberId === 'member' ? { ...member, role: 'removed' } : member
    );
    return good({});
  });
  const engine = {
    members,
    peer,
    remove,
    REFEREE_ERROR_CODES: {
      FAILED: 'REFEREE_FAILED',
      NOT_READY: 'REFEREE_NOT_READY',
      NEEDS_RECOVERY: 'REFEREE_NEEDS_RECOVERY',
    },
  } as unknown as RefereeEngine;
  const host = createHostState(config, engine);
  const project = host.state.get('project')!;
  project.shared = true;
  project.members = carried.map((member) => ({ ...member }));
  project.recordProjectId = 'record-project';
  host.rememberHead(project, head);
  host.save();
  mkdirSync(path.dirname(host.storeOf('project')), { recursive: true });
  writeFileSync(host.storeOf('project'), 'unchanged source');
  const saved = () =>
    JSON.parse(readFileSync(path.join(root, 'server-state.json'), 'utf8')).project;
  return { root, config, host, engine, members, peer, remove, events, saved };
}

it.each(
  ['returned', 'thrown', 'malformed'].flatMap((failure) =>
    [false, true].map((restart) => ({ failure, restart }))
  )
)(
  'retains and refreshes invalid membership: $failure, restart=$restart',
  async ({ failure, restart }) => {
    const f = cacheFixture();
    try {
      const failRefresh = async () => {
        if (failure === 'thrown') throw new Error('Injected thrown refresh');
        return failure === 'returned' ? failed() : good(undefined);
      };
      f.members.mockImplementationOnce(failRefresh).mockImplementationOnce(failRefresh);
      const changed = jest.fn(async () => good({}));
      const outcome = await f.host.serialized('project', changed);
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.error?.code).toBe('REFEREE_FAILED');
      expect(outcome.result.error?.suggestion).toMatch(/retry/i);
      if (failure === 'returned') expect(outcome.result.error).toEqual(refreshError);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(f.saved()).toMatchObject({ members: carried, membersInvalid: true, head });

      const active = restart ? createHostState(f.config, f.engine) : f.host;
      expect(active.beginRecovery('project')).toBeNull();
      expect(readFileSync(active.storeOf('project'), 'utf8')).toBe('unchanged source');
      const blocked = jest.fn(async () => good({}));
      expect((await active.serialized('project', blocked)).result.success).toBe(false);
      expect(blocked).not.toHaveBeenCalled();
      expect(f.saved()).toMatchObject({ members: carried, membersInvalid: true, recovery: null });

      // A valid refresh must happen before reconciliation and before the next peer apply.
      f.events.length = 0;
      const caller = { replicaId: 'member-copy', accountId: 'member-account' };
      const resumed = await active.serialized('project', async () => {
        const refused = await reconcileCarriedMembers(
          active,
          f.engine,
          f.config,
          'project',
          caller
        );
        return refused ?? f.engine.peer(active.locate('project'), 'apply', {}, caller);
      });
      expect(resumed.result.success).toBe(true);
      expect(f.events).toEqual(['members', 'hello', 'remove', 'apply', 'members']);
      expect(f.saved()).toMatchObject({ membersInvalid: false });
      expect(f.saved().members[1]).toMatchObject({ memberId: 'member', role: 'removed' });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

it.each(
  [
    null,
    {},
    [carried[0], null],
    [carried[0], { ...carried[1], accountId: 42 }],
    [carried[0], { ...carried[1], memberId: '' }],
    [carried[0], { ...carried[1], role: null }],
  ].map((data) => ({ data }))
)(
  'refuses malformed successful membership instead of authorizing an empty cache: $data',
  async ({ data }) => {
    const f = cacheFixture();
    try {
      f.members.mockResolvedValueOnce(good(data));
      const outcome = await f.host.serialized('project', async () => good({}));
      expect(outcome.result.error?.code).toBe('REFEREE_FAILED');
      expect(outcome.result.error?.suggestion).toMatch(/retry/i);
      expect(f.saved()).toMatchObject({ members: carried, membersInvalid: true });
      expect(f.host.beginRecovery('project')).toBeNull();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

it.each(
  [
    [],
    [carried[1]],
    [{ ...carried[0], accountId: 'another-account' }],
    [
      { ...carried[0], accountId: carried[1].accountId },
      { ...carried[1], accountId: carried[0].accountId },
    ],
    [{ ...carried[0], role: 'editor' }],
  ].map((data) => ({ data }))
)(
  'refuses owner-missing membership through restart until an authenticated refresh: $data',
  async ({ data }) => {
    const f = cacheFixture();
    try {
      f.members.mockResolvedValue(good(data));
      const outcome = await f.host.serialized('project', async () => good({}));
      expect(outcome.result.error?.code).toBe('REFEREE_FAILED');
      expect(outcome.result.error?.suggestion).toMatch(/retry/i);
      expect(f.saved()).toMatchObject({ members: carried, membersInvalid: true });
      const restarted = createHostState(f.config, f.engine);
      expect(restarted.beginRecovery('project')).toBeNull();
      const blocked = jest.fn(async () => good({}));
      expect((await restarted.serialized('project', blocked)).result.success).toBe(false);
      expect(blocked).not.toHaveBeenCalled();
      expect(f.saved().recovery).toBeNull();
      f.members.mockResolvedValue(good(carried));
      expect((await restarted.serialized('project', blocked)).result.success).toBe(true);
      expect(blocked).toHaveBeenCalledTimes(1);
      expect(f.saved()).toMatchObject({ members: carried, membersInvalid: false });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

it('keeps the initial unhosted cache empty without attempting a ready membership query', () => {
  const f = cacheFixture();
  try {
    const initial = createHostState({ ...f.config, root: path.join(f.root, 'new') }, f.engine);
    expect(initial.state.get('project')).toMatchObject({ members: [], membersInvalid: false });
    expect(initial.beginRecovery('project')).toBeNull();
    expect(f.members).not.toHaveBeenCalled();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each(
  [
    [],
    [carried[1]],
    [{ ...carried[0], accountId: 'another-account' }],
    [
      { ...carried[0], accountId: carried[1].accountId },
      { ...carried[1], accountId: carried[0].accountId },
    ],
    [{ ...carried[0], role: 'editor' }],
  ].map((members) => ({ members }))
)('refreshes legacy shared cache before peer work: $members', async ({ members }) => {
  const f = cacheFixture();
  try {
    const legacy = { ...f.saved(), members };
    delete legacy.membersInvalid;
    writeFileSync(path.join(f.root, 'server-state.json'), JSON.stringify({ project: legacy }));
    const restarted = createHostState(f.config, f.engine);
    expect(restarted.state.get('project')).toMatchObject({ members, membersInvalid: true });
    expect(restarted.beginRecovery('project')).toBeNull();
    expect(readFileSync(restarted.storeOf('project'), 'utf8')).toBe('unchanged source');
    f.members.mockRejectedValueOnce(new Error('Legacy refresh is unavailable'));
    const blocked = jest.fn(async () => good({}));
    expect((await restarted.serialized('project', blocked)).result.error?.code).toBe(
      'REFEREE_FAILED'
    );
    expect(blocked).not.toHaveBeenCalled();
    expect(f.saved()).toMatchObject({ members, membersInvalid: true, recovery: null });

    const caller = { replicaId: 'member-copy', accountId: 'member-account' };
    f.events.length = 0;
    const resumed = await restarted.serialized('project', async () => {
      const refused = await reconcileCarriedMembers(
        restarted,
        f.engine,
        f.config,
        'project',
        caller
      );
      return refused ?? f.engine.peer(restarted.locate('project'), 'apply', {}, caller);
    });
    expect(resumed.result.success).toBe(true);
    expect(f.events).toEqual(['members', 'hello', 'remove', 'apply', 'members']);
    expect(f.saved()).toMatchObject({ membersInvalid: false });
    expect(f.saved().members[1]).toMatchObject({ memberId: 'member', role: 'removed' });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'keeps valid legacy state distinct from a damaged shared cache: shared=%s',
  async (shared) => {
    const f = cacheFixture();
    try {
      const members = shared ? carried : [];
      const legacy = { ...f.saved(), shared, members };
      delete legacy.membersInvalid;
      writeFileSync(path.join(f.root, 'server-state.json'), JSON.stringify({ project: legacy }));
      const restarted = createHostState(f.config, f.engine);
      expect(restarted.state.get('project')).toMatchObject({ members, membersInvalid: false });
      const called = jest.fn(async () => ({ result: { success: true }, head: null }));
      expect((await restarted.serialized('project', called)).result.success).toBe(true);
      expect(called).toHaveBeenCalledTimes(1);
      expect(f.members).not.toHaveBeenCalled();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

it('filters unbound accounts only after the configured owner is present', async () => {
  const f = cacheFixture();
  try {
    f.members.mockResolvedValueOnce(good([...carried, { ...carried[1], accountId: null }]));
    expect((await f.host.serialized('project', async () => good({}))).result.success).toBe(true);
    expect(f.members).toHaveBeenCalledTimes(1);
    expect(f.saved()).toMatchObject({ members: carried, membersInvalid: false });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('grounds the ready-cache owner requirement in the real hosted library', async () => {
  const fixture = replicaFixture('rbook-member-cache-real-');
  try {
    const hosted = await hostProject(fixture.tmp);
    const listed = await ask(hosted.referee, listHostedMembers);
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: 'owner',
          role: 'owner',
          accountId: hosted.ownerAccount,
        }),
      ])
    );
  } finally {
    fixture.restore();
  }
});

it('allows NOT_READY only for the initial create join request, retaining carried bindings', async () => {
  const f = cacheFixture();
  try {
    f.members.mockResolvedValue({
      result: { success: false, error: { ...refreshError, code: 'REFEREE_NOT_READY' } },
      head: null,
    });
    const created = await f.host.serialized('project', async () =>
      good({ joinRequest: { projectId: 'record-project' } })
    );
    expect(created.result.success).toBe(true);
    expect(f.saved()).toMatchObject({ members: carried, membersInvalid: false });
    const later = await f.host.serialized('project', async () => good({}));
    expect(later.result.error?.code).toBe('REFEREE_NOT_READY');
    expect(f.saved()).toMatchObject({ members: carried, membersInvalid: true });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each([undefined, {}, { replicaId: 'r', authority: 'r' }])(
  'refuses a malformed successful authority probe: %j',
  async (data) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rbook-reconcile-refusal-'));
    const config = {
      root,
      accounts: {},
      projects: { project: { ownerAccountId: 'owner-account' } },
    };
    const engine = {
      peer: jest.fn(async () => ({ result: { success: true, data }, head: null })),
      REFEREE_ERROR_CODES: { FAILED: 'REFEREE_FAILED' },
      remove: jest.fn(),
    } as unknown as RefereeEngine;
    const host = createHostState(config, engine);
    host.state.get('project')!.members = [
      { memberId: 'member', name: 'Member', role: 'editor', accountId: 'member-account' },
    ];
    try {
      const result = await reconcileCarriedMembers(host, engine, config, 'project', {
        replicaId: 'owner-copy',
        accountId: 'owner-account',
      });
      expect(result?.result.error?.code).toBe('REFEREE_FAILED');
      expect(result?.result.error?.suggestion).toMatch(/retry/i);
      expect(engine.remove).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

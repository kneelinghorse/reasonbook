// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A host must durably invalidate its membership census before a call can change it.
// ABOUTME: Unknown outcomes stay invalid while definite refusals, including loss detection, allow recovery.
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as engine from '../../src/referee';
import { createHostState, type RefereeEngine } from '../helpers/referee-server-state';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-census-host-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const head = { replicaId: 'referee', seq: 3, hash: 'hash' };
const census = [
  { memberId: 'owner', accountId: 'owner-account', name: 'Owner', role: 'owner', replicas: [] },
];
function host(members = jest.fn(async () => ({ result: { success: true, data: census }, head }))) {
  const config = { root, projects: { p: { ownerAccountId: 'owner-account' } }, accounts: {} };
  fs.writeFileSync(
    path.join(root, 'server-state.json'),
    JSON.stringify({
      p: {
        head,
        shared: true,
        needsRecovery: null,
        grants: [],
        known: [],
        recordProjectId: 'p',
        members: census,
        membersInvalid: false,
      },
    })
  );
  return { config, state: createHostState(config, { ...engine, members } as RefereeEngine) };
}
const saved = () => JSON.parse(fs.readFileSync(path.join(root, 'server-state.json'), 'utf8')).p;
it('a crash after a possible commit leaves the saved census invalid across restart', async () => {
  const { state, config } = host();
  await expect(
    state.serialized('p', async () => {
      expect(saved().membersInvalid).toBe(true);
      throw new Error('crashed after commit');
    })
  ).rejects.toThrow('crashed after commit');
  expect(saved().membersInvalid).toBe(true);
  const restarted = createHostState(config, engine);
  expect(restarted.state.get('p')!.membersInvalid).toBe(true);
  expect(restarted.beginRecovery('p')).toBeNull();
});
it('a failed refresh cannot mark a possibly changed membership census valid', async () => {
  const { state } = host(
    jest.fn(async () => {
      throw new Error('crash before refresh');
    })
  );
  const outcome = await state.serialized('p', async () => ({ result: { success: true }, head }));
  expect(outcome.result.success).toBe(false);
  expect(saved().membersInvalid).toBe(true);
  expect(state.beginRecovery('p')).toBeNull();
});
it.each(['REFEREE_NEEDS_RECOVERY', 'REFEREE_MALFORMED'])(
  '%s is a definite refusal, so the prior census stays valid',
  async (code) => {
    const { state } = host();
    await state.serialized('p', async () => {
      expect(saved().membersInvalid).toBe(true);
      return {
        result: { success: false, error: { code, message: 'refused', suggestion: 'retry' } },
        head: null,
      };
    });
    expect(saved().membersInvalid).toBe(false);
    if (code === 'REFEREE_NEEDS_RECOVERY')
      expect(state.state.get('p')!.recovery?.state).toBe('collecting');
  }
);

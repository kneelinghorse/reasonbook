// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §7) — a sync over SSH reaches a member's copy through the remote command its route names,
// ABOUTME: with only the bare PATH there; the command is shell-quoted, and a far end that is not a sync is named so.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { clientPeer, exchange } from '../../../src/tools/rbook/record-exchange';
import { remoteCommand, routeProblem, sshArgs, sshPeer } from '../../../src/tools/rbook/record-ssh';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { memberCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';
import { routeTo, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-ssh-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const configOf = (copy: Copy): string => path.join(fixture.tmp, `config-${copy.machine}`);

describe('the remote command', () => {
  it('quotes every word, so a folder with spaces and a quote reaches the far end whole', () => {
    const root = `/tmp/a folder's "name"`;
    const command = remoteCommand(
      { host: 'studio', root, node: '/opt/homebrew/bin/node', bin: '/opt/x/bin.js' },
      ['sync', '--serve']
    );
    const echoed = execFileSync('/bin/sh', ['-c', command.replace(/^/, 'printf "%s\\n" ')], {
      encoding: 'utf8',
    });
    expect(echoed.split('\n').filter(Boolean)).toEqual([
      '/opt/homebrew/bin/node',
      '/opt/x/bin.js',
      'sync',
      '--serve',
      '--project-root',
      root,
    ]);
  });

  it('asks ssh for no terminal, no password prompt and a bounded connect, and refuses a host ssh would read as an option', () => {
    const args = sshArgs({ host: 'darryl@M4.local', root: '/p' }, ['sync', '--serve']);
    // No terminal: a user's RequestTTY setting would otherwise mangle the wire.
    expect(args.slice(0, 5)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
    expect(args[5]).toBe('darryl@M4.local');
    expect(routeProblem({ host: '-oProxyCommand=touch /tmp/x', root: '/p' })).toMatch(
      /may not start with "-"/
    );
    expect(routeProblem({ host: 'studio', root: '' })).toMatch(/no project folder/);
  });
});

describe('a sync over SSH', () => {
  it("reaches a member's copy through its remote command with only the bare PATH, and leaves one record", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Made on the Studio.' });
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'Made on the Air.' });
    const { ssh, log } = standinSsh(path.join(fixture.tmp, 'bin'));
    const far = await sshPeer(routeTo(member.root, configOf(member)), { ssh });
    try {
      const local = clientPeer('the owner', (step) => onCopy(fixture.tmp, owner, step));
      const result = await exchange(local, far);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ sent: expect.any(Number), received: expect.any(Number) });
    } finally {
      far.close();
    }
    for (const copy of [owner, member])
      expect(
        read(
          copy,
          "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Made on%' ORDER BY 1"
        )
      ).toEqual([{ decision_text: 'Made on the Air.' }, { decision_text: 'Made on the Studio.' }]);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('studio');
  }, 180000);

  it('a far end that is not a Reasonbook sync, or no ssh at all, is named rather than guessed at', async () => {
    const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
    await expect(
      sshPeer({ host: 'studio', root: '/nowhere', node: '/bin/echo', bin: 'hello' }, { ssh })
    ).rejects.toThrow(/did not answer as a Reasonbook sync|closed the connection/);
    await expect(
      sshPeer({ host: 'studio', root: '/nowhere' }, { ssh: path.join(fixture.tmp, 'no-ssh') })
    ).rejects.toThrow(/ssh could not start/);
  }, 60000);
});

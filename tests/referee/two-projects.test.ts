// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R1, fact 20; decision #1490) — projects hosted in one process with one configDir stay apart,
// ABOUTME: those with distinct ids and those whose ids collide, each with its own bindings, whether calls interleave or overlap.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { members, peer } from '../../src/referee';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  syncWithReferee,
  type Hosted,
} from '../helpers/referee-fixture';
import { read, recordedState, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-two-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const projectOf = (hosted: Hosted): string => {
  const db = new Database(hosted.referee.storePath, { readonly: true });
  try {
    return (
      db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as { value: string }
    ).value;
  } finally {
    db.close();
  }
};

describe('projects hosted in one process with one configDir (s97-m09)', () => {
  it('stay apart whether their ids differ or collide, through interleaved and overlapping calls', async () => {
    const alpha = await hostProject(fixture.tmp, { name: 'alpha' });
    const beta = await hostProject(fixture.tmp, { name: 'beta', ownerAccount: 'acct-beta-owner' });
    const gamma = await hostProject(fixture.tmp, {
      name: 'gamma',
      projectId: 'p-gamma',
      ownerAccount: 'acct-gamma-owner',
    });
    expect([projectOf(alpha), projectOf(beta), projectOf(gamma)]).toEqual([
      'p-shared',
      'p-shared',
      'p-gamma',
    ]);
    expect(new Set([alpha, beta, gamma].map((hosted) => hosted.referee.configDir)).size).toBe(1);
    // Each store's bindings live in its own folder under the one configDir (decision #1490).
    const folders = fs.readdirSync(path.join(alpha.referee.configDir, 'referees'));
    expect(folders).toHaveLength(3);

    const a = await joinThroughReferee(fixture.tmp, alpha, 'ann', 'acct-ann');
    const b = await joinThroughReferee(fixture.tmp, beta, 'bea', 'acct-bea');
    await on(a, 'rbook_decisions', { action: 'record', content: 'Only in alpha.' });
    await on(b, 'rbook_decisions', { action: 'record', content: 'Only in beta.' });
    await syncWithReferee(fixture.tmp, alpha, a, 'acct-ann');
    await syncWithReferee(fixture.tmp, beta, b, 'acct-bea');
    await syncWithReferee(fixture.tmp, alpha, alpha.owner, alpha.ownerAccount);
    await syncWithReferee(fixture.tmp, beta, beta.owner, beta.ownerAccount);
    expect(
      read(
        alpha.owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Only in %'"
      )
    ).toEqual([{ decision_text: 'Only in alpha.' }]);
    expect(
      read(
        beta.owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Only in %'"
      )
    ).toEqual([{ decision_text: 'Only in beta.' }]);
    expect(recordedState(a)).toEqual(recordedState(alpha.owner));
    expect(recordedState(b)).toEqual(recordedState(beta.owner));

    // Calls on all three at once: the library runs them one at a time, each against its own bindings.
    const callers = await Promise.all([
      callerOf(fixture.tmp, a, 'acct-ann'),
      callerOf(fixture.tmp, b, 'acct-bea'),
      callerOf(fixture.tmp, gamma.owner, gamma.ownerAccount),
    ]);
    const answers = await Promise.all(
      [alpha, beta, gamma].flatMap((hosted, index) => [
        ask(hosted.referee, (location) => peer(location, 'hello', {}, callers[index])),
        ask(hosted.referee, (location) => members(location)),
      ])
    );
    expect(answers.map((answer) => answer.error?.code ?? 'ok')).toEqual(Array(6).fill('ok'));
    // An account of one project is no member of another, even where the project ids collide.
    const crossed = await ask(beta.referee, (location) => peer(location, 'hello', {}, callers[0]));
    expect(crossed.error?.code).toBe('REFEREE_NOT_A_MEMBER');
  }, 300000);
});

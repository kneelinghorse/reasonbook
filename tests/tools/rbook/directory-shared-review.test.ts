// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Existing shared stores keep local integrity warnings without remote status or unusable remedies.
// ABOUTME: A populated two-copy fixture proves the directory boundary against full-mode controls.
import fs from 'fs';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { rbookReview } from '../../../src/tools/rbook/rbook-review';
import { call, replicaFixture, useMachine } from '../../helpers/replica-fixture';
import { ownerCopy, memberCopy, syncCopies, exchange, sync } from '../../helpers/shared-copies';

it('reports stored conflicts locally, never peer/dashboard status or a directory-forbidden sync command', async () => {
  const saved = { ...process.env };
  const fixture = replicaFixture('directory-shared-');
  process.env.RBOOK_EDITION = 'full';
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    for (const sprintId of ['active-a', 'active-b']) {
      const copy = sprintId === 'active-a' ? owner : member;
      useMachine(fixture.tmp, copy.machine);
      expect(
        (
          await call('rbook_sprint', {
            action: 'add',
            projectRoot: copy.root,
            sprintId,
            title: sprintId,
            status: 'Active',
          })
        ).success
      ).toBe(true);
    }
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    await syncCopies(fixture.tmp, member, owner);
    useMachine(fixture.tmp, owner.machine);
    const full = await readDigestV2(owner.root);
    expect(full.shared?.peers?.length).toBeGreaterThan(0);
    expect(full.shared?.states.length).toBeGreaterThan(0);
    process.env.RBOOK_EDITION = 'directory';
    const attempted: string[] = [];
    const read = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (/(credentials|dashboard-identity)\.json$/.test(String(file))) {
        attempted.push(String(file));
        throw new Error('Synthetic credential fence');
      }
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof read);
    const model = await readDigestV2(owner.root);
    expect(model.shared).toMatchObject({ directory: true, states: full.shared?.states });
    for (const key of [
      'peers',
      'syncErrors',
      'moves',
      'movePending',
      'recoveryConditions',
      'protocol',
    ])
      expect(model.shared).not.toHaveProperty(key);
    const digest = renderDigestV2(model).text;
    expect(digest).toContain('full plugin');
    expect(digest).toContain('1 state');
    expect(digest).not.toMatch(/syncing|reasonbook sync|rbook_db\(action="conflicts"\)/);
    const review = await rbookReview({ projectRoot: owner.root });
    expect(review.success).toBe(true);
    expect(review.data?.sharedRecord).toContain('full plugin');
    expect(review.data?.recordProtocol).toBeUndefined();
    expect(JSON.stringify(review.data)).not.toMatch(/reasonbook sync|syncing/);
    expect(attempted).toEqual([]);
  } finally {
    jest.restoreAllMocks();
    fixture.restore();
    process.env = saved;
  }
}, 120000);

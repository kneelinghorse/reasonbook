// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m14 — the conflict check an answer runs on each shared copy its call opened: a copy the call no longer
// ABOUTME: has names nothing, and a copy still there that cannot be read says so.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sharedRecordNoticesAt } from '../../../src/tools/rbook/record-notices';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-notices-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the conflict check on the shared copies a call opened (s97-m14)', () => {
  it('names nothing for a copy the call no longer has, such as the file a fresh copy was built in', async () => {
    // The live test's join answered that its record "could not be checked for conflicts" at the
    // file its first copy was built in, already renamed into place, and the agent read the join
    // as failed. A join taken back after its store was written leaves the same: no copy to check.
    expect(await sharedRecordNoticesAt(path.join(dir, 'rbook.sqlite.building-1-2'), {})).toEqual(
      []
    );
  });

  it('still says so for a copy that is there and cannot be read', async () => {
    const file = path.join(dir, 'rbook.sqlite');
    fs.writeFileSync(file, 'not a database, though it sits where one does');
    const notes = await sharedRecordNoticesAt(file, {});
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^This shared record could not be checked for conflicts: /);
  });
});

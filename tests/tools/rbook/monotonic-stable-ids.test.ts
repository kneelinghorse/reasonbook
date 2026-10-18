// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (ADR s96 §2) — new stable ids sort in the order they were minted, even within one
// ABOUTME: millisecond, because plain ulid(now) orders about half of such pairs backwards (fact 30).
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { genesisColumns } from '../../../src/tools/rbook/genesis-columns';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let client: RbookDatabaseClient;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-monotonic-'));
  const dbPath = seedRbookDb(path.join(tmp, 'project'), { projectId: 'p-mono' });
  client = (await RbookDatabaseClient.create({ dbPath })).data!;
});
afterEach(() => {
  client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('mints stable ids that sort in minting order within one millisecond', () => {
  const now = Date.now();
  const ids = Array.from(
    { length: 200 },
    () => genesisColumns(client, 'strategic_decisions', 'p-mono', now).values[1] as string
  );
  // Sorting is what the merge does with them (ADR s96 §5 orders by hlc and change id).
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});

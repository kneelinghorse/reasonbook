// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Requires a disposable filesystem copy of a real store for schema-refusal positive fires.
// ABOUTME: Invalid inputs must leave the copy unchanged, and no call may open the original store.

import { createHash } from 'crypto';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { executeMissionProtocolTool } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

const fingerprint = (file: string): string | null =>
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const bundle = (file: string) =>
  Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [suffix, fingerprint(file + suffix)]));

it('fires actual refusals on a real store copy without mutating either record', async () => {
  const sourceRoot = process.env.SCHEMA_REAL_STORE_ROOT;
  if (!sourceRoot)
    throw new Error('Set SCHEMA_REAL_STORE_ROOT to an existing real Reasonbook project.');
  const source = path.join(sourceRoot, 'rbook', 'db', 'rbook.sqlite');
  expect(fs.existsSync(source)).toBe(true);
  const sourceBefore = bundle(source);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-schema-real-'));
  const target = path.join(scratch, 'rbook', 'db', 'rbook.sqlite');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    for (const suffix of ['', '-wal', '-shm'])
      if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
    expect(bundle(source)).toEqual(sourceBefore);
    const copyBefore = bundle(target);
    for (const [name, args] of [
      ['rbook_db', { action: 'snapshot', maxSnapshots: 0 }],
      [
        'rbook_context',
        {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'project_name' }],
        },
      ],
      [
        'rbook_session',
        { action: 'capture', category: 'Learning', content: 'Must not disappear.' },
      ],
    ] as const) {
      const result = await executeMissionProtocolTool(
        name,
        { ...args, projectRoot: scratch },
        {} as never
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID_PARAMETER' } });
      expect(bundle(target)).toEqual(copyBefore);
    }
    // The copied database is a usable store, not merely a path that early validation can reject.
    const read = await executeMissionProtocolTool(
      'rbook_mission',
      { action: 'list', limit: 1, projectRoot: scratch },
      {} as never
    );
    expect(read.structuredContent).toMatchObject({ success: true });
    expect(bundle(source)).toEqual(sourceBefore);
  } finally {
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

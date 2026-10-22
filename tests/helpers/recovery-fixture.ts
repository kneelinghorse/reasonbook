// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Frozen SQLite uploads and VACUUM snapshots for hosted recovery's library-level trust tests.
// ABOUTME: Every store belongs to the calling replica fixture and authenticated account ids are explicit.
import Database from 'better-sqlite3';
import path from 'path';
import { members, type RecoveryPlanInput } from '../../src/referee';
import { recordedProjectId } from '../../src/tools/rbook/replica-identity';
import { dbOf } from './replica-fixture';
import { ask, hostProject, joinThroughReferee, syncWithReferee } from './referee-fixture';
import { onCopy } from './shared-copies';

export function recoverySnapshot(tmp: string, source: string, name: string): string {
  const file = path.join(tmp, `${name}.sqlite`);
  const db = new Database(source);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return file;
}

export async function recoveryFixture(tmp: string, two = false) {
  const hosted = await hostProject(tmp);
  const extra = two ? [await joinThroughReferee(tmp, hosted, 'Erin', 'acct-erin')] : [];
  await syncWithReferee(tmp, hosted, hosted.owner, hosted.ownerAccount);
  const listed = (await ask(hosted.referee, (location) => members(location))).data!;
  const projectId = await onCopy(tmp, hosted.owner, recordedProjectId);
  const uploads = [hosted.owner, ...extra].map((copy, index) => ({
    file: recoverySnapshot(tmp, dbOf(copy.root), `upload-${index}`),
    caller: {
      replicaId: copy.replicaId,
      accountId: index === 0 ? hosted.ownerAccount : 'acct-erin',
    },
  }));
  const input: RecoveryPlanInput = {
    lostHead: hosted.referee.expectedHead!,
    recordedHeads: [hosted.referee.expectedHead!],
    ownerAccountId: hosted.ownerAccount,
    members: listed.map(({ memberId, name, role, accountId }) => ({
      memberId,
      name,
      role,
      accountId: accountId!,
    })),
    uploads,
    snapshots: [
      {
        file: recoverySnapshot(tmp, hosted.referee.storePath, 'snapshot'),
        takenAt: new Date().toISOString(),
      },
    ],
  };
  const location = { ...hosted.referee, storePath: path.join(tmp, 'recovered.sqlite'), projectId };
  return { hosted, extra, input, location };
}

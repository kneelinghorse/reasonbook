// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A switched record admits or moves authority only to copies that report reading protocol2.
// ABOUTME: Share the named refusal while callers hold their admission or move write transaction.
import type { RbookDatabaseClient } from './client';
import { copyReport } from './record-copy-report';
import { reportedCopy } from './record-peer-report';
import { currentWriteProtocol } from './record-protocol-state';
import { mergeContext, type MergeContext } from './record-standing';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError } from './types';

export function readerRefusal(
  client: RbookDatabaseClient,
  replicaId: string,
  report: unknown = reportedCopy(client, replicaId),
  memberName?: string,
  ctx: MergeContext = mergeContext(client)
): RbookToolError | null {
  const reads = copyReport(report).reads;
  if (currentWriteProtocol(client, ctx) < 2 || (reads ?? 0) >= 2) return null;
  return {
    code: REPLICA_ERROR_CODES.COPY_TOO_OLD,
    message: `${memberName ? `${memberName}'s ` : ''}copy ${replicaId} must report that it reads record protocol 2 before joining, taking a new identity or holding authority in this switched record; it reported ${reads ?? 'no usable read protocol'}.`,
    suggestion:
      'Upgrade that copy to Reasonbook 4.5.0 or later. For a join, make a fresh request with reasonbook join --request-out <file>; otherwise sync it and retry the action.',
  };
}

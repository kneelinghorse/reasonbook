// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Explain this record's counted protocol switch and name every active copy delaying it.
// ABOUTME: Keep informational protocol state separate from conflicts, with compact text and complete structured blockers.
import type { RbookDatabaseClient } from './client';
import { mergeContext } from './record-context';
import {
  protocolBlockers,
  protocolSwitch,
  type ProtocolBlockingCopy,
  type ProtocolSwitch,
} from './record-protocol-state';

export interface RecordProtocolReview {
  readonly writeProtocol: number;
  readonly switch: ProtocolSwitch | null;
  readonly blockers: readonly ProtocolBlockingCopy[];
  readonly summary: string;
  readonly detail: string;
}

export function protocolReview(client: RbookDatabaseClient): RecordProtocolReview {
  const ctx = mergeContext(client);
  const switched = protocolSwitch(client, ctx);
  if (switched)
    return {
      writeProtocol: 2,
      switch: switched,
      blockers: [],
      summary:
        'record protocol 2: switched; downgraded copies keep out streams and may rename ids locally',
      detail: `Switched at authority term ${switched.epoch}, sequence ${switched.seq}. A downgraded copy keeps out protocol-2 streams and may rename ids locally; a downgraded authority also holds members' protocol-2 changes. Keep every copy upgraded.`,
    };
  const recovered = ctx.terms.some((term) => term.ended === 'recovery');
  const blockers = protocolBlockers(client, ctx);
  return {
    writeProtocol: 1,
    switch: null,
    blockers,
    summary: `record protocol 1: not switched; ${blockers.length ? `${blockers.length} blocking copy(ies), named in recordProtocol.blockers` : 'no blocking copies'}`,
    detail:
      (recovered
        ? "Not switched: the recovery's adopted prefix contains no counted protocol-2 switch. "
        : '') +
      (blockers.length
        ? 'Upgrade and sync each blocking copy, or have the authority set it aside if it is gone.'
        : ctx.ownReplica === ctx.authority
          ? 'Every active copy reports reads 2 or later; the next authority write can switch this record.'
          : "This copy follows protocol 1 until it receives the authority's counted protocol-2 switch."),
  };
}

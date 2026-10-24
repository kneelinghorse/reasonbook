// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Explain this record's counted protocol switch and name every active copy delaying it.
// ABOUTME: Keep informational protocol state separate from conflicts, with compact text and complete structured blockers.
import type { RbookDatabaseClient } from './client';
import { mergeContext } from './record-context';
import { isActiveDashboardRoute } from './record-dashboard-route';
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
  readonly stranded: readonly ProtocolBlockingCopy[];
  readonly summary: string;
  readonly detail: string;
}

/** Review never migrates peer metadata or silently invents a direct-sharing remedy on read failure. */
function hostedRecord(client: RbookDatabaseClient, authority: string): boolean {
  const tables = client.getMany<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('referee_state', 'record_peers')"
  );
  if (!tables.success) throw new Error(tables.error?.message ?? 'Could not read shared routes.');
  if (tables.data?.some((row) => row.name === 'referee_state')) return true;
  if (!tables.data?.some((row) => row.name === 'record_peers')) return false;
  const route = client.getOne<{ route?: string | null }>(
    'SELECT * FROM record_peers WHERE replica_id = ?',
    [authority]
  );
  if (!route.success)
    throw new Error(route.error?.message ?? 'Could not read the authority route.');
  return isActiveDashboardRoute(route.data?.route ? JSON.parse(route.data.route) : null);
}

export function protocolReview(client: RbookDatabaseClient): RecordProtocolReview {
  const ctx = mergeContext(client);
  const switched = protocolSwitch(client, ctx);
  const authority = ctx.ownReplica === ctx.authority;
  const hosted = hostedRecord(client, ctx.authority);
  const oldCopies = authority ? protocolBlockers(client, ctx) : [];
  if (switched)
    return {
      writeProtocol: 2,
      switch: switched,
      blockers: [],
      stranded: oldCopies,
      summary:
        'record protocol 2: switched; downgraded copies keep out streams and may rename ids locally' +
        (oldCopies.length
          ? `; ${oldCopies.length} stranded copy(ies), named in recordProtocol.stranded`
          : ''),
      detail:
        `Switched at authority term ${switched.epoch}, sequence ${switched.seq}. A downgraded copy keeps out protocol-2 streams and may rename ids locally; a downgraded authority also holds members' protocol-2 changes. Keep every copy upgraded.` +
        (oldCopies.length
          ? ` Each stranded copy receives nothing new since authority term ${switched.epoch}, sequence ${switched.seq}; upgrade and sync it${hosted ? '.' : ', or have the authority set it aside if it is gone.'}`
          : ''),
    };
  const recovered = ctx.terms.some((term) => term.ended === 'recovery');
  const blockers = oldCopies;
  return {
    writeProtocol: 1,
    switch: null,
    blockers,
    stranded: [],
    summary: `record protocol 1: not switched; ${blockers.length ? `${blockers.length} blocking copy(ies), named in recordProtocol.blockers` : 'no blocking copies'}`,
    detail:
      (recovered
        ? "Not switched: the recovery's adopted prefix contains no counted protocol-2 switch. "
        : '') +
      (blockers.length
        ? hosted
          ? 'Upgrade and sync each blocking copy; until then this hosted record stays on protocol 1.'
          : 'Upgrade and sync each blocking copy, or have the authority set it aside if it is gone.'
        : ctx.ownReplica === ctx.authority
          ? 'Every active copy reports reads 2 or later; the next authority write can switch this record.'
          : `This copy follows protocol 1. ${hosted ? "The dashboard's referee" : "The owner's copy"} switches once every active copy reports reads 2 or later.`),
  };
}

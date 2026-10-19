// SPDX-License-Identifier: Apache-2.0
// ABOUTME: @aquex/reasonbook/referee (s97-m09, design §R1): the library a host such as the dashboard runs to referee a
// ABOUTME: shared record with Reasonbook's own engine; every call opens its store for one step and returns the new head.

/**
 * The referee contract, v1 (rbook/planning/s97-shared-through-the-dashboard-build.md).
 *
 * Every call takes the store's location and the head the previous call returned, opens the store,
 * does one step, closes it and returns `{ result, head }`. Send `result` to the caller unchanged,
 * with `refereeStatus(result)` as its HTTP status, and record `head` off the volume to pass back as
 * `expectedHead`. A store behind that head is refused with REFEREE_NEEDS_RECOVERY.
 *
 * A store ahead of that head is served: a host that wrote but lost the head it was given can carry on.
 * So a restore of the volume must mark every referee store on it as needing recovery (D1, D8): a
 * restore taken between the recorded head and the store's own would otherwise pass.
 *
 * REFEREE_NEEDS_RECOVERY means the store is lost to this project (missing, never made here, restored,
 * replaced, behind or forked); REFEREE_FAILED (503) means it could not be used just now, so retry;
 * REFEREE_MIGRATE_NEEDED means run migrate(). REFEREE_PROTOCOL_NEWER and REFEREE_CLOCK_AHEAD leave the
 * changes on their copy, to go up on a later sync. createReferee may be retried until the referee
 * joins: it answers its own pending join request again for the same owner account.
 *
 * Calls in one process run one at a time; run projects in parallel in separate workers. No call
 * loads sqlite-vec, embeds, sets a timer, runs a hook, opens a network connection or reads the
 * working folder; replica bindings live under `configDir`, one folder per referee store. Rate
 * limits are the host's: the library refuses forged and malformed deliveries, not frequent ones.
 */

import { getServerVersion } from '../server-version';
import { PROTOCOL_VERSION } from '../tools/rbook/record-changes';
import { SYNC_PROTOCOL } from '../tools/rbook/record-exchange';
import { DASHBOARD_LIMIT_FLOOR } from '../tools/rbook/record-pages';

export { REFEREE_ERROR_CODES, refereeStatus } from './codes';
export type { RefereeLocation, RefereeOutcome, StreamHead } from './open';
export { peer, PEER_METHODS, type Caller } from './peer';
export { applyJoinAnswer, archiveReferee, createReferee, discardReferee } from './handover';
export { invite, members, remove, setRole, type HostedMember } from './membership';
export { exportSnapshot, makeFirstCopy, migrate } from './copies';
export {
  conflicts,
  peers,
  recentChanges,
  waiting,
  type CopyState,
  type RecentChange,
  type WaitingTransaction,
} from './views';
export type { JoinAnswer, JoinRequest } from '../tools/rbook/record-join';
export type { LoggedChange } from '../tools/rbook/record-standing';
export type { FreshCopy } from '../tools/rbook/record-fresh-copy';
export type { RbookToolError, RbookToolResult } from '../tools/rbook/types';

/** The library's own version, the package's, and the two protocols it speaks (D9 reports them). */
export const REFEREE_VERSION: string = getServerVersion();
export const REFEREE_PROTOCOL = { wire: SYNC_PROTOCOL, record: PROTOCOL_VERSION } as const;

/** The smallest request a host must accept after decompression, so a delivery pages by whole transactions within it. */
export const MIN_REQUEST_LIMIT_BYTES: number = DASHBOARD_LIMIT_FLOOR;

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What a copy keeps out when a change arrives in a newer record protocol (s100-m01, settled item 6): that change
// ABOUTME: and the rest of its replica's stream, a note the review shows until this copy upgrades, and how a sync says so.

import type { RbookDatabaseClient } from './client';
import { PROTOCOL_VERSION } from './record-protocol';
import type { LoggedChange } from './record-standing';
import { COPY_KEYS, readCopyKey, writeCopyKey } from './replica-copy-keys';

/** How a person upgrades Reasonbook on a machine, as every newer-protocol note names it. */
export const UPGRADE_COMMAND = 'npm install -g @aquex/reasonbook@latest';

/**
 * What this copy takes in of what arrived, and what it keeps out. A change written in a record
 * protocol newer than this copy's may be of a kind this version cannot store, so it stays on the
 * copy that sent it, with the rest of its replica's stream from its transaction on; everything else
 * is taken in. This copy's marks stop before it (replicaMarks), so every exchange asks for it again,
 * and the first after this copy upgrades takes it in. Pass a whole delivery: a part of one cannot
 * tell what follows a held change in its replica's stream.
 */
export function keptOut(incoming: readonly LoggedChange[]): {
  readonly taken: LoggedChange[];
  readonly held: LoggedChange[];
} {
  const txnStart = new Map<string, number>();
  for (const change of incoming)
    txnStart.set(
      change.txn_id,
      Math.min(txnStart.get(change.txn_id) ?? Infinity, change.replica_seq)
    );
  const from = new Map<string, number>();
  for (const change of incoming)
    if (change.protocol_version > PROTOCOL_VERSION)
      from.set(
        change.replica_id,
        Math.min(from.get(change.replica_id) ?? Infinity, txnStart.get(change.txn_id)!)
      );
  const taken: LoggedChange[] = [];
  const held: LoggedChange[] = [];
  for (const change of incoming)
    (change.replica_seq >= (from.get(change.replica_id) ?? Infinity) ? held : taken).push(change);
  return { taken, held };
}

/** The newest record protocol a delivery's kept-out changes are written in, or 0. */
export function newestProtocol(changes: readonly LoggedChange[]): number {
  return Math.max(0, ...changes.map((change) => change.protocol_version));
}

/**
 * Keep in mind that this copy kept changes of a newer record protocol out, for its review (the
 * sprint-100 build's critics): a sync's own answer says so only to whoever ran it and read it, and
 * a hook's or the timer's sync is read by no one. The first time a protocol was met is kept.
 */
export function noteNewerProtocol(client: RbookDatabaseClient, protocol: number): void {
  const held = newerProtocolHeld(client);
  if (held && held.protocol >= protocol) return;
  writeCopyKey(
    client,
    COPY_KEYS.newerProtocol,
    JSON.stringify({ protocol, at: new Date().toISOString() })
  );
}

/** The newer record protocol this copy keeps changes of out, and since when; null once it speaks it. */
export function newerProtocolHeld(
  client: RbookDatabaseClient
): { readonly protocol: number; readonly at: string } | null {
  const raw = readCopyKey(client, COPY_KEYS.newerProtocol);
  if (!raw) return null;
  try {
    const held = JSON.parse(raw) as { protocol?: unknown; at?: unknown };
    return typeof held.protocol === 'number' &&
      held.protocol > PROTOCOL_VERSION &&
      typeof held.at === 'string'
      ? { protocol: held.protocol, at: held.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * What a sync says when a copy kept changes of a newer protocol out: this copy, which must upgrade,
 * or the far copy, named, which must, while this copy's own changes wait on it.
 */
export function newerProtocolWarning(count: number, keptBy: 'here' | string): string {
  return keptBy === 'here'
    ? `${count} change(s) arrived written in a record protocol newer than this copy's ${PROTOCOL_VERSION}, so they stay on the copy that sent them, with what it wrote after them, and come again at every sync. Upgrade Reasonbook here to take them in: ${UPGRADE_COMMAND}.`
    : `${keptBy} kept out ${count} change(s) this copy sent, written in a record protocol newer than its own, with what came after them; they stay here and go up once Reasonbook is upgraded there.`;
}

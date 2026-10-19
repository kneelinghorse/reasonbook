// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Changes cut into pages of whole transactions within a byte budget (s97-m10, design §R2): what one request to
// ABOUTME: the dashboard carries in either direction, and the transaction too large for any page.

import type { LoggedChange } from './record-standing';

/** The least request a dashboard takes, after decompression (contract v1 D2, the referee's MIN_REQUEST_LIMIT_BYTES). */
export const DASHBOARD_LIMIT_FLOOR = 32 * 1024 * 1024;

/** A change's size in a request: its JSON and the comma after it. */
export function changeBytes(change: LoggedChange): number {
  return Buffer.byteLength(JSON.stringify(change)) + 1;
}

/** Each transaction's changes, in the order the first of each appears; a copy's own order is kept. */
function transactions(changes: readonly LoggedChange[]): LoggedChange[][] {
  const byTxn = new Map<string, LoggedChange[]>();
  for (const change of changes) {
    const txn = byTxn.get(change.txn_id);
    if (txn) txn.push(change);
    else byTxn.set(change.txn_id, [change]);
  }
  return [...byTxn.values()];
}

const bytesOf = (txn: readonly LoggedChange[]): number =>
  txn.reduce((sum, change) => sum + changeBytes(change), 0);

export interface Paged {
  /** Pages of whole transactions, in order: every one before an oversized transaction, if any. */
  readonly pages: LoggedChange[][];
  /** The first transaction larger than the budget on its own, which no page carries, nor any after it. */
  readonly oversized: { readonly txnId: string; readonly bytes: number } | null;
}

/**
 * Cut `changes` into pages of whole transactions, in order, each within `budget` bytes; nothing at all
 * gives one empty page. A page never splits a transaction: the referee takes one in once, so a later
 * page joining it would be refused as a forgery. Pages stop before a transaction larger than any page.
 */
export function pagesOf(changes: readonly LoggedChange[], budget: number): Paged {
  const pages: LoggedChange[][] = [];
  let page: LoggedChange[] = [];
  let size = 0;
  for (const txn of transactions(changes)) {
    const bytes = bytesOf(txn);
    if (bytes > budget) {
      if (page.length) pages.push(page);
      return { pages, oversized: { txnId: txn[0].txn_id, bytes } };
    }
    if (page.length && size + bytes > budget) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(...txn);
    size += bytes;
  }
  if (page.length || !pages.length) pages.push(page);
  return { pages, oversized: null };
}

/**
 * The first page of `changes` within `budget`, and whether more follow. It always holds the first
 * transaction, however large: a stream sent back is never held up by its size.
 */
export function firstPage(
  changes: readonly LoggedChange[],
  budget: number
): { readonly changes: LoggedChange[]; readonly more: boolean } {
  const txns = transactions(changes);
  const page: LoggedChange[] = [];
  let size = 0;
  let taken = 0;
  for (const txn of txns) {
    const bytes = bytesOf(txn);
    if (taken > 0 && size + bytes > budget) break;
    page.push(...txn);
    size += bytes;
    taken += 1;
  }
  return { changes: page, more: taken < txns.length };
}

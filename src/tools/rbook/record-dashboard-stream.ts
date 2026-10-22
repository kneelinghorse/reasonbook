// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Assemble dashboard pages as bounded whole-transaction prefixes for ordinary sync.
// ABOUTME: Complete recovery fetches refuse a cap or stalled stream rather than accepting a partial log.
import type { LoggedChange } from './record-standing';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';

export async function readDashboardChanges(
  fetchPage: (
    marks: Record<string, number>
  ) => Promise<{ changes: LoggedChange[]; more: boolean } | LoggedChange[]>,
  marks: Readonly<Record<string, number>>,
  options: {
    readonly maxStreamBytes: number;
    readonly requireComplete?: boolean;
    readonly name: string;
  }
): Promise<LoggedChange[]> {
  const since: Record<string, number> = { ...marks };
  const all: LoggedChange[] = [];
  let taken = 0;
  for (;;) {
    const page = await fetchPage(since);
    if (Array.isArray(page)) return [...all, ...page];
    all.push(...page.changes);
    if (!page.more) return all;
    // Ordinary sync resumes a capped prefix; recovery requires the complete record.
    taken += JSON.stringify(page.changes).length;
    if (taken > options.maxStreamBytes) {
      if (options.requireComplete)
        throw new ReplicaRefusal({
          code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
          message:
            'The complete record exceeds this recovery fetch limit, so no partial log was returned.',
          suggestion:
            'Recover from complete local copies, or raise the fetch limit before retrying.',
        });
      return all;
    }
    let moved = false;
    for (const change of page.changes)
      if (change.replica_seq > (since[change.replica_id] ?? 0)) {
        since[change.replica_id] = change.replica_seq;
        moved = true;
      }
    if (!moved)
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message: `${options.name} said more changes wait but sent none, so the sync stopped.`,
        suggestion:
          'Sync again; if this repeats, report it with the dashboard address and the time.',
      });
  }
}

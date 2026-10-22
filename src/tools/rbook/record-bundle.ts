// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A shared record's changes carried as a file (ADR s96 §7): a header, the chain hashes at the marks it assumed,
// ABOUTME: a content hash and the changes since those marks, imported one whole transaction at a time.

import { createHash } from 'crypto';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { applyRemote, changesSince, type ApplyReport } from './record-apply';
import { embedLive } from './record-apply-embed';
import { attachWarnings } from './format-warnings';
import { canonicalJson } from './record-capture';
import { chainClashes, chainsAt } from './record-chain';
import { clashRefusal, hello, pairRefusal, SYNC_PROTOCOL, type Hello } from './record-exchange';
import { memberProblem } from './record-exchange-steps';
import { receivedMove } from './record-move-receipt';
import {
  keptOut,
  newerProtocolWarning,
  newestProtocol,
  noteNewerProtocol,
} from './record-protocol-hold';
import { rememberCopyReport } from './record-peer-report';
import type { CopyReport } from './record-copy-report';
import { mergeContext, type LoggedChange } from './record-standing';
import { mergeRefusal } from './record-token';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

export const BUNDLE_FORMAT = 'reasonbook-bundle';

export interface Bundle {
  readonly format: typeof BUNDLE_FORMAT;
  readonly protocol: number;
  readonly projectId: string;
  /** The copy that wrote it: who it is, the blocks it knows and how far it holds each stream. */
  readonly from: Hello;
  /** The recipient's marks the writer assumed: the bundle holds every change after them. */
  readonly since: Readonly<Record<string, number>>;
  /** The writer's chain hash at each assumed mark it holds, so the recipient can check its own. */
  readonly chains: Readonly<Record<string, string | null>>;
  readonly changes: readonly LoggedChange[];
  /** sha256 of everything above, so a damaged or edited file is refused whole. */
  readonly hash: string;
}

export interface BundleImport {
  /** s96-m13: the bundle came from a copy one move ahead; this copy holds the move to confirm. */
  readonly caughtUp?: { readonly epoch: number; readonly authority: string };
  readonly transactions: number;
  readonly stored: number;
  readonly judged: number;
  readonly conflicts: number;
  readonly held: number;
  readonly newlyLive: readonly string[];
  readonly notes: readonly string[];
  /** s100-m01: changes kept out with their replica's stream, written in a newer record protocol. */
  readonly newerProtocol: number;
}

const contentHash = (bundle: Omit<Bundle, 'hash'>): string =>
  createHash('sha256').update(canonicalJson(bundle)).digest('hex');

/** Everything this copy holds after the recipient's assumed marks, as a bundle. */
export function writeBundle(
  client: RbookDatabaseClient,
  since: Readonly<Record<string, number>>,
  recipient: Pick<CopyReport, 'reads'> = {}
): Bundle {
  const self = hello(client);
  const assumed = Object.fromEntries(
    Object.entries(since).filter(
      ([replicaId, mark]) => mark > 0 && (self.marks[replicaId] ?? 0) >= mark
    )
  );
  const body: Omit<Bundle, 'hash'> = {
    format: BUNDLE_FORMAT,
    protocol: SYNC_PROTOCOL,
    projectId: self.projectId,
    from: self,
    since,
    chains: chainsAt(client, assumed),
    changes: changesSince(client, since, recipient),
  };
  return { ...body, hash: contentHash(body) };
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/** Parse a bundle's text, refusing anything that is not one whole, unedited bundle. */
export function readBundle(text: string): RbookToolResult<Bundle> {
  let bundle: Bundle;
  try {
    bundle = JSON.parse(text) as Bundle;
  } catch {
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: 'The file is not a bundle: it is not JSON.',
      suggestion: 'Carry the bundle file as written, unchanged.',
    });
  }
  if (bundle?.format !== BUNDLE_FORMAT || !Array.isArray(bundle.changes))
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: 'The file is not a Reasonbook bundle.',
      suggestion: 'Import a file that reasonbook sync --bundle-out wrote.',
    });
  const { hash, ...body } = bundle;
  if (contentHash(body) !== hash)
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        'The bundle does not match its content hash, so it was damaged or edited, and nothing was imported.',
      suggestion: 'Write the bundle again and carry it unchanged.',
    });
  return createSuccess(bundle);
}

/**
 * Import a bundle: the same checks as an exchange, then each transaction it carries applied whole,
 * in order, so an import that stops leaves only whole transactions behind (ADR s96 §7).
 */
export function importBundle(
  client: RbookDatabaseClient,
  bundle: Bundle
): RbookToolResult<BundleImport> {
  const self = hello(client);
  // The copy check first, as an opener's: a restored or replaced copy takes in a catch-up only.
  const refused = mergeRefusal(client, bundle.from.epoch > self.epoch);
  if (refused) return createError<BundleImport>(refused);
  const outcome = 'nothing was imported';
  const unpaired = pairRefusal(self, bundle.from, "the bundle's copy", outcome);
  if (unpaired) return createError<BundleImport>(unpaired);
  // The writer's chains at the marks it assumed, against this copy's own where it holds as far.
  const comparable = Object.keys(bundle.chains).filter(
    (replicaId) => (self.marks[replicaId] ?? 0) >= (bundle.since[replicaId] ?? 0)
  );
  const ours = chainsAt(
    client,
    Object.fromEntries(comparable.map((replicaId) => [replicaId, bundle.since[replicaId]]))
  );
  const theirs = Object.fromEntries(
    comparable.map((replicaId) => [replicaId, bundle.chains[replicaId]])
  );
  const clashes = chainClashes(ours, theirs);
  // s96-m13 (ADR s96 §8): across a move a bundle only brings the copy behind up to it.
  if (bundle.from.epoch < self.epoch)
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        "The bundle's copy has not taken the owner copy's latest move, so nothing was imported.",
      suggestion:
        "Bring that copy up to the move first (a bundle from the owner's copy, then reasonbook sync --confirm-owner there), and write the bundle again.",
    });
  const catchUp = bundle.from.epoch > self.epoch;
  // As a direct catch-up: the copy one move ahead must be the owner's copy in one of the two views.
  if (
    catchUp &&
    bundle.from.replicaId !== bundle.from.authority &&
    bundle.from.replicaId !== self.authority
  )
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        "This copy has not taken the owner copy's latest move, and the bundle's copy is not the owner's copy in either view, so nothing was imported.",
      suggestion: "Import a bundle the owner's copy wrote.",
    });
  // ADR s96 §8, §11: a copy the bundle's copy shows as removed receives nothing new.
  if (bundle.from.removed.includes(self.replicaId))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        "The bundle's copy shows this copy's member as removed, so this copy takes in nothing new from it.",
      suggestion: 'Ask the owner to invite the member again; this copy then syncs as before.',
    });
  // A member's copy that must take a new identity needs the authority's answer in one exchange.
  if (
    !catchUp &&
    self.replicaId === self.authority &&
    memberProblem(bundle.from, self, clashes.includes(bundle.from.replicaId))
  )
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        "The bundle's copy must take a new identity first, which needs a direct sync with the owner's copy, so nothing was imported.",
      suggestion:
        "Sync that copy over SSH from the owner's machine (reasonbook sync), or give its member a fresh copy (reasonbook copy, then reasonbook join).",
    });
  const clashed = clashRefusal(self, bundle.from, clashes, "the bundle's copy", outcome);
  if (clashed) return createError<BundleImport>(clashed);

  // s100-m01 (settled item 6): what a newer record protocol keeps out is decided over the whole
  // bundle, which each transaction's own apply below could not see.
  const { taken, held: keptOutChanges } = keptOut(bundle.changes);
  const byTxn = new Map<string, LoggedChange[]>();
  for (const change of taken)
    byTxn.set(change.txn_id, [...(byTxn.get(change.txn_id) ?? []), change]);
  const totals = { stored: 0, judged: 0, conflicts: 0, held: 0 };
  const newlyLive = new Set<string>();
  const notes: string[] = [];
  let last: ApplyReport | null = null;
  // Each replica's own order, merged by the clock of each one's next transaction: a create is
  // applied, and judged, before what another replica wrote against it, and a successor's renumber
  // before the changes it moved, whose clocks are older than its own (ADR s96 §5).
  const firstHlc = (changes: readonly LoggedChange[]) =>
    changes.reduce((low, change) => (change.hlc < low ? change.hlc : low), changes[0].hlc);
  const firstSeq = (changes: readonly LoggedChange[]) =>
    Math.min(...changes.map((change) => change.replica_seq));
  const streams = new Map<string, LoggedChange[][]>();
  for (const changes of byTxn.values())
    streams.set(changes[0].replica_id, [...(streams.get(changes[0].replica_id) ?? []), changes]);
  for (const stream of streams.values()) stream.sort((a, b) => firstSeq(a) - firstSeq(b));
  const ordered: LoggedChange[][] = [];
  while (ordered.length < byTxn.size) {
    let next: LoggedChange[][] | undefined;
    for (const stream of streams.values())
      if (stream.length && (!next || firstHlc(stream[0]) < firstHlc(next[0]))) next = stream;
    ordered.push(next!.shift()!);
  }
  for (const changes of ordered) {
    const applied = applyRemote(client, changes, { judge: !catchUp, catchUp });
    if (!applied.success || !applied.data) return createError<BundleImport>(applied.error!);
    last = applied.data;
    totals.stored += applied.data.stored;
    totals.judged += applied.data.judged;
    applied.data.newlyLive.forEach((txnId) => newlyLive.add(txnId));
    notes.push(...applied.data.notes);
  }
  if (keptOutChanges.length) noteNewerProtocol(client, newestProtocol(keptOutChanges));
  // s100-m01: a move kept out did not arrive, so there is nothing to confirm yet.
  const arrived = catchUp ? receivedMove(hello(client), bundle.from) : null;
  if (mergeContext(client).members.has(bundle.from.replicaId))
    rememberCopyReport(client, bundle.from.replicaId, bundle.from);
  return createSuccess<BundleImport>(
    {
      ...(arrived ? { caughtUp: arrived } : {}),
      transactions: byTxn.size,
      ...totals,
      conflicts: last?.conflicts ?? 0,
      held: last?.held ?? 0,
      newlyLive: [...newlyLive],
      notes,
      newerProtocol: keptOutChanges.length,
    },
    keptOutChanges.length ? [newerProtocolWarning(keptOutChanges.length, 'here')] : []
  );
}

/**
 * Import a bundle, then embed what it made live once its merges committed (s96-m13); a failed
 * embedding never undoes the import, and is a warning on the answer.
 */
export async function importBundleAndEmbed(
  client: RbookDatabaseClient,
  bundle: Bundle
): Promise<RbookToolResult<BundleImport>> {
  const warnings: string[] = [];
  const result = await (async (): Promise<RbookToolResult<BundleImport>> => {
    const imported = importBundle(client, bundle);
    if (!imported.success || !imported.data) return imported;
    const embedded = await embedLive(client, imported.data.newlyLive);
    warnings.push(...embedded.warnings);
    return imported;
  })();
  return attachWarnings(result, warnings);
}

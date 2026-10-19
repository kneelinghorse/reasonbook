// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — `reasonbook drafts list`: the drafts awaiting the operator, with their computed state.
// ABOUTME: Read-only: opens the store and the draft runtime read-only, migrates and writes nothing.

import Database from 'better-sqlite3';

import { openDraftRuntime, startsSince } from '../tools/rbook/draft-runtime';
import {
  draftLabel,
  draftsCreatedBetween,
  isExpired,
  pendingDrafts,
  rawRunner,
  type DraftRow,
} from '../tools/rbook/proposals';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { parseArgs, resolveCliProject, type CliIo } from './core';

/** How far back `--all` reaches. */
const ALL_DAYS = 30;

export interface ListedDraft {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  /** The stored outcome, or `expired` for a pending draft past its lease. */
  readonly state: string;
  readonly createdAt: string;
  readonly offeredAt: string | null;
  readonly answeredAt: string | null;
  readonly recordId: string | null;
  readonly replacedBy: string | null;
  readonly approvalMode: string | null;
  readonly outsideContent: 'seen' | 'none' | 'unknown';
  readonly evidence: readonly string[];
}

function listed(row: DraftRow, starts: number, now: number): ListedDraft {
  return {
    id: draftLabel(row.id),
    kind: row.kind,
    text: row.text,
    state: row.outcome === 'pending' && isExpired(row, starts, now) ? 'expired' : row.outcome,
    createdAt: row.createdAt,
    offeredAt: row.offeredAt,
    answeredAt: row.answeredAt,
    recordId: row.recordId,
    replacedBy: row.replacedBy ? draftLabel(row.replacedBy) : null,
    approvalMode: row.approvalMode,
    outsideContent:
      row.outsideContent === 1 ? 'seen' : row.outsideContent === 0 ? 'none' : 'unknown',
    evidence: row.evidence,
  };
}

/** The drafts a store holds: pending ones (expiry applied), or with `all`, the last 30 days'. */
export function listDrafts(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  all: boolean,
  now: number = Date.now()
): ListedDraft[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  const runtime = openDraftRuntime(dbPath, env, { readonly: true });
  try {
    const run = rawRunner(db);
    const rows = all
      ? draftsCreatedBetween(
          run,
          new Date(now - ALL_DAYS * 86_400_000).toISOString(),
          new Date(now).toISOString()
        )
      : pendingDrafts(run);
    const drafts = rows.map((row) =>
      listed(row, runtime ? startsSince(runtime, storedTimeMs(row.createdAt)) : 0, now)
    );
    return all ? drafts : drafts.filter((draft) => draft.state === 'pending');
  } finally {
    runtime?.close();
    db.close();
  }
}

function line(draft: ListedDraft): string {
  const outcome =
    draft.state === 'pending'
      ? `pending${draft.offeredAt ? ', offered' : ''}${draft.replacedBy ? `, revised by ${draft.replacedBy} after its approval` : ''}`
      : draft.state === 'replaced'
        ? `replaced by ${draft.replacedBy}`
        : draft.state === 'approved' || draft.state === 'answered'
          ? `${draft.state} as ${draft.recordId}${draft.approvalMode ? ` (${draft.approvalMode})` : ''}`
          : draft.state;
  const outside = draft.outsideContent === 'seen' ? '; outside content seen' : '';
  return `  ${draft.id} [${draft.kind}] ${draft.createdAt.slice(0, 10)} ${draft.text} — ${outcome}${outside}`;
}

export async function runDrafts(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if ((positional[0] ?? 'list') !== 'list') {
    io.stderr('Usage: reasonbook drafts list [--all] [--format json] [--project-root <dir>]');
    return 1;
  }
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store') {
    io.stderr('reasonbook drafts: no Reasonbook project here; pass --project-root <dir>.');
    return 1;
  }
  try {
    const drafts = listDrafts(resolution.dbPath, io.env, flags.all === 'true');
    if (flags.format === 'json') {
      io.stdout(`${JSON.stringify(drafts, null, 2)}\n`);
      return 0;
    }
    const title = flags.all === 'true' ? `Drafts from the last ${ALL_DAYS} days` : 'Pending drafts';
    io.stdout(
      drafts.length
        ? `${title} (${drafts.length}):\n${drafts.map(line).join('\n')}\n`
        : `${title}: none.\n`
    );
    return 0;
  } catch (error) {
    io.stderr(
      `reasonbook drafts: the store could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}

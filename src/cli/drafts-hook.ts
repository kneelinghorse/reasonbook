// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — what the hooks do with drafts: Stop stores "Would record" lines silently and notes what the reply
// ABOUTME: showed; the next message binds only to that; session start counts toward expiry; session end forgets.

import {
  openStore,
  storeTimeout,
  checkDeadline,
  withRuntime,
  unexpired,
} from './drafts-hook-runtime';
export {
  prepareOffer,
  NO_OFFER,
  OFFERS_PER_START,
  OFFER_TEXT_MAX,
  type PreparedOffer,
} from './drafts-offer';

import {
  draftCoverage,
  keywordOverlap,
  proseLines,
  readDraftReply,
  REVISION_COVERAGE,
  REVISION_OVERLAP,
  SINGLE_REVISION_FLOOR,
  type DraftLine,
} from '../tools/rbook/draft-grammar';
import {
  closeWindow,
  endDraftSession,
  openDraftRuntime,
  openWindow,
  carryShown,
  pruneAllRuntimes,
  pendingDeclines,
  readExcerpt,
  recordSessionStart,
  setShown,
} from '../tools/rbook/draft-runtime';
import { harnessSessionHash } from '../tools/rbook/harness-session';
import {
  ensureProposalsTable,
  getDraft,
  insertDraft,
  markReplaced,
  markRevisedAfterApproval,
  newestPending,
  pendingDrafts,
  proposalsTableExists,
  rawRunner,
  type DraftRow,
} from '../tools/rbook/proposals';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { lastAssistantText } from './transcript-scan';
import { readScans } from '../tools/rbook/draft-runtime';
import { scanSession, sessionOutside } from './drafts-scan';
export { sessionOutside } from './drafts-scan';
import { retryRetainedDeclines } from './drafts-decline';

/**
 * THE FLOW (design doc s93 m06; decisions #1186–#1188; build plan B5–B8, B13, B16, with the plan
 * critic's folds).
 *   Stop: the reply's trailing "Would record" lines become pending drafts (a repeated line shows
 *     its draft again; a revised one replaces the draft the operator's last message answered).
 *     Stop then records what the reply SHOWED the operator: those drafts and any pending draft it
 *     named by id. It writes nothing to stdout, ever (#1187).
 *   Prompt: the operator's message binds ONLY to what the reply before it showed. A plain decline
 *     declines those; anything else keeps the message as their words for two hours, outside the
 *     store. Other eligible drafts are reminders to the agent, never bound: on up to two more
 *     messages in the session that drafted them, and on the first message of a later session.
 *   Session start: counted toward the 3-start expiry; every store's stale words are pruned.
 *   Session end: the session's words, offers, windows, shown set and scans are deleted.
 * Under the review role (RBOOK_AGENT_ROLE=review) the hooks store, bind and decline nothing.
 */

/** Stop keeps this much of its budget for closing up after the scan. */
const SCAN_MARGIN_MS = 60;

function same(a: string, b: string): boolean {
  const norm = (text: string): string =>
    text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.!…\s]+$/, '')
      .trim();
  return norm(a) === norm(b);
}

/**
 * Counted when a non-compact session starts; nothing is written to the store. Also prunes every
 * store's stale words. Best effort, never throws: an uncounted start only lets a draft live to its
 * 7-day limit, and the digest and the session link matter more at session start.
 */
export function onSessionStart(
  dbPath: string,
  rawSessionId: string,
  source: string | undefined,
  env: NodeJS.ProcessEnv,
  now: number = Date.now()
): boolean {
  // A review-role session writes nothing, and a critic's run must not shorten anyone's lease.
  if (isReadOnlyAgentSession(env)) return true;
  try {
    pruneAllRuntimes(env, now);
    if (source === 'compact') return true;
    // Only a start after a draft exists counts toward its expiry, and a session that started
    // before every pending draft is concurrent with them: with none pending, nothing is written
    // (the session-start hook stays a read; tests/tools/rbook/reads-never-write.test.ts).
    if (!hasPending(dbPath)) return true;
    return withRuntime(dbPath, env, false, (runtime) => {
      recordSessionStart(runtime, harnessSessionHash(rawSessionId), now);
      return true;
    });
  } catch {
    return false;
  }
}

function hasPending(dbPath: string): boolean {
  const db = openStore(dbPath, true);
  try {
    return pendingDrafts(rawRunner(db)).length > 0;
  } finally {
    db.close();
  }
}

/** Best effort, never throws: words left behind expire within two hours, and the close matters more. */
export function onSessionEnd(
  dbPath: string,
  rawSessionId: string,
  env: NodeJS.ProcessEnv
): boolean {
  try {
    return withRuntime(dbPath, env, false, (runtime) => {
      endDraftSession(runtime, harnessSessionHash(rawSessionId));
      return true;
    });
  } catch {
    return false;
  }
}

export interface StopOutcome {
  readonly lines: number;
  readonly created: number;
  readonly replaced: number;
  readonly elsewhere: number;
}

/**
 * Which window draft each line revises (B3, folded): when the operator's last message answered one
 * draft of a kind, the reply's best line of that kind revises it if they share a subject (an
 * amendment may flip its key term, which the 0.5 overlap missed); among several of a kind, only a
 * line at the full overlap threshold. A line about something else leaves the draft pending. Without
 * a window (s97-m12), a line must hold REVISION_COVERAGE of the draft's own subject instead: no
 * operator message names the draft, so a line on a neighbouring subject, or one part of a longer
 * draft, does not retire it.
 */
function revisions(
  lines: readonly DraftLine[],
  candidates: readonly DraftRow[],
  /**
   * s97-m12: whether a draft is one the operator's last message answered, other than by a plain
   * approval; any other candidate (none answered, kept from an earlier reply, or approved, which a
   * link limits to its own words) is revised only at the coverage rule.
   */
  answered: (draft: DraftRow) => boolean
): Map<number, DraftRow> {
  const assigned = new Map<number, DraftRow>();
  for (const draft of candidates) {
    const ofKind = candidates.filter((row) => row.kind === draft.kind && answered(row)).length;
    const covered = !answered(draft);
    let best = -1;
    let bestScore =
      (covered ? REVISION_COVERAGE : ofKind === 1 ? SINGLE_REVISION_FLOOR : REVISION_OVERLAP) -
      Number.EPSILON;
    lines.forEach((line, index) => {
      if (line.kind !== draft.kind || assigned.has(index)) return;
      const score = covered
        ? draftCoverage(draft.text, line.text)
        : keywordOverlap(draft.text, line.text);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0) assigned.set(best, draft);
  }
  return assigned;
}

/**
 * The pending drafts explicitly named as `draft P12` or `proposal P12`, in first-mention order.
 * on a prose line (outside code, links and URLs) that also shares the draft's subject at the
 * single-revision floor (the build critic, B1): "Now the P1 fix itself" names no draft.
 */
export function namedDrafts(reply: string, pending: readonly DraftRow[]): number[] {
  const byId = new Map(pending.map((draft) => [draft.id, draft]));
  const ids: number[] = [];
  for (const line of proseLines(reply)) {
    for (const match of line.matchAll(
      /\b(?:draft|proposal)\s+P([1-9]\d{0,15})(?![\w/\\-]|\.\w)/gi
    )) {
      const draft = byId.get(Number(match[1]));
      if (
        draft &&
        !ids.includes(draft.id) &&
        keywordOverlap(line, draft.text) >= SINGLE_REVISION_FLOOR
      )
        ids.push(draft.id);
    }
  }
  return ids;
}

function setOutside(dbPath: string, ids: readonly number[], outside: number | null): void {
  const db = openStore(dbPath, false);
  try {
    rawRunner(db).run(
      `UPDATE proposals SET outside_content = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [outside, ...ids]
    );
  } finally {
    db.close();
  }
}

/**
 * Store the reply's trailing "Would record" lines as drafts and note what the reply showed. Never
 * prints. The drafts are written before the transcript scan, so a slow scan cannot lose them at
 * the deadline (the plan critic, N3); the scan's flag is then set on the drafts it created.
 */
export function onStop(options: {
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly reply?: string;
  readonly transcriptPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAtMs: number;
  readonly now?: number;
}): StopOutcome {
  const none = { lines: 0, created: 0, replaced: 0, elsewhere: 0 };
  if (isReadOnlyAgentSession(options.env)) return none;
  const now = options.now ?? Date.now();
  const session = harnessSessionHash(options.rawSessionId);
  const runtime = openDraftRuntime(options.dbPath, options.env, { timeoutMs: storeTimeout() });
  try {
    if (runtime) retryRetainedDeclines(options.dbPath, runtime);
    const declined = new Set(runtime ? pendingDeclines(runtime).map((entry) => entry.id) : []);
    const reply =
      options.reply ??
      (options.transcriptPath ? lastAssistantText(options.transcriptPath) : null) ??
      '';
    const read = readDraftReply(reply);
    const windowIds = runtime ? openWindow(runtime, session, now) : [];
    if (runtime) closeWindow(runtime, session);
    const mentionsId = /\bP[1-9]\d{0,15}\b/.test(reply);
    const priorOutside = runtime ? sessionOutside(readScans(runtime, session)) : null;
    const shown: number[] = [];
    const createdIds: number[] = [];
    let replaced = 0;
    if (read.lines.length || mentionsId) {
      checkDeadline(options.deadlineAtMs);
      const db = openStore(options.dbPath, false);
      try {
        const run = rawRunner(db);
        const update = (): void => {
          if (read.lines.length) ensureProposalsTable(run);
          else if (!proposalsTableExists(run)) return;
          const live = unexpired(runtime, pendingDrafts(run), now).filter(
            (row) => !declined.has(row.id)
          );
          const window = live.filter((row) => windowIds.includes(row.id));
          const fresh: DraftLine[] = [];
          for (const line of read.lines) {
            const repeated = live.find(
              (row) => row.kind === line.kind && same(row.text, line.text)
            );
            if (repeated) {
              if (!shown.includes(repeated.id)) shown.push(repeated.id);
            } else fresh.push(line);
          }
          // s97-m12 (learning #481): a line revises a draft the operator's last message answered at
          // the window's floors, and any other pending draft of this session at the coverage rule,
          // so a revision never leaves what it revises pending. A draft the operator plainly
          // approved keeps that approval: its revision is linked, and it stays pending, to be
          // recorded only in its own words. Window drafts are matched first.
          const approved = (row: DraftRow): boolean => {
            const excerpt = runtime && readExcerpt(runtime, session, row.id, now);
            return excerpt?.reply === 'approval' && !excerpt.late;
          };
          const candidates = [
            ...window,
            ...live.filter((row) => row.sourceSession === session && !windowIds.includes(row.id)),
          ].filter((row) => !shown.includes(row.id));
          const revised = revisions(
            fresh,
            candidates,
            (row) => windowIds.includes(row.id) && !approved(row)
          );
          const at = new Date(now).toISOString();
          fresh.forEach((line, position) => {
            const id = insertDraft(run, {
              text: line.text,
              kind: line.kind,
              sourceSession: session,
              assistantExcerpt: read.excerpt || null,
              evidence: line.evidence,
              outsideContent: priorOutside,
              createdAt: at,
            });
            createdIds.push(id);
            shown.push(id);
            const old = revised.get(position);
            // s100-m02 (verification round 2): the line joins an approved draft's chain at its
            // newest pending draft, and one there the operator never approved it retires, as it
            // would any unapproved draft it revised.
            const target = old && approved(old) ? getDraft(run, newestPending(run, old.id)) : null;
            if (target && target.id !== old!.id && !approved(target))
              replaced += markReplaced(run, target.id, id, at);
            else if (old && approved(old)) markRevisedAfterApproval(run, old.id, id);
            else if (old) replaced += markReplaced(run, old.id, id, at);
          });
          for (const id of namedDrafts(
            reply,
            unexpired(runtime, pendingDrafts(run), now).filter((row) => !declined.has(row.id))
          ))
            if (!shown.includes(id)) shown.push(id);
        };
        // s96-m11: draft lines are written after the pending drafts are read, so that transaction
        // takes the write lock at BEGIN; a commit by another process in between made the insert
        // fail at once. A reply that only names drafts writes nothing, and stays deferred.
        if (read.lines.length) db.transaction(update).immediate();
        else db.transaction(update)();
      } finally {
        db.close();
      }
    }
    if (runtime) {
      // s97-m12: drafts an earlier reply showed that no operator message took, as when the harness
      // opened this turn itself, are kept apart from this reply's (learning #481; critic round 2).
      carryShown(runtime, session, now);
      setShown(runtime, session, shown, now);
      if (options.transcriptPath) {
        const outside = scanSession(
          runtime,
          session,
          options.transcriptPath,
          options.deadlineAtMs - SCAN_MARGIN_MS
        );
        if (createdIds.length && outside !== priorOutside)
          setOutside(options.dbPath, createdIds, outside);
      }
    }
    return {
      lines: read.lines.length,
      created: createdIds.length,
      replaced,
      elsewhere: read.elsewhere,
    };
  } finally {
    runtime?.close();
  }
}

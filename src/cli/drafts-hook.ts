// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — what the hooks do with drafts: Stop stores "Would record" lines silently and notes what the reply
// ABOUTME: showed; the next message binds only to that; session start counts toward expiry; session end forgets.

import Database from 'better-sqlite3';
import * as fs from 'fs';

import {
  classifyReply,
  draftCoverage,
  keywordOverlap,
  proseLines,
  readDraftReply,
  REVISION_COVERAGE,
  REVISION_OVERLAP,
  SINGLE_REVISION_FLOOR,
  type DraftLine,
  type ReplyClass,
} from '../tools/rbook/draft-grammar';
import {
  bindWindow,
  bumpOffers,
  closeWindow,
  endDraftSession,
  offerCounts,
  openDraftRuntime,
  openWindow,
  carryShown,
  pruneAllRuntimes,
  readExcerpt,
  readScans,
  recordSessionStart,
  saveScan,
  sessionStartedAt,
  setShown,
  startsSince,
  takeKept,
  takeShown,
  type DraftRuntime,
  type ScanState,
} from '../tools/rbook/draft-runtime';
import { harnessSessionHash } from '../tools/rbook/harness-session';
import {
  draftLabel,
  ensureProposalsTable,
  insertDraft,
  isExpired,
  markDeclined,
  markOffered,
  markReplaced,
  markRevisedAfterApproval,
  pendingDrafts,
  proposalsTableExists,
  rawRunner,
  type DraftRow,
} from '../tools/rbook/proposals';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { processBusyTimeout } from '../tools/rbook/sqlite-busy';
import { storedTimeMs } from '../tools/rbook/stored-time';
import {
  lastAssistantText,
  scanFile,
  SCAN_MAX_BYTES,
  sessionTranscripts,
  transcriptKey,
} from './transcript-scan';

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

export const OFFERS_PER_START = 3;
export const OFFER_TEXT_MAX = 1000;
const FULL_TEXT_MAX = 300;
const COMPACT_TEXT_MAX = 80;
/** Stop keeps this much of its budget for closing up after the scan. */
const SCAN_MARGIN_MS = 60;

function storeTimeout(): number {
  return processBusyTimeout() ?? 250;
}

function openStore(dbPath: string, readonly: boolean): Database.Database {
  return new Database(dbPath, { readonly, fileMustExist: true, timeout: storeTimeout() });
}

function checkDeadline(deadlineAtMs: number): void {
  if (Date.now() >= deadlineAtMs) throw new Error('draft handling deadline exceeded');
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function same(a: string, b: string): boolean {
  const norm = (text: string): string =>
    text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.!…\s]+$/, '')
      .trim();
  return norm(a) === norm(b);
}

function withRuntime<T>(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  fallback: T,
  action: (runtime: DraftRuntime) => T
): T {
  const runtime = openDraftRuntime(dbPath, env, { timeoutMs: storeTimeout() });
  if (!runtime) return fallback;
  try {
    return action(runtime);
  } finally {
    runtime.close();
  }
}

function unexpired(runtime: DraftRuntime | null, rows: DraftRow[], now: number): DraftRow[] {
  return rows.filter(
    (row) => !isExpired(row, runtime ? startsSince(runtime, storedTimeMs(row.createdAt)) : 0, now)
  );
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

/** The session's outside-content flag over every file scanned: 1 seen, 0 none, null unknown. */
export function sessionOutside(state: ScanState): number | null {
  const values = [...state.files.values()].map((file) => file.outside);
  if (values.includes(1)) return 1;
  if (!values.length || values.includes(null)) return null;
  return 0;
}

const MISSING_SUBAGENTS = 'subagents-missing';

/** Scan what the session's transcripts gained, inside the time left; returns the session's flag. */
function scanSession(
  runtime: DraftRuntime,
  session: string,
  main: string,
  deadlineAtMs: number
): number | null {
  const prior = readScans(runtime, session);
  let budget = SCAN_MAX_BYTES;
  const files = sessionTranscripts(main);
  for (const file of files) {
    const key = transcriptKey(file);
    const before = prior.files.get(key);
    if (Date.now() >= deadlineAtMs || budget <= 0) {
      // Not read this time: a file that grew past its last scan is unknown, never "none" (the
      // build critic, N2). A file already flagged stays flagged.
      let grew = true;
      try {
        grew = fs.statSync(file).size > (before?.scanned ?? 0);
      } catch {
        // Unreadable: unknown.
      }
      if (!before || (grew && before.outside !== 1))
        saveScan(runtime, session, key, {
          scanned: before?.scanned ?? 0,
          outside: before?.outside === 1 ? 1 : null,
        });
      continue;
    }
    try {
      const result = scanFile(file, before?.scanned ?? 0, budget, deadlineAtMs);
      budget -= result.bytes;
      const outside =
        result.outside || before?.outside === 1
          ? 1
          : !result.complete || (before !== undefined && before.outside === null)
            ? null
            : 0;
      saveScan(runtime, session, key, { scanned: result.scanned, outside });
      if (file === main && result.subagent && files.length === 1)
        saveScan(runtime, session, MISSING_SUBAGENTS, { scanned: 0, outside: null });
    } catch {
      saveScan(runtime, session, key, {
        scanned: before?.scanned ?? 0,
        outside: before?.outside === 1 ? 1 : null,
      });
    }
  }
  return sessionOutside(readScans(runtime, session));
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
          const live = unexpired(runtime, pendingDrafts(run), now);
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
          const approved = (row: DraftRow): boolean =>
            runtime !== null && readExcerpt(runtime, session, row.id, now)?.reply === 'approval';
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
            if (old && approved(old)) markRevisedAfterApproval(run, old.id, id);
            else if (old) replaced += markReplaced(run, old.id, id, at);
          });
          for (const id of namedDrafts(reply, unexpired(runtime, pendingDrafts(run), now)))
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

export interface PreparedOffer {
  /** The text to inject ahead of recall; empty when nothing is offered. */
  readonly text: string;
  readonly offered: number;
  /** How the operator's message reads, when it answered drafts; else null. */
  readonly reply: ReplyClass | null;
  /** After the output is delivered: count the offers and stamp first offers. Never throws. */
  commit(): void;
}

export const NO_OFFER: PreparedOffer = { text: '', offered: 0, reply: null, commit: () => {} };

const KIND_NOTE: Readonly<Record<string, string>> = {
  constraint: ' It is recorded as a constraint, and only on the operator’s approval.',
  rule: ' It is recorded as a standing rule (an evergreen learning), and only on the operator’s approval.',
  profile: ' It is a line for the operator profile, written only on the operator’s approval.',
};

function fullOffer(draft: DraftRow): string {
  const label = draftLabel(draft.id);
  let text = `Reasonbook draft ${label} (${draft.kind}), which your last reply put to the operator: "${cut(draft.text, FULL_TEXT_MAX)}".`;
  text += KIND_NOTE[draft.kind] ?? '';
  if (draft.evidence.length) text += ` It names ${draft.evidence.slice(0, 3).join(', ')}.`;
  if (draft.outsideContent === 1)
    text +=
      ' This session read outside content (web pages or other projects’ records) before it was drafted.';
  return text;
}

/**
 * s97-m12 (critic round 2): a draft shown before the latest reply. The operator's message answers
 * that reply, so a plain yes or no to it settles nothing here, and a record of this draft reads
 * agent-judged.
 */
function earlierOffer(draft: DraftRow): string {
  const label = draftLabel(draft.id);
  return `Reasonbook draft ${label} (${draft.kind}) was shown before your last reply and not answered since: "${cut(draft.text, FULL_TEXT_MAX)}". Record it with fromDraft="${label}" only if the operator's message plainly speaks to it (it reads agent-judged); a yes or no to your last reply settles nothing about it.`;
}

function instruction(reply: ReplyClass, bound: readonly DraftRow[]): string {
  const labels = bound.map((draft) => draftLabel(draft.id));
  const one = labels.length === 1;
  const standing = bound.some((draft) => draft.kind !== 'decision');
  const call = (label: string) =>
    `rbook_decisions(action="record", content=<${label}'s text as drafted>, fromDraft="${label}")`;
  switch (reply) {
    case 'approval':
      return one
        ? `The operator’s message is a plain approval of ${labels[0]}: record it now with ${call(labels[0])}. A record that adds to the draft reads agent-judged.`
        : `The operator’s message approves ${labels.join(', ')} together: record each with ${call('P<n>')}; several at once read agent-judged. Ask if it is unclear which.`;
    case 'question':
      return `The operator’s message asks about ${labels.join(', ')}: answer, leave it unrecorded, and end with its Would record line again, revised if your answer changes it.`;
    default:
      return (
        `Only if this message approves ${labels.join(', ')}, record it with ${call(one ? labels[0] : 'P<n>')} and the operator's nuance folded in (it reads agent-judged); ask first when the nuance is unclear or conflicts with a record. An amendment gets a revised Would record line; otherwise leave it pending.` +
        (standing
          ? ' A constraint, rule or profile line is recorded only on a plain approval: propose it again instead.'
          : '')
      );
  }
}

function reminder(draft: DraftRow, later: boolean): string {
  const head = `${draftLabel(draft.id)} (${draft.kind}) "${cut(draft.text, COMPACT_TEXT_MAX)}"`;
  return later
    ? `From an earlier session, awaiting the operator: ${head} — name it as "draft ${draftLabel(draft.id)}" with its subject.`
    : `Still pending: ${head} — not answered; if it still matters, end a reply with its Would record line again.`;
}

/**
 * Bind the operator's message to what the reply before it showed, and remind the agent of other
 * eligible drafts (B6–B8, folded). Runs before any skip rule; the caller emits `text`, then calls
 * `commit`. Writes: the session's runtime words and window, and in the store a decline or a first
 * offer's time (the prompt hook's one store write, named in SECURITY.md).
 */
export function prepareOffer(options: {
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAtMs: number;
  readonly now?: number;
}): PreparedOffer {
  if (isReadOnlyAgentSession(options.env)) return NO_OFFER;
  const now = options.now ?? Date.now();
  const session = harnessSessionHash(options.rawSessionId);
  const reader = openStore(options.dbPath, true);
  let pending: DraftRow[];
  try {
    pending = pendingDrafts(rawRunner(reader));
  } finally {
    reader.close();
  }
  // With nothing pending there is nothing to bind or remind, and no runtime is touched: a shown
  // set left behind names no pending draft, and expires with the session's other words.
  if (!pending.length) return NO_OFFER;
  checkDeadline(options.deadlineAtMs);
  const runtime = openDraftRuntime(options.dbPath, options.env, { timeoutMs: storeTimeout() });
  if (!runtime) return NO_OFFER;
  try {
    // One message answers one reply: what it showed is taken now, whether or not it binds. Drafts
    // an earlier reply showed, kept when the harness opened a turn itself, are taken with it, and
    // bind only as words the agent judges: this message answers the latest reply (s97-m12).
    const shown = takeShown(runtime, session, now);
    const earlier = takeKept(runtime, session, now).filter((id) => !shown.includes(id));
    const startedAtMs = sessionStartedAt(runtime, session);
    const counts = offerCounts(runtime, session);
    const live = unexpired(runtime, pending, now);
    const bound = live.filter((draft) => shown.includes(draft.id));
    const carried = live.filter((draft) => earlier.includes(draft.id));
    const reminders: Array<{ draft: DraftRow; later: boolean }> = [];
    for (const draft of live) {
      // A draft approved and then revised waits to be recorded in its own words, not for an answer.
      if (bound.includes(draft) || carried.includes(draft) || draft.replacedBy !== null) continue;
      const createdMs = storedTimeMs(draft.createdAt);
      const count = counts.get(draft.id) ?? 0;
      const thisStart =
        draft.sourceSession === session && (startedAtMs === null || createdMs >= startedAtMs);
      const later = startedAtMs !== null && startedAtMs > createdMs;
      if ((thisStart && count < OFFERS_PER_START) || (later && count === 0))
        reminders.push({ draft, later: !thisStart });
    }
    if (!bound.length && !carried.length && !reminders.length) return NO_OFFER;
    checkDeadline(options.deadlineAtMs);
    const boundIds = bound.map((draft) => draft.id);
    const carriedIds = carried.map((draft) => draft.id);
    const labels = bound.map((draft) => draftLabel(draft.id));
    const reply = bound.length ? classifyReply(options.message) : carried.length ? 'other' : null;
    const lines: string[] = [];
    // Persist a decline before touching the store: a locked store must not leave an older
    // approval usable after the shown set was consumed. The record path checks these words.
    if (reply) bindWindow(runtime, session, boundIds, options.message, reply, now, carriedIds);
    if (reply === 'decline') {
      const writer = openStore(options.dbPath, false);
      try {
        markDeclined(rawRunner(writer), boundIds, new Date(now).toISOString());
      } finally {
        writer.close();
      }
      lines.push(
        `The operator declined ${labels.join(', ')}; ${labels.length === 1 ? 'it is' : 'they are'} not recorded.`
      );
    } else if (reply && bound.length) {
      // The instruction leads, so the 1,000-character cut can only shorten offers (the build
      // critic, N5).
      lines.push(instruction(reply, bound), ...bound.map(fullOffer));
    }
    lines.push(...carried.map(earlierOffer));
    lines.push(...reminders.map((item) => reminder(item.draft, item.later)));
    let text = lines.join('\n');
    if (text.length > OFFER_TEXT_MAX) text = `${text.slice(0, OFFER_TEXT_MAX - 1).trimEnd()}…`;
    const offeredIds = [
      ...(reply === 'decline' ? [] : boundIds),
      ...carriedIds,
      ...reminders.map((item) => item.draft.id),
    ];
    return {
      text,
      offered: offeredIds.length,
      reply,
      commit: () => {
        if (!offeredIds.length) return;
        try {
          withRuntime(options.dbPath, options.env, undefined, (later) =>
            bumpOffers(later, session, offeredIds)
          );
          const writer = openStore(options.dbPath, false);
          try {
            markOffered(rawRunner(writer), offeredIds, new Date(now).toISOString());
          } finally {
            writer.close();
          }
        } catch {
          // The output is already out; a missed count only lengthens the reminders by one message.
        }
      },
    };
  } finally {
    runtime.close();
  }
}

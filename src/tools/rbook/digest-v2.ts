// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Render the same small, stable local context for session hooks, CLI review and MCP review.
// ABOUTME: Preserve complete profiles, provenance fences and typed item spans within explicit section caps.

import { formatCliRemedy, remedyCommand, type CliRemedyTarget } from '../../utils/cli-remedy';
import { frameInlineIfForeign, isForeignProject } from '../../intelligence/provenance-frame';
import type { OperatorProfile } from './operator-profile';
import { PROFILE_CAP_CHARS } from './operator-profile';
import type { RenderedContext } from './rendered-context';
import { levelName, type ProjectLevel } from './rules-files';
import type { SharedRecordReview } from './record-review';

export interface DigestRow {
  readonly id: string;
  readonly text: string;
  readonly projectId: string | null;
  readonly date?: string;
  /** s96-m12: on a shared record, who wrote it, when someone other than this copy's writer did. */
  readonly author?: string;
}

export interface DigestV2Model {
  readonly project: { readonly name: string; readonly level: ProjectLevel };
  readonly localProjectId: string | null;
  readonly sprint: {
    readonly id: string;
    readonly title: string;
    readonly focus: string | null;
    readonly status: string | null;
    readonly projectId: string | null;
  } | null;
  readonly profile: OperatorProfile | null;
  readonly stepUp: string | null;
  readonly legacyRecord?: boolean;
  readonly rules: readonly DigestRow[];
  readonly decisions: { readonly rows: readonly DigestRow[]; readonly total: number };
  readonly learnings: { readonly rows: readonly DigestRow[]; readonly total: number };
  readonly work: readonly DigestRow[];
  /** s93-m06: pending, unexpired drafts awaiting the operator, oldest first. */
  readonly drafts?: readonly DigestDraft[];
  readonly feedback?: string | null;
  /** s96-m12: what a shared record holds for a person; absent or null off one. */
  readonly shared?: SharedRecordReview | null;
}

export interface DigestDraft {
  readonly id: number;
  readonly kind: string;
  readonly text: string;
}

export const DIGEST_V2_CAP = 4000;
/** The pointer also carries the proposal convention, so a project with no drafts still teaches it. */
export const DIGEST_POINTER =
  'Full: Reasonbook show by ID; search: Reasonbook context search. The operator’s call: end with Would record: <decision>.';
export const DRAFTS_SECTION_CAP = 450;
/** s96-m12: the shared record's section, which takes its room before the drafts do. */
export const SHARED_SECTION_CAP = 600;
const DRAFTS_ASK = 'Name each as "draft P<n>" with its subject; record approval with fromDraft.';

/** Cut only the body, before framing it; never split a provenance boundary or typed ID. */
function cut(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Published label rule: capitals, digits and punctuation ending in colon, em dash or period. */
export function digestHeadline(text: string): string {
  let value = text.replace(/\s+/g, ' ').trim();
  const label = /^[\p{Lu}\d\p{P}\p{Zs}]*?[:—.](?:\s+|$)/u;
  while (label.test(value)) value = value.replace(label, '').trim();
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(value)?.[0] ?? value;
  return cut(sentence, 140);
}

type Line = { text: string; id?: string };
type Section = { text: string; items: RenderedContext['items'] };

function section(lines: readonly Line[]): Section {
  const items: Array<{ typedId: string; start: number; end: number }> = [];
  let text = '';
  for (const line of lines) {
    if (text) text += '\n';
    const start = text.length;
    text += line.text;
    if (line.id) items.push({ typedId: line.id, start, end: text.length });
  }
  return { text, items };
}

function rowLine(row: DigestRow, cap: number, local: string | null): Line | null {
  const prefix = `  • ${row.id}${row.date ? ` ${row.date}` : ''}${row.author ? ` (${cut(row.author, 24)})` : ''} `;
  const overhead = frameInlineIfForeign('', row.projectId, local).length;
  const room = Math.min(140, cap - prefix.length - overhead);
  if (room < 16) return null;
  const headline = digestHeadline(row.text) || '[no sentence; read in full]';
  const text = prefix + frameInlineIfForeign(cut(headline, room), row.projectId, local);
  return {
    text,
    ...(!isForeignProject(row.projectId, local) && /^[dlcn]:[1-9]\d*$/.test(row.id)
      ? { id: row.id }
      : {}),
  };
}

function rowsSection(
  title: string,
  rows: readonly DigestRow[],
  cap: number,
  max: number,
  local: string | null,
  total = rows.length,
  week = false
): Section | null {
  if (!rows.length) return null;
  const selected = rows.slice(0, max);
  const heading = (shown: number): string =>
    `${title}:${total > shown ? ` (${shown} of ${total}${week ? ' this week' : ''})` : ''}`;
  // Reserve the longest count heading before sharing space equally across complete rows.
  const headingRoom = heading(0).length + String(selected.length).length;
  const perRow = Math.floor((cap - headingRoom - selected.length) / selected.length);
  const lines = selected
    .map((row) => rowLine(row, perRow, local))
    .filter((line): line is Line => !!line);
  if (!lines.length) return section([{ text: `${heading(0)}\nRead these records in full.` }]);
  return section([{ text: heading(lines.length) }, ...lines]);
}

function projectSection(model: DigestV2Model): Section {
  const step =
    (model.stepUp ? `\n${model.stepUp}` : '') +
    (model.legacyRecord
      ? `\nLegacy record: preview migration with ${remedyCommand()} migrate.`
      : '');
  const level = levelName(model.project.level);
  const title = `${cut(model.project.name.replace(/\s+/g, ' '), 70)} (${level})`;
  // s95-m06: a Ledger keeps no sprints, even after moving down from a level that had one, and a
  // Planner calls them cycles; only a Builder reads "no sprint" when none is open.
  const projectLevel = model.project.level;
  const sprint = projectLevel === 'ledger' ? null : model.sprint;
  if (!sprint) {
    const none = projectLevel === 'builder' ? `${title} — no sprint` : title;
    return section([{ text: `${cut(none, 250 - step.length)}${step}` }]);
  }
  const word = projectLevel === 'planner' ? 'Cycle' : 'Sprint';
  const prefix = `${title}\n${word} ${cut(sprint.id, 40)} [${sprint.status ?? 'unknown'}]: `;
  const body = `${sprint.title}${sprint.focus ? ` — ${sprint.focus}` : ''}`.replace(/\s+/g, ' ');
  const frameSize = frameInlineIfForeign('', sprint.projectId, model.localProjectId).length;
  const room = 250 - prefix.length - frameSize - step.length;
  if (room < 16)
    return section([
      {
        text: `${cut(`${title} — ${word.toLowerCase()} details available in Reasonbook`, 250 - step.length)}${step}`,
      },
    ]);
  return section([
    {
      text: `${prefix}${frameInlineIfForeign(cut(body, room), sprint.projectId, model.localProjectId)}${step}`,
    },
  ]);
}

/**
 * s96-m12: a shared record's conflicts, the states its checks find, the changes not live and who
 * started each mission in progress, within its cap and the room left; a short count when tight.
 */
function sharedSection(
  review: SharedRecordReview | null | undefined,
  room: number
): Section | null {
  if (!review) return null;
  const { conflicts, states, waiting, started } = review;
  const peers = review.peers ?? [];
  const moves = review.moves ?? [];
  if (
    !conflicts.length &&
    !states.length &&
    !waiting.length &&
    !started.length &&
    !peers.length &&
    !moves.length
  )
    return null;
  const cap = Math.min(SHARED_SECTION_CAP, room);
  const more = (list: readonly string[], shown: number) =>
    list.length > shown ? `; and ${list.length - shown} more` : '';
  const lines = ['Shared record:'];
  // s96-m13 (ADR s96 §8): a move this copy must confirm comes first; nothing else settles it.
  if (moves.length) lines.push(`  • Owner's copy: ${moves.join('; ')}.`);
  if (conflicts.length)
    lines.push(
      `  • ${conflicts.length} field(s) in conflict, so reads show a provisional value: ${conflicts.slice(0, 3).join('; ')}${more(conflicts, 3)}.`
    );
  if (states.length)
    lines.push(`  • ${states.length} state(s) need a person: ${states[0]}${more(states, 1)}`);
  if (waiting.length) lines.push(`  • Changes not live: ${waiting.join('; ')}.`);
  if (started.length) lines.push(`  • In progress: ${started.join('; ')}.`);
  // s96-m13 (design §s96-m13 item 5): each copy this one syncs with, its last exchange and errors.
  if (peers.length) lines.push(`  • Sync: ${peers.join('; ')}.`);
  // Only conflicts and the checks' states are listed and settled there; changes not live wait.
  const settle = conflicts.length || states.length;
  if (settle) lines.push('  List and settle them with rbook_db(action="conflicts").');
  const full = lines.map((line) => cut(line, 300)).join('\n');
  if (full.length <= cap) return section([{ text: full }]);
  const short = sharedShortForm(review);
  return short && short.length <= cap ? section([{ text: short }]) : null;
}

/**
 * s97-m14: the shared section's text, or its short form past the cap, for the review's structured
 * answer: Claude Code hands its model that answer, not this digest's text (the live test's join).
 */
export function sharedRecordText(review: SharedRecordReview | null | undefined): string | null {
  return sharedSection(review, SHARED_SECTION_CAP)?.text ?? null;
}

/** The shared section's short form, a count of each part it has, whose room the digest keeps. */
function sharedShortForm(review: SharedRecordReview | null | undefined): string | null {
  if (!review) return null;
  const { conflicts, states, waiting, waitingTotal, started } = review;
  const peers = review.peers ?? [];
  const moves = review.moves ?? [];
  if (
    !conflicts.length &&
    !states.length &&
    !waiting.length &&
    !started.length &&
    !peers.length &&
    !moves.length
  )
    return null;
  const settle = conflicts.length || states.length;
  const syncErrors = review.syncErrors ?? 0;
  const counts = [
    // s97-m14: a removal leads, so the short form never drops it (critics, round 1).
    review.removed ? "this copy's member was removed from the project" : '',
    review.movePending
      ? "a move of the owner's copy to confirm (reasonbook sync --confirm-owner)"
      : '',
    conflicts.length ? `${conflicts.length} field(s) in conflict` : '',
    states.length ? `${states.length} state(s) need a person` : '',
    waitingTotal ? `${waitingTotal} change(s) not live yet` : '',
    syncErrors ? `${syncErrors} sync error(s)` : '',
    !settle && !waitingTotal && !syncErrors && started.length
      ? `${started.length} mission(s) in progress`
      : '',
  ].filter(Boolean);
  if (!counts.length && moves.length) counts.push(`${moves.length} note(s) on the owner's copy`);
  if (!counts.length) counts.push(`${peers.length} copy(ies) syncing`);
  return `Shared record: ${counts.join(', ')}${settle ? '; rbook_db(action="conflicts")' : ''}.`;
}

/** The drafts' short form, which also sets the room the shared section leaves them (s96-m12). */
function draftsShortForm(drafts: readonly DigestDraft[], target: CliRemedyTarget): string {
  const short = `Pending drafts: ${drafts.length}. Read them: ${formatCliRemedy('drafts list', target)}.`;
  return short;
}

/**
 * The drafts section within its own cap and whatever room the rest of the digest leaves under
 * {@link DIGEST_V2_CAP}: a full store never makes the digest throw because drafts are pending.
 */
function draftsSection(
  drafts: readonly DigestDraft[],
  room: number,
  target: CliRemedyTarget
): Section | null {
  if (!drafts.length) return null;
  const cap = Math.min(DRAFTS_SECTION_CAP, room);
  const shown = drafts.slice(0, 3);
  const heading = `Pending drafts:${drafts.length > shown.length ? ` (${shown.length} of ${drafts.length})` : ''}`;
  const fixed = heading.length + 1 + DRAFTS_ASK.length + 1;
  const perLine = Math.floor((cap - fixed - shown.length) / shown.length);
  const lines: Line[] = [];
  for (const draft of shown) {
    const prefix = `  • P${draft.id} [${draft.kind}] `;
    const roomForText = Math.min(120, perLine - prefix.length);
    if (roomForText < 16) break;
    lines.push({ text: prefix + cut(digestHeadline(draft.text) || draft.text, roomForText) });
  }
  if (lines.length) return section([{ text: heading }, ...lines, { text: DRAFTS_ASK }]);
  const short = draftsShortForm(drafts, target);
  return short.length <= cap ? section([{ text: short }]) : null;
}

/** Empty sections vanish; all caps include headings, except the profile's approved text allowance. */
export function renderDigestV2(
  model: DigestV2Model,
  target: CliRemedyTarget = { projectRoot: process.cwd(), resolvedBy: 'cwd' }
): RenderedContext {
  const sections: Section[] = [projectSection(model)];
  if (model.profile?.text.trim()) {
    sections.push(
      section([
        {
          text:
            'Operator profile:\n' +
            (model.profile.overCap || model.profile.text.length > PROFILE_CAP_CHARS
              ? `Profile exceeds ${PROFILE_CAP_CHARS} characters; not injected. Read: ${remedyCommand()} profile show.`
              : model.profile.text),
        },
      ])
    );
  }
  const local = model.localProjectId;
  const decisionsAt = (cap: number) =>
    rowsSection(
      'Recent decisions',
      model.decisions.rows,
      cap,
      8,
      local,
      model.decisions.total,
      true
    );
  const recent = decisionsAt(1000);
  for (const value of [
    rowsSection('Rules in force', model.rules, 500, 4, local),
    recent,
    rowsSection(
      'Recent learnings',
      model.learnings.rows,
      350,
      3,
      local,
      model.learnings.total,
      true
    ),
    rowsSection('Open work', model.work, 400, 5, local),
  ])
    if (value) sections.push(value);
  const tail: Section[] = [];
  if (model.feedback) tail.push(section([{ text: model.feedback }]));
  tail.push(section([{ text: DIGEST_POINTER }]));
  const room = (): number =>
    DIGEST_V2_CAP -
    [...sections, ...tail].reduce((sum, part, i) => sum + part.text.length + (i ? 2 : 0), 0) -
    2;
  // s96-m12: pending drafts keep room for their short form, since the operator's answer needs them.
  const draftsReserve = model.drafts?.length ? draftsShortForm(model.drafts, target).length + 2 : 0;
  // On a shared copy the shared record's short form keeps its room too: the recent decisions give up
  // what the two need, since rbook_review's answer carries no shared-record notice of its own.
  const sharedShort = sharedShortForm(model.shared);
  const owed = sharedShort ? sharedShort.length + draftsReserve - room() : 0;
  const at = recent ? sections.indexOf(recent) : -1;
  if (owed > 0 && recent && at >= 0) {
    const smaller = decisionsAt(recent.text.length - owed);
    if (smaller && smaller.text.length < recent.text.length) sections[at] = smaller;
  }
  const shared = sharedSection(model.shared, room() - draftsReserve);
  if (shared) sections.splice(1, 0, shared);
  const drafts = draftsSection(model.drafts ?? [], room(), target);
  if (drafts) sections.push(drafts);
  sections.push(...tail);
  let text = '';
  const items: Array<{ typedId: string; start: number; end: number }> = [];
  for (const part of sections) {
    if (text) text += '\n\n';
    const offset = text.length;
    text += part.text;
    items.push(
      ...part.items.map((item) => ({ ...item, start: item.start + offset, end: item.end + offset }))
    );
  }
  // Feedback uses the reserved 100-character inbox allocation. Future sections must allocate their own
  // room rather than rely on the hook's looser 6,000-character emergency cap.
  if (text.length > DIGEST_V2_CAP) throw new Error('Digest exceeds its 4000-character allocation.');
  return { text, items, returnedIds: [...new Set(items.map((item) => item.typedId))] };
}

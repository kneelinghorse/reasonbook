// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Render the same small, stable local context for session hooks, CLI review and MCP review.
// ABOUTME: Preserve complete profiles, provenance fences and typed item spans within explicit section caps.

import { formatCliRemedy, remedyCommand, type CliRemedyTarget } from '../../utils/cli-remedy';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import type { OperatorProfile } from './operator-profile';
import {
  cut,
  digestHeadline,
  section,
  rowLine,
  rowsSection,
  type Line,
  type Section,
} from './digest-format';
export { digestHeadline } from './digest-format';
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
  readonly emptyRecord?: boolean;
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
  readonly nextSteps?: { readonly rows: readonly DigestRow[]; readonly total: number };
  /** s108-m02: open next steps waiting until a date, which the work rows leave out. */
  readonly waitingSteps?: number;
  /** s108-m03: Deferred missions whose current date has come: how many, and the earliest's id and day. */
  readonly dueMissions?: {
    readonly count: number;
    readonly first: string;
    readonly name: string;
    readonly since: string;
  };
  /** s93-m06: pending, unexpired drafts awaiting the operator, oldest first. */
  readonly drafts?: readonly DigestDraft[];
  readonly feedback?: string | null;
  readonly dashboardUpload?: string | null;
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
  'Full decisions: rbook_decisions; learnings: rbook_learnings; search: rbook_context. The operator’s call: end with Would record: <decision>.';
export const DRAFTS_SECTION_CAP = 450;
/** s96-m12: the shared record's section, which takes its room before the drafts do. */
export const SHARED_SECTION_CAP = 600;
/** s109-m02: with the settle line, taught with both its clauses (settled item 1). */
export const DRAFTS_ASK =
  'Name each as "draft P<n>" with its subject; record approval with fromDraft. If a recorded decision already answered one, write "Settled: P<n> by decision <N>" above any Would record lines, naming the draft only in that line.';

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
  if (review.directory) {
    const text = sharedShortForm(review)!;
    return text.length <= Math.min(SHARED_SECTION_CAP, room) ? section([{ text }]) : null;
  }
  const { conflicts, states, waiting, started } = review;
  const peers = review.peers ?? [];
  const moves = review.moves ?? [];
  if (
    !conflicts.length &&
    !states.length &&
    !waiting.length &&
    !started.length &&
    !peers.length &&
    !moves.length &&
    !review.recoveryConditions?.length &&
    !review.upgrade &&
    !review.protocol
  )
    return null;
  const cap = Math.min(SHARED_SECTION_CAP, room);
  const more = (list: readonly string[], shown: number) =>
    list.length > shown ? `; and ${list.length - shown} more` : '';
  const lines = ['Shared record:'];
  // s96-m13 (ADR s96 §8): a move this copy must confirm comes first; nothing else settles it.
  if (moves.length) lines.push(`  • Owner's copy: ${moves.join('; ')}.`);
  // s100-m01: then an upgrade this copy needs, which only its own operator can make.
  if (review.upgrade) lines.push(`  • This copy: ${review.upgrade}.`);
  if (review.protocol) lines.push(`  • ${review.protocol.summary}.`);
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
  if (review.directory)
    return `Local shared record: ${review.conflicts.length} field(s) in conflict; ${review.states.length} state(s) need a person; ${review.waitingTotal} stored change(s) not live. Changes beyond this copy are not checked. Use the full plugin to inspect and resolve shared-record issues.`;
  const { conflicts, states, waiting, waitingTotal, started } = review;
  const peers = review.peers ?? [];
  const moves = review.moves ?? [];
  if (
    !conflicts.length &&
    !states.length &&
    !waiting.length &&
    !started.length &&
    !peers.length &&
    !moves.length &&
    !review.recoveryConditions?.length &&
    !review.upgrade &&
    !review.protocol
  )
    return null;
  const settle = conflicts.length || states.length;
  const syncErrors = review.syncErrors ?? 0;
  const waitingDetail = Object.entries(review.waitingCounts ?? {})
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
  const moveNotice = review.recoveryConditions?.length
    ? `recovery held: ${review.recoveryConditions.join(', ')}; ask owner; fix invalid chains first`
    : "a move of the owner's copy to confirm";
  const protocol = review.protocol;
  const protocolNotice =
    protocol?.writeProtocol === 2
      ? 'record protocol 2: switched; downgrades may rename ids and hold streams' +
        (protocol.stranded.length ? `; ${protocol.stranded.length} stranded copies` : '')
      : protocol?.writeProtocol === 1
        ? `record protocol 1: not switched; ${protocol.blockers.length} blocking copies`
        : (protocol?.summary ?? '');
  const counts = [
    // s97-m14: a removal leads, so the short form never drops it (critics, round 1).
    review.removed ? "this copy's member was removed from the project" : '',
    // s100-m01: what a newer record protocol keeps out waits for this copy's upgrade.
    review.upgrade ? 'newer record protocol waits for an upgrade here' : '',
    protocolNotice,
    review.movePending || review.recoveryConditions?.length
      ? `${moveNotice} (reasonbook sync --confirm-owner)`
      : '',
    conflicts.length ? `${conflicts.length} field(s) in conflict` : '',
    states.length ? `${states.length} state(s) need a person` : '',
    waitingTotal
      ? `${waitingTotal} change(s) not live yet${waitingDetail ? ` (${waitingDetail})` : ''}`
      : '',
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

/** s108-m02: how many next steps wait until a date, which the rows above leave out. */
function waitingLine(count: number | undefined): Line[] {
  if (!count) return [];
  return [{ text: `  ${count} more next step${count === 1 ? ' waits' : 's wait'} until a date.` }];
}

/**
 * s108-m03: Deferred missions whose date has come, on a line of their own after the waiting line:
 * how many, and the earliest by its id and day, or for Planner as a task by its name. No row's text
 * is cut in it, so the count and day stay whole. A Ledger keeps no missions, so it has none.
 */
function dueLine(due: DigestV2Model['dueMissions'], level: ProjectLevel): Line[] {
  if (!due || level === 'ledger') return [];
  const [one, many, first] =
    level === 'planner'
      ? ['task', 'tasks', cut(due.name.replace(/\s+/g, ' ').trim(), 48)]
      : ['mission', 'missions', cut(due.first, 48)];
  return [
    {
      text:
        due.count === 1
          ? `  1 deferred ${one} is due: ${first}, since ${due.since}.`
          : `  ${due.count} deferred ${many} are due; the first, ${first}, since ${due.since}.`,
    },
  ];
}

/** Builder keeps its mission and next steps inside one 400-character section. */
function openWork(model: DigestV2Model): Section | null {
  const next = model.nextSteps;
  const waiting = waitingLine(model.waitingSteps);
  // s108-m03: the waiting line, then the due line, close the section, counted inside its 400.
  const due = dueLine(model.dueMissions, model.project.level);
  const tail = [...waiting, ...due];
  if (!next?.rows.length) {
    // The rows get m02's room unless the lines after them would then pass 400; then they share
    // what those lines leave, which keeps Ledger's and Planner's five rows inside the cap.
    const reserved = tail.reduce((sum, line) => sum + line.text.length + 1, 0);
    const listed = (room: number) =>
      rowsSection('Open work', model.work, room, 5, model.localProjectId);
    let rows = listed(400);
    if (rows && rows.text.length + reserved > 400) rows = listed(400 - reserved);
    if (!tail.length) return rows;
    return rows
      ? { text: [rows.text, ...tail.map((line) => line.text)].join('\n'), items: rows.items }
      : section([{ text: 'Open work:' }, ...tail]);
  }
  const open: Line = { text: 'Open work:' };
  const selected = next.rows.slice(0, 3);
  const heading = (count: number): Line => ({ text: `Next steps (${count} of ${next.total}):` });
  // The mission receives the room left after three bounded next-step lines, including IDs.
  const stepLines = selected
    .map((row) => rowLine(row, 100, model.localProjectId))
    .filter((line): line is Line => !!line);
  const fixed = section([open, heading(selected.length), ...stepLines, ...waiting]).text.length;
  let mission =
    (model.work[0] && rowLine(model.work[0], 400 - fixed - 1, model.localProjectId)) || null;
  // The heading stays even when every step line has given way, so the count of open steps does.
  const render = (steps: readonly Line[], missionLine: Line | null): Section =>
    section([
      open,
      ...(missionLine ? [missionLine] : []),
      heading(steps.length),
      ...steps,
      ...tail,
    ]);
  // s108-m03: the mission keeps that room. The due line takes the room of the last next steps it
  // needs, down to one, so the section still shows that steps are open.
  let steps = stepLines;
  while (due.length && steps.length > 1 && render(steps, mission).text.length > 400)
    steps = steps.slice(0, -1);
  if (mission && render(steps, mission).text.length > 400) {
    // Then the mission's line takes the room the rest leaves; only if even that cannot render, as
    // with a very long project id, does the last step line give way too, its heading staying, and
    // m02's own line returns if it then fits.
    const m02Line = mission;
    const refit = (rest: readonly Line[]) =>
      rowLine(model.work[0], 400 - render(rest, null).text.length - 1, model.localProjectId);
    mission = refit(steps);
    if (!mission && steps.length) {
      // The step line goes only when a mission line takes its place.
      const fitted = render([], m02Line).text.length <= 400 ? m02Line : refit([]);
      if (fitted) {
        steps = [];
        mission = fitted;
      } else {
        // No mission line fits at all: the steps it was given way for come back, as many as fit.
        steps = stepLines;
        while (steps.length > 1 && render(steps, null).text.length > 400)
          steps = steps.slice(0, -1);
      }
    }
  }
  return render(steps, mission);
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
  const hasSteps =
    !!model.nextSteps?.rows.length || model.work.some((row) => row.id.startsWith('n:'));
  const decisionsAt = (cap: number) =>
    rowsSection(
      'Recent decisions',
      model.decisions.rows,
      cap,
      hasSteps ? 6 : 8,
      local,
      model.decisions.total,
      true
    );
  const recent = decisionsAt(
    (hasSteps ? 750 : 1000) - (model.dashboardUpload ? model.dashboardUpload.length + 2 : 0)
  );
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
    openWork(model),
  ])
    if (value) sections.push(value);
  const tail: Section[] = [];
  if (model.dashboardUpload) tail.push(section([{ text: model.dashboardUpload }]));
  if (model.feedback) tail.push(section([{ text: model.feedback }]));
  tail.push(
    section([
      {
        text: model.emptyRecord
          ? 'No decisions or learnings recorded yet. Begin with the project goal and the first choice to keep. The operator’s call: end with Would record: <decision>.'
          : DIGEST_POINTER,
      },
    ])
  );
  const room = (): number =>
    DIGEST_V2_CAP -
    [...sections, ...tail].reduce((sum, part, i) => sum + part.text.length + (i ? 2 : 0), 0) -
    2;
  // s96-m12: pending drafts keep room for their short form, since the operator's answer needs them.
  const draftsReserve = model.drafts?.length ? draftsShortForm(model.drafts, target).length + 2 : 0;
  // On a shared copy the shared record's short form keeps its room too: the recent decisions give up
  // what the two need, since rbook_review's answer carries no shared-record notice of its own.
  const sharedShort = sharedShortForm(model.shared);
  const owed = (sharedShort?.length ?? 0) + draftsReserve - room();
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
  // Upload notices borrow decision room; feedback retains its reserved 100-character allocation.
  if (text.length > DIGEST_V2_CAP) throw new Error('Digest exceeds its 4000-character allocation.');
  return { text, items, returnedIds: [...new Set(items.map((item) => item.typedId))] };
}

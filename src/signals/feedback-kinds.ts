// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The feedback kinds (s97-m07): published, deterministic rules that sort an agent_feedback row into a
// ABOUTME: kind of friction with Reasonbook by its text, or leave it unclassified. The fleet view and the signals count them.

/**
 * WHY RULES. 884 agent_feedback rows sit in 21 of this Mac's registered stores (2026-10-20), 782 of
 * them open, and the October study's hand labels did not survive. A count by kind is only
 * worth showing if anyone can recompute it, so a row's kind comes from these published rules alone:
 * the same text always gets the same kind, on this client and in any host using this library at ingest.
 *
 * HOW A ROW IS SORTED.
 *   0. Read only the first 4,000 UTF-16 code units, bounding work on historical uncapped rows.
 *   1. A row that names Reasonbook nowhere ({@link REASONBOOK_NAMED}: `reasonbook`, `rbook`, `cmos`,
 *      or one of their tools) is unclassified: about half the rows are about the project's own
 *      code, plans or tools, and only words that name Reasonbook keep those out.
 *   2. Otherwise the first rule in {@link FEEDBACK_KIND_RULES} whose pattern matches the text
 *      decides the kind. The order is precedence: a row about a stale binary also names
 *      projectRoot, and a supersession complaint often also gives a payload size, so the narrow
 *      rules come first.
 *   3. A row no rule matches, or whose first match is a folded kind's rule, is unclassified.
 *      Unclassified is reported beside the kinds, so a rule set that misses friction reads as a
 *      large unclassified count, never as a false zero.
 *
 * The tool name decides nothing: it is where the row was submitted, not what it is about (672 of
 * the 884 rows came in through mission completion), so no rule reads it.
 *
 * WHAT A KIND MEANS. The kinds are the fleet-friction study's categories
 * (rbook/research/2026-10-strategy/fleet-friction.md §3), named for what they are: A ceremony,
 * E surfacing, F identity, G sync and H payload. C (docs drift) has no rule, so it is not a kind;
 * its rows read as unclassified. The study's project content (K.domain, K.plan-quality) is never a
 * kind.
 *
 * PRECISION. A kind is counted only when its precision is 0.9 or more against labels a separate
 * agent gave a seeded sample without seeing these rules. The rules were frozen before the labels
 * were scored (2026-10-20, 157 rows, a rule's kind correct when the labeller gave it as primary or
 * as another kind that applies): ceremony 18/20, surfacing 19/20, identity 19/20, sync 20/20,
 * payload 20/20. Two kinds fell short and are folded ({@link FOLDED_FEEDBACK_KINDS}): setup 8/20,
 * whose stale-binary rows the labeller read as tool defects, since their text names only the
 * failure, and silent-loss 5/7. A folded kind's rules keep their place, so its rows read as
 * unclassified rather than reaching a later rule whose precision never covered them, and a folded
 * kind is never tuned against the same labels. The measurement, the sample and the coverage are in
 * rbook/research/2026-10-s100-build/README.md (s97-m07).
 */

/** A kind of friction with Reasonbook that the signals count, by the study's category letter. */
export type FeedbackKind = 'ceremony' | 'surfacing' | 'identity' | 'sync' | 'payload';

/**
 * Kinds measured below precision 0.9 (setup 8/20, silent-loss 5/7). Their rules still match in
 * their place, and a row they claim reads as unclassified.
 */
export const FOLDED_FEEDBACK_KINDS = ['setup', 'silent-loss'] as const;
export type FoldedFeedbackKind = (typeof FOLDED_FEEDBACK_KINDS)[number];

export interface FeedbackKindInfo {
  readonly kind: FeedbackKind;
  /** The fleet-friction study's category letter. */
  readonly letter: 'A' | 'E' | 'F' | 'G' | 'H';
  readonly meaning: string;
}

/** The kinds, in the study's letter order. */
export const FEEDBACK_KINDS: readonly FeedbackKindInfo[] = [
  {
    kind: 'ceremony',
    letter: 'A',
    meaning: 'lifecycle machinery that costs work, warns falsely or blocks',
  },
  {
    kind: 'surfacing',
    letter: 'E',
    meaning: 'noisy, stale or misordered suggestions, next actions and counts',
  },
  {
    kind: 'identity',
    letter: 'F',
    meaning: 'the wrong project resolved, or every project walked when one was meant',
  },
  { kind: 'sync', letter: 'G', meaning: 'messages between projects and hosted connectors' },
  { kind: 'payload', letter: 'H', meaning: 'an answer too large, repeated or costly to read' },
];

export interface FeedbackKindRule {
  /** `<kind>.<pain>`: the pain a rule groups is a triage cluster. */
  readonly id: string;
  readonly kind: FeedbackKind | FoldedFeedbackKind;
  readonly pattern: RegExp;
}

/** A row names Reasonbook: its names, old and new, or one of their tools. */
export const REASONBOOK_NAMED = /\b(?:cmos|rbook|reasonbook)\b|\b(?:cmos|rbook)_[a-z_]+/i;

/**
 * The rules, in precedence order. Case-insensitive and never global, so stateless.
 * A lookahead captures the first required token after a period; its backreference commits that
 * prefix before the next search. Without that commitment, repeated starts retry the same suffix
 * quadratically (or cubically with two gaps). The 4,000 bounds preserve matches within the input
 * cap. Direct pattern tests on longer text can ignore tokens beyond a bounded lookahead span.
 */
export const FEEDBACK_KIND_RULES: readonly FeedbackKindRule[] = [
  {
    id: 'setup.stale-binary',
    kind: 'setup',
    pattern:
      /NOT NULL constraint(?: failed)?:?[^.]{0,40}\b(?:sessions|sprints)\.project_id|\b(?:sessions|sprints)\.project_id NOT NULL|stale (?:cmos-mcp )?(?:binary|runtime)|retired cmos-mcp runtime|version skew/i,
  },
  {
    id: 'surfacing.supersession-noise',
    kind: 'surfacing',
    pattern:
      /supersession (?:detect(?:or|ion)|candidates?|offers?|heuristic|signal|suggestions?|hints?)|suggest(?:s|ed)? (?:superseding|that [^.]{0,60}supersedes)|propos(?:es|ed|ing) (?:superseding|supersession)|proposed as superseded|(?:offered|proposed) [^.]{0,40}as superseding|(?:^|\.)(?=([^.]{0,4000}?supersed))\1[^.]*\b(?:false[- ]positives?|keyword overlap|shared (?:rare )?(?:terms|vocabulary)|too eager)\b/i,
  },
  {
    id: 'payload.oversized-answer',
    kind: 'payload',
    pattern:
      /(?:^|\.)(?=([^.]{0,4000}?\b\d{1,4000}(?:\.\d{1,4000})?\s?(?:KB|kB|MB)\b))\1[^.]*\b(?:payload|response|returned|answer|cap|overflow)|(?:^|\.)(?=([^.]{0,4000}?\b(?:payload|response|returned|answer)))\2[^.]*\b\d{1,4000}(?:\.\d{1,4000})?\s?(?:KB|kB|MB)\b|token cap|tool-result (?:token )?(?:cap|limit)|token limit|jq'?d (?:it )?(?:off|from)|spilled to (?:a )?file|exceed(?:s|ed|ing)? the (?:MCP )?(?:tool-result )?(?:token )?cap|\b\d{2,3},\d{3} char(?:acter)?s\b/i,
  },
  {
    id: 'payload.repeated-focus',
    kind: 'payload',
    pattern:
      /(?:^|\.)(?=([^.]{0,4000}?\bfocus\b))\1[^.]*\b(?:every|each) (?:queued )?mission|repeats? the (?:full )?sprint/i,
  },
  {
    id: 'identity.fan-out',
    kind: 'identity',
    pattern:
      /MISSION_NOT_FOUND|not-found stubs|fan[- ]?(?:s )?out|walk(?:s|ed)? (?:the )?(?:whole |entire |every )?(?:project )?(?:registry|registered)|(?:every|all|each) (?:registered |sibling )?project(?:'s)? (?:root|DB|queue|store)s?|sibling project (?:roots|DBs)|one entry per (?:registered )?project|multi-project (?:response|resolution)|across \d+ (?:registered |portfolio )?project|iterate over all sibling/i,
  },
  {
    id: 'identity.scope',
    kind: 'identity',
    pattern:
      /(?:had to|must|need(?:ed)? to) pass (?:an )?(?:explicit )?projectRoot|projectRoot (?:filter|explicitly)|without (?:an )?explicit projectRoot|scop(?:e|ed|ing) to (?:the )?cwd|default(?:ing)? to (?:the )?cwd|current project only/i,
  },
  {
    // Before silent loss: a message send that says it worked and returns no id is a messaging defect first.
    id: 'sync.messaging',
    kind: 'sync',
    pattern:
      /(?:^|\.)(?=([^.]{0,4000}?(?:cmos|rbook)_message))\1[^.]*\b(?:respond|reply|replies|ack|thread|undefined|refuses|rejects|fails?)\b|\bID: undefined\b|already been responded to/i,
  },
  {
    id: 'silent-loss.false-success',
    kind: 'silent-loss',
    pattern:
      /silently (?:ignores|ignored|drops|dropped|discards|absorbed|returned zero)|(?:^|\.)(?=([^.]{0,4000}?returns? success(?::\s?true)?))\1[^.]*\b(?:without|but|no)\b|No changes needed|reported success but/i,
  },
  {
    id: 'ceremony.no-decisions-warning',
    kind: 'ceremony',
    pattern:
      /no (?:strategic )?(?:decisions?|learnings?)(?: or learnings| \/ learnings|\/learnings)? (?:were )?(?:captured|recorded)|decisionCount/i,
  },
  {
    id: 'ceremony.capture-coupled',
    kind: 'ceremony',
    pattern:
      /has no `?(?:add|record|create)`? action|no (?:learning|decision)[- ]CREATE|no supported way to (?:mint|create|record)|(?:cmos|rbook)_learnings has (?:only )?list/i,
  },
  {
    id: 'ceremony.session-required',
    kind: 'ceremony',
    pattern:
      /requires? an active session|no active session|(?:must|had to|have to|needs? to) (?:call )?(?:cmos_|rbook_)?session[ (]*(?:action=)?['"]?start/i,
  },
  {
    id: 'ceremony.build-freshness',
    kind: 'ceremony',
    pattern:
      /BUILD_STALE|build[- ]freshness|buildFreshness|build output is behind|freshness (?:warning|nag|gate|probe)/i,
  },
  {
    id: 'ceremony.close-archival',
    kind: 'ceremony',
    pattern:
      /(?:sprint|close|closeout)[^.]{0,80}archiv(?:es|ed|ing)[^.]{0,80}\b(?:decisions?|learnings?)\b|archiv(?:es|ed|ing) (?:every|all)[^.]{0,40}\b(?:decisions?|learnings?)\b/i,
  },
  {
    id: 'ceremony.state-machine',
    kind: 'ceremony',
    pattern:
      /(?:Blocked|Queued)\s?(?:→|->|to)\s?(?:Completed|Blocked)|(?:only allows|refuses|rejected) (?:the )?(?:target )?(?:status|transition)|forward-only state/i,
  },
  {
    id: 'surfacing.next-action-order',
    kind: 'surfacing',
    pattern:
      /(?:^|\.)(?=([^.]{0,4000}?(?:next ?action|nextAction|next_actions|recommend(?:s|ed)?|picks?|suggested)))\1[^.]*\b(?:alphabetic\w{0,4000}|by id|first queued|despite|although|even though|prerequisite|dependenc\w{0,4000}|Requires|above the actual|buried)\b/i,
  },
  { id: 'setup.schema-mismatch', kind: 'setup', pattern: /DB_SCHEMA_MISMATCH|schema mismatch/i },
  {
    id: 'ceremony.current-sprint',
    kind: 'ceremony',
    pattern:
      /reports? activeSprint as|activeSprint as sprint|current sprint "by fallback"|demotes the other (?:open |Active )?sprint|shown as (?:the )?current sprint|placeholder sprints?/i,
  },
  {
    id: 'ceremony.next-step-lifecycle',
    kind: 'ceremony',
    pattern:
      /auto-?complet(?:es|ed|ing) (?:PENDING |pending )?next[- ]steps|wrongly auto-completed|carry with a nonexistent carryToSprint|lease (?:dropped|drops)|dropped \d+ (?:freshly )?carried/i,
  },
  {
    id: 'surfacing.stale-counts',
    kind: 'surfacing',
    pattern:
      /\bundercount(?:s|ed)?\b|showed Queued:?\s?\d+ while|capped at \d{1,4000} while \d{1,4000} were/i,
  },
  {
    id: 'sync.hosted-wrapper',
    kind: 'sync',
    pattern:
      /(?:^|\.)(?=([^.]{0,4000}?(?:Aquex|hosted|codex_apps)))\1(?=([^.]{0,4000}?\b(?:connector|wrapper|endpoint)s?\b))\2[^.]*\b(?:404|502|failed|failing|error)|(?:^|\.)(?=([^.]{0,4000}?\b(?:404|502)s?\b))\3[^.]*\b(?:connector|wrapper|endpoint)\b|Dashboard 404|sync health unavailable/i,
  },
];

/** Published beside every count by kind. */
export const FEEDBACK_KINDS_RULE =
  "a row's kind is that of the first rule in FEEDBACK_KIND_RULES whose pattern matches the first 4,000 UTF-16 code units of its text, " +
  'among rows that name Reasonbook (reasonbook, rbook, cmos or one of their tools); a row that names ' +
  "it nowhere, that no rule matches, or whose first rule is a folded kind's, is unclassified; the " +
  'tool name decides nothing';

export interface FeedbackClassification {
  readonly kind: FeedbackKind | 'unclassified';
  /** The rule that decided it, or null when unclassified. */
  readonly rule: string | null;
}

const UNCLASSIFIED: FeedbackClassification = { kind: 'unclassified', rule: null };

/** The kind of one row's text. Deterministic: no clock, no state, no I/O. */
export function classifyFeedback(text: string | null | undefined): FeedbackClassification {
  const body = typeof text === 'string' ? text.slice(0, 4000) : '';
  if (!REASONBOOK_NAMED.test(body)) return UNCLASSIFIED;
  for (const rule of FEEDBACK_KIND_RULES) {
    if (!rule.pattern.test(body)) continue;
    return isFolded(rule.kind) ? UNCLASSIFIED : { kind: rule.kind, rule: rule.id };
  }
  return UNCLASSIFIED;
}

function isFolded(kind: FeedbackKind | FoldedFeedbackKind): kind is FoldedFeedbackKind {
  return (FOLDED_FEEDBACK_KINDS as readonly string[]).includes(kind);
}

export interface FeedbackKindCounts {
  /** Every kind, zero included, in FEEDBACK_KINDS order. */
  readonly counts: Readonly<Record<FeedbackKind, number>>;
  readonly unclassified: number;
}

/** Counts by kind over many rows' texts; every kind is present, so a zero is a measured zero. */
export function countFeedbackKinds(texts: Iterable<string | null | undefined>): FeedbackKindCounts {
  const counts = Object.fromEntries(FEEDBACK_KINDS.map(({ kind }) => [kind, 0])) as Record<
    FeedbackKind,
    number
  >;
  let unclassified = 0;
  for (const text of texts) {
    const { kind } = classifyFeedback(text);
    if (kind === 'unclassified') unclassified += 1;
    else counts[kind] += 1;
  }
  return { counts, unclassified };
}

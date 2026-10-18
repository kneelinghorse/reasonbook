// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fail-closed read/write action taxonomy for the Reasonbook tool surface (Sprint 78 m04).
// ABOUTME: classifyAction(tool, action) => 'read' | 'write'; unknown tools/actions default to 'write'.

export type ActionMode = 'read' | 'write';

/**
 * Tools that take NO `action` parameter and are entirely read-only digests /
 * diagnostics. Every call to one of these is a read.
 *
 * `rbook_agent_onboard` is deliberately NOT here (s78-m04 adversarial review): it records an
 * `agentFeedback` row when one is passed (INSERT INTO agent_feedback), and as a write-classified
 * call its sender resolution may repair a `rbook://unknown/*` address and seed a missing
 * project_identity row (lazy repairs: asLazyRepair). It is therefore write-classified and blocked
 * under review; a review agent uses `rbook_review` (a genuine read digest) for cold-start context
 * instead. Onboard makes no status write and never starts first-write upkeep (s93-m11, fork 4).
 *
 * `rbook_review` and `rbook_status` are admitted as read-classified entry points. s93-m11: every
 * read-classified call is write-free in the store, under any role — no status, owner, address,
 * identity or schema-label write, and a migration a read runs is DDL plus filling what it created
 * (decision #1182; tests/tools/rbook/reads-never-write.test.ts runs every pair below). `rbook_review`
 * may still touch an EXISTING per-user graph row's `last_seen_at` outside the review role (#906);
 * the review role suppresses that, and s88-m08 suppresses project-identity mint/registration for
 * every read-classified call.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['rbook_review', 'rbook_status']);

/**
 * Per-tool allowlist of read-only ACTIONS for the action-bearing tools.
 *
 * FAIL-CLOSED CONTRACT: an action is 'read' ONLY if it is listed here. Everything
 * else is 'write' — unknown tools, unknown/new actions, and every action of a tool
 * absent from this map. When a tool gains a new action it defaults to 'write' until
 * deliberately promoted here (the taxonomy-drift test guards that every shipped
 * action is covered and that this map contains no stale/typo entries).
 *
 * SECURITY BIAS: misclassifying a write as a read is a data-loss vulnerability;
 * misclassifying a read as a write only over-restricts a review agent. So only
 * UNAMBIGUOUS pure reads are listed. Deliberately WRITE (i.e. NOT listed) despite
 * looking read-ish:
 *   - rbook_context next_steps / constraints — sub-dispatchers that route to a
 *     nested read-OR-write sub-action; the top-level action can't prove read-only.
 *   - rbook_db identify_orphans — a sync diagnostic that can enqueue work.
 *   - rbook_sprint retro / analytics — report generators that may persist; promote here with
 *     per-handler proof if a reviewer needs them. (s93-m11 promoted rbook_decisions review, the
 *     remedy the opener names for records past the review age, with the reads-never-write oracle
 *     as its proof.)
 *   - rbook_project validate — carries a mutating `prune` option.
 *
 * NOTE: this is the s78 read/write SECURITY gate (fail-closed dispatch guard for
 * review agents). It is a DIFFERENT concept from the former client.ts
 * `isReadAction`/`READ_ACTIONS` fan-out-eligibility set — which was deleted in
 * s79-m04 along with the whole per-handler fan-out model (portfolio reads now go
 * through `acrossProjects=true` + the graph-backed `queryAcrossStores`).
 */
export const READ_ONLY_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  rbook_context: ['view', 'history', 'search'],
  rbook_db: ['health', 'conflicts'],
  rbook_decisions: ['list', 'search', 'show', 'review'],
  rbook_feedback: ['list'],
  rbook_learnings: ['list', 'search', 'show'],
  rbook_mission: ['list', 'show', 'status'],
  rbook_mission_transition: [],
  rbook_project: ['list', 'members'],
  rbook_session: ['list', 'search'],
  rbook_sprint: ['list', 'show'],
  rbook_auth: ['list'],
  rbook_message: ['list', 'directory', 'whoami'],
};

/**
 * Classify a (toolName, action) pair. Returns 'read' ONLY for an action-less
 * read tool, or an action explicitly allowlisted for its tool. Everything else —
 * unknown tool, action-bearing tool called with no action, or any non-allowlisted
 * action — is 'write' (fail closed).
 */
export function classifyAction(toolName: string, action: string | undefined): ActionMode {
  if (READ_ONLY_TOOLS.has(toolName)) return 'read';
  const reads = READ_ONLY_ACTIONS[toolName];
  if (reads === undefined) return 'write'; // unknown tool → fail closed
  if (action === undefined) return 'write'; // action-bearing tool with no action → fail closed
  return reads.includes(action) ? 'read' : 'write';
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Audits action effects separately from the security read/write access taxonomy.
// ABOUTME: Derives conservative MCP annotations from action effects and common wire behavior.

import type { ActionMode } from './action-taxonomy';

/**
 * Rule: https://developers.openai.com/plugins/plugin-guidelines#correct-annotation
 * A read-only hint excludes ALL state changes, including bookkeeping. Overwrites (statuses
 * included), deletion, access revocation and sends are destructive even when undo is possible.
 * Other-project messaging and a shared record's writes to a copy on another machine, over SSH, are
 * open-world; the user's own dashboard account is bounded.
 * Nothing except an effect-free action is claimed idempotent by this table.
 *
 * `none` means no action-owned store/registry mutation on a prepared schema, not no wire effects.
 * Reads can create missing schema; write-classified opens can register/repair identity, and
 * successful writes can run first-write upkeep. These shared behaviors belong to bookkeeping.
 * The security mode stays governed by action-taxonomy.ts, equality-tested against these rows.
 * It protects project records; it never promised telemetry-free MCP calls.
 *
 * Every real MCP call appends telemetry and may delete expired monthly telemetry files
 * (telemetry-call.ts, local-telemetry.ts). Resolution observes opened projects and may schedule
 * already-owed uploads to the user's account (dashboard-upload-scheduler.ts). Hence every
 * current wire tool is non-read-only, destructive and non-idempotent. Auto approval may prompt
 * for every tool; these hints claim neither fewer prompts nor a passed directory review.
 */
export type ToolEffect =
  | 'none'
  | 'bookkeeping'
  | 'local-write'
  | 'dashboard-write'
  | 'overwrite'
  | 'delete'
  | 'access-revocation'
  | 'message'
  /** s96-m13: writes a copy of the shared record on another machine, over SSH. */
  | 'remote-write';

export interface ActionEffects {
  readonly mode: ActionMode;
  readonly effects: readonly ToolEffect[];
}

export interface ToolEffects {
  readonly title: string;
  /** Empty action names represent tools that have no action discriminator. */
  readonly actions: Readonly<Record<string, ActionEffects>>;
}

export interface EffectAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Possible shared effects, not a claim that every call uploads or expires a log. */
export const COMMON_WIRE_EFFECTS: readonly ToolEffect[] = [
  'bookkeeping',
  'local-write', // one telemetry append, even for a refused call
  'delete', // expiration of old telemetry months
  'dashboard-write', // a configured upload can follow project resolution
];

const read: ActionEffects = { mode: 'read', effects: ['none'] };
const write = (...effects: ToolEffect[]): ActionEffects => ({ mode: 'write', effects });

/** Explicit action inventory: missing/new/stale rows fail the published-schema equality test. */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffects>> = {
  rbook_mission: {
    title: 'Missions',
    actions: {
      list: read,
      show: read,
      status: read,
      add: write('local-write'),
      update: write('local-write', 'overwrite'), // field values have no retained preimage
      move: write('local-write', 'overwrite'),
      depends: write('local-write'),
      undepends: write('local-write', 'delete'),
    },
  },
  rbook_mission_transition: {
    title: 'Mission transitions',
    actions: {
      start: write('local-write', 'overwrite', 'dashboard-write'),
      complete: write('local-write', 'overwrite', 'dashboard-write'),
      block: write('local-write', 'overwrite', 'dashboard-write'),
      unblock: write('local-write', 'overwrite', 'dashboard-write'),
      drop: write('local-write', 'overwrite', 'dashboard-write'),
      defer: write('local-write', 'overwrite', 'dashboard-write'),
      reopen: write('local-write', 'overwrite', 'dashboard-write'),
    },
  },
  rbook_sprint: {
    title: 'Sprints',
    actions: {
      list: read,
      show: read,
      add: write('local-write', 'overwrite'), // activating one demotes other active sprints
      update: write('local-write', 'overwrite', 'dashboard-write'),
      complete: write('local-write', 'overwrite', 'delete', 'dashboard-write'), // backup retention
      retro: write('bookkeeping'), // write-classified client opens can register/repair identity
      carry_forward: write('bookkeeping', 'message'),
      analytics: write('bookkeeping'),
    },
  },
  rbook_context: {
    title: 'Project context',
    actions: {
      view: read,
      update: write('local-write', 'overwrite', 'dashboard-write'), // manual snapshot is post-write
      condense: write('local-write', 'overwrite'),
      snapshot: write('local-write'),
      history: read,
      next_steps: write('local-write', 'overwrite'),
      constraints: write('local-write', 'overwrite'),
      search: read,
    },
  },
  rbook_session: {
    title: 'Sessions',
    actions: {
      list: read,
      start: write('local-write', 'overwrite'),
      capture: write('local-write', 'overwrite'),
      complete: write('local-write', 'overwrite', 'dashboard-write'),
      search: read,
    },
  },
  rbook_decisions: {
    title: 'Decisions',
    actions: {
      list: read,
      search: read,
      show: read,
      update: write('local-write', 'overwrite'),
      review: read,
      batch_update: write('local-write', 'overwrite'),
      record: write('local-write', 'overwrite'), // optional supersession replaces prior status
    },
  },
  rbook_db: {
    title: 'Database administration',
    actions: {
      health: read,
      snapshot: write('local-write', 'delete'), // retention removes old snapshot files
      restore: write('local-write', 'overwrite', 'delete'),
      backfill: write('bookkeeping', 'dashboard-write', 'overwrite'),
      reconcile: write('bookkeeping'),
      purge: write('dashboard-write', 'delete'),
      identify_orphans: write('bookkeeping', 'dashboard-write'),
      pull: write('local-write', 'overwrite'),
      clone: write('local-write', 'overwrite'),
      prune_snapshots: write('local-write', 'overwrite', 'delete'), // content and backup retention
      conflicts: read,
      settle: write('local-write', 'overwrite'), // keeps one value; the others stay in the log
    },
  },
  rbook_project: {
    title: 'Projects',
    actions: {
      init: write('local-write', 'overwrite'), // re-init can replace explicit name/type metadata and contexts
      register: write('local-write', 'overwrite'),
      list: read,
      unregister: write('local-write', 'delete'), // hard registry-row deletion, not archival
      validate: write('bookkeeping', 'overwrite'), // prune=true archives registry rows
      prune: write('bookkeeping', 'overwrite'),
      update: write('local-write', 'overwrite'),
      sweep: write('bookkeeping'),
      share: write('local-write', 'overwrite', 'dashboard-write'), // identity and baseline; via the dashboard, the upload and handover
      invite: write('local-write'),
      join: write('local-write', 'remote-write', 'dashboard-write'), // admits the far copy over SSH; via the dashboard, its join there
      members: read,
      remove: write('local-write', 'access-revocation'),
      sync: write('local-write', 'overwrite', 'remote-write'), // other copies' changes, or a confirmed move
      move: write('local-write', 'overwrite', 'dashboard-write'), // a new identity, the record moved back, the referee archived
    },
  },
  rbook_learnings: {
    title: 'Learnings',
    actions: {
      list: read,
      search: read,
      show: read,
      update: write('local-write', 'overwrite'),
      reaffirm: write('local-write', 'overwrite'),
    },
  },
  rbook_feedback: {
    title: 'Agent feedback',
    actions: {
      list: read,
      triage: write('local-write', 'overwrite'),
      resolve: write('local-write', 'overwrite'),
      archive: write('local-write', 'overwrite'),
    },
  },
  rbook_auth: {
    title: 'Dashboard authentication',
    actions: {
      rotate: write('local-write', 'dashboard-write', 'overwrite', 'access-revocation'),
      revoke: write('local-write', 'dashboard-write', 'delete', 'access-revocation'),
      list: read,
      reissue: write('local-write', 'dashboard-write', 'overwrite', 'access-revocation'),
      login: write('local-write', 'dashboard-write', 'overwrite'),
      login_init: write('dashboard-write'),
      login_complete: write('local-write', 'dashboard-write', 'overwrite'),
      logout: write('local-write', 'dashboard-write', 'delete', 'access-revocation'),
    },
  },
  rbook_message: {
    title: 'Project messages',
    actions: {
      send: write('message'),
      list: read,
      get: write('bookkeeping'), // GET is read-only; write-classified resolution can repair identity
      respond: write('message', 'overwrite'),
      ack: write('dashboard-write', 'overwrite'),
      directory: read,
      whoami: read,
    },
  },
  rbook_agent_onboard: {
    title: 'Project onboarding',
    actions: { '': write('local-write', 'overwrite', 'bookkeeping') },
  },
  rbook_status: { title: 'Project status', actions: { '': read } },
  rbook_review: {
    title: 'Project review',
    actions: { '': { mode: 'read', effects: ['bookkeeping', 'overwrite'] } },
  },
};

/** Worst possible action and shared effects govern a tool's hints, including its read actions. */
export function deriveEffectAnnotations(
  actions: readonly ActionEffects[],
  commonEffects: readonly ToolEffect[] = COMMON_WIRE_EFFECTS
): EffectAnnotations {
  const effects = [...commonEffects, ...actions.flatMap((action) => action.effects)];
  const unchanged = effects.every((effect) => effect === 'none');
  return {
    readOnlyHint: unchanged,
    destructiveHint: effects.some((effect) =>
      ['overwrite', 'delete', 'access-revocation', 'message'].includes(effect)
    ),
    idempotentHint: unchanged,
    openWorldHint: effects.includes('message') || effects.includes('remote-write'),
  };
}

/** Fail loudly on an unclassified tool rather than publishing misleading safety hints. */
export function toolEffectMetadata(name: string): {
  title: string;
  annotations: EffectAnnotations;
} {
  const tool = TOOL_EFFECTS[name];
  if (!tool) throw new Error(`No effects table for tool ${name}`);
  return { title: tool.title, annotations: deriveEffectAnnotations(Object.values(tool.actions)) };
}

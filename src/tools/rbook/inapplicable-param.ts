// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — a declared parameter given to an action that does not use it, refused instead of
// ABOUTME: ignored, for the keys whose silent loss would write the wrong thing: dates, reasons and next_steps' bounds.

import { RBOOK_ERROR_CODES } from './errors';
import type { RbookToolError } from './types';

/**
 * WHY. Dispatch refuses only undeclared keys (unknown-param-guard.ts), so once a key is declared on a
 * tool every other action of that tool accepts it and ignores it. For `checkAfter` that would turn
 * `rbook_session(action="complete", nextSteps=[…], checkAfter=…)` into a success that writes undated
 * rows, where 4.9.0 refused the unknown key (the sprint-108 design, settled item 5).
 *
 * WHAT "GIVEN" MEANS. Absent, JSON null and an empty or blank string are not given: dispatch has
 * already deleted top-level nulls (tool-validation.ts), and a client that sends null for every field
 * it knows is a very common shape (decision #1117). So this runs in each router, on the normalised
 * arguments, never beside the unknown-key preflight, which sees raw ones.
 *
 * THE CLASS, AND WHAT IS LEFT. A published key of an action-bearing tool, given to an action whose
 * RBOOK_ACTION_PARAMS entry lacks it, is accepted and ignored: 1,470 such triples at 51de697c. This
 * refuses only the new keys and next_steps' since and until; every other triple answers as 4.9.0 did,
 * a stated limit.
 */
export function isGiven(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
}

/** What each refused key would have done, said in its refusal. */
const WHAT_IT_DOES: Readonly<Record<string, string>> = {
  checkAfter:
    'Date a next step when it is captured with rbook_session(action="capture", category="next-step", checkAfter=…), or carry it by id with rbook_context(action="next_steps", nextStepAction="carry", nextStepIds=[…], checkAfter=…).',
  reason:
    'Give a reason when completing or dropping next steps: rbook_context(action="next_steps", nextStepAction="complete" or "drop", nextStepIds=[…], reason=…).',
};

/**
 * The refusal for the first of `keys` given to a call whose action does not take it, or null.
 * `takes` is the action's entry in its tool's applicability table, so the refused pairs are derived
 * from that table, never listed by hand (Process Hardening practice 2).
 */
export function inapplicableParam(
  call: string,
  takes: readonly string[],
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): RbookToolError | null {
  const key = keys.find((name) => isGiven(params[name]) && !takes.includes(name));
  if (!key) return null;
  return {
    code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
    field: key,
    providedValue: params[key],
    message: `${call} does not use ${key}, so it would be ignored; nothing was written.`,
    suggestion: WHAT_IT_DOES[key] ?? `Send the call without ${key}.`,
  };
}

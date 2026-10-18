// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which records a sprint close archives (s87-m02): active rows linked to the sprint, its missions or its
// ABOUTME: sessions. Kept apart so the shared record's checks (s96-m12) read the same scope without the close.

/**
 * s87-m02 — THE SHARED ARCHIVE PREDICATE. One base constant, two derived ones.
 *
 * The decisions and learnings arms carried two hand-written copies of the same three-branch
 * disjunction. They were identical, which is the problem: nothing made them stay identical, and
 * an enumeration that does not use the EXACT predicate the UPDATE uses is not evidence about
 * that UPDATE. Hoisted so the pre-SELECT and the UPDATE are the same string by construction.
 *
 * THE THREE BRANCHES ARE RATIFIED, NOT INCIDENTAL. #38 blesses the compound WHERE ("sprint_id OR
 * mission_id-via-sprint OR session_id-via-sprint for comprehensive coverage") and #39 blesses the
 * active-only filter. Do not simplify it: 4 decisions and 2 learnings in this store live ONLY on
 * the session branch, and `sprint-close-archival-disclosure.test.ts` fences both halves.
 *
 * s96-m12: moved here from rbook-sprint-complete.ts, so the shared record's cross-record checks read
 * the close's exact scope without loading the close.
 */
export const ARCHIVE_WHERE = `status = 'active'
       AND (sprint_id = ?
         OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
         OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?))`;

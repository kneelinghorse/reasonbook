// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m02 — the refusal for a supplied value the content sanitizer emptied.
// ABOUTME: "Missing" would send the caller back with the same text, which the sanitizer empties again.

import { RBOOK_ERROR_CODES } from './errors';
import type { RbookToolError } from './types';

/**
 * Kept out of errors.ts, which is a sealed retrieval source
 * (rbook/research/2026-10-s94-m06/labels-v8-review/manifest.json).
 */
export function emptiedParameter(field: string): RbookToolError {
  return {
    code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
    message: `Parameter '${field}' held a stray tool-call tag (such as <parameter>), and the content sanitizer removes everything from that tag on, so nothing was left.`,
    field,
    suggestion: `Resend ${field} as plain text in its own parameter. A tag such as <parameter> outside backticks removes the text after it.`,
  };
}

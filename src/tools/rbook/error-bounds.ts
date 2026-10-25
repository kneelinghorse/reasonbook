// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bound caller-controlled refusal fields before text or structured rendering.
// ABOUTME: Preserve small values and successful answers while disclosing truncated JSON sizes.

import type { RbookToolError } from './types';

const FIELDS = [
  'message',
  'suggestion',
  'field',
  'providedValue',
  'currentState',
  'validValues',
] as const;
const FIELD_LIMIT = 512;
const PREVIEW_LIMIT = 160;

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[value cannot be serialized as JSON]';
  }
}

/** Budget the JSON-encoded preview, not just its unescaped character count. */
export function boundErrorValue(value: unknown, maxSerialized = PREVIEW_LIMIT): string {
  const json = serialized(value);
  const text = typeof value === 'string' ? value : json;
  if (JSON.stringify(text).length <= maxSerialized) return text;
  const suffix = `… [truncated; original JSON length=${json.length}]`;
  let low = 0;
  let high = Math.min(text.length, maxSerialized);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, middle) + suffix).length <= maxSerialized) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + suffix;
}

/** Handler values stay intact; only the refusal copy passed to its formatter is bounded. */
export function boundErrorFields<T extends { success: boolean; error?: RbookToolError }>(
  result: T
): T {
  if (result.success || !result.error) return result;
  const error = { ...result.error };
  for (const field of FIELDS) {
    const value = error[field];
    if (value === undefined || serialized(value).length <= FIELD_LIMIT) continue;
    // Existing formatters join validValues; a one-element preview retains that array contract.
    if (field === 'validValues') error.validValues = [boundErrorValue(value, PREVIEW_LIMIT - 2)];
    else error[field] = boundErrorValue(value);
  }
  return { ...result, error };
}

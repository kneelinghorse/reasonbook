// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Validates whole tool schemas before handlers can resolve a project or open a store.
// ABOUTME: Normalizes omitted optional values without stripping accepted nested data or valid nulls.

import type { z } from 'zod';
import { createError, createSuccess, RbookErrors } from './errors';
import type { RbookToolResult } from './types';

function expectation(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_union') {
    return [...new Set(issue.errors.flat().map(expectation))].join(' or ');
  }
  if (issue.code === 'invalid_type' && issue.expected === 'record') {
    return 'Provide a JSON object.';
  }
  return issue.message;
}

/**
 * Null on a non-nullable top-level key means omitted. Nested nulls are governed by their schema:
 * mission field clears and arbitrary JSON values remain values, while malformed entries refuse.
 * Return the normalized original, not zod's output: open nested objects must not lose extra keys.
 */
export function validateRbookArguments(
  schema: z.ZodObject,
  args: unknown
): RbookToolResult<Record<string, unknown>> {
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return createError(RbookErrors.invalidParameter('arguments', args, ['a JSON object']));
  }
  const normalized = { ...(args as Record<string, unknown> | undefined) };
  for (const [key, value] of Object.entries(normalized)) {
    const node = schema.shape[key];
    if (value === null && node && !node.safeParse(null).success) delete normalized[key];
  }
  const parsed = schema.safeParse(normalized);
  if (parsed.success) return createSuccess(normalized);

  const issue = parsed.error.issues[0];
  const parts = [...issue.path];
  if (issue.code === 'unrecognized_keys') parts.push(issue.keys[0]);
  let provided: unknown = normalized;
  for (const key of parts) {
    provided =
      provided !== null && typeof provided === 'object'
        ? (provided as Record<PropertyKey, unknown>)[key]
        : undefined;
  }
  const field = parts.map(String).join('.') || 'arguments';
  const error = RbookErrors.invalidParameter(
    field,
    provided,
    issue.code === 'invalid_value' ? issue.values.map(String) : undefined
  );
  return createError({ ...error, suggestion: error.suggestion ?? expectation(issue) });
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keep an offered refusal remedy in the same readable text as its failure message.
// ABOUTME: Existing formatters retain their prefixes and fallback wording without inventing missing suggestions.
import type { RbookToolError } from './types';

export function formatToolFailure(
  prefix: string,
  error: RbookToolError | undefined,
  fallback = 'Unknown error'
): string {
  const lines = [`${prefix}: ${error?.message ?? fallback}`];
  if (error?.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
  return lines.join('\n');
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One stable refusal for the retired dashboard event-sync and soft-lock paths.
// ABOUTME: Compatibility actions stay callable until 5.0 and direct people to the shared-record exchange.
import { createError } from './errors';
import type { RbookToolResult } from './types';

export function legacySyncRefusal<T>(operation: string, detail?: string): RbookToolResult<T> {
  return createError({
    code: 'LEGACY_SYNC_RETIRED',
    message: `${operation} is retired.${detail ? ` ${detail}` : ''}`,
    suggestion: 'Use reasonbook sync to exchange the shared record between copies.',
  });
}

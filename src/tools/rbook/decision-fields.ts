// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Validate and sanitize optional decision fields before any record-side effects.
// ABOUTME: Compose stored decision text consistently for recall while keeping headlines separate.

import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { RbookErrors, createError, createSuccess } from './errors';
import type { RbookToolResult } from './types';

export interface DecisionFieldsParams {
  readonly context?: string;
  readonly alternatives?: readonly string[];
  readonly consequences?: string;
  readonly deciders?: readonly string[];
  readonly mode?: 'autonomous';
}

export const DECISION_TEXT_FIELDS = [
  'context_text',
  'alternatives',
  'consequences',
  'deciders',
] as const;
const FIELD_COLUMNS = {
  context: 'context_text',
  alternatives: 'alternatives',
  consequences: 'consequences',
  deciders: 'deciders',
  mode: 'approval_mode',
} as const;

export function prepareDecisionFields(
  params: DecisionFieldsParams & { readonly fromDraft?: string }
): RbookToolResult<{ fields: DecisionFieldsParams; sanitizedFields: SanitizedField[] }> {
  const supplied = Object.keys(FIELD_COLUMNS).filter(
    (name) => params[name as keyof DecisionFieldsParams] !== undefined
  );
  if (params.fromDraft != null && supplied.length) {
    return createError({
      code: 'INVALID_PARAMETER',
      field: supplied[0],
      message:
        'fromDraft cannot be combined with mode or new decision fields that were not in the approved draft.',
      // s106-m02 (#870): "record the draft alone" sent fromDraft without content, which was refused;
      // name the resend exactly.
      suggestion:
        "Resend without context, alternatives, consequences, deciders and mode: fromDraft without content records the draft in its own words. To add reasoning or effects, then record a separate decision with supersedes=[the recorded decision's id].",
    });
  }
  const fields: {
    context?: string;
    alternatives?: string[];
    consequences?: string;
    deciders?: string[];
    mode?: 'autonomous';
  } = {};
  const sanitizedFields: SanitizedField[] = [];
  for (const field of ['context', 'consequences'] as const) {
    const value = params[field];
    if (value === undefined) continue;
    if (typeof value !== 'string')
      return createError(RbookErrors.invalidParameter(field, value, ['a JSON string']));
    const result = sanitizeContentField(value);
    fields[field] = result.cleaned;
    if (result.wasModified) sanitizedFields.push({ field, reason: result.reason ?? '' });
  }
  for (const field of ['alternatives', 'deciders'] as const) {
    const value = params[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return createError(RbookErrors.invalidParameter(field, value, ['an array of JSON strings']));
    }
    const result = sanitizeStringArray(field, value);
    fields[field] = result.cleaned;
    sanitizedFields.push(...result.sanitizedFields);
  }
  if (params.mode !== undefined) {
    if (params.mode !== 'autonomous')
      return createError(RbookErrors.invalidParameter('mode', params.mode, ['autonomous']));
    fields.mode = params.mode;
  }
  return createSuccess({ fields, sanitizedFields });
}

/** Only supplied values participate in insertion or retry comparison; omission never erases. */
export function storedDecisionFields(fields: DecisionFieldsParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
    const value = fields[field as keyof DecisionFieldsParams];
    if (value !== undefined)
      result[column] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return result;
}

export interface DecisionTextRow {
  readonly decision_text: string;
  readonly context_text?: string | null;
  readonly alternatives?: string | null;
  readonly consequences?: string | null;
  readonly deciders?: string | null;
}

/** Invalid historical array JSON remains text for search; show separately discloses its shape. */
export function composeDecisionText(row: DecisionTextRow): string {
  const parts = [row.decision_text];
  for (const field of DECISION_TEXT_FIELDS) {
    const value = row[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (field === 'alternatives' || field === 'deciders') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          parts.push(...parsed);
          continue;
        }
      } catch {
        /* Preserve malformed historical text in search input without calling it an array. */
      }
    }
    parts.push(value);
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

/** Fixed column names only; callers supply a schema probe and an internal SQL alias. */
export function decisionTextProjection(columns: ReadonlySet<string>, alias = ''): string {
  return DECISION_TEXT_FIELDS.map(
    (field) => `${columns.has(field) ? `${alias}${field}` : 'NULL'} AS ${field}`
  ).join(', ');
}

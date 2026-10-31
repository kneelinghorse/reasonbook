// ABOUTME: Detects and strips XML sibling-absorption artifacts from free-text fields written through Reasonbook tools.
// ABOUTME: Strip-and-surface semantics: cleaned content is written, field names bubble up via sanitizedFields.

/**
 * Content sanitizer for XML marshalling artifacts.
 *
 * Sprint 56 m02 — root cause: when an agent emits a tool call like
 *   <parameter name="content">...text...</content>
 * with a misspelled closing tag (e.g. `</content` missing the trailing `>`),
 * the harness's XML→JSON marshaller absorbs the following
 * `<parameter name="missionId">` block as literal string content. The JSON
 * that reaches the MCP server is schema-valid (the `content` field is just
 * a very long string), so the write succeeds and corruption lives forever.
 *
 * Strategy: scan incoming free-text fields for the literal `<parameter …>`
 * or `</parameter …>` / `<content …>` / `</content …>` patterns outside
 * triple-backtick code fences AND inline backtick spans (Sprint 65 m04).
 * When detected, strip from the artifact onwards and surface a per-field
 * warning on the tool response so the calling agent can re-emit.
 *
 * Legitimate content inside ```…``` fences (embedded code samples) and inside
 * `…` inline spans (prose quoting a tag name as data, e.g. `<content>`) is
 * preserved — these are the places an agent may genuinely include these
 * tokens. Unclosed fences / dangling backticks still trigger sanitization;
 * the protection only applies to balanced delimiter pairs.
 *
 * @module intelligence/content-sanitizer
 */

/** Tag names that trigger sanitization when they appear as literal XML/XML-like markup. */
export const ARTIFACT_TAG_NAMES = ['content', 'parameter', 'invoke', 'function_calls'] as const;

/** Matches any `<tag …>` or `</tag …>` for one of the tracked tag names. */
const ARTIFACT_PATTERN = new RegExp(`<\\/?(?:${ARTIFACT_TAG_NAMES.join('|')})\\b[^>]*>`, 'g');

/** Matches a balanced triple-backtick code fence. `[\s\S]` keeps newlines in scope. */
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;

/**
 * Matches an inline backtick span — a single opening backtick, one or more
 * non-backtick non-newline characters, a single closing backtick. Multi-line
 * spans and double-backtick spans (`` `` `` …`) are intentionally NOT covered;
 * the typical agent-prose case is `` `<content>` `` on a single line. Unclosed
 * spans don't match — by design, they fall through to artifact sanitization.
 */
const INLINE_BACKTICK_PATTERN = /`[^`\n]+`/g;

/**
 * One sanitized field entry surfaced on a tool response.
 * Populated when a write-path handler strips an artifact before persisting.
 */
export interface SanitizedField {
  /** The field name (or array path like `decisions[2]`) that was sanitized. */
  field: string;
  /** Short human-readable explanation of what was stripped. */
  reason: string;
}

/** Result of sanitizing a single string value. */
export interface SanitizerResult {
  /** The cleaned string. Identical to input when no artifact was found. */
  cleaned: string;
  /** Whether the input was modified. */
  wasModified: boolean;
  /** Short reason string, present only when `wasModified` is true. */
  reason?: string;
}

function findCodeFenceRanges(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // First pass: triple-backtick fences. Take precedence so the inline pass
  // doesn't try to interpret embedded fence backticks as inline spans.
  let match: RegExpExecArray | null;
  CODE_FENCE_PATTERN.lastIndex = 0;
  while ((match = CODE_FENCE_PATTERN.exec(input)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  // Second pass: inline backtick spans, skipping any that overlap a triple-fence
  // range. Sprint 65 m04 — preserves prose like `<content>` written in agent notes.
  INLINE_BACKTICK_PATTERN.lastIndex = 0;
  while ((match = INLINE_BACKTICK_PATTERN.exec(input)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const overlapsFence = ranges.some(([s, e]) => start < e && end > s);
    if (!overlapsFence) {
      ranges.push([start, end]);
    }
  }

  return ranges;
}

function isInsideAny(index: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a single free-text field.
 *
 * Finds the first XML marshalling artifact outside any triple-backtick code
 * fence, strips from that position to end-of-string, and trims the trailing
 * whitespace so the cleaned value doesn't carry orphan newlines.
 *
 * @param input - The raw field value as received from the tool caller.
 * @returns The cleaned string and whether anything was stripped.
 */
export function sanitizeContentField(input: string): SanitizerResult {
  if (!input || typeof input !== 'string') {
    return { cleaned: input, wasModified: false };
  }

  const fences = findCodeFenceRanges(input);

  ARTIFACT_PATTERN.lastIndex = 0;
  let firstIndex = -1;
  let firstMatchText: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = ARTIFACT_PATTERN.exec(input)) !== null) {
    if (!isInsideAny(match.index, fences)) {
      firstIndex = match.index;
      firstMatchText = match[0];
      break;
    }
  }

  if (firstIndex === -1 || firstMatchText === null) {
    return { cleaned: input, wasModified: false };
  }

  const cleaned = input.slice(0, firstIndex).replace(/\s+$/, '');
  const snippet = firstMatchText.length > 40 ? `${firstMatchText.slice(0, 40)}…` : firstMatchText;
  const reason = `Stripped XML marshalling artifact starting with ${JSON.stringify(snippet)} — the tool harness absorbed a sibling parameter into this field; re-emit the content without the spurious tag.`;

  return { cleaned, wasModified: true, reason };
}

/** Matches a `<parameter name="X">` open tag and captures X. */
const PARAMETER_OPEN_PATTERN = /<parameter\s+name\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["'][^>]*>/g;

/**
 * s91-m03 — the names of the sibling parameters a marshalling artifact absorbed into this field:
 * every `<parameter name="X">` open tag outside a code fence or inline span, in order. Detection
 * only; it changes nothing about what `sanitizeContentField` strips or keeps.
 */
export function absorbedParameterNames(input: string): string[] {
  if (!input || typeof input !== 'string') return [];
  const fences = findCodeFenceRanges(input);
  const names: string[] = [];
  PARAMETER_OPEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAMETER_OPEN_PATTERN.exec(input)) !== null) {
    if (!isInsideAny(match.index, fences)) names.push(match[1]);
  }
  return names;
}

/**
 * Sanitize a named record of fields in one pass.
 *
 * @param input - The record to sanitize. Non-string values are passed through.
 * @param fieldNames - The subset of fields to scan for artifacts.
 * @returns A shallow-copied record with cleaned values, plus the per-field
 *   entries that changed. Pass through unchanged when nothing was stripped.
 */
export function sanitizeFields<T extends Record<string, unknown>>(
  input: T,
  fieldNames: ReadonlyArray<keyof T>
): { sanitized: T; sanitizedFields: SanitizedField[] } {
  let copy: T | null = null;
  const sanitizedFields: SanitizedField[] = [];

  for (const field of fieldNames) {
    const value = input[field];
    if (typeof value !== 'string') {
      continue;
    }
    const result = sanitizeContentField(value);
    if (result.wasModified) {
      if (copy === null) {
        copy = { ...input };
      }
      (copy as Record<string, unknown>)[field as string] = result.cleaned;
      sanitizedFields.push({
        field: field as string,
        reason: result.reason ?? 'Stripped XML marshalling artifact.',
      });
    }
  }

  return { sanitized: copy ?? input, sanitizedFields };
}

/**
 * Sanitize a homogeneous array of strings (e.g. `decisions[]`, `nextSteps[]`).
 *
 * Sanitized indices are reported as `${fieldName}[${i}]` so the caller can
 * tell which array entry was altered.
 *
 * @param fieldName - The array's name, used to build field-path labels.
 * @param values - The array to sanitize. Non-string entries are passed through.
 * @returns Cleaned array plus a list of altered entries.
 */
export function sanitizeStringArray(
  fieldName: string,
  values: readonly string[] | undefined
): { cleaned: string[] | undefined; sanitizedFields: SanitizedField[] } {
  if (!values) {
    return { cleaned: values as undefined, sanitizedFields: [] };
  }

  const cleaned: string[] = new Array(values.length);
  const sanitizedFields: SanitizedField[] = [];
  let anyModified = false;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'string') {
      cleaned[i] = value;
      continue;
    }
    const result = sanitizeContentField(value);
    cleaned[i] = result.cleaned;
    if (result.wasModified) {
      anyModified = true;
      sanitizedFields.push({
        field: `${fieldName}[${i}]`,
        reason: result.reason ?? 'Stripped XML marshalling artifact.',
      });
    }
  }

  return { cleaned: anyModified ? cleaned : (values as string[]), sanitizedFields };
}

/**
 * Merge multiple `sanitizedFields` arrays, de-duplicating by field name (first wins).
 */
export function mergeSanitizedFields(
  ...groups: ReadonlyArray<ReadonlyArray<SanitizedField>>
): SanitizedField[] {
  const seen = new Set<string>();
  const out: SanitizedField[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.field)) continue;
      seen.add(entry.field);
      out.push(entry);
    }
  }
  return out;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Structural feedback-regex guard shared by its focused regression test and cost probe.
// ABOUTME: Retains the F5 predicate's top-level alternatives and explicit limits; it is not a complexity proof.

/** Split only top-level alternatives, respecting escapes, groups and character classes. */
export function regexAlternatives(source: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      current += char + source[++index];
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      current += char;
      continue;
    }
    if (char === '[') {
      inClass = true;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === '|' && depth === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives;
}

/** Same structural predicate as the pre-edit regex-static.js witness, including its blind spots. */
export function multipleUnboundedAlternatives(pattern: RegExp): string[] {
  const unbounded = /(\\[wdsWDSbB]|\[(?:\\.|[^\]\\])*\]|\.|\)|[^\\()[\]{}|*+?])(\*|\+|\{\d+,\})/g;
  return regexAlternatives(pattern.source).filter(
    (alternative) => [...alternative.matchAll(unbounded)].length >= 2
  );
}

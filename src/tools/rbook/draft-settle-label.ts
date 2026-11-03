// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — recognizes a "Settled: P<n> by decision <N>" line, plain or in a form that is not read as a settle.
// ABOUTME: Pure and dependency-free: the draft grammar's trailing reader uses it to read past Settled lines.

/**
 * THE LINE (the sprint-109 design, settled item 1). `Settled: P<n> by decision <N>`, with an optional
 * `#` before N, on a plain line: no quote or list marker, no emphasis, code or link around it. A
 * plain line settles only from the reply's trailing block (draft-settle-grammar.ts); every other form
 * is a Settled-labelled line that is named as not kept, and still takes its draft out of the shown set.
 */
export interface SettleLabel {
  /** The plain form, the only one read as a settle. */
  readonly plain: boolean;
  /** The draft the line names, or null when it names none. */
  readonly draftId: number | null;
  /** Every draft the line names: a line in a form not kept can name several (critic m02-b1, B1). */
  readonly draftIds: readonly number[];
  /** The decision, for the plain form only. */
  readonly decisionId: number | null;
}

const ID = '([1-9]\\d{0,15})';
const PLAIN = new RegExp(`^settled:\\s*p${ID}\\s+by\\s+decision\\s+#?${ID}\\.?$`, 'i');
/** The label once leading markers are gone, with a wrapper allowed before the colon (`**Settled**:`). */
const LABELLED = /^settled\s*(?:\*\*|__|\*|_|`|~~)?\s*:/i;
const DRAFTS = new RegExp(`\\bp${ID}\\b`, 'gi');

/** The Settled label a line carries, or null; quote, list, emphasis, code and link-text forms are not plain. */
export function settleLabel(line: string): SettleLabel | null {
  const text = line.trim();
  const plain = PLAIN.exec(text);
  if (plain)
    return {
      plain: true,
      draftId: Number(plain[1]),
      draftIds: [Number(plain[1])],
      decisionId: Number(plain[2]),
    };
  // critic m02-b1, B2: any leading run of marks (heading, strikethrough, table, emoji, comment) too.
  const bare = text
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '');
  const label = LABELLED.exec(bare);
  if (!label) return null;
  const draftIds = [...bare.slice(label[0].length).matchAll(DRAFTS)].map((match) =>
    Number(match[1])
  );
  return { plain: false, draftId: draftIds[0] ?? null, draftIds, decisionId: null };
}

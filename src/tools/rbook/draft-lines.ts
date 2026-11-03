// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — how a reply's lines are read: fenced and indented code marked, prose with code, links and URLs
// ABOUTME: blanked, and the links a line names. Moved from draft-grammar.ts in s109-m02, which re-exports it.

/** The links and documents a line names: URLs, markdown link targets and .md/.html/.pdf paths. */
export function draftEvidence(text: string): string[] {
  const found: string[] = [];
  const add = (value: string): void => {
    const clean = value.replace(/[.,;:]+$/, '');
    if (clean && !found.includes(clean)) found.push(clean);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) add(match[0]);
  const withoutUrls = text.replace(/https?:\/\/[^\s)<>\]"'`]+/g, ' ');
  for (const match of withoutUrls.matchAll(
    /(?:^|[\s(`'"[])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:md|html?|pdf))(?=$|[\s)`'".,;:\]])/gi
  ))
    add(match[1]);
  return found.slice(0, 5);
}

/** Split into lines and mark the ones inside a fenced block (an unclosed fence runs to the end). */
export function fencedLines(reply: string): Array<{ text: string; fenced: boolean }> {
  let fence: { delimiter: string; quotes: number } | null = null;
  return reply.split(/\r?\n/).map((text) => {
    const quotes = /^(?: {0,3}> ?)+/.exec(text)?.[0] ?? '';
    const depth = quotes.split('>').length - 1;
    const unquoted = text.slice(quotes.length);
    // A list marker may open a fence, but is literal code inside one. A closing fence must
    // stay in the opener's quote container; a quoted example inside plain code cannot close it.
    const container = fence ? unquoted : unquoted.replace(/^ {0,3}(?:[-*+]|\d+[.)]) +/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(container);
    if (marker) {
      if (fence === null) fence = { delimiter: marker[1], quotes: depth };
      else if (
        depth === fence.quotes &&
        marker[1][0] === fence.delimiter[0] &&
        marker[1].length >= fence.delimiter.length &&
        !marker[2].trim()
      )
        fence = null;
      return { text, fenced: true };
    }
    return { text, fenced: fence !== null || /^(?: {4}|\t)/.test(unquoted) };
  });
}

/**
 * The reply's prose: lines outside fenced blocks, with inline code, markdown link targets and URLs
 * blanked. Where a draft id counts as named (the build critic, B1): "P1" in a file name, a URL or
 * a code sample names nothing.
 */
export function proseLines(reply: string): string[] {
  return fencedLines(reply ?? '')
    .map((line) => (line.fenced ? '' : line.text))
    .join('\n')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (code) => code.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\]\([^)]*\)/g, '] ').replace(/https?:\/\/\S+/g, ' '));
}

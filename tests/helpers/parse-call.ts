// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads one written tool call (rbook_x(key="value", ...)) into its tool and arguments, slots marked as placeholders.
// ABOUTME: Moved from seed-example-calls.test.ts (s107-m05) so other suites import it without running that suite.

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

/** A value the example leaves for the reader to fill (seed-example-calls.test.ts's counting rule). */
export class Placeholder {
  constructor(readonly text: string) {}
}

type Token =
  | { readonly t: 'word'; readonly v: string }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'number'; readonly v: number }
  | { readonly t: 'mark'; readonly v: string }
  | { readonly t: 'ellipsis' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (source.startsWith('...', i) || c === '…') {
      tokens.push({ t: 'ellipsis' });
      i += c === '…' ? 1 : 3;
    } else if (c === '"' || c === "'") {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== c; j += 1) {
        if (source[j] !== '\\') {
          value += source[j];
          continue;
        }
        // JSON's escapes, which callText writes (a backtick or a line separator as \uXXXX); any
        // other escaped character stands for itself, as it always has (s107-m05).
        const next = source[++j];
        const hex = source.slice(j + 1, j + 5);
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          j += 4;
        } else value += ESCAPES[next] ?? next;
      }
      tokens.push({ t: 'string', v: value });
      i = j + 1;
    } else if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^-?[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ t: 'number', v: Number(match[0]) });
      i += match[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))!;
      tokens.push({ t: 'word', v: match[0] });
      i += match[0].length;
    } else if ('()[]{},=:'.includes(c)) {
      tokens.push({ t: 'mark', v: c });
      i += 1;
    } else {
      throw new Error(`unexpected "${c}" in ${source}`);
    }
  }
  return tokens;
}

/** Whether a string the example passes is a slot for the reader rather than a real value. */
function isPlaceholderText(text: string): boolean {
  return (
    text === '...' ||
    text === '…' ||
    /^<[^>]*>$/.test(text) ||
    /^[A-Za-z]+(\|[A-Za-z]+)+$/.test(text) ||
    text.startsWith('/path/to/')
  );
}

export interface ParsedCall {
  /** The call as written. */
  readonly source: string;
  readonly tool: string;
  /** Each argument as written; a value holding a {@link Placeholder} anywhere is filled whole. */
  readonly args: ReadonlyMap<string, unknown>;
  readonly elided: boolean;
}

export function parseCall(source: string): ParsedCall {
  const tool = /^rbook_[a-z_]+/.exec(source)![0];
  const tokens = tokenize(source.slice(tool.length));
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const take = (): Token => {
    const token = tokens[at];
    if (!token) throw new Error(`unexpected end of ${source}`);
    at += 1;
    return token;
  };
  const expectMark = (mark: string): void => {
    const token = take();
    if (token.t !== 'mark' || token.v !== mark) throw new Error(`expected "${mark}" in ${source}`);
  };

  const value = (): unknown => {
    const token = take();
    switch (token.t) {
      case 'string':
        return isPlaceholderText(token.v) ? new Placeholder(token.v) : token.v;
      case 'number':
        return token.v;
      case 'ellipsis':
        return new Placeholder('...');
      case 'word':
        if (token.v === 'true') return true;
        if (token.v === 'false') return false;
        if (token.v === 'null') return null;
        return new Placeholder(token.v);
      case 'mark':
        if (token.v === '[') {
          const items: unknown[] = [];
          while (!(peek()?.t === 'mark' && (peek() as { v: string }).v === ']')) {
            items.push(value());
            if (peek()?.t === 'mark' && (peek() as { v: string }).v === ',') take();
          }
          take();
          return items;
        }
        if (token.v === '{') {
          const entries = members('}');
          // `{type, id}` names its fields without values, and `{...}` elides them: both are slots.
          return entries.shorthand || entries.elided
            ? new Placeholder('{…}')
            : Object.fromEntries(entries.pairs);
        }
        throw new Error(`unexpected "${token.v}" in ${source}`);
    }
  };

  /** `key: value` or `key = value` members up to `close`; a bare word is a shorthand slot. */
  const members = (
    close: string
  ): { pairs: Array<[string, unknown]>; shorthand: boolean; elided: boolean } => {
    const pairs: Array<[string, unknown]> = [];
    let shorthand = false;
    let elided = false;
    while (!(peek()?.t === 'mark' && (peek() as { v: string }).v === close)) {
      const key = take();
      if (key.t === 'ellipsis') {
        elided = true;
      } else if (key.t === 'word' || key.t === 'string') {
        const next = peek();
        if (next?.t === 'mark' && (next.v === ':' || next.v === '=')) {
          take();
          pairs.push([key.v, value()]);
        } else {
          shorthand = true;
        }
      } else {
        throw new Error(`unexpected argument in ${source}`);
      }
      if (peek()?.t === 'mark' && (peek() as { v: string }).v === ',') take();
    }
    take();
    return { pairs, shorthand, elided };
  };

  expectMark('(');
  if (peek()?.t === 'mark' && (peek() as { v: string }).v === '{') {
    take();
    const object = members('}');
    expectMark(')');
    return { source, tool, args: new Map(object.pairs), elided: object.elided };
  }
  const call = members(')');
  return { source, tool, args: new Map(call.pairs), elided: call.elided };
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every relative link in a Markdown file the npm package ships must reach a file the package ships too:
// ABOUTME: an installed copy has no repository beside it, so a link out of the package is a dead end for its reader.

import * as fs from 'fs';
import * as path from 'path';
import { inspectNpmPack } from './npm-pack-inspection';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The relative link targets in Markdown: inline links and images, and reference definitions, outside
 * fenced blocks and inline code. A target with a URL scheme, or only an anchor, is no file link.
 */
export function relativeLinks(markdown: string): Array<{ line: number; target: string }> {
  const found: Array<{ line: number; target: string }> = [];
  let fenced = false;
  markdown.split('\n').forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, '');
    const targets = [
      ...[...line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
        (match) => match[1]
      ),
      ...[...line.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/g)].map((match) => match[1]),
    ];
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      found.push({ line: index + 1, target });
    }
  });
  return found;
}

describe('links inside the npm package', () => {
  it('finds inline links, images and definitions, and skips code, anchors and URLs', () => {
    const sample = [
      '[a](docs/a.md) ![b](img/b.png "B") [web](https://x.y) [here](#top)',
      '`[not](code.md)`',
      '```',
      '[fenced](fenced.md)',
      '```',
      '[ref]: ../c.md#part',
    ].join('\n');
    expect(relativeLinks(sample)).toEqual([
      { line: 1, target: 'docs/a.md' },
      { line: 1, target: 'img/b.png' },
      { line: 6, target: '../c.md#part' },
    ]);
  });

  it('reach only files the package ships', () => {
    const { files } = inspectNpmPack(ROOT);
    const folders = new Set(
      [...files].flatMap((file) =>
        file
          .split('/')
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join('/'))
      )
    );
    const dead: string[] = [];
    for (const file of [...files].filter((name) => name.endsWith('.md')).sort()) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const { line, target } of relativeLinks(text)) {
        const resolved = path.posix
          .normalize(path.posix.join(path.posix.dirname(file), decodeURI(target.split('#')[0])))
          .replace(/\/$/, '');
        if (!files.has(resolved) && !folders.has(resolved))
          dead.push(`${file}:${line} -> ${target}`);
      }
    }
    expect(dead).toEqual([]);
  }, 180000);
});

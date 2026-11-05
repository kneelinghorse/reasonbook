// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — architecture.md says RBOOK_PROJECT_ID guards nothing, and that stays true only while no
// ABOUTME: runtime path calls validateProjectId; at 7d7a3c28 the doc claimed a guard the code never ran.

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { requiresPrivateEvidence } from '../helpers/public-mirror';

const PRIVATE = requiresPrivateEvidence({
  reason: 'architecture.md lives under rbook/docs, which the public mirror does not carry.',
  paths: { architecture: 'rbook/docs/architecture.md' },
});

const SRC = path.resolve(__dirname, '../../src');

function sources(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

PRIVATE.describe("architecture.md's RBOOK_PROJECT_ID line", () => {
  it('claims no runtime guard, and the code calls validateProjectId nowhere', () => {
    const doc = fs.readFileSync(PRIVATE.paths.architecture, 'utf8');
    const line = doc.split('\n').findIndex((text) => text.startsWith('RBOOK_PROJECT_ID='));
    const entry = doc
      .split('\n')
      .slice(line, line + 3)
      .join('\n');
    expect(entry).not.toMatch(/must-match guard|fails when the store carries/);
    expect(entry).toMatch(/no\s+#?\s*runtime path calls that method/);

    // The sentence is true only while this holds: a caller would make the setting a guard again.
    const callers = sources(SRC).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((text) => /\.validateProjectId\(/.test(text))
        .map((text) => `${path.relative(SRC, file)}: ${text.trim()}`)
    );
    expect(callers).toEqual([]);
  });
});

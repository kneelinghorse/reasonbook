// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The Builder seed describes the shipped Reasonbook product and its current tool surface.
// ABOUTME: Guards the first-hour documents against obsolete setup instructions and retired actions.

import * as fs from 'fs';
import * as path from 'path';
import { getToolDefinitions } from '../../src/index';

const SEED = path.resolve(__dirname, '../../rbook-seed');
const FILES = [
  'README.md',
  'docs/README.md',
  'docs/getting-started.md',
  'templates/PROJECT-README-template.md',
];

describe('the first-hour Builder seed', () => {
  it.each(FILES)('%s teaches Reasonbook and supported setup', (file) => {
    const text = fs.readFileSync(path.join(SEED, file), 'utf8');
    expect(text).not.toMatch(/Context \+ Mission|cp -r rbook-seed\/|No Python CLI/);
  });

  it('lists exactly the 15 tools returned by tools/list, with shared-record actions', () => {
    const text = fs.readFileSync(path.join(SEED, 'README.md'), 'utf8');
    const rows = [...text.matchAll(/^\|\s*`(rbook_[a-z_]+)`\s*\|\s*([^|]+)\|/gm)];
    const advertised = getToolDefinitions()
      .map((tool) => tool.name)
      .sort();
    expect(advertised).toHaveLength(15);
    expect(rows.map((row) => row[1]).sort()).toEqual(advertised);
    const projectActions = rows.find((row) => row[1] === 'rbook_project')?.[2];
    expect(projectActions).toMatch(/\bshare\b/);
    expect(projectActions).toMatch(/\bjoin\b/);
    expect(projectActions).toMatch(/\bsync\b/);
    expect(rows.find((row) => row[1] === 'rbook_db')?.[2]).not.toMatch(/\bpull\b|\bclone\b/);
  });
});

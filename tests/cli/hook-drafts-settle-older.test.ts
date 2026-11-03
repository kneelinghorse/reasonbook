// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the taught settle reply under 4.10.0's own hooks, which never read a Settled line: the Would record
// ABOUTME: lines below it still draft, and the operator's next "yes" binds nothing to the draft the reply settles.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

/**
 * WHY 4.10.0 (the sprint-109 design, settled item 1; E2's harness, e2-drafts.md:46-49). This
 * repository's own sessions, and the Codex adapter, run an older Stop hook until m06 updates the
 * plugins. That hook stops reading the trailing block at the first line without the Would record
 * label, so the teaching puts the Settled line above the Would record lines and names the draft only
 * there. The release runs from npx's cache; a machine without it skips, saying so.
 */
function cachedRelease(version: string): string | null {
  const root = path.join(os.homedir(), '.npm', '_npx');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const pkg = path.join(root, entry, 'node_modules', '@aquex', 'reasonbook');
    try {
      if (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version === version)
        return path.join(pkg, 'dist', 'bin.js');
    } catch {
      // Not this one.
    }
  }
  return null;
}

const OLDER = cachedRelease('4.10.0');
const describeOlder = OLDER ? describe : describe.skip;
if (!OLDER)
  process.stderr.write(
    'hook-drafts-settle-older: skipped, @aquex/reasonbook 4.10.0 is not in the npx cache\n'
  );

let tmp: string;
let projectRoot: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-older-')));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'older-hooks' });
  reidentifyRbookTestStore(projectRoot);
  for (const dir of ['home', 'config', 'tmp']) fs.mkdirSync(path.join(tmp, dir));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** One hook run by the released CLI, in a scratch home and config folder, with nothing else set. */
function hook(event: string, fields: Record<string, unknown>): string {
  const run = spawnSync(process.execPath, [OLDER!, 'hook', event], {
    cwd: projectRoot,
    input: JSON.stringify({ session_id: 's-older', cwd: projectRoot, ...fields }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(tmp, 'home'),
      RBOOK_CONFIG_DIR: path.join(tmp, 'config'),
      TMPDIR: path.join(tmp, 'tmp'),
      RBOOK_CHECKPOINT_SYNC: 'off',
    },
  });
  expect(run.status).toBe(0);
  return run.stdout ? (JSON.parse(run.stdout).hookSpecificOutput.additionalContext as string) : '';
}

function drafts(): Array<{ id: number; text: string; outcome: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, text, outcome FROM proposals ORDER BY id').all() as ReturnType<
      typeof drafts
    >;
  } finally {
    db.close();
  }
}

function decision(text: string): number {
  const db = new Database(dbPath);
  try {
    return Number(
      db
        .prepare('INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)')
        .run(text, new Date(Date.now() + 1000).toISOString()).lastInsertRowid
    );
  } finally {
    db.close();
  }
}

const FIRST = 'Store project decisions as one JSON file per decision, because diffs stay readable.';
const SECOND = 'Keep one SQLite store per project because sync expects one.';

describeOlder('4.10.0’s hooks and the taught settle reply', () => {
  it('keep the drafts below a Settled line above its Would record lines, and ignore the line', () => {
    hook('session-start', { source: 'startup' });
    hook('stop', { last_assistant_message: `Proposed.\n\nWould record: ${FIRST}` });
    const d = decision(FIRST);
    hook('stop', {
      last_assistant_message: `Recorded.\n\nSettled: P1 by decision ${d}\nWould record: ${SECOND}`,
    });
    expect(drafts()).toEqual([
      { id: 1, text: FIRST, outcome: 'pending' },
      { id: 2, text: SECOND, outcome: 'pending' },
    ]);
  });

  it('bind nothing to the settled draft when the operator says yes, and bind the Would record line below as usual', () => {
    hook('session-start', { source: 'startup' });
    hook('stop', { last_assistant_message: `Proposed.\n\nWould record: ${FIRST}` });
    const d = decision(FIRST);
    // The taught reply: the settle explained in prose without "draft P1", then the Settled line.
    hook('stop', {
      last_assistant_message: `The operator's earlier approval is now recorded as decision ${d}.\n\nSettled: P1 by decision ${d}\nWould record: ${SECOND}`,
    });
    const offer = hook('prompt', { prompt: 'yes', prompt_id: 'after-settle' });
    expect(offer).toContain('plain approval of P2');
    expect(offer).not.toMatch(
      /approval of P1\b|approves P1\b|Reasonbook draft P1 \(decision\), which your last reply/
    );
  });
});

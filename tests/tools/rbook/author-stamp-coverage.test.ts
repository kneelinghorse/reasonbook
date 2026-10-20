// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m02 (practice 2) — every production insert into the eight logged tables takes the genesis stamp,
// ABOUTME: which carries the author (ADR s96 §10); an insert that writes its own columns would leave it out.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { genesisColumns, rawGenesisColumns } from '../../../src/tools/rbook/genesis-columns';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const SRC = path.resolve(__dirname, '../../../src');

/**
 * The published universe (rbook/research/2026-10-s96-probes/s96-m02-authors-build.md, class F):
 * 28 lines at cde8a0a; 29 since s100-m03's next-step insert at capture, which splices the stamp. Left,
 * each for its reason; every other site splices the genesis stamp.
 *
 * WHAT IT CANNOT SEE (practice 7). The rule reads a table named in the SQL text, bare or quoted.
 * An insert whose table is a variable (`INSERT INTO ${table}`) is outside it: spin-out's copy and
 * the migrations' table rebuild are the two today, and both keep every column they copy. A new
 * dynamic insert into a logged table, such as s96-m12's apply step, must be reviewed by hand.
 */
const LEFT: Readonly<Record<string, string>> = {
  'tools/rbook/sync-merge.ts': "the retired sync, refused from 4.1.0, copies the origin's rows",
  'tools/rbook/genesis-columns.ts': 'a documentation example',
};

function sources(dir = SRC): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [rel, text] of sources(full)) files.set(rel, text);
    else if (entry.name.endsWith('.ts'))
      files.set(path.relative(SRC, full), fs.readFileSync(full, 'utf8'));
  }
  return files;
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly columns: string;
}

function sites(files: Map<string, string>): Site[] {
  const insert = new RegExp(
    `INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+["'\`[]?(?:${FIREHOSE_TABLES.join('|')})\\b["'\`\\]]?([\\s\\S]*?)(?:VALUES|SELECT)\\b`,
    'gi'
  );
  const found: Site[] = [];
  for (const [file, text] of files)
    for (const match of text.matchAll(insert))
      found.push({ file, line: text.slice(0, match.index).split('\n').length, columns: match[1] });
  return found;
}

/** A site that writes its own columns, rather than the stamp's, would carry no author. */
function unstamped(files: Map<string, string>): string[] {
  return sites(files)
    .filter((site) => !(site.file in LEFT))
    .filter((site) => {
      if (/\bg\.columns\b|\bgenesis\.columns\b/.test(site.columns)) return false;
      const text = files.get(site.file) ?? '';
      return !(
        /\$\{\s*insertColumns\s*\}/.test(site.columns) &&
        /\.push\(\.\.\.genesis\.columns\)/.test(text)
      );
    })
    .map((site) => `${site.file}:${site.line} writes its own columns`);
}

describe('author stamp coverage', () => {
  it('gives every production insert into a logged table the stamp, as published', () => {
    const files = sources();
    const found = sites(files);
    expect(found).toHaveLength(29);
    const left: Record<string, number> = {};
    for (const site of found) if (site.file in LEFT) left[site.file] = (left[site.file] ?? 0) + 1;
    expect(left).toEqual({ 'tools/rbook/sync-merge.ts': 5, 'tools/rbook/genesis-columns.ts': 1 });
    expect(unstamped(files)).toEqual([]);
  });

  it('fails a new insert that writes its own columns, bare or in any quoting', () => {
    const files = sources();
    files.set(
      'tools/rbook/new-writer.ts',
      "const sql = `INSERT INTO context_snapshots (context_id, content, event_type) VALUES (?, ?, 'context_snapshotted')`;\n" +
        'const quoted = `INSERT INTO "learnings" (content, created_at) VALUES (?, ?)`;\n' +
        "const single = `INSERT INTO 'constraints' (content) VALUES (?)`;\n" +
        "const backticked = 'INSERT INTO `sprints` (title) VALUES (?)';\n" +
        'const bracketed = `INSERT INTO [missions] (name) VALUES (?)`;'
    );
    expect(unstamped(files)).toEqual(
      [1, 2, 3, 4, 5].map((line) => `tools/rbook/new-writer.ts:${line} writes its own columns`)
    );
  });

  it('fails a production site that stops splicing the stamp', () => {
    const files = sources();
    const sprint = 'tools/rbook/rbook-sprint-add.ts';
    files.set(sprint, files.get(sprint)!.replace(/\$\{g\.columns\.join\(', '\)\}/g, 'event_type'));
    expect(unstamped(files)).toEqual([
      expect.stringMatching(/^tools\/rbook\/rbook-sprint-add\.ts:\d+/),
    ]);
  });
});

describe('the stamp carries the author', () => {
  let tmp: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-author-stamp-')));
    saved = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
    writeUserAuthor('Ada Lovelace');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(FIREHOSE_TABLES)(
    'on %s, through a client and through a raw connection',
    async (table) => {
      const root = path.join(tmp, 'project');
      const dbPath = seedRbookDb(root, { projectId: 'p-stamp' });
      const client = (await RbookDatabaseClient.create({ dbPath })).data!;
      try {
        // An unshared store stamps without a transaction; its lazy migrations run first.
        const stamp = genesisColumns(client, table, 'p-stamp');
        expect(stamp.values[stamp.columns.indexOf('author_name')]).toBe('Ada Lovelace');
        expect(stamp.columns).toContain('author_user_id');
      } finally {
        client.close();
      }
      const db = new Database(dbPath);
      try {
        const raw = rawGenesisColumns(db, table, 'p-stamp');
        expect(raw.values[raw.columns.indexOf('author_name')]).toBe('Ada Lovelace');
      } finally {
        db.close();
      }
    }
  );
});

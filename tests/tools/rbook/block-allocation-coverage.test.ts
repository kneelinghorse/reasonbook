// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (practice 2) — every production INSERT into a block table takes its id from genesisColumns,
// ABOUTME: and every create of a shared table takes the copy's next sequence, so a lost one can be counted.
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { BLOCK_TABLES, SHARED_TABLES } from '../../../src/tools/rbook/replica-identity';

const SRC = path.resolve(__dirname, '../../../src');

/**
 * The published universe (rbook/research/2026-10-s96-probes/s96-m01-identity-build.md, class A):
 * the objective's predicate over src, 11 lines at 92e0121; 12 since s100-m03's next-step insert at
 * capture, a ninth production site through the stamp. Left, each for its reason:
 * - sync-merge.ts, the retired sync, refused from 4.1.0 (s96-m08), inserts the origin's own ids;
 * - genesis-columns.ts holds a documentation example, inside a comment.
 * Outside the predicate: spin-out-copy.ts's dynamic insert writes into another project's store.
 */
const LEFT: Readonly<Record<string, string>> = {
  'tools/rbook/sync-merge.ts': 'the retired sync, refused from 4.1.0',
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
  readonly table: string;
  readonly columns: string;
}

/** Each INSERT into one of `tables`, with the column region up to VALUES or SELECT. */
function sites(files: Map<string, string>, tables: ReadonlySet<string> = BLOCK_TABLES): Site[] {
  const insert = new RegExp(
    `INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(${[...tables].join('|')})\\b([\\s\\S]*?)(?:VALUES|SELECT)\\b`,
    'gi'
  );
  const found: Site[] = [];
  for (const [file, text] of files)
    for (const match of text.matchAll(insert))
      found.push({
        file,
        line: text.slice(0, match.index).split('\n').length,
        table: match[1],
        columns: match[2],
      });
  return found;
}

/** Why a site would bypass the block, or null when it takes its id from the stamp. */
function bypass(site: Site, text: string): string | null {
  if (/(?:^|[(,\s])id\s*[,)]/.test(site.columns)) return 'names its own id';
  if (/\bg\.columns\b|\bgenesis\.columns\b/.test(site.columns)) return null;
  // The dynamic form: a column list built in a variable that the stamp extends.
  if (
    /\$\{\s*insertColumns\s*\}/.test(site.columns) &&
    /\.push\(\.\.\.genesis\.columns\)/.test(text)
  )
    return null;
  return 'does not take the genesis stamp';
}

/** How many sites each left file holds; pinned, so a new create in a left file is not passed unseen. */
function leftCounts(found: readonly Site[], left: Readonly<Record<string, string>>) {
  const counts: Record<string, number> = {};
  for (const site of found) if (site.file in left) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return counts;
}

function violations(files: Map<string, string>): string[] {
  return sites(files)
    .filter((site) => !(site.file in LEFT))
    .flatMap((site) => {
      const why = bypass(site, files.get(site.file) ?? '');
      return why ? [`${site.file}:${site.line} ${why}`] : [];
    });
}

describe('block allocation coverage', () => {
  it('routes every production insert into a block table through the stamp', () => {
    const files = sources();
    const production = sites(files).filter((site) => !(site.file in LEFT));
    // 9 production sites, as published (8, and s100-m03's); a change must update the class.
    expect(production).toHaveLength(9);
    expect(leftCounts(sites(files), LEFT)).toEqual({
      'tools/rbook/sync-merge.ts': 2,
      'tools/rbook/genesis-columns.ts': 1,
    });
    expect(violations(files)).toEqual([]);
  });

  it('fails a new insert that names its own id, or skips the stamp', () => {
    const files = sources();
    files.set(
      'tools/rbook/new-writer.ts',
      'const sql = `INSERT INTO learnings (id, content, created_at) VALUES (?, ?, ?)`;\n' +
        'const other = `INSERT INTO constraints (content, created_at) VALUES (?, ?)`;'
    );
    expect(violations(files)).toEqual([
      'tools/rbook/new-writer.ts:1 names its own id',
      'tools/rbook/new-writer.ts:2 does not take the genesis stamp',
    ]);
  });

  it('fails a production site that stops splicing the stamp', () => {
    const files = sources();
    const capture = 'tools/rbook/rbook-session-capture.ts';
    files.set(
      capture,
      files.get(capture)!.replace(/\$\{g\.columns\.join\(', '\)\}/g, 'origin_seq')
    );
    // Learnings, constraints and, since s100-m03, next steps.
    expect(violations(files).filter((v) => v.startsWith(capture))).toHaveLength(3);
  });
});

/**
 * Class E (rbook/research/2026-10-s96-probes/s96-m01-identity-build.md), published at the build
 * critics' fold: the same predicate over the nine shared tables, 23 matches at 32e4974, plus
 * s100-m03's next-step insert and s102-m03's mission-session link (25 now). A
 * create takes the copy's next sequence through the genesis stamp, or by name for the two link
 * tables, which take no stamp. Left, each for its reason, beside class A's two:
 * - rbook-project-init.ts writes through a raw connection and seeds nothing into a shared copy;
 * - spin-out-copy.ts writes only between projects that are not shared.
 */
const SHARED_LEFT: Readonly<Record<string, string>> = {
  ...LEFT,
  'tools/rbook/rbook-project-init.ts': 'seeds no sprint or mission into a shared copy',
  'tools/rbook/spin-out-copy.ts': 'spin-out refuses a shared store on either side',
};

function unsequenced(files: Map<string, string>): string[] {
  return sites(files, SHARED_TABLES)
    .filter((site) => !(site.file in SHARED_LEFT))
    .flatMap((site) => {
      const text = files.get(site.file) ?? '';
      if (/\bg\.columns\b|\bgenesis\.columns\b/.test(site.columns)) return [];
      if (
        /\$\{\s*insertColumns\s*\}/.test(site.columns) &&
        /\.push\(\.\.\.genesis\.columns\)/.test(text)
      )
        return [];
      if (text.includes(`takeReplicaSeq(client, '${site.table}')`)) return [];
      return [`${site.file}:${site.line} ${site.table} takes no sequence`];
    });
}

describe('sequence coverage', () => {
  it('gives every production create of a shared table the next sequence', () => {
    const files = sources();
    const production = sites(files, SHARED_TABLES).filter((site) => !(site.file in SHARED_LEFT));
    // 15 production sites: the prior 14 plus mission-session-link.ts's session_missions insert.
    // The same sequence requirement applies to the new link; the unsequenced check stays intact.
    expect(production).toHaveLength(15);
    expect(leftCounts(sites(files, SHARED_TABLES), SHARED_LEFT)).toEqual({
      'tools/rbook/sync-merge.ts': 6,
      'tools/rbook/genesis-columns.ts': 1,
      'tools/rbook/rbook-project-init.ts': 2,
      'tools/rbook/spin-out-copy.ts': 1,
    });
    expect(unsequenced(files)).toEqual([]);
  });

  it('fails a new create added to a file that is left', () => {
    const files = sources();
    const init = 'tools/rbook/rbook-project-init.ts';
    files.set(
      init,
      `${files.get(init)!}\nconst extra = \`INSERT INTO sessions (id, type) VALUES (?, ?)\`;\n`
    );
    expect(leftCounts(sites(files, SHARED_TABLES), SHARED_LEFT)[init]).toBe(3);
  });

  it('fails a new create that takes no sequence', () => {
    const files = sources();
    files.set(
      'tools/rbook/new-writer.ts',
      'const sql = `INSERT INTO mission_dependencies (from_id, to_id, type) VALUES (?, ?, ?)`;'
    );
    expect(unsequenced(files)).toEqual([
      'tools/rbook/new-writer.ts:1 mission_dependencies takes no sequence',
    ]);
  });

  it('fails a link site that stops taking its sequence', () => {
    const files = sources();
    const depends = 'tools/rbook/rbook-mission-depends.ts';
    files.set(depends, files.get(depends)!.replace(/takeReplicaSeq\(client, '[a-z_]+'\);?/g, ''));
    expect(unsequenced(files)).toEqual([
      expect.stringMatching(
        /^tools\/rbook\/rbook-mission-depends\.ts:\d+ mission_dependencies takes no sequence$/
      ),
    ]);
  });
});

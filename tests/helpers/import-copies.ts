// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14's copies made before sharing: the owner's project written to before it is shared, a zip of its folder,
// ABOUTME: a copy in an older schema built from a fixture, and raw SQL on a store, each on its own machine.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { call, dbOf, project, useMachine } from './replica-fixture';
import type { Copy } from './shared-copies';

export type Place = Pick<Copy, 'root' | 'machine'>;

/** A tool call on a place's own machine; it throws when the call fails. */
export async function onPlace(
  tmp: string,
  place: Place,
  tool: string,
  args: Record<string, unknown>
) {
  useMachine(tmp, place.machine);
  const answer = await call(tool, { ...args, projectRoot: place.root });
  if (!answer.success) throw new Error(`${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** The owner's project before sharing: a sprint, a mission and a decision. */
export async function preShare(
  tmp: string,
  options: { base?: boolean; marker?: boolean } = {}
): Promise<Place> {
  const on = (place: Place, tool: string, args: Record<string, unknown>) =>
    onPlace(tmp, place, tool, args);
  const owner = { root: project(tmp, 'owner'), machine: 'machine-owner' };
  await on(owner, 'rbook_sprint', {
    action: 'add',
    sprintId: 'i-sprint',
    title: 'One',
    status: 'Planned',
  });
  await on(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'i-m01',
    name: 'Before the copy',
    sprintId: 'i-sprint',
  });
  await on(owner, 'rbook_decisions', { action: 'record', content: 'Decided before the copy.' });
  if (options.marker)
    await on(owner, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
  if (options.base) await on(owner, 'rbook_db', { action: 'snapshot' });
  return owner;
}

/** A zip of the project's folder as it is now: its store, and its snapshots when it keeps some. */
export function zipOf(tmp: string, from: Place, name = 'zip'): Place {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const snapshots = path.join(path.dirname(dbOf(from.root)), 'snapshots');
  if (fs.existsSync(snapshots))
    fs.cpSync(snapshots, path.join(path.dirname(dbOf(root)), 'snapshots'), { recursive: true });
  return { root, machine: 'machine-studio' };
}

/**
 * A copy made before sharing in an older schema (`tests/fixtures/old-schemas`): its tables as that
 * schema made them, holding the rows the owner's store holds now, and the project's name and id.
 */
export function oldCopyOf(tmp: string, from: Place, schema: string): Place {
  const root = path.join(tmp, 'zip');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const db = new Database(dbOf(root));
  try {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'old-schemas', schema), 'utf8'));
    db.exec(`ATTACH DATABASE '${dbOf(from.root).replace(/'/g, "''")}' AS owner`);
    const columns = (schemaName: string, table: string) =>
      (
        db.prepare(`PRAGMA ${schemaName}.table_info(${table})`).all() as Array<{ name: string }>
      ).map((column) => column.name);
    for (const { name } of db
      .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name <> 'metadata'")
      .all() as Array<{ name: string }>) {
      const theirs = new Set(columns('owner', name));
      // The one rename since (universe 2): an old schema keeps a decision's session as session_id.
      const source = (column: string) =>
        theirs.has(column)
          ? column
          : column === 'session_id' && theirs.has('author_session_id')
            ? 'author_session_id'
            : null;
      const both = columns('main', name).filter((column) => source(column));
      if (both.length)
        db.exec(
          `INSERT INTO main.${name} (${both.join(', ')}) SELECT ${both.map(source).join(', ')} FROM owner.${name}`
        );
    }
    db.exec(
      "INSERT INTO main.metadata (key, value) SELECT key, value FROM owner.metadata WHERE key IN ('project_id', 'project_name')"
    );
    db.exec('DETACH DATABASE owner');
  } finally {
    db.close();
  }
  return { root, machine: 'machine-studio' };
}

/** Raw SQL on a store, as an older schema or another tool would have left it. */
export function onFile(place: Place, ...statements: string[]): void {
  const db = new Database(dbOf(place.root));
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

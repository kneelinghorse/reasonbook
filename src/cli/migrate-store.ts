// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Holds the record's exclusive lock and a migration guard while it backs up and renames it.
// ABOUTME: A durable journal rolls an interrupted cutover back without overwriting another writer.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { LEGACY } from '../intelligence/legacy-compat';
import {
  cutoverSeams,
  JOURNAL,
  LOCK,
  pendingAfterCommit,
  PENDING,
  release,
  writeMigrationState,
  type Journal,
} from './migrate-state';
import { rollback } from './migrate-rollback';
import { restoreWal, verify } from './migrate-wal';
import { assertNoOpenFiles, assertNoRecordProcesses } from './migrate-guard';
import {
  exposureRefusal,
  listIgnored,
  liveBackstop,
  planIgnores,
  recordIgnoreEdit,
  restoreTwins,
  shown,
  visibleToGit,
  writeTwins,
  type WrittenTwins,
} from './migrate-ignore';

export {
  cutoverSeams,
  JOURNAL,
  PENDING,
  readPending,
  writeMigrationState,
  writePending,
} from './migrate-state';
export type { PendingMarker } from './migrate-state';
export { recoverMigration } from './migrate-rollback';
/**
 * s108-m05: whether a record may have synced with a peer, which is what a 4.1 to 4.9 server's sync
 * list remembers: it keeps a project it once saw shared, after its route is forgotten (round 3).
 * Only a readable store with no record_peers table, which a record's first peer makes and no
 * release drops, never did.
 */
export function mayHaveSynced(dbPath: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'").get()
    );
  } catch {
    // Not read, so not known never to have synced.
    return true;
  } finally {
    db?.close();
  }
}

export interface MovedRecord {
  readonly backup: string;
  /** What the move leaves for the owner: its edits, the lines it did not edit, the journal mode. */
  readonly left: string[];
}

export function moveRecord(
  root: string,
  checkProcesses = true,
  env: NodeJS.ProcessEnv = process.env
): MovedRecord {
  const source = path.join(root, LEGACY.recordDirectory);
  const destination = path.join(root, 'rbook');
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      'Refusing migration because both record folders exist; inspect them before retrying.'
    );
  if (fs.lstatSync(source).isSymbolicLink())
    throw new Error(`Refusing a symlinked record directory: ${source}`);
  // s108-m05 (round 2): the rename would overwrite a store already named rbook.sqlite in the old
  // folder, and a journal or log under that name would be applied to the moved store when it opens.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stray = path.join(source, 'db', `rbook.sqlite${suffix}`);
    // lstat, so a link there, even one to nothing, is not replaced unseen (round 3).
    if (fs.lstatSync(stray, { throwIfNoEntry: false }))
      throw new Error(
        `Refusing migration because ${stray} already exists and the move would overwrite or apply it; inspect it before retrying.`
      );
  }
  const dbPath = path.join(source, 'db', LEGACY.databaseFile);
  // A 4.1 to 4.9 server that syncs a record ends at a sync during its move (round 2), so a record
  // that may ever have synced waits for every runtime (round 3). s109-m01 (#915): checked before
  // the guard exists too, so a refused move never makes it; the check after closes the race.
  const scope = () => (mayHaveSynced(dbPath) ? 'shared' : 'pre-guard');
  if (checkProcesses) assertNoRecordProcesses(scope());
  // s109-m01: git's answers come before any write; a git that cannot run in a work tree refuses.
  const ignores = planIgnores(root, env);
  fs.mkdirSync(lock);
  writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid });
  let journal: Journal | undefined;
  // s108-m05: one connection holds the record's exclusive lock from the backup through both renames,
  // so a handle any process opens meanwhile can write nothing (E5 F8). Copying or reading the file
  // another way in this process would silently drop that lock, so the backup is VACUUM INTO.
  let held: Database.Database | undefined;
  const letGo = () => {
    if (held?.open) held.close();
  };
  let journalMode = '';
  let switched = false;
  let twins: WrittenTwins[] = [];
  const backupRelative = path.join('db', 'snapshots', `pre-migrate-${randomUUID()}.sqlite`);
  const left = [...ignores.left];
  try {
    if (checkProcesses) assertNoRecordProcesses(scope());
    assertNoOpenFiles(source, undefined, { refuseSlowWarnings: true });
    if (fs.lstatSync(dbPath).nlink > 1)
      throw new Error(`Refusing a hardlinked database: ${dbPath}`);
    if (fs.lstatSync(dbPath).isSymbolicLink())
      throw new Error(`Refusing a symlinked database: ${dbPath}`);
    held = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    journalMode = String(held.pragma('journal_mode', { simple: true }));
    // Beside the pid, before the switch: recovery of a move that dies before its journal restores it.
    writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid, journalMode });
    const checkpoint = held.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((row) => row.busy !== 0))
      throw new Error('Database checkpoint is busy; close all clients before migration.');
    // The switch from WAL comes first: made under the exclusive mode, its rollback journal would
    // stay until the close, which comes after the renames and no longer finds it (round 1).
    const beside = (suffix: string) => fs.existsSync(`${dbPath}${suffix}`);
    const [hadWal, hadJournal] = [beside('-wal'), beside('-journal')];
    held.pragma('journal_mode = DELETE');
    switched = true;
    held.pragma('locking_mode = EXCLUSIVE');
    held.exec('BEGIN EXCLUSIVE; COMMIT;');
    const wal = `${dbPath}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size !== 0)
      throw new Error(`Uncheckpointed WAL remains at ${wal}; nothing was moved.`);
    // From the switch to the lock another process could switch the store back to WAL or leave a
    // journal, which would stay behind under the old name; the move refuses instead (round 2).
    if (
      String(held.pragma('journal_mode', { simple: true })) !== 'delete' ||
      (!hadWal && beside('-wal')) ||
      (!hadJournal && beside('-journal'))
    )
      throw new Error(
        'Another process used the record as the move began; nothing was moved. Retry once it is done.'
      );
    fs.mkdirSync(path.join(source, 'db', 'snapshots'), { recursive: true });
    held.prepare('VACUUM INTO ?').run(path.join(source, backupRelative));
    // s109-m01: judged by the backstop after migrate's writes, listed before any of them.
    const listed = listIgnored(ignores);
    const ignore = path.join(source, '.gitignore');
    const ignoreStat = fs.lstatSync(ignore, { throwIfNoEntry: false });
    // s109-m01: never written through a link, which git does not read as a .gitignore.
    const edited = !ignoreStat?.isSymbolicLink();
    const original = ignoreStat && edited ? fs.readFileSync(ignore) : null;
    journal = {
      pid: process.pid,
      source,
      destination,
      originalIgnore: original?.toString('utf8') ?? null,
      ...(original ? { originalIgnoreBytes: original.toString('base64') } : {}),
      ignoreEdited: edited,
      ignoreMode: ignoreStat && edited ? ignoreStat.mode & 0o7777 : 0o644,
      backup: path.join(destination, backupRelative),
      journalMode,
      folder: ignores.folder,
      steps: [...(ignores.git ? ['the git index'] : []), 'documents', 'registration'],
      phase: 'prepared',
    };
    writeMigrationState(file, journal);
    if (edited) {
      fs.writeFileSync(
        ignore,
        recordIgnoreEdit(original?.toString('latin1') ?? '', ignores.trackedSnapshots),
        'latin1'
      );
      left.push(
        `${path.join(destination, '.gitignore')}: migrate added its store and backup lines.`
      );
    } else
      left.push(
        `${path.join(destination, '.gitignore')} is a symlink, which git does not read as a .gitignore; migrate did not write through it.`
      );
    cutoverSeams.beforeFinalCheck();
    // Nothing but this process's held connection may have the record open now.
    assertNoOpenFiles(source, process.pid);
    // s109-m01: the twins match nothing until the rename; the backstop checks that no ignored file
    // would become visible with them in place, judged by each file's deciding rule.
    twins = writeTwins(ignores);
    const exposed = liveBackstop(ignores, listed);
    if (exposed.length) throw new Error(exposureRefusal(exposed));
    for (const link of ignores.chain)
      if (link.added.length)
        left.push(`${link.file}: migrate added ${link.added.map(shown).join(', ')}.`);
    cutoverSeams.beforeRename();
    // Each phase is advanced in memory only once its write is durable, so a failed write leaves
    // rollback reading the phase on disk (build critic A, note 10).
    writeMigrationState(file, { ...journal, phase: 'folder' });
    journal.phase = 'folder';
    fs.renameSync(source, destination);
    writeMigrationState(file, { ...journal, phase: 'database' });
    journal.phase = 'database';
    fs.renameSync(
      path.join(destination, 'db', LEGACY.databaseFile),
      path.join(destination, 'db', 'rbook.sqlite')
    );
    letGo();
    // s109-m01: after both renames a store that cannot go back to WAL commits the move and says so;
    // a completed move is never rolled back for it.
    const moved = path.join(destination, 'db', 'rbook.sqlite');
    left.push(...verify(moved, journalMode));
    writeMigrationState(file, { ...journal, phase: 'committed' });
    journal.phase = 'committed';
    // The marker names each follow-up before any runs, so a crash leaves them to a retry.
    writeMigrationState(path.join(root, PENDING), pendingAfterCommit(journal));
    release(root);
    return { backup: journal.backup, left };
  } catch (error) {
    // Rollback's own open-file check must not find this process's handle.
    letGo();
    const message = (error as Error).message;
    // s109-m01: a backup git can see would go into the next git add -A (build critic A, note 6),
    // judged once rollback has put the record's own .gitignore back; it is looked for in both
    // folders, since a rollback that failed may leave it under rbook/ (round-2 verifier A, note 2).
    const named = (): string[] => {
      const folder = [ignores.folder, 'rbook'].find((name) =>
        fs.existsSync(path.join(root, name, backupRelative))
      );
      return folder
        ? [
            `The attempt left a backup, ${path.join(root, folder, backupRelative)}; it may be deleted once the record has moved.${
              visibleToGit(ignores, `${folder}/${backupRelative}`)
                ? ' git can see it, so git add -A would commit a copy of the record: delete it, or ignore db/snapshots/, before you commit.'
                : ''
            }`,
          ]
        : [];
    };
    if (journal && journal.phase !== 'committed') {
      let notes: string[];
      try {
        notes = rollback(root, journal);
      } catch (recovery) {
        throw new Error(
          [`${message}; recovery failed: ${(recovery as Error).message}`, ...named()].join(' ')
        );
      }
      // The folder is back where it was, so its twins match nothing; they go too, unless edited since.
      notes.push(...restoreTwins(twins));
      throw new Error([message, ...notes, ...named()].join(' '));
    }
    if (!journal) {
      // s109-m01: a refusal after the switch from WAL puts the store back, or says it could not.
      const notes = switched && journalMode === 'wal' ? restoreWal(dbPath) : [];
      release(root);
      const backupNote = named();
      if (notes.length || backupNote.length)
        throw new Error([message, ...notes, ...backupNote].join(' '));
    }
    throw error;
  }
}

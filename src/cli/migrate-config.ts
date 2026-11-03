// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared configuration moves only when every configured client can read its new location.
// ABOUTME: Offline checkpointing and a durable recovery receipt keep credentials and registry together.
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { LEGACY, getSetting } from '../intelligence/legacy-compat';
import type { RbookToolResult } from '../tools/rbook/types';
import { assertModernClients, assertNoRecordProcesses, assertNoOpenFiles } from './migrate-guard';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { writeMigrationState } from './migrate-store';
import { CLIENT_BUSY_MS, walFailure } from './migrate-wal';
import type { MigrationResult } from './migrate';

/** A registry left out of WAL, and why: another program's lock, or the error itself. */
type Held = readonly [name: string, reason: string];

/**
 * s109-m01 (#913's class): a note for each registry a refusal or a result says stayed out of WAL,
 * naming its own cause, so damage is never blamed on another program (round-3 verifier A, note 1).
 */
const stayed = (directory: string, held: readonly Held[]): string[] =>
  [...new Map(held)].map(
    ([name, reason]) =>
      `${path.join(directory, name)} stayed in rollback-journal mode: ${reason}. Each Reasonbook client switches a registry back when it next opens it.`
  );

export async function migrateConfig(
  env: NodeJS.ProcessEnv,
  apply: boolean
): Promise<RbookToolResult<MigrationResult>> {
  const home = env.HOME ?? os.homedir();
  const parent = path.join(home, '.config');
  const source = path.join(parent, LEGACY.configDirectory);
  const destination = path.join(parent, 'rbook');
  const recovery = path.join(parent, '.rbook-config-migration.json');
  const lock = path.join(parent, '.rbook-config-migration.lock');
  let acquired = false;
  let release: (() => void) | undefined;
  /**
   * Checks each registry and puts a WAL one back in WAL, within the clients' busy timeout; returns
   * those that stayed in rollback-journal mode, each with why, which no longer refuse (s109-m01).
   */
  const restoreModes = (
    directory: string,
    modes: Record<string, string>,
    renamed = true
  ): Held[] => {
    const held: Held[] = [];
    for (const [name, mode] of Object.entries(modes)) {
      if (path.basename(name) !== name || !name.endsWith('.sqlite'))
        throw new Error(`Invalid recovery database: ${name}`);
      const db = new Database(path.join(directory, name), {
        fileMustExist: true,
        timeout: CLIENT_BUSY_MS,
      });
      try {
        // When nothing was renamed the move wrote no row (it switched the mode and copied a backup),
        // so only the mode goes back: an integrity check a late writer's lock outlasts kept the guard.
        if (renamed && db.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error(`Integrity check failed for ${name}`);
        const failure = mode === 'wal' ? walFailure(db) : null;
        if (failure) held.push([name, failure]);
      } finally {
        db.close();
      }
    }
    return held;
  };
  const modes: Record<string, string> = {};
  // Registries recovery could not put back in WAL, named where they end up (build critic A, note 5).
  let recoveredHeld: Held[] = [];
  try {
    if (getSetting('RBOOK_CONFIG_DIR', env) !== undefined)
      throw new Error(
        'Unset RBOOK_CONFIG_DIR and its legacy setting before moving the default shared config folder.'
      );
    if (apply && fs.existsSync(parent)) release = acquireMigrationExclusion(parent);
    if (fs.existsSync(recovery) || fs.existsSync(lock)) {
      if (!apply)
        throw new Error(
          `An interrupted config migration needs reasonbook migrate --config --apply; recovery record: ${recovery}`
        );
      assertModernClients(home, true);
      assertNoRecordProcesses();
      const receipt = fs.existsSync(recovery)
        ? (JSON.parse(fs.readFileSync(recovery, 'utf8')) as {
            pid: number;
            source: string;
            destination: string;
            modes: Record<string, string>;
          })
        : null;
      const ownerFile = path.join(lock, 'owner.json');
      const pid =
        receipt?.pid ??
        (fs.existsSync(ownerFile)
          ? (JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid: number }).pid
          : null);
      let alive = true;
      if (pid && Number.isInteger(pid)) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (alive) throw new Error(`Config migration has a live or unknown owner; retained ${lock}.`);
      if (receipt && (receipt.source !== source || receipt.destination !== destination))
        throw new Error(`Invalid recovery paths in ${recovery}.`);
      if (fs.existsSync(source) && fs.existsSync(destination))
        throw new Error(
          'Cannot recover config while both directories exist; neither was overwritten.'
        );
      const current = fs.existsSync(destination) ? destination : source;
      // s109-m01 (#913): with the folder where it was, recovery renames nothing, so a program
      // holding a file there no longer keeps the guard that refuses every client's shared config.
      if (current === destination) {
        assertNoOpenFiles(current);
        fs.renameSync(destination, source);
      }
      recoveredHeld = receipt ? restoreModes(source, receipt.modes, current === destination) : [];
      fs.rmSync(recovery, { force: true });
      fs.rmSync(lock, { recursive: true, force: true });
    }
    if (fs.existsSync(source) && fs.existsSync(destination))
      throw new Error('Refusing config migration because both config folders exist.');
    if (!fs.existsSync(source))
      return {
        success: true,
        data: {
          dryRun: !apply,
          moved: false,
          changed: [],
          left: stayed(source, recoveredHeld),
        },
      };
    if (!apply)
      return {
        success: true,
        data: { dryRun: true, moved: false, changed: [`${source} -> ${destination}`], left: [] },
      };
    assertModernClients(home, true);
    // s109-m01 (#915): checked before the guard exists too, so a refused move never makes it; the
    // check after it closes the race of a runtime starting in between.
    assertNoRecordProcesses();
    fs.mkdirSync(lock);
    acquired = true;
    writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid });
    assertNoRecordProcesses();
    assertNoOpenFiles(source);
    for (const name of fs.readdirSync(source).filter((entry) => entry.endsWith('.sqlite'))) {
      const file = path.join(source, name);
      // Takes its lock now or refuses: the move must never wait on a client holding a registry.
      const db = new Database(file, { fileMustExist: true, timeout: 0 });
      try {
        const mode = String(db.pragma('journal_mode', { simple: true }));
        const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (rows.some((row) => row.busy)) throw new Error(`${file} is busy; no folder was moved.`);
        db.pragma('locking_mode = EXCLUSIVE');
        modes[name] = mode;
        db.pragma('journal_mode = DELETE');
        db.exec('BEGIN EXCLUSIVE; COMMIT;');
        fs.copyFileSync(file, `${file}.pre-migrate-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
      } finally {
        db.close();
      }
    }
    writeMigrationState(recovery, {
      pid: process.pid,
      source,
      destination,
      modes,
      phase: 'prepared',
    });
    assertNoOpenFiles(source);
    fs.renameSync(source, destination);
    // s109-m01: a registry another program keeps in rollback-journal mode no longer rolls the
    // completed move back; the result says which.
    const held = restoreModes(destination, modes);
    fs.rmSync(recovery);
    fs.rmSync(lock, { recursive: true });
    acquired = false;
    return {
      success: true,
      data: {
        dryRun: false,
        moved: true,
        changed: [`${source} -> ${destination}`],
        left: stayed(destination, [...recoveredHeld, ...held]),
      },
    };
  } catch (error) {
    let held: Held[] = [];
    try {
      let renamedBack = false;
      if (acquired && fs.existsSync(destination)) {
        if (fs.existsSync(source))
          throw new Error(`Cannot restore ${source}: another writer created it.`);
        assertNoOpenFiles(destination);
        fs.renameSync(destination, source);
        renamedBack = true;
      }
      if (acquired) {
        // s109-m01: a refusal after a registry left WAL puts it back, or says which stayed out.
        if (Object.keys(modes).length && fs.existsSync(source))
          held = restoreModes(source, modes, renamedBack);
        fs.rmSync(recovery, { force: true });
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch (rollback) {
      return {
        success: false,
        error: {
          code: 'MIGRATION_RECOVERY_REQUIRED',
          message: `${(error as Error).message}; ${(rollback as Error).message}`,
          suggestion: `Preserved recovery record ${recovery} and migration guard ${lock}; resolve the conflicting path or open handle before retrying.`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'MIGRATION_REFUSED',
        message: [
          error instanceof Error ? error.message : String(error),
          ...stayed(source, [...recoveredHeld, ...held]),
        ].join(' '),
        suggestion:
          'Use Reasonbook 4.x in every configured client and close all clients using the shared config, then retry.',
      },
    };
  } finally {
    release?.();
  }
}

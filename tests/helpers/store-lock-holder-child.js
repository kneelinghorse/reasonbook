// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s105-m01 — a separate process that holds a SQLite store exclusively, readers included, even in WAL.
// ABOUTME: It waits for the store to be free, then holds until a marker appears and a set time after it.
const fs = require('fs');
const Database = require('better-sqlite3');

const config = JSON.parse(process.argv[2]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const busy = (error) =>
  typeof error?.code === 'string' &&
  (error.code === 'SQLITE_BUSY' || error.code.startsWith('SQLITE_BUSY_'));
const send = (message) => new Promise((resolve) => process.send(message, () => resolve()));

/** Another connection with the store open refuses the exclusive lock at once, so retry within budget. */
async function take() {
  const started = Date.now();
  for (let attempts = 1; ; attempts += 1) {
    let db;
    try {
      db = new Database(config.dbPath, { fileMustExist: true, timeout: 0 });
      // Exclusive locking mode keeps the lock for the connection's life and, in WAL, bypasses the
      // shared-memory index, so no other connection can read until it closes.
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return { db, attempts, freeWaitMs: Date.now() - started };
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* The attempt's own connection only. */
      }
      if (!busy(error) || Date.now() - started >= config.freeWaitMs) throw error;
      // Said once, so a caller can know the holder met the other connection rather than guess.
      if (attempts === 1) await send({ type: 'waiting' });
      await pause(5);
    }
  }
}

async function main() {
  // The parent owns this process; if it goes away, exiting releases the lock with it.
  process.on('disconnect', () => process.exit(2));
  let held;
  try {
    held = await take();
  } catch (error) {
    await send({ type: 'error', phase: 'take', code: error.code ?? null, message: error.message });
    process.exit(1);
  }
  const record = {
    attempts: held.attempts,
    freeWaitMs: held.freeWaitMs,
    heldAt: now(),
    marker: config.marker,
    sawMarker: null,
    markerSeenAt: null,
    afterMarkerMs: config.afterMarkerMs,
    releasedAt: null,
  };
  await send({ type: 'held', record });
  if (config.marker !== null) {
    const started = Date.now();
    while (!fs.existsSync(config.marker) && Date.now() - started < config.markerWaitMs)
      await pause(2);
    record.sawMarker = fs.existsSync(config.marker);
    record.markerSeenAt = record.sawMarker ? now() : null;
  }
  await pause(config.afterMarkerMs);
  held.db.exec('COMMIT');
  held.db.close();
  record.releasedAt = now();
  await send({ type: 'released', record });
  process.exit(0);
}

main();

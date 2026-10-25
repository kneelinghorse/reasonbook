#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Runs the fixed release load check against a mechanically selected test population.
// ABOUTME: Owns bounded child groups and retains every report, diagnostic and cleanup receipt.
const { HISTORICAL_FAILURES, selectTests, summarizeReport, git } = require('./test-load-contract');
const BUDGET_MS = 30 * 60 * 1000;
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, fork } = require('child_process');
const { performance } = require('perf_hooks');
const { waitForGroups } = require('./test-load-worker');
const worker = path.join(__dirname, 'test-load-worker.js');
const sorted = (values) => [...new Set(values)].sort();
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function settleWithin(promises, ms) {
  let timer;
  try {
    await Promise.race([
      Promise.all(promises),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runGate({ root = path.resolve(__dirname, '..'), outputDir, budgetMs = BUDGET_MS }) {
  const start = performance.now();
  const startedAt = new Date().toISOString();
  if (process.platform === 'win32')
    throw new Error('The load gate requires POSIX child process groups');
  if (!Number.isFinite(budgetMs) || budgetMs <= 1000 || budgetMs > BUDGET_MS)
    throw new Error('Invalid load budget');
  root = fs.realpathSync(root);
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root)
    throw new Error('Use the Git checkout root');
  if (git(root, 'status', '--porcelain'))
    throw new Error('The load gate requires a clean committed tree');
  outputDir = path.resolve(outputDir);
  outputDir = path.join(fs.realpathSync(path.dirname(outputDir)), path.basename(outputDir));
  if (!path.relative(root, outputDir).startsWith('..' + path.sep))
    throw new Error('Keep load receipts outside the checkout');
  fs.mkdirSync(outputDir);
  const manifest = path.join(root, 'dist/.build-manifest.json');
  const receipt = {
    success: false,
    reason: null,
    startedAt,
    budgetMs,
    headBefore: git(root, 'rev-parse', 'HEAD'),
    buildManifestBefore: hash(manifest),
    spinners: [],
    processes: [],
    runs: [],
    diagnostics: [],
    loadBefore: os.loadavg(),
  };
  const active = new Set();
  const owned = [];
  let stopping = false,
    timer,
    rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  // An abort can arrive between awaits; attach its rejection handler immediately.
  aborted.catch(() => {});
  const stop = (reason) => rejectAbort(new Error(reason));
  const onInt = () => stop('Interrupted by SIGINT');
  const onTerm = () => stop('Interrupted by SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const saveRunning = () =>
    write(path.join(outputDir, 'running.json'), {
      spinners: receipt.spinners,
      processes: receipt.processes,
    });
  function own(child, label, spinner, fd) {
    const record = { pid: child.pid, label, spinner, startedAt: new Date().toISOString() };
    receipt.processes.push(record);
    const job = { child, record };
    active.add(job);
    owned.push(job);
    job.done = new Promise((resolve) => {
      child.on('error', (error) => {
        record.error = error.message;
        stop(`Could not start ${label}: ${error.message}`);
      });
      child.once('exit', () => {
        record.exitedAt = new Date().toISOString();
        if (!stopping) stop(`Owned group leader ${label} exited before cleanup`);
      });
      child.once('close', (code, signal) => {
        if (fd !== undefined) fs.closeSync(fd);
        Object.assign(record, { exitCode: code, signal, finishedAt: new Date().toISOString() });
        active.delete(job);
        resolve(record);
      });
    });
    saveRunning();
    return job;
  }
  function signalGroup(job, signal) {
    if (!job.child.pid) return;
    if (job.record.exitedAt) return 'owner-exited-not-signalled';
    try {
      process.kill(-job.child.pid, signal);
      return 'sent';
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return 'absent';
    }
  }
  const jest = path.join(root, 'node_modules/jest/bin/jest.js');
  async function run(label, files) {
    const json = path.join(outputDir, `${label}.json`);
    const log = path.join(outputDir, `${label}.log`);
    const args = [
      jest,
      '--coverage=false',
      '--maxWorkers=7',
      '--json',
      `--outputFile=${json}`,
      '--runTestsByPath',
      ...files,
    ];
    const fd = fs.openSync(log, 'wx');
    const child = fork(worker, [JSON.stringify(args)], {
      cwd: root,
      execArgv: [],
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    const job = own(child, label, false, fd);
    job.record.command = [process.execPath, worker, JSON.stringify(args)];
    saveRunning();
    const closed = await new Promise((resolve, reject) => {
      child.once('message', (result) => {
        if (result.type !== 'result' || result.error)
          reject(new Error(result.error || 'Invalid worker result'));
        else {
          job.record.jestPid = result.pid;
          resolve(result);
        }
      });
      job.done.then(() =>
        reject(new Error(`Owned worker ${label} closed before reporting a result`))
      );
    });
    if (stopping) return;
    const summary = summarizeReport(JSON.parse(fs.readFileSync(json, 'utf8')), files, root);
    return {
      label,
      ...summary,
      success: closed.exitCode === 0 && summary.success,
      startedAt: closed.startedAt,
      finishedAt: closed.finishedAt,
      pid: closed.pid,
      groupPid: child.pid,
      command: [process.execPath, ...args],
      exitCode: closed.exitCode,
      signal: closed.signal,
      jsonSha256: hash(json),
    };
  }
  try {
    const listArgs = [jest, '--listTests', '--json', '--runInBand'];
    const eligible = JSON.parse(
      execFileSync(process.execPath, listArgs, {
        cwd: root,
        encoding: 'utf8',
        timeout: Math.min(30000, budgetMs - 1000),
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    receipt.selection = selectTests(root, eligible);
    receipt.selectionCommand = [process.execPath, ...listArgs];
    timer = setTimeout(
      () => stop(`Load-check budget exhausted (${budgetMs} ms)`),
      Math.max(1, budgetMs - (performance.now() - start) - 1000)
    );
    const ready = [];
    for (let index = 0; index < 8; index++) {
      const child = fork(
        __filename,
        ['--spinner', String(Math.max(1, budgetMs - (performance.now() - start)))],
        {
          execArgv: [],
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }
      );
      receipt.spinners.push(child.pid);
      const job = own(child, `spinner-${index + 1}`, true);
      ready.push(
        new Promise((resolve, reject) => {
          child.once('message', (message) =>
            message === 'ready' ? resolve() : reject(new Error('Invalid spinner readiness'))
          );
          job.done.then(() => reject(new Error('Spinner exited before readiness')));
        })
      );
    }
    await Promise.race([Promise.all(ready), aborted]);
    for (let round = 1; round <= 2; round++) {
      const pair = await Promise.race([
        Promise.all(
          ['a', 'b'].map((name) => run(`round-${round}-${name}`, receipt.selection.files))
        ),
        aborted,
      ]);
      receipt.runs.push(...pair);
    }
    const failures = sorted(receipt.runs.flatMap((result) => result.failedFiles));
    for (const [index, file] of failures.entries()) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await Promise.race([
          run(`diagnostic-${index + 1}-${attempt}`, [file]),
          aborted,
        ]);
        receipt.diagnostics.push(result);
      }
    }
    receipt.success = receipt.runs.length === 4 && receipt.runs.every((result) => result.success);
    if (!receipt.success)
      receipt.reason =
        'At least one of the four required reports failed; diagnostics do not replace it';
  } catch (error) {
    receipt.reason = error.message;
  } finally {
    stopping = true;
    clearTimeout(timer);
    const cleanupErrors = [];
    const attempts = [];
    const failedAttempts = [];
    let groups = [];
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const job of active) {
        const attempt = {
          pid: job.child.pid,
          label: job.record.label,
          signal,
          attemptedAt: new Date().toISOString(),
        };
        attempts.push(attempt);
        try {
          attempt.result = signalGroup(job, signal);
        } catch (error) {
          Object.assign(attempt, { result: 'error', code: error.code, message: error.message });
          cleanupErrors.push(error.message);
          failedAttempts.push({ job, attempt });
        }
      }
      if (signal === 'SIGTERM')
        await settleWithin(
          [...active].map((job) => job.done),
          250
        );
      else groups = await waitForGroups(owned, 500);
    }
    // A disappearing macOS group can return EPERM while its last members are zombies.
    // Keep the original error; only a closed child AND an absent group resolve it.
    for (const { job, attempt } of failedAttempts) {
      if (attempt.code !== 'EPERM' || !job.record.finishedAt) continue;
      attempt.checkedAt = new Date().toISOString();
      try {
        process.kill(-job.child.pid, 0);
        attempt.groupProbe = 'present';
      } catch (error) {
        attempt.groupProbe = error.code || error.message;
        if (error.code === 'ESRCH') attempt.resolution = 'closed-and-group-absent';
      }
    }
    const unresolvedErrors = failedAttempts
      .map(({ attempt }) => attempt)
      .filter((attempt) => !attempt.resolution);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    receipt.cleanup = {
      pidsStillAlive: [...active].map((job) => job.child.pid).filter((pid) => pid && isAlive(pid)),
      errors: cleanupErrors,
      attempts,
      unresolvedErrors,
      groups,
      groupsStillPresent: groups.filter((group) => group.state !== 'ESRCH'),
    };
    receipt.loadAfter = os.loadavg();
    try {
      for (const run of [...receipt.runs, ...receipt.diagnostics])
        run.logSha256 = hash(path.join(outputDir, `${run.label}.log`));
      receipt.headAfter = git(root, 'rev-parse', 'HEAD');
      receipt.statusAfter = git(root, 'status', '--porcelain');
      receipt.buildManifestAfter = hash(manifest);
    } catch (error) {
      receipt.integrityError = error.message;
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.elapsedSeconds = (performance.now() - start) / 1000;
    if (
      receipt.cleanup.pidsStillAlive.length ||
      receipt.cleanup.groupsStillPresent.length ||
      unresolvedErrors.length ||
      receipt.elapsedSeconds * 1000 > budgetMs ||
      receipt.integrityError ||
      receipt.headBefore !== receipt.headAfter ||
      receipt.statusAfter ||
      receipt.buildManifestBefore !== receipt.buildManifestAfter
    ) {
      receipt.success = false;
      receipt.reason = receipt.reason || 'Cleanup, budget or committed-tree integrity check failed';
    }
    write(path.join(outputDir, 'receipt.json'), receipt);
  }
  return receipt;
}

function spinner() {
  if (!process.send) throw new Error('CPU spinners require their owning gate IPC connection');
  const duration = Number(process.argv[3]);
  if (!(duration > 0 && duration <= BUDGET_MS)) throw new Error('Invalid spinner duration');
  const deadline = Date.now() + duration;
  process.on('disconnect', () => process.exit(0));
  const burn = () => {
    const slice = Math.min(deadline, Date.now() + 100);
    while (Date.now() < slice) {
      /* Consume CPU while keeping disconnect handling bounded. */
    }
    if (Date.now() < deadline && process.connected) setImmediate(burn);
    else process.exit(0);
  };
  process.send('ready', burn);
}
if (require.main === module) {
  if (process.argv[2] === '--spinner') spinner();
  else if (process.argv.length !== 3) {
    process.stderr.write(
      'Usage: node scripts/check-test-load.js <new-output-directory-outside-checkout>\n'
    );
    process.exitCode = 2;
  } else
    runGate({ outputDir: process.argv[2] })
      .then((receipt) => {
        process.stdout.write(
          JSON.stringify({
            success: receipt.success,
            reason: receipt.reason,
            files: receipt.selection?.count,
            reports: receipt.runs.length,
            elapsedSeconds: receipt.elapsedSeconds,
            receipt: path.resolve(process.argv[2], 'receipt.json'),
          }) + '\n'
        );
        process.exitCode = receipt.success ? 0 : 1;
      })
      .catch((error) => {
        process.stderr.write(error.message + '\n');
        process.exitCode = 1;
      });
}
module.exports = { HISTORICAL_FAILURES, BUDGET_MS, selectTests, summarizeReport, runGate };

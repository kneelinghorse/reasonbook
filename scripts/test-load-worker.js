// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Holds an owned process-group leader alive after Jest exits so descendants stay controllable.
// ABOUTME: Reports Jest separately over IPC and audits group disappearance within cleanup's fixed grace.
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

function groupState(pid) {
  try {
    process.kill(-pid, 0);
    return 'present';
  } catch (error) {
    return error.code || error.message;
  }
}

async function waitForGroups(jobs, ms) {
  const deadline = performance.now() + ms;
  let groups;
  do {
    groups = jobs.map(({ child, record }) => ({
      pid: child.pid,
      label: record.label,
      state: child.pid ? groupState(child.pid) : 'NO_PID',
      checkedAt: new Date().toISOString(),
    }));
    if (
      groups.every((group) => group.state === 'ESRCH') &&
      jobs.every(({ record }) => record.finishedAt)
    )
      break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  } while (performance.now() < deadline);
  return groups;
}

function runWorker(args) {
  if (!process.send) throw new Error('Load workers require their owning gate IPC connection');
  // This process keeps its own PGID reserved until cleanup's KILL reaches all descendants.
  process.on('SIGTERM', () => {});
  const killOwnGroup = () => process.kill(-process.pid, 'SIGKILL');
  process.on('disconnect', killOwnGroup);
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, args, { stdio: ['ignore', 1, 2] });
  const report = (result) => {
    if (!process.connected) return killOwnGroup();
    process.send(
      {
        type: 'result',
        pid: child.pid,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...result,
      },
      (error) => {
        if (error) killOwnGroup();
      }
    );
  };
  child.once('error', (error) => report({ error: error.message }));
  child.once('exit', (exitCode, signal) => report({ exitCode, signal }));
  // IPC can be unreferenced by Node; retain the owner after its direct child has exited.
  setInterval(() => {}, 1000);
}

if (require.main === module) runWorker(JSON.parse(process.argv[2]));
module.exports = { waitForGroups };

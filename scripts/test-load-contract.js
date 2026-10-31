// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Defines the release load population and rejects incomplete or inconsistent Jest reports.
// ABOUTME: Retains s98-m08 and feedback 660 failures even when their lexical triggers disappear.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sorted = (values) => [...new Set(values)].sort();
const HISTORICAL_FAILURES = [
  'tests/cli/hook-adapter-isolation.test.ts',
  'tests/cli/hook-cli.test.ts',
  'tests/cli/hook-dedupe.test.ts',
  'tests/cli/hook-lifecycle.test.ts',
  'tests/cli/migrate-ownership.test.ts',
  'tests/cli/prompt-recall.test.ts',
  'tests/cli/telemetry-use.test.ts',
  'tests/docs/seed-example-calls.test.ts',
  'tests/index.runtime.test.ts',
  'tests/integration/codex-request-dispatch.test.ts',
  'tests/intelligence/cross-store-query.test.ts',
  'tests/plugin/detached-install.test.ts',
  'tests/plugin/install-state.test.ts',
  'tests/plugin/install-worker.test.ts',
  'tests/plugin/installing-server.test.ts',
  'tests/referee/dashboard-sharing.test.ts',
  'tests/referee/dashboard-transport.test.ts',
  'tests/referee/reference-server.test.ts',
  'tests/scripts/restart-session-server.test.ts',
  'tests/server-dual-era.test.ts',
  'tests/signals/feedback-regex.test.ts',
  'tests/tools/rbook/author-names.test.ts',
  'tests/tools/rbook/dashboard-upload-auth.test.ts',
  'tests/tools/rbook/draft-real-store.test.ts',
  'tests/tools/rbook/feedback-fleet.test.ts',
  'tests/tools/rbook/lifecycle-decoupling.test.ts',
  'tests/tools/rbook/rbook-agent-onboard.test.ts',
  'tests/tools/rbook/rbook-sprint-carry-forward.test.ts',
  'tests/tools/rbook/reads-never-write.test.ts',
  'tests/tools/rbook/record-derived.test.ts',
  'tests/tools/rbook/record-links-writers.test.ts',
  'tests/tools/rbook/record-sync-trigger.test.ts',
  'tests/tools/rbook/session-ops.test.ts',
  'tests/tools/rbook/snapshot-diet.test.ts',
  'tests/tools/rbook/structured-decision-record.test.ts',
  'tests/tools/rbook/suggestion-oracle.test.ts',
  'tests/tools/rbook/tool-effects.test.ts',
  'tests/tools/rbook/upload-shutdown.test.ts',
  'tests/tools/rbook/vector-tables-first-write.test.ts',
];
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

function selectTests(root, eligiblePaths) {
  const tracked = git(root, 'ls-files', '-z', '--', 'tests').split('\0').filter(Boolean);
  const eligible = new Set(
    eligiblePaths.map((file) => (path.isAbsolute(file) ? path.relative(root, file) : file))
  );
  const missing = HISTORICAL_FAILURES.filter(
    (file) => !tracked.includes(file) || !eligible.has(file)
  );
  if (missing.length)
    throw new Error(
      `Historical load files missing from tracked Jest population: ${missing.join(', ')}`
    );
  const A = [],
    B = [];
  const bound = /expect\((Date\.now\(\) - [a-zA-Z]+|[a-zA-Z.]*elapsed[a-zA-Z.]*)\)\.toBeLessThan/;
  for (const file of tracked) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue;
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') continue;
      throw error;
    }
    if (source.includes('runCli(') && source.includes("'hook'")) A.push(file);
    if (source.split(/\r?\n/).some((line) => bound.test(line))) B.push(file);
  }
  const union = sorted([...A, ...B, ...HISTORICAL_FAILURES]);
  const files = union.filter((file) => eligible.has(file) && !file.startsWith('tests/private/'));
  if (!files.length) throw new Error('The load-test population is empty');
  return {
    files,
    predicates: { A, B, C: HISTORICAL_FAILURES },
    excluded: union.filter((file) => !files.includes(file)),
    count: files.length,
  };
}

function summarizeReport(report, files, root) {
  const results = report.testResults;
  if (
    !Array.isArray(results) ||
    JSON.stringify(sorted(results.map((test) => path.relative(root, test.name)))) !==
      JSON.stringify(sorted(files)) ||
    results.length !== files.length
  )
    throw new Error('Jest report population differs from the selected files');
  const assertions = results.flatMap((test) => test.assertionResults);
  const count = (status) => assertions.filter((test) => test.status === status).length;
  const passedTests = count('passed'),
    failedTests = count('failed'),
    skippedTests = count('pending');
  if (
    assertions.length !== passedTests + failedTests + skippedTests ||
    report.numPassedTests !== passedTests ||
    report.numFailedTests !== failedTests ||
    report.numPendingTests !== skippedTests ||
    report.numTotalTests !== assertions.length ||
    report.numTotalTestSuites !== files.length ||
    report.numTodoTests !== 0 ||
    report.numPassedTestSuites + report.numFailedTestSuites + (report.numPendingTestSuites ?? 0) !==
      files.length
  )
    throw new Error('Jest aggregate counts do not reconcile with its assertions');
  const failedFiles = results
    .filter(
      (test) =>
        !['passed', 'focused'].includes(test.status) ||
        test.message ||
        !test.assertionResults.some((assertion) => assertion.status === 'passed') ||
        test.assertionResults.some(
          (assertion) => assertion.status === 'failed' || assertion.failureMessages?.length
        )
    )
    .map((test) => path.relative(root, test.name));
  return {
    success:
      report.success === true &&
      report.numFailedTestSuites === 0 &&
      report.numRuntimeErrorTestSuites === 0 &&
      failedTests === 0 &&
      failedFiles.length === 0,
    files: files.length,
    passedTests,
    failedTests,
    skippedTests,
    failedFiles,
    skips: results.flatMap((test) =>
      test.assertionResults
        .filter((assertion) => assertion.status === 'pending')
        .map((assertion) => ({ file: path.relative(root, test.name), test: assertion.fullName }))
    ),
  };
}

module.exports = { HISTORICAL_FAILURES, selectTests, summarizeReport, git };

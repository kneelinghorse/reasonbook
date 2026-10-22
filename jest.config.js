// Dynamically adjust coverage thresholds when running a focused subset
// e.g., `npm test -- import-export` should validate functionality without failing global thresholds
const isFocusedRun = process.argv.some((arg) => /combination|intelligence/.test(arg));

// Coverage floors — measured-green integers, deliberately set BELOW the measured
// ratios so normal work does not red CI on noise (never bolt filler tests onto
// live code to hold a number: design doc §5.4).
//
// Sprint 51: removing dead condense functions (all tested) lowered ratio by 0.1%.
// Sprint 76 (Great Deletion G2): deleting the heavily-covered dead agentic island +
//   its edge-padder tests dropped global functions 83.94 -> 80.51; lowered 82 -> 80.
// Sprint 77 m03 (2026-07-08, gpt-tokenizer excision): re-measured green at
//   statements 84.74, branches 69.60, functions 80.17, lines 85.45.
// Sprint 79 m06 (2026-07-09, Arc D convergence — OWNS the re-set): the fan-out
//   deletion (m04) plus the new tested registry/authority/acrossProjects/portfolio
//   modules net-RAISED coverage. Re-measured full-suite green:
//   statements 85.76, branches 70.40, functions 81.58, lines 86.40. Floors raised
//   to sit just under measured (deliberate headroom; never bolt filler tests to
//   hold a number — design doc §5.4).
// Sprint 80 m07 (2026-07-09, Arc D Sprint 2 — OWNS the re-set): the m02 JSON
//   ProjectRegistry deletion (a ~95%-covered class + suite, F5 spike) lowered ratios;
//   the m01/m05/m06/m07 net-ADD tested code (project-resolution, message summary/get,
//   deriveDrift, self-capture-guard) partially recovered them. Re-measured full-suite
//   green: statements 85.5, branches 70.14, functions 81.45, lines 86.15 — all still
//   ABOVE the floors, so single-owner-last-mission holds them UNTOUCHED (F5: no
//   defensive down-adjust was needed). Branches headroom is thin (+0.16) but the floor
//   already sits at 70; raising it would red CI on noise. NO filler tests were added.
const baselineThresholds = {
  branches: 70,
  functions: 81,
  lines: 85,
  statements: 85,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // DB-heavy integration suites (bdd/rbook-session-start.steps, sprint-status-sync,
  // tier-config, sync-locks, …) occasionally exceed the 5s default under 220+-suite
  // parallel CPU contention, producing rotating timeout flakes. 30s gave headroom
  // without masking real hangs; a file-level jest.setTimeout still overrides per suite.
  // s98-m08: a hang guard, not a speed budget. Under two concurrent full suites on a Mac that was
  // swapping, ordinary tests in index.runtime, session-ops, snapshot-diet, record-links-writers,
  // structured-decision-record, tool-effects and rbook-agent-onboard ran past 30 s, and a shared-record
  // test in record-derived past 120 s; across four such suites 32 tests took over 120 s and the
  // slowest 314 s. 300 s still fails a real hang.
  testTimeout: 300000,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // s77-m10: the heavy first-run E2E (tests/e2e/*.e2e.ts) runs under jest.e2e.config.js
  // via `npm run test:e2e-firstrun`, never in the default suite (protects the coverage
  // floors + unit runtime). testMatch already excludes *.e2e.ts; this is belt-and-suspenders.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],
  globalSetup: '<rootDir>/tests/jest-global-setup.ts',
  globalTeardown: '<rootDir>/tests/jest-global-teardown.ts',
  // Sprint 70 m01: strip real dashboard creds (leaked from .env via env-loader)
  // before each test so fire-and-forget checkpoint syncs never hit the live
  // dashboard or log after teardown. See tests/jest-setup-after-env.ts.
  // s92-m10 (feedback #44): no test may open a connection to a non-loopback host unless it opts
  // in; tests/jest-setup-network-deny.ts fails the test that tries.
  setupFilesAfterEnv: [
    '<rootDir>/tests/jest-setup-after-env.ts',
    '<rootDir>/tests/jest-setup-network-deny.ts',
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.interface.ts'],
  coverageThreshold: isFocusedRun
    ? {
        // Looser thresholds for focused suites to prevent unrelated files from failing CI
        global: {
          branches: Math.min(75, baselineThresholds.branches),
          functions: Math.min(80, baselineThresholds.functions),
          lines: Math.min(80, baselineThresholds.lines),
          statements: Math.min(80, baselineThresholds.statements),
        },
      }
    : {
        // Project-wide targets aligned with latest green baseline
        global: {
          branches: baselineThresholds.branches,
          functions: baselineThresholds.functions,
          lines: baselineThresholds.lines,
          statements: baselineThresholds.statements,
        },
      },
};

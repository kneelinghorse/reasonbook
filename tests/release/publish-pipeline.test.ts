// ABOUTME: Release versions must agree across package metadata, plugin metadata and published documentation.
// ABOUTME: Mutation controls preserve the release and public-mirror boundaries without publishing anything.

import { describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { parse } from 'yaml';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { installPackedArtifact } from '../e2e/packed-artifact';

type PackageJsonExports = {
  [key: string]:
    | string
    | {
        types?: string;
        require?: string;
        default?: string;
      };
};

type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  mcpName?: string;
  repository?: { url?: string };
  main?: string;
  types?: string;
  exports?: PackageJsonExports;
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackageLock = {
  version?: string;
  packages?: Record<string, { version?: string }>;
};

/** s99-m04: the MCP Registry entry. Its name must equal package.json's mcpName on the published package. */
type ServerJson = {
  name?: string;
  description?: string;
  version?: string;
  repository?: { url?: string; source?: string };
  packages?: Array<{
    registryType?: string;
    identifier?: string;
    version?: string;
    transport?: { type?: string };
    environmentVariables?: Array<{ name?: string; isRequired?: boolean }>;
  }>;
};

interface MarkdownVersionStamp {
  readonly relativePath: string;
  readonly line: number;
  readonly label: string;
  readonly value: string;
  readonly lastUpdated?: string;
}

interface VersionLedgerRow {
  readonly source: string;
  readonly value: string;
  readonly disposition: 'AUTHORITY' | 'ASSERTED' | 'EXCLUDED' | 'BOUNDARY_ONLY' | 'UNCLASSIFIED';
  readonly rule: string;
  readonly valid: boolean;
}

interface ReleaseVersionState {
  readonly packageVersion: string;
  readonly pluginVersion: string;
  readonly lockVersion: string;
  readonly lockSelfVersion: string;
  readonly serverVersion: string;
  readonly serverPackageVersion: string;
  readonly serverName: string;
  readonly mcpName: string;
  readonly changelog: string;
  readonly stamps: readonly MarkdownVersionStamp[];
  readonly newestTag?: string;
}

const projectRoot = path.resolve(__dirname, '..', '..');
const PRIVATE = requiresPrivateEvidence({
  reason:
    'release authority documents and private version stamps are absent from the public mirror',
  paths: {
    workflow: '.github/workflows/publish.yml',
    releaseRunbook: 'rbook/docs/release.md',
    agents: 'agents.md',
    buildSessionPrompt: 'rbook/docs/build-session-prompt.md',
  },
});

const VERSION_STAMP_PATTERN =
  /^\*\*((?:[A-Za-z]+ )?Version)\*\*:[ \t]*([0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/gm;
const DATED_CHANGELOG_HEADING =
  /^##\s*\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\]?\s*[—-]\s*(\d{4}-\d{2}-\d{2})/m;
const RECORD_TREE_PREFIXES = [
  'cmos/db/',
  'rbook/db/',
  'cmos/planning/',
  'rbook/planning/',
  'cmos/docs/archive/',
  'rbook/docs/archive/',
  'cmos/research/',
  'rbook/research/',
] as const;
const RELEASE_GATE_COMMAND =
  'npx jest tests/release/publish-pipeline.test.ts --coverage=false --runInBand';

function readTextFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

/** Literal child-process build commands; dynamic commands and package lifecycle scripts need review. */
function e2eBuildCalls(filename: string, text: string): number[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      /(?:spawn|exec)(?:File)?(?:Sync)?$/.test(node.expression.getText(source))
    ) {
      const [command, args] = node.arguments;
      const npmBuild =
        command &&
        ts.isStringLiteralLike(command) &&
        command.text === 'npm' &&
        args &&
        ts.isArrayLiteralExpression(args) &&
        args.elements.length >= 2 &&
        args.elements
          .slice(0, 2)
          .every((arg, i) => ts.isStringLiteralLike(arg) && arg.text === ['run', 'build'][i]);
      const shellBuild =
        command && ts.isStringLiteralLike(command) && /\bnpm\s+run\s+build\b/.test(command.text);
      if (npmBuild || shellBuild)
        found.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isInVersionSweep(relativePath: string): boolean {
  return !RECORD_TREE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function scanMarkdownVersionStamps(files: readonly string[]): MarkdownVersionStamp[] {
  const stamps: MarkdownVersionStamp[] = [];
  for (const relativePath of files.filter(
    (candidate) => isInVersionSweep(candidate) && candidate.endsWith('.md')
  )) {
    const content = readTextFile(relativePath);
    const lastUpdated = content.match(/^\*\*Last Updated\*\*:\s*(.*?)\s*$/m)?.[1];
    for (const match of content.matchAll(new RegExp(VERSION_STAMP_PATTERN))) {
      stamps.push({
        relativePath,
        line: content.slice(0, match.index).split('\n').length,
        label: match[1],
        value: match[2],
        lastUpdated,
      });
    }
  }
  return stamps;
}

function loadReleaseVersionState(): ReleaseVersionState {
  const pkg = JSON.parse(readTextFile('package.json')) as PackageJson;
  const lock = JSON.parse(readTextFile('package-lock.json')) as PackageLock;
  const server = JSON.parse(readTextFile('server.json')) as ServerJson;
  const files = trackedFiles();
  const newestTag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)[0];

  return {
    packageVersion: pkg.version ?? '',
    pluginVersion: fs.existsSync(
      path.join(projectRoot, 'plugins/reasonbook/.claude-plugin/plugin.json')
    )
      ? ((
          JSON.parse(readTextFile('plugins/reasonbook/.claude-plugin/plugin.json')) as {
            version?: string;
          }
        ).version ?? '')
      : '<missing>',
    lockVersion: lock.version ?? '',
    lockSelfVersion: lock.packages?.['']?.version ?? '',
    serverVersion: server.version ?? '',
    serverPackageVersion: server.packages?.[0]?.version ?? '',
    serverName: server.name ?? '',
    mcpName: pkg.mcpName ?? '',
    changelog: readTextFile('CHANGELOG.md'),
    stamps: scanMarkdownVersionStamps(files),
    newestTag,
  };
}

function evaluateReleaseVersionClass(state: ReleaseVersionState): {
  rows: VersionLedgerRow[];
  failures: string[];
} {
  const rows: VersionLedgerRow[] = [];
  const add = (
    source: string,
    value: string,
    disposition: VersionLedgerRow['disposition'],
    rule: string,
    valid: boolean
  ): void => {
    rows.push({ source, value, disposition, rule, valid });
  };

  add(
    'package.json $.version',
    state.packageVersion,
    'AUTHORITY',
    'non-empty semver authority',
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      state.packageVersion
    )
  );
  add(
    'plugins/reasonbook/.claude-plugin/plugin.json $.version',
    state.pluginVersion,
    'ASSERTED',
    'exactly equals package.json $.version; the plugin shim derives its package pin here',
    state.pluginVersion === state.packageVersion
  );
  add(
    'package-lock.json $.version',
    state.lockVersion,
    'ASSERTED',
    'exactly equals package.json $.version',
    state.lockVersion === state.packageVersion
  );
  add(
    'package-lock.json $.packages[""].version',
    state.lockSelfVersion,
    'ASSERTED',
    'exactly equals package.json $.version',
    state.lockSelfVersion === state.packageVersion
  );
  add(
    'server.json $.version',
    state.serverVersion,
    'ASSERTED',
    'exactly equals package.json $.version; the MCP Registry entry names the release it describes',
    state.serverVersion === state.packageVersion
  );
  add(
    'server.json $.packages[0].version',
    state.serverPackageVersion,
    'ASSERTED',
    'exactly equals package.json $.version; the registry installs this npm version',
    state.serverPackageVersion === state.packageVersion
  );
  add(
    'server.json $.name',
    state.serverName,
    'ASSERTED',
    'exactly equals package.json $.mcpName, which the registry verifies on the published package',
    state.serverName !== '' && state.serverName === state.mcpName
  );

  const datedHeading = state.changelog.match(DATED_CHANGELOG_HEADING);
  add(
    'CHANGELOG.md newest dated heading',
    datedHeading?.[1] ?? '<not located>',
    'ASSERTED',
    'newest dated heading exactly equals package.json $.version; UNRELEASED headings do not participate',
    datedHeading?.[1] === state.packageVersion
  );

  for (const stamp of state.stamps) {
    const source = `${stamp.relativePath}:${stamp.line} **${stamp.label}**`;
    if (stamp.label === 'Schema Version' || stamp.label === 'Template Version') {
      add(
        source,
        stamp.value,
        'EXCLUDED',
        `${stamp.label} is an adjacent schema/template-format axis`,
        true
      );
      continue;
    }
    if (stamp.label === 'Version') {
      add(
        source,
        stamp.value,
        'ASSERTED',
        'exactly equals package.json $.version',
        stamp.value === state.packageVersion
      );
      continue;
    }
    if (stamp.label === 'Reasonbook Version') {
      add(
        source,
        stamp.value,
        'ASSERTED',
        'major.minor prefix of package.json $.version',
        state.packageVersion.startsWith(`${stamp.value}.`)
      );
      continue;
    }
    add(
      source,
      stamp.value,
      'UNCLASSIFIED',
      'UNCLASSIFIED version-shaped stamp — assign a mechanical rule',
      false
    );
  }

  add(
    'git newest v* tag',
    state.newestTag ?? '<not observable here>',
    'BOUNDARY_ONLY',
    'checked against package.json by publish.yml and mirror-to-public.sh only during release operations',
    true
  );

  return {
    rows,
    failures: rows
      .filter((row) => !row.valid)
      .map((row) => `${row.source} has ${JSON.stringify(row.value)}; rule: ${row.rule}`),
  };
}

function missingDeclaredStamps(
  stamps: readonly MarkdownVersionStamp[],
  expected: ReadonlyArray<{ relativePath: string; label: string }>
): string[] {
  const located = new Set(stamps.map((stamp) => `${stamp.relativePath}\0${stamp.label}`));
  return expected
    .filter((target) => !located.has(`${target.relativePath}\0${target.label}`))
    .map((target) => `${target.relativePath} **${target.label}**`);
}

function runbookUsesCanonicalReleaseGate(runbook: string): boolean {
  return (
    runbook.includes(RELEASE_GATE_COMMAND) &&
    !runbook.includes('package.json and package-lock.json versions differ') &&
    !/lock\.version\s*!==\s*pkg\.version/.test(runbook)
  );
}

/**
 * s90-m06 — one ledger for the release-version class.
 *
 * SCOPE. The authority is package.json. Continuous checkout state includes both package-lock
 * roots, plugin.json's version (the install pin), the newest DATED CHANGELOG heading, and bold
 * Markdown Version/Reasonbook Version stamps.
 * Schema Version and Template Version are neighbouring axes, not release versions; an unfilled
 * scaffold is excluded only while its own Last Updated value is bracketed. The broad locator
 * still prints all of them so an exclusion cannot make a matching site disappear. Git tags are
 * boundary-only state: the ordinary pre-tag release commit legitimately has a newer package than
 * the newest tag, so this gate verifies the two executable tag guards instead of asserting an
 * always-wrong checkout equality.
 *
 * PUBLIC MIRROR. The scanner derives its universe from the checkout's own tracked files. Private
 * targets removed by mirror-to-public.sh are therefore not invented as a numeric floor; package,
 * lockfile, CHANGELOG, seed-axis exclusions, and the mirror tag guard remain fully asserted. The
 * private arm separately requires every declared private stamp to be located.
 *
 * FALSE-NEGATIVE PROFILE. Prose version tokens outside the declared JSON/heading/bold-stamp
 * shapes are invisible. The published npm artifact and the public mirror's own remote objects are
 * outside this checkout. src/index.ts's fallback version on a broken package read is runtime
 * behaviour, not a stamp. Tag equality is transitive through the release-only workflow/script
 * guards. Finally, this checks the resulting values, not whether an operator used `npm version`.
 * Deleting this entire describe is not independently detected; the mutation controls below make
 * partial or vacuous implementations fail but cannot prove their own file still exists.
 */
describe('release-version class', () => {
  test('classifies every located signal and validates every continuous member', () => {
    const files = trackedFiles();
    const sweptFiles = files.filter(isInVersionSweep);
    const state = loadReleaseVersionState();
    const evaluation = evaluateReleaseVersionClass(state);

    expect(files.length).toBeGreaterThan(0);
    expect(sweptFiles.length).toBeGreaterThan(0);
    expect(state.stamps.length).toBeGreaterThan(0);
    expect(evaluation.rows).toHaveLength(state.stamps.length + 9);
    expect(evaluation.failures).toEqual([]);

    console.log(
      [
        `[release-version class] tracked=${files.length} swept=${sweptFiles.length} rawSignals=${evaluation.rows.length}`,
        ...evaluation.rows.map(
          (row) => `  ${row.disposition} ${row.source}=${JSON.stringify(row.value)} — ${row.rule}`
        ),
      ].join('\n')
    );
  });

  test('turns red when package.json alone is bumped', () => {
    const state = loadReleaseVersionState();
    const evaluation = evaluateReleaseVersionClass({
      ...state,
      packageVersion: '99.99.99',
    });

    expect(evaluation.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('package-lock.json $.version'),
        expect.stringContaining('package-lock.json $.packages[""].version'),
        expect.stringContaining('plugins/reasonbook/.claude-plugin/plugin.json $.version'),
        expect.stringContaining('CHANGELOG.md newest dated heading'),
        expect.stringContaining('server.json $.version'),
        expect.stringContaining('server.json $.packages[0].version'),
      ])
    );
  });

  test('turns red when the MCP Registry name and the package mcpName disagree (s99-m04)', () => {
    const state = loadReleaseVersionState();
    expect(
      evaluateReleaseVersionClass({ ...state, mcpName: 'io.github.someone-else/reasonbook' })
        .failures
    ).toEqual([expect.stringContaining('server.json $.name')]);
  });

  test('turns red when the plugin install pin drifts independently from the package', () => {
    const state = loadReleaseVersionState();
    expect(evaluateReleaseVersionClass({ ...state, pluginVersion: '99.99.99' }).failures).toEqual([
      expect.stringContaining('plugins/reasonbook/.claude-plugin/plugin.json $.version'),
    ]);
  });

  test('ignores an UNRELEASED accumulation heading but rejects a wrong dated heading', () => {
    const state = loadReleaseVersionState();
    const withUnreleasedHeading = {
      ...state,
      changelog: `## 99.99.99 — UNRELEASED\n\n${state.changelog}`,
    };
    expect(evaluateReleaseVersionClass(withUnreleasedHeading).failures).toEqual([]);

    const dated = state.changelog.match(DATED_CHANGELOG_HEADING);
    expect(dated).not.toBeNull();
    const wrongDatedHeading = state.changelog.replace(
      dated?.[0] ?? '',
      (dated?.[0] ?? '').replace(dated?.[1] ?? '', '99.99.99')
    );
    expect(
      evaluateReleaseVersionClass({ ...state, changelog: wrongDatedHeading }).failures
    ).toEqual([expect.stringContaining('CHANGELOG.md newest dated heading')]);
  });

  test('accepts the runbook-supported prerelease SemVer shape', () => {
    const state = loadReleaseVersionState();
    const dated = state.changelog.match(DATED_CHANGELOG_HEADING);
    expect(dated).not.toBeNull();
    const stable = state.packageVersion.split(/[+-]/, 1)[0];
    const [major, minor] = stable.split('.');
    const prerelease = `${stable}-rc.1`;
    const changelog = state.changelog.replace(
      dated?.[0] ?? '',
      (dated?.[0] ?? '').replace(dated?.[1] ?? '', prerelease)
    );
    const stamps = state.stamps.map((stamp) => {
      if (stamp.label === 'Version') {
        return { ...stamp, value: prerelease };
      }
      if (stamp.label === 'Reasonbook Version') {
        return { ...stamp, value: `${major}.${minor}` };
      }
      return stamp;
    });

    expect(
      evaluateReleaseVersionClass({
        ...state,
        packageVersion: prerelease,
        pluginVersion: prerelease,
        lockVersion: prerelease,
        lockSelfVersion: prerelease,
        serverVersion: prerelease,
        serverPackageVersion: prerelease,
        changelog,
        stamps,
      }).failures
    ).toEqual([]);
  });

  test('keeps the public mirror tag argument coupled to package.json at release time', () => {
    const mirrorScript = readTextFile('scripts/mirror-to-public.sh');
    expect(mirrorScript).toMatch(/SEMVER="\$\{VERSION#v\}"/);
    expect(mirrorScript).toMatch(/PKG_VERSION=.*require\('\.\/package\.json'\)\.version/);
    expect(mirrorScript).toMatch(/\[\[ "\$SEMVER" == "\$PKG_VERSION" \]\]/);
  });

  test('keeps the package files allowlist non-empty for the runbook gate', () => {
    const pkg = JSON.parse(readTextFile('package.json')) as PackageJson;
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files?.length).toBeGreaterThan(0);
  });

  PRIVATE.describe('private release-version members and release entrypoint', () => {
    const declaredPrivateStamps = [
      { relativePath: PRIVATE.relativePaths.agents, label: 'Version' },
      { relativePath: PRIVATE.relativePaths.buildSessionPrompt, label: 'Reasonbook Version' },
    ] as const;

    test('locates every declared private stamp before applying its rule', () => {
      const state = loadReleaseVersionState();
      expect(missingDeclaredStamps(state.stamps, declaredPrivateStamps)).toEqual([]);

      const withoutAgents = state.stamps.filter(
        (stamp) => stamp.relativePath !== PRIVATE.relativePaths.agents
      );
      expect(missingDeclaredStamps(withoutAgents, declaredPrivateStamps)).toEqual([
        `${PRIVATE.relativePaths.agents} **Version**`,
      ]);
    });

    // s93-m12 retired the unfilled private scaffold (rbook/templates/agents.md) and its exemption, so
    // a placeholder Last Updated exempts no Version stamp: the release authority still fails.
    test('a placeholder Last Updated exempts no Version stamp', () => {
      const state = loadReleaseVersionState();
      const disguisedAuthority = state.stamps.map((stamp) =>
        stamp.relativePath === PRIVATE.relativePaths.agents
          ? { ...stamp, value: '1.0.0', lastUpdated: '[Date]' }
          : stamp
      );
      expect(
        evaluateReleaseVersionClass({ ...state, stamps: disguisedAuthority }).failures
      ).toEqual([expect.stringContaining(PRIVATE.relativePaths.agents)]);
    });

    test('keeps the private tag workflow and runbook on the canonical gate', () => {
      const workflow = fs.readFileSync(PRIVATE.paths.workflow, 'utf8');
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');

      expect(workflow).toMatch(/TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/);
      expect(workflow).toMatch(/PACKAGE_VERSION=.*require\('\.\/package\.json'\)\.version/);
      expect(workflow).toMatch(/"\$TAG_VERSION" != "\$PACKAGE_VERSION"/);
      expect(runbookUsesCanonicalReleaseGate(runbook)).toBe(true);

      const restoredInlineCopy = runbook.replace(
        RELEASE_GATE_COMMAND,
        'node -e "if (lock.version !== pkg.version) throw new Error(\'package.json and package-lock.json versions differ\')"'
      );
      expect(runbookUsesCanonicalReleaseGate(restoredInlineCopy)).toBe(false);
    });

    test('builds the dist-driven E2E artifact before the test and rebuilds the final manifest', () => {
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');
      const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

      expect(packageJson.scripts?.['test:e2e-firstrun']).toBe(
        'jest --config jest.e2e.config.js --runInBand'
      );
      expect(runbook).not.toContain('`test:e2e-firstrun` builds internally');
      expect(runbook).toMatch(
        /npm test -- --runInBand\nnpm run clean\nnpm run build\nnpm run test:e2e-firstrun\n\n# `test:e2e-firstrun` drives dist\/index\.js and does not build it\.[\s\S]*?npm run clean\nnpm run build\nnpm run verify:dist/
      );
    });

    test('checks outgoing history against a freshly fetched boundary before expensive branch gates', () => {
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');
      const gates = runbook.split('## 2. Run the branch gates')[1].split('## 2a.')[0];
      const ordered = (text: string): boolean =>
        /git fetch origin main\nnode scripts\/check-outgoing-blobs\.js --boundary refs\/remotes\/origin\/main --candidate HEAD[\s\S]*npm run lint[\s\S]*npm test -- --runInBand/.test(
          text
        );
      expect(ordered(gates)).toBe(true);
      expect(ordered(gates.replace('git fetch origin main\n', ''))).toBe(false);
      expect(ordered(gates.replace('--boundary refs/remotes/origin/main', '--boundary HEAD'))).toBe(
        false
      );
    });
  });
});

describe('npm publish pipeline configuration', () => {
  test('packed E2E consumers install the prebuilt tarball and fail before packing when dist is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-pack-contract-'));
    const mkTmp = (prefix: string): string => fs.mkdtempSync(path.join(root, prefix));
    const calls: string[][] = [];
    const runNpm = (args: string[], cwd: string) => {
      calls.push(args);
      if (args[0] === 'pack') {
        fs.writeFileSync(
          path.join(args[args.indexOf('--pack-destination') + 1], 'fixture.tgz'),
          'tarball'
        );
      } else if (args[0] === 'install') {
        for (const file of [
          'node_modules/@rbook/fixture/dist/index.js',
          'node_modules/.bin/reasonbook',
        ]) {
          fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
          fs.writeFileSync(path.join(cwd, file), 'installed');
        }
      } else throw new Error(`Unexpected npm command: ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"@rbook/fixture"}');
      expect(() => installPackedArtifact(root, mkTmp, runNpm)).toThrow(/build.*first/i);
      expect(calls).toEqual([]);
      fs.mkdirSync(path.join(root, 'dist'));
      fs.writeFileSync(path.join(root, 'dist/index.js'), 'prebuilt');
      const installed = installPackedArtifact(root, mkTmp, runNpm);
      expect(calls.map((args) => args[0])).toEqual(['pack', 'install']);
      expect(calls[1][1]).toBe(installed.tarball);
      expect(fs.readFileSync(installed.serverPath, 'utf8')).toBe('installed');
      expect(installed.serverPath).toBe(
        path.join(installed.hostDir, 'node_modules/@rbook/fixture/dist/index.js')
      );
      expect(fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8')).toBe('prebuilt');
      expect(() =>
        installPackedArtifact(root, mkTmp, () => ({
          status: 1,
          stdout: '',
          stderr: 'pack refused',
        }))
      ).toThrow(/pack refused/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the E2E lane consumes its prebuilt artifact without replacing it', () => {
    expect(e2eBuildCalls('control.ts', "spawnSync('npm', ['run', 'build']);")).toEqual([1]);
    expect(e2eBuildCalls('control.ts', "execSync('npm run build');")).toEqual([1]);
    expect(
      e2eBuildCalls('control.ts', "// npm run build\nthrow new Error('Run npm run build first');")
    ).toEqual([]);
    const builds = trackedFiles()
      .filter((file) => file.startsWith('tests/e2e/'))
      .flatMap((file) => e2eBuildCalls(file, readTextFile(file)).map((line) => `${file}:${line}`));
    expect(builds).toEqual([]);
  });

  test('every CI artifact build passes verify:dist before E2E or publishing', () => {
    const files = trackedFiles().filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file));
    let builds = 0;
    for (const file of files) {
      const workflow = parse(readTextFile(file)) as {
        jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
      };
      for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
        const commands = (definition.steps ?? []).map((step) => step.run ?? '');
        const buildSteps = commands.flatMap((command, index) =>
          /\bnpm run build\b/.test(command) ? [index] : []
        );
        for (const [buildNumber, build] of buildSteps.entries()) {
          builds++;
          const nextBuild = buildSteps[buildNumber + 1] ?? commands.length;
          const verify = commands.findIndex(
            (command, index) =>
              index > build && index < nextBuild && /\bnpm run verify:dist\b/.test(command)
          );
          expect({ file, job, build, verifyAfterBuild: verify > build }).toEqual({
            file,
            job,
            build,
            verifyAfterBuild: true,
          });
          for (const [index, command] of commands.entries()) {
            if (
              index > build &&
              index < nextBuild &&
              /\bnpm (?:publish|run test:e2e-firstrun)\b/.test(command)
            )
              expect(index).toBeGreaterThan(verify);
          }
        }
      }
    }
    expect(builds).toBeGreaterThan(0);
  });

  test('every CI job running the suite provisions the real PCRE2 tarball scanner first', () => {
    const files = trackedFiles().filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file));
    const missing: string[] = [];
    let suites = 0;
    for (const file of files) {
      const workflow = parse(readTextFile(file)) as {
        jobs?: Record<string, { steps?: Array<{ run?: string; if?: string }> }>;
      };
      for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
        const steps = definition.steps ?? [];
        for (const [index, step] of steps.entries()) {
          if (!/\bnpm (?:test|run test)(?=\s|$)|\bnpx jest(?=\s|$)/.test(step.run ?? '')) continue;
          suites++;
          const provisioned = steps
            .slice(0, index)
            .some(
              (before) =>
                !before.if &&
                /\bapt-get install\b[^\n]*\bripgrep\b/.test(before.run ?? '') &&
                /\brg --pcre2-version\b/.test(before.run ?? '')
            );
          if (!provisioned) missing.push(`${file}:${job}`);
        }
      }
    }
    expect(suites).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  PRIVATE.describe('the release tarball scan fails closed without shell errexit', () => {
    test('the actual scanner rejects text under either private record folder and accepts the seed', () => {
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');
      const pattern = runbook.match(/'([^'\n]*\^package\/[^'\n]*)'/)?.[1];
      expect(pattern).toBeDefined();
      // Text fixtures prevent the separate SQLite-extension arm from hiding a missing root.
      for (const [entry, status] of [
        ['package/cmos/research/receipt.md', 0],
        ['package/rbook/research/receipt.md', 0],
        ['package/rbook-seed/docs/README.md', 1],
      ] as const) {
        const result = spawnSync('rg', ['--pcre2', pattern!], {
          input: entry + '\n',
          encoding: 'utf8',
        });
        if (result.error || result.signal || ![0, 1].includes(result.status ?? -1)) {
          throw new Error(
            `The real release scanner could not run: ${result.error?.message ?? `exit=${result.status}, signal=${result.signal}, stderr=${result.stderr.trim()}`}. Install ripgrep with PCRE2 support; verify with rg --pcre2-version.`
          );
        }
        expect(result.status).toBe(status);
      }
    });
    test.each([
      ['a nonempty clean tarball', 0, 'package/dist/index.js\n', 1, 0],
      ['an empty listing', 0, '', 1, 1],
      ['a tar failure', 2, '', 1, 1],
      ['a partial listing followed by tar failure', 2, 'package/dist/index.js\n', 1, 1],
      ['a private path match', 0, 'package/rbook/db/rbook.sqlite\n', 0, 1],
      ['a broken scanner', 0, 'package/dist/index.js\n', 2, 1],
      ['a missing scanner', 0, 'package/dist/index.js\n', 127, 1],
      ['a failed counter despite positive output', 0, 'package/dist/index.js\n', 1, 1, 1],
    ])('%s', (_name, tarStatus, listing, scanStatus, expected, countStatus = 0) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-release-scan-'));
      try {
        for (const [name, body] of Object.entries({
          tar: 'printf "%s" "$RBOOK_TEST_LISTING"; exit "$RBOOK_TEST_TAR_STATUS"',
          rg: 'exit "$RBOOK_TEST_SCAN_STATUS"',
          wc: 'if [ "$RBOOK_TEST_COUNT_STATUS" -ne 0 ]; then printf "1\\n"; exit "$RBOOK_TEST_COUNT_STATUS"; fi; exec /usr/bin/wc "$@"',
        }))
          fs.writeFileSync(path.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');
        const block = runbook.match(/```bash\n([^`]*tar -tzf[\s\S]*?)\n```/)?.[1];
        expect(block).toBeDefined();
        const start = block!.split('\n').findIndex((line) => /^(?:if ! )?tar -tzf/.test(line));
        expect(start).toBeGreaterThanOrEqual(0);
        const run = spawnSync(
          'bash',
          ['-c', `set +e\n${block!.split('\n').slice(start).join('\n')}`],
          {
            encoding: 'utf8',
            env: {
              PATH: `${root}:${process.env.PATH}`,
              RBOOK_TARBALL_DIR: root,
              RBOOK_TARBALL: path.join(root, 'candidate.tgz'),
              RBOOK_TEST_TAR_STATUS: String(tarStatus),
              RBOOK_TEST_LISTING: String(listing),
              RBOOK_TEST_SCAN_STATUS: String(scanStatus),
              RBOOK_TEST_COUNT_STATUS: String(countStatus),
            },
          }
        );
        expect({ status: run.status, error: run.error }).toEqual({
          status: expected,
          error: undefined,
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('server.json describes the published npm package for the MCP Registry (s99-m04)', () => {
    const pkg = JSON.parse(readTextFile('package.json')) as PackageJson;
    const server = JSON.parse(readTextFile('server.json')) as ServerJson;
    const owner = /github\.com\/([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? '');
    expect(owner).not.toBeNull();
    // The verified aquex.ai namespace keeps registry identity stable across repository moves.
    expect(server.name).toBe('ai.aquex/reasonbook');
    expect(pkg.mcpName).toBe('ai.aquex/reasonbook');
    expect(server.repository).toEqual({
      url: `https://github.com/${owner![1]}/${owner![2]}`,
      source: 'github',
    });
    // The registry caps the description at 100 characters; it says what the package says.
    expect(server.description).toBe(pkg.description);
    expect((server.description ?? '').length).toBeLessThanOrEqual(100);
    expect(server.packages).toHaveLength(1);
    expect(server.packages![0]).toMatchObject({
      registryType: 'npm',
      identifier: pkg.name,
      transport: { type: 'stdio' },
    });
    // The server starts with no secret; a required variable would make every listing ask for one.
    expect((server.packages![0].environmentVariables ?? []).filter((v) => v.isRequired)).toEqual(
      []
    );
  });

  test('package.json exposes dist entry points and declaration files', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.types).toBe('dist/index.d.ts');
    expect(packageJson.files).toContain('dist');
    // s93-m01: the bin is dist/bin.js, which sends a CLI verb to dist/cli.js before any server
    // module loads and starts the server through dist/index.js for no verb, `serve` or a server
    // flag. main and the exports stay dist/index.js, which still starts the server when run directly.
    // Version 4 installs only the public command; legacy installations upgrade explicitly.
    expect(packageJson.bin).toEqual({
      reasonbook: './dist/bin.js',
    });

    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    });
  });

  // Arc C / s78-m01 (FORK-1 = A, hard-delete): the unauthenticated HTTP transport
  // (`cmos-mcp-http` bin, `./http-server` export, `start:http` script, `src/http-server.ts`)
  // was removed — it was a CORS-`*`, zero-auth, full-store-write channel with no consumers.
  // This guard is INVERTED from the old "must expose the http bin" assertion: it now fences
  // AGAINST a well-meaning re-add. If a real remote client ever needs it, recover the source
  // from git history and rebuild WITH authentication (do not just un-delete this surface).
  test('package.json does NOT expose the unauthenticated HTTP transport', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.bin).not.toHaveProperty('cmos-mcp-http');
    expect(packageJson.scripts ?? {}).not.toHaveProperty('start:http');
    expect(packageJson.exports ?? {}).not.toHaveProperty('./http-server');

    // No bin/export/script value may point at the deleted http-server artifact.
    const referencesHttpServer = [
      ...Object.values(packageJson.bin ?? {}),
      ...Object.values(packageJson.scripts ?? {}),
      ...Object.values(packageJson.exports ?? {}).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry)
      ),
    ].some((value) => typeof value === 'string' && value.includes('http-server'));
    expect(referencesHttpServer).toBe(false);

    // The stdio bin — the product — is dist/bin.js since s93-m01 (it starts the same server).
    expect(packageJson.bin).toMatchObject({ reasonbook: './dist/bin.js' });
  });

  test('the http-server source and transport docs are deleted from the repo', () => {
    for (const relativePath of [
      'src/http-server.ts',
      'HTTP_TRANSPORT.md',
      'README_HTTP.md',
      'ecosystem.config.js',
    ]) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  test('.npmignore excludes private workspace artifacts but not the shipped seed', () => {
    const npmIgnoreLines = readTextFile('.npmignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(npmIgnoreLines).toEqual(
      expect.arrayContaining([
        'rbook/',
        'tests/',
        'tmp/',
        'coverage/',
        '.eslintcache',
        '.github/',
        'scripts/',
      ])
    );
    expect(npmIgnoreLines).not.toContain('rbook-seed/');
  });

  PRIVATE.describe('private-source npm publish workflow', () => {
    test('triggers on version tags and publishes to npm', () => {
      const workflow = fs.readFileSync(PRIVATE.paths.workflow, 'utf8');

      expect(workflow).toMatch(/name:\s+Publish to npm/);
      expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*-\s*'v\*'/m);
      expect(workflow).toMatch(/npm pack --dry-run/);
      // Publishes with --access public (scoped package). Deliberately WITHOUT --provenance:
      // provenance requires a PUBLIC source repo, but this is the private publish source
      // (F2/F4), so `npm publish --provenance` fails with npm E422 (s73 release). The negative
      // guard stops a well-meaning re-add from re-breaking the publish.
      expect(workflow).toMatch(/npm publish --access public/);
      expect(workflow).not.toMatch(/npm publish --provenance/);
      expect(workflow).toMatch(/NODE_AUTH_TOKEN:\s+\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    });
  });
});

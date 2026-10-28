// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m11 (#651) — migrate renames an old identifier only where it still names the old tooling.
// ABOUTME: Lines 4.0.1's migrate rewrote wrongly in the field, and the build critic's, are fixtures.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateIdentifiers, planDocumentEdits } from '../../src/cli/migrate-docs';
import { LEGACY } from '../../src/intelligence/legacy-compat';

// Quoted from each project's agents.md before 4.0.1's migrate rewrote it. Each project restored
// the line by hand afterwards: cmos-dashboard in 54cb719, aquex.ai in f7d0456, Meridian in place.
const DASHBOARD_HOSTS =
  '- **Hosts**: `reasonbook.ai` is canonical. `cmos.aquex.ai` and `cmos-mcp.com` redirect browser navigations (301); `reasonbook.aquex.ai` uses 302 until its launch page.';
const DASHBOARD_FORMERLY =
  '- **Reasonbook** (`@aquex/reasonbook`, formerly `cmos-mcp`): source of the uploaded SQLite records, agent-side MCP tools (`rbook_*`)';
const DASHBOARD_SCHEMES =
  '│   │   ├── cmos-address.ts    # address parser: rbook:// and cmos:// in, cmos:// on the wire';
const AQUEX_PRODUCTS =
  'Products: OODS Foundry (`@oods/foundry`, Apache-2.0), Stage1 (`@aquex/stage1`, Apache-2.0), Reasonbook, formerly CMOS (`@aquex/reasonbook`, Apache-2.0; `@aquex/cmos-mcp` is deprecated; optional dashboard at reasonbook.ai) and TraceLab (`@aquex/tracelab-mcp`, MIT adapter).';
const AQUEX_SPRINT =
  "**Current sprint (2026-10-13): S14.** Plan: [sprint-14-plan.md](cmos/planning/sprint-14-plan.md). CMOS is now Reasonbook: 4.0 renamed the tools (`rbook_*`), folders (`rbook/`), addresses (`rbook://`) and CLI (`reasonbook`). M04 moves this project's record from `cmos/` to `rbook/`; until then Reasonbook 4 reads it in place. The content authority is the [S12 content brief](cmos/planning/sprint-12-content-brief.md).";
const MERIDIAN_FILE =
  '- [src/meridian/processing/cmos_context.py](src/meridian/processing/cmos_context.py) — CMOS project state fetching';
const MERIDIAN_SLUGS =
  'oods, oods-foundry-mcp, meridian, tracelab, deepsearch, stage1, cmos-mcp, cmos-mcp-2';
const AQUEX_STORE =
  "- SQLite at `cmos/db/cmos.sqlite` is source of truth. It moves to `rbook/db/rbook.sqlite` when S14-M04's offline migration runs; Reasonbook 4 reads it in place until then";
const MERIDIAN_VOLUME = '- **CMOS volume**: `./cmos` → `/app/cmos` in container';

describe('old names that no longer name the old tooling stay', () => {
  it.each([
    ['a host, where a dot and a letter follow (cmos-dashboard)', DASHBOARD_HOSTS],
    ['the old name after "formerly" (cmos-dashboard)', DASHBOARD_FORMERLY],
    ['a line that names both schemes on purpose (cmos-dashboard)', DASHBOARD_SCHEMES],
    ['the deprecated package beside its successor (aquex.ai)', AQUEX_PRODUCTS],
    ['a file name (Meridian)', MERIDIAN_FILE],
    ['a project slug in a list (Meridian)', MERIDIAN_SLUGS],
    ['a record path beside its new form (aquex.ai agents.md:309)', AQUEX_STORE],
    ['a tool glob in a mapping table', '| MCP tools | `cmos_*` | `rbook_*` |'],
    [
      'a setting beside its new name',
      '`CMOS_CONFIG_DIR` is still read when `RBOOK_CONFIG_DIR` is unset.',
    ],
    ['the folder pair at the end of a sentence', 'M04 moves the record from cmos/ to rbook/.'],
    ['a slug an option names', 'tracelab --project cmos-mcp --format json'],
    ['the package an uninstall removes', 'npm uninstall -g @aquex/cmos-mcp'],
    ['the package on a line about its deprecation', '`@aquex/cmos-mcp` is deprecated.'],
    [
      'old names in a parenthesis that opens with "formerly"',
      'Reasonbook (formerly CMOS, `@aquex/cmos-mcp`) ships rbook_* tools.',
    ],
    [
      'file and folder names with any extension',
      'Export to cmos_export.csv, cmos_notes.mdx and src/meridian/cmos_bridge/client.py.',
    ],
    ['prose that names the product before a verb', 'The cmos-mcp review cadence is weekly.'],
    ['the command in a mapping table', '| CLI | `cmos-mcp init` | `reasonbook init` |'],
    ['the command beside its new form', '`cmos-mcp ambient off` is now `reasonbook ambient off`.'],
    ['the folder named in words beside its new name', 'The cmos folder is now the rbook folder.'],
    // The build critic's round 3: every wording of a deprecation note keeps the old package.
    ['the package called deprecated', 'The `@aquex/cmos-mcp` package is deprecated.'],
    ['the package now deprecated', '`@aquex/cmos-mcp` is now deprecated.'],
    ['the package marked deprecated in a list', '- `@aquex/cmos-mcp` (deprecated)'],
    ['the package after "Deprecated:"', 'Deprecated: `@aquex/cmos-mcp`.'],
    ['the package deprecated since a version', '`@aquex/cmos-mcp` — deprecated since 4.0.'],
    // Round 4: a negated install on a deprecation line is advice about the old package.
    [
      'the package a deprecation note says not to install',
      'Do not install `@aquex/cmos-mcp`; it is deprecated.',
    ],
    [
      'the package a deprecation note says to stop installing',
      "Don't `npm i @aquex/cmos-mcp` any more: the package is deprecated.",
    ],
    [
      'the folder named in words beside the new folder',
      'Rename the cmos directory to rbook/ by hand.',
    ],
  ])('leaves %s', (_case, line) => {
    expect(migrateIdentifiers(line, true)).toBe(line);
  });

  it('moves links into the record folder but keeps the folder pair a note names (aquex.ai agents.md:87)', () => {
    expect(migrateIdentifiers(AQUEX_SPRINT, true)).toBe(
      AQUEX_SPRINT.replace(
        '(cmos/planning/sprint-14-plan.md)',
        '(rbook/planning/sprint-14-plan.md)'
      ).replace(
        '(cmos/planning/sprint-12-content-brief.md)',
        '(rbook/planning/sprint-12-content-brief.md)'
      )
    );
  });
});

describe('old names that still name the old tooling are renamed', () => {
  it.each([
    [
      'the command before its verb',
      '`cmos-mcp ambient off` turns the hooks off here.',
      '`reasonbook ambient off` turns the hooks off here.',
    ],
    [
      // The unscoped `reasonbook` on npm is someone else's package, so npx gets the scoped one.
      'the command after npx, as the scoped package',
      'Run `npx -y cmos-mcp init --level builder`.',
      'Run `npx -y @aquex/reasonbook init --level builder`.',
    ],
    [
      'a server entry quoted in a document (the 3.x README)',
      '"command": "cmos-mcp", "args": ["serve"]',
      '"command": "reasonbook", "args": ["serve"]',
    ],
    [
      'the package an npx server entry runs, quoted in a document',
      '"command": "npx", "args": ["-y", "cmos-mcp"]',
      '"command": "npx", "args": ["-y", "@aquex/reasonbook"]',
    ],
    ['a tool at the end of a sentence', 'Call cmos_review.', 'Call rbook_review.'],
    // The build critic's round 2: what 4.0.2 renamed and round 1's rules left.
    [
      'the command after an npx flag',
      'npx --yes cmos-mcp init',
      'npx --yes @aquex/reasonbook init',
    ],
    [
      'the command after an npx flag that takes no value',
      'npx --prefer-offline cmos-mcp init',
      'npx --prefer-offline @aquex/reasonbook init',
    ],
    [
      'the command with a tag',
      'npx -y cmos-mcp@latest init',
      'npx -y @aquex/reasonbook@latest init',
    ],
    [
      'the command another runner runs',
      'pnpm dlx cmos-mcp init',
      'pnpm dlx @aquex/reasonbook init',
    ],
    [
      'a quoted server entry with arguments',
      '"command": "cmos-mcp hook session-start"',
      '"command": "reasonbook hook session-start"',
    ],
    [
      'the command in a list item',
      '- cmos-mcp init --level builder',
      '- reasonbook init --level builder',
    ],
    ['the command in a numbered step', '1. cmos-mcp init', '1. reasonbook init'],
    ['the command after sudo', 'sudo cmos-mcp migrate --apply', 'sudo reasonbook migrate --apply'],
    [
      'the command after a setting',
      'RBOOK_AMBIENT=off cmos-mcp hook prompt',
      'RBOOK_AMBIENT=off reasonbook hook prompt',
    ],
    ['the command in quotes', "bash -c 'cmos-mcp hook stop'", "bash -c 'reasonbook hook stop'"],
    ['a tool and its action', 'Use cmos_session.capture.', 'Use rbook_session.capture.'],
    ['a quoted tool and its action', 'Call `cmos_mission.add`.', 'Call `rbook_mission.add`.'],
    [
      'tools as alternatives',
      'Run cmos_review/cmos_status first.',
      'Run rbook_review/rbook_status first.',
    ],
    [
      'a tool beside a longer new name, which is not its own',
      'Call cmos_review, which writes rbook_review_log.',
      'Call rbook_review, which writes rbook_review_log.',
    ],
    [
      'the package on a line about something else deprecated',
      'Install with `npm i -g @aquex/cmos-mcp` (the --legacy flag is deprecated).',
      'Install with `npm i -g @aquex/reasonbook` (the --legacy flag is deprecated).',
    ],
    [
      'the record folder named in words (older record READMEs)',
      'The script normalises from cmos root and writes to `cmos/dist/`.',
      'The script normalises from rbook root and writes to `rbook/dist/`.',
    ],
    [
      'the record folder named as ./cmos (Meridian agents.md:245; the container side is its own)',
      MERIDIAN_VOLUME,
      '- **CMOS volume**: `./rbook` → `/app/cmos` in container',
    ],
    ['the command before a flag', 'cmos-mcp --version', 'reasonbook --version'],
    ['a tool', 'Call `cmos_review()` first.', 'Call `rbook_review()` first.'],
    [
      'the tool glob',
      'Use the shared CMOS MCP tools (`cmos_*`) for project management.',
      'Use the shared CMOS MCP tools (`rbook_*`) for project management.',
    ],
    ['a setting', 'Set CMOS_CONFIG_DIR to a folder.', 'Set RBOOK_CONFIG_DIR to a folder.'],
    [
      'an address',
      'One message to `cmos://derek/forge` per release.',
      'One message to `rbook://derek/forge` per release.',
    ],
    ['the package', 'npm install -g @aquex/cmos-mcp', 'npm install -g @aquex/reasonbook'],
    [
      'paths into the moved record',
      'See cmos/docs/guide.md and cmos/db/cmos.sqlite.',
      'See rbook/docs/guide.md and rbook/db/rbook.sqlite.',
    ],
    [
      'the record folder on a line with no note',
      'Never write application code into `cmos/`.',
      'Never write application code into `rbook/`.',
    ],
  ])('renames %s', (_case, before, after) => {
    expect(migrateIdentifiers(before, true)).toBe(after);
  });

  it('leaves record paths alone until the record folder moves', () => {
    expect(migrateIdentifiers('See cmos/docs/guide.md.', false)).toBe('See cmos/docs/guide.md.');
  });

  it("keeps a line's own private-use characters while it renames the line", () => {
    // The placeholder for a kept span is a private-use character; one the line holds is never used.
    const line = 'glyph \uE0010\uE001 (formerly cmos) beside cmos_review';
    expect(migrateIdentifiers(line, true)).toBe(
      'glyph \uE0010\uE001 (formerly cmos) beside rbook_review'
    );
  });
});

describe('documents a migration plans', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-rules-'));
    fs.mkdirSync(path.join(root, LEGACY.recordDirectory, 'tiers'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = () => path.join(root, LEGACY.recordDirectory);
  const edited = (file: string) =>
    planDocumentEdits(root, record(), true).edits.find((edit) => edit.file === file);

  it('renames .mcp.json values but never a server key outside mcpServers', () => {
    // Synthesis-Workbench's file: top-level entries, one running the old package from its source.
    const file = path.join(root, '.mcp.json');
    const text = JSON.stringify(
      {
        aquex: { command: 'aquex', args: ['serve', '--stdio'] },
        'cmos-mcp': {
          command: 'node',
          args: [['', 'Users', 'someone', 'cmos-mcp', 'dist', 'index.js'].join('/')],
        },
      },
      null,
      2
    );
    fs.writeFileSync(file, text + '\n');
    expect(edited(file)).toBeUndefined();
  });

  it('moves the standard server entry to rbook and renames its command', () => {
    const file = path.join(root, '.mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { 'cmos-mcp': { command: 'cmos-mcp', args: ['serve'] } } })
    );
    expect(JSON.parse(edited(file)!.after)).toEqual({
      mcpServers: { rbook: { command: 'reasonbook', args: ['serve'] } },
    });
  });

  it('renames the package an npx entry runs, and setting names in env, but keeps a slug', () => {
    const file = path.join(root, '.mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'cmos-mcp': {
            command: 'npx',
            args: ['-y', 'cmos-mcp', '--project', 'cmos-mcp'],
            env: { CMOS_DASHBOARD_URL: 'https://example.test', RBOOK_X: '1', CMOS_X: '2' },
          },
        },
      })
    );
    expect(JSON.parse(edited(file)!.after)).toEqual({
      mcpServers: {
        rbook: {
          command: 'npx',
          args: ['-y', '@aquex/reasonbook', '--project', 'cmos-mcp'],
          // A setting whose new name is already set keeps its old name rather than replace it.
          env: { RBOOK_DASHBOARD_URL: 'https://example.test', RBOOK_X: '1', CMOS_X: '2' },
        },
      },
    });
  });

  it('lists a line that kept an old record path beside its new one, for a look at its tense', () => {
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(agents, `# Notes\n${AQUEX_STORE}\nSee cmos/docs/guide.md.\n`);
    const plan = planDocumentEdits(root, record(), true);
    expect(plan.edits.find((edit) => edit.file === agents)!.after).toBe(
      `# Notes\n${AQUEX_STORE}\nSee rbook/docs/guide.md.\n`
    );
    expect(plan.left).toContain(
      `${agents}: line 2 names the record folder by both its old and its new name, so the old name was left; if it describes the move as still to come, update it by hand.`
    );
  });

  it("leaves the old package's own source documents, reports them, and still moves its record files", () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: LEGACY.packageName, version: '1.0.1' })
    );
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(
      agents,
      '- `src/tools/cmos/` - tool implementations\n- `cmos/` - the record\nUse `cmos_review`.\n'
    );
    const guide = path.join(record(), 'tiers', 'build.md');
    fs.writeFileSync(guide, 'Call `cmos_review()` and read cmos/tiers/build.md.\n');
    const plan = planDocumentEdits(root, record(), true);
    expect(plan.edits.map((edit) => edit.file)).toEqual([guide]);
    expect(plan.edits[0].after).toBe('Call `rbook_review()` and read rbook/tiers/build.md.\n');
    expect(plan.left.join('\n')).toContain(`${agents}: left unchanged`);
    expect(plan.left.join('\n')).toMatch(/1 line names the record folder/);
  });

  it("moves the old package's relative and reference links into the record folder", () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: LEGACY.packageName, version: '1.0.1' })
    );
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(
      agents,
      'See [guide](./cmos/docs/guide.md).\n\n[plan]: cmos/planning/plan.md\n'
    );
    expect(edited(agents)!.after).toBe(
      'See [guide](./rbook/docs/guide.md).\n\n[plan]: rbook/planning/plan.md\n'
    );
  });

  it('lists a line that keeps the record folder beside its new name, for a look at its tense', () => {
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(agents, 'Rename the cmos directory to rbook/ by hand.\n');
    expect(planDocumentEdits(root, record(), true).left).toContain(
      `${agents}: line 1 names the record folder by both its old and its new name, so the old name was left; if it describes the move as still to come, update it by hand.`
    );
  });

  it("moves the old package's links into the record folder, and reads a manifest with a BOM", () => {
    // ~/portfolio/cmos-mcp/agents.md:482 links its build guide; the file moves with the folder.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      '\uFEFF' + JSON.stringify({ name: LEGACY.packageName, version: '1.0.1' })
    );
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(
      agents,
      '- **[Build Tier Guide](cmos/tiers/build.md)** - CMOS build session behavioral guide\n' +
        'See [cmos/docs/live-testing.md](cmos/docs/live-testing.md).\n' +
        '- `cmos/` - Local CMOS workspace (dogfooding)\nUse `cmos_review`.\n'
    );
    // Its .mcp.json runs its own code, so it is left with the documents (an admitted hole).
    const mcp = path.join(root, '.mcp.json');
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { 'cmos-mcp': { command: 'cmos-mcp' } } }));
    const plan = planDocumentEdits(root, record(), true);
    expect(plan.edits.map((edit) => edit.file)).toEqual([agents]);
    expect(plan.edits[0].after).toBe(
      '- **[Build Tier Guide](rbook/tiers/build.md)** - CMOS build session behavioral guide\n' +
        'See [rbook/docs/live-testing.md](rbook/docs/live-testing.md).\n' +
        '- `cmos/` - Local CMOS workspace (dogfooding)\nUse `cmos_review`.\n'
    );
    expect(plan.left.join('\n')).toContain(
      `${agents}: left unchanged but for its links into the record folder`
    );
    expect(plan.left.join('\n')).toMatch(/1 line names the record folder/);
  });
});

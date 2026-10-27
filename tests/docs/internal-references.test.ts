// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m06 — no text Reasonbook publishes to a model or ships to a stranger may cite this
// ABOUTME: repository's own sprints, missions, decisions or issues; worked examples are named.

/**
 * A stranger reading "(Sprint 56 m03)", "(#487 mission -> row trail)" or "s84-m05: on reaffirm" in
 * a tool's parameter table learns nothing, and a model reading it in tools/list spends tokens on a
 * reference it cannot follow. The audit (rbook/research/2026-10-strategy/first-run-and-plugin.md
 * §4.3) counted 6 such references in TOOL_REFERENCE.md, 5 in SECURITY.md and 22 in the seed schema
 * every project receives.
 *
 * THE PREDICATE is the audit's own: `Sprint N`, a mission id `sN-mN`, `decision #N`, `#N`,
 * case-insensitive and with no digit-width limit.
 * Worked examples use the same shapes on purpose (`missionId="s01-m01"`), so a match is an example
 * when it sits inside a fenced code block or an `e.g.` / "for example" parenthetical. The few
 * examples written in prose are named in ALLOWLIST below, each with its reason; an entry that no
 * longer matches anything fails the gate, so the list cannot rot into a blanket exemption.
 *
 * WHAT IS CHECKED: every string value and property name in the tool definitions the server publishes, both
 * the full definitions (which generate TOOL_REFERENCE.md) and the tools/list definitions, and the
 * shipped prose: README.md, SECURITY.md, docs/getting-started.md, docs/harnesses.md,
 * TOOL_REFERENCE.md, and the seed's README and schema plus Markdown/JSON at every depth of docs,
 * templates, tiers, context and foundational-docs; the marketplace and plugin manifests, skills,
 * adapter Markdown/JSON and static string/template spans in every plugin hook module and root-level
 * src/cli implementation module.
 * Static hook strings are a deliberate
 * superset of output: comments are excluded, but private references in a string fail even if a
 * branch currently never emits it. Runtime data and references assembled across separate string
 * spans, Markdown references split across lines, helper output outside the named source directories,
 * other extensions, and symlinked directories are outside this syntax-only gate; behavioral output
 * tests must cover those paths. Matching does not resolve which project's record an id names, so
 * worked examples remain explicit exemptions rather than guessed external references.
 *
 * NOT CHECKED, by rule: CHANGELOG.md (an immutable record of what each release did, sprint ids
 * included), comments compiled into dist/ (maintainer commentary no answer carries), and
 * docs/demo/README.md, whose transcript quotes the demo project's own decision and session ids
 * from end to end; the prose-truth gate checks its claims instead.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { RBOOK_TOOL_DEFINITIONS } from '../../src/tools/rbook';
import { toWireDefinition } from '../../src/tools/rbook/wire-definition';

const REPO_ROOT = path.resolve(__dirname, '../..');

const INTERNAL_REFERENCE =
  /\bSprint [0-9]+\b|\bs[0-9]+-m[0-9]+[a-z]?\b|\bdecision #[0-9]+\b|#[0-9]+\b/gi;

/** Worked examples written in prose, where neither rule can see them as examples. */
const ALLOWLIST: ReadonlyArray<{ file: string; match: string; text: string; reason: string }> = [
  {
    file: 'rbook-seed/tiers/managed.md',
    match: 's42-m01',
    text: 'Don\'t show mission IDs to the user unless they ask. Use task names: "The venue task is done" not "s42-m01 is complete."',
    reason: 'the guide quotes the mission id an agent should NOT show a managed-tier user',
  },
  ...[1, 2, 3, 4].map((sprint) => ({
    file: 'rbook-seed/foundational-docs/roadmap_template.md',
    match: `Sprint ${sprint}`,
    text: `### Sprint ${sprint}: [Sprint Name]`,
    reason: "a blank roadmap heading for the adopting project, not this repository's sprint",
  })),
  {
    file: 'rbook-seed/foundational-docs/roadmap_template.md',
    match: 'Sprint 5',
    text: '### Medium Term (Sprint 5-8)',
    reason: 'a planning-horizon example in the blank roadmap',
  },
  {
    file: 'rbook-seed/foundational-docs/tech_arch_template.md',
    match: 'Sprint 1',
    text: '### MVP (Sprint 1-2)',
    reason: 'an example MVP phase in the blank architecture template',
  },
  {
    file: 'rbook-seed/foundational-docs/tech_arch_template.md',
    match: 'Sprint 3',
    text: '### Sprint 3-4',
    reason: 'an example follow-on phase in the blank architecture template',
  },
];

function publishedFiles(directory: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? publishedFiles(relative)
        : /\.(md|json|mjs)$/.test(entry.name)
          ? [relative]
          : [];
    });
}

const SHIPPED_FILES = [
  'README.md',
  'SECURITY.md',
  'docs/getting-started.md',
  'docs/harnesses.md',
  // s95-m08: public, though not in the npm package; the plugin README links to it on GitHub.
  'docs/trust.md',
  'docs/privacy.md',
  // s95-m01: the documentation home, public on GitHub like the trust page.
  'docs/README.md',
  'docs/reviewer/README.md',
  'docs/reviewer/cases.json',
  // s95-m05: the method page and the starter templates.
  'docs/method.md',
  'templates/ledger/README.md',
  'templates/ledger/AGENTS.md',
  'templates/ledger/CLAUDE.md',
  'templates/planner/README.md',
  'templates/planner/AGENTS.md',
  'templates/planner/CLAUDE.md',
  'templates/builder/README.md',
  'templates/builder/AGENTS.md',
  'templates/builder/CLAUDE.md',
  'TOOL_REFERENCE.md',
  'rbook-seed/README.md',
  'rbook-seed/db/schema.sql',
  '.claude-plugin/marketplace.json',
  ...publishedFiles('plugins/reasonbook'),
  ...publishedFiles('adapters'),
  'src/cli.ts',
  ...fs
    .readdirSync(path.join(REPO_ROOT, 'src/cli'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/cli/${name}`),
  ...['docs', 'templates', 'tiers', 'context', 'foundational-docs'].flatMap((dir) =>
    publishedFiles(`rbook-seed/${dir}`)
  ),
];

interface Finding {
  where: string;
  match: string;
  text: string;
}

/** Whether the match at `index` sits inside an open `(` whose text so far says it is an example. */
function insideExample(text: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      if (depth === 0) return /\be\.g\.|for example/i.test(text.slice(i, index));
      depth -= 1;
    }
  }
  return false;
}

function findingsIn(where: string, text: string): Finding[] {
  const found: Finding[] = [];
  for (const m of text.matchAll(INTERNAL_REFERENCE)) {
    if (insideExample(text, m.index ?? 0)) continue;
    found.push({ where, match: m[0], text: text.trim().slice(0, 160) });
  }
  return found;
}

/** Every published string value and property name, with its path for an actionable failure. */
function definitionStrings(
  value: unknown,
  at: string,
  out: Array<{ at: string; text: string }>
): void {
  if (typeof value === 'string') {
    out.push({ at, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => definitionStrings(item, `${at}[${i}]`, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push({ at: `${at}.${key} (property name)`, text: key });
    definitionStrings(child, `${at}.${key}`, out);
  }
}

function definitionFindings(definitions: readonly unknown[], label: string): Finding[] {
  const strings: Array<{ at: string; text: string }> = [];
  for (const definition of definitions) {
    const name = (definition as { name: string }).name;
    definitionStrings(definition, `${label}:${name}`, strings);
  }
  return strings.flatMap((s) => findingsIn(s.at, s.text));
}

/** A shipped file's published text, retaining source locations for useful failures. */
function publishedLines(rel: string, content: string): Array<{ line: number; text: string }> {
  if (/\.(mjs|json|ts)$/.test(rel)) {
    if (rel.endsWith('.json')) JSON.parse(content);
    const source = ts.createSourceFile(
      rel,
      content,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith('.json')
        ? ts.ScriptKind.JSON
        : rel.endsWith('.ts')
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS
    );
    const strings: Array<{ line: number; text: string }> = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        strings.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: node.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return strings;
  }
  const lines = content.split('\n');
  if (!rel.endsWith('.md')) return lines.map((text, i) => ({ line: i + 1, text }));
  const out: Array<{ line: number; text: string }> = [];
  let fenced = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line: i + 1, text });
  });
  return out;
}

function fileFindings(): Finding[] {
  return SHIPPED_FILES.flatMap((rel) =>
    publishedLines(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).flatMap(
      ({ line, text }) => findingsIn(`${rel}:${line}`, text)
    )
  );
}

function allowed(finding: Finding): boolean {
  return ALLOWLIST.some(
    (entry) =>
      finding.where.startsWith(`${entry.file}:`) &&
      finding.match === entry.match &&
      finding.text === entry.text
  );
}

describe('s92-m06 — no internal sprint, mission, decision or issue references in published text', () => {
  it.each([
    'sprint 7',
    'SPRINT 12000',
    'Decision #2',
    'DECISION #12345',
    '#1',
    '#12',
    '#12345',
    'S12000-M12345',
  ])('does not let capitalization or identifier width hide %s', (reference) => {
    expect(
      findingsIn('control', `See ${reference} for why.`).map((finding) => finding.match)
    ).toEqual([reference]);
  });

  it.each(['full', 'tools/list'])('checks every schema string on the %s surface', (surface) => {
    const definition = {
      name: 'rbook_context',
      description: 'A public tool.',
      inputSchema: {
        type: 'object',
        title: 'Sprint 7',
        properties: {
          projectRoot: {
            type: 'string',
            enum: ['#1'],
            default: 'decision #2',
            examples: [{ explanation: '#12345' }],
            properties: { '#6': { type: 'boolean' } },
          },
        },
      },
    };
    const published = surface === 'full' ? definition : toWireDefinition(definition as never);
    expect(definitionFindings([published], surface).map((finding) => finding.match)).toEqual([
      'Sprint 7',
      '#1',
      'decision #2',
      '#12345',
      '#6',
    ]);
  });

  it('includes the seed context and foundational documents in the published surface', () => {
    expect(SHIPPED_FILES).toEqual(
      expect.arrayContaining([
        'docs/harnesses.md',
        'adapters/codex/hooks.json',
        'rbook-seed/context/master_context.json',
        'rbook-seed/context/project_context.json',
        'rbook-seed/foundational-docs/roadmap_template.md',
        'rbook-seed/foundational-docs/tech_arch_template.md',
      ])
    );
  });

  it('an example allowlist entry does not exempt a private claim with the same id', () => {
    const finding = findingsIn(
      'rbook-seed/tiers/managed.md:1',
      'See s42-m01 for the rationale.'
    )[0];
    expect(allowed(finding)).toBe(false);
  });

  it('finds nested seed Markdown and JSON rather than only immediate guide files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-reference-seed-'));
    try {
      for (const file of ['context/nested/context.json', 'foundational-docs/nested/plan.md']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(
          path.join(root, file),
          file.endsWith('.json') ? '{"note":"#1"}' : 'See #2.'
        );
      }
      const files = publishedFiles(path.relative(REPO_ROOT, root));
      expect(files.map((file) => path.relative(root, path.join(REPO_ROOT, file))).sort()).toEqual([
        'context/nested/context.json',
        'foundational-docs/nested/plan.md',
      ]);
      expect(
        files.flatMap((file) =>
          publishedLines(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).flatMap(
            ({ text }) => findingsIn(file, text).map((finding) => finding.match)
          )
        )
      ).toEqual(['#1', '#2']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['hooks/run.mjs', 'src/cli/session-start.ts'])(
    'checks %s output literals while excluding maintainer comments',
    (filename) => {
      const source = [
        '// Sprint 56 was the historical reason for this implementation.',
        '/* decision #841 stays in a maintainer comment. */',
        'const constant = "s84-m05";',
        'process.stderr.write(`Before Sprint 77 ${constant} after #487`);',
        'process.stdout.write("See decision #926");',
      ].join('\n');
      const findings = publishedLines(filename, source).flatMap(({ text }) =>
        findingsIn('control', text).map((finding) => finding.match)
      );
      expect(findings).toEqual(['s84-m05', 'Sprint 77', '#487', 'decision #926']);
    }
  );

  it('decodes nested manifest strings instead of treating serialized JSON as prose', () => {
    const findings = publishedLines(
      'marketplace.json',
      '{"plugins":[{"description":"See decision \\u0023841"}]}'
    ).flatMap(({ text }) => findingsIn('control', text).map((finding) => finding.match));
    expect(findings).toEqual(['decision #841']);
  });

  it('the predicate and the example rules behave as stated (positive and negative controls)', () => {
    const hits = (text: string): string[] => findingsIn('control', text).map((f) => f.match);
    expect(hits('Optional free-text UX feedback (Sprint 56 m03).')).toEqual(['Sprint 56']);
    expect(hits('Filter to rows (#487 mission -> row trail)')).toEqual(['#487']);
    expect(hits('s84-m05: on reaffirm, set the flag')).toEqual(['s84-m05']);
    expect(hits('see decision #841')).toEqual(['decision #841']);
    expect(hits('The mission ID (e.g., "s12-m06")')).toEqual([]);
    expect(hits('A label (for example "Sprint 12 completed")')).toEqual([]);
    expect(hits('a sprint id such as sprint-22, and port 8080')).toEqual([]);
    const fencedProbe = ['```', 'rbook_mission(action="add", missionId="s01-m01")', '```'];
    expect(fencedProbe.join('\n').match(INTERNAL_REFERENCE)).not.toBeNull();
  });

  it('no tool definition the server publishes carries one, full or tools/list', () => {
    const definitions = RBOOK_TOOL_DEFINITIONS as unknown as readonly Record<string, unknown>[];
    expect(definitions.length).toBe(15);
    const findings = [
      ...definitionFindings(definitions, 'full'),
      ...definitionFindings(
        definitions.map((d) => toWireDefinition(d as never) as unknown),
        'tools/list'
      ),
    ];
    expect(findings).toEqual([]);
  });

  it('no shipped document carries one outside worked examples', () => {
    expect(SHIPPED_FILES.length).toBeGreaterThan(10);
    expect(fileFindings().filter((f) => !allowed(f))).toEqual([]);
  });

  it('every allowlisted example still exists, so the list cannot outlive its reason', () => {
    const findings = fileFindings();
    for (const entry of ALLOWLIST) {
      expect({
        entry: entry.match,
        found: findings.some(
          (f) =>
            f.where.startsWith(`${entry.file}:`) && f.match === entry.match && f.text === entry.text
        ),
      }).toEqual({ entry: entry.match, found: true });
    }
  });
});

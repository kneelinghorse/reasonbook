// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 Instrument 3 — every code-shaped token in a shipped document must resolve to
// ABOUTME: something real, and no shipped document may assert what another one in the same tarball denies.

/**
 * Sprint 86 m05 — INSTRUMENT 3: SHIPPED-PROSE TRUTH.
 *
 * ═══ THE DEFECT CLASS, AND WHY TWO PRIOR ARCS MISSED IT ═══
 * README.md and SECURITY.md ship in the SAME npm tarball and contradicted each other on three
 * data-loss guarantees — soft deletes via `deleted_at`, an automatic snapshot before destructive
 * operations, and a `dry_run` flag. README asserted all three; SECURITY.md, under a heading
 * literally called "Backups & deletion — the honest reality", denied all three. That
 * contradiction shipped in 2.3.0, 2.4.0 and 2.5.0.
 *
 * `git log -L 216,232:README.md` dates that block to 2026-05-07 (826f542, s62-m01) — BEFORE Arc B
 * ("everything documented is true") and before Arc C (which authored SECURITY.md). Both arcs
 * closed over it because both verified GENERATED artifacts against their generators, and prose
 * has no generator. This file is that generator's replacement: not a proofread, a resolver.
 *
 * ═══ MEASURED RED BASELINE (2026-08-12, pre-fix tree) — 13 findings, no false positives ═══
 *   identifier arm (8): `deleted_at` at README.md:218 (0 in the seed schema, 0 in src/ CODE — the
 *                      only two src/ mentions are JSDoc saying the column does NOT exist);
 *                      `RBOOK_AUTO_SNAPSHOT` and `RBOOK_SNAPSHOT_RETENTION_DAYS` at README.md:194-195
 *                      and agents.md:403-404 (0 reads anywhere in src/ or scripts/); `dry_run` at
 *                      README.md:221 (0 in src/ — the real param is `dryRun`, on 2 of 15 tools);
 *                      and `valid_values` at README.md:214 and agents.md:138.
 *   contradiction arm (5): the RBOOK_AUTO_SNAPSHOT / RBOOK_SNAPSHOT_RETENTION_DAYS / deleted_at
 *                      trio, asserted in README.md and agents.md, denied in SECURITY.md.
 *
 * `valid_values` was NOT in the build plan's fix list — the gate found it. Both README.md and
 * agents.md document the error envelope as carrying `valid_values` and `current_state`, while
 * every error the code actually emits uses `validValues` / `currentState` (errors.ts:218,
 * rbook-next-steps.ts:80, and the `result.error.validValues` reads in five routers). A consumer
 * writing `if (err.valid_values)` against the documented shape gets `undefined` forever. Same
 * class as the trio, found by rule rather than by having been noticed.
 *
 * ═══ DIRECTION OF FIX IS ONE-WAY ═══
 * SECURITY.md is the correct document. Every fix moved README.md and docs/getting-started.md
 * TOWARD it, and each claim was re-proven against SOURCE (grep the identifier, read the schema),
 * never against SECURITY.md's prose. That ordering is not a style preference: SECURITY.md's
 * claims are the ones a security reader relies on, and "make the docs agree" would have been
 * satisfied just as well by deleting the true statement.
 *
 * ═══ RESOLUTION CORPUS — WHY CODE AND NOT `grep src/` ═══
 * A token resolves against src/ and scripts/ CODE (AST identifiers + string literals), the seed
 * schema, package.json `scripts`, and package.json `files`. Comments are excluded, and that is
 * load-bearing rather than tidy: `deleted_at` appears twice in src/, both times inside JSDoc
 * saying *"that column does not exist"*. A raw `grep src/` would have resolved the token and
 * passed the very defect this gate exists to catch.
 *
 * ═══ THE NEGATION RULE (no allowlist, and SECURITY.md must stay sayable) ═══
 * A document naming an identifier in order to DENY it is not claiming it exists. SECURITY.md
 * says `RBOOK_AUTO_SNAPSHOT`, `RBOOK_SNAPSHOT_RETENTION_DAYS` and `DB_PATH` "are vestigial — no
 * code reads them", which is TRUE and is exactly the disclosure a reader needs. Without a
 * negation rule this gate would fire on the honest document and the only way to green it would
 * be an allowlist — the failure mode this sprint exists to close. So a token inside a negated
 * sentence is excluded BY RULE, and the same rule is what lets the contradiction arm read
 * SECURITY.md's denials as the authority they are.
 *
 * ═══ FALSE-NEGATIVE PROFILE ═══
 *   - A claim made in prose with no backticked token ("snapshots are taken automatically") is
 *     invisible to both arms. The contradiction arm reaches it only when SECURITY.md's denial
 *     carries a backticked token.
 *   - A token that exists but means something else — a real column named in a false claim about
 *     its behavior — resolves and passes. Existence is not semantics.
 *   - A contradiction between two documents that BOTH state a claim positively (neither denies
 *     the other) is invisible; the arm keys on an explicit denial.
 *   - camelCase identifiers are not checked (too many are prose words). Exactly three token
 *     shapes are: ENV-shaped (`RBOOK_*`), snake_case, and `npm run <script>`. PATHS ARE NOT
 *     CHECKED HERE — path reachability belongs to Instrument 1
 *     (tests/tools/rbook/agent-prompt-reachability.test.ts), which owns the package.json
 *     files[]+bin oracle and the freshly-init'd-root fire test. An earlier revision declared a
 *     'path' token kind that nothing ever constructed, which claimed coverage this file does
 *     not have — the same defect it exists to catch.
 *
 * ═══ EXCLUDED FROM THE TARGET SET, with the rule reason — printed by the gate ═══
 * See EXCLUSIONS below. The gate PRINTS them, because a silent exclusion is this sprint's own
 * defect class.
 */

import { describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { RBOOK_TOOL_DEFINITIONS } from '../../src/tools/rbook';
import { rbookRulesLine } from '../../src/tools/rbook/rules-files';
import { rulesStatistics } from '../../src/tools/rbook/telemetry-stats-rules';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { lastUpdatedBodyChangeFindings } from './last-updated-body-oracle';
import { inspectNpmPack, toPackagePath } from './npm-pack-inspection';

const REPO_ROOT = path.resolve(__dirname, '../..');
const r = (...p: string[]): string => path.join(REPO_ROOT, ...p);

/**
 * TARGET SET — an explicit path list, NOT "package.json files[] entries".
 *
 * The two roles of files[] are different and conflating them was a plan-time defect caught by a
 * critic: files[] is the REACHABILITY ORACLE (what actually ships), but it cannot be the TARGET
 * SET because directory entries mix prose with schemas and configuration. Every shipped prose
 * subtree in scope is named below, so a newly noticed subtree cannot remain absent from both the
 * targets and exclusions.
 */
const PUBLIC_TARGETS = [
  'README.md',
  'SECURITY.md',
  'docs/getting-started.md',
  'docs/harnesses.md',
  'TOOL_REFERENCE.md',
  // Ships inside the `rbook-seed` files[] entry and is the seed's own front page — every claim in
  // it reaches a consumer. It was absent from BOTH lists in the first revision, which is the
  // failure this instrument is about: not a wrong scope decision, an UNSTATED one.
  'rbook-seed/README.md',
  // s95-m08: the trust page, and the plugin's own README, which Anthropic's directory shows as the
  // listing's description. Both are public.
  'docs/trust.md',
  'docs/privacy.md',
  'plugins/reasonbook/README.md',
  // s95-m01: the documentation home and the demo page, which the landing content links to.
  'docs/README.md',
  'docs/demo/README.md',
  // s95-m05: the method page and the starter templates, public in the repository.
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
];

/**
 * Targets that exist ONLY in this private repo. `scripts/mirror-to-public.sh` deletes `agents.md`
 * and the whole `rbook/` tree (PRIVATE_PATHS at :25) while MIRRORING `tests/` — and a test is
 * public-mirror-exposed surface (learning #281). So a gate that unconditionally reads these two
 * files throws ENOENT in the public repo and breaks its suite for everyone.
 *
 * NOT A SILENT SKIP. Absence is only acceptable when it is CONSISTENT with a mirrored checkout —
 * every private target missing together. A partially-missing set means a file was deleted or
 * moved for some other reason, and that fails loudly. Whatever is skipped is PRINTED.
 */
const PRIVATE = requiresPrivateEvidence({
  reason: 'private authority documents and private source-history provenance',
  paths: {
    agents: 'agents.md',
    buildSessionPrompt: 'rbook/docs/build-session-prompt.md',
    // s93-m12: agents.md's architecture reference, environment lists included, moved here.
    architecture: 'rbook/docs/architecture.md',
    rulesPreservation: 'rbook/research/2026-10-s93-probes/m10-repo-rules-preservation.json',
  },
});
const PRIVATE_TARGETS: readonly string[] = [
  PRIVATE.relativePaths.agents,
  PRIVATE.relativePaths.buildSessionPrompt,
  PRIVATE.relativePaths.architecture,
];
const presentPrivateTargets = PRIVATE.availableRelativePaths.filter((file) =>
  PRIVATE_TARGETS.includes(file)
);

/**
 * s87-m04 — the seed's own documentation, swept for IDENTIFIER claims.
 *
 * These ship inside the `rbook-seed` files[] entry and are copied verbatim into every project by
 * `rbook_project(action="init")`, so every identifier they name reaches a consumer as instruction.
 * They are NOT in PRIVATE_TARGETS and must never be added there: `mirror-to-public.sh`'s
 * PRIVATE_PATHS does not list `rbook-seed`, so they ship to the public mirror too — and a check
 * gated on `inPublicMirror` would leave the public copies unchecked in the one repo an external
 * consumer actually reads.
 */
const SEED_DOC_TARGETS = fs
  .readdirSync(r('rbook-seed/docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `rbook-seed/docs/${f}`)
  .sort();

/**
 * s88-m03 — both templates ship inside package.json's `rbook-seed` entry and are copied into every
 * initialized project. They were previously absent from BOTH the targets and exclusions: the
 * exact undeclared-scope failure this instrument's header says it prevents.
 */
const SEED_TEMPLATE_TARGETS = fs
  .readdirSync(r('rbook-seed/templates'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `rbook-seed/templates/${f}`)
  .sort();

/** Tier guides are executable agent instruction prose, not inert configuration. */
const SEED_TIER_TARGETS = fs
  .readdirSync(r('rbook-seed/tiers'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `rbook-seed/tiers/${f}`)
  .sort();

/** Plugin skills are shipped agent instructions, just like the seed's tier guides. */
const PLUGIN_SKILL_TARGETS = walkFiles(r('plugins/reasonbook/skills'), '.md')
  .map((absolute) => toPackagePath(path.relative(REPO_ROOT, absolute)))
  .sort();

const TARGETS = [
  ...PUBLIC_TARGETS,
  ...SEED_DOC_TARGETS,
  ...SEED_TEMPLATE_TARGETS,
  ...SEED_TIER_TARGETS,
  ...PLUGIN_SKILL_TARGETS,
  ...presentPrivateTargets,
];

/** Excluded from the target set, each with the RULE that excludes it. Printed, never silent. */
const EXCLUSIONS: Array<{ pathGlob: string; reason: string }> = [
  {
    pathGlob: 'rbook/planning/**',
    reason:
      'Sprint planning records. Naming a retired tool or a superseded figure there is CORRECT — ' +
      'they are a historical record, not a description of the current surface.',
  },
  {
    pathGlob: 'CHANGELOG.md',
    reason:
      'A release history. Every entry describes the surface AT THAT VERSION; identifiers removed ' +
      'since are supposed to still appear under their old release heading.',
  },
  {
    pathGlob: 'rbook-seed/foundational-docs/**',
    reason:
      'Fill-in-the-blank project scaffolds. Tokens such as `operation_name` and `tool_name` are ' +
      'deliberate consumer placeholders, not claims that those identifiers exist in Reasonbook.',
  },
];

function isExplicitlyExcluded(rel: string): boolean {
  return EXCLUSIONS.some(({ pathGlob }) =>
    pathGlob.endsWith('/**') ? rel.startsWith(pathGlob.slice(0, -2)) : rel === pathGlob
  );
}

// ─── Resolution corpus: what a token may resolve AGAINST ─────────────────────

function walkFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (entry.name.endsWith(ext) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Every identifier and string-literal chunk in a TS file — i.e. the CODE, with comments and
 * JSDoc structurally absent. See the header for why that distinction decides this gate.
 */
function codeTokens(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.push(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const PKG = JSON.parse(fs.readFileSync(r('package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
};

/**
 * What counts as REAL. Every entry is a place a token can legitimately exist; none of them is an
 * exemption for a token that does not.
 *
 *   src/ + scripts/ CODE  — identifiers and string literals only (comments excluded; see header)
 *   rbook-seed/db/schema.sql — column and table names
 *   rbook-seed/tiers/*.md    — shipped tier config (YAML frontmatter in a .md file). agents.md
 *                             documents its keys (`tools_use`, `onboard_fields_show`), which exist
 *                             ONLY there: tier-config.ts mentions `tools_use` in a comment
 *                             explaining the parser ignores it, so a code-only corpus would call
 *                             a true statement false.
 *   tests/ `process.env` READS ONLY — and the narrowness is load-bearing, not fussiness. See
 *                             ENV_READS below.
 */
const CODE_CORPUS: string = (() => {
  const parts: string[] = [];
  for (const f of [...walkFiles(r('src'), '.ts'), ...walkFiles(r('scripts'), '.ts')]) {
    parts.push(codeTokens(f).join('\n'));
  }
  const schema = r('rbook-seed', 'db', 'schema.sql');
  if (fs.existsSync(schema)) parts.push(fs.readFileSync(schema, 'utf8'));
  for (const t of walkFiles(r('rbook-seed', 'tiers'), '.md')) {
    parts.push(fs.readFileSync(t, 'utf8'));
  }
  return parts.join('\n');
})();

/**
 * Env vars actually READ via `process.env` anywhere in the repo, tests included.
 *
 * WHY NOT JUST ADD tests/ TO THE CORPUS — a mistake this gate made and caught on itself, worth
 * recording because it is the failure mode the whole instrument is about. agents.md documents
 * `RBOOK_LIVE_PROJECT_ID`, which is real but read only by a test, so tests/ was added to the
 * corpus wholesale. That immediately turned the gate GREEN on `deleted_at`,
 * `RBOOK_AUTO_SNAPSHOT` and `RBOOK_SNAPSHOT_RETENTION_DAYS` — because THIS FILE names all three,
 * in its own header and assertions, as examples of things that do not exist. The corpus had
 * become self-referential: the gate documenting a defect was what made the defect resolve.
 *
 * So the tests/ contribution is exactly the thing that justified it — a name passed to
 * `process.env` — and nothing else. A test MENTIONING a token proves nothing; a test READING an
 * env var proves that env var is real.
 */
const ENV_READS: Set<string> = (() => {
  const found = new Set<string>();
  const files = [
    ...walkFiles(r('src'), '.ts'),
    ...walkFiles(r('scripts'), '.ts'),
    ...walkFiles(r('tests'), '.ts'),
  ];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    for (const m of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]);
    for (const m of content.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      found.add(m[1]);
    }
  }
  return found;
})();

function existsInCode(token: string, kind?: Token['kind']): boolean {
  if (kind === 'env' && ENV_READS.has(token)) return true;
  return new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(CODE_CORPUS);
}

// ─── Token extraction from a markdown document ───────────────────────────────

interface Token {
  text: string;
  kind: 'env' | 'snake' | 'script';
  line: number;
  sentence: string;
}

/**
 * A sentence is negated when it DENIES the existence of the thing it names. Deliberately
 * narrower than "contains a negation word": `only when you set RBOOK_DASHBOARD_URL` contains no
 * denial of RBOOK_DASHBOARD_URL, and a loose rule reads it as one.
 */
const NEGATED = new RegExp(
  [
    'vestigial',
    'no code reads',
    // Hyphenated compounds are how this reads in practice: "a-column-that-doesn't-exist".
    "does(n't| not)[- ]exist",
    'not[- ]exist',
    'no such',
    'there is (\\*\\*)?no\\b',
    '(is|are|was|were|has been|have been)\\s+(\\w+\\s+and\\s+)?(removed|retired|superseded|deleted)\\b',
    'no table has',
    'no longer (exists|shipped|supported|read)',
    'nothing (implements|writes|reads)',
    'never (created|exists|existed|shipped)',
    'no (automatic|`?deleted_at`?)',
  ].join('|'),
  'i'
);

/**
 * Does the denial in `sentence` actually GOVERN `token`, or does it merely share a sentence with
 * it? Two shapes count, and nothing else does:
 *
 *   (a) the negation immediately precedes the token — "There is **no `deleted_at` net**";
 *   (b) the token is the SUBJECT of a denial predicate — "`RBOOK_AUTO_SNAPSHOT`, … are
 *       **vestigial**", "the legacy `RBOOK_DASHBOARD_SECRET` shared-secret is retired".
 *
 * Sentence co-occurrence alone is not enough, and the counter-example is in SECURITY.md itself:
 * "The `cmk_` keys in that file are stored in plaintext — there is **no** encryption at rest."
 * That sentence denies ENCRYPTION, not `cmk_`. A co-occurrence rule reads it as a denial of the
 * key prefix and then reports agents.md as contradicting SECURITY.md for mentioning `cmk_` at
 * all — a false positive that could only be silenced with an allowlist.
 */
function denialGoverns(sentence: string, token: string): boolean {
  const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const precedes = new RegExp(`\\b(no|not|never)\\b[^.]{0,30}?\`?${t}\`?(?![A-Za-z0-9_])`, 'i');
  const predicate = new RegExp(
    `\`?${t}\`?(?![A-Za-z0-9_])[^.]{0,140}?\\b(is|are|was|were|has been|have been)\\b[^.]{0,40}?` +
      `(vestigial|removed|retired|superseded|deleted|no longer)`,
    'i'
  );
  return precedes.test(sentence) || predicate.test(sentence);
}

/**
 * A markdown document as UNITS — a bullet or paragraph with its continuation lines JOINED.
 *
 * The joining is not cosmetic. SECURITY.md's denial wraps across two lines:
 *     - The environment variables `RBOOK_AUTO_SNAPSHOT`, `RBOOK_SNAPSHOT_RETENTION_DAYS`, …
 *       appear in older docs but are **vestigial — no code reads them.**
 * A line-scoped reader sees the tokens on one line and the denial on the next, and reports the
 * HONEST document as making a false claim. The same shape hides agents.md's "no table has a
 * literal `deleted_at` column". Continuation-joining is what makes the negation rule work at
 * all — the identical defect Instrument 1's markdown arm exists to fix.
 */
interface Unit {
  text: string;
  line: number;
  inFence: boolean;
}

function markdownUnits(content: string): Unit[] {
  const lines = content.split('\n');
  const units: Unit[] = [];
  let current: { parts: string[]; line: number; inFence: boolean } | null = null;
  let inFence = false;

  const flush = (): void => {
    if (current)
      units.push({ text: current.parts.join(' '), line: current.line, inFence: current.inFence });
    current = null;
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) {
      // Inside a fence every line is its own code unit; wrapping is not a thing there.
      units.push({ text: line, line: i + 1, inFence: true });
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    // A new bullet, numbered item, heading or table row starts a new unit; anything else that
    // follows a non-empty line is a CONTINUATION of it.
    if (/^\s*([-*+]|\d+\.|#{1,6}\s|\|)/.test(line) || current === null) {
      flush();
      current = { parts: [line.trim()], line: i + 1, inFence: false };
    } else {
      current.parts.push(line.trim());
    }
  });
  flush();
  return units;
}

/** The sentence within `unit` that contains `token`, or the whole unit when it is one sentence. */
function sentenceFor(unit: string, token: string): string {
  const sentences = unit.split(/(?<=[.!?])\s+(?=[A-Z*`-])/);
  const hit = sentences.find((s) =>
    new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(s)
  );
  return hit ?? unit;
}

function extractTokens(rel: string): Token[] {
  const out: Token[] = [];
  for (const unit of markdownUnits(fs.readFileSync(r(rel), 'utf8'))) {
    // Inside a fenced block the whole line is code; outside, only backticked spans are.
    const candidates: string[] = unit.inFence
      ? [unit.text]
      : [...unit.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    const push = (text: string, kind: Token['kind']): void => {
      // A SQLite PRAGMA name belongs to SQLite's surface, not Reasonbook's — the same "not ours to
      // own" class as a consumer-project path. `PRAGMA user_version` is a real thing that will
      // never appear in src/ or in our schema, and the oracle has nothing to resolve it against.
      // Structural (the token is qualified by the PRAGMA keyword), so no name is written down.
      if (new RegExp(`\\bPRAGMA\\s+\`?${text}\\b`, 'i').test(unit.text)) return;
      out.push({ text, kind, line: unit.line, sentence: sentenceFor(unit.text, text) });
    };

    for (const candidate of candidates) {
      // npm scripts, wherever they appear.
      for (const m of candidate.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) push(m[1], 'script');
      // ENV-shaped names.
      for (const m of candidate.matchAll(/\b(RBOOK_[A-Z0-9_]+)\b/g)) push(m[1], 'env');
      // snake_case identifiers (columns, params, fields).
      const bare = candidate.trim();
      if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(bare)) push(bare, 'snake');
      // `dry_run: true`-shaped claims: a snake_case key with a value. Inside a fence this also
      // catches interface fields (`valid_values?: any[]`), which is how a documented envelope
      // shape gets checked against the shape the code actually emits.
      for (const m of candidate.matchAll(/(?:^|\s)([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\??\s*:\s*\S/g)) {
        push(m[1], 'snake');
      }
    }
  }
  return out;
}

interface Finding {
  where: string;
  message: string;
}

function sweepIdentifierExistence(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of TARGETS) {
    for (const tok of extractTokens(rel)) {
      if (NEGATED.test(tok.sentence)) continue; // denying a thing is not claiming it
      if (tok.kind === 'script') {
        if (!(tok.text in PKG.scripts)) {
          findings.push({
            where: `${rel}:${tok.line}`,
            message: `${rel}:${tok.line} tells a reader to run \`npm run ${tok.text}\`, which is not a package.json script.`,
          });
        }
        continue;
      }
      if (!existsInCode(tok.text, tok.kind)) {
        findings.push({
          where: `${rel}:${tok.line}`,
          message:
            `${rel}:${tok.line} names \`${tok.text}\`, which does not exist in src/ or scripts/ code, ` +
            `nor in rbook-seed/db/schema.sql, rbook-seed/tiers/, or any process.env read. A shipped ` +
            `document may not describe a thing the shipped code does not have.`,
        });
      }
    }
  }
  return findings;
}

// ─── Cross-document contradiction ────────────────────────────────────────────

/**
 * SECURITY.md is the DESIGNATED AUTHORITY, and the arm derives its claim set from that document
 * rather than from a table written here: every backticked token SECURITY.md explicitly denies
 * becomes a claim no other shipped document may assert positively. That is why the trio
 * (`deleted_at`, `RBOOK_AUTO_SNAPSHOT`, `RBOOK_SNAPSHOT_RETENTION_DAYS`) needs no seeding by hand —
 * SECURITY.md already denies all three, in the section it calls "the honest reality".
 */
function deniedBySecurityDoc(): Map<string, string> {
  const denied = new Map<string, string>();
  for (const unit of markdownUnits(fs.readFileSync(r('SECURITY.md'), 'utf8'))) {
    if (unit.inFence) continue;
    for (const m of unit.text.matchAll(/`([^`]+)`/g)) {
      const token = m[1].trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) continue;
      if (!/_/.test(token)) continue; // ENV or snake_case only; prose words are not claims
      // SENTENCE scope, not paragraph scope. A paragraph-scoped rule treats every backticked
      // token in any paragraph containing a negation as denied — measured at 144 findings, of
      // which 141 were tokens SECURITY.md merely mentions ("only when you set
      // `RBOOK_DASHBOARD_URL`"). The denial has to be ABOUT the token to be a denial of it.
      const sentence = sentenceFor(unit.text, token);
      if (!NEGATED.test(sentence)) continue;
      if (!denialGoverns(sentence, token)) continue;
      denied.set(token, sentence);
    }
  }
  return denied;
}

function sweepContradictions(): Finding[] {
  const findings: Finding[] = [];
  const denied = deniedBySecurityDoc();
  for (const rel of TARGETS) {
    if (rel === 'SECURITY.md') continue;
    for (const unit of markdownUnits(fs.readFileSync(r(rel), 'utf8'))) {
      for (const [token, denial] of denied) {
        if (!new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(unit.text)) continue;
        const sentence = sentenceFor(unit.text, token);
        if (NEGATED.test(sentence)) continue; // this document denies it too — they agree
        findings.push({
          where: `${rel}:${unit.line}`,
          message:
            `${rel}:${unit.line} asserts \`${token}\`, which SECURITY.md — shipped in the SAME npm ` +
            `tarball — denies: "${denial.slice(0, 140).replace(/\s+/g, ' ')}…". One of the two is ` +
            `lying to every reader. SECURITY.md is the authority; move this document toward it.`,
        });
      }
    }
  }
  return findings;
}

// ─── Role-bearing claims ─────────────────────────────────────────────────────

/**
 * s89-m02 — ROLE-BEARING SHIPPED PROSE.
 *
 * Scope and false-negative profile are one document, per decision #1063. This arm checks only
 * roles with a shipped mechanical oracle:
 *
 * R1 COLUMN-OF-TABLE — simple Markdown pipe tables whose header has exactly one cell containing
 * "column" and whose data row starts with one backticked table/view name. The named object's
 * columns come from executing rbook-seed/db/schema.sql in memory and reading PRAGMA table_info.
 * R2 EXECUTABLE SQL — semicolon-delimited statements in sql fences are prepared, never executed,
 * against that same seed-schema database.
 * R3 TOOL/ACTION — call-like prose in the form rbook_name(action="value"...), with action first,
 * is checked against RBOOK_TOOL_DEFINITIONS and the named tool's action enum.
 *
 * ROLE_COMPLEMENT below is binding, not an allowlist: each unchecked role states why this parser
 * cannot adjudicate it honestly. In particular, R1 does not infer arbitrary prose or non-pipe
 * tables; R2 does not understand statements constructed across fences or runtime-only schema;
 * and R3 does not claim actionless calls, JSON/MCP syntax, action after another argument, or
 * dynamic action prose. A real identifier in a false semantic claim can still pass every arm.
 */

interface TargetDocument {
  rel: string;
  content: string;
}

interface ColumnRoleSweep {
  objectCount: number;
  keyColumnTableCount: number;
  claimCount: number;
  findings: Finding[];
}

interface SqlRoleSweep {
  statementCount: number;
  findings: Finding[];
}

interface ToolActionRoleSweep {
  claimCount: number;
  findings: Finding[];
}

interface RoleToolDefinition {
  name: string;
  inputSchema: {
    properties?: Record<string, { enum?: readonly unknown[] }>;
  };
}

const ROLE_TOOL_DEFINITIONS = RBOOK_TOOL_DEFINITIONS as unknown as readonly RoleToolDefinition[];

const ROLE_COMPLEMENT: ReadonlyArray<{ role: string; reason: string }> = [
  {
    role: 'dotted table.column references in prose',
    reason:
      'The measured shipped dotted forms are metadata key references, not columns; treating them ' +
      'as columns would make the arm suppress its only current examples rather than verify them.',
  },
  {
    role: 'table existence asserted in free prose',
    reason:
      'The measured examples are deliberately hedged future/runtime tables, so a truthful check ' +
      'needs a hedge grammar that this structural Markdown-table predicate does not possess.',
  },
  {
    role: 'runtime-migration-only columns and tables',
    reason:
      'The oracle is the seed schema shipped beside the document; migration-only names require ' +
      'running their named migration, never silently widening the oracle or adding an allowlist.',
  },
  {
    role: 'semantics of an identifier that really exists',
    reason:
      'Role membership is not behavioural truth: a real column can still be described falsely, ' +
      'and none of the available structural oracles can prove arbitrary prose semantics.',
  },
  {
    role: 'tool/action claims outside rbook_name(action="value"...) syntax',
    reason:
      'Actionless calls, JSON or MCP payloads, action after another argument, and dynamically ' +
      'described actions are outside the deliberately narrow first-argument call-like grammar.',
  },
  {
    role: 'Markdown tables outside the simple pipe-table grammar',
    reason:
      'Multiline cells, embedded pipes, HTML tables, and omitted leading pipes need a real ' +
      'Markdown parser; splitting those forms as ordinary rows would manufacture false claims.',
  },
  {
    role: 'SQL assembled across fences or dependent on runtime-only state',
    reason:
      'The oracle prepares complete semicolon-delimited fence statements against the day-zero ' +
      'seed schema and cannot validate fragments or state supplied by later runtime migrations.',
  },
];

/**
 * Authored per-target regression floors. Summing only TARGETS makes mirror scope explicit:
 * The per-file predicate is the call-like `rbook_tool(action="value")` regex in sweepToolActionRoles.
 * 271 shared claims + 0 agents.md + 46 architecture.md + 63 private build-session claims = 380 in
 * this checkout, while the staged public mirror derives 271 because the private targets are absent.
 * s99-m08 replaces eight demo call recipes with sealed receipt excerpts, without callable examples.
 * s93-m12 moved agents.md's architecture reference (and its claims) to rbook/docs/architecture.md,
 * and the seed's AGENTS.md now names no Reasonbook call (its hook-less block, a separate template, does).
 * s93-m10 removes generic call recipes from agents.md and replaces the private close recipe with
 * the release checklist and runtime carrier. Its zero/63 floors follow those actual scoped texts.
 */
const TOOL_ACTION_CLAIM_FLOORS: Readonly<Record<string, number>> = {
  'README.md': 13,
  'SECURITY.md': 13,
  'docs/getting-started.md': 22,
  'docs/harnesses.md': 0,
  'TOOL_REFERENCE.md': 85,
  'rbook-seed/README.md': 5,
  'docs/trust.md': 3,
  // Three actionable removal calls: purge, logout, revoke; counted by the R3 predicate.
  'docs/privacy.md': 3,
  'plugins/reasonbook/README.md': 0,
  'docs/README.md': 0,
  'docs/demo/README.md': 0,
  'docs/method.md': 1,
  'templates/ledger/README.md': 0,
  'templates/ledger/AGENTS.md': 0,
  'templates/ledger/CLAUDE.md': 0,
  'templates/planner/README.md': 0,
  'templates/planner/AGENTS.md': 0,
  'templates/planner/CLAUDE.md': 0,
  'templates/builder/README.md': 0,
  'templates/builder/AGENTS.md': 0,
  'templates/builder/CLAUDE.md': 0,
  'rbook-seed/docs/README.md': 32,
  'rbook-seed/docs/agents-md-guide.md': 2,
  'rbook-seed/docs/build-session-prompt.md': 8,
  'rbook-seed/docs/getting-started.md': 22,
  'rbook-seed/docs/session-management-guide.md': 19,
  'rbook-seed/docs/sqlite-schema-reference.md': 0,
  'rbook-seed/templates/PROJECT-README-template.md': 3,
  'rbook-seed/templates/AGENTS.md': 0,
  'rbook-seed/templates/AGENTS-no-hooks.md': 2,
  'rbook-seed/templates/CLAUDE-import.md': 0,
  // s95-m06: the Ledger and Planner rbook/README.md, each naming its step-up call.
  'rbook-seed/templates/README-ledger.md': 1,
  'rbook-seed/templates/README-planner.md': 1,
  'rbook-seed/tiers/build.md': 14,
  'rbook-seed/tiers/general.md': 3,
  'rbook-seed/tiers/managed.md': 4,
  'plugins/reasonbook/skills/build/SKILL.md': 9,
  'plugins/reasonbook/skills/close-out/SKILL.md': 6,
  'plugins/reasonbook/skills/feedback/SKILL.md': 3,
  'plugins/reasonbook/skills/init/SKILL.md': 0,
  'plugins/reasonbook/skills/plan/SKILL.md': 7,
  'plugins/reasonbook/skills/record-decision/SKILL.md': 3,
  'plugins/reasonbook/skills/start/SKILL.md': 1,
  'agents.md': 0,
  'rbook/docs/build-session-prompt.md': 63,
  'rbook/docs/architecture.md': 46,
};

function targetDocuments(): TargetDocument[] {
  return TARGETS.map((rel) => ({ rel, content: fs.readFileSync(r(rel), 'utf8') }));
}

function markdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((value) => value.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells !== null && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function seedSchemaColumns(): { objectCount: number; columns: Map<string, Set<string>> } {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(r('rbook-seed/db/schema.sql'), 'utf8'));
    const objects = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all() as Array<{ name: string }>;
    const columns = new Map<string, Set<string>>();
    for (const { name } of objects) {
      const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{
        name: string;
      }>;
      columns.set(name, new Set(rows.map((row) => row.name)));
    }
    return { objectCount: objects.length, columns };
  } finally {
    db.close();
  }
}

function sweepColumnRoles(documents: readonly TargetDocument[]): ColumnRoleSweep {
  const oracle = seedSchemaColumns();
  const findings: Finding[] = [];
  let keyColumnTableCount = 0;
  let claimCount = 0;

  for (const { rel, content } of documents) {
    const lines = content.split('\n');
    for (let headerLine = 0; headerLine < lines.length - 1; headerLine += 1) {
      const headerCells = markdownTableCells(lines[headerLine]);
      if (headerCells === null || !isMarkdownTableSeparator(lines[headerLine + 1])) continue;
      const columnIndexes = headerCells
        .map((cell, index) => (/\bcolumns?\b/i.test(cell) ? index : -1))
        .filter((index) => index >= 0);
      if (columnIndexes.length !== 1) continue;

      keyColumnTableCount += 1;
      const columnIndex = columnIndexes[0];
      for (
        let rowLine = headerLine + 2;
        rowLine < lines.length && markdownTableCells(lines[rowLine]) !== null;
        rowLine += 1
      ) {
        const cells = markdownTableCells(lines[rowLine]) ?? [];
        const tableMatch = (cells[0] ?? '').match(/^`([^`]*)`$/);
        if (!tableMatch) continue;
        const table = tableMatch[1];
        const claimedColumns = [...(cells[columnIndex] ?? '').matchAll(/`([^`]*)`/g)].map(
          (match) => match[1]
        );
        claimCount += claimedColumns.length;
        const actualColumns = oracle.columns.get(table);
        if (!actualColumns) {
          findings.push({
            where: `${rel}:${rowLine + 1}`,
            message:
              `${rel}:${rowLine + 1} assigns ${claimedColumns.length} column claim(s) to ` +
              `\`${table}\`, but the shipped seed schema has no table or view by that name.`,
          });
          continue;
        }
        for (const column of claimedColumns) {
          if (actualColumns.has(column)) continue;
          findings.push({
            where: `${rel}:${rowLine + 1}`,
            message:
              `${rel}:${rowLine + 1} assigns \`${column}\` as a column of \`${table}\`; the ` +
              `shipped seed schema instead exposes [${[...actualColumns].sort().join(', ')}].`,
          });
        }
      }
    }
  }

  return { objectCount: oracle.objectCount, keyColumnTableCount, claimCount, findings };
}

function sweepSqlRoles(documents: readonly TargetDocument[]): SqlRoleSweep {
  const db = new Database(':memory:');
  const findings: Finding[] = [];
  let statementCount = 0;
  try {
    db.exec(fs.readFileSync(r('rbook-seed/db/schema.sql'), 'utf8'));
    for (const { rel, content } of documents) {
      for (const fence of content.matchAll(/```sql\s*\n([\s\S]*?)```/gi)) {
        const statements = fence[1]
          .split(';')
          .map((statement) => statement.trim())
          .filter(Boolean);
        for (const statement of statements) {
          statementCount += 1;
          try {
            db.prepare(`${statement};`);
          } catch (error) {
            findings.push({
              where: rel,
              message: `${rel} contains SQL the shipped seed schema rejects: ${String(error)}`,
            });
          }
        }
      }
    }
  } finally {
    db.close();
  }
  return { statementCount, findings };
}

function sweepToolActionRoles(documents: readonly TargetDocument[]): ToolActionRoleSweep {
  const definitions = new Map(
    ROLE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
  );
  const findings: Finding[] = [];
  let claimCount = 0;
  const pattern = /\b(rbook_[A-Za-z0-9_-]*)\s*\(\s*action\s*=\s*["']([^"']*)["']/g;

  for (const { rel, content } of documents) {
    for (const match of content.matchAll(pattern)) {
      claimCount += 1;
      const line = content.slice(0, match.index).split('\n').length;
      const definition = definitions.get(match[1]);
      if (!definition) {
        findings.push({
          where: `${rel}:${line}`,
          message: `${rel}:${line} names unknown Reasonbook tool \`${match[1]}\`.`,
        });
        continue;
      }
      const validActions = definition.inputSchema.properties?.action?.enum;
      if (!validActions?.includes(match[2])) {
        findings.push({
          where: `${rel}:${line}`,
          message:
            `${rel}:${line} names unknown action \`${match[2]}\` for \`${match[1]}\`; valid ` +
            `actions are [${(validActions ?? []).join(', ')}].`,
        });
      }
    }
  }
  return { claimCount, findings };
}

function expectedToolActionClaimFloor(): number {
  return TARGETS.reduce((sum, rel) => {
    const floor = TOOL_ACTION_CLAIM_FLOORS[rel];
    if (floor === undefined) {
      throw new Error(`No authored tool/action claim floor for target ${rel}`);
    }
    return sum + floor;
  }, 0);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('shipped-prose truth (s86-m05 Instrument 3)', () => {
  it('states its excluded set with the rule that excludes each one', () => {
    // A silent exclusion is this sprint's own defect class. Print, then assert the exclusions
    // are real scope statements rather than an allowlist smuggled in under another name.
    const printed = EXCLUSIONS.map((e) => `  EXCLUDED ${e.pathGlob}\n    reason: ${e.reason}`);
    // eslint-disable-next-line no-console
    console.log(
      `Instrument 3 target set:\n${TARGETS.map((t) => `  ${t}`).join('\n')}\n${printed.join('\n')}`
    );

    expect(EXCLUSIONS.every((e) => e.reason.length > 40)).toBe(true);
    // The exclusions are scope statements, never individual findings. Seed docs are targets for
    // identifier claims here and their eight date stamps are gated by the always-running arm.
    expect(TARGETS.some((t) => t.startsWith('rbook-seed/docs/'))).toBe(true);
    expect(TARGETS.some((t) => t.startsWith('rbook/planning/'))).toBe(false);
  });

  it('accounts for every shipped Markdown file under the seed and plugin', () => {
    const shippedMarkdown = [
      ...walkFiles(r('rbook-seed'), '.md'),
      ...walkFiles(r('plugins/reasonbook'), '.md'),
    ]
      .map((absolute) => toPackagePath(path.relative(REPO_ROOT, absolute)))
      .sort();
    expect(
      shippedMarkdown.filter((rel) => !TARGETS.includes(rel) && !isExplicitlyExcluded(rel))
    ).toEqual([]);
  });

  it('reads every target document (the sweep must not be silently vacuous)', () => {
    for (const rel of TARGETS) expect(fs.existsSync(r(rel))).toBe(true);
    const total = TARGETS.reduce((n, rel) => n + extractTokens(rel).length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });

  it('leaves mirror classification to the shared helper while keeping public targets mandatory', () => {
    expect([0, PRIVATE_TARGETS.length]).toContain(presentPrivateTargets.length);
    for (const rel of PUBLIC_TARGETS) expect(fs.existsSync(r(rel))).toBe(true);
  });

  it('resolves tokens against CODE, not comments', () => {
    // The distinction that decides this gate: `deleted_at` appears twice in src/, both inside
    // JSDoc stating the column does not exist. A comment-blind corpus would resolve it.
    const raw = fs.readFileSync(r('src/tools/rbook/self-capture-guard.ts'), 'utf8');
    expect(raw).toContain('deleted_at');
    expect(codeTokens(r('src/tools/rbook/self-capture-guard.ts'))).not.toContain('deleted_at');
    // …and a real identifier still resolves.
    expect(existsInCode('sprint_id')).toBe(true);
  });

  it('does not resolve a token against its own test file (no self-referential corpus)', () => {
    // This file NAMES `deleted_at`, `RBOOK_AUTO_SNAPSHOT` and `RBOOK_SNAPSHOT_RETENTION_DAYS` as
    // examples of things that do not exist. An earlier revision put tests/ in the corpus
    // wholesale and those mentions made all three resolve — the gate's own documentation of a
    // defect is what silenced it. The corpus is src/ + scripts/ + schema + tiers; tests/
    // contributes process.env READS only.
    expect(existsInCode('deleted_at')).toBe(false);
    expect(existsInCode('RBOOK_AUTO_SNAPSHOT', 'env')).toBe(false);
    expect(existsInCode('RBOOK_SNAPSHOT_RETENTION_DAYS', 'env')).toBe(false);
    // …while an env var read only by a test helper is still real.
    expect(ENV_READS.has('RBOOK_LIVE_PROJECT_ID')).toBe(true);
    expect(existsInCode('RBOOK_LIVE_PROJECT_ID', 'env')).toBe(true);
  });

  it('treats a denial as a denial, not as a claim', () => {
    // SECURITY.md must stay able to name a vestigial variable in order to warn about it.
    expect(NEGATED.test('These variables are **vestigial — no code reads them.**')).toBe(true);
    expect(NEGATED.test('There is **no automatic snapshot** before destructive operations.')).toBe(
      true
    );
    expect(NEGATED.test('Snapshot retention (defaults shown)')).toBe(false);
  });

  it('requires the denial to GOVERN the token, not merely share a sentence with it', () => {
    // (a) negation immediately precedes the token
    expect(denialGoverns('There is **no `deleted_at` soft-delete net**.', 'deleted_at')).toBe(true);
    // (b) the token is the subject of a denial predicate
    expect(
      denialGoverns(
        'The environment variables `RBOOK_AUTO_SNAPSHOT`, `DB_PATH` appear in older docs but are **vestigial**',
        'RBOOK_AUTO_SNAPSHOT'
      )
    ).toBe(true);
    expect(
      denialGoverns(
        'the legacy `RBOOK_DASHBOARD_SECRET` shared-secret is retired',
        'RBOOK_DASHBOARD_SECRET'
      )
    ).toBe(true);
    // THE COUNTER-EXAMPLE, from SECURITY.md itself: the sentence denies ENCRYPTION, not `cmk_`.
    expect(
      denialGoverns(
        'The `cmk_` keys in that file are stored in plaintext — there is **no** encryption at rest',
        'cmk_'
      )
    ).toBe(false);
  });

  it('derives its denied-claim set from SECURITY.md', () => {
    const denied = deniedBySecurityDoc();
    // The trio the whole instrument was built around, derived rather than seeded by hand.
    expect([...denied.keys()]).toEqual(
      expect.arrayContaining(['deleted_at', 'RBOOK_AUTO_SNAPSHOT', 'RBOOK_SNAPSHOT_RETENTION_DAYS'])
    );
  });

  it('names nothing the shipped code does not have', () => {
    expect(sweepIdentifierExistence().map((f) => f.message)).toEqual([]);
  });

  it('asserts nothing another shipped document denies', () => {
    expect(sweepContradictions().map((f) => f.message)).toEqual([]);
  });
});

describe('role-bearing shipped prose (s89-m02)', () => {
  it('prints the checkable roles and their declared complement', () => {
    const printed = ROLE_COMPLEMENT.map(
      ({ role, reason }) => `  UNCHECKED ROLE ${role}\n    reason: ${reason}`
    );
    // eslint-disable-next-line no-console
    console.log(`Role-bearing claim complement:\n${printed.join('\n')}`);
    expect(ROLE_COMPLEMENT.length).toBeGreaterThanOrEqual(7);
    for (const entry of ROLE_COMPLEMENT) expect(entry.reason.length).toBeGreaterThan(40);
  });

  it('R1 checks every claimed Markdown-table column against the named seed-schema object', () => {
    const result = sweepColumnRoles(targetDocuments());
    // eslint-disable-next-line no-console
    console.log(
      `R1 column roles: ${result.objectCount} oracle objects, ` +
        `${result.keyColumnTableCount} Key-Columns table(s), ${result.claimCount} claims`
    );
    // s94-m06: the seed adds `record_links` (27 -> 28); indexes are outside this table/view count.
    expect(result.objectCount).toBe(28);
    expect(result.keyColumnTableCount).toBeGreaterThanOrEqual(1);
    expect(result.claimCount).toBeGreaterThanOrEqual(65);
    expect(result.findings.map((finding) => finding.message)).toEqual([]);
  });

  it('R1 catches the exact decision-column regression in memory', () => {
    const documents = targetDocuments();
    const target = documents.find(
      ({ rel }) => rel === 'rbook-seed/docs/sqlite-schema-reference.md'
    );
    expect(target).toBeDefined();
    const needle = '`decision_text`, `status`';
    expect((target?.content.split(needle).length ?? 1) - 1).toBe(1);
    const mutated = documents.map((document) =>
      document.rel === target?.rel
        ? { ...document, content: document.content.replace(needle, '`decision`, `status`') }
        : document
    );
    const findings = sweepColumnRoles(mutated).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('strategic_decisions');
    expect(findings[0].message).toContain('`decision`');
    expect(findings[0].message).toContain('decision_text');
  });

  it('R1 reports an unknown first-cell table instead of silently skipping it', () => {
    const result = sweepColumnRoles([
      {
        rel: 'fixture.md',
        content:
          '| Object | Key Columns |\n' +
          '| --- | --- |\n' +
          '| `not_a_seed_object` | `id` |\n' +
          '| `Strategic-Decisions` | `id` |\n',
      },
    ]);
    expect(result.claimCount).toBe(2);
    expect(result.findings).toHaveLength(2);
    const messages = result.findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('not_a_seed_object');
    expect(messages).toContain('Strategic-Decisions');
    expect(messages).toContain('no table or view');
  });

  it('R1 captures malformed role values before validating them', () => {
    const result = sweepColumnRoles([
      {
        rel: 'fixture.md',
        content:
          '| Object | Key Columns |\n' +
          '| --- | --- |\n' +
          '| `strategic_decisions` | `Decision`, `decision-text`, `` |\n',
      },
    ]);
    expect(result.claimCount).toBe(3);
    expect(result.findings).toHaveLength(3);
    const messages = result.findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('`Decision`');
    expect(messages).toContain('`decision-text`');
    expect(messages).toContain('``');
  });

  it('R2 prepares every fenced SQL statement without executing it', () => {
    const result = sweepSqlRoles(targetDocuments());
    // eslint-disable-next-line no-console
    console.log(`R2 executable SQL: ${result.statementCount} statements prepared`);
    expect(result.statementCount).toBeGreaterThanOrEqual(12);
    expect(result.findings.map((finding) => finding.message)).toEqual([]);

    const bad = sweepSqlRoles([
      {
        rel: 'fixture.md',
        content: '```sql\nSELECT missing_role_column FROM strategic_decisions;\n```',
      },
    ]);
    expect(bad.statementCount).toBe(1);
    expect(bad.findings).toHaveLength(1);
    expect(bad.findings[0].message).toContain('missing_role_column');
  });

  it('R3 validates every call-like tool/action claim at its derived target-set floor', () => {
    const floor = expectedToolActionClaimFloor();
    const result = sweepToolActionRoles(targetDocuments());
    // eslint-disable-next-line no-console
    console.log(
      `R3 tool/action roles: ${result.claimCount} claims, derived floor ${floor}, ` +
        `${presentPrivateTargets.length}/${PRIVATE_TARGETS.length} private targets present`
    );
    expect(result.claimCount).toBeGreaterThanOrEqual(floor);
    expect(result.findings.map((finding) => finding.message)).toEqual([]);
  });

  it('R3 distinguishes an unknown tool from an unknown action', () => {
    const result = sweepToolActionRoles([
      {
        rel: 'fixture.md',
        content: [
          'rbook_missing(action="list")',
          "rbook_review(action='missing')",
          'rbook_Project(action="list")',
          'rbook_review(action="Init")',
          'rbook_review(action="in-it")',
          'rbook_review(action="")',
        ].join('\n'),
      },
    ]);
    expect(result.claimCount).toBe(6);
    expect(result.findings).toHaveLength(6);
    const messages = result.findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('unknown Reasonbook tool `rbook_missing`');
    expect(messages).toContain('unknown Reasonbook tool `rbook_Project`');
    expect(messages).toContain('unknown action `missing`');
    expect(messages).toContain('unknown action `Init`');
    expect(messages).toContain('unknown action `in-it`');
    expect(messages).toContain('unknown action ``');
  });
});

// ─── agents.md environment-variable read set, derived mechanically ───────────

/**
 * Every `RBOOK_*` env var a tree actually READS, across FIVE access shapes. A deriver that
 * handles only the first two silently misses three real vars, so the shapes are enumerated:
 *
 *   (i)   `process.env.NAME` / `process.env['NAME']`
 *   (ii)  `process.env[CONST]` where CONST is a module-level string constant —
 *         RBOOK_CONFIG_DIR_ENV, the four dashboard-client *_ENV constants, RBOOK_PROJECT_ROOT_ENV,
 *         RBOOK_PROJECT_ID_ENV, STALENESS_THRESHOLD_ENV, RBOOK_CHECKPOINT_SYNC_ENV
 *   (iii) a member read on a `NodeJS.ProcessEnv`-typed PARAMETER that defaults to process.env —
 *         read-only-agent-guard.ts (`env[READ_ONLY_AGENT_ENV]` → RBOOK_AGENT_ROLE),
 *         transformers-offline-env.ts (`env.RBOOK_OFFLINE_EMBEDDINGS`,
 *         `processEnv.RBOOK_MODEL_CACHE_DIR`)
 *   (iv)  a helper taking the name as a string literal — envFloat/envOptFloat/envOptInt in
 *         scripts/measure-retrieval-production.ts
 *
 *   (v)   getSetting with a literal or module-level constant; both accepted prefixes map to
 *         the current documented spelling. Compatibility tests separately verify precedence.
 *
 * FALSE-NEGATIVE PROFILE: a name assembled at runtime (`process.env['RBOOK_' + suffix]`), a name
 * reaching the process through a shell wrapper rather than a code read, and a constant defined
 * in one module and consumed in another are all invisible. None exists in the tree today.
 */
function deriveEnvReads(root: string): Set<string> {
  const out = new Set<string>();
  const files = walkFiles(r(root), '.ts');
  const constMap = new Map<string, string>();
  for (const f of files) {
    for (const m of fs
      .readFileSync(f, 'utf8')
      .matchAll(
        /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]((?:Reasonbook|RBOOK)_[A-Z0-9_]+)['"]/g
      )) {
      constMap.set(m[1], m[2]);
    }
  }
  for (const f of files) {
    const c = fs.readFileSync(f, 'utf8');
    for (const m of c.matchAll(
      /\bgetSetting\(\s*(?:['"]((?:Reasonbook|RBOOK)_[A-Z0-9_]+)['"]|([A-Za-z_][A-Za-z0-9_]*))/g
    )) {
      const name = m[1] ?? constMap.get(m[2]);
      if (name) out.add(name.replace(/^(?:Reasonbook|RBOOK)_/, 'RBOOK_'));
    }
    for (const m of c.matchAll(/process\.env\.(RBOOK_[A-Z0-9_]+)/g)) out.add(m[1]); // (i)
    for (const m of c.matchAll(/process\.env\[\s*['"](RBOOK_[A-Z0-9_]+)['"]\s*\]/g)) out.add(m[1]);
    for (const m of c.matchAll(/process\.env\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const v = constMap.get(m[1]); // (ii)
      if (v) out.add(v);
    }
    for (const m of c.matchAll(/\b(?:env|processEnv)\.(RBOOK_[A-Z0-9_]+)/g)) out.add(m[1]); // (iii)
    for (const m of c.matchAll(/\b(?:env|processEnv)\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const v = constMap.get(m[1]);
      if (v) out.add(v);
    }
    for (const m of c.matchAll(/\b(?:env|processEnv)\[\s*['"](RBOOK_[A-Z0-9_]+)['"]\s*\]/g)) {
      out.add(m[1]);
    }
    for (const m of c.matchAll(/\benv[A-Za-z]*\(\s*['"](RBOOK_[A-Z0-9_]+)['"]/g)) out.add(m[1]); // (iv)
  }
  return out;
}

/**
 * The RBOOK_* names the environment lists hold, split by which subsection they appear under. They
 * moved with agents.md's architecture reference to rbook/docs/architecture.md in s93-m12.
 */
function agentsMdEnvSections(): { server: string[]; scripts: string[] } {
  const content = fs.readFileSync(PRIVATE.paths.architecture, 'utf8');
  // Read the FENCED BLOCK under the heading, not the whole section. Prose around the block
  // legitimately mentions other variables (the note that RBOOK_PROJECT_ROOT is optional), and
  // counting those would make the assertion depend on the surrounding wording rather than on
  // the list itself.
  const grab = (heading: RegExp): string[] => {
    const start = content.search(heading);
    if (start === -1) return [];
    const rest = content.slice(start);
    const open = rest.indexOf('```');
    if (open === -1) return [];
    const close = rest.indexOf('```', open + 3);
    const fence = rest.slice(open, close === -1 ? undefined : close);
    return [...new Set([...fence.matchAll(/\b(RBOOK_[A-Z0-9_]+)\b/g)].map((m) => m[1]))];
  };
  return {
    server: grab(/^###\s+`RBOOK_\*` names read by the shipped server/m),
    scripts: grab(/^###\s+Read only by repo scripts/m),
  };
}

/**
 * PRIVATE-REPO ONLY. These blocks read agents.md and rbook/docs/build-session-prompt.md, both of
 * which scripts/mirror-to-public.sh deletes while still mirroring tests/. The shared wrapper's
 * mirror skip is a SCOPE statement, not a silent pass: partial/private absence fails loudly, and
 * a genuine structural mirror prints exactly what it skipped without evaluating this callback.
 */
const describePrivate = PRIVATE.describe;

describePrivate('agents.md environment-variable block is derived, not maintained (s86-m05)', () => {
  const srcReads = deriveEnvReads('src');
  const scriptReads = deriveEnvReads('scripts');
  const scriptsOnly = [...scriptReads].filter((n) => !srcReads.has(n));

  it('recovers the three shape-(iii) vars a two-shape deriver misses', () => {
    // The fixture the build plan requires: without shape (iii) these three vanish silently, and
    // the documented list would be quietly short by three with nothing to notice it.
    for (const name of ['RBOOK_AGENT_ROLE', 'RBOOK_OFFLINE_EMBEDDINGS', 'RBOOK_MODEL_CACHE_DIR']) {
      expect([...srcReads]).toContain(name);
    }
  });

  it('recovers the shape-(ii) constant-indirection vars', () => {
    for (const name of [
      'RBOOK_CONFIG_DIR',
      'RBOOK_PROJECT_ID',
      'RBOOK_DASHBOARD_USER',
      'RBOOK_DASHBOARD_PASSWORD',
      'RBOOK_STALENESS_THRESHOLD_SPRINTS',
      'RBOOK_CHECKPOINT_SYNC',
    ]) {
      expect([...srcReads]).toContain(name);
    }
  });

  it('recovers the shape-(iv) helper-literal vars from scripts/', () => {
    for (const name of ['RBOOK_RECENCY_OVERRIDE', 'RBOOK_RRFK_OVERRIDE', 'RBOOK_GRAPH_WEIGHT']) {
      expect(scriptsOnly).toContain(name);
    }
  });

  it('documents exactly the server-read set, no more and no less', () => {
    // MEASURED DELTA against the build plan, recorded per its standing instruction: the plan
    // states 16 server-read names. The deriver finds 17 — the plan's enumeration omitted
    // RBOOK_CHECKPOINT_SYNC, a genuine shape-(ii) read at checkpoint-backfill.ts:348
    // (`process.env[RBOOK_CHECKPOINT_SYNC_ENV]`, constant declared :64). 17 is the measured
    // number and the one the document carries. s92-m01 adds RBOOK_EPHEMERAL_PATHS (the extra
    // ephemeral store locations, resolution-policy.ts), making 18. s92-m07 adds RBOOK_DEBUG (the
    // stderr diagnostics gate, debug-log.ts), making 19. s93-m01 added RBOOK_AMBIENT (the hook
    // CLI's per-session off switch, src/cli/core.ts), making 20. s96-m13 adds RBOOK_SHARED_SYNC
    // (the shared record's own sync switch, record-sync-trigger.ts), making 21. s97-m11 adds
    // RBOOK_DASHBOARD_SHARING (dashboard sharing's switch, record-dashboard-share.ts), making 22.
    expect(srcReads.size).toBe(22);
    expect(agentsMdEnvSections().server.sort()).toEqual([...srcReads].sort());
  });

  it('documents exactly the scripts-only read set', () => {
    expect(scriptsOnly.length).toBe(11);
    expect(agentsMdEnvSections().scripts.sort()).toEqual([...scriptsOnly].sort());
  });

  it('no longer documents a variable nothing reads', () => {
    for (const dead of ['RBOOK_AUTO_SNAPSHOT', 'RBOOK_SNAPSHOT_RETENTION_DAYS']) {
      expect(srcReads.has(dead)).toBe(false);
      expect(scriptReads.has(dead)).toBe(false);
      expect(agentsMdEnvSections().server).not.toContain(dead);
      expect(agentsMdEnvSections().scripts).not.toContain(dead);
    }
  });
});

// ─── Stamps, citations and the build-session-prompt reconcile ────────────────

function releaseOrder(a: string, b: string): number {
  const parse = (value: string): { core: bigint[]; pre: string[] } => {
    const match = value.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    );
    if (!match) throw new Error(`Invalid release version: ${value}`);
    const pre = match[4]?.split('.') ?? [];
    if (pre.some((part) => /^0\d+$/.test(part)))
      throw new Error(`Invalid release version: ${value}`);
    return { core: match.slice(1, 4).map(BigInt), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1)
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length)
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const numericLeft = /^\d+$/.test(left);
    const numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function newestReleasedHeading(changelog: string): RegExpMatchArray | null {
  return changelog.match(
    /^##\s*\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?\s*[—-]\s*(\d{4}-\d{2}-\d{2})/m
  );
}

describe('shipped-document stamps and citations (s86-m05)', () => {
  it('does not let an older stable release hide a newer RC from authority-document stamps', () => {
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stable = `## 3.2.0 — ${yesterday}`;
    expect(newestReleasedHeading(stable)?.slice(1)).toEqual(['3.2.0', yesterday]);
    for (const version of ['3.3.0-rc.1', '3.3.0-rc.1+build.2']) {
      for (const heading of [version, `[${version}]`]) {
        const release = newestReleasedHeading(
          `## Unreleased\n\n## ${heading} — ${today}\n\n${stable}`
        );
        expect(release?.slice(1)).toEqual([version, today]);
        // A stamp valid for the older stable release must now fail the same date boundary.
        expect(new Date(yesterday).getTime()).toBeLessThan(new Date(release![2]).getTime());
      }
    }
  });

  it('orders release candidates without accepting an older or different candidate stamp', () => {
    expect(releaseOrder('3.3.0-rc.1', '3.3.0-rc.1')).toBe(0);
    expect(releaseOrder('3.3.0-rc.1', '3.3.0-rc.2')).toBeLessThan(0);
    expect(releaseOrder('3.3.0-rc.2', '3.3.0-rc.10')).toBeLessThan(0);
    expect(releaseOrder('3.3.0-rc.10', '3.3.0')).toBeLessThan(0);
    expect(releaseOrder('3.3.0', '3.3.0-rc.1')).toBeGreaterThan(0);
    expect(releaseOrder('3.2.0', '3.3.0-rc.1')).toBeLessThan(0);
    expect(releaseOrder('3.3.0-alpha.1', '3.3.0-alpha.beta')).toBeLessThan(0);
    expect(releaseOrder('3.3.0-rc', '3.3.0-rc.1')).toBeLessThan(0);
    expect(() => releaseOrder('3.3.0-rc.01', '3.3.0')).toThrow(/version/);
  });

  it('cites a CHANGELOG section that exists and is non-empty', () => {
    // SECURITY.md cited "the `[Unreleased] → Removed` entry"; [Unreleased] is empty and the
    // HTTP-transport removal lives under 2.0.0. A citation into an empty section is a claim
    // that evidence exists where it does not.
    const security = fs.readFileSync(r('SECURITY.md'), 'utf8');
    const changelog = fs.readFileSync(r('CHANGELOG.md'), 'utf8');

    const cite = security.match(/the `\[?([^`\]]+)\]?\s*→\s*([A-Za-z]+)` entry/);
    expect(cite).not.toBeNull();
    const [, section, subsection] = cite as RegExpMatchArray;

    // The cited release heading must exist…
    const headingRe = new RegExp(
      `^##\\s*\\[?${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?.*$`,
      'm'
    );
    const headingMatch = changelog.match(headingRe);
    expect(headingMatch).not.toBeNull();

    // …and the cited subsection under it must carry at least one bullet.
    const after = changelog.slice((headingMatch as RegExpMatchArray).index ?? 0);
    const body = after.slice(
      0,
      after.indexOf('\n## ', 1) === -1 ? undefined : after.indexOf('\n## ', 1)
    );
    const sub = body.match(new RegExp(`^###\\s*${subsection}\\s*$([\\s\\S]*?)(?=^###|\\z)`, 'm'));
    expect(sub).not.toBeNull();
    expect(
      (sub as RegExpMatchArray)[1]
        .trim()
        .split('\n')
        .filter((l) => l.trim().startsWith('-')).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('stamps SECURITY.md against the release it ships in', () => {
    // s92-m06: SECURITY.md no longer cites this repository's sprints (an internal reference a
    // stranger cannot follow; tests/docs/internal-references.test.ts), so the stamp is a release.
    // Same purpose as the sprint stamp it replaces: a footer older than the package carrying it
    // says the document was checked before what it describes. It may name the release being
    // prepared while CHANGELOG.md opens with "## Unreleased", as the launch recipes may.
    const security = fs.readFileSync(r('SECURITY.md'), 'utf8');
    const footer = security.match(
      /_Last verified against the source for release ([0-9A-Za-z.+-]+)\._/
    );
    expect(footer).not.toBeNull();
    const verified = (footer as RegExpMatchArray)[1];
    const pkgVersion = (
      JSON.parse(fs.readFileSync(r('package.json'), 'utf8')) as { version: string }
    ).version;
    const preparing = /^## Unreleased\b/m.test(fs.readFileSync(r('CHANGELOG.md'), 'utf8'));
    const cmp = releaseOrder(verified, pkgVersion);
    expect({ verified, pkgVersion, ok: cmp === 0 || (cmp > 0 && preparing) }).toEqual({
      verified,
      pkgVersion,
      ok: true,
    });
  });

  PRIVATE.describe('private authority-document stamps', () => {
    it('stamps Last Updated no earlier than the release whose content the file documents', () => {
      // WHAT THIS ASSERTS, stated plainly because an earlier revision's NAME promised more than
      // its body delivered: it claimed "not older than the newest sprint the file documents" and
      // then only checked that the date parsed and was not in the future — a bar a 2020 stamp
      // clears. Naming a check you do not perform is this mission's own defect class, in the
      // file that exists to close it.
      //
      // Sprint→date is not available here without the DB, so the ORACLE is CHANGELOG.md: the
      // date of the newest released version. Both files document the surface as of the current
      // release, so a stamp predating that release is stale by construction. Derived from repo
      // content, no hardcoded date, and it fails for the reason its name gives.
      const changelog = fs.readFileSync(r('CHANGELOG.md'), 'utf8');
      const release = newestReleasedHeading(changelog);
      expect(release).not.toBeNull();
      const releaseDate = new Date((release as RegExpMatchArray)[2]).getTime();
      expect(Number.isNaN(releaseDate)).toBe(false);

      for (const [rel, absolute] of [
        [PRIVATE.relativePaths.agents, PRIVATE.paths.agents],
        [PRIVATE.relativePaths.buildSessionPrompt, PRIVATE.paths.buildSessionPrompt],
      ] as const) {
        const content = fs.readFileSync(absolute, 'utf8');
        const stamp = content.match(/\*\*Last Updated\*\*:\s*(\d{4}-\d{2}-\d{2})/);
        expect(stamp).not.toBeNull();
        const stamped = new Date((stamp as RegExpMatchArray)[1]).getTime();
        expect(Number.isNaN(stamped)).toBe(false);

        // The real assertion: not older than the newest release.
        if (stamped < releaseDate) {
          throw new Error(
            `${rel} is stamped "**Last Updated**: ${(stamp as RegExpMatchArray)[1]}", which is ` +
              `EARLIER than the newest release in CHANGELOG.md ` +
              `(${(release as RegExpMatchArray)[1]} — ${(release as RegExpMatchArray)[2]}). ` +
              `The file documents the current surface, so its stamp cannot predate that release.`
          );
        }
        // …and not in the future.
        expect(stamped).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
      }
    });
  });
});

describe('shipped standing-method carrier', () => {
  it('tells every consumer to keep standing-method learnings evergreen', () => {
    const build = fs.readFileSync(r('plugins/reasonbook/skills/build/SKILL.md'), 'utf8');
    expect(build).toMatch(/evergreen: true/);
    expect(build).toMatch(/standing method/);
    expect(build).toMatch(/staleness archival/);
  });
});

describePrivate(
  'repo rules refresh preserves current conventions and the fixed G1 predicate',
  () => {
    type ProtectedLine = { line: number; text: string; home: string; disposition: string };
    const readLedger = () =>
      JSON.parse(fs.readFileSync(PRIVATE.paths.rulesPreservation, 'utf8')) as {
        sources: Array<{ path: string; sha256: string; content: string }>;
        protected: ProtectedLine[];
        counts: { protectedNonemptyLines: number; retained: number; moved: number };
        migrationReceipt: { architectureAfterSha256: string };
      };
    // s94-m09 replaces only the old presence-only compliance claim. Preserve the frozen
    // ledger and the complete original rule/evidence prefix; the bounded replacement's
    // clauses and cross-document parity are checked below. No other protected line changes.
    const practice8Lines = (entries: ProtectedLine[]): ProtectedLine[] =>
      entries.map((entry) =>
        entry.home === PRIVATE.relativePaths.agents &&
        createHash('sha256').update(entry.text).digest('hex') ===
          '190c3fa08a6daf2730457a8c7ebb7ea7eddbcf0e3b96fc8a1435995d8a496019'
          ? {
              ...entry,
              text: entry.text.slice(0, entry.text.indexOf('Compliance is reviewer-judgment;')),
            }
          : entry
      );
    // 2026-10-19: the operator turned GitHub Actions off (agents.md, "No GitHub Actions"). The line
    // said CI enforced the scratch loop; the loop now runs locally, and the obligation the line
    // carried, nothing merges that fails the loop, stays in its replacement. No other line changes.
    const localGateLines = (entries: ProtectedLine[]): ProtectedLine[] =>
      entries.map((entry) =>
        entry.home === PRIVATE.relativePaths.agents &&
        createHash('sha256').update(entry.text).digest('hex') ===
          '9af2f481982f4d51b9e0f316cdc4f437e61fd2753637e9c47b68b2d55880e699'
          ? {
              ...entry,
              text: "The scratch loop is the whole bar, run locally: if it doesn't pass, it doesn't merge.",
            }
          : entry
      );
    // s99-m07 translates names and m09 follows the moved record while retaining every obligation
    // and the original sealed ledger. Operator-owned repository names retain their identity.
    const currentRuleNames = (text: string): string => {
      const kept: string[] = [];
      const preserve = (value: string) => {
        kept.push(value);
        return `RECORD_NAME_${kept.length - 1}_END`;
      };
      let current = text
        .split(`${LEGACY.proseName}-MCP`)
        .join('Reasonbook')
        .split(`~/.config/${LEGACY.configDirectory}/`)
        .join('~/.config/rbook/')
        .replace(/(Detector[^\n]*via `)[^`]+(?=` directory)/, '$1rbook/')
        .replace(
          new RegExp(`${LEGACY.command}-pro|${LEGACY.recordDirectory}-dashboard`, 'g'),
          preserve
        )
        .split(`plugins/${LEGACY.recordDirectory}`)
        .join('plugins/reasonbook')
        .split(LEGACY.command)
        .join('reasonbook')
        .split(`${LEGACY.recordDirectory}-seed`)
        .join('rbook-seed')
        .split(`${LEGACY.proseName}_`)
        .join('RBOOK_')
        .split(LEGACY.proseName)
        .join('Reasonbook')
        .split('C' + LEGACY.recordDirectory.slice(1))
        .join('Rbook')
        .split(LEGACY.recordDirectory)
        .join('rbook');
      kept.forEach((value, index) => {
        current = current.replace(`RECORD_NAME_${index}_END`, value);
      });
      return current;
    };
    const currentPreservationLines = (entries: ProtectedLine[]): ProtectedLine[] =>
      localGateLines(practice8Lines(entries)).map((entry) => ({
        ...entry,
        home:
          entry.home === `${LEGACY.recordDirectory}/docs/build-session-prompt.md`
            ? PRIVATE.relativePaths.buildSessionPrompt
            : entry.home,
        text: currentRuleNames(entry.text),
      }));
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const missingLines = (entries: ProtectedLine[], homes: Map<string, string>) =>
      entries.filter(
        (entry) => !normalize(homes.get(entry.home) ?? '').includes(normalize(entry.text))
      );
    const homes = () =>
      new Map<string, string>([
        [PRIVATE.relativePaths.agents, fs.readFileSync(PRIVATE.paths.agents, 'utf8')],
        [
          PRIVATE.relativePaths.buildSessionPrompt,
          fs.readFileSync(PRIVATE.paths.buildSessionPrompt, 'utf8'),
        ],
      ]);

    it('preserves every protected current line in its declared home, with audited moved counts', () => {
      const ledger = readLedger();
      for (const source of ledger.sources) {
        expect(createHash('sha256').update(source.content).digest('hex')).toBe(source.sha256);
      }
      expect(ledger.protected.length).toBe(ledger.counts.protectedNonemptyLines);
      expect(ledger.protected.filter((entry) => entry.disposition === 'retained').length).toBe(
        ledger.counts.retained
      );
      expect(ledger.protected.filter((entry) => entry.disposition === 'moved').length).toBe(
        ledger.counts.moved
      );
      expect(missingLines(currentPreservationLines(ledger.protected), homes())).toEqual([]);
      const architecture = ledger.sources.find(
        (source) => source.path === `${LEGACY.recordDirectory}/docs/architecture.md`
      )!;
      // The already-moved architecture text was unchanged at this migration boundary. Keep
      // that receipt without freezing the entire architecture document against future edits.
      expect(ledger.migrationReceipt.architectureAfterSha256).toBe(architecture.sha256);
    });

    it('limits the m09 replacement to its exact historical practice-8 claim', () => {
      const original = readLedger().protected;
      const current = practice8Lines(original);
      expect(current.filter((entry, index) => entry.text !== original[index].text)).toHaveLength(1);
      const previous = original.find((entry) => entry.text.startsWith('8. **Name a defect class'))!;
      const replacement = current[original.indexOf(previous)];
      expect(replacement.text).toBe(
        previous.text.slice(0, previous.text.indexOf('Compliance is reviewer-judgment;'))
      );
      expect(missingLines(currentPreservationLines(original), homes())).toEqual([]);
      const unrelated = { ...previous, text: `${previous.text} changed original` };
      expect(practice8Lines([unrelated])).toEqual([unrelated]);
    });

    it('replaces only the CI line, keeping its obligation, once GitHub Actions were turned off', () => {
      const original = readLedger().protected;
      const current = localGateLines(original);
      const changed = current.filter((entry, index) => entry.text !== original[index].text);
      expect(changed).toHaveLength(1);
      expect(changed[0].text).toMatch(/if it doesn't pass, it doesn't merge\.$/);
      expect(missingLines(currentPreservationLines(original), homes())).toEqual([]);
    });

    it.each([
      'publish a runnable PREDICATE',
      'the COUNT it returns across the whole tree BEFORE any matching site is edited',
      'name both the sites it will change and those it deliberately leaves',
    ])('still detects removal of an original practice-8 obligation: %s', (clause) => {
      const required = currentPreservationLines(readLedger().protected).find((entry) =>
        entry.text.startsWith('8. **Name a defect class')
      )!;
      const copies = homes();
      expect(missingLines([required], copies)).toEqual([]);
      copies.set(required.home, copies.get(required.home)!.replace(clause, 'removed obligation'));
      expect(missingLines([required], copies)).toEqual([required]);
    });

    it('detects deletion of the shared-host safeguard from an isolated carrier copy', () => {
      const ledger = readLedger();
      const safeguard = currentPreservationLines(ledger.protected).find((entry) =>
        entry.text.includes('Never restart the shared app host')
      )!;
      expect(safeguard).toBeDefined();
      const copies = homes();
      expect(missingLines([safeguard], copies)).toEqual([]);
      copies.set(safeguard.home, copies.get(safeguard.home)!.replace(safeguard.text, ''));
      expect(missingLines([safeguard], copies)).toEqual([safeguard]);
    });

    it('keeps exactly the Builder pointer and zero procedure matches without weakening the matcher', () => {
      const agents = fs.readFileSync(PRIVATE.paths.agents, 'utf8');
      expect(
        agents
          .split('\n')
          .filter((line) => line.startsWith("Reasonbook keeps this project's record"))
      ).toEqual([rbookRulesLine('builder')]);
      const scan = rulesStatistics(REPO_ROOT);
      expect(scan.files).toBeGreaterThan(0);
      expect(scan.warnings).toEqual([]);
      expect(scan.hits).toEqual([]);
      expect(scan.matchingLines).toBe(0);
    });

    it("retains this repository's release and close safeguards in the rules file", () => {
      const agents = fs.readFileSync(PRIVATE.paths.agents, 'utf8');
      const checklist =
        agents.split('### Release execution and close checklist')[1]?.split('\n### ')[0] ?? '';
      expect(checklist).toMatch(/authorized release end to end/);
      for (const required of [
        'origin/main',
        'full-suite witness',
        'measuredAt',
        'startup/current build hashes',
        'archivedDecisionIds',
        'learningIds',
        'Array.isArray',
        'do not retry the close',
        'separate post-release state commit',
      ])
        expect(checklist).toContain(required);
      expect(checklist).toMatch(/stop and fail loudly/);
      expect(agents).toContain("Restart only this session's server after every build");
      expect(agents).toContain('never hand the\nreconnect to the operator');
    });
  }
);

describePrivate('build-session-prompt ↔ agents.md process-hardening parity (s86-m05, #500)', () => {
  const promptPath = PRIVATE.paths.buildSessionPrompt;

  /**
   * The Process Hardening section of one document, as its numbered practice titles.
   *
   * SECTION-SCOPED, and the scoping is the whole test. An earlier revision matched a
   * numbered-bold-heading pattern across each WHOLE file and asserted only "at least 6" on each
   * side. It passed — for entirely the wrong reason: it found 22 headings in agents.md (five
   * unrelated numbered lists — project-resolution priority, the known-accepted consequences, the
   * AI-agent instructions) and 6 in build-session-prompt.md that were the FIXTURE-CHECKLIST
   * items, not the practices. It never compared the two lists, and could not have failed if the
   * prompt had dropped a practice. Rule 9: a test that cannot fail when the logic changes is wrong.
   *
   * The two files write the same list differently — agents.md puts the number outside the bold
   * span, build-session-prompt.md puts it inside — so both shapes are accepted, but ONLY within
   * the Process Hardening section of each file.
   */
  const processHardeningSection = (content: string): string => {
    const start = content.search(/^#{2,3}\s+Process Hardening/m);
    if (start === -1) return '';
    // Slice past the whole heading LINE. Advancing by one character leaves `## …` behind when
    // the heading was `### …`, which matches the section-END pattern at offset 0 and yields an
    // empty section — silently, and the parity assertion would then compare [] to [].
    const afterHeading = content.indexOf('\n', start);
    const rest = content.slice(afterHeading === -1 ? start : afterHeading + 1);
    const end = rest.search(/^#{2,3}\s/m);
    return end === -1 ? rest : rest.slice(0, end);
  };

  const processHardeningPracticeBlocks = (
    content: string
  ): Array<{ readonly number: number; readonly title: string; readonly body: string }> => {
    const section = processHardeningSection(content);
    // Two shapes exist and each document uses ONE of them for its practices:
    //   OUTSIDE — `1. **Title** — …`   (agents.md's practices, and the prompt's nested
    //                                   6-path fixture checklist)
    //   INSIDE  — `**1. Title — …**`   (the prompt's practices)
    // Matching both shapes in both files double-counts the prompt: it returns 13, the seven
    // practices PLUS the six checklist items nested inside practice 4. Which shape a file uses
    // is decided by its FIRST numbered item in the section — practice 1 — so the shape is read
    // off the document rather than assumed per-file.
    // s91-m08: `\d+`, not `\d` — practice 10 is the first two-digit practice, and a single-digit
    // pattern silently stops counting at nine.
    const OUTSIDE = /^(\d+)\.\s+\*\*([^*]+?)\*\*/gm;
    const INSIDE = /^\*\*(\d+)\.\s+([^*—]+?)(?:\s+—|\*\*)/gm;
    const firstOutside = section.search(/^\d+\.\s+\*\*/m);
    const firstInside = section.search(/^\*\*\d+\.\s+/m);
    const usesInside = firstInside !== -1 && (firstOutside === -1 || firstInside < firstOutside);
    const pattern = usesInside ? INSIDE : OUTSIDE;
    const matches = [...section.matchAll(pattern)];
    return matches.map((match, index) => ({
      number: Number(match[1]),
      title: match[2].trim(),
      body: section.slice(
        match.index,
        index + 1 < matches.length ? matches[index + 1].index : section.length
      ),
    }));
  };

  const processHardeningPractices = (content: string): string[] =>
    processHardeningPracticeBlocks(content).map(
      (practice) => `${practice.number}. ${practice.title}`
    );

  const markdownSection = (content: string, heading: string): string => {
    const start = content.indexOf(heading);
    if (start === -1) return '';
    const rest = content.slice(start + heading.length);
    const end = rest.search(/^###\s+/m);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('carries ten numbered practices, at parity with agents.md', () => {
    // agents.md says "Full text + evidence lives in build-session-prompt.md" — so the cited
    // authority must not be the weaker of the two documents.
    const agentsPractices = processHardeningPractices(
      fs.readFileSync(PRIVATE.paths.agents, 'utf8')
    );
    const promptPractices = processHardeningPractices(fs.readFileSync(promptPath, 'utf8'));

    // Premise check: the extractor found a Process Hardening section in BOTH files. Without
    // this, two empty lists would compare equal and the parity assertion would be vacuous.
    // s91-m08: practice 10 (rules live in documents; rows expire; a next-step holds a lease).
    expect(agentsPractices.length).toBe(10);
    expect(promptPractices.length).toBe(10);

    // Same practices, same order — compared by NUMBER and by the leading words of the title,
    // so a reworded title does not fail but a DROPPED or REORDERED practice does.
    const key = (s: string): string =>
      s.toLowerCase().replace(/[`_*]/g, '').split(/\s+/).slice(0, 3).join(' ');
    expect(promptPractices.map(key)).toEqual(agentsPractices.map(key));
  });

  /**
   * SCOPE + FALSE-NEGATIVE PROFILE (#1063): these assertions check only the presence,
   * numbering, parity, and clause wording of practices 8 and 9 in agents.md and
   * rbook/docs/build-session-prompt.md.
   *
   * This file does not verify practice-8 sweep execution. The separate class-sweeps gate checks
   * only s92-m03, s92-m09 and both s94-m11 arms over tracked UTF-8 src files, across extensions:
   * current witnesses, residual predicates and historical ledger arithmetic. Whole-tree scope,
   * pre-edit chronology, semantic classifications and all other sweeps remain unverified by
   * machine checks. snapshot-diet independently retains its recursive untracked INSERT checks.
   * Neither gate reads the shared mutable Reasonbook store as evidence of historical compliance.
   * They cannot see COMPLIANCE with practice 9 either: next-step #555 passes the strongest
   * home-of-record text predicate by citing rbook-context-view.ts while never naming its actual
   * home, rbook/planning/phase-2-master-plan.md. A predicate that green-lights its motivating
   * counterexample is a fake gate. These checks also key on wording, so a rewrite that retains
   * every keyword while inverting the rule can pass; sentence correctness is reviewer-judgment.
   *
   * This block runs only in the private tree. Both targets are PRIVATE_PATHS in
   * scripts/mirror-to-public.sh; the enclosing private-only block skips by scope in the public
   * mirror and prints what it skipped. The complement — rbook-seed/docs/build-session-prompt.md and
   * rbook-seed/templates/AGENTS.md (s93-m12 retired the private rbook/templates/agents.md) —
   * deliberately has no Process Hardening section, as the existing seed assertion below requires. Finally, this gates two of
   * the twenty standing process-rule decision rows absent from both authority documents before
   * this mission; the other eighteen remain out of scope and are named as a next-step. Historical
   * planning prose that proposed these rules is evidence, not either designated authority.
   */
  const practice8MachineClauses = [
    ['names the artifact home', /tests\/sweeps\//, 'tests/sweeps/'],
    [
      'names the separate source gate',
      /tests\/docs\/class-sweeps\.test\.ts/,
      'tests/docs/class-sweeps.test.ts',
    ],
    ['limits the machine claim', /Machine checks cover only/, 'Machine checks cover only'],
    ['requires s92-m03', /s92-m03/, 's92-m03'],
    ['requires s92-m09', /s92-m09/, 's92-m09'],
    [
      'requires both s94-m11 arms',
      /both s94-m11 arms \(literal and variable commands\)/,
      'both s94-m11 arms (literal and variable commands)',
    ],
    [
      'limits current source scope',
      /tracked UTF-8 files under `src\/` across all extensions/,
      'tracked UTF-8 files under `src/` across all extensions',
    ],
    [
      'checks current witnesses and residuals',
      /current witnesses\/residual predicates/,
      'current witnesses/residual predicates',
    ],
    ['checks ledger arithmetic', /historical ledger arithmetic/, 'historical ledger arithmetic'],
    [
      'leaves whole-tree coverage unverified',
      /Whole-tree coverage, pre-edit chronology, semantic classifications and compliance for all other sweeps remain unverified by machine checks/,
      'Whole-tree coverage, pre-edit chronology, semantic classifications and compliance for all other sweeps remain unverified by machine checks',
    ],
    [
      'retains the separate untracked snapshot gate',
      /snapshot-diet\.test\.ts` separately checks untracked snapshot INSERT sites; this tracked-source gate does not replace it/,
      'snapshot-diet.test.ts` separately checks untracked snapshot INSERT sites; this tracked-source gate does not replace it',
    ],
  ] as const;
  const practice8MachineFindings = (body: string): string[] =>
    practice8MachineClauses.filter(([, pattern]) => !pattern.test(body)).map(([label]) => label);

  it('states the exact bounded machine checks and their unverified complements in both authorities', () => {
    for (const file of [PRIVATE.paths.agents, promptPath]) {
      const body =
        processHardeningPracticeBlocks(fs.readFileSync(file, 'utf8')).find(
          (practice) => practice.number === 8
        )?.body ?? '';
      expect({ file, findings: practice8MachineFindings(body) }).toEqual({ file, findings: [] });
    }
  });

  it.each(practice8MachineClauses)(
    'rejects a practice-8 clause deletion: %s',
    (label, _pattern, token) => {
      const body =
        processHardeningPracticeBlocks(fs.readFileSync(PRIVATE.paths.agents, 'utf8')).find(
          (practice) => practice.number === 8
        )?.body ?? '';
      expect(practice8MachineFindings(body)).toEqual([]);
      const changed = body.split(token).join('removed clause');
      expect(changed).not.toBe(body);
      expect(practice8MachineFindings(changed)).toContain(label);
    }
  );

  it('keeps every required clause of practices 8 and 9 in each authority document', () => {
    const clauses = [
      [
        8,
        [
          ['names the defect CLASS', /\bdefect class\b/i],
          ['names the PREDICATE', /\bpredicate\b/i],
          ['names the site COUNT', /\bcount\b/i],
          ['names the before-edit ORDERING', /before .{0,60}edit/i],
          ['names the WHOLE-TREE scope', /whole tree|across the (?:whole )?tree/i],
          ['cites learning #364 and decision #1085', /learning #364.*decision #1085/i],
        ],
      ],
      [
        9,
        [
          ['names the HOME OF RECORD', /home of record/i],
          ['calls the row a CACHE', /\bcache\b/i],
          ['names the read-on-a-SCHEDULE test', /read (?:on a schedule|at every sprint open)/i],
          ['names the OPERATOR', /operator/i],
          [
            'limits declared authority to a registered foundational document',
            /projectIdentity\.foundational_docs|registered foundational document/i,
          ],
          ['limits cache treatment to a duplicate database row', /duplicate database row/i],
          ['cites decision #1086', /decision #1086/i],
        ],
      ],
    ] as const;
    const issues: string[] = [];

    for (const [rel, absolute] of [
      [PRIVATE.relativePaths.agents, PRIVATE.paths.agents],
      [PRIVATE.relativePaths.buildSessionPrompt, PRIVATE.paths.buildSessionPrompt],
    ] as const) {
      const blocks = processHardeningPracticeBlocks(fs.readFileSync(absolute, 'utf8'));
      for (const [practiceNumber, requiredClauses] of clauses) {
        const block = blocks.find((candidate) => candidate.number === practiceNumber);
        if (!block) {
          issues.push(`${rel} is missing Process Hardening practice ${practiceNumber}`);
          continue;
        }
        for (const [clauseName, pattern] of requiredClauses) {
          if (!pattern.test(block.body)) {
            issues.push(`practice ${practiceNumber} in ${rel} ${clauseName}`);
          }
        }
      }
    }

    expect(issues).toEqual([]);
  });

  it('keeps the canonical normative paragraph identical across both authority documents', () => {
    const agentsBlocks = processHardeningPracticeBlocks(
      fs.readFileSync(PRIVATE.paths.agents, 'utf8')
    );
    const promptBlocks = processHardeningPracticeBlocks(fs.readFileSync(promptPath, 'utf8'));
    const starts = [
      [8, /If a mission names a defect class/],
      [9, /Before asking the operator to adjudicate a record's status/],
    ] as const;
    const canonicalLine = (body: string, start: RegExp): string => {
      const offset = body.search(start);
      return offset === -1 ? '' : body.slice(offset).split('\n')[0].trim();
    };

    for (const [practiceNumber, start] of starts) {
      const agentsBlock = agentsBlocks.find((block) => block.number === practiceNumber);
      const promptBlock = promptBlocks.find((block) => block.number === practiceNumber);
      expect(agentsBlock).toBeDefined();
      expect(promptBlock).toBeDefined();
      expect(canonicalLine(promptBlock?.body ?? '', start)).toBe(
        canonicalLine(agentsBlock?.body ?? '', start)
      );
      expect(canonicalLine(agentsBlock?.body ?? '', start)).not.toBe('');
    }
  });

  it('places practices 8 and 9 at their mission-authoring and review decision points', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    const authoring = markdownSection(prompt, '### Mission Authoring Conventions');
    const review = markdownSection(prompt, '### Sprint Review Session');

    expect(authoring).toMatch(/classSweep/);
    expect(authoring).toMatch(/practice 8/i);
    expect(authoring).toMatch(/tests\/sweeps\/<id>\.json/);
    expect(authoring).toMatch(/private whole-tree pre-edit evidence/);
    expect(authoring).toMatch(/tracked UTF-8 `src\/` files across all extensions/);
    expect(review).toMatch(/home of record/i);
    expect(review).toMatch(/practice 9/i);
  });

  it('states that the Process Hardening set now contains ten practices', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/bringing the set to ten/);
    expect(prompt).not.toMatch(/bringing the set to (?:seven|nine)/);
  });

  it('carries the 6-path checklist, the positive-fire clause and the no-silent-fail-open rule', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/6-path/);
    expect(prompt).toMatch(/POSITIVE FIRE|positive-fire/i);
    expect(prompt).toMatch(/silent fail-open/i);
  });

  it('describes the adversarial critic as blocking at BOTH plan-time and build-time', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/plan-time/i);
    expect(prompt).toMatch(/build-time/i);
    expect(prompt).toMatch(/blocking/i);
  });

  it("says '5-path' in neither file", () => {
    expect(fs.readFileSync(promptPath, 'utf8')).not.toMatch(/5-path/);
    expect(fs.readFileSync(PRIVATE.paths.agents, 'utf8')).not.toMatch(/5-path/);
  });

  it('points See-Also at a document that exists', () => {
    // rbook/docs/mcp-reference.md never existed; the generated tool documentation is
    // TOOL_REFERENCE.md.
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).not.toMatch(/mcp-reference\.md/);
  });

  it('leaves the rbook-seed copy untouched (it has no Process Hardening section at all)', () => {
    // REFUTED at plan time and re-verified here: "syncing" the two would import ~370 lines of
    // Reasonbook-internal sprint methodology into every consumer project.
    const seed = fs.readFileSync(r('rbook-seed/docs/build-session-prompt.md'), 'utf8');
    expect(seed).not.toMatch(/Process Hardening/);
    expect(seed).not.toMatch(/6-path/);
    expect(seed).not.toMatch(/5-path/);
  });
});

/**
 * s87-m04 + s88-m03 + s88-m07 — ARC F ITEM 3, ALL BOLD SHIPPED SEED-MARKDOWN STAMPS.
 *
 * #1009's enumeration named the seed's stale stamps as an Arc F item. The schema-version and tool-
 * count claims are checkable against something the tarball itself ships. s88-m03 performed the
 * required per-file review and corrected all eight bold **Last Updated** stamps in shipped seed
 * Markdown. s88-m07 replaces its release-date proxy with the body-change oracle: git is available
 * at TEST time, so a stamp must be at least as recent as the file's latest non-stamp body change.
 * Stamp-only edits are ignored. A real temporary npm tarball supplies the files and stamp bytes.
 * The oracle follows committed renames, compares merge diffs per parent, and treats a tracked
 * working-tree body edit as a change today. It fails loudly when a file is untracked, history is
 * shallow/unavailable, or a file's lineage combines a committed rename with a merge — git --follow
 * cannot prove per-parent paths for that bounded composition, so it is never allowed to silently
 * green. It runs in both source repositories;
 * a public-mirror transport commit therefore counts at that repository's committer date. This is a
 * necessary freshness relation, not proof that a human reviewed the prose: a dishonest stamp-only
 * bump remains outside what git can establish. Lowercase prose-like source-code comments are
 * outside this deliberately bold-Markdown contract, and date-only stamps cannot distinguish two
 * body edits made on the same calendar day.
 *
 * THE PACKED-CONTENT ARM ALWAYS RUNS. `rbook-seed/**` is not mirror-excluded, so the public clone
 * still verifies the stamp count, syntax, future-date bound, schema version, and tool count. The
 * one private-history comparison is scoped separately: a mirror release commit re-dates private
 * body changes, so public Git history cannot establish when the private source body changed.
 * Treating that mirror commit date as source provenance produced this suite's public false RED.
 */
describe('the seed ships stamps that describe the seed (s87-m04 + s88-m03 + s88-m07)', () => {
  /** The schema version the SHIPPED seed actually seeds. Read from the generated file, not typed. */
  function seededSchemaVersion(): string {
    const sql = fs.readFileSync(r('rbook-seed/db/schema.sql'), 'utf8');
    const m = sql.match(
      /INSERT OR IGNORE INTO metadata \(key, value\) VALUES \('schema_version', '([^']+)'\)/
    );
    if (!m)
      throw new Error('rbook-seed/db/schema.sql seeds no schema_version — the oracle is gone');
    return m[1];
  }

  function stampsIn(rel: string, label: string): Array<{ rel: string; value: string }> {
    return stampsInContent(rel, label, fs.readFileSync(r(rel), 'utf8'));
  }

  function stampsInContent(
    rel: string,
    label: string,
    content: string
  ): Array<{ rel: string; value: string }> {
    const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, 'g');
    const out: Array<{ rel: string; value: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push({ rel, value: m[1].trim() });
    return out;
  }

  /** Every Markdown file under package.json's shipped `rbook-seed` directory entry. */
  const SEED_MD = walkFiles(r('rbook-seed'), '.md')
    .map((absolute) => toPackagePath(path.relative(REPO_ROOT, absolute)))
    .sort();

  const PACKED = inspectNpmPack(REPO_ROOT);

  const shipsInPackage = (rel: string): boolean => PACKED.files.has(rel);

  const lastUpdatedStamps = (): Array<{ rel: string; value: string }> =>
    [...PACKED.seedMarkdown].flatMap(([rel, content]) =>
      stampsInContent(rel, 'Last Updated', content)
    );

  it('records that the old private-only Last Updated arm covered zero tarball stamps', () => {
    // These private paths are excluded from both the tarball and the public mirror.
    expect(PRIVATE_TARGETS).toHaveLength(3);
    expect(PRIVATE_TARGETS.filter(shipsInPackage)).toEqual([]);
  });

  it('checks the seven bold Last Updated stamps in actual packed seed Markdown', () => {
    const stamps = lastUpdatedStamps();
    const expectedStampPaths = [
      'rbook-seed/README.md',
      'rbook-seed/docs/README.md',
      'rbook-seed/docs/agents-md-guide.md',
      'rbook-seed/docs/build-session-prompt.md',
      'rbook-seed/docs/getting-started.md',
      'rbook-seed/docs/session-management-guide.md',
      'rbook-seed/docs/sqlite-schema-reference.md',
    ].sort();

    // The count is a regression floor, not prose: six docs + the seed README. s93-m12 dropped the
    // AGENTS.md template's footer stamp, which init would copy into every new project's rules
    // file. The template files are ordinary identifier/contradiction targets all the same; s95-m06
    // added the Ledger and Planner READMEs, which carry no stamp, making six.
    expect(stamps).toHaveLength(7);
    expect(stamps.map((stamp) => stamp.rel).sort()).toEqual(expectedStampPaths);
    expect([...PACKED.seedMarkdown.keys()].sort()).toEqual(SEED_MD);
    expect(stamps.every((stamp) => shipsInPackage(stamp.rel))).toBe(true);
    expect(SEED_TEMPLATE_TARGETS).toHaveLength(6);
    expect(SEED_TEMPLATE_TARGETS.every((rel) => TARGETS.includes(rel))).toBe(true);
    expect(SEED_TEMPLATE_TARGETS.every(shipsInPackage)).toBe(true);

    const malformed = stamps
      .filter((stamp) => !/^\d{4}-\d{2}-\d{2}$/.test(stamp.value))
      .map((stamp) => `${stamp.rel} has malformed Last Updated value "${stamp.value}"`);
    expect(malformed).toEqual([]);

    const future = stamps
      .filter((stamp) => new Date(stamp.value).getTime() > Date.now() + 24 * 60 * 60 * 1000)
      .map((stamp) => `${stamp.rel} has future Last Updated value "${stamp.value}"`);
    expect(future).toEqual([]);
  });

  PRIVATE.describe('private source-history provenance for packed seed stamps', () => {
    it('confirms the old private-only arm actually observed two private stamps', () => {
      expect(PRIVATE_TARGETS.flatMap((rel) => stampsIn(rel, 'Last Updated'))).toHaveLength(2);
    });

    it('dates each Last Updated stamp from the private body history', () => {
      expect(lastUpdatedBodyChangeFindings(REPO_ROOT, lastUpdatedStamps())).toEqual([]);
    });
  });

  it('every **Schema Version** stamp in the shipped seed names the version the seed seeds', () => {
    const expected = seededSchemaVersion();
    // Non-vacuity: if nobody stamps a schema version, this arm has nothing to protect and should
    // say so rather than pass. RED baseline at HEAD 1a54a79: THREE stamps read "2.0" against a
    // seed that seeds "2.1" — rbook-seed/README.md, docs/README.md, docs/getting-started.md.
    const stamps = SEED_MD.flatMap((rel) => stampsIn(rel, 'Schema Version'));
    expect(stamps.length).toBeGreaterThanOrEqual(3);

    const wrong = stamps
      .filter((st) => !st.value.startsWith(expected))
      .map((st) => `${st.rel} stamps "Schema Version: ${st.value}" but the seed seeds ${expected}`);
    expect(wrong).toEqual([]);
  });

  it('the **Tool Count** stamp equals the number of tools actually registered', () => {
    // GREEN AT BASELINE (15 = 15), and it ships as a REGRESSION FLOOR: it fires the moment a
    // sixteenth tool registers and nobody updates the seed's front page. That is the only thing
    // that makes it a gate rather than a decoration — and it is the one stamp in the set that was
    // already a working claim, which #539's coordinate range omitted.
    const stamps = SEED_MD.flatMap((rel) => stampsIn(rel, 'Tool Count'));
    expect(stamps.length).toBeGreaterThanOrEqual(1);

    const wrong = stamps
      .filter((st) => !st.value.startsWith(String(RBOOK_TOOL_DEFINITIONS.length)))
      .map(
        (st) =>
          `${st.rel} stamps "Tool Count: ${st.value}" but ${RBOOK_TOOL_DEFINITIONS.length} tools ` +
          `are registered`
      );
    expect(wrong).toEqual([]);
  });

  it('this arm is not gated on the public mirror, and the seed is not a PRIVATE_TARGET', () => {
    // The trap, asserted rather than intended. rbook-seed/** ships to the public repo, so gating
    // these checks on `inPublicMirror` would leave the public copies unchecked.
    expect(PRIVATE_TARGETS).toHaveLength(3);
    expect(PRIVATE_TARGETS.some((t) => t.startsWith('rbook-seed'))).toBe(false);
    for (const rel of SEED_MD) expect(fs.existsSync(r(rel))).toBe(true);
  });
});

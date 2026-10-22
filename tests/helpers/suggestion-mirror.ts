// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Provenance instrument for authored error `suggestion:` strings — an AST source transform
// ABOUTME: into a gitignored CommonJS mirror, so a fired suggestion names the src/ site that authored it.

/**
 * WHY A SOURCE TRANSFORM AND NOT A STRUCTURED FIELD (s89-m08, FORK 2).
 *
 * An oracle that drives a router and reads back `error.suggestion` sees a STRING. To assert
 * anything about the SITE that authored it, the site has to be recoverable from the string —
 * and it is not. Regex-attributing observed suggestions back to AST string literals was measured
 * at plan time and could not attribute 25 of 53 distinct observed suggestions, because every
 * interpolated template (`errors.ts:319/333/466`) yields an unmatchable anchored pattern.
 *
 * Making `suggestion` a structured `{text, remedy}` object would be a BREAKING change to
 * `RbookToolError` on the MCP wire, across 181 sites, in the sprint whose own review dinged 2.8.0
 * for shipping an undisclosed wire break. An additive `remedy?:` field beside `suggestion` avoids
 * the break but still costs 181 authoring edits AND creates a second source of truth that can
 * silently disagree with the string — the precise defect class Arc F is named for.
 *
 * So the harness carries the provenance instead of the source: every `suggestion:` initializer `E`
 * is rewritten to `(globalThis.__RBOOK_SUGGESTION_SITE__("<relpath>:<line>", E))`, which records the
 * site and returns `E` unchanged. ZERO `src/` edits. The shipped bytes are what ships.
 *
 * WHY `.js` AND NOT `.ts` (proven at plan time). `preset: 'ts-jest'` transforms `^.+\.tsx?$` and
 * tsconfig declares `rootDir: "./src"`, so importing a mirrored `.ts` from outside `src/` invites a
 * ts-jest/rootDir interaction with no clean fix. Emitting CommonJS `.js` via `ts.transpileModule`
 * sidesteps the transform entirely, and `collectCoverageFrom: ['src/**\/*.ts']` never matches it.
 *
 * MIRROR INTEGRITY IS LOAD-BEARING. A harness that is not testing the shipped code must fail
 * loudly, so `buildSuggestionMirror()` proves — every run, never cached — that removing exactly the
 * spans it recorded restores every `src/` file byte-for-byte by SHA-256. If that check ever fails,
 * the mirror is testing something other than the shipped source and the suite is meaningless.
 *
 * THE MIRROR IS AN INSTRUMENT, NOT A BUILD. It is written under `node_modules/.cache/`, which is
 * gitignored, outside jest `roots: ['<rootDir>/tests']` and outside `collectCoverageFrom` — and is
 * not part of any mirror exclusion. See MIRROR_ROOT for why that placement remains load-bearing.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
/**
 * The mirror lives under `node_modules/.cache/`, NOT under `<repo>/tmp/`.
 *
 * MEASURED REASON, and it is not a style preference. `tmp` is a PRIVATE_PATHS leak guard. The old
 * classifier treated every exclusion as an identity marker, so writing the mirror into
 * `<repo>/tmp/` made 13 later suites throw instead of skip in a staged public mirror. Identity now
 * uses excluded paths tracked in the checkout's HEAD/index, but scratch placement still avoids
 * every exclusion: that keeps generated data out of the mirror surface and survives a future
 * tracking change.
 *
 * `node_modules/.cache/` has every property `tmp/` was chosen for — gitignored, outside jest
 * `roots: ['<rootDir>/tests']`, outside `collectCoverageFrom: ['src/**\/*.ts']` — and additionally
 * resolves `<repo>/node_modules` from inside itself, while being no part of any mirror exclusion.
 */
export const MIRROR_ROOT = path.join(
  REPO_ROOT,
  'node_modules',
  '.cache',
  // s98-m08: one mirror per process. Two full suites at once in this checkout rebuilt one shared
  // folder, and one suite's rmSync met the other's writes (ENOTEMPTY), failing the oracle in both.
  `rbook-suggestion-mirror-${process.pid}`
);

/** Removes the mirrors of processes that have ended; a live suite's mirror is left alone. */
function removeEndedMirrors(): void {
  const cache = path.dirname(MIRROR_ROOT);
  if (!fs.existsSync(cache)) return;
  for (const name of fs.readdirSync(cache)) {
    const pid = Number(/^rbook-suggestion-mirror-(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        fs.rmSync(path.join(cache, name), { recursive: true, force: true });
    }
  }
}

/** The mirror's own folder, removed once its suite is done with it. */
export function removeSuggestionMirror(): void {
  fs.rmSync(MIRROR_ROOT, { recursive: true, force: true });
}

/** The global the transform calls. Declared here so both the sink and the wrapper agree on it. */
export const SINK_NAME = '__RBOOK_SUGGESTION_SITE__';

export interface SuggestionSink {
  /** `<relpath>:<line>` for every site that fired at least once, in first-fire order. */
  readonly fired: ReadonlySet<string>;
  /** Fire counts per site — a site can author more than one string, and can fire many times. */
  readonly counts: ReadonlyMap<string, number>;
  /** Distinct string VALUES observed per site (a conditional site authors more than one). */
  readonly values: ReadonlyMap<string, Set<string>>;
  reset(): void;
}

interface SinkState {
  fired: Set<string>;
  counts: Map<string, number>;
  values: Map<string, Set<string>>;
}

/**
 * Install the recording sink on `globalThis`.
 *
 * The wrapper is evaluated when the error object literal is CONSTRUCTED, not when the module is
 * loaded, so the sink must be live for the duration of the driven call — not merely at require
 * time. Installing it is idempotent; the same state object is returned on every call so a suite
 * can install once and read the ledger at the end.
 */
export function installSuggestionSink(): SuggestionSink {
  const holder = globalThis as unknown as Record<string, unknown>;
  const existing = holder.__RBOOK_SUGGESTION_STATE__ as SinkState | undefined;
  const state: SinkState = existing ?? { fired: new Set(), counts: new Map(), values: new Map() };
  holder.__RBOOK_SUGGESTION_STATE__ = state;
  holder[SINK_NAME] = <T>(site: string, value: T): T => {
    state.fired.add(site);
    state.counts.set(site, (state.counts.get(site) ?? 0) + 1);
    if (typeof value === 'string') {
      const seen = state.values.get(site) ?? new Set<string>();
      seen.add(value);
      state.values.set(site, seen);
    }
    return value;
  };
  return {
    fired: state.fired,
    counts: state.counts,
    values: state.values,
    reset(): void {
      state.fired.clear();
      state.counts.clear();
      state.values.clear();
    },
  };
}

export interface MirrorSite {
  /** `<relpath>:<line>` — the identity the sink records and the ledger counts. */
  readonly site: string;
  /** Repo-relative source path, POSIX-separated. */
  readonly file: string;
  /** 1-based line of the initializer in `src/`. */
  readonly line: number;
  /** The initializer's source text, for the authored/forwarding split and the extractor arm. */
  readonly initializer: string;
  /** `suggestion: x.suggestion` — forwards an existing claim, makes no new one. */
  readonly forwarding: boolean;
}

export interface SuggestionMirrorResult {
  readonly root: string;
  /** Every `suggestion:` PropertyAssignment found, wrapped, in source order. */
  readonly sites: readonly MirrorSite[];
  /** Wrapped initializers === sites.length. Ratified denominator input. */
  readonly wraps: number;
  /** Files whose bytes the transform changed. */
  readonly changedFiles: readonly string[];
  /** Every `src/` .ts file transpiled into the mirror (changed or not). */
  readonly transpiledFiles: number;
  /** Per-file proof that removing the recorded spans restores `src/` byte-for-byte. */
  readonly integrityChecked: number;
}

interface Insertion {
  start: number;
  end: number;
  site: string;
  line: number;
  initializer: string;
  forwarding: boolean;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Collect every `suggestion:` PropertyAssignment initializer range in one file. */
function collectInsertions(absolute: string, relative: string, content: string): Insertion[] {
  const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
  const found: Insertion[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === 'suggestion'
    ) {
      const init = node.initializer;
      const start = init.getStart(source);
      const line = source.getLineAndCharacterOfPosition(start).line + 1;
      found.push({
        start,
        end: init.getEnd(),
        site: `${relative}:${line}`,
        line,
        initializer: init.getText(source),
        forwarding: ts.isPropertyAccessExpression(init) && init.name.text === 'suggestion',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  found.sort((a, b) => a.start - b.start);
  for (let i = 1; i < found.length; i += 1) {
    // A nested `suggestion:` inside another `suggestion:` initializer would make the flat span
    // rewrite below unsound AND make the inverse check meaningless. Refuse rather than guess.
    if (found[i].start < found[i - 1].end) {
      throw new Error(
        `Nested suggestion initializers in ${relative} at lines ${found[i - 1].line} and ${found[i].line}; ` +
          'the flat span transform cannot represent this and the integrity inverse would be unsound.'
      );
    }
  }
  return found;
}

interface RewrittenFile {
  text: string;
  /** Spans of inserted bytes, in OUTPUT coordinates, ascending. */
  inserted: Array<{ start: number; end: number }>;
}

function rewrite(content: string, insertions: readonly Insertion[]): RewrittenFile {
  let out = '';
  let cursor = 0;
  const inserted: Array<{ start: number; end: number }> = [];
  for (const insertion of insertions) {
    out += content.slice(cursor, insertion.start);
    const prefix = `(globalThis.${SINK_NAME}(${JSON.stringify(insertion.site)}, `;
    const prefixStart = out.length;
    out += prefix;
    inserted.push({ start: prefixStart, end: out.length });
    out += content.slice(insertion.start, insertion.end);
    const suffixStart = out.length;
    out += '))';
    inserted.push({ start: suffixStart, end: out.length });
    cursor = insertion.end;
  }
  out += content.slice(cursor);
  return { text: out, inserted };
}

/** Remove exactly the recorded spans. The result must be the original `src/` bytes. */
function stripInserted(
  text: string,
  inserted: ReadonlyArray<{ start: number; end: number }>
): string {
  let out = text;
  for (let i = inserted.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, inserted[i].start) + out.slice(inserted[i].end);
  }
  return out;
}

/**
 * Regenerate the mirror from `src/` and prove it is byte-faithful. NEVER cached: a stale mirror is
 * a harness that silently stops testing the shipped code.
 */
export function buildSuggestionMirror(): SuggestionMirrorResult {
  removeEndedMirrors();
  fs.rmSync(MIRROR_ROOT, { recursive: true, force: true });
  fs.mkdirSync(MIRROR_ROOT, { recursive: true });
  // Node resolves `<mirror>/**` as CommonJS regardless of the repo's own package type.
  fs.writeFileSync(path.join(MIRROR_ROOT, 'package.json'), '{"type":"commonjs"}\n');
  // s93-m12: the shipped code finds its seed beside the package root (resolveSeedPath), and so must
  // the mirror, or every init past the seed lookup refuses with the missing-seed FAULT and its later
  // refusals (a re-init naming another project's id) can never be driven. A link, never a copy: the
  // seed is read, and init writes only into the case's own temp project.
  fs.symlinkSync(path.join(REPO_ROOT, 'rbook-seed'), path.join(MIRROR_ROOT, 'rbook-seed'), 'dir');

  const sites: MirrorSite[] = [];
  const changedFiles: string[] = [];
  let transpiledFiles = 0;
  let integrityChecked = 0;

  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const content = fs.readFileSync(absolute, 'utf8');
    const insertions = content.includes('suggestion')
      ? collectInsertions(absolute, relative, content)
      : [];

    const { text, inserted } = rewrite(content, insertions);
    if (insertions.length > 0) {
      changedFiles.push(relative);
      // THE INVERSE. Removing exactly what was inserted must restore the shipped bytes.
      const restored = stripInserted(text, inserted);
      if (sha256(restored) !== sha256(content)) {
        throw new Error(
          `Mirror integrity FAILED for ${relative}: removing the recorded wrapper spans did not restore ` +
            `the src/ bytes (sha256 ${sha256(restored)} != ${sha256(content)}). The mirror is not the shipped code.`
        );
      }
      integrityChecked += 1;
      for (const insertion of insertions) {
        sites.push({
          site: insertion.site,
          file: relative,
          line: insertion.line,
          initializer: insertion.initializer,
          forwarding: insertion.forwarding,
        });
      }
    }

    const emitted = ts.transpileModule(text, {
      fileName: absolute,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        allowJs: false,
      },
    });
    const destination = path.join(
      MIRROR_ROOT,
      path.relative(SRC_ROOT, absolute).replace(/\.ts$/, '.js')
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, emitted.outputText);
    transpiledFiles += 1;
  }

  return {
    root: MIRROR_ROOT,
    sites,
    wraps: sites.length,
    changedFiles,
    transpiledFiles,
    integrityChecked,
  };
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Derive the repository's environment reads with the shared five-shape census.
// ABOUTME: Keep shipped documentation and Codex forwarding checked against the same source rules.

import * as fs from 'fs';
import * as path from 'path';

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
 *   (v)   getSetting, or settingIsOff (s100-m02: an off switch, which reads through getSetting),
 *         with a literal or module-level constant; both accepted prefixes map to the current
 *         documented spelling. Compatibility tests separately verify precedence.
 *
 * FALSE-NEGATIVE PROFILE: a name assembled at runtime (`process.env['RBOOK_' + suffix]`), a name
 * reaching the process through a shell wrapper rather than a code read, and a constant defined
 * in one module and consumed in another are all invisible. None exists in the tree today.
 */
export function deriveEnvReads(root: string): Set<string> {
  const out = new Set<string>();
  const files = walkFiles(root, '.ts');
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
      /\b(?:getSetting|settingIsOff)\(\s*(?:['"]((?:Reasonbook|RBOOK)_[A-Z0-9_]+)['"]|([A-Za-z_][A-Za-z0-9_]*))/g
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

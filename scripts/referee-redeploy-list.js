#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The referee's redeploy list (s100 plan, settled item 15): the files reachable by relative imports from
// ABOUTME: src/referee/*.ts that differ from a release tag, which the dashboard redeploys when it pins the next release.
// Usage: node scripts/referee-redeploy-list.js <repo> [<tag>]: prints the closure, and with a tag only the
// closure's files that differ between that tag and the working tree, untracked ones included.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const repo = path.resolve(process.argv[2]);
const base = process.argv[3];
const seen = new Set();
const queue = fs
  .readdirSync(path.join(repo, 'src/referee'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(repo, 'src/referee', f));
const resolve = (from, spec) => {
  const target = path.resolve(path.dirname(from), spec);
  for (const candidate of [target + '.ts', path.join(target, 'index.ts'), target])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return null;
};
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  const re =
    /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const spec = m[1] || m[2] || m[3];
    const hit = resolve(file, spec);
    if (hit && hit.endsWith('.ts')) queue.push(hit);
  }
}
const closure = [...seen].map((f) => path.relative(repo, f)).sort();
if (!base) {
  console.log(closure.join('\n'));
  console.log(`# ${closure.length} files`);
  process.exit(0);
}
const changed = new Set(
  execFileSync('git', ['-C', repo, 'diff', '--name-only', base, '--'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
);
const untracked = execFileSync(
  'git',
  ['-C', repo, 'ls-files', '--others', '--exclude-standard', 'src/'],
  { encoding: 'utf8' }
)
  .split('\n')
  .filter(Boolean);
for (const f of untracked) changed.add(f);
const hits = closure.filter((f) => changed.has(f));
console.log(`closure: ${closure.length} files; changed since ${base}: ${hits.length}`);
console.log(hits.join('\n'));

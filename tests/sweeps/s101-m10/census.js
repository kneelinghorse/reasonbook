// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Enumerate registration and name-derived identity candidates before the m10 repair.
// ABOUTME: Scan every tracked UTF-8 file; classify shipped candidates separately from witnesses.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { TextDecoder } = require('util');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const classes = { registration: [], defaultName: [], senderAddressMatch: [] };
for (const file of files) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    continue;
  }
  if (source.includes('\0')) continue;
  source.split('\n').forEach((line, index) => {
    const item = { file, line: index + 1, text: line.trim().slice(0, 240) };
    if (/\bregisterProject\s*\(|\/api\/(?:projects|sync)\/register/.test(line))
      classes.registration.push(item);
    if (/projectName\s*=\s*''|projectName\s*\|\|\s*restoredName/.test(line))
      classes.defaultName.push(item);
    if (/\.find\(.*normalizeAddress\(.*\.address\).*===.*normalizedLocal/.test(line))
      classes.senderAddressMatch.push(item);
  });
}
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      predicate:
        'git ls-files -z; every UTF-8 file across all extensions; matching lines counted once per class',
      counts: Object.fromEntries(
        Object.entries(classes).map(([key, rows]) => [
          key,
          {
            wholeTree: rows.length,
            production: rows.filter(
              (row) => row.file.startsWith('src/') || row.file.startsWith('rbook-seed/')
            ).length,
          },
        ])
      ),
      // Keep the public receipt small: enumerate shipped candidates, aggregate history and fixtures.
      classes: Object.fromEntries(
        Object.entries(classes).map(([key, rows]) => [
          key,
          rows.filter((row) => row.file.startsWith('src/') || row.file.startsWith('rbook-seed/')),
        ])
      ),
      retainedScopes: Object.fromEntries(
        Object.entries(classes).map(([key, rows]) => {
          const scopes = {};
          for (const row of rows) {
            if (row.file.startsWith('src/') || row.file.startsWith('rbook-seed/')) continue;
            const scope = row.file.split('/')[0];
            scopes[scope] = (scopes[scope] || 0) + 1;
          }
          return [key, scopes];
        })
      ),
    },
    null,
    2
  ) + '\n'
);

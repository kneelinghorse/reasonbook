// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reproduce the first-hour defect candidate census across every tracked UTF-8 file.
// ABOUTME: Lexical candidates require semantic classification; historical text is retained.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { TextDecoder } = require('util');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const classes = { renameResidue: [], nameFallback: [], unsharedGenericError: [] };
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
    if (/Context \+ Mission|show by ID|context search/.test(line)) classes.renameResidue.push(item);
    if (
      /(name|Name)\s*(\?\?|\|\|)\s*[^;\n]*(\bid\b|\bprojectId\b|project_id)|\bplain\(id\)|project_name.*project_id|name:\s*null/.test(
        line
      )
    )
      classes.nameFallback.push(item);
    if (
      [...line.matchAll(/throw new Error\((['"])([^\r\n]*?)\1\)/g)].some((m) =>
        m[2].includes('shared record')
      )
    )
      classes.unsharedGenericError.push(item);
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

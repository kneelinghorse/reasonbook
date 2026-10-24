// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Find child-exit checks that may wait again after signal termination.
// ABOUTME: Count candidate lines across every tracked UTF-8 file, not only test code.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { TextDecoder } = require('util');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const hits = [];
let inspected = 0;
for (const file of files) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  inspected++;
  text.split('\n').forEach((line, index) => {
    if (/\bexitCode\s*!==?\s*null/.test(line))
      hits.push({ file, line: index + 1, text: line.trim() });
  });
}
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      predicate:
        'All git ls-files entries, every extension, valid UTF-8 without NUL; one line per exitCode unequal-to-null comparison',
      inspected,
      count: hits.length,
      hits,
    },
    null,
    2
  ) + '\n'
);

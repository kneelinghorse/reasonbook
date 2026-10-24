// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Count public naming and documentation candidates before the front-door edit.
// ABOUTME: Traverse every tracked UTF-8 file; report counts separately from chosen repair sites.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { TextDecoder } = require('util');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const patterns = {
  projectNames: /stage1|oods|parts.?town|rbook:\/\/derek\/cmos-dashboard/i,
  stage1: /stage1/i,
  oods: /oods/i,
  partsTown: /parts.?town/i,
  toolExample: /rbook:\/\/derek\/cmos-dashboard/,
  docClaims: /until reasonbook\.ai runs 4\.2\.1|RBOOK_CHECKPOINT_SYNC|recover|delet/i,
};
const results = Object.fromEntries(
  Object.keys(patterns).map((name) => [name, { count: 0, scopes: {}, repairSurface: [] }])
);
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
    for (const [name, predicate] of Object.entries(patterns)) {
      if (!predicate.test(line)) continue;
      const result = results[name];
      result.count++;
      const scope = file.split('/')[0];
      result.scopes[scope] = (result.scopes[scope] || 0) + 1;
      const repairSurface =
        name === 'docClaims'
          ? ['README.md', 'docs/privacy.md', 'docs/trust.md', 'docs/getting-started.md'].includes(
              file
            )
          : /^(src|tests)\//.test(file);
      if (repairSurface) result.repairSurface.push({ file, line: index + 1 });
    }
  });
}
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      predicate:
        'git ls-files -z; all extensions; valid UTF-8 without NUL; each regex counts one matching physical line, not occurrences',
      patterns: Object.fromEntries(
        Object.entries(patterns).map(([name, regex]) => [name, String(regex)])
      ),
      inspected,
      results,
    },
    null,
    2
  ) + '\n'
);

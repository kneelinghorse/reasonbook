// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Captures upload auth regression predicates over all tracked UTF-8 files.
// ABOUTME: Reports lexical key-time comparisons and direct resolver credential overrides.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const { createHash } = require('crypto');
const revision = process.argv[2];
const git = (args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const files = git(revision ? ['ls-tree', '-r', '--name-only', '-z', revision] : ['ls-files', '-z'])
  .toString()
  .split('\0')
  .filter(Boolean);
const matches = { lexicalIssuedAt: [], resolverApiKeyOverride: [] };
const decoder = new TextDecoder('utf-8', { fatal: true });
const row = (file, line, text) => ({
  file,
  line,
  text: text.length > 500 ? text.slice(0, 300) : text.trim(),
  ...(text.length > 500
    ? {
        textLength: text.length,
        textSha256: createHash('sha256').update(text.trim()).digest('hex'),
      }
    : {}),
});
for (const file of files) {
  let source;
  try {
    source = decoder.decode(
      revision ? git(['show', `${revision}:${file}`]) : fs.readFileSync(file)
    );
  } catch {
    continue;
  }
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    if (/issuedAt.*(?:localeCompare| > | < )/.test(text))
      matches.lexicalIssuedAt.push(row(file, index + 1, text));
    if (
      /\b(?:fromEnvForProject|fromEnvForUser)\s*\(/.test(text) &&
      /\bapiKey\s*:/.test(lines.slice(index, index + 4).join(' '))
    )
      matches.resolverApiKeyOverride.push(row(file, index + 1, text));
  });
}
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      sha: git(['rev-parse', revision || 'HEAD'])
        .toString()
        .trim(),
      predicate: {
        lexicalIssuedAt: 'Physical lines matching /issuedAt.*(?:localeCompare| > | < )/',
        resolverApiKeyOverride:
          'Resolver call pattern plus apiKey property in that line and next three lines',
        universe: 'Every git ls-files path whose bytes decode as UTF-8, across all extensions',
        longLineEvidence:
          'Matched physical lines above 500 characters retain a 300-character prefix, full character count and SHA-256; replay against the recorded SHA for full evidence.',
        falseNegativeProfile:
          'Text only: aliases, dynamic calls, multiline time comparisons, longer argument lists, untracked and generated files are outside the predicate; matches may be comments or tests, not defects.',
      },
      counts: Object.fromEntries(
        Object.entries(matches).map(([key, rows]) => [
          key,
          {
            wholeTree: rows.length,
            src: rows.filter((row) => row.file.startsWith('src/')).length,
          },
        ])
      ),
      changed: [
        'src/tools/rbook/dashboard-upload-auth.ts lexical comparison and resolver override',
      ],
      deliberatelyUnchanged: [
        'src/auth/auth-state.ts existing ISO-key lexical pick',
        'src/tools/rbook/dashboard-client.ts existing ISO-key lexical pick',
        'All test-only explicit apiKey overrides exercise the existing public contract',
      ],
      matches,
    },
    null,
    2
  )
);

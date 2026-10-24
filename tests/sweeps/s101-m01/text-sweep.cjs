// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Replays the upload text predicates over every tracked UTF-8 file, across extensions.
// ABOUTME: A supplied Git revision reproduces the recorded pre-edit universe without a checkout.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const repo = path.resolve(process.argv[2] || '.');
const revision = process.argv[3];
const evidence = require('./text-before.json');
const git = (args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
const files = git(revision ? ['ls-tree', '-r', '--name-only', '-z', revision] : ['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const predicates = Object.entries(evidence)
  .filter(([, row]) => row.predicate)
  .map(([name, row]) => [name, new RegExp(row.predicate)]);
const matches = Object.fromEntries(predicates.map(([name]) => [name, []]));
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const file of files) {
  let source;
  const bytes = revision
    ? git(['show', `${revision}:${file}`])
    : fs.readFileSync(path.join(repo, file));
  try {
    source = decoder.decode(bytes);
  } catch {
    continue; // Non-UTF-8 files are outside the recorded text universe.
  }
  source.split(/\r?\n/).forEach((text, index) => {
    for (const [name, pattern] of predicates)
      if (pattern.test(text)) matches[name].push({ file, line: index + 1, text: text.trim() });
  });
}
for (const [name, rows] of Object.entries(matches))
  console.log(
    `${name}: ${rows.length} whole-tree physical lines; ${rows.filter((row) => row.file.startsWith('src/')).length} src lines`
  );
if (process.argv.includes('--detail')) console.log(JSON.stringify(matches, null, 2));

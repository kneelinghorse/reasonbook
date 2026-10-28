#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Refuses oversized Git blobs reachable only from an outgoing release candidate.
// ABOUTME: Checks complete history against an explicitly supplied fetched publication boundary.
'use strict';

const { execFileSync } = require('node:child_process');
const thresholdBytes = 104857600;
function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--boundary' || args[2] !== '--candidate') {
    throw new Error('Usage: check-outgoing-blobs.js --boundary <fetched-ref> --candidate <commit>');
  }
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error(
      'shallow history cannot prove outgoing blob sizes; fetch complete history first'
    );
  }
  const boundary = git(['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`]);
  const candidate = git(['rev-parse', '--verify', '--end-of-options', `${args[3]}^{commit}`]);
  const objectText = git(['rev-list', '--objects', '--no-object-names', candidate, `^${boundary}`]);
  const objects = objectText ? [...new Set(objectText.split('\n'))] : [];
  if (objects.some((oid) => !/^[a-f0-9]{40,64}$/.test(oid)))
    throw new Error('Malformed object census');
  const rows = objects.length
    ? git(
        ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        `${objects.join('\n')}\n`
      ).split('\n')
    : [];
  if (rows.length !== objects.length) throw new Error('Incomplete object census');
  const offenders = [];
  let blobCount = 0;
  rows.forEach((row, index) => {
    const match = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/.exec(row);
    if (!match || match[1] !== objects[index])
      throw new Error('Missing or malformed object information');
    const bytes = Number(match[3]);
    if (!Number.isSafeInteger(bytes)) throw new Error('Object size is not a safe integer');
    if (match[2] === 'blob') {
      blobCount++;
      if (bytes > thresholdBytes) offenders.push({ oid: match[1], bytes });
    }
  });
  console.log(
    JSON.stringify(
      {
        success: offenders.length === 0,
        candidate,
        boundary,
        predicate:
          'Distinct blobs reachable from candidate and not boundary, including deleted historical files; reject bytes > thresholdBytes',
        thresholdBytes,
        blobCount,
        offenders,
      },
      null,
      2
    )
  );
  if (offenders.length) process.exitCode = 1;
} catch (error) {
  console.error(`Cannot inspect outgoing blobs: ${error.message}`);
  process.exitCode = 1;
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies sealed retrieval evidence, source identity and structural public-mirror skips.
// ABOUTME: Literal exclusion parsing and pre/post hashes make missing private evidence fail closed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONTRACT = 'tests/fixtures/retrieval-quality-contract.json';
const FIXTURE = 'rbook/research/2026-10-s94-m06';
const EVIDENCE = [
  'acceptance-fixture/corpus.json',
  'acceptance-fixture/manifest.json',
  'frozen-labels/labels.json',
  'frozen-labels/manifest.json',
  'paraphrase-fixture/paraphrases.json',
  'paraphrase-fixture/manifest.json',
  'no-relevance-controls.json',
  'no-relevance-manifest.json',
  'labels-v6-review/manifest.json',
  'labels-v6-review/labels.json',
];
const EVALUATORS = [
  'measure-retrieval-quality.js',
  'retrieval-quality-fixture.js',
  'retrieval-quality-metrics.js',
  'retrieval-quality-diagnostics.js',
];
const HASH = /^[0-9a-f]{64}$/;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
function same(actual, expected, name) {
  if (canonical(actual) !== canonical(expected)) throw new Error(`${name} changed`);
}
function localPath(root, relative) {
  if (
    typeof relative !== 'string' ||
    !/^[A-Za-z0-9._/-]+$/.test(relative) ||
    path.posix.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('invalid contract path');
  return path.join(root, relative);
}
function hashed(file, expected) {
  if (!HASH.test(expected ?? '') || !fs.existsSync(file) || sha(fs.readFileSync(file)) !== expected)
    throw new Error(`sealed hash mismatch or missing evidence: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function originalSource(bytes, rename, relative) {
  let original = bytes.toString('utf8');
  // Only the recorded finite rename is reversible; never normalize algorithm changes.
  for (const { from, to, count } of [...(rename?.replacements ?? [])].reverse()) {
    const pieces = original.split(to);
    if (pieces.length - 1 !== count)
      throw new Error(`source rename occurrence mismatch: ${relative}`);
    original = pieces.join(from);
  }
  return original;
}
function hashMap(root, expected, renames = {}) {
  if (!expected || !Object.keys(expected).length) throw new Error('empty sealed hash inventory');
  const currentHashes = {};
  for (const [relative, hash] of Object.entries(expected)) {
    const rename = renames[relative];
    const current = rename?.path ?? relative;
    const file = localPath(root, current);
    if (!HASH.test(hash) || !fs.existsSync(file))
      throw new Error(`sealed hash mismatch or missing source: ${relative}`);
    const bytes = fs.readFileSync(file);
    // Only the finite recorded rename may differ. Reconstruct the historical bytes; do not
    // replace an old seal with a hash of today's source or normalize arbitrary whitespace.
    if (sha(originalSource(bytes, rename, relative)) !== hash)
      throw new Error(`sealed hash mismatch or missing source: ${relative}`);
    currentHashes[current] = sha(bytes);
  }
  return currentHashes;
}
/** Strict literal-array subset of the mirror authority; unsupported shell syntax fails closed. */
function privateExclusions(root) {
  const source = fs.readFileSync(path.join(root, 'scripts/mirror-to-public.sh'), 'utf8');
  const exclusions = ['PRIVATE_PATHS', 'DOCS_EXCLUDES'].flatMap((name) => {
    const matches = [...source.matchAll(new RegExp(`^${name}=\\(([^)]*)\\)`, 'gm'))];
    if (matches.length !== 1) throw new Error(`ambiguous mirror exclusion array ${name}`);
    const trailing = source.slice(matches[0].index + matches[0][0].length).split('\n')[0];
    if (!/^[ \t]*(?:#.*)?$/.test(trailing))
      throw new Error('ambiguous mirror exclusions after array');
    const values = matches[0][1].replace(/#.*$/gm, '').trim().split(/\s+/);
    if (!values.length || new Set(values).size !== values.length)
      throw new Error('invalid mirror exclusions');
    for (const value of values) localPath(root, value);
    return values;
  });
  if (new Set(exclusions).size !== exclusions.length)
    throw new Error('overlapping mirror exclusions');
  return exclusions;
}
function isPublicMirror(root) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== fs.realpathSync(root))
    throw new Error('benchmark root differs from Git root');
  const excludes = privateExclusions(root);
  const tracked =
    git(['ls-files', '-z', '--cached', '--', ...excludes]) +
    git(['ls-tree', '-rz', '--name-only', 'HEAD', '--', ...excludes]);
  return tracked.split('\0').filter(Boolean).length === 0;
}
function readContract(root) {
  const contract = JSON.parse(fs.readFileSync(path.join(root, CONTRACT), 'utf8'));
  same(
    Object.keys(contract).sort(),
    [
      'schemaVersion',
      'sourceRenames',
      'mission',
      'fixtureRoot',
      'baseline',
      'evidenceHashes',
      'parserHashes',
      'parserReview',
      'currentParserReview',
      'evaluatorHashes',
      'baselineConfig',
      'candidateConfig',
      'counts',
      'requiredSourceFiles',
    ].sort(),
    'contract fields'
  );
  if (
    contract.schemaVersion !== 3 ||
    contract.mission !== 's94-m06' ||
    contract.fixtureRoot !== FIXTURE
  )
    throw new Error('unrecognized retrieval contract');
  same(Object.keys(contract.evidenceHashes).sort(), [...EVIDENCE].sort(), 'evidence inventory');
  same(
    Object.keys(contract.evaluatorHashes).sort(),
    EVALUATORS.map((name) => `scripts/${name}`).sort(),
    'evaluator inventory'
  );
  if (
    !HASH.test(contract.baseline?.sha256 ?? '') ||
    !/^[a-f0-9]{40}$/.test(contract.baseline?.sourceCommit ?? '')
  )
    throw new Error('unsealed retrieval baseline');
  if (contract.baseline.file !== 'frozen-baseline.json')
    throw new Error('unrecognized baseline filename');
  if (
    contract.parserReview?.file !== 'labels-v5-review/manifest.json' ||
    !HASH.test(contract.parserReview.sha256 ?? '') ||
    !HASH.test(contract.parserReview.generatorSha256 ?? '')
  )
    throw new Error('unsealed parser review');
  same(
    Object.keys(contract.currentParserReview ?? {}).sort(),
    ['file', 'sha256'],
    'current parser review fields'
  );
  if (
    contract.currentParserReview.file !== 'labels-v7-review/manifest.json' ||
    !HASH.test(contract.currentParserReview.sha256 ?? '')
  )
    throw new Error('unsealed current parser review');
  const sealedSources = {
    ...contract.parserHashes,
    ...contract.evaluatorHashes,
    'scripts/build-retrieval-labels.js': contract.parserReview.generatorSha256,
  };
  const renames = contract.sourceRenames;
  if (!renames || typeof renames !== 'object' || Array.isArray(renames))
    throw new Error('invalid source rename inventory');
  const currentPaths = new Set();
  for (const name of Object.keys(renames))
    if (!Object.hasOwn(sealedSources, name)) throw new Error(`unknown source rename: ${name}`);
  for (const name of Object.keys(sealedSources)) {
    localPath(root, name);
    const rename = renames[name];
    const current = rename?.path ?? name;
    localPath(root, current);
    if (currentPaths.has(current)) throw new Error(`duplicate source rename path: ${current}`);
    currentPaths.add(current);
    if (!rename) continue;
    same(Object.keys(rename).sort(), ['path', 'replacements'], 'source rename fields');
    if (!Array.isArray(rename.replacements)) throw new Error('invalid source rename replacements');
    for (const replacement of rename.replacements) {
      same(
        Object.keys(replacement).sort(),
        ['count', 'from', 'to'],
        'source rename replacement fields'
      );
      if (
        typeof replacement.from !== 'string' ||
        !replacement.from ||
        typeof replacement.to !== 'string' ||
        !replacement.to ||
        replacement.from === replacement.to ||
        !Number.isSafeInteger(replacement.count) ||
        replacement.count < 1
      )
        throw new Error('invalid source rename replacement');
    }
  }
  for (const name of ['primary', 'mission', 'mixed'])
    if (!Number.isSafeInteger(contract.counts[name]) || contract.counts[name] < 1)
      throw new Error(`empty frozen ${name} population`);
  if (!Array.isArray(contract.requiredSourceFiles) || !contract.requiredSourceFiles.length)
    throw new Error('missing required source inventory');
  for (const name of contract.requiredSourceFiles)
    if (!name.startsWith('src/') || !name.endsWith('.ts'))
      throw new Error('required source outside src');
  same(Object.keys(contract.counts).sort(), ['mission', 'mixed', 'primary'], 'count fields');
  if (new Set(contract.requiredSourceFiles).size !== contract.requiredSourceFiles.length)
    throw new Error('duplicate source inventory');
  if (
    contract.baselineConfig?.mode !== 'baseline' ||
    contract.candidateConfig?.mode !== 'candidate' ||
    contract.baselineConfig.keywordOnly !== true ||
    contract.candidateConfig.keywordOnly !== true
  )
    throw new Error('invalid benchmark mode');
  return contract;
}
function validateReport(report, contract, mode) {
  same(report.config, contract[`${mode}Config`], `${mode} configuration`);
  if (report.skipped !== 0 || !Array.isArray(report.units))
    throw new Error('incomplete benchmark report');
  for (const name of ['primary', 'mission', 'mixed']) {
    const rows = report.units.filter((unit) => unit.population === name);
    if (rows.length !== contract.counts[name]) throw new Error(`${name} denominator changed`);
  }
  for (const unit of report.units) {
    const cap = ['mission', 'first-prompt', 'first-prompt-internal'].includes(unit.population)
      ? 5
      : 10;
    if (
      !Array.isArray(unit.retrievedIds) ||
      unit.retrievedIds.length > cap ||
      [...unit.positiveIds, ...unit.retrievedIds].some((id) => !/^([dl]):[1-9]\d*$/.test(id))
    )
      throw new Error('invalid retrieved population or output cap');
  }
}
function snapshotSources(root) {
  const hashes = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        hashes[path.relative(root, file)] = sha(fs.readFileSync(file));
    }
  };
  visit(path.join(root, 'src'));
  return hashes;
}
function verifyCandidateSource(root, report, contract, before) {
  if (!report.sourceHashes || !Object.keys(report.sourceHashes).length)
    throw new Error('empty candidate source hashes');
  for (const name of contract.requiredSourceFiles)
    if (!Object.hasOwn(report.sourceHashes, name))
      throw new Error(`missing candidate source: ${name}`);
  for (const [name, hash] of Object.entries(report.sourceHashes)) {
    if (
      !name.startsWith('src/') ||
      before[name] !== hash ||
      sha(fs.readFileSync(localPath(root, name))) !== hash
    )
      throw new Error(`candidate source changed: ${name}`);
  }
  same(
    report.evaluatorHashes,
    Object.fromEntries(
      Object.entries(hashMap(root, contract.evaluatorHashes, contract.sourceRenames)).map(
        ([name, hash]) => [path.basename(name), hash]
      )
    ),
    'candidate evaluator hashes'
  );
}
function verifyEvidence(root, contract) {
  const fixture = localPath(root, contract.fixtureRoot);
  hashMap(fixture, contract.evidenceHashes);
  hashMap(root, contract.evaluatorHashes, contract.sourceRenames);
  const baseline = hashed(path.join(fixture, contract.baseline.file), contract.baseline.sha256);
  const labels = JSON.parse(
    fs.readFileSync(path.join(fixture, 'frozen-labels/manifest.json'), 'utf8')
  );
  const review = hashed(
    path.join(fixture, contract.parserReview.file),
    contract.parserReview.sha256
  );
  const generator = hashMap(
    root,
    { 'scripts/build-retrieval-labels.js': contract.parserReview.generatorSha256 },
    contract.sourceRenames
  );
  const current = hashed(
    path.join(fixture, contract.currentParserReview.file),
    contract.currentParserReview.sha256
  );
  same(
    Object.keys(current.extractorSources ?? {}).sort(),
    Object.keys(contract.parserHashes)
      .map((name) => contract.sourceRenames[name]?.path ?? name)
      .sort(),
    'source rename/current parser inventory'
  );
  // V5/V6 retain historical parser provenance. V7 independently binds every current dependency;
  // its generated label bytes must still equal the frozen labels. Rename counts remain guarded.
  hashMap(root, current.extractorSources);
  for (const name of Object.keys(contract.parserHashes)) {
    const rename = contract.sourceRenames[name];
    originalSource(fs.readFileSync(localPath(root, rename?.path ?? name)), rename, name);
  }
  same(current.generatorSha256, Object.values(generator)[0], 'current label generator');
  same(review.extractorSources, contract.parserHashes, 'review parser inventory');
  same(
    Object.keys(labels.extractorSources).sort(),
    Object.keys(contract.parserHashes).sort(),
    'original parser inventory'
  );
  for (const manifest of [labels, review, current]) {
    same(
      manifest.corpusSha256,
      contract.evidenceHashes['acceptance-fixture/corpus.json'],
      'manifest corpus'
    );
    same(
      manifest.labelsSha256,
      contract.evidenceHashes['frozen-labels/labels.json'],
      'manifest labels'
    );
    if (manifest !== current)
      same(manifest.generatorSha256, contract.parserReview.generatorSha256, 'label generator');
    for (const name of ['primary', 'mission', 'mixed'])
      same(manifest.counts[name], contract.counts[name], 'manifest denominator');
  }
  same(current.counts, labels.counts, 'current manifest denominator');
  hashed(
    path.join(fixture, 'labels-v7-review/labels.json'),
    contract.evidenceHashes['frozen-labels/labels.json']
  );
  hashed(
    path.join(fixture, 'labels-v5-review/labels.json'),
    contract.evidenceHashes['frozen-labels/labels.json']
  );
  same(
    baseline.fixtureSha256,
    contract.evidenceHashes['acceptance-fixture/corpus.json'],
    'baseline corpus'
  );
  same(
    baseline.labelsSha256,
    contract.evidenceHashes['frozen-labels/labels.json'],
    'baseline labels'
  );
  validateReport(baseline, contract, 'baseline');
  return { fixture, baseline };
}

module.exports = {
  same,
  readContract,
  isPublicMirror,
  validateReport,
  snapshotSources,
  verifyCandidateSource,
  verifyEvidence,
};

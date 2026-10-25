// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A reviewed parser refresh preserves frozen labels and every historical retrieval seal.
// ABOUTME: Current dependency bytes and fresh review evidence must remain bound before and after the child.
import * as fs from 'fs';
import * as path from 'path';
import {
  setup,
  put,
  hash,
  root,
  fixturePath,
  contractPath,
} from '../helpers/retrieval-quality-gate';
const { runGate } = require('../../scripts/retrieval-quality-gate');

const reviewFile = `${fixturePath}/labels-v8-review/manifest.json`;
function refreshed() {
  const fixture = setup();
  const historical = JSON.stringify(fixture.contract);
  const original = JSON.parse(
    fs.readFileSync(path.join(root, `${fixturePath}/labels-v5-review/manifest.json`), 'utf8')
  );
  put('src/parser.ts', 'export const parser = "reviewed implementation";');
  const review = {
    ...original,
    extractorSources: { ...original.extractorSources, 'src/parser.ts': hash('src/parser.ts') },
  };
  put(reviewFile, review);
  put(
    `${fixturePath}/labels-v8-review/labels.json`,
    fs.readFileSync(path.join(root, `${fixturePath}/frozen-labels/labels.json`), 'utf8')
  );
  const contract = {
    ...fixture.contract,
    schemaVersion: 3,
    currentParserReview: { file: 'labels-v8-review/manifest.json', sha256: hash(reviewFile) },
  };
  const save = () => {
    put(reviewFile, review);
    contract.currentParserReview.sha256 = hash(reviewFile);
    put(contractPath, contract);
  };
  save();
  fixture.candidate.sourceHashes['src/parser.ts'] = hash('src/parser.ts');
  fixture.saveCandidate();
  return { ...fixture, historical, contract, review, save };
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('accepts reviewed new parser bytes without rewriting the baseline, labels or V5/V6/V7 provenance', () => {
  const fixture = refreshed();
  expect(runGate({ root }).skipped).toBe(false);
  for (const [key, value] of Object.entries(JSON.parse(fixture.historical)))
    if (key !== 'schemaVersion' && key !== 'currentParserReview')
      expect(Reflect.get(fixture.contract, key)).toEqual(value);
  expect(fixture.contract.parserHashes['src/parser.ts']).not.toBe(hash('src/parser.ts'));
  for (const [name, digest] of Object.entries(fixture.contract.evidenceHashes))
    expect(hash(`${fixturePath}/${name}`)).toBe(digest);
  expect(hash(`${fixturePath}/${fixture.contract.baseline.file}`)).toBe(
    fixture.contract.baseline.sha256
  );
  expect(hash(`${fixturePath}/${fixture.contract.parserReview.file}`)).toBe(
    fixture.contract.parserReview.sha256
  );
});

it.each(['manifest.json', 'labels.json'])(
  'rejects missing or changed V8 %s before running a child',
  (name) => {
    refreshed();
    fs.unlinkSync(path.join(root, `${fixturePath}/labels-v8-review/${name}`));
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
    put(`${fixturePath}/labels-v8-review/${name}`, {});
    expect(() => runGate({ root })).toThrow(/sealed hash/);
  }
);

it.each([
  ['manifest.json', 'missing'],
  ['manifest.json', 'changed'],
  ['labels.json', 'missing'],
  ['labels.json', 'changed'],
])('rejects retained V6 %s when %s before running a child', (name, change) => {
  setup();
  const file = `${fixturePath}/labels-v6-review/${name}`;
  if (change === 'missing') fs.unlinkSync(path.join(root, file));
  else put(file, {});
  // Advancing the current review must not make the previous review's evidence optional.
  expect(() => runGate({ root })).toThrow(/sealed hash/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
});

it.each(['manifest.json', 'labels.json'])(
  'rejects retained V6 %s changed during the child',
  (name) => {
    setup();
    put('child-mutation.json', JSON.stringify(`${fixturePath}/labels-v6-review/${name}`));
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
  }
);

it.each([
  ['manifest.json', 'missing'],
  ['manifest.json', 'changed'],
  ['labels.json', 'missing'],
  ['labels.json', 'changed'],
])('rejects retained V7 %s when %s before running a child', (name, change) => {
  setup();
  const file = `${fixturePath}/labels-v7-review/${name}`;
  if (change === 'missing') fs.unlinkSync(path.join(root, file));
  else put(file, {});
  // Advancing the current review must not make the previous review's evidence optional.
  expect(() => runGate({ root })).toThrow(/sealed hash/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
});

it.each(['manifest.json', 'labels.json'])(
  'rejects retained V7 %s changed during the child',
  (name) => {
    setup();
    put('child-mutation.json', JSON.stringify(`${fixturePath}/labels-v7-review/${name}`));
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
  }
);

it.each(['src/parser.ts', 'src/parser-dependency.ts', 'scripts/build-retrieval-labels.js'])(
  'rejects unreviewed %s bytes',
  (name) => {
    refreshed();
    put(name, 'unreviewed');
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
  }
);

it.each(['missing', 'extra'])(
  'rejects a %s current dependency even with a resealed manifest',
  (change) => {
    const fixture = refreshed();
    if (change === 'missing')
      Reflect.deleteProperty(fixture.review.extractorSources, 'src/parser.ts');
    else
      Object.assign(fixture.review.extractorSources, {
        'src/retrieval.ts': hash('src/retrieval.ts'),
      });
    fixture.save();
    expect(() => runGate({ root })).toThrow(/current parser inventory/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
  }
);

it.each(['corpusSha256', 'labelsSha256', 'generatorSha256', 'counts'])(
  'binds V8 %s to original evidence and the unchanged generator',
  (key) => {
    const fixture = refreshed();
    fixture.review[key] = key === 'counts' ? { primary: 2, mission: 1, mixed: 1 } : 'a'.repeat(64);
    fixture.save();
    expect(() => runGate({ root })).toThrow(
      /manifest corpus|manifest labels|current label generator|manifest denominator/
    );
  }
);

it.each(['src/parser.ts', reviewFile, `${fixturePath}/labels-v8-review/labels.json`])(
  'rejects %s changed during the child',
  (name) => {
    refreshed();
    put('child-mutation.json', JSON.stringify(name));
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
  }
);

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Disposable synthetic retrieval contracts and child reports shared by gate mutation tests.
// ABOUTME: These fixtures verify sealing and orchestration, never production retrieval quality.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
const { summarize } = require('../../scripts/retrieval-quality-metrics');
export const fixturePath = 'rbook/research/2026-10-s94-m06';
export const contractPath = 'tests/fixtures/retrieval-quality-contract.json';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export let root: string;
export const put = (name: string, value: unknown) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
export const hash = (name: string) => sha(fs.readFileSync(path.join(root, name)));
export const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
export function setup(mirror = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-gate-test-'));
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  put('public.txt', 'public');
  if (!mirror) put(`${fixturePath.split('/')[0]}/private.txt`, 'private checkout identity');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  put(
    'scripts/mirror-to-public.sh',
    fs.readFileSync(path.resolve(__dirname, '../../scripts/mirror-to-public.sh'), 'utf8')
  );
  put('src/parser.ts', 'export const parser = true;');
  put('src/parser-dependency.ts', 'export const dependency = true;');
  put('src/retrieval.ts', 'export const candidate = true;');
  const evaluatorNames = [
    'measure-retrieval-quality.js',
    'retrieval-quality-fixture.js',
    'retrieval-quality-metrics.js',
    'retrieval-quality-diagnostics.js',
  ];
  for (const name of evaluatorNames) put(`scripts/${name}`, '// sealed evaluator fixture');
  put(
    'scripts/measure-retrieval-quality.js',
    `const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),root=process.cwd(),fixture=path.join(root,${JSON.stringify(fixturePath)});
if(JSON.stringify(args.slice(0,6))!==JSON.stringify(['--mode','candidate','--fixture',fixture,'--source-root',root])||args.length!==8||args[6]!=='--output')throw Error('unexpected override');
fs.writeFileSync(path.join(root,'child-ran'),'yes');
fs.writeFileSync(args[7],fs.readFileSync(path.join(fixture,'candidate-fixture.json')));
const mutation=path.join(root,'child-mutation.json');
if(fs.existsSync(mutation)){const target=JSON.parse(fs.readFileSync(mutation,'utf8'));fs.appendFileSync(path.join(root,target),' ');}`
  );
  put('scripts/build-retrieval-labels.js', '// sealed label generator');
  const generatorSha256 = hash('scripts/build-retrieval-labels.js');
  const parserHashes: Record<string, string> = {
    'src/parser.ts': hash('src/parser.ts'),
    'src/parser-dependency.ts': hash('src/parser-dependency.ts'),
  };
  const data: Record<string, unknown> = {
    'acceptance-fixture/corpus.json': { rows: ['private corpus text'] },
    'acceptance-fixture/manifest.json': { frozen: true },
    'frozen-labels/labels.json': { rows: ['private labels'] },
    'frozen-labels/manifest.json': { extractorSources: parserHashes },
    'paraphrase-fixture/paraphrases.json': { queries: [{ id: 'para', expected: ['d:1'] }] },
    'paraphrase-fixture/manifest.json': { count: 1 },
    'no-relevance-controls.json': { queries: [{ id: 'negative' }] },
    'no-relevance-manifest.json': { count: 1 },
  };
  for (const [name, value] of Object.entries(data)) put(`${fixturePath}/${name}`, value);
  const labelManifest = {
    extractorSources: parserHashes,
    generatorSha256,
    corpusSha256: hash(`${fixturePath}/acceptance-fixture/corpus.json`),
    labelsSha256: hash(`${fixturePath}/frozen-labels/labels.json`),
    counts: { primary: 1, mission: 1, mixed: 1 },
  };
  put(`${fixturePath}/frozen-labels/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v5-review/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v5-review/labels.json`, data['frozen-labels/labels.json']);
  put(`${fixturePath}/labels-v6-review/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v6-review/labels.json`, data['frozen-labels/labels.json']);
  put(`${fixturePath}/labels-v7-review/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v7-review/labels.json`, data['frozen-labels/labels.json']);
  const evidenceHashes = Object.fromEntries(
    [...Object.keys(data), 'labels-v6-review/manifest.json', 'labels-v6-review/labels.json'].map(
      (name) => [name, hash(`${fixturePath}/${name}`)]
    )
  );
  const evaluatorHashes = Object.fromEntries(
    evaluatorNames.map((name) => [`scripts/${name}`, hash(`scripts/${name}`)])
  );
  const unit = (id: string, population: string) => ({
    id,
    population,
    positiveIds: ['d:1'],
    retrievedIds: ['d:1'],
  });
  const units = [
    unit('query/decision', 'primary'),
    unit('mission/decision', 'mission'),
    unit('query/mixed', 'mixed'),
    unit('query/first-prompt', 'first-prompt'),
    unit('query/first-prompt-internal', 'first-prompt-internal'),
  ];
  const baselineConfig = {
    mode: 'baseline',
    keywordOnly: true,
    effectiveSurfaces: { firstPromptFloor: 0 },
    learningPrior: 1,
  };
  const candidateConfig = { ...baselineConfig, mode: 'candidate' };
  const baseline = {
    fixtureSha256: evidenceHashes['acceptance-fixture/corpus.json'],
    labelsSha256: evidenceHashes['frozen-labels/labels.json'],
    config: baselineConfig,
    units,
    skipped: 0,
  };
  const promptUnit = {
    id: 'query/first-prompt',
    positiveIds: ['d:1'],
    internalIds: ['d:1'],
    emittedIds: ['d:1'],
  };
  const negative = { id: 'negative', internalIds: [], emittedIds: [], missionIds: [] };
  const candidate = {
    ...clone(baseline),
    config: candidateConfig,
    sourceHashes: {
      'src/parser.ts': hash('src/parser.ts'),
      'src/parser-dependency.ts': hash('src/parser-dependency.ts'),
      'src/retrieval.ts': hash('src/retrieval.ts'),
    },
    evaluatorHashes: Object.fromEntries(
      evaluatorNames.map((name) => [name, hash(`scripts/${name}`)])
    ),
    diagnostics: {
      paraphraseSha256: evidenceHashes['paraphrase-fixture/paraphrases.json'],
      noRelevanceSha256: evidenceHashes['no-relevance-controls.json'],
      paraphrase: {
        units: [unit('para/typed', 'paraphrase-typed'), unit('para/mixed', 'paraphrase-mixed')],
      },
      noRelevance: { units: [negative] },
      floorSweeps: [0, 1, 2, 3].map((threshold) => ({
        threshold,
        units: [clone(promptUnit)],
        noRelevance: [clone(negative)],
        internal: summarize([units[3]]),
        emitted: summarize([units[3]]),
      })),
    },
  };
  put(`${fixturePath}/frozen-baseline.json`, baseline);
  const contract = {
    schemaVersion: 3,
    sourceRenames: {} as Record<
      string,
      { path: string; replacements: Array<{ from: string; to: string; count: number }> }
    >,
    mission: 's94-m06',
    fixtureRoot: fixturePath,
    baseline: {
      file: 'frozen-baseline.json',
      sha256: hash(`${fixturePath}/frozen-baseline.json`),
      sourceCommit: 'a'.repeat(40),
    },
    evidenceHashes,
    parserHashes,
    parserReview: {
      file: 'labels-v5-review/manifest.json',
      sha256: hash(`${fixturePath}/labels-v5-review/manifest.json`),
      generatorSha256,
    },
    currentParserReview: {
      file: 'labels-v7-review/manifest.json',
      sha256: hash(`${fixturePath}/labels-v7-review/manifest.json`),
    },
    evaluatorHashes,
    baselineConfig,
    candidateConfig,
    counts: { primary: 1, mission: 1, mixed: 1 },
    requiredSourceFiles: ['src/parser.ts', 'src/parser-dependency.ts', 'src/retrieval.ts'],
  };
  put(contractPath, contract);
  const saveCandidate = () => put(`${fixturePath}/candidate-fixture.json`, candidate);
  saveCandidate();
  return { candidate, contract, saveCandidate };
}

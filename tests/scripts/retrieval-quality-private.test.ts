// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Requires the actual sealed private corpus at runtime without rerunning the full benchmark.
// ABOUTME: Public mirrors disclose their skip; missing private evidence and real positive losses fail loudly.
import * as fs from 'fs';
import * as path from 'path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
const { readContract, verifyEvidence } = require('../../scripts/retrieval-quality-contract');
const { compareReports } = require('../../scripts/retrieval-quality-metrics');

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The retrieval acceptance baseline and natural labels contain private project records; CI executes the actual candidate benchmark separately.',
  paths: {
    baseline: 'rbook/research/2026-10-s94-m06/frozen-baseline.json',
    corpus: 'rbook/research/2026-10-s94-m06/acceptance-fixture/corpus.json',
    labels: 'rbook/research/2026-10-s94-m06/frozen-labels/labels.json',
    manifest: 'rbook/research/2026-10-s94-m06/frozen-labels/manifest.json',
    parserReview: 'rbook/research/2026-10-s94-m06/labels-v5-review/manifest.json',
    reviewLabels: 'rbook/research/2026-10-s94-m06/labels-v5-review/labels.json',
    retainedParserReview: 'rbook/research/2026-10-s94-m06/labels-v6-review/manifest.json',
    retainedReviewLabels: 'rbook/research/2026-10-s94-m06/labels-v6-review/labels.json',
    retainedV7ParserReview: 'rbook/research/2026-10-s94-m06/labels-v7-review/manifest.json',
    retainedV7ReviewLabels: 'rbook/research/2026-10-s94-m06/labels-v7-review/labels.json',
    currentParserReview: 'rbook/research/2026-10-s94-m06/labels-v8-review/manifest.json',
    currentReviewLabels: 'rbook/research/2026-10-s94-m06/labels-v8-review/labels.json',
  },
});
const root = path.resolve(__dirname, '../..');
type Unit = { population: string; positiveIds: string[]; retrievedIds: string[] };

PRIVATE.describe('sealed private retrieval acceptance evidence', () => {
  it('requires every current seal and the actual paired baseline populations', () => {
    const contract = readContract(root);
    const { baseline } = verifyEvidence(root, contract);
    const labels = JSON.parse(fs.readFileSync(PRIVATE.paths.labels, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(PRIVATE.paths.manifest, 'utf8'));
    expect(labels.queries).toHaveLength(manifest.counts.queries);
    expect(fs.readFileSync(PRIVATE.paths.reviewLabels)).toEqual(
      fs.readFileSync(PRIVATE.paths.labels)
    );
    expect(fs.readFileSync(PRIVATE.paths.currentReviewLabels)).toEqual(
      fs.readFileSync(PRIVATE.paths.labels)
    );
    for (const population of ['primary', 'mission', 'mixed'])
      expect(baseline.units.filter((unit: Unit) => unit.population === population)).toHaveLength(
        contract.counts[population]
      );
  });

  it('rejects actual frozen retrieved-positive loss through the paired-regression arm', () => {
    const { baseline } = verifyEvidence(root, readContract(root));
    const candidate = JSON.parse(JSON.stringify(baseline));
    let removed = 0;
    for (const unit of candidate.units as Unit[]) {
      if (unit.population !== 'primary') continue;
      unit.retrievedIds = unit.retrievedIds.filter((id) => {
        if (!unit.positiveIds.includes(id)) return true;
        removed++;
        return false;
      });
    }
    expect(removed).toBeGreaterThan(0);
    // The old baseline itself is below the new absolute target. Only this specific failure proves
    // the mutation reached the paired comparison, rather than failing for the pre-existing target.
    expect(() => compareReports(baseline, candidate)).toThrow(/paired recall regression/);
  });
});

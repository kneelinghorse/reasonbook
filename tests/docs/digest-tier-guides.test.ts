// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Local and shipped tier guides promise the same bounded next-step digest contract.
// ABOUTME: These prose checks prevent a stale Ledger omission or lost full-record remedy from shipping.

import * as fs from 'fs';
import * as path from 'path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const root = path.resolve(__dirname, '../..');
const shippedGuide = (tier: string): string =>
  fs.readFileSync(path.join(root, 'rbook-seed', 'tiers', `${tier}.md`), 'utf8');
const PRIVATE = requiresPrivateEvidence({
  reason: 'local tier-guide parity needs this repository’s private rbook/tiers copies',
  paths: { tiers: 'rbook/tiers' },
});
const digest = (content: string): string =>
  content.split('## The Session Digest\n')[1]?.split('\n## ')[0]?.trim() ?? '';

it.each(['general', 'managed', 'build'])(
  '%s shipped guide describes its bounded next-step preview',
  (tier) => {
    const shipped = digest(shippedGuide(tier));
    expect(shipped).not.toBe('');
    const prose = shipped.replace(/\s+/g, ' ');
    expect(prose).toContain('lapsing, warning, idle');
    expect(prose).toContain('then newest');
    expect(prose).toContain('6 recent decisions');
    expect(prose).toContain('4,000 characters');
    expect(prose).toContain('nextStepAction="list"');
    expect(prose).toContain('preview');
    expect(prose).toContain('nextStepAction="show", nextStepIds=[123]');
    expect(prose).toContain('in full');
    expect(prose).toContain(tier === 'build' ? 'up to 3' : 'up to 5');
    if (tier === 'build') {
      expect(prose).toContain('400-character Open work');
      expect(prose).toContain('mission');
      expect(prose).toContain('72 characters');
      expect(prose).toContain('Next steps (k of N)');
    }
    expect(shippedGuide(tier)).not.toMatch(/next steps are kept separately from the Ledger digest/);
  }
);

PRIVATE.describe('local and shipped tier-guide parity', () => {
  it.each(['general', 'managed', 'build'])('%s keeps the same digest contract', (tier) => {
    const local = fs.readFileSync(path.join(PRIVATE.paths.tiers, `${tier}.md`), 'utf8');
    expect(digest(local)).toBe(digest(shippedGuide(tier)));
    expect(local).not.toMatch(/next steps are kept separately from the Ledger digest/);
  });
});

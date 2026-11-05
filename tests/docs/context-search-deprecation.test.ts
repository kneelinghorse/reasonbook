// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The session-search compatibility promise lives in documents after its next-step row expires.
// ABOUTME: Public release notes and the private architecture reference keep the same major-version boundary.

import fs from 'fs';
import path from 'path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE = requiresPrivateEvidence({
  reason: 'the architecture home of the session-search compatibility promise',
  paths: { architecture: 'rbook/docs/architecture.md' },
});
const promise = /`rbook_context`[^\n]*`searchTypes`[^\n]*until 5\.0\.0/;

it('publishes the session-search deprecation boundary in the changelog', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  expect(changelog).toContain('### Deprecated');
  expect(changelog).toMatch(promise);
});

PRIVATE.describe('architecture owns the promise beyond next step 896', () => {
  it('keeps the accepted session enum value until 5.0.0', () => {
    const architecture = fs.readFileSync(PRIVATE.paths.architecture, 'utf8');
    expect(architecture).toMatch(promise);
    expect(architecture).toMatch(/keeps `"session"` until 5\.0\.0/);
  });
});

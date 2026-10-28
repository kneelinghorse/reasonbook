// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Public docs must describe deployed recovery without hiding retained copies or promising a new host guarantee.
// ABOUTME: These regressions retain the sprint-103 review's forbidden sentences and the user-facing facts replacing them.
import fs from 'fs';
import path from 'path';

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8').replace(/\s+/g, ' ');
const recoveryDocs = ['README.md', 'docs/privacy.md', 'docs/trust.md', 'docs/getting-started.md'];

describe('hosted recovery disclosure', () => {
  it.each(recoveryDocs)('%s no longer says deployed hosted recovery is unavailable', (file) => {
    expect(read(file)).not.toMatch(
      /is not deployed on reasonbook|has not deployed the recovery route|does not yet offer this recovery route|has no recovery route yet/
    );
  });

  it('describes automatic recovery discovery and the owner-controlled confirmation', () => {
    const privacy = read('docs/privacy.md');
    expect(privacy).not.toContain('owner-started recovery');
    expect(read('docs/trust.md')).not.toContain('owner-started recovery');
    expect(privacy).toContain('dashboard begins recovery');
    expect(privacy).toContain('owner reviews the plan');
    expect(privacy).toContain('confirms or cancels');
    expect(privacy).toContain('cancelled attempt can be restarted');
    expect(privacy).toContain('previously recorded valid member census');
  });

  it('names retained recovery material and distinguishes it from ordinary snapshot expiry', () => {
    const privacy = read('docs/privacy.md');
    expect(privacy).toMatch(/accepted recovery contributions/i);
    expect(privacy).toContain('current stored plan');
    expect(privacy).toContain('until the project is deleted');
    expect(privacy).toContain('earlier snapshots');
    expect(privacy).toContain('Refused contributions are removed');
    expect(privacy).toContain('replanning replaces the stored plan');
    for (const file of ['docs/privacy.md', 'docs/trust.md']) {
      expect(read(file)).toMatch(/remov\w*[^.]*recovery[^.]*contributions/i);
    }
  });

  it('explains retained member identities on same-record re-share and the deployed set-aside control', () => {
    const privacy = read('docs/privacy.md');
    expect(privacy).not.toContain('refuses their usernames');
    expect(privacy).toContain(
      'same-record re-share carries member/account bindings, including removed members'
    );
    expect(privacy).toContain('admitted only over SSH');
    const main = read('README.md');
    expect(main).not.toMatch(
      /cannot safely restore its members|needs the host's set-aside deployment|must deploy that operation/
    );
    expect(main).toContain('Set aside this copy');
    expect(main).toContain('This copy is gone');
    expect(read('docs/trust.md')).not.toContain('must pin the supporting library');
  });

  it('discloses recovery uploads in the full outbound-network list and keeps both controls', () => {
    const security = read('SECURITY.md');
    expect(security).toContain('**Recovery contributions**');
    expect(security).toContain('/api/relay/projects/<id>/recovery/copy');
    const contribution = security.split('**Recovery contributions**')[1] ?? '';
    expect(contribution).toContain('RBOOK_SHARED_SYNC=off');
    expect(contribution).toContain('RBOOK_DASHBOARD_SHARING=off');
    expect(contribution).toContain('RBOOK_CHECKPOINT_SYNC=off');
  });

  it('does not present the new census guarantee as already deployed', () => {
    const privacy = read('docs/privacy.md');
    expect(privacy).toContain('deployed host still refuses');
    expect(privacy).toContain('4.7.0');
    expect(privacy).toContain('invalidate its census before');
  });

  it('discloses all draft outcomes and other projects mission names entering this conversation', () => {
    const privacy = read('docs/privacy.md');
    expect(privacy).toContain('approved and replaced drafts');
    expect(privacy).toContain('those marked answered');
    expect(privacy).toContain("other projects' mission names");
    expect(privacy).toContain('current AI conversation');
  });

  it.each(['docs/privacy.md', 'docs/trust.md', 'plugins/reasonbook/README.md'])(
    '%s distinguishes excerpt row cleanup from physical erasure',
    (file) => {
      expect(read(file)).toContain('SQLite free pages');
      expect(read(file)).toContain('physical erasure');
    }
  );

  it('gives the demo date an explicit timezone and identifies the hosting plan correctly', () => {
    expect(read('docs/demo/README.md')).toMatch(/recorded on \d{4}-\d{2}-\d{2} UTC/);
    expect(read('docs/privacy.md')).toContain("workspace's Pro plan");
    expect(read('docs/trust.md')).toContain('4.2.1 or later on both machines');
  });
});

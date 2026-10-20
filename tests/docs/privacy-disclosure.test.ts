// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps the public privacy disclosure reachable and explicit about account visibility.
// ABOUTME: These prose checks guard published promises; source and hosting evidence need review.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const privacy = (): string => read('docs/privacy.md').replace(/\s+/g, ' ');

describe('public privacy disclosure', () => {
  it('covers collection, use, retention and removal for the local record and optional service', () => {
    const text = privacy();
    for (const section of [
      'The local server and its plugins',
      'Installing from npm',
      'The dashboard (optional)',
      'What is collected',
      'What it is used for',
      'How long it is kept',
      'How to remove it',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('rbook/db/rbook.sqlite');
    expect(text).toContain('~/.config/rbook/');
    expect(text).toContain('(migrating-from-cmos.md)');
  });

  it('separates email-address discovery from mail access and intended use from enforcement', () => {
    const text = privacy();
    expect(text).toContain('intended for people working within one organization');
    expect(text).toContain(
      'registration does not require an invitation or verify organization membership'
    );
    expect(text).toContain('email addresses');
    expect(text).toContain('does not connect to or read your email inbox');
    expect(text).toContain('does not include email addresses');
    expect(text).toContain('owners and active collaborators');
    expect(text).toContain('known authorization limitations');
    expect(text).toContain('Diagnostic views can expose sync-request contents across accounts');
    expect(text).toContain('contents of rejected unauthenticated requests');
    // Since the dashboard's 2026-10-13 change, other accounts see names, never email addresses.
    expect(text).toContain('never by their email address');
    expect(text).not.toContain("can see other registered users' email addresses");
    expect(text).not.toContain("returns its owner's email address");
  });

  it('says what reasonbook.ai keeps for a project shared through it, and what deletion leaves', () => {
    const text = privacy();
    expect(text).toContain('Sharing through reasonbook.ai');
    // s100-m02 (the s97 review's findings 1, 2 and 4): a share needs the project registered, and
    // registering and every upload after it send the whole file, so nothing "stays on the machine"
    // before the handover; the share itself sends only the shared record.
    expect(text).toContain('registers the project and uploads its whole SQLite file');
    expect(text).toContain('Every later upload sends the whole file again');
    expect(text).toContain('no close uploads or registers a project');
    expect(text).toContain('a fresh copy holding only the shared record');
    expect(text).toContain("each change's author name");
    expect(text).toContain('snapshotted daily and each snapshot is kept 7 days');
    // Who can see it: every share holder, read-only included; every other account only the
    // directory's entry, never the record.
    expect(text).toContain('read-only shares included');
    expect(text).toContain('but none of its record');
    expect(text).not.toContain('Other accounts see nothing of the project');
    // Removal deletes nothing already held. Purge is refused on every copy while the dashboard holds
    // the record (the owner's copy is a member's then), so the page names the way that works;
    // project deletion leaves the mirror and the logs (s100-m02, the docs-truth critic's round 2).
    expect(text).toContain('Removing a member deletes nothing');
    expect(text).toContain("every copy refuses it, the owner's included");
    expect(text).toContain('the owner moves the project back first');
    expect(text).toContain(
      'It leaves the mirror, its sync log and the activity and diagnostic logs'
    );
    expect(text).not.toContain('is not available yet');
    expect(text).toContain('two accounts operated by one person, on two machines');
  });

  it('gives current removal controls without promising deletion from every copy', () => {
    const text = privacy();
    expect(text).toContain('rbook_db(action="purge", confirm=true, expectedSlug="<slug>")');
    expect(text).toContain('rbook_auth(action="logout")');
    expect(text).toContain('rbook_auth(action="revoke", keyId="<id>")');
    expect(text).toContain('Activity and sync logs are kept');
    expect(text).toContain('https://github.com/kneelinghorse/reasonbook/issues');
  });

  it('makes privacy reachable from the landing page, docs, trust page and plugin listing', () => {
    for (const file of [
      'README.md',
      'docs/README.md',
      'docs/trust.md',
      'plugins/reasonbook/README.md',
    ]) {
      expect(read(file)).toMatch(/\[Privacy\]\([^\n)]*privacy\.md\)/);
    }
  });
});

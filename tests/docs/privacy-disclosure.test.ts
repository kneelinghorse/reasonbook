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
    // The deployment notice and its verified Railway commit now scope discovery to held access.
    expect(text).toContain('only projects you own or that are shared with you');
    expect(text).not.toContain('archive markers across accounts');
    expect(text).not.toContain('lists every project');
    expect(text).toContain(
      'Cross-project intelligence pages and APIs, including Supervision and the Brief, require a configured operator account'
    );
    expect(text).toContain(
      'Diagnostic views show your requests and eligible requests for projects you can access'
    );
    expect(text).toContain('platform-wide diagnostic counts require an operator account');
    expect(text).not.toContain('known authorization limitations');
    expect(text).not.toContain('Diagnostic views can expose sync-request contents across accounts');
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
    expect(text).toContain(
      'stops these uploads, including explicit closes and manual backfill, for every project that process serves'
    );
    expect(text).toContain('It does not stop shared-record exchanges');
    expect(text).toContain('a fresh copy holding only the shared record');
    expect(text).toContain("each change's author name");
    expect(text).toContain('snapshotted daily and each snapshot is kept 7 days');
    // A pending invitation must not be mistaken for access to the shared record.
    expect(text).toContain('read-only shares included');
    expect(text).toContain('A waiting invitation grants no access');
    // Removal deletes nothing already held. Purge is refused on every copy while the dashboard holds
    // the record (the owner's copy is a member's then), so the page names the way that works;
    // deletion removes the dashboard's mirror and attributed logs, but cannot retract member copies.
    expect(text).toContain('Removing a member deletes nothing');
    expect(text).toContain("every copy refuses it, the owner's included");
    expect(text).toContain('the owner moves the project back first');
    expect(text).toContain(
      'Deleting the project removes its registration, mirror and mirror sync log, attributed activity and sync-request logs, shares, keys and signals report'
    );
    expect(text).toContain(
      'attempts to remove the uploaded file, referee copy, snapshots and archive'
    );
    expect(text).toContain('file-removal failures are logged for cleanup');
    expect(text).toContain('do not need to purge, move it back, stop uploads or sign out first');
    // The tombstone, rather than a mandatory sign-out, stops ordinary uploads resurrecting a
    // deleted project. A revoked project key's 401 is not evidence of that tombstone on its own.
    expect(text).toContain(
      "tombstone containing the owner's account id, each current or former project slug and the deletion time"
    );
    expect(text).toContain(
      "Uploads and pushes authenticated with the owner's account credential receive `410 PROJECT_DELETED`"
    );
    expect(text).toContain(
      "the deleted project's key receives `401` because that key no longer exists"
    );
    expect(text).toContain('A `401` alone does not prove deletion');
    expect(text).toContain(
      'The tombstone lasts until the slug is deliberately taken again or the account is deleted'
    );
    expect(text).not.toContain(
      'It leaves the mirror, its sync log and the activity and diagnostic logs'
    );
    expect(text).not.toContain('Purge before deleting a project');
    expect(text).toContain('Every member keeps their own copy');
    expect(text).toContain('two accounts operated by one person, on two machines');
  });

  it('explains invitation acceptance and directional messaging without promising anonymous lookup', () => {
    const text = privacy();
    expect(text).toContain(
      'A new message reaches an account only if that recipient has let the sender in'
    );
    expect(text).toContain("Co-members of a third person's project do not count");
    expect(text).toContain('same 404 response as a missing address');
    expect(text).toContain(
      'Exact username or email lookup returns a name or says no account matches'
    );
    expect(text).toContain(
      'Turning this setting on lets anyone message you and share projects with you'
    );
    expect(text).toContain('opens the link, signs in and chooses Join');
    expect(text).not.toContain('Whoever opens it while signed in joins');
    const guide = read('docs/getting-started.md').replace(/\s+/g, ' ');
    expect(guide).toContain(
      'accept the invitation on their home page at reasonbook.ai before joining'
    );
    expect(guide).toContain('A read-only share does not create a local copy');
    expect(guide).toContain('open the link, sign in and choose Join');
  });

  it('gives current removal controls without promising deletion from every copy', () => {
    const text = privacy();
    expect(text).toContain('rbook_db(action="purge", confirm=true, expectedSlug="<slug>")');
    expect(text).toContain('rbook_auth(action="logout")');
    expect(text).toContain('rbook_auth(action="revoke", keyId="<id>")');
    expect(text).toContain(
      'Its activity rows, sync-request logs sent by or routed to it, signals reports and deletion tombstones are removed too'
    );
    expect(text).toContain(
      'Uploaded files, referee copies, snapshots and archives are removed on a best-effort basis'
    );
    expect(text).toContain(
      "Your edits and activity relayed into other owners' projects remain there"
    );
    expect(text).toContain('Deleting a live record does not remove it from an existing backup');
    expect(text).toContain(
      'Deleting a project leaves its messages, with their project links removed'
    );
    expect(text).not.toContain('Activity and sync logs are kept');
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

  it('discloses stored conversation excerpts before approval and their later transfer', () => {
    const text = privacy();
    expect(text).toContain('up to 600 characters of the preceding assistant reply');
    expect(text).toContain('pending, declined and expired drafts remain stored');
    expect(text).toContain('approval words copied into a decision');
    expect(text).toContain('whole-store dashboard uploads and initial shared copies');
    expect(text).toContain('Validity expiry is not immediate physical erasure');
    expect(text).not.toContain(
      'Your message after a draft is deleted at session end or expires after two hours'
    );
  });

  it('distinguishes sampled record-bearing hosting errors from content-free local telemetry', () => {
    const text = privacy();
    expect(text).toContain('up to three error strings, each truncated to 200 characters');
    expect(text).toContain('database errors can quote record field values');
    expect(text).toContain('not a bound on all diagnostic logging');
    expect(text).toContain('14 days of log retention');
    expect(text).toContain('does not retroactively erase hosting logs or backups');
    const trust = read('docs/trust.md').replace(/\s+/g, ' ');
    expect(trust).toContain('tool results to your AI client');
    expect(trust).toContain('record field values');
    const plugin = read('plugins/reasonbook/README.md').replace(/\s+/g, ' ');
    expect(plugin).not.toContain('There is no remote telemetry.');
    expect(plugin).toContain('local usage log is never uploaded');
    expect(plugin).toContain('assistant excerpts');
  });
});

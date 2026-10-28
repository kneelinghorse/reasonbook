# Privacy

Reasonbook keeps a local project record, can share copies with members, and offers an optional hosted
dashboard. This page describes what each part collects, why it keeps it, who can see it and how to
remove it. It covers Reasonbook's
server and plugins; your AI client's and model provider's own policies apply to the prompts, tool
results and files they receive. [Trust](trust.md) explains the local hooks and network controls in
more detail.

## Local directory edition

The `reasonbook-chat` plugin selects the directory mode of the same npm package. It records only
what you ask to save or approve through its skills. It has no hooks, transcript/history readers,
operator-profile injection, draft capture or approval-runtime access. It never reads or writes
`CLAUDE.md`, `AGENTS.md` or `.claude`, and init creates no agent instructions. Existing local
records remain readable; this mode does not erase previously saved content.

It makes no server-side network calls: dashboard credentials do not enable sharing, messages,
checkpoint uploads or sign-in. SSH and automatic sync are disabled. Search is keyword-only and
optional model/tokenizer downloads are disabled. First installation still downloads the pinned npm
package and dependencies; SQLite may fetch its native binary from GitHub or Node headers from
nodejs.org. Your AI client receives requested tool results under its own policy.

It stores the selected project record, local snapshots and Reasonbook's own configuration, registry
and usage files. Registry lookup can read path and identity/address metadata from registered stores;
it does not aggregate their record content. The selected project's constraints are returned as data.
Its MCP usage log contains timestamps, restricted tool/client/session tokens, outcomes and capped
record identifiers, never argument/result prose; the three newest monthly files are retained. The
legacy `telemetry_events` table can contain arbitrary imported JSON and is not this log. Existing
records, backups and SQLite free-page contents have the retention limits described below.

The remaining hooks, dashboard and sharing disclosures describe the full plugin, available
separately as `reasonbook@reasonbook`. See the
[directory edition README](../plugins/reasonbook-chat/README.md) for installation and exact boundaries.

## The local server and its plugins

**What is collected.** Ordinary local work needs no dashboard account. Reasonbook's server contacts
the dashboard only for dashboard operations, including sign-in, or when dashboard credentials are
available. On your machine it keeps:

- your project's record in `rbook/db/rbook.sqlite`;
- under `~/.config/rbook/`, the project registry, your operator profile and the author name you
  set (`config.json`), which each record you write carries;
- a local usage log: tool names, identifiers, counts, error codes, which published prompt patterns
  a prompt matches and the slash command it starts with, without prompt text or record contents;
- hook state: session identifiers as hashes, the folders and repositories you worked in, each
  session's Git commit and changed filenames, your next message after a displayed draft (up to
  1,000 characters), and which record previews you have already seen;
- if you sign in, dashboard keys in `credentials.json`, readable only by your user account and
  not encrypted, and each sign-in's account id, username and dashboard address in
  `dashboard-identity.json`, so that your records can name you as their author. Each entry is
  kept under a fingerprint of its key, never the key itself. For an email and password sign-in
  the fingerprint is of the email, so someone who can read the file and guesses your email can
  confirm it.

The hooks read your prompt and the agent's last reply. Claude Code hooks also read bounded pieces
of its transcript; the Codex transcript path is discarded. Reasonbook's MCP tools return the
requested project information to your AI client. `rbook_review` can also read registered local
projects and return their project names, attention counts and other projects' mission names into
the current AI conversation. The local usage log is never uploaded.

Draft capture stores up to three proposed lines of 1,000 characters each and up to 600 characters
of the preceding assistant reply in the project's SQLite file, before approval. This includes
profile drafts; pending, declined and expired drafts remain stored, as do approved and replaced drafts and those marked answered,
until the record is removed. Expiry changes whether a draft can be used, not whether it is stored.
These excerpts can travel in whole-store dashboard uploads and initial shared copies. Later
shared-record exchanges exclude proposals, but include approval words copied into a decision.
Those words follow the decision's retention, not the runtime excerpt's two-hour validity.
The operator profile file itself stays outside project uploads; hooks can add its text to the AI
client's context in later projects. Client and model-provider retention follows their own policies.

**What it is used for.** To give your agents the project's record and keep the hooks working.

**How long it is kept.** Until you delete it, with these exceptions:

- The usage log keeps its three newest months.
- A session's Git note is deleted when the session-end hook completes; otherwise it remains until
  you delete it.
- Your message after a draft is valid for approval binding for two hours. Validity expiry is not
  immediate physical erasure: later binding operations or session cleanup delete the excerpt rows.
  Their text can remain in SQLite free pages in the user-only runtime file after row deletion;
  cleanup does not guarantee physical erasure. Without cleanup, the rows can remain until you
  delete the runtime store. Approval words already
  copied into a decision remain with that record.
- A decline awaiting a busy store keeps only its draft id and first decline time until the store
  confirms the draft is no longer pending. This retry marker survives session cleanup.
- Shown draft references contain ids and times, without your words. They expire after three later
  session starts in that store or more than seven days, and clear when that conversation restarts
  or ends.
- An interrupted upload, share, join, import or replay can leave record data in your temp folder.
  The next such operation removes matching directories owned by your user and older than a day;
  symlinks and other users' directories stay. Without a numeric user ID, including on Windows,
  you remove them yourself. [Trust](trust.md#removing-your-data) lists the directory prefixes.

**How to remove it.** Delete the project's `rbook/` folder and `~/.config/rbook/`. Uninstalling the
plugin does not delete these records. Existing installations can still use their older record and
configuration locations until you migrate them; deleting only the new location does not remove
that older data. Follow the [upgrade and migration guide](migrating-from-cmos.md) to identify those
locations. Init also creates `AGENTS.md` and `CLAUDE.md` when absent; you can edit or remove them.

## Shared copies

**What a member receives.** Sharing gives a member a full copy of the SQLite store, including its
record history and any pending, declined or expired proposals already stored there. Later exchanges
carry shared-record changes through the owner's copy, over SSH or bundles carried by hand. There is
no private subset of the initial store copy. A dashboard account is not required for this exchange.

**Who can see and use it.** A member with the file can read the contents. Editors' accepted rows
reach the owner's agents as local project content, without a foreign-source fence. Owner/editor
roles hold among honest copies using the supported SSH and bundle protocol; they do not protect
against a member who alters their local store or software. Author names provide attribution, not
independent identity verification. Choose members you trust with the whole record and with the
content your agents will read.

**Control and removal.** Copies with a saved route exchange automatically at session start and end
where hooks run, and every five minutes for shared projects a running server has opened. Set
`RBOOK_SHARED_SYNC=off` in the hook and server environments to stop these automatic exchanges;
explicit sync and bundle commands remain available. The dashboard-upload switch,
`RBOOK_CHECKPOINT_SYNC`, is separate. Removing a member stops new changes from reaching them and
quarantines their changes beyond the removal cut. It cannot retract data their copy already holds;
the holder must delete that copy. Re-inviting the member resumes exchange, and their quarantined
changes are judged again: those their role does not allow are refused.

The measured support scope is two accounts operated by one person, on two machines, sharing either
in an owner/member star over SSH or through reasonbook.ai. A second person's collaboration and
privacy experience remain unvalidated. See the [sharing steps](getting-started.md#share-a-projects-record)
and [trust boundary](trust.md#shared-copies).

## Sharing through reasonbook.ai

**What goes up before the share.** Sharing needs the project on reasonbook.ai, and a project gets
there at its first upload: an explicit session close on a machine signed in to the dashboard
registers the project and uploads its whole SQLite file. Every later upload sends the whole file
again. These uploads hold everything the store holds, including session events, agent feedback,
proposals (pending, declined and expired), context documents and snapshots, telemetry events,
prompt mappings, the sync queue and the search index. `RBOOK_CHECKPOINT_SYNC=off` in the server's
environment stops these uploads, including explicit closes and manual backfill, for every project
that process serves. It does not stop shared-record exchanges. A project that was never uploaded
cannot be shared through the dashboard.

**What the share sends.** The share's own upload is a fresh copy holding only the shared record:
missions, sprints, decisions, learnings, sessions, next steps and constraints with the links between
them, and the change log. The change log holds every value ever recorded (replaced text included),
each change's author name and, from a signed-in machine, account id, the project's identity
document and every change of membership. The dashboard keeps that copy as the project's referee
copy. Once the referee copy holds the record, the owner's copy uploads no more whole files until the
project is moved back, and the project's pages come from the referee copy meanwhile. Every member's
machine keeps its own full copy of the shared record.

**Recovery contributions.** When a call finds a referee copy lost or behind, the dashboard begins recovery
if it has the required saved identity, head and member census. A member's next sync, the owner's
included, can send that copy's contribution for its remembered project and referee. It builds a fresh file
with the shared tables, identity and full change log described above; it does not copy feedback,
session timelines, proposals, snapshots, search indexes or local working-memory documents. An
accepted contribution is sent once per recovery and copy; a request without an acknowledgement may
be retried. Either `RBOOK_SHARED_SYNC=off` or `RBOOK_DASHBOARD_SHARING=off` stops this contribution,
including during an explicit sync. `RBOOK_CHECKPOINT_SYNC=off` does not. On the Shared record page,
the owner reviews the plan, chooses copies not to wait for, and confirms or cancels. A cancelled attempt can be restarted.
Choosing not to wait for a copy does not remove its member from the frozen census.

**What reasonbook.ai keeps.**

- The whole file the project's registration uploaded, until the project is deleted or registered
  again. Each later upload is read into the dashboard's mirror of the project's pages, then deleted.
- The mirror: the rows of sprints, missions, sessions, decisions, learnings, next steps and
  constraints, with mission dependencies, the context snapshots' details without their content, the
  full text of the context documents the uploads held, and the store's metadata. An upload adds and
  updates the mirror's rows but removes none except the dependency links (registering the project
  again rebuilds it whole), so a row deleted on your machine stays there, and the people a project
  is shared with later see rows deleted before the share. Once the project is shared, the mirror is refreshed from the referee copy after each change
  it accepts.
- The referee copy: every change it took in, with its verdict, the changes it sets aside included
  (a delivery it refuses whole is not kept); the members, by dashboard account and username; and
  each copy's latest call. Ordinary daily snapshots are pruned after 7 days. A copy that needs
  recovery or is moving back takes no new snapshot; recovery retention is described next. After a
  move back, the dashboard keeps the archived copy 7 days, and its list of the project's members
  (each one's account, username and whether they were removed) until the project is deleted. A
  same-record re-share carries these bindings forward.
- Recovery records: the frozen member census, the attempt's current stored plan and summary,
  contribution receipts and final result. Accepted recovery contributions and whatever remained at
  the lost store's path, including sidecars and account bindings, are kept until the project is deleted.
  After successful recovery, earlier snapshots move into the retained lost-store folder and no
  longer follow ordinary seven-day snapshot pruning. Refused contributions are removed;
  replanning replaces the stored plan rather than keeping every revision.
- A member's first copy is built each time they ask for it, sent, and deleted.

**The activity feed** shows what was created (sprints, missions, sessions, decisions, learnings,
next steps and constraints) and status changes: a mission started, completed or blocked, and a
sprint or session completed. Each entry names its change's author, or the row's author when the
change names none. It also keeps the entries the owner's uploads made before the share, of every
kind. It shows 50 entries a page by default, and at most 100.

**Who can see it.** The owner and everyone the project is shared with, read-only shares included,
see its pages, its feed and a list of the changes the referee set aside (whose they are, their
state and why, not their contents), and can read its identity document and mirror through the
dashboard's API. Editors' copies exchange changes with the referee copy; a read-only share holds no
copy and cannot sync. Members appear by display name and username. The directory lists only
projects you own or that are shared with you, including their name, slug, owner, address and
creation and sync times. A waiting invitation grants no access to the record; its recipient must
accept it first. The service's operators can read every account's mirror.

**Removal and deletion.**

- Removing a member deletes nothing: their later changes stop counting and they receive nothing new,
  but what their copy holds and what the project's pages already show remain. The referee keeps the
  changes it sets aside whole, in its snapshots and archive too. The owner removes a member on the
  dashboard; a member is also removed when they leave or are removed from the team the project is
  shared with, or when their account is deleted. Re-adding a removed member judges their set-aside
  changes again; those their role does not allow are refused.
- `rbook_db(action="purge", confirm=true, expectedSlug="<slug>")` clears the mirror's record tables
  and its sync log, and leaves the registration's file, the activity feed, the diagnostic logs and
  messages. While the project is shared through reasonbook.ai, every copy refuses it, the owner's
  included, and the mirror is refreshed from the referee copy after each change it accepts: to
  clear the mirror, the owner moves the project back first (`reasonbook move --to owner`), then
  purges from that copy.
- Deleting the project removes its registration, mirror and mirror sync log, attributed activity
  and sync-request logs, shares, keys and signals report. Recovery records are removed with their project.
  It also attempts to remove the uploaded file, referee copy, snapshots and archive, along with
  recovery contributions and retained lost-store artifacts; file-removal failures are logged for cleanup. You do
  not need to purge, move it back, stop uploads or sign out first. The dashboard keeps a tombstone
  containing the owner's account id, each current or former project slug and the deletion time to
  stop later uploads from recreating it. Uploads and pushes authenticated with the owner's account
  credential receive `410 PROJECT_DELETED`; the deleted project's key receives `401` because that
  key no longer exists. A `401` alone does not prove deletion. The tombstone lasts until the slug is
  deliberately taken again or the account is deleted. Messages, hosting logs and backups follow the
  retention described below. Every member keeps their own copy.
- Deleting your account removes your projects and mirrors and attempts to remove their uploaded
  files, referee copies, snapshots and retained recovery contributions and artifacts. In projects
  shared with you, your username and your changes
  remain in their record.
- The owner's copy moves a project back off reasonbook.ai with
  `rbook_project(action="move", to="owner")` or `reasonbook move --to owner`, and catches up a
  member's copy over SSH, whose person then confirms the move with `reasonbook sync --confirm-owner`
  ([steps](getting-started.md#through-reasonbookai)). That was measured live with one member
  present and automatic syncs off.

**Limits.**

- If reasonbook.ai loses a project's referee copy, normal exchange stops while recovery collects
  surviving copies. Recovery requires a previously recorded valid member census, record identity
  and head. Every member keeps their own copy. As verified on 2026-10-27, the deployed host still refuses
  finalization when its frozen census contains an invite, removal or role change absent from the
  recovered record. The 4.7.0 library can reconcile these changes while keeping verified removals;
  that guarantee reaches reasonbook.ai only after its host adopts the library and is changed to
  invalidate its census before membership-changing calls and recovery finalization, refreshing it
  after success and retaining invalidity after an unknown outcome.
- After a move back, a same-record re-share carries member/account bindings, including removed members.
  Members or copies admitted only over SSH after the move back are refused; a different record
  starts fresh. The host binds by member and account ids, not by guessing from usernames.
- Cases not measured after a move back include a member's copy that syncs with the dashboard
  before the owner's copy catches it up, whose sync then says to sync with the owner's copy over SSH
  or with a bundle, and a member's copy the owner's machine cannot reach over SSH.

Sharing through reasonbook.ai was measured with two accounts operated by one person, on two
machines.

## Installing from npm

Installing Reasonbook, or letting a plugin install it, downloads the package and its dependencies
from your configured npm registry. SQLite's install script downloads a prebuilt binary from its
GitHub releases or Node.js headers from nodejs.org to build one. If you separately install the
optional semantic-search package, its first embedding downloads a model from Hugging Face; its
dependencies can also download native libraries. These services receive the download requests and
their own policies apply. Reasonbook's dashboard receives no install report.

## The dashboard (optional)

**What is collected.** The hosted service at [reasonbook.ai](https://reasonbook.ai) keeps:

- your account's email address, password hash, username, optional display name, creation and update
  times, and last home-page visit;
- hashes of your API keys and when each was last used;
- registered projects' uploaded databases, their local file paths, copied record contents,
  including decision reasons, recorded approval words and each record's author name and account
  id, and synced events;
- for a project shared through it, its referee copy, ordinary snapshots for 7 days and, after a
  move back, its archive for 7 days; recovery records, accepted contributions and retained lost-store
  artifacts (including earlier snapshots) stay until the project is deleted, as described above;
- for projects owned by configured operator accounts, one current signals report: the project's
  name and id, counts, row ids, timestamps, rule sentences, read-failure reasons and the Reasonbook
  library version, without record prose;
- sync-request logs, including contents of rejected unauthenticated requests, and activity and
  diagnostic logs;
- messages between accounts and projects: sender, recipient, type, summary, body, links, status,
  response, and sent, read and response times;
- project invitations and their answers, and invite links' roles, expiry times and token hashes;
- a sign-in cookie that lasts seven days.

A device sign-in request also records its IP address and user agent, whether or not you have an
account. Reasonbook's user agent includes your computer's name. Sign-in rate limits temporarily
keep IP addresses in memory.

When importing an uploaded database, database errors can quote record field values. A failed
backfill's diagnostic summary includes project identifiers, an error count and up to three error
strings, each truncated to 200 characters. This is not a bound on all diagnostic logging or a
redaction guarantee; other errors and responses can include more text. These console messages
follow hosting-log retention below, separately from the database's sync-request and activity logs.
Deleting or purging a project does not retroactively erase hosting logs or backups.

**What it is used for.** To display and sync project records, support collaboration and deliver
messages. The dashboard does not connect to or read your email inbox; the email address is an
account and contact identifier. Its application code has no advertising or third-party behavioral
tracking integration. The service operator and hosting providers can access the data needed to run
the service.

Signals reports are computed when a file arrives through registration or upload, and when a shared
project refreshes its mirror. Supervision and the weekly Brief use these reports; reading those
pages does not recompute them. A failed report keeps the latest readable report with its stale date
and reason. Reports are not collected for projects owned by other accounts.

**Who else can see it.** The dashboard is intended for people working within one organization, with
account discovery and communication between its members. This is its intended deployment, not an
organization-membership check: registration does not require an invitation or verify organization
membership, and accounts are not separated into organization tenants.

- Signed-in accounts see connected people by display name and username, never by their email address:
  themselves, people linked through a project (including its other collaborators), and teammates.
  Archived projects' shares still count; revoked shares and unaccepted team invitations do not.
  The message composer and collaborator picker use this list. Exact username or email lookup returns
  a name or says no account matches; it offers no suggested matches. Typing an email can therefore
  reveal its account's username and display name. A withdrawn team invitation or a referee-refused
  editor share can leave the lookup's target without a lasting notice. Resolving a project address
  through the messaging API returns no email address. Your own email address is shown to you; the
  service operator's people page lists every account's.
- The authenticated project-discovery directory exposes project names, identifiers, slugs, owner
  usernames and display names, addresses, creation times, latest mirror activity times and archive
  markers for only projects you own or that are shared with you. That directory does not include email addresses. Its name includes
  “public,” but it still requires sign-in or an API credential.
- Ordinary project pages check for owners and active collaborators. Sharing management and project
  deletion check ownership. Cross-project intelligence pages and APIs, including Supervision and
  the Brief, require a configured operator account. Diagnostic views show your requests and eligible
  requests for projects you can access; platform-wide diagnostic counts require an operator
  account. Service administrators can access the stored data.
- Inbox and message-detail queries filter by sender or recipient, with additional project-key
  checks for project-scoped API access. These interface-level checks are not a guarantee of
  isolation between mutually untrusted organizations.

**Invitations and messages.** A new message reaches an account only if that recipient has let the
sender in: either has a grant on the other's project, they share a team, the recipient has written
the sender an ordinary message, or the recipient has turned on "Let anyone message me and share
projects with me". Turning this setting on lets anyone message you and share projects with you;
it starts off. A recipient's pending project invitation also lets its invitee message them, but
does not let the invitee share a project back. Co-members of a third person's project do not count,
nor do notices or anything the sender sent the recipient. An unreachable address gets the same
404 response as a missing address, including when the unreachable project is archived. Responses,
service notices and same-account messages still go through.

A share from someone the recipient has not let in waits for acceptance on their home page.
An owner can instead make an invite link on the project's Access page, choosing a role and an
expiry of 1, 7 or 30 days. Whoever opens the link, signs in and chooses Join gets that role; it does not
readmit someone the owner removed. The service stores the token's SHA-256 hash, not the token.

**Where it runs.** Since 2026-10-24, the hosted service uses a Render web service and a Render
PostgreSQL 17 database, both in Virginia, with Cloudflare in front of the website. Hosting providers
receive connection information under their own policies.

**How long it is kept.**

- The database uploaded at registration remains until replaced or removed. Uploads that only
  refresh the mirror are deleted at the end of their request; an interrupted request can leave a
  file behind.
- Device sign-in codes expire after ten minutes. A later device sign-in request attempts to remove
  expired requests; deletion failures or no later request can leave them stored longer. Requests
  approved by an account are also removed when that account is deleted.
- Copied records, synced events, sync and activity logs and messages have no automatic expiry.
- A signals report is replaced by the next readable report and removed with its project or account.
- Project-deletion tombstones remain until their slug is deliberately taken again or the owning
  account is deleted. Deleting a project leaves its messages, with their project links removed.
- Render keeps seven days of database point-in-time recovery and takes a snapshot of the service
  disk every 24 hours, keeping each snapshot at least seven days. Nightly offsite copies to a private
  Cloudflare R2 bucket are running, with 30-day retention: the database dump, hosted referee
  snapshots and archives, and the volume mark. R2 encrypts them at rest; the service adds no separate
  encryption layer. Deleting a live record does not remove it from an existing backup; it can remain
  there until that backup expires. These are configured retention periods, not a guarantee of
  physical media erasure.
- Render's [log policy](https://render.com/docs/logging) gives the workspace's Pro plan 14 days of log
  retention.

**How to remove it.**

- **Delete your account** in Profile, then Delete. This removes the account, its projects, mirror
  copies and keys, and messages it sent or received, including sent messages in other accounts'
  inboxes. Its activity rows, sync-request logs sent by or routed to it, signals reports and deletion
  tombstones are removed too. Recovery records are removed with their project. Uploaded files, referee copies, snapshots and archives are removed on
  a best-effort basis, as are recovery contributions and retained lost-store artifacts. Your edits and activity relayed into other owners' projects remain there.
- **Delete a project** to remove its registration, mirror, attributed activity and sync-request logs,
  shares, keys and signals report, and attempt to remove its uploaded and referee files. No purge or
  sign-out is needed first. The [deletion details](#sharing-through-reasonbookai) explain its
  tombstones, `401`/`410` responses and the copies deletion cannot retract.
- **`rbook_db(action="purge", confirm=true, expectedSlug="<slug>")`** removes the project's mirror
  and its mirror sync log. It leaves the uploaded database, messages, and activity and diagnostic
  logs, and it is refused while a project is shared through reasonbook.ai, so the owner moves such a
  project back first. It does not take the record off the project's pages: they read the uploaded
  database instead until the project is deleted. Set `RBOOK_CHECKPOINT_SYNC=off` to stop automatic
  uploads and manual backfill: a later upload rebuilds the mirror.
- **`rbook_auth(action="logout")`** revokes your account's key and removes it locally. Project keys
  remain valid until you revoke each with `rbook_auth(action="revoke", keyId="<id>")`, which is sent
  with your account's key: revoke them before you sign out. Environment credentials can still enable
  dashboard access and uploads after logout. Manual backfill also requires a user-scoped key or
  environment credentials and is refused by `RBOOK_CHECKPOINT_SYNC=off`; [Trust](trust.md) explains
  the controls.

## Contact

Questions and requests go to the
[Reasonbook issue tracker](https://github.com/kneelinghorse/reasonbook/issues). For a request you
would rather not post publicly, open a short issue asking for a private channel, as
[SECURITY.md](../SECURITY.md#reporting-a-vulnerability) describes.

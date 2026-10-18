# Privacy

Reasonbook keeps a local project record, can share copies with members, and offers an optional hosted
dashboard. This page describes what each part collects, why it keeps it, who can see it and how to
remove it. It covers Reasonbook's
server and plugins; your AI client's and model provider's own policies apply to the prompts, tool
results and files they receive. [Trust](trust.md) explains the local hooks and network controls in
more detail.

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
requested project information to your AI client. The local usage log is never uploaded.

**What it is used for.** To give your agents the project's record and keep the hooks working.

**How long it is kept.** Until you delete it, with these exceptions:

- The usage log keeps its three newest months.
- A session's Git note is deleted when the session-end hook completes; otherwise it remains until
  you delete it.
- Your message after a draft is deleted at session end or expires after two hours.
- An interrupted upload can leave a copy of the record in your temp folder. The next upload
  removes your copies older than a day, except on Windows, where you remove them yourself.

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
the holder must delete that copy. Re-inviting the member resumes exchange, including quarantined
changes.

The measured support scope is two accounts operated by one person, on two machines in an
owner/member star over SSH. A second person's collaboration and privacy experience remain
unvalidated. See the [sharing steps](getting-started.md#share-a-projects-record) and
[trust boundary](trust.md#shared-copies).

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
- sync-request logs, including contents of rejected unauthenticated requests, and activity and
  diagnostic logs;
- messages between accounts and projects: sender, recipient, type, summary, body, links, status,
  response, and sent, read and response times;
- a sign-in cookie that lasts seven days.

A device sign-in request also records its IP address and user agent, whether or not you have an
account. Reasonbook's user agent includes your computer's name. Sign-in rate limits temporarily
keep IP addresses in memory.

**What it is used for.** To display and sync project records, support collaboration and deliver
messages. The dashboard does not connect to or read your email inbox; the email address is an
account and contact identifier. Its application code has no advertising or third-party behavioral
tracking integration. The service operator and hosting providers can access the data needed to run
the service.

**Who else can see it.** The dashboard is intended for people working within one organization, with
account discovery and communication between its members. This is its intended deployment, not an
organization-membership check: registration does not require an invitation or verify organization
membership, and accounts are not separated into organization tenants.

- Signed-in accounts can see other registered users' email addresses and display names in the
  message composer. Project owners also see them when choosing collaborators. Resolving a project
  address through the messaging API returns its owner's email address.
- The authenticated project-discovery directory exposes project names, identifiers, slugs, owner
  usernames and display names, addresses, creation times, latest mirror activity times and archive
  markers across accounts. That directory does not include email addresses. Its name includes
  “public,” but it still requires sign-in or an API credential.
- Ordinary project pages check for owners and active collaborators. Sharing management and project
  deletion check ownership. Configured operator accounts can use cross-project intelligence, but
  known authorization limitations can grant that access more broadly than intended. Diagnostic
  views can expose sync-request contents across accounts. Service administrators can access the
  stored data.
- Inbox and message-detail queries filter by sender or recipient, with additional project-key
  checks for project-scoped API access. These interface-level checks are not a guarantee of
  isolation between mutually untrusted organizations.

**Where it runs.** The hosted service uses Railway for hosting and its database, with Cloudflare in
front of the website. Hosting providers receive connection information under their own policies.

**How long it is kept.**

- The database uploaded at registration remains until replaced or removed. Uploads that only
  refresh the mirror are deleted at the end of their request; an interrupted request can leave a
  file behind.
- Device sign-in codes expire after ten minutes. A later device sign-in request attempts to remove
  expired requests; deletion failures or no later request can leave them stored longer. Requests
  approved by an account are also removed when that account is deleted.
- Copied records, synced events, sync and activity logs and messages have no automatic expiry.
- Database backups are scheduled monthly with 89-day retention. Deleting a live record does not
  remove it from an existing backup; it can remain there until that backup expires. This describes
  the configured backup retention, not a guarantee of physical media erasure.
- Railway's [log policy](https://docs.railway.com/observability/logs) gives the service's Pro plan a
  30-day log-access window. Older logs can become available after a plan upgrade, so this is not a
  promise that the underlying logs are deleted after 30 days.

**How to remove it.**

- **Delete your account** in Profile, then Delete. This removes the account, its projects, mirror
  copies and keys, and messages it sent or received, including sent messages in other accounts'
  inboxes. Uploaded database files are also removed on a best-effort basis. Activity and sync logs
  are kept with their account link removed; their project names, request contents and identifiers
  can remain. Your edits in projects shared with you remain in those projects.
- **Purge before deleting a project.** Project deletion removes its registration and attempts to
  remove its uploaded database, but does not remove its mirror copy. Purge can no longer reach the
  copy after registration is deleted.
- **`rbook_db(action="purge", confirm=true, expectedSlug="<slug>")`** removes the project's mirror
  and its mirror sync log. It leaves the uploaded database, messages, activity and diagnostic logs.
  Stop uploads or sign out first: a later upload rebuilds the mirror.
- **`rbook_auth(action="logout")`** revokes your account's key and removes it locally. Project keys
  remain valid until you revoke each with `rbook_auth(action="revoke", keyId="<id>")`. Environment
  credentials can still enable dashboard access after logout; [Trust](trust.md) explains the controls.

## Contact

Questions and requests go to the
[Reasonbook issue tracker](https://github.com/kneelinghorse/reasonbook/issues). For a request you
would rather not post publicly, open a short issue asking for a private channel, as
[SECURITY.md](../SECURITY.md#reporting-a-vulnerability) describes.

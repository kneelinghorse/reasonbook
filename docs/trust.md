# Trust: what Reasonbook does on your machine

Reasonbook, formerly CMOS, keeps your project's record in a SQLite file inside your project, `rbook/db/rbook.sqlite`, and
runs as a local MCP server over stdin and stdout. It opens no listening port. The dashboard is
optional: without a dashboard credential, ordinary local work never contacts it.

These disclosures come from the code, [SECURITY.md](../SECURITY.md), and recorded tests of the
shared-record workflow and how Codex starts a plugin's server.

[Privacy](privacy.md) covers collection, dashboard account visibility, retention and removal.
Existing installations may still use older record and configuration locations until migrated;
the [upgrade guide](migrating-from-cmos.md) explains how those locations are selected and moved.
The paths below describe a new installation. Removing only those paths does not remove data that
remains in an older location.

## What leaves your machine, and when

| What                                           | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | How to stop or control it                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Reasonbook package, from your npm registry | The plugin's first launch installs its exact Reasonbook version and dependencies with `npm install`: into the plugin's data folder in Claude Code, or into `~/.config/rbook/plugins` in Codex, which both Codex plugins share. Until that install is ready, a command run through the plugin in Claude Code fetches the same version through `npx`. The one dependency with an install script, SQLite's `better-sqlite3`, downloads a prebuilt build from its GitHub releases, or Node's headers from nodejs.org when it has to build one | Install the exact version yourself: in Claude Code the plugin then uses that copy from your PATH instead of installing its own, while Codex always installs its own. Or set up the server without the plugin. Either way the package comes from npm                                                                                          |
| Your project's record, to the dashboard        | Only with a dashboard credential, or when you sign in. Signing in sends your computer's name in its request. With a credential: a snapshot of the whole `rbook.sqlite` file after writes in a registered project and at explicit session or sprint closes; a key recovered at startup; and the dashboard calls you make, including message summaries in review and onboard                                                                                                                                                                | `RBOOK_CHECKPOINT_SYNC=off` stops automatic snapshot uploads where it reaches the server. It does not stop requested dashboard calls or direct shared-record exchanges. Signing out stops automatic uploads unless your environment sets a dashboard key or user and password; without a credential nothing is sent to the dashboard         |
| Your shared record, to its members             | The initial full store copy, then changes over SSH or bundles carried by hand. Copies with saved routes also exchange at session start and end where hooks run, and every five minutes while a server that opened them is running                                                                                                                                                                                                                                                                                                         | `RBOOK_SHARED_SYNC=off` in the hook and server environments stops automatic exchanges. Explicit sync and bundle commands remain available. Removal stops new exchange with that member but cannot retract data already copied                                                                                                                |
| Your shared record, to reasonbook.ai           | Only for a project you share through the dashboard, or join there. The project must be on the dashboard first: the whole-file uploads in the row above put it there, and they continue until the share hands the record over. The share sends a copy holding only the shared record, then its changes at each sync, at session start and end where hooks run, every five minutes while a server that opened it is running, and on demand                                                                                                  | `RBOOK_DASHBOARD_SHARING=off` (or `false`, `0` or `no`, in any case) refuses a new share or join through the dashboard on that machine; it stops no sync. `RBOOK_SHARED_SYNC=off` stops the automatic syncs; explicit syncs still run. Removal on the dashboard stops new exchange with that member but cannot retract what their copy holds |
| The embedding model, from Hugging Face         | Only if you installed the optional `@xenova/transformers` package for semantic search: the first embedding downloads `Xenova/all-MiniLM-L6-v2` (about 25 MB) once, and installing that package also downloads native libraries for its `sharp` dependency                                                                                                                                                                                                                                                                                 | Leave the optional package out (the default), or set `RBOOK_OFFLINE_EMBEDDINGS=1`                                                                                                                                                                                                                                                            |

There is no remote telemetry. Reasonbook keeps a local log of tool and hook use in
`~/.config/rbook/telemetry/`: tool names, ids, counts, error codes, which of Reasonbook's published prompt
patterns a prompt matches and the slash command it starts with, never the text of your prompts or
your record. It keeps the three newest months and is never uploaded.

## Shared copies

Sharing is supported in the measured setup: two accounts operated by one person, on two machines,
either in an owner/member star over SSH or through reasonbook.ai. A second person's collaboration and
privacy experience remain unvalidated. The [getting-started guide](getting-started.md#share-a-projects-record)
gives the steps for both.

A member receives a full copy of the SQLite store, including its history and any pending, declined
or expired proposals already stored there. Choose the project boundary before sharing: there is no
private subset of the record that an invited member's initial copy cannot read. Subsequent exchanges
carry the shared record's changes through the owner's copy.

Editors' accepted rows reach the owner's agents as local project content, without the foreign-source
fence used for content from another project. An author's name is attribution, not a guarantee that
the content is safe. Invite editors whose record content you trust.

Owner/editor roles hold among honest copies using the supported protocol over SSH or carried
bundles. They are not a security boundary against a member who controls and modifies their local
store or software. Protect SSH access and the files you carry. Removing a member stops new changes
from reaching that member and quarantines their changes beyond the removal cut; it does not erase
what their copy already holds. Re-inviting the member permits exchange again, and their
quarantined changes are judged again: those their role does not allow are refused.

Through reasonbook.ai, the dashboard holds the project's referee copy: every member's changes
count once it accepts them. It runs Reasonbook's own engine, binds each copy to its account, and
refuses whole a delivery that breaks the record's rules or, from a member's copy, names anyone but
that member as a change's author. A change may name no author, and the feed then shows the row's
author; the owner's own copies are not held to the name; and a change's account id is not compared
with the caller's account. It does not check the author fields of the rows a change writes, and it
checks a change's time only against the member's admission and a week past its own clock. So a
member who edits their own copy can put rows, and feed entries, under another member's name, and
can claim a mission, sprint or session id with a back-dated time: the earliest create keeps an id,
by its time rather than its arrival. Until reasonbook.ai runs Reasonbook 4.2.1, re-inviting a
removed member accepts their set-aside changes whole, owner-only edits included.

The owner shares and removes members on the dashboard. A copy shared through the dashboard exchanges
with it alone, never by bundle, and over SSH only to take a catch-up from the owner's copy that moved
the project back, with Reasonbook 4.2.1 on both machines; there, as for direct sharing, SSH login is
the boundary. One machine keeps one live copy of a shared project: a second copy of it in another
folder on the same machine has its writes refused, and two joined copies of one project there both
do. The dashboard's operator can read the referee
copy; [Privacy](privacy.md#sharing-through-reasonbookai) says what the dashboard keeps and for how
long.

`RBOOK_SHARED_SYNC=off` stops the exchanges Reasonbook starts itself through hooks and its five-minute
server timer. Explicit sync and bundle commands still run. `RBOOK_CHECKPOINT_SYNC=off` controls
automatic dashboard uploads separately. These settings must reach the relevant processes: the
developer plugin requests environment forwarding, while the portable chat plugin inherits its
host's environment. Configure the server yourself if its loader does not forward the setting.

## What the hooks read and add

The Claude Code plugin and the Codex developer plugin run five hooks: session start, prompt submit,
stop, pre-compact and session end. From the harness they read the session id, the event's source or
reason, the turn id, the working folder, your prompt and the agent's last reply. In Claude Code they
also read the conversation transcript, in bounded pieces, to notice content that came from outside
the conversation and to find the last reply; Codex's transcript path is discarded. Raw session ids
and transcript paths are never stored. In Claude Code they also read when the harness's process
started: with `ps` on macOS, from `/proc` on Linux.

- **Session start** adds up to 6,000 characters: a digest of the project's record, your operator
  profile, the drafts waiting for your answer and a feedback count. In Claude Code it also links the
  conversation to the project. In any Git repository it notes the current commit and which files are
  changed or untracked (names only), so session end can say what changed. In a Git repository
  without a record, it offers to start one until you decline, which runs `ambient off` there.
- **Prompt submit** may add up to 1,500 characters: previews of related past decisions, drafts
  waiting for you, and reminders. When a reply has shown you a draft, Reasonbook keeps your next message,
  whatever it says, up to 1,000 characters, outside the record for up to two hours; a decision
  recorded from the draft carries your words.
- **Stop** keeps up to three `Would record:` lines that close a reply, with up to 600 characters
  before them, as drafts. A draft is never a decision until it is recorded.
- **Pre-compact** adds nothing. After compaction, session start runs again and adds the digest
  again.
- **Session end** closes the sessions the conversation opened and notes which files Git reports
  changed, as observations, not as authorship.

Only session start and prompt submit add anything to the conversation.

The hooks keep their own state in `~/.config/rbook/runtime/`:

- session ids, only as hashes;
- the folders and repositories you worked in;
- each session's Git note (the commit and the changed file names), deleted when the session-end hook
  completes, and otherwise kept until you delete it;
- your messages after a draft, until they expire;
- which records' previews you have already been shown, with no expiry.

The conversation-focused plugin, `reasonbook-chat`, has no hooks.

## Credentials

Signing in to the dashboard stores keys in `~/.config/rbook/credentials.json`, readable only by
you (mode 0600): your account's key, and a key for each project registered with the dashboard. The
keys are not encrypted: treat the file like an SSH private key. They are sent only to the dashboard
address (`https://reasonbook.ai`, or `RBOOK_DASHBOARD_URL` if you set it).

## Dependencies

On 2026-10-11, `npm audit --omit=dev` on this repository's lockfile reported no advisories for the
dependencies the package installs. The plugin installs without a lockfile, so the versions it gets
can differ. [SECURITY.md](../SECURITY.md#dependency-posture) lists what remains in the development
tree and why.

## Turning parts off

- **The hooks in one project:** `npx --prefer-offline -y @aquex/reasonbook@4.3.0 ambient off`, run in that project,
  with the version the plugin installed if it differs. The hooks still start and log their use locally, but add
  nothing. The command also updates the Reasonbook line in that project's `AGENTS.md`. `ambient on` turns
  them back on.
- **Automatic uploads:** `RBOOK_CHECKPOINT_SYNC=off` in the server's environment, or signing out
  (with no dashboard key, user or password set in the environment).
- **Automatic shared-record exchanges:** `RBOOK_SHARED_SYNC=off` in the hook and server environments.
  Explicit sync and bundle commands remain available.
- **Sharing and joining through reasonbook.ai:** `RBOOK_DASHBOARD_SHARING=off` (or `false`, `0` or
  `no`, in any case) where Reasonbook runs. A project already shared through the dashboard keeps
  syncing, and its owner's copy can still move it back.
- **The plugin:** uninstall it in your client. The Reasonbook server can still run on its own.

## Removing your data

- **The record:** delete the project's `rbook/` folder. Init also wrote the project's `AGENTS.md`
  and `CLAUDE.md` if they did not exist; edit or delete them as you like.
- **Other members' copies:** removing a member or deleting your local record cannot erase data
  already held on another machine. Each holder must remove their own copy.
- **An interrupted upload's copy:** an upload that stopped partway can leave a copy of the record in
  your temp folder, in a folder named `rbook-dashboard-upload-*`. The next upload removes your copies
  older than a day, except on Windows, where you delete them yourself.
- **Everything Reasonbook keeps for you on this machine:** delete `~/.config/rbook/` (credentials, the
  project registry, telemetry, hook state and your operator profile).
- **Dashboard sign-in:** `rbook_auth(action="logout")` revokes your account's key on the dashboard
  and removes it from this machine. Project keys stay valid, and stay in `credentials.json`, until
  you revoke each with `rbook_auth(action="revoke", keyId="<id>")`. A revoke is sent with your
  account's key, so revoke them before you sign out.
- **The dashboard's mirror of a project:** `rbook_db(action="purge", confirm=true, expectedSlug="<slug>")`
  deletes the mirror the dashboard's pages read and its sync log. The uploaded database, the
  messages, and the activity and diagnostic logs remain, and the next upload rebuilds the mirror
  unless uploads are off. For a project not shared through the dashboard, the pages read the
  uploaded database meanwhile, so purge does not take the record off them; deleting the project
  does. While a project is shared through the dashboard, every copy refuses the purge, the owner's
  included: the owner moves the project back first (`reasonbook move --to owner`), then purges.

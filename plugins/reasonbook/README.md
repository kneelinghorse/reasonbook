# Reasonbook plugin

Reasonbook is the record your agents keep for a project: what was decided and why, what was learned, and
what is still open. The next conversation, in Claude Code or in Codex, picks up from that record
instead of starting over. The record is a SQLite file inside your project, `rbook/db/rbook.sqlite`. The
agent records its own routine choices directly; a choice that is yours, it drafts with
`Would record:` and records only once you approve.

## Install

In Claude Code:

```sh
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook@reasonbook
```

In Codex, `codex plugin marketplace add kneelinghorse/reasonbook`, then `codex plugin add reasonbook@reasonbook`.
Start a new session once it is installed.

In Claude Code, uninstall `cmos@cmos` before refreshing its marketplace, then install
`reasonbook@reasonbook`. Use `claude plugin uninstall cmos@cmos --scope user`, replacing
`user` with the original `project` or `local` scope; for a local installation, run it from
that project. If refresh already happened and uninstall says “not found”, follow the
[migration guide](https://github.com/kneelinghorse/reasonbook/blob/main/docs/migrating-from-cmos.md#recover-an-already-refreshed-claude-marketplace).
Upgrade every client before moving a record.

In Codex, remove a plugin installed under its former name first, because both plugins answer as the
same server: `codex plugin remove cmos@cmos`, and `codex plugin remove cmos-chat@cmos` for the chat
plugin.

## Where it works

- **Claude Code.**
- **Codex,** through this same plugin, or the conversation-focused `reasonbook-chat` plugin; the
  repository's README covers both.
- **Not claude.ai chat:** Reasonbook needs its local server, which chat does not run. Without it, the
  skills stop and say so.

It needs Node.js 20 or newer on your machine.

## What it runs, sends and fetches

- **A local MCP server.** The plugin starts the Reasonbook server on your machine over stdin and stdout.
  It opens no network port.
- **One install from npm.** On first launch the plugin installs its exact Reasonbook version from your npm
  registry: into the plugin's data folder in Claude Code, or into `~/.config/rbook/plugins` in
  Codex (with legacy config fallback for existing installations). npm also runs SQLite's install script, which downloads a prebuilt build from its GitHub
  releases, or Node's headers from nodejs.org to build one. Until the install finishes, Claude Code
  runs the same version through `npx`, and Codex says it is installing. Start a new session once
  installation finishes to load the record and, in Codex, the tools.
- **Your record stays local by default.** Reasonbook sends your record nowhere unless you sign in to the
  optional dashboard. Then, once a close has registered the project, it uploads a snapshot of the
  project's database after writes and at closes. `RBOOK_CHECKPOINT_SYNC=off` stops those uploads
  when supplied to the server. The developer plugin requests forwarding of this setting;
  the portable chat plugin uses the environment inherited from its host. Forwarding through
  every client loader is unverified. There is no remote telemetry.

[Trust](https://github.com/kneelinghorse/reasonbook/blob/main/docs/trust.md) has the full list and how
to turn each part off. [Privacy](https://github.com/kneelinghorse/reasonbook/blob/main/docs/privacy.md)
explains collection, dashboard account visibility, retention and removal.

## The five hooks

| Hook          | What it does                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session start | Adds a digest of the project's record, your operator profile and the drafts waiting for you; in a Git repository, notes the commit and the changed file names for session end |
| Prompt submit | May add previews of related past decisions and drafts waiting for you; after a reply shows you a draft, keeps your next message for up to two hours                           |
| Stop          | Keeps up to three closing `Would record:` lines as drafts for you to approve                                                                                                  |
| Pre-compact   | Adds nothing; the next session start adds the digest again                                                                                                                    |
| Session end   | Closes the sessions the conversation opened                                                                                                                                   |

To turn the hooks off in one project, run `npx --prefer-offline -y @aquex/reasonbook@4.2.1 ambient off` in that
project, with the version this plugin installed; `ambient on` turns them back on. To turn everything
off, disable or uninstall the plugin.

## Try it

Open a project folder and ask:

1. "Start a Reasonbook record for this project." The agent asks how much structure you want and starts at
   that level; a Ledger keeps decisions and lessons.
2. "Record that we use PostgreSQL rather than SQLite for the API, because we need row-level
   security." The decision and its reason go into the record.
3. "Why did we choose PostgreSQL?" In this or any later session, the agent answers from the record.

## Support

Report problems and ask questions in the
[issue tracker](https://github.com/kneelinghorse/reasonbook/issues). Report security issues as
[SECURITY.md](https://github.com/kneelinghorse/reasonbook/blob/main/SECURITY.md#reporting-a-vulnerability)
describes.

Apache-2.0.

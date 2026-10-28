# Reasonbook — local directory edition

Keep the decisions, reasons, lessons and next steps you ask to record for a project. Reasonbook
uses a local SQLite store, `rbook/db/rbook.sqlite`, and retrieves that record when you ask. This
edition has no hooks. Its skills record a choice when you request it or approve the proposed choice;
they do not quote the conversation into the record.

## Install and use

This plugin needs Node.js 20 or newer and a client that runs local MCP servers. In Claude Code:

```sh
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook-chat@reasonbook
```

In Codex, add the same marketplace with `codex plugin marketplace add kneelinghorse/reasonbook`,
then `codex plugin add reasonbook-chat@reasonbook`. Start a new session after installation finishes.
Enable one Reasonbook edition in a conversation, so the client has one project-record server.
Ordinary claude.ai chat cannot run this local server. Cowork has not been tested. Manual Claude Code
and Codex installation is separate from directory acceptance; no public-directory approval is claimed.

Try these requests:

- “Start a Reasonbook record for this project.”
- “Record our choice to use SQLite because this reading log must work offline.”
- “Why did we choose SQLite, and what comes next?”

[Review it locally](https://github.com/kneelinghorse/reasonbook/blob/main/docs/reviewer/README.md)
provides fictional data, reset instructions and five positive and three negative cases.

## What it runs, reads, writes and sends

- The plugin starts a local MCP server over stdin/stdout; it opens no listening port. Both the
  installing and ready launch use the directory mode of the same versioned Reasonbook npm package.
- First launch installs the exact version from your npm registry into Reasonbook's shared install
  folder under `~/.config/rbook/plugins` (or your configured Reasonbook folder). npm downloads
  dependencies; SQLite's install script can download a native binary from GitHub, or Node headers
  from nodejs.org to compile one. npm can use your configured registry authentication for this
  installation. Restart the client session if it still reports that installation is in progress.
- After installation, the Reasonbook server makes no network requests: no dashboard, sign-in,
  messages, SSH, shared-record exchange or checkpoint uploads, even if a full installation left
  credentials on this machine. Semantic models and tokenizer downloads are disabled; search is
  keyword-only and token counts use a local estimate. Your AI client still sends prompts and tool
  results to its model provider under its own policy.
- Calls read and write the selected project's Reasonbook record, including user-requested decisions,
  lessons, sessions, context, missions, sprints and next steps. Local health, snapshots, restore and
  snapshot pruning remain available. A restored or existing store can contain records created by
  the full edition; this mode does not erase those records or rewrite their history. Shared stores
  show local conflict and unapplied-change counts with a full-plugin remedy, without peer status.
- Reasonbook's configuration folder holds its registry, install state, author setting and local
  runtime/usage files. Project selection can inspect registered paths and identity/address metadata;
  it does not aggregate their decisions, missions, drafts or attention counts. Explicitly choose
  another project to read its record. The selected project's constraints are returned as record data.
- The local MCP usage log stores timestamps, restricted tool/client/session tokens, outcomes and
  capped record identifiers, without argument or result prose. It retains the three newest monthly
  files and is never uploaded. Imported legacy `telemetry_events` rows in a project store can hold
  arbitrary historical JSON; they are not the current usage log.
- This edition never reads Claude transcripts/history, the approval runtime or operator profile,
  and never reads or writes `CLAUDE.md`, `AGENTS.md` or `.claude`. Init creates only the store and
  its database directory, plus the normal Reasonbook registry/configuration state. It does not load
  a project `.env`, project tier guides or dashboard credentials, capture drafts, bind `fromDraft`,
  store approval quotations or install memory rules. Onboarding omits autonomous capture guidance;
  MCP prompts expose the same six directory skills shipped in this plugin.

The store and its backups remain until you remove them. Deleting a row or pruning snapshot content
is not guaranteed physical erasure from SQLite free pages or existing copies. Disable/uninstall the
plugin to stop it; remove only your intended project's store and backups to remove its local record.
Shared configuration may serve other projects and the full plugin: do not delete it indiscriminately.
See [Privacy](https://github.com/kneelinghorse/reasonbook/blob/main/docs/privacy.md) and
[Trust](https://github.com/kneelinghorse/reasonbook/blob/main/docs/trust.md) for retention and removal.

## The full plugin

The full `reasonbook` plugin adds session hooks, draft approval binding, the operator profile,
semantic search when its optional dependency is installed, sharing, the dashboard and messages.
Install `reasonbook@reasonbook` from the same marketplace and select it instead when you need those
features. [Its README](https://github.com/kneelinghorse/reasonbook/blob/main/plugins/reasonbook/README.md)
discloses its transcript reads and optional transfers. Both editions use one npm package and version.

Support: [issues](https://github.com/kneelinghorse/reasonbook/issues). Security:
[report privately](https://github.com/kneelinghorse/reasonbook/blob/main/SECURITY.md#reporting-a-vulnerability).
Licensed under [Apache-2.0](https://github.com/kneelinghorse/reasonbook/blob/main/LICENSE).

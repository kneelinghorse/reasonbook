# Your first ten minutes with Reasonbook

Start a small local record, save one real choice and ask for its reason in a new session.
You need Node.js 20 or newer and Claude Code or Codex. No dashboard account is required.
Installation time depends on your connection and whether npm has cached the package.

Choose one installation path. If you already use the plugin, go straight to
[Record a choice](#record-a-choice).

## Plugin path

For Claude Code, run:

```sh
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook@reasonbook
```

For Codex, run:

```sh
codex plugin marketplace add kneelinghorse/reasonbook
codex plugin add reasonbook@reasonbook
```

Open your project in a new session. A first cold session may say Reasonbook is installing;
start another after it finishes. In the Codex CLI, review the five developer hooks with
`/hooks`. If the desktop app does not expose that review, use its bundled CLI with the same
Codex home, then restart the app. The [harness guide](harnesses.md#codex) covers this setup.

Ask the agent:

> Start a Reasonbook Ledger in this project. Keep it local.

A Ledger keeps decisions and lessons. You can add planning or build structure later.
If you have a plugin under the former CMOS name, follow the
[migration guide](migrating-from-cmos.md) before installing its replacement.

## npm path

Install the CLI and initialize the project folder you want to track:

```sh
npm install -g @aquex/reasonbook@4.6.1
cd /absolute/path/to/your/project
reasonbook init --level ledger
reasonbook review --format=context
```

Replace the path with your project's folder. Ensure npm's global bin directory is on your
PATH. If the former package is installed globally, first run
`npm uninstall -g @aquex/cmos-mcp`. A new Ledger's digest names the project and starts empty.

The CLI can initialize and read the record; an agent uses the MCP tools to record choices.
For Claude Code, register the installed server from the project folder:

```sh
claude mcp add-json rbook '{"command":"reasonbook","args":[]}'
claude mcp list
```

Start a new Claude Code session in that folder. For another client, use its configuration
in [Getting started](getting-started.md#2-wire-it-into-your-mcp-client), or use the Codex
plugin path above. Keep one answering Reasonbook server; a plugin already supplies it.

## Record a choice

Tell the agent one choice you have actually made and its reason. For example, if this is your
decision:

> Record that we will review the project every Friday because a weekly check is enough to keep its next steps useful.

The agent records the choice you authorized and returns its record id. For a choice you have
not made, it can offer a `Would record:` draft; answer before it becomes a decision.

Now open a fresh session in the same project and ask:

> Why did we choose a weekly review? Read the Reasonbook record.

The answer should cite the saved decision and its reason. This is the first useful check:
the new conversation can retrieve the choice without you explaining it again. If the agent
says Reasonbook is still installing or has no project tools, finish the installation and
start another session before continuing.

## Keep the record with the project

Commit the generated `AGENTS.md`, `CLAUDE.md`, `rbook/.gitignore` and your project documents.
Keep `rbook/db/rbook.sqlite`, its WAL/SHM files and snapshots out of Git. Init creates the
ignore file when missing and preserves one that already exists; check existing rules before
adding files. Share records through Reasonbook's sharing commands when you need another copy.

A plugin's private runtime does not put `reasonbook` on your terminal PATH. To read the digest
without a global install, run this from the project folder:

```sh
npx --prefer-offline -y @aquex/reasonbook@4.6.1 review --format=context
```

[Trust](trust.md) explains local files, hooks and network activity.
[Privacy](privacy.md) explains optional dashboard uploads, visibility and deletion.

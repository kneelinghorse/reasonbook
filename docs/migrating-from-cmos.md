# Migrating from CMOS to Reasonbook 4

Reasonbook 4 changes the installed commands and tool names. It can still read an existing
CMOS record in place. Upgrade your clients first; move files only when you are ready.

| Surface               | Previous name         | Reasonbook 4                 |
| --------------------- | --------------------- | ---------------------------- |
| npm package           | `@aquex/cmos-mcp`     | `@aquex/reasonbook`          |
| CLI                   | `cmos-mcp`            | `reasonbook`                 |
| MCP tools             | `cmos_*`              | `rbook_*`                    |
| Project database      | `cmos/db/cmos.sqlite` | `rbook/db/rbook.sqlite`      |
| Default shared config | `~/.config/cmos-mcp`  | `~/.config/rbook`            |
| Environment settings  | `CMOS_*`              | `RBOOK_*`                    |
| Project addresses     | `cmos://…`            | `rbook://…`                  |
| Developer plugin      | `cmos@cmos`           | `reasonbook@reasonbook`      |
| Codex chat plugin     | `cmos-chat@cmos`      | `reasonbook-chat@reasonbook` |

The old CLI and MCP tool names are not aliases in version 4. Update saved tool
permissions, prompts, scripts and manual MCP configurations. Use `rbook` as the server
entry name, and reconnect the client so it discovers the new tool names.

Existing `cmos/` records remain readable when no `rbook/` folder exists. Shared config
resolution retains the existing legacy registry; if both locations contain a registry,
Reasonbook warns and chooses `~/.config/rbook`. `RBOOK_*` settings take precedence over
matching `CMOS_*` settings, including an explicitly empty value. Old `cmos://` addresses
remain accepted. Reading an old record does not move it or rewrite its history.

## Upgrade installations first

Requires Node.js 20 or newer. Replace a globally installed old package if present:

```sh
npm uninstall -g @aquex/cmos-mcp
npm install -g @aquex/reasonbook@4.8.0
reasonbook --version
```

Without a global installation, use the scoped package explicitly:

```sh
npx --prefer-offline -y @aquex/reasonbook@4.8.0 --version
```

Update every manual MCP package pin to `@aquex/reasonbook@4.8.0`. A server that runs
local `dist/` files needs a 4.x build too. See [client configuration](getting-started.md)
and [harness setup](harnesses.md).

For **Claude Code**, uninstall the old plugin **before refreshing its marketplace**.
Use the scope where it was installed: `user`, `project` or `local`. For a user installation:

```sh
claude plugin uninstall cmos@cmos --scope user
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook@reasonbook --scope user
```

Only run the uninstall for an installed old plugin. Replace `user` with the correct
scope; remove old installations from every scope in which they remain enabled. Keeping
`cmos@cmos` and updating it is not the 4.x upgrade path.

For **Codex**, remove each old plugin you have installed, then add its replacement:

```sh
codex plugin remove cmos@cmos
codex plugin marketplace add kneelinghorse/reasonbook
codex plugin add reasonbook@reasonbook
```

For the chat plugin, remove `cmos-chat@cmos` and add `reasonbook-chat@reasonbook` instead.
Review changed hook definitions through your client's normal trust workflow. Remove
duplicate manual server or hook registrations, preserving unrelated entries. Start a new
session and verify that the client exposes `rbook_*` tools before planning a move.

## Recover an already-refreshed Claude marketplace

Claude Code 2.0.76 can report `cmos@cmos` as “not found” after the marketplace refreshes,
even though its installed record remains. Temporarily restore the old marketplace so
Claude can uninstall that record, then install the new plugin. This sequence was checked
at user and local scopes; the pinned public 3.5.0 marketplace remains available.

From the affected project for a local installation, run:

```sh
claude plugin marketplace remove cmos
claude plugin marketplace add https://github.com/kneelinghorse/reasonbook.git#v3.5.0
claude plugin uninstall cmos@cmos --scope user
claude plugin marketplace remove cmos
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook@reasonbook --scope user
```

Replace `user` with the original scope. If `reasonbook` is already listed by
`claude plugin marketplace list`, skip the final marketplace add. The temporary old
marketplace is only for removing the installed old ID; do not start a session with it.
Do not edit Claude's installation registry or trust records by hand.

## Preview the project changes

The command is a dry run unless you add `--apply`. Run it from the project root, or
select a root explicitly; `--project-root` is an alias for `--project`.

```sh
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --project /absolute/path/to/project
```

The JSON result lists proposed changes and text left for review. A successful preview
does not establish that the database will be safe to move when you apply it.

To update instructions while keeping the database where it is:

```sh
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --docs-only --project /absolute/path/to/project
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --docs-only --apply --project /absolute/path/to/project
```

This covers root `AGENTS.md`/`agents.md`, `CLAUDE.md`, `.mcp.json`, and the record's
`README.md` and tier guides. It updates identifiers, refreshes unchanged generated
lines, hook-less blocks and seed guides, and preserves paths to folders that have not
moved. Hand-edited owned lines or blocks are left for review with a proposed replacement.
Ordinary prose is not broadly renamed. A package explicitly pinned below version 4 is
refused; update that pin first.

## Move the project record offline

Update your own source code, scripts and other configuration that refer to `cmos/`;
those files are outside the document migration's scope. Then stop every process using
the record: MCP servers, CLI jobs, plugin installers and database viewers, including
idle Reasonbook 4.x servers. Run the migration from a separate terminal.

```sh
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --apply --project /absolute/path/to/project
```

The command refuses configured legacy clients, detected live runtimes, open file handles
and unavailable process or handle inspection. It does not stop processes for you. Custom
programs that access the record must also be stopped; detection is not a substitute for
that offline requirement. Both record folders already existing, or a symlinked record
or symlinked/hardlinked database, also cause a refusal.

Before renaming, it checkpoints and closes the database, creates
`db/snapshots/pre-migrate-<uuid>.sqlite`, and adds ignore rules for the database, WAL/SHM
files and that backup. A successful move changes `cmos/` to `rbook/` and the database
filename to `rbook.sqlite`. It then updates the covered documents and existing local
registration. Project identity and historical rows stay intact. Review the reported
files and remaining text before committing your changes.

## Move shared config separately

The project command does not move credentials, profile or registry configuration. You can keep using the selected legacy config, so this step can wait until every client
using it has been upgraded. Stop all relevant runtimes and installers first. Unset `RBOOK_CONFIG_DIR` and
`CMOS_CONFIG_DIR`; this command moves only the default shared folder.

```sh
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --config
npx --prefer-offline -y @aquex/reasonbook@4.8.0 migrate --config --apply
```

It moves `~/.config/cmos-mcp` to `~/.config/rbook`, preserving filenames and creating
backups of the config databases. It refuses two existing config folders or an installed
legacy client that still needs the old location. Do not combine `--config` with
`--project` or `--docs-only`.

## Refusals and interrupted work

Read the reported paths and reason. Close the named process, update the remaining old
client, or resolve the reported path conflict before retrying the same `--apply` command.
Do not delete migration guards or journals to force a move. If a process crashes during
cutover, a later apply checks that the previous owner is gone and recovers the interrupted
move. Recovery refuses to overwrite an unexpected file or directory.

A failure after the project move can leave the new store intact with
`.rbook-migration-pending.json`. Restore the missing precondition and rerun the project
apply command to finish its recorded follow-ups; the database is not moved again.

For a linked dashboard project, the follow-up verifies the stored dashboard ID, slug
and ownership, then updates that existing project's local database path. It does not
create another project or upload the database. Unavailable credentials, an unverified
incumbent or a rejected path update leaves a pending retry. Config recovery similarly
uses `migrate --config --apply`; its recovery files are under `~/.config`.

# Reasonbook — decisions that survive the session

[![npm version](https://img.shields.io/npm/v/@aquex/reasonbook)](https://www.npmjs.com/package/@aquex/reasonbook)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)

Reasonbook, formerly CMOS, is the project record your agents keep: what was decided, why, what was learned,
and what remains. The next session can pick up from that record, even in another tool.
You make the decisions; agents handle the bookkeeping. No dashboard account is required.

[See it work](https://github.com/kneelinghorse/reasonbook/blob/main/docs/demo/README.md) in a 75-second replay of recorded runs in Claude Code and
Codex, and read [what it sends and stores](docs/trust.md).

## Install it in Claude Code

Install the plugin once for all your projects:

```sh
claude plugin marketplace add kneelinghorse/reasonbook
claude plugin install reasonbook@reasonbook
```

Upgrading from `cmos@cmos`? Uninstall it before refreshing the marketplace, using
`claude plugin uninstall cmos@cmos --scope user` (or its original `project` or `local` scope),
then install `reasonbook@reasonbook`. For a local installation, run the command from that
project. If the marketplace already refreshed and uninstall says “not found”, use the
[tested recovery steps](docs/migrating-from-cmos.md#recover-an-already-refreshed-claude-marketplace).
Upgrade every client before moving an existing record.

For candidate testing, replace `kneelinghorse/reasonbook` with this checkout's absolute
path. Start a new Claude Code session after installation. The plugin supplies the
MCP server, hooks and commands; its first cold session may report that Reasonbook is
installing and load the record from the next session. Use `/reasonbook:init` for a new
record, `/reasonbook:start` to read it, `/reasonbook:close-out` to finish work, `/reasonbook:plan` to plan,
and `/reasonbook:build` to execute. [Plugin installation](https://code.claude.com/docs/en/discover-plugins).
Other tools use the [harness adapters and coverage guide](docs/harnesses.md).

## Get a project digest in three steps

Requires Node.js 20 or newer.

1. Install the pinned CLI:

   ```sh
   npm install -g @aquex/reasonbook@4.2.0
   ```

   Ensure the global npm bin directory is on your PATH. If the former package is installed globally, run `npm uninstall -g @aquex/cmos-mcp` first. Version 4 provides only the `reasonbook` command; update scripts and MCP configurations that use the old command.

2. In the project folder you want to track, start a Ledger:

   ```sh
   cd /absolute/path/to/your/project
   reasonbook init --level ledger
   ```

3. Read its first digest:

   ```sh
   reasonbook review --format=context
   ```

The digest names this project and shows its decisions, lessons and open work. A new
Ledger starts empty. Planner adds next steps; Builder adds sprints and missions.

## Codex plugins — 4.1.0

The developer plugin `reasonbook` supplies the server, seven skills and five lifecycle hooks.
The conversation-focused `reasonbook-chat` supplies the same server and six distinct chat skills,
with no hooks. Plugin loading, installation and project calls are verified in the bundled
Codex CLI and app-server. **ChatGPT Work remains unverified**; this is not a hosted plugin
for ChatGPT web or phone.

Install the developer plugin:

```sh
codex plugin marketplace add kneelinghorse/reasonbook
codex plugin add reasonbook@reasonbook
```

If the plugin is installed under its former name, remove it first, because both plugins answer as the
same server: `codex plugin remove cmos@cmos`, and `codex plugin remove cmos-chat@cmos` for the chat
plugin.

For chat workflows, install `reasonbook-chat@reasonbook` instead:

```sh
codex plugin add reasonbook-chat@reasonbook
```

For local development, replace the marketplace repository with this checkout's absolute path.
Both plugins can be enabled together: Codex loads one server named `rbook`, and both sets of
skills remain visible. Choose the developer plugin for building; choose the chat plugin for
setup, catch-up, recall, proposing decisions, capturing notes and discussing next steps.

Node.js 20 or newer is required. The plugins install their exact Reasonbook version into
`~/.config/rbook/plugins`, with [legacy config fallback](docs/migrating-from-cmos.md) for existing
installations. On a first install, Reasonbook connects with an installing message; start a new
session when installation finishes to load the project tools. The developer hooks share that runtime.
The developer plugin requests forwarding of supported settings, including `RBOOK_CONFIG_DIR`;
the portable chat plugin uses the environment inherited from its host. Use an **absolute** path,
because empty or relative shared roots are refused. Environment forwarding depends on the
client's plugin loader. If your loader does not forward a setting,
use the default root or configure a manual server. See [the harness guide](docs/harnesses.md#codex).

In the Codex CLI, run `/hooks` and review the five developer-plugin commands once. If the desktop
app does not expose that review, use its bundled Codex CLI with the same Codex home. Restart the
app after installation if it has not loaded the plugin. A changed hook definition needs review
again. The chat plugin has no hook review step.

Before replacing a CMOS 3.3.0 adapter, remove only its CMOS entries from project
`.codex/hooks.json` and any user-level `~/.codex/hooks.json`; keep unrelated hooks. Remove any
other imported CMOS hook registration too. Keep one answering MCP server: remove a duplicate
manual entry, or deliberately retain it and set `"pluginServer": "off"` in
`~/.config/cmos-mcp/config.json` (under your custom config root when using one).

Reasonbook uses the working folder supplied on each supported Codex call, so a conversation in a
project can call `rbook_review()` without naming a path. Outside that folder, choose a registered
address from `rbook_project(action="list")` and pass it as `projectRoot`, for example
`rbook_review(projectRoot="rbook://you/project")`. Unknown or ambiguous addresses refuse;
local-only projects need their folder. Tool hints conservatively include telemetry deletion,
so Codex Auto mode can still ask for approval for any Reasonbook tool.

## Propose a decision, then approve it

When a choice needs your approval, the agent ends its reply with one concrete line:

> Would record: Use a weekly review because it keeps the reading list useful without daily upkeep.

With the developer hooks enabled and linked to that conversation, the Stop hook keeps this as a
draft. Your next reply can approve it, decline it, ask a question or amend the wording. The agent
records an approved draft with its returned `P<n>` id; a draft is not yet a decision. Inspect drafts
from the project folder with:

```sh
reasonbook drafts list
```

`reasonbook-chat` asks for approval in the conversation and makes a direct record, preserving your
observed words in its context. Reasonbook cannot independently verify that approval; it does not claim
hook-verified approval for a chat-only record. An explicit approval already given for the exact
wording counts, so the agent need not ask again.

## The method

- One project, one record of decisions, lessons, constraints and next steps.
- Start from that record; supported hooks bring it into the session automatically.
- Record decisions deliberately, with reasons. Supersede a changed decision.
- Make expiry and supersession visible; closing a sprint keeps records active by default.
- Keep the record with the project so it survives a change of tools.

[The method](docs/method.md) gives the five lines in full, what Reasonbook does at each level, and
how to move up; the [starter templates](https://github.com/kneelinghorse/reasonbook/tree/main/templates) hold the files each level starts with.

## What leaves your machine

The record stays in your project's SQLite file. With a stored user-scoped key or legacy
environment credentials, explicit session and sprint closes attempt a background
upload of the **whole file**, including pending and declined proposals. For a registered project,
MCP tool writes also schedule an upload after 5 quiet minutes or 30 minutes of continuous writes;
the next poll starts it within 60 seconds when no upload lease or failure backoff blocks it.
Transfer time follows. See the timing and failure details under [Optional: hosted dashboard](#optional-hosted-dashboard).
`RBOOK_CHECKPOINT_SYNC=off` stops automatic uploads, not requested network actions or
shared-record exchanges. Implicit process-exit closes do not upload. [Full network and data disclosure](SECURITY.md#outbound-network).

## Technical reference

## What it is

Reasonbook is the protocol + client. It runs locally on your machine, owns a SQLite database under `rbook/db/rbook.sqlite`, and exposes 15 typed tools over MCP. Claude Code and Codex are verified (see the [harness guide](docs/harnesses.md)); other MCP clients, such as Claude Desktop, Cursor, Zed, VS Code and Windsurf, are untested.

Out of the box you get:

- Sprint and mission state machines with auditable transitions
- Session capture for decisions, learnings, constraints, next-steps
- Strategic context that condenses across sprints, with FTS5 retrieval
- Full-text search across decisions, learnings, missions, sessions
- Database snapshots on demand; backup attempts around sprint closes; required backups before
  a restore or a snapshot prune with selected rows
- Per-project credential store and device-code auth (RFC 8628)

The dashboard at [reasonbook.ai](https://reasonbook.ai) is **optional**. You can run Reasonbook standalone forever — sign-up unlocks dashboard uploads (SQLite → Postgres mirror), the project registry (`rbook://you/*` addresses), and cross-project messaging. Without it, every other tool still works locally.

## Install

Recommended: a global install of this release. The server then starts from disk, with no registry
lookup on launch:

```bash
npm install -g @aquex/reasonbook@4.2.0
```

If the former package is installed globally, run `npm uninstall -g @aquex/cmos-mcp` first. Version 4 provides only the `reasonbook` command; update scripts and MCP configurations that use the old command.

Or run it on demand with `npx`. Pin the version and prefer the local cache: an unpinned `npx -y`
can look the package up again on every launch.

```bash
npx --prefer-offline -y @aquex/reasonbook@4.2.0
```

Semantic (vector) search is optional. Without it, retrieval is keyword-only, and the install is
about 45 MB instead of about 306 MB. To add a vector term to retrieval, install
`@xenova/transformers` next to Reasonbook. `rbook_db(action="health")` reports whether it is on.

Requires Node.js 20 or newer.

## Configure your MCP client

Claude Code and Codex are verified; the other blocks follow each client's own MCP configuration
and are untested with Reasonbook. Each example below runs a pinned version through `npx`, preferring the local cache; to upgrade,
change the version. With the global install, use `"command": "reasonbook"` and drop the `npx`
arguments (keep `--project-root` where an example has it).

### Claude Code

```bash
claude mcp add-json rbook '{"command":"npx","args":["--prefer-offline","-y","@aquex/reasonbook@4.2.0"]}'
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "rbook": {
      "command": "npx",
      "args": [
        "--prefer-offline",
        "-y",
        "@aquex/reasonbook@4.2.0",
        "--project-root",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

Claude Desktop is expected to start servers with no project context (on macOS, from `/` with no
workspace roots; untested with Reasonbook), so name the project in the config. `--project-root` applies only to this server entry, and only to
calls with no project context: no `projectRoot`, no workspace roots, and a working directory of `/`,
your home directory or the server's install directory. A client that starts the server from any
other folder should pass `projectRoot` instead.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rbook": {
      "command": "npx",
      "args": ["--prefer-offline", "-y", "@aquex/reasonbook@4.2.0"]
    }
  }
}
```

### Zed

```json
{
  "context_servers": {
    "rbook": {
      "command": "npx",
      "args": ["--prefer-offline", "-y", "@aquex/reasonbook@4.2.0"]
    }
  }
}
```

### VS Code (Claude extension)

Use the Claude Code command above from the integrated terminal, or add the server
through `/mcp` in the Claude panel. The extension and CLI share MCP configuration;
start a new conversation after changing it. The extension does not add `claude` to
your terminal PATH, so the terminal route needs the standalone Claude CLI.
[Claude Code in VS Code](https://code.claude.com/docs/en/vs-code#connect-to-external-tools-with-mcp)

### Windsurf

```json
{
  "mcpServers": {
    "rbook": {
      "command": "npx",
      "args": ["--prefer-offline", "-y", "@aquex/reasonbook@4.2.0"]
    }
  }
}
```

## First call

Project tools work on a folder that has a Reasonbook database, so a new project starts with init:

```
rbook_project(action="init", projectRoot="/absolute/path/to/your/project")
```

`init` creates `rbook/db/rbook.sqlite`, the seed files, and an `AGENTS.md` at the project root (unless
one is already there). In a folder without that database, the tools that read or write a project
refuse and name `init`; registry and sign-in actions need no project.

Then run `rbook_agent_onboard` once: on a new project it walks the first-session setup. Open every
later session with the session digest:

```
Run rbook_review to see the project state.
```

`rbook_review` returns the shared session digest: project identity, current sprint, open work and recent decisions. Its local text core is capped at 4,000 characters; appended portfolio context and the surrounding MCP response are outside that cap.

The full walkthrough — install → config → init → first sprint/mission/session loop — lives in [docs/getting-started.md](docs/getting-started.md).

## Tool surface

Reasonbook exposes 15 consolidated tools. 12 use an `action` parameter to select the operation; `rbook_agent_onboard`, `rbook_status` and `rbook_review` take no `action`. [TOOL_REFERENCE.md](TOOL_REFERENCE.md) publishes one parameter table per action, so it says which parameters actually apply to a given call.

| Tool                       | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `rbook_review`             | Session digest: identity, current sprint, work queue, decisions               |
| `rbook_agent_onboard`      | Cold-start payload: identity, active sprint, missions, decisions, suggestions |
| `rbook_status`             | Diagnostic snapshot: rbook_address, dashboard_url, auth_tier, sync timestamps |
| `rbook_mission`            | Missions — create, update, query, and link dependencies                       |
| `rbook_mission_transition` | Mission state machine — start, complete, block, unblock, drop, defer          |
| `rbook_sprint`             | Sprints — CRUD, closeout, retro, and cross-sprint analytics                   |
| `rbook_session`            | Work sessions (optional) — start, capture insights, complete, list, search    |
| `rbook_context`            | Master/project context — view, update, condense, snapshot, and search         |
| `rbook_decisions`          | Strategic decisions — record, show, list, search, update, staleness review    |
| `rbook_learnings`          | Cross-cutting learnings — list, search, show, update, and reaffirm            |
| `rbook_db`                 | Database ops — health, snapshot/restore, sync, and a context-snapshot prune   |
| `rbook_project`            | Projects — init, register, list, validate; share, invite, join, members, sync |
| `rbook_auth`               | Dashboard credential lifecycle — device-code login, rotate, revoke            |
| `rbook_message`            | Cross-project messaging (requires the hosted dashboard)                       |
| `rbook_feedback`           | Agent-feedback channel — list, triage, resolve, archive                       |

See **[TOOL_REFERENCE.md](TOOL_REFERENCE.md)** for the exact per-action parameter reference — it is generated from the tool definitions on every build, so it never drifts from the shipped surface.

## Share a project's record

The owner can share a project with editors. Each keeps a full local copy, works locally, and
exchanges changes either through reasonbook.ai, which keeps the project's referee copy and shows it
on the dashboard, or directly through the owner's copy over SSH or with bundles carried by hand.
Conflicting field values stay visible until someone settles them.

Sharing is supported in the measured setup: two accounts operated by one person, on two machines,
either through reasonbook.ai or in an owner/member star over SSH. A second person's collaboration and
privacy experience remain unvalidated. Editors' rows become local project content for the owner's
agents, without a foreign-source fence; invite people whose record content you trust.

Through reasonbook.ai, each person signs in on their machine. The owner's agent shares the project,
the owner shares it with the editor on the dashboard, and the editor gives their agent the join
sentence from the project's page. Moving a project back off reasonbook.ai is not available yet.

Start with the [sharing steps](docs/getting-started.md#share-a-projects-record) and
[trust boundary](docs/trust.md#shared-copies). Sharing over SSH needs no dashboard account. Automatic exchanges
run at session start and end where hooks run, and every five minutes for shared projects the server
has opened with a saved route. `RBOOK_SHARED_SYNC=off` stops those automatic exchanges; explicit
sync and bundle commands remain available.

## Optional: hosted dashboard

The dashboard is a separate service. Sign up at [reasonbook.ai](https://reasonbook.ai) to unlock:

- **Dashboard mirror** — uploads a snapshot of your whole SQLite file for the dashboard to display.
- **Project registry** — addressable `rbook://you/project-name` URIs across machines.
- **Messaging** — `rbook_message(action="send")` between your own projects.
- **Sharing** — share a project's record with editors, who join from its page; the dashboard keeps
  the referee copy and shows each member's changes. See [Share a project's record](#share-a-projects-record).

To connect:

```bash
export RBOOK_DASHBOARD_URL=https://reasonbook.ai
```

Then run `rbook_auth(action="login_init")` from your agent. It returns a one-time `userCode` and `verificationUri` — paste the code at the URL in your browser, then run `rbook_auth(action="login_complete", deviceCode=...)` to finish. Credentials persist atomically to `~/.config/rbook/credentials.json` (mode 0600).

`RBOOK_DASHBOARD_URL` defaults to `https://reasonbook.ai`. Without a dashboard credential, dashboard operations return a structured `DASHBOARD_NOT_CONFIGURED` error that names `rbook_auth(action="login_init")`. Local tools and direct shared-record exchanges work without the dashboard.

With a stored user-scoped dashboard key or legacy environment credentials, explicit `rbook_session(action="complete")` and `rbook_sprint(action="complete")` calls attempt a background upload and may register the project first. For a registered project, an MCP tool call that actually writes its store also schedules an upload. It becomes due after 5 quiet minutes or 30 minutes of continuous writes, and starts within the next 60 seconds when no upload lease or failure backoff blocks it. A running server must have opened the project; work owed by a short-lived process survives for the next server. Each upload sends a consistent snapshot of the whole SQLite file, including pending, declined and expired proposals. Transfer time is additional, and concurrent servers share one upload lease per project.

Upload results and failures appear in `rbook_status` and `rbook_review`. HTTP 401, 402 or 403 pauses automatic retries until an explicit close succeeds. A failed upload does not fail the local write or close. Implicit process-exit closes do not upload. Set `RBOOK_CHECKPOINT_SYNC=off` in the server environment to disable automatic uploads; it does not disable explicit sync, messaging, sign-in, shared-record exchanges or other requested network actions. See [SECURITY.md](SECURITY.md#outbound-network).

## Project resolution

Reasonbook never acts on a project you did not name. For each tool call it picks one project, in this
order, and refuses rather than falling back when that project cannot be used:

1. The `projectRoot` parameter on the call: a project folder or an exact registered
   `rbook://owner/project` address. Address discovery reads stored identities without repairing
   them; no match, duplicate matches or an unreadable registered identity refuse.
2. For a supported Codex request, its conversation working folder. An invalid supplied folder
   refuses instead of falling back to the server's folder.
3. The workspace roots your MCP client advertises: the first one inside a Reasonbook project.
4. The working directory, or the nearest folder above it that is a Reasonbook project — one holding
   `rbook/db/`; a plain folder named `rbook` does not count (the search stops below your home
   directory).
5. Only when the server has no project context at all — no `projectRoot`, no roots, and a working
   directory of `/`, your home directory or the server's install directory (as for a client that starts
   servers without a project folder): the `--project-root <dir>` argument in that server's config, then a registry default set
   with `rbook_project(action="register", projectRoot="...", setAsDefault=true)`.
6. Otherwise the call is refused. In a folder that is not a Reasonbook project, a write names
   `rbook_project(action="init")` and a read answers "No Reasonbook project in '<dir>'".

`rbook_project(action="list")` includes stored ids, addresses and folders. `init`, `register` and
`unregister` require folders; an address never becomes a filesystem path.

Every successful response names the project it used (`projectRoot` and `resolvedBy` in its data), and
says so in its text whenever the project came from workspace roots, `--project-root` or the registry
default. A registry default set before 3.2.0 is not applied until you re-run `setAsDefault`; the
server, `rbook_message(action="whoami")` and `rbook_review` say so when one exists.

## Move work out of a central planning folder

If you collect several efforts in one Reasonbook project, use `spin-out` when an effort needs its
own project folder. It copies selected missions, their linked decisions, learnings and next
steps, and any additional record IDs you name. The source remains a readable history with
pointers to the new project.

Create the destination folder first. The source must be registered, and the two stores must
have distinct project identities. Both roots are required; this command does not use an ambient
project or registry default. Omit `--apply` to preview the selection and mapping:

```sh
reasonbook spin-out --from /work/projects --to /work/new-product --sprint sprint-12

# Or select missions, with additional decisions, learnings and next steps by ID:
reasonbook spin-out --from /work/projects --to /work/new-product \
  --missions product-plan,product-prototype \
  --decisions 41,42 --learnings 17 --next-steps 23,24

# Apply the same reviewed selection:
reasonbook spin-out --from /work/projects --to /work/new-product \
  --missions product-plan,product-prototype \
  --decisions 41,42 --learnings 17 --next-steps 23,24 --apply
```

Choose either `--sprint` or `--missions`. A destination without Reasonbook is reported as needing
initialization in the preview; `--apply` initializes it and takes database backups before
copying. Copied work retains its status but has no sprint assignment in the destination.
Assign it to a target sprint when ready. Source Queued, Blocked and Deferred missions become
Dropped; Completed and already Dropped missions retain their status. Source decisions and
learnings become archived, and source next steps become dropped. Default lists and retrieval
omit these transferred source rows. Sprint history retains its counts and identifies transfers
with their destination pointers. No sprint closes automatically.

Read a source or copied decision, learning or mission with its existing `show` action and an
explicit `projectRoot`; the result includes `spunOutTo` or `spinOutOrigin` and a readable address.
For a historical next step, use
`rbook_context(action="next_steps", nextStepAction="list", nextStepIds=[23], projectRoot="/work/projects")`.
Explicit IDs include moved or dropped rows; an explicit `nextStepStatus` still filters them.
The ordinary next-step list continues to show open work. Target next steps without a sprint
are flagged idle after 42 days. The CLI does not upload either store immediately: each enters
the normal upload schedule after its next successful MCP write, subject to the configured
[upload controls](#optional-hosted-dashboard).

Retry the exact command after an interruption. A verified completed operation returns unchanged.
If source records changed after the target copy committed, final source marking is refused and
both stores are preserved for review. If a reserved retry lacks its committed target receipt,
the command also refuses: it cannot distinguish a crash before copying from an erased proof of
an earlier copy. Preserve **both roots and the operation ID** named in the remedy, inspect their
ledgers and pre-write snapshots, and resolve or restore the conflicting state before retrying.
Do not delete a reservation to force another copy; retries never silently overwrite copied work.

## Environment variables

```bash
# Optional — connects to the hosted dashboard. Defaults to https://reasonbook.ai
# when unset; treat empty string as unset.
RBOOK_DASHBOARD_URL=https://reasonbook.ai

# Optional — the directory the server reads its own .env from. It does NOT select a project:
# use the projectRoot parameter, or --project-root in a server's config.
RBOOK_PROJECT_ROOT=/path/to/your/project

# Optional — override the credential + registry directory. Default: ~/.config/rbook
RBOOK_CONFIG_DIR=/custom/path

# Snapshot retention (default shown)
RBOOK_MAX_SNAPSHOTS=50

# Optional — disable background uploads after writes and explicit completion calls.
# Shared-store propagation and explicitly requested network actions remain available.
RBOOK_CHECKPOINT_SYNC=off

# Optional — disable shared-record exchanges started by hooks and the server timer.
# Explicit reasonbook sync and bundle commands remain available.
RBOOK_SHARED_SYNC=off

# Optional — turn off starting a share or a join through reasonbook.ai on this machine.
# On by default; a project already shared through the dashboard syncs either way.
RBOOK_DASHBOARD_SHARING=off
```

## Error response shape

Every tool returns a uniform envelope:

```json
{
  "success": false,
  "error": {
    "code": "MISSION_NOT_FOUND",
    "message": "Mission 's99-m01' not found",
    "suggestion": "Use rbook_mission(action=\"list\") to see available missions"
  }
}
```

`code` is machine-readable, `message` is human-readable, `suggestion` is a concrete next step. Validation errors carry `validValues` (a `string[]`). State errors can carry `currentState`: generally a status string when the relevant mission, session, or sprint state is available, and — on `SESSION_ALREADY_ACTIVE` only — an object `{ id, type, title, startedAt, captureCount }`. Branch on `code` before reading it.

## Safety

- **Append-only audit.** Session events and mission transitions are append-only rows. Context snapshots keep their rows, ids and events, but `rbook_db(action="prune_snapshots")` can empty the content of copies Reasonbook wrote on its own.
- **Atomic credential writes.** `credentials.json` is written via temp-file + rename with 0600 permissions.
- **Database snapshots.** `rbook_db(action="snapshot")` copies the database on demand. A `rbook_sprint(action="complete")` attempts a snapshot before and after the close; a snapshot failure warns without blocking completion. Applying `rbook_db(action="prune_snapshots")` to a nonempty selection requires a backup, and `rbook_db(action="restore")` first copies the live database to `rbook/db/snapshots/pre-restore/`. `RBOOK_MAX_SNAPSHOTS` caps how many are kept: taking one deletes the oldest beyond it, automatic ones included. Nothing else snapshots first, and there is no soft-delete net — `rbook_db(action="purge")` deletes this project's data from the dashboard mirror. See [SECURITY.md](SECURITY.md#backups--deletion--the-honest-reality).
- **Dry-run where it exists.** `rbook_context(action="condense")` accepts `dryRun` to preview without committing. It is not a general property of mutating tools. Backfill's old event-replay dry run is retired and refuses with `LEGACY_SYNC_RETIRED`.

## Known limits

- Registered projects with dashboard credentials upload snapshots after writes and explicit closes while a server is running; manual `rbook_db(action="backfill")` requests a whole-file upload immediately. Shared-record exchanges use their own hooks, timer and `RBOOK_SHARED_SYNC` control.
- SQLite is the source of truth; the dashboard holds the owner's uploaded mirror. Shared copies exchange their record with `reasonbook sync`, through reasonbook.ai, over SSH or by bundle.
- Through reasonbook.ai, moving a project back to the owner's copy is not available yet. The dashboard's activity feed shows 100 events a page and its decisions page 20 decisions a page; older entries are on later pages.
- A project shared through reasonbook.ai changes through its members' agents; the dashboard's pages show the record but do not change it. If reasonbook.ai loses its copy of a shared project, sharing that project stops until its owner shares it again, and every member keeps their own copy. The old `rbook_db(action="clone")` and `rbook_db(action="pull")` actions refuse with `LEGACY_SYNC_RETIRED`; their action values remain until 5.0.0.

## Documentation

- [Documentation home](docs/README.md) — what it is, how to install it, the levels and where to read more.
- [The handoff demo](https://github.com/kneelinghorse/reasonbook/blob/main/docs/demo/README.md) — a 75-second replay of recorded runs, with a transcript.
- [Trust](docs/trust.md) — what leaves your machine, what the hooks read, and how to turn each part off.
- [Privacy](docs/privacy.md) — collection, dashboard visibility, retention and removal.
- [The method](docs/method.md) — the five lines, the three levels and how to move up.
- [Getting started](docs/getting-started.md) — client configuration and an optional Builder walkthrough.
- [Harness coverage](docs/harnesses.md) — native adapters, MCP prompts and the fallback without hooks.
- [Tool reference](TOOL_REFERENCE.md) — every tool, action, and parameter (generated from the tool definitions).
- [Changelog](CHANGELOG.md) — release notes and tool-surface changes.

## Development

```bash
git clone https://github.com/kneelinghorse/reasonbook
cd reasonbook
npm install
npm run build
npm test
```

Development needs Node.js 20.17 or newer (lint-staged 16.4); the published package runs on Node.js
20 or newer.

Pre-commit hooks run lint + format via husky/lint-staged. This public repository is a code mirror;
release validation and npm publishing run from the private source.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

# Security posture

This document describes what Reasonbook does with your data, credentials, and network — plainly and
truthfully. Every claim below names the source it rests on — a file in the
[source repository](https://github.com/kneelinghorse/reasonbook) and, where it helps, the function or
constant to look for — so you can verify it. (The npm package ships compiled code, so the links point
at the repository.) If something here does not match the code, that is a bug in this document —
please report it.

Reasonbook is a **local-first** MCP server. The default, fully-supported mode is: a stdio server running
on your machine, reading and writing a single SQLite file in your project. Nothing listens on a
network port. Ordinary local-only operations do not contact the dashboard. Dashboard-backed tool
calls can, and startup may conditionally recover a missing project key when a registered project and
usable stored user credential make that recovery possible. Authentication bootstrap can use the
baked default host without an environment setting.

## MCP tool annotations

Every published tool has a human-readable title and all four MCP effect hints. The explicit
action inventory in [tool-effects.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/tool-effects.ts)
is checked against the published actions and the security read/write taxonomy. Hints describe the
union of every action's effects and the common MCP dispatch effects, following
[OpenAI's annotation definitions](https://developers.openai.com/plugins/plugin-guidelines#correct-annotation).
Deletion, overwriting content or status, cancellation, revoking access and sending messages count
as destructive. An undo path does not turn an overwrite into an additive operation.

**All current tools advertise `readOnlyHint: false`, `destructiveHint: true` and
`idempotentHint: false`.** Every MCP call, including a read or refusal, can append local telemetry;
the same append expires old monthly telemetry files. That deletion counts conservatively as
destructive, with no exemption for operational logs. Opening a project can also let the configured
upload scheduler pay upload debt from an earlier write. A configured upload may therefore follow
a read; its destination is the user's bounded dashboard account.

`rbook_message`, `rbook_sprint` and `rbook_project` advertise `openWorldHint: true`: messaging and
sprint `carry_forward` can send to other people's projects, and project `join` and `sync` can write
another machine's shared copy over SSH, or the dashboard's copy of a project shared through it.
Their hints apply to every action, including reads. Access
to the user's own bounded dashboard account alone does not make a tool open-world.

These hints are different from [action-taxonomy.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/action-taxonomy.ts),
which governs a review agent's access to project records. A security-classified read can leave the
record unchanged while writing telemetry outside the store. Tests check prepared store and
registry snapshot hashes for enumerated actions with no action-owned mutation; separate tests
exercise telemetry append and expiration through the registered MCP boundary. Those fixtures do
not prove every argument combination, legacy migration or remote server behavior; effect labels
also require code review.

Codex Auto mode can require approval for every current tool. These annotations do not promise
fewer prompts or a passed plugin-directory review. Reducing approvals requires separately scoped
runtime or tool-surface changes, rather than inaccurate hints.

## Reporting a vulnerability

Please report security issues via the GitHub issue tracker
([github.com/kneelinghorse/reasonbook/issues](https://github.com/kneelinghorse/reasonbook/issues)). For a
sensitive report you would rather not file publicly, open a minimal issue asking for a private channel
and we will follow up. There is no bug-bounty program.

## What listens on the network

**Nothing.** Reasonbook is a stdio MCP server (the `reasonbook` bin → `dist/bin.js`, `package.json`, which
starts the server from `dist/index.js` when given no verb). It speaks JSON-RPC over stdin/stdout to its
MCP host and opens **no** listening socket. The same bin's CLI verbs (`reasonbook hook …`) run once and
exit; they open no socket either.

A previous release also shipped an HTTP transport bin (`cmos-mcp-http`) that bound a port with
`Access-Control-Allow-Origin: *`, no authentication, and full read-write access to every registered
store. **It has been removed** — source, bin, export, script, docs, and PM2 config are all deleted
(see the `[2.0.0] → Removed` entry in [CHANGELOG.md](CHANGELOG.md)). There is no unauthenticated
network surface.

## Outbound network

Reasonbook runtime and plugin installation make outbound requests in these situations:

1. **The dashboard, once you have a credential, or when you ask for it.** The URL resolves from
   `RBOOK_DASHBOARD_URL`, then the baked `https://reasonbook.ai` default (`DEFAULT_DASHBOARD_URL` in
   [dashboard-client.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/dashboard-client.ts)).
   - **Sign-in.** `rbook_auth(action="login")` or `login_init` contacts that host even when no URL
     variable or credential exists. `login_complete` polls only when given a `deviceCode`; without
     one it returns a local `MISSING_PARAMETER` and sends nothing.
   - **Registered-project writes and explicit completion calls start background uploads.**
     `rbook_session(action="complete")` and `rbook_sprint(action="complete")` start this best-effort
     work when a nonempty stored user-scoped key, `RBOOK_DASHBOARD_API_KEY`, or the complete
     `RBOOK_DASHBOARD_USER` / `RBOOK_DASHBOARD_PASSWORD` pair exists. A project key alone does not
     open that gate. The primary path uploads a consistent snapshot of the **whole SQLite file**, including pending
     proposal drafts and any approval words already copied into decision records. It may first
     register the project and save its project key. Completion success does not confirm upload
     success: this work is asynchronous. For a registered project, an MCP tool call that actually
     writes the store also schedules an upload, due after 5 quiet minutes or 30 minutes of
     continuous writes. The next poll starts it within 60 seconds when no upload lease or failure
     backoff blocks it; transfer time is additional. A running server must have opened the
     project. An owed upload survives process exit in the per-user registry, and concurrent
     servers share one lease per project. Only explicit closes may register a new project.
     Upload results and failures appear in `rbook_status`, `rbook_review` and close receipts.
     Transient failures back off for 1, 5, 15 and then 60 minutes, never before Retry-After.
     Authentication failures are rechecked before pausing, and an hourly probe resumes uploads once
     authentication works. Confirmed deletion or replacement holds all uploads for that project,
     including explicit closes and manual backfill. Restoring it as a new project is not available
     in this version. Tier and confirmed forbidden responses pause until an explicit success. Event replay is retired: a missing project slug or a failed file upload never
     falls back to replay. A later checkpoint can retry the file upload. Implicit process-exit closes do not upload; explicitly completing an
     implicit session through the tool does. Set
     **`RBOOK_CHECKPOINT_SYNC=off`** to disable these automatic upload paths and manual backfill
     (`triggerCheckpointBackfill` in [checkpoint-backfill.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/checkpoint-backfill.ts)).
   - **Calls you make.** Messaging, status and sync health, `rbook_db` dashboard actions (backfill and purge), sprint carry-forward, and the onboard and review summaries of messages. Backfill honors `RBOOK_CHECKPOINT_SYNC=off`; the other calls remain available. Logout leaves project keys valid for these calls until separately revoked.
   - **Startup key recovery**, when a registered project and a usable user-scoped credential exist
     but the project's key is missing. Member copies of a shared record refuse recovery.
   - **Retired dashboard collaboration.** The old lock, pull and mutable-push paths refuse
     with `LEGACY_SYNC_RETIRED`; local updates on old collab-role stores report that warning.
     Shared records exchange directly over configured SSH routes or carried bundle files
     using `reasonbook sync`, or with the dashboard's copy of a project shared through it
     (item 5). `RBOOK_CHECKPOINT_SYNC=off` does not disable those exchanges.

   Without a dashboard credential, ordinary local work sends nothing to the dashboard: the baked
   address alone does not make any tool upload project data.

2. **HuggingFace (`huggingface.co`)**, only when the optional `@xenova/transformers` package is
   installed next to Reasonbook. The default install does not include it, and then Reasonbook never
   contacts HuggingFace: retrieval is keyword-only and `rbook_db(action="health")` reports semantic
   search off. With the package installed, the first write that records an embedding (a decision,
   learning or mission) or the first search downloads the embedding model
   `Xenova/all-MiniLM-L6-v2` (~25 MB, [embedding-pipeline.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/embedding-pipeline.ts)),
   which is then cached locally. You can force **embedding-model loading to remain offline** with
   `RBOOK_OFFLINE_EMBEDDINGS=1` (and optionally a pre-seeded `RBOOK_MODEL_CACHE_DIR`): the loader sets
   `env.allowRemoteModels=false` before loading
   ([transformers-offline-env.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/transformers-offline-env.ts)), and if the model is
   not present locally the vector arm degrades to keyword-only retrieval instead of blocking on a
   fetch (`getEmbedder` in [embedding-pipeline.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/embedding-pipeline.ts)). The token
   counter's tokenizer (`Xenova/claude-tokenizer`) loads only when something counts tokens, and no
   tool does. A local-forever install never _hard-requires_ a network fetch.

3. **Plugin installation.** A cold plugin launch runs npm to install the plugin's exact Reasonbook
   version and its dependencies. This contacts the configured npm registry; dependency install
   scripts may also download native packages from their suppliers. Until that install is ready, a
   command run through the plugin (not a hook) runs the same exact version with
   `npx -y --prefer-offline`, which contacts the registry too unless npx's cache already holds it;
   in Codex, the plugin's server answers that Reasonbook is installing rather than starting through npx
   ([run.mjs](https://github.com/kneelinghorse/reasonbook/blob/main/plugins/reasonbook/hooks/run.mjs)).
   This installation is separate from dashboard sync and does not upload the project database. The
   launcher validates package identity, CLI version and native SQLite before publishing the install
   ([install-worker.mjs](https://github.com/kneelinghorse/reasonbook/blob/main/plugins/reasonbook/hooks/install-worker.mjs)).
   `pluginServer: "off"` disables the plugin's MCP server before package discovery or installation;
   enabled developer hooks can still need their runtime.

4. **Shared-record exchanges over SSH.** Once a project is shared and copies have joined,
   `reasonbook sync` exchanges their changes through the owner's copy. Saved routes also run at
   session start and end where hooks run, detached so the hook does not wait for the network, and
   every five minutes for shared projects a running server has opened. These paths need no dashboard
   credential. **`RBOOK_SHARED_SYNC=off`** stops automatic exchanges where it reaches the hook and
   server processes; explicit sync and bundle commands remain available. The dashboard-upload
   switch is separate
   ([record-sync-trigger.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-sync-trigger.ts),
   [record-sync-scheduler.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-sync-scheduler.ts)).
   SSH uses `BatchMode=yes` and configured remote runtime paths
   ([record-ssh.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-ssh.ts));
   a bundle can instead be carried and imported explicitly.

   A member's initial copy contains the full SQLite store, including history and stored proposals.
   Owner/editor roles hold among honest copies using the supported protocol over SSH or bundles;
   they do not defend against a member altering their store or software. Removal stops delivery of
   new changes to that member and quarantines their changes beyond the removal cut, but cannot
   retract data already copied. Quarantined change bodies remain in the shared log and reach active
   members even while those changes do not become live records. Re-inviting permits exchange again,
   and from 4.2.1 judges those
   quarantined changes again, refusing what the member's role does not allow
   ([record-membership.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-membership.ts)).
   See [Trust](docs/trust.md#shared-copies) for the measured support scope and content boundary.

5. **Sharing through the dashboard, on unless `RBOOK_DASHBOARD_SHARING=off`.** This release ships
   it switched on, after its live test through reasonbook.ai. The setting is read only from the
   environment Reasonbook runs in; `off`, `false`, `0` or `no`, in any case, refuses starting a share
   or a join on that machine, and nothing the dashboard reports changes it
   ([record-dashboard-share.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-dashboard-share.ts)).
   With it on:
   - **Sharing** (`rbook_project(action="share", via="dashboard")`, `reasonbook share --dashboard`)
     first lists what would go up, and sends nothing without `confirm=true` or `--yes`. It then
     uploads a fresh copy, built with Reasonbook's own schema, that holds the shared record only:
     the recorded tables' rows, the change log (every value ever recorded, replaced text
     included, with each change's author name and, from a signed-in machine, account id) with the
     engine's tables beside it (conflicts, heads, roots and aliases), the project identity and the
     metadata the engine needs. That copy leaves out session events, agent feedback, telemetry,
     context snapshots and documents, proposals, prompt mappings, the sync queue, the search
     index, routes to other copies and credentials. The dashboard then holds the project's
     referee copy. A share needs the project on the dashboard first, though, and item 1's uploads
     put it there: they send the whole SQLite file, those tables included, until the share hands
     the record over, and the dashboard keeps the file its registration uploaded.
   - **Joining** by the project's address downloads a first copy over HTTPS into a private
     temporary folder and builds the member's store from it with this version's schema, checking
     every change, so nothing the downloaded file holds runs on the member's machine
     ([record-dashboard-join.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-dashboard-join.ts)).
   - **Syncing** exchanges changes with the dashboard's copy over HTTPS, in pages within the limit
     the dashboard publishes, on the triggers of item 4; `RBOOK_SHARED_SYNC=off` stops the automatic
     ones. A copy shared through the dashboard exchanges with it alone, with no bundle in or out and
     one exchange over SSH: a catch-up from the owner's copy that moved the project back, which it
     serves with only the methods a catch-up needs, so SSH login is the boundary there too
     ([record-wire.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-wire.ts)).
   - **Recovery contributions** can upload a fresh shared-record SQLite copy to
     `POST /api/relay/projects/<id>/recovery/copy` when the dashboard is recovering the remembered
     project and referee. It holds the shared tables, identity and full change log, with the same
     exclusions as the share copy above. The owner's copy contributes too. An accepted contribution
     is sent once per recovery and copy; an unacknowledged request may be retried. Either
     `RBOOK_SHARED_SYNC=off` or `RBOOK_DASHBOARD_SHARING=off` stops contributions, including during
     explicit sync. `RBOOK_CHECKPOINT_SYNC=off` controls whole-store uploads separately and does not
     stop these contributions. [Privacy](docs/privacy.md#sharing-through-reasonbookai) describes their retention.
   - **Moving back** (`rbook_project(action="move", to="owner")`, `reasonbook move --to owner`)
     hands the record to the owner's copy, and the dashboard archives its copy once the owner's
     copy holds the record and has synced again.

   These calls sign with this machine's dashboard credentials for the project, resolved as other
   dashboard calls are, and go only to the configured dashboard address, over HTTPS unless that
   address is this machine, never with a password and following no redirect
   ([record-dashboard-peer.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-dashboard-peer.ts)).
   The dashboard's copy runs Reasonbook's own engine (`@aquex/reasonbook/referee`), which binds
   each copy to its account and refuses, whole, a delivery that breaks the record's rules or, from a
   member's copy, names anyone but that member as a change's author. A change may name no author
   (the feed then shows the row's author), the owner's own copies are not held to the name, and a
   change's account id is not compared with the caller's account. It does not check the author
   fields of the rows a change writes, and checks a change's time only against the member's
   admission and a week past its own clock, so a member who edits their own copy can put rows, and
   feed entries, under another member's name. Before a record switches to protocol 2, a back-dated
   create can win a mission, sprint or session id because claims use clock order. After the switch,
   the first counted acceptance fixes a claim's position, and pre-switch claims precede later ones.
   An accepted id is final once a copy holds every earlier-positioned claim's data. Predictable ids
   can still be claimed first, and recovery judges previously unjudged transactions in clock order
   ([record-claim-order.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/record-claim-order.ts)).
   The dashboard runs the engine version it pins, and a fix to the engine reaches projects shared
   through it once it pins the release that carries it.

6. **`reasonbook doctor`'s version lookup.** One HTTPS GET of
   `https://registry.npmjs.org/@aquex/reasonbook/latest`, limited to 5 seconds, to compare this
   machine's installs with the latest release. It sends no project, path or credential;
   `--offline` skips it, and a failed lookup is reported in the answer, not treated as an error.

## Authentication model

Dashboard authentication is **optional**. Device-code bootstrap uses the effective dashboard URL
described above and does not require an existing credential. After bootstrap, credential-bearing
project clients are constructed by `DashboardClient.fromEnvForProject()`
([dashboard-client.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/dashboard-client.ts)); the selected credential source is
surfaced as an `authTier` (the `AuthTier` type and `deriveAuthTier` in
[auth-state.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/auth/auth-state.ts)):

- **`device-code` (preferred).** RFC 8628 device-code flow via `rbook_auth(action="login_init")` +
  `login_complete`. Mints user-scoped and project-scoped `cmk_` keys stored locally.
- **`legacy-env`.** A `RBOOK_DASHBOARD_API_KEY` environment variable (`RBOOK_DASHBOARD_API_KEY_ENV`
  in [dashboard-client.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/dashboard-client.ts)). Kept as a CI/script fallback; the
  server emits a one-time `[WARN]` nudging migration to device-code (`warnLegacyAuth`, same file).
- **`password-fallback`.** Email + password login. Also emits the migration `[WARN]`.
- **`none`.** No stored credential — ordinary local work remains local and credential-requiring
  dashboard operations refuse gracefully. Credential bootstrap remains available: `login` /
  `login_init` require no existing key and may contact the baked dashboard host.

## Data & credentials at rest

- **Project data** lives in one SQLite file, `rbook/db/rbook.sqlite`, inside your project. It is not
  encrypted at rest (it is an ordinary SQLite database on your disk, with your filesystem's
  permissions).
- **Credentials** live at `<configDir>/credentials.json`, where `configDir` defaults to
  `~/.config/rbook` and honors `RBOOK_CONFIG_DIR` (`RBOOK_CONFIG_DIR_ENV` in
  [credential-store.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/credential-store.ts)). The file is written atomically with
  **`0600`** permissions (`writeFileAtomic(…, { mode: 0o600 })`, same file).
- **The `cmk_` keys in that file are stored in plaintext** — there is **no** encryption at rest and
  we make no such claim (the key fields in
  [credential-store.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/credential-store.ts) are documented "Plaintext `cmk_…`
  key"). The protection is filesystem permissions (`0600`), not cryptography. Treat
  `credentials.json` like an SSH private key.

## Backups & deletion — the honest reality

- **Database snapshots** are copies of the SQLite file under `rbook/db/snapshots/`.
  `rbook_db(action="snapshot")` takes one on demand. `rbook_sprint(action="complete")` attempts
  snapshots before and after closing; a snapshot failure warns without blocking the close.
  `rbook_db(action="prune_snapshots")` requires a backup before applying a nonempty selection.
  `rbook_db(action="restore")` requires a copy of the live database under
  `rbook/db/snapshots/pre-restore/` before replacing it. These are the automatic backup paths.
- **Retention deletes.** `RBOOK_MAX_SNAPSHOTS` (default 50, `resolveMaxSnapshots` in
  [rbook-db-snapshot.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/rbook-db-snapshot.ts)) caps how many snapshots are kept:
  taking one deletes the oldest beyond the cap, automatic ones included.
- The environment variables `RBOOK_AUTO_SNAPSHOT`, `RBOOK_SNAPSHOT_RETENTION_DAYS`, and `DB_PATH`
  appear in older docs but are **vestigial — no code reads them.** Do not rely on them.
- There is **no `deleted_at` soft-delete net** on the main store. Decisions and learnings carry a
  status (`active`/`superseded`/`archived`/`stale`), but `rbook_db(action="restore")` replaces the
  whole database, and `rbook_db(action="purge")` deletes this project's data from the dashboard
  mirror (refused while a project is shared through reasonbook.ai). A restore's pre-restore copy is **not listed or accepted by restore-by-ID**: keep its
  returned path for manual filesystem recovery with all writers stopped. That subdirectory is
  also outside the top-level snapshot retention count
  ([rbook-db-restore.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/rbook-db-restore.ts)).
- **Snapshot content can be emptied.** `rbook_db(action="prune_snapshots")` is a dry run unless
  `confirm=true`; applied, it empties the content of context-snapshot copies Reasonbook wrote on its own
  (rows, ids, references and events stay) after taking a database snapshot.

## Untrusted / foreign content

Inbound message bodies and summaries, project directory descriptions, and decision/learning rows
from _other_ projects are treated as **data, not instructions**. They are rendered inside a
source-labeled, self-escaping "untrusted" fence and carry an
additive `{source, trust:"foreign"}` descriptor
([provenance-frame.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/provenance-frame.ts)), applied across the message list,
onboarding, directory, and cross-store/pull-merged decision & learning renders. The `rbook_message` and
`rbook_agent_onboard` tool descriptions state this contract to the calling agent.

Editors' accepted rows in the **same shared project** keep that project's identity, so they reach
the owner's agents as local content, without this foreign-source fence. Sharing grants trust in
the editor's record content; an author name is attribution, not content validation.

- **Decision & learning read surfaces framed:** a legacy store may already hold rows
  from the retired dashboard pull; cross-store reads also reach rows from other projects. `project_id` is
  derived read-time (no migration; column-presence guarded so ancient stores degrade to `NULL` and
  render bare, never throw) and a foreign **decision or learning** row — its `project_id` ≠ the resolved
  local project — renders inside the untrusted fence, while local rows stay bare, at **every** surface
  that renders such rows:
  - the retrieval/search reads: mission-start "relevant decisions"
    ([relevance-surfacing.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/relevance-surfacing.ts) →
    [rbook-mission-start.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/rbook-mission-start.ts), decision text **and** evidence),
    `rbook_context(action="search")`, `rbook_decisions(action="search")`, `rbook_learnings(action="search")`
    (threaded through the retriever's `RankedResult` and the two direct-SELECT search paths);
  - the aggregate/digest reads: `rbook_context(action="view")` (full + compact),
    `rbook_agent_onboard` "Recent Decisions", and the `rbook_review` digest's recent-decisions.

  This closes the former mission-start "relevant decisions" limitation for decision/learning content.

- **MISSION / SPRINT / SESSION read surfaces framed:** legacy stores can retain foreign
  `project_id` values on `missions` / `sprints` / `sessions` rows from the retired pull-merge path. Their
  name / objective / context / title / focus / summary fields are now derived read-time (same
  column-presence PRAGMA guard, so ancient stores degrade to `NULL` and render bare, never throw) and a
  foreign row — its `project_id` ≠ the resolved local project — renders inside the untrusted fence while
  local rows stay bare, at **every** surface that renders such rows:
  - `rbook_agent_onboard` current-sprint header, active-session, and pending & blocked missions;
  - `rbook_mission(action="list")` name/objective, `rbook_mission(action="show")` name/title/focus
    (inline) + objective/context/success_criteria/deliverables (block);
  - `rbook_mission(action="status")` local work-queue (In Progress/Current/Queued/Blocked names +
    objectives + sprint title/focus) and `acrossProjects=true` portfolio mission names (foreign fenced,
    the local project's own rows bare — the `[proj:X]` tag is metadata, not a trust boundary);
  - the `rbook_review` digest sprint title/focus, portfolio mission names, and the `Next:` recommendation
    (a foreign referenced mission renders **id-only** so its name never lands unfenced in the ≤4KB digest);
  - the `rbook_agent_onboard` **suggested actions** and the `rbook_review` promoted **next_actions** they
    feed — a foreign mission/session referenced by a "continue/start/resolve/complete" action renders
    **id-only** (name/title dropped) rather than fenced, keeping the byte-capped digest clean;
  - `rbook_session(action="list")` title/summary and `rbook_session(action="search")` title + matched
    snippets.

  This closes the former foreign MISSION/SPRINT/SESSION limitation; the decision/learning sweep above
  and this row-type sweep together frame every local-store read surface that can carry a pull-merged row.

- **Signals (4.3.0):** `rbook_review`'s list of other projects that need a person frames each
  project's name, and its counts are numbers this client computed from those projects' stores, read
  read-only. `reasonbook signals` frames each project's name the same way. The weekly brief
  (`renderBrief`, `reasonbook brief`) escapes every name and row id for markdown and carries counts,
  row ids and dates, never record text. The signals library reads one store file read-only, and a
  draft runtime file only when it and its sidecars are plain files; it opens no network connection.
  Scope boundary (ratified): the framed field set is name / objective / context / title / focus / summary
  (+ success_criteria / deliverables on `mission show`). Mission `notes` and `reference_docs` are **not**
  framed — they are operator-authored operational metadata (a blocker reason, a doc URI), rendered on a
  narrow set of surfaces, and were deliberately left out of the sweep; revisit if a real cross-owner share
  makes them an injection vector.

- The separate content sanitizer ([content-sanitizer.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/content-sanitizer.ts))
  guards Reasonbook's own **write** paths against a specific tool-call-marshalling corruption; it is not the
  inbound-rendering mechanism above.

## Dependency posture

Since 3.2.0 a consumer install carries no embedding stack. Measured on packed tarballs installed with
`npm install --omit=dev` into an empty project: 3.1.0's install was 305.7 MB and `npm audit` reported
1 critical and 5 high advisories, all through `@xenova/transformers` (`protobufjs`, `onnx-proto`,
`onnxruntime-web`, `sharp`); the 3.2.0 release audit reported none. A fresh macOS arm64 install checked on 2026-10-09
uses 45,972 KiB under `node_modules` by `du -sk` (44.9 MiB); allocation varies by platform
and dependency resolution. `@xenova/transformers` is an
optional peer dependency. If you install it for semantic search, its chain carries those advisories
into your tree, and this package's `overrides` cannot reach a dependent's tree: pin `protobufjs` to
`^7` in your own `overrides`. In this repository the override still pins it for the development tree
(where the package is a dev dependency), guarded by
[tests/release/dependency-overrides.test.ts](https://github.com/kneelinghorse/reasonbook/blob/main/tests/release/dependency-overrides.test.ts).
On 2026-10-11, `npm audit --omit=dev --json` reported **zero** vulnerable package entries. The full
development installation's `npm audit --json` reported **2 affected package entries, both high**,
counting `Object.keys(vulnerabilities)` and the report's severity totals; an entry can be flagged
only because a package it depends on is. Both come from three `sharp` advisories
(GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w) on one path,
`@xenova/transformers@2.17.2 → sharp`: the optional embedding peer, a development dependency here.
They remain because npm's only offered fix downgrades `@xenova/transformers` to 1.4.2, and the
package reaches only people who install it for semantic search.

The same development tree reported 40 entries (9 moderate, 30 high, 1 critical) earlier the same
day and on 2026-10-10. Jest 30.5.2 and lint-staged 16.4.0 removed `micromatch` and `braces`, which
has no fixed release; `handlebars` 4.7.10, through `ts-jest`, cleared the critical. Two development
`overrides` cleared the rest: `@istanbuljs/load-nyc-config` gets js-yaml 4, dropping `argparse` 1
and `sprintf-js`, which has no fixed release either, and `uuid` is pinned to ^11.1.1 across the
development tree, where its only users are `jest-cucumber` (asking for ^10) and `@cucumber/messages`
(asking for exactly 9.0.1). Overrides apply only to this repository's own install, never to a
consumer's, and
[tests/release/dependency-overrides.test.ts](https://github.com/kneelinghorse/reasonbook/blob/main/tests/release/dependency-overrides.test.ts)
fails if any of these advisories comes back. Developing in this repository needs Node.js 20.17 or
newer (lint-staged 16.4); the published package runs on Node.js 20 or newer. A consumer that
installs the optional embedding peer must audit that resulting installation separately.

## Sanctioned deployment shape

**Recommended: one project-local stdio server per project.** Launch Reasonbook from the project directory
(or let your MCP host advertise the project via `roots/list`) so attribution resolves to the right
project. Sender/attribution resolution never consults `RBOOK_PROJECT_ROOT` at tool-dispatch time — that
env var is retained only as a bootstrap hint so the server can find its own `.env` (the module note
in [sender-context.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/intelligence/sender-context.ts)).

**The one topology to avoid:** a single _global_ MCP entry that pins `RBOOK_PROJECT_ROOT` to one repo
while you work across several registered projects. That configuration ties `.env` bootstrap — and
any dashboard key that `.env` holds — to one repo that every sibling session shares. The server emits
a startup `[WARN]` when it detects exactly this — `RBOOK_PROJECT_ROOT` pinned **and** more than one
project registered (`evaluateStartupTopology` in [index.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/index.ts)). If you see that warning,
prefer a project-local server or pass `projectRoot` explicitly per call.

**Credentials belong in `~/.config/rbook`, not a repo `.env`.** Keeping `cmk_` keys out of any
repository avoids committing or mirroring them. The publish/mirror tooling additionally fails hard if
a real `.env` (anything but `.env.template`) ever reaches the public tree (the leak guard in
[scripts/mirror-to-public.sh](https://github.com/kneelinghorse/reasonbook/blob/main/scripts/mirror-to-public.sh)).

### Read-only review agents (the review deployment)

Reasonbook ships a fail-closed **read-only mode** for agents that should never mutate your store — e.g. a
code-review agent. When `RBOOK_AGENT_ROLE=review` is set, a dispatch-layer guard
([read-only-agent-guard.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/read-only-agent-guard.ts), classifying every action via the
fail-closed [action-taxonomy.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/action-taxonomy.ts)) hard-rejects every write-classified
tool call **before any database is opened** and is a strict no-op when the env is unset.

To close the _other_ data-loss vector — a review agent running `git reset`/`stash`/`clean`/etc. — the
repo ships a PreToolUse hook ([scripts/hooks/block-git-mutations.sh](https://github.com/kneelinghorse/reasonbook/blob/main/scripts/hooks/block-git-mutations.sh))
that rejects destructive git commands. It is **role-gated**: a strict no-op unless
`RBOOK_AGENT_ROLE=review`, so it is safe to wire into any settings. To run a review deployment, use a
**separate** Claude Code / MCP host instance and apply
[scripts/hooks/review-agent.settings.json](https://github.com/kneelinghorse/reasonbook/blob/main/scripts/hooks/review-agent.settings.json) (copy it to that
instance's `.claude/settings.json`) — it sets `RBOOK_AGENT_ROLE=review` and wires the hook, activating
both guards together.

**Reads never write the record, under any role.** Since 3.3.0 a read-classified call (the
`READ_ONLY_ACTIONS` list in [src/tools/rbook/action-taxonomy.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/action-taxonomy.ts))
changes no row: no record status, no owner or address, no seeded identity, no schema label, no rebuilt
search index. Each repair that rewrites a value asks `callMayWrite()` in
[src/tools/rbook/tool-call-context.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/tool-call-context.ts) first. Through 3.2.0 the
session opener marked old decisions and learnings `stale` on every review, the review role included. A
migration may still run on a read when it is DDL, the filling of a table or column that same call
added, and the new completion marker it writes under its own key when it ran that DDL
(`ensureExternalFts` and `ensureVectorStorage` in
[src/tools/rbook/schema-migrations.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/schema-migrations.ts)). Store upkeep that
rewrites existing values (restoring rows an older Reasonbook marked stale, a pending master_context
migration, rebuilding a search index out of step with its table) runs only at a write, at a server
process's first write to a store (`runFirstWriteMaintenance` in
[src/tools/rbook/first-write-maintenance.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/first-write-maintenance.ts)), and the
write's answer says what it did. A read that meets an index out of step says so on its answer, and the
server that read it rebuilds it at its next write. Repairs made on a write's way (an address heal, a
seeded identity row) are not that write (`asLazyRepair`): onboard, which makes no status write, never
starts the upkeep. Whoami and the startup lines write nothing at all; they resolve with the address the
next write would store. [tests/tools/rbook/reads-never-write.test.ts](https://github.com/kneelinghorse/reasonbook/blob/main/tests/tools/rbook/reads-never-write.test.ts)
calls every read-classified action against stores seeded so each old write was possible, in both
roles, and fails on any committed row change.

**Codex input boundary.** The developer plugin wires SessionStart, UserPromptSubmit, Stop,
PreCompact and SessionEnd. Its hook parser consumes `session_id`, `cwd`, `prompt`, and
`last_assistant_message`; Codex's `turn_id` becomes the shared `prompt_id`. The shared parser also
accepts `source` and `reason`. The prompt can be searched for recall and observed for draft approval;
the latest assistant reply can produce the draft and its bounded excerpt described below. Codex
`transcript_path` is discarded before the shared parser, so Reasonbook does not scan a Codex transcript
as if it were a Claude transcript. Other stdin fields are ignored
([hook-adapters.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/cli/hook-adapters.ts),
[core.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/cli/core.ts)). The chat plugin has no hooks.

For MCP calls, Reasonbook advertises `codex/sandbox-state-meta` and reads only the presence and object
shape of `_meta["x-codex-turn-metadata"]`, the nonempty `_meta.sessionId`, and
`_meta["codex/sandbox-state-meta"].sandboxCwd` as a `file://` URI. It ignores the marker's contents
and every other sandbox-state field; those fields are not copied into the Reasonbook request context.
An explicit `projectRoot` remains the first choice. Without it, malformed supplied metadata
refuses project resolution. The folder and conversation id live only for the request; background upload work
clears this context
([codex-request-context.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/codex-request-context.ts)).

The metadata is caller context, not authentication or proof of approval. Reasonbook uses a conversation
session key only when its folder resolves to the same physical store and that session has actual
hook state there. Otherwise it uses a process-owned session; merely supplying a session id cannot
manufacture hook approval. SessionEnd removes that session's hook evidence
([session-owner.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/session-owner.ts),
[draft-runtime.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/draft-runtime.ts)).
A chat-only direct decision can put observed approval words in `context`; Reasonbook cannot verify those
words and does not label that direct record as hook-approved.

**Hook runtime files.** The hook CLI keeps per-machine state under the config directory, never in a
project or the store ([src/tools/rbook/harness-session.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/harness-session.ts)):
`<configDir>/runtime/harness/<pid>.json` links a harness process to its sessions, each by a
16-character SHA-256 prefix of the session id (`harnessSessionHash`), and holds the path of the
folder the conversation works in; `<pid>.ended` holds the prefix of the session that ended;
`runtime/declined.json` lists repositories whose user declined the init offer;
and `runtime/fail-open.jsonl` records hook verbs that gave up (the verb and a cause, never content;
`recordFailOpen` in [src/cli/core.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/cli/core.ts)). No raw harness session id is written to the store, the
runtime files or a log. The hook verbs read the record without writing it (the digest is
`rbook_review`'s read), except that session end closes the sessions the conversation opened, and that
drafts are kept in the store's `proposals` table (below). No hook verb registers a project in the
project graph or writes its identity.

**Drafted records (3.3.0).** When an agent ends a reply with a `Would record:` line, the Stop hook
stores it in the store's `proposals` table: the line, its kind, the hashed session, up to 600
characters of the reply before it, the links it named, and whether the session had read outside
content. The prompt hook writes only a decline or a draft's first-offer time there. Neither is a
record: the table is outside search, embeddings and sync events, and nothing in it becomes a
decision, constraint, learning or profile line without a `rbook_decisions(action="record",
fromDraft=...)` call. The table is in `rbook.sqlite`, so a signed-in checkpoint upload carries it with
the rest of the store. The operator's reply to a draft is never written to the store by a hook.
The runtime uses one SQLite file per store under `<configDir>/runtime/drafts/`, keyed by a hash of
the project id and the store's native real path. It keeps:

- the newest 200 counted session-start times and each session's start time;
- offer counts per session and draft;
- the operator's reply, at most 1,000 characters, its class, the number of drafts it answered and
  the time it was received and whether it answered a showing more than two hours old;
- the draft ids shown by the last reply, with their time;
- declined draft ids awaiting a store write, with the first decline time and no words;
- the draft ids in an approval window, its open/closed state and its time;
- transcript scan offsets and outside-content flags, keyed by hashes of transcript paths.

Session keys are 16-character hashes; raw session ids and transcript paths are not stored there
([src/tools/rbook/draft-runtime.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/draft-runtime.ts)).
Replies and windows stop being usable after two hours. Shown and retained draft ids contain no
operator words; they expire after three later starts in that store’s runtime or more than seven
days from their showing. A non-compact start clears that session’s sets. A late answer opens no
direct-record window: an approval is agent-judged, and a decline is persisted in the store. If a
decline meets a busy store, its showing is retained and commit retries once after output delivery.
An id-only decline marker survives session cleanup and expiry until the store confirms the draft
is no longer pending; later prompt and Stop hooks retry it. Record transactions apply retained
declines before settling related revisions, and leave marker cleanup to a later hook. Current readers refuse that draft
even without a linked session. Older binaries do not understand this marker: their refusal is
guaranteed only after the decline reaches the store. Session start still writes no project store.
These are expiry checks, not background deletion timers: cross-store pruning runs only at a session start inside a Reasonbook project
with a harness session id, visits at most 50 runtime files, and skips files it cannot open. Binding
a new reply also prunes expired replies in that store. A successful session-end cleanup deletes
that session's runtime rows; the bounded start-time history remains. A crash followed by no such
start or cleanup can leave expired data on disk. Only a `fromDraft` record copies a reply into the
decision it approves, as that decision's `approval_words`. Under `RBOOK_AGENT_ROLE=review` session
starts do not prune or count toward draft expiry, and the hooks store, bind and decline nothing
([src/cli/drafts-hook.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/cli/drafts-hook.ts)).

The plugin also keeps hashed source-election and turn receipts under `runtime/hooks/`, and
completed first-prompt receipts plus delivered typed IDs under `runtime/recall/`. These receipts
survive session end so duplicate adapters or resumed conversations do not replay completed work.
Transient `runtime/lifecycle/` files hold the initial Git commit, dirty paths and compact marker;
successful session end removes only that conversation's transient files. Git summaries describe
repository observations, not agent authorship. The Claude plugin installer stores an exact
runtime/version marker with its package in `CLAUDE_PLUGIN_DATA` and an installation pointer under
the config directory. The Codex developer hooks and both Codex plugin servers instead share
`<configDir>/plugins`, with an exact version, platform, architecture and Node ABI in the install
identity. The developer entry forwards an optional absolute `RBOOK_CONFIG_DIR`; empty or relative
values are refused. The portable chat loader cannot forward that optional variable, so its supported
shared root is the default `~/.config/rbook`. Both entries use the same installation validation. `pluginServer: off` is checked before package discovery or installation and exposes
no tools or instructions. None of this external runtime state is uploaded with the project store.

**The operator profile.** `<configDir>/profile.md` holds the operator's working preferences, for
every project. It lives outside every repository and every store, so it is never committed and never
uploaded with the store. `reasonbook profile show` prints it. Reasonbook's own write path (`addProfileLine` in
[src/tools/rbook/operator-profile.ts](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/operator-profile.ts))
adds a line only on an approved draft of kind `profile`, refuses a line past the 1,100-character cap,
and never cuts the profile to fit. That is a rule Reasonbook keeps, not a sandbox: it checks the approval
it is handed, not where the approval came from, and the profile is an ordinary file in the user's
config folder, which anything running as the user, an agent with file access included, can edit.

**Honesty caveat (important).** The machine-enforced read-only guarantee holds under this
**separate-read-only-server** deployment, where the review agent's MCP server is launched with
`RBOOK_AGENT_ROLE=review`. It does **not** automatically extend to in-session subagents spawned by a
normal build agent: those subagents share the parent's environment and MCP connection, so the parent's
(writable) server serves them. For read-only investigation _within_ a build session, use a read-only
subagent type (e.g. the `Explore` agent) — that is a mitigation, not the machine-hard guarantee.

---

_Last verified against the source for release 4.9.0._

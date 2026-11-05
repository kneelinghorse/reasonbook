# Sharing and the hosted dashboard

## Share a project's record

Sharing is supported in the measured setup: two accounts operated by one person, on two machines,
either through reasonbook.ai or in an owner/member star over SSH. A second person's collaboration
and privacy experience remain unvalidated. Each member receives a full local copy of the record and works locally.
Editor content reaches the owner's agents as local project content, without a foreign-source fence;
invite people whose record content you trust. Read [Trust](trust.md#shared-copies) and [Privacy](privacy.md) before sharing.

Use a current Reasonbook installation on both machines; older servers cannot write a shared store.
The store must be outside Git's tracked files. If sharing refuses because Git tracks it, follow the
returned untracking remedy while keeping the local file. One machine keeps one live copy of a shared
project: work in one folder, since a second copy of it in another folder on the same machine has its
writes refused, and two joined copies of one project there both do.

There are two ways to share. Through reasonbook.ai, the dashboard keeps the project's referee copy,
and nobody needs SSH while the project is shared there. Directly, the owner's copy is the referee, over SSH or with bundles carried by
hand. Replace the names and absolute paths in these examples with yours.

### Through reasonbook.ai

Each person signs in to reasonbook.ai on their own machine, once:
`rbook_auth(action="login_init")`, then `rbook_auth(action="login_complete", deviceCode=...)`, as
[Connect the hosted dashboard](#optional-connect-the-hosted-dashboard) describes. Sharing through the
dashboard is on by default; `RBOOK_DASHBOARD_SHARING=off` where Reasonbook runs turns it off on that
machine. It is the person's setting, not an agent's.

On the owner's machine, ask your agent to share the project through the dashboard. It first lists
what the share would send (the shared record) and what the shared record leaves out, and sends
nothing until you confirm:

```text
rbook_project(action="share", via="dashboard", projectRoot="/owner/project")
rbook_project(action="share", via="dashboard", confirm=true, projectRoot="/owner/project")
```

Until the share hands the record over, the project's uploads to reasonbook.ai still send its whole
file; [Privacy](privacy.md#sharing-through-reasonbookai) says what each upload holds and what the
dashboard keeps.

A project reaches reasonbook.ai at its first upload. If sharing says the project is not on the
dashboard yet, start and close a session on that machine, signed in and with uploads on, which
uploads it, and share again a few seconds later. With `RBOOK_CHECKPOINT_SYNC=off`, a project that
was never uploaded cannot be shared through the dashboard:

```text
rbook_session(action="start", type="custom", title="Share through the dashboard", projectRoot="/owner/project")
rbook_session(action="complete", summary="Uploaded to share it", projectRoot="/owner/project")
```

On reasonbook.ai, open the project's Access page and share it with the editor, using their exact
username or email. "Can push" makes them an editor with a copy of their own; "Read only" lets them
see the project's pages. If the recipient has not let the owner in, they must accept the invitation
on their home page at reasonbook.ai before joining. A waiting invitation grants no access.
An owner can also make an invite link on the Access page; open the link, sign in and choose Join
to get the link's role. A read-only share does not create a local copy.

After accepting, the editor opens the project's page, which shows a sentence to give their agent.
In an empty folder for the project, the editor's agent joins with it:

```text
rbook_project(action="join", via="dashboard", project="rbook://alex/project", projectRoot="/member/project")
```

From the command line, the same steps are `reasonbook share --dashboard` (`--yes` to send) and
`reasonbook join --dashboard rbook://alex/project --into /member/project`.

Every copy then syncs with the dashboard at session start and end where hooks run, every five
minutes while a server that opened it is running, and when asked:
`rbook_project(action="sync", projectRoot="/member/project")`. A change counts for everyone once the
dashboard accepts it, and each copy keeps working offline until its next sync. The project's pages on
reasonbook.ai show the record as the dashboard accepted it, a feed of what was created and of status
changes under each change's author, its members and its open conflicts.
Conflicts are settled through an agent, as below. The owner removes a member on the dashboard, from
the project's sharing page. The owner's copy can move the project back with
`rbook_project(action="move", to="owner", projectRoot="/owner/project")` or `reasonbook move --to owner`.
Members then sync with the owner's copy directly. To catch up a member's copy that still syncs
through reasonbook.ai, run this on the owner's machine:

```bash
reasonbook sync --ssh <host> --remote-root <folder>
```

Add `--node` and `--bin`, as in [Directly over SSH](#directly-over-ssh), when the member's
non-login shell cannot run `reasonbook`, and `--project-root /owner/project` outside the project
folder. That copy serves only what a catch-up needs, stores what it takes in, and holds the move
until its own person confirms it there with `reasonbook sync --confirm-owner`. The catch-up's answer
can add a note that the member's copy did not note the exchange; its review shows the previous one
until the next sync. A second `reasonbook sync` on the owner's machine then exchanges both copies'
changes. Both machines need 4.2.1 or later.

This was measured live with one member present and automatic syncs off, with the move made through
`rbook_project`, before the member's copy had synced with the dashboard since the move. With
automatic syncs on, that copy also syncs at session start and end and every five minutes while a
server that opened it runs, so it may well sync first. Not measured: a member's copy that syncs with the dashboard first, whose sync then says the
owner moved the project back and to sync with the owner's copy over SSH or with a bundle, and a
member's copy that the owner's machine cannot reach over SSH.

### Directly over SSH

Direct sharing over SSH needs no dashboard account. SSH must work without a password prompt (`BatchMode=yes`), and the remote account must be able to
run Reasonbook. On the owner's machine, ask your agent to share the project and invite an editor:

```text
rbook_project(action="share", projectRoot="/owner/project", authorName="alex")
rbook_project(action="invite", projectRoot="/owner/project", name="sam", role="editor")
```

After sharing, make a consistent copy while the server can keep running:

```bash
reasonbook copy --project-root /owner/project --to /tmp/project-copy
```

Carry that folder securely to `/member/project` on the other machine. The command copies the store
under `rbook/db/`, including its record contents; it does not copy the project's working files. Use
an empty destination rather than overwriting an existing store. The new copy cannot accept writes
until it joins. From the owner's machine:

```bash
reasonbook join --project-root /owner/project \
  --ssh sam@member-machine --remote-root /member/project --member sam \
  --node /absolute/path/to/node --bin /absolute/path/to/reasonbook
reasonbook sync --project-root /owner/project
```

`--node` and `--bin` name the remote installation. With `--node`, `--bin` must point to Reasonbook's
JavaScript entry (the installed `reasonbook` link or `dist/bin.js`). Omit both if the remote
non-login shell can run `reasonbook` directly. Add `--config-dir` only for a nondefault remote
Reasonbook config directory. Join saves the owner's route to the member; a sync over that route
exchanges changes in both directions. A member initiating its own sync needs an SSH route back to
the owner, set with `reasonbook sync --ssh … --remote-root …` and the corresponding runtime paths.

Work locally on either copy, then run `reasonbook sync` to exchange changes. With a saved route,
session-start and session-end hooks also start a detached exchange, and a running server exchanges
every five minutes for shared projects it has opened. Set `RBOOK_SHARED_SYNC=off` in the hook and
server environments to stop automatic exchanges. Explicit commands still work. Dashboard uploads
have a separate switch, `RBOOK_CHECKPOINT_SYNC`.

For bundles carried by hand, after joining, export on the member and import on the owner:

```bash
reasonbook sync --project-root /member/project --bundle-out /tmp/member-changes.json
# Carry member-changes.json to the owner's machine, then:
reasonbook sync --project-root /owner/project --bundle-in /tmp/member-changes.json
reasonbook sync --project-root /owner/project --bundle-out /tmp/owner-changes.json --for sam
# Carry owner-changes.json back, then:
reasonbook sync --project-root /member/project --bundle-in /tmp/owner-changes.json
```

### Join by bundle

Where SSH cannot reach the member's machine, the join itself can travel by hand. Make the copy with
`reasonbook copy` as above and carry it to the member's machine, then:

```bash
# On the member's machine: write a join request.
reasonbook join --project-root /member/project --request-out /tmp/join-request.json
# Carry join-request.json to the owner's machine, then answer it for the invited member:
reasonbook join --project-root /owner/project --answer /tmp/join-request.json --member sam \
  --out /tmp/join-answer.json
# Carry join-answer.json back, then apply it on the member's machine:
reasonbook join --project-root /member/project --apply /tmp/join-answer.json
```

The copies then exchange changes with bundles, as above.

### Conflicts and removal

When both copies change the same field before seeing each other, the record keeps the competing
values. Ask `rbook_db(action="conflicts", projectRoot="/owner/project")` for their values and
authors. Settle with the returned `table`, `recordId`, `field` and the value you choose:

```text
rbook_db(action="settle", projectRoot="/owner/project", table="missions", recordId="<mission id>", field="name", value="<chosen name>")
```

Sync again to carry the settlement. The owner's copy must settle project-identity and decision
lineage conflicts. To remove a member of a project shared directly, use
`rbook_project(action="remove", projectRoot="/owner/project", name="sam")`; through reasonbook.ai,
the owner removes them on the dashboard. Removal stops new exchanges with that member; it cannot
erase data their copy already holds. Re-inviting the same member resumes exchange, and the changes
held in quarantine after removal are judged again: those their role does not allow are refused.

## Optional: connect the hosted dashboard

The dashboard at [reasonbook.ai](https://reasonbook.ai) is a separate, optional service. It adds four things on top of local mode:

- **Dashboard mirror** — `rbook_db(action="backfill")` and automatic uploads both send a consistent SQLite snapshot, including committed pages still in the WAL.
- **Project registry** — addressable `rbook://you/project-name` URIs across all your machines.
- **Messaging** — `rbook_message(action="send")` between your own projects.
- **Sharing** — share a project's record with editors through it, as [Share a project's record](#share-a-projects-record) describes.

### Sign up

Visit [reasonbook.ai](https://reasonbook.ai) and create an account.

### Connect from Reasonbook

```bash
export RBOOK_DASHBOARD_URL=https://reasonbook.ai
```

(Set it in your shell profile or your MCP client's env block. Reasonbook also defaults to `https://reasonbook.ai` when the variable is unset, but exporting it explicitly is the convention.)

In your agent:

```
rbook_auth(action="login_init")
```

Returns a `userCode` and a `verificationUri`. Visit the URL in your browser, enter the code, approve the device. Then:

```
rbook_auth(action="login_complete", deviceCode="<the deviceCode from login_init>")
```

This polls until the device is approved (or 30s, whichever comes first; agents re-call until approved). On success, a user-scoped key persists atomically to `~/.config/rbook/credentials.json` with mode 0600.

Without a dashboard credential, dashboard operations return a structured `DASHBOARD_NOT_CONFIGURED` error that names `rbook_auth(action="login_init")`. Local tools and direct shared-record exchanges work without the dashboard.

### What happens next

With a stored user-scoped dashboard key or legacy environment credentials, the next explicit `rbook_session(action="complete")` or `rbook_sprint(action="complete")` attempts to register the project, store its project-scoped key and upload the whole SQLite file in the background. Later explicit closes attempt another upload. For a registered project, an MCP tool call that actually writes its store also schedules an upload. It becomes due after 5 quiet minutes or 30 minutes of continuous writes, and starts within the next 60 seconds when no upload lease or failure backoff blocks it. Transfer time follows dispatch. A running server must have opened the project; an owed upload survives a short-lived process for the next server, and concurrent servers share one upload lease per project.

Each upload sends a consistent snapshot of the whole SQLite file, including pending, declined and expired proposals. There is no table-level exclusion from this whole-file upload. `rbook_status` and `rbook_review` show the last upload result and any failure. Transient failures back off for 1, 5, 15 and then 60 minutes, never earlier than Retry-After. Authentication failures are rechecked before pausing; hourly probes can resume uploads when the key works again. Confirmed deletion or replacement holds this project’s automatic uploads, closes and manual backfill. Other projects keep uploading. Tier and confirmed forbidden responses remain paused until a successful explicit attempt. Close receipts name the upload status and any hold. A server ending after an explicit close drains its accepted upload within a bound; an interrupted upload remains owed for the next server. A failed upload does not fail the local write or close, and implicit process-exit closes do not upload.

Set `RBOOK_CHECKPOINT_SYNC=off` in the MCP server environment to stop timed uploads, explicit session/sprint close uploads and manual backfill for every project that server serves. It does not disable explicit sync, messaging, sign-in, status queries, shared-record exchanges or other requested network actions. Hosted recovery contributions use separate controls: either `RBOOK_SHARED_SYNC=off` or `RBOOK_DASHBOARD_SHARING=off` stops them, even during explicit sync. When a call discovers a lost or behind referee, reasonbook.ai can begin recovery; eligible copies contribute on sync and the owner reviews and confirms the plan on the Shared record page. See the [recovery limits](privacy.md#sharing-through-reasonbookai). (`rbook_project(action="register", projectRoot=…)` is different: it records the project in the local registry only.) See the [network disclosure](../SECURITY.md#outbound-network).

### Verify

```
rbook_status()
```

`auth_tier` will read `device-code` and `dashboard_url` will reflect the configured URL. `rbook_message(action="whoami")` confirms sender attribution.

If you sign out:

```
rbook_auth(action="logout")
```

This revokes the user-scoped key on the dashboard and clears the local row. Project-scoped child keys keep working for requested dashboard calls until you revoke them individually with `rbook_auth(action="revoke", keyId=...)`. A revoke is sent with your user-scoped key, so revoke them before you sign out. Closes and manual backfill also need a stored user-scoped key or environment credentials, so a remaining project key alone does not keep those uploads enabled.

# Changelog

All notable changes to Reasonbook (published as `@aquex/cmos-mcp` before 4.0.0) are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.9.0] — 2026-10-31

`reasonbook doctor` lists what in your setup is out of date, doubled up or left over from the move
from cmos-mcp, with the command that fixes each, and changes nothing. Approving a drafted record
now saves its words whole or says why it cannot, and a long session is read a page at a time
instead of in one oversized answer.

### Added

- `reasonbook doctor` lists setup drift on this machine and the fix for each, in the order to apply
  them: an old global install or the old `cmos-mcp` one; a Claude Code or Codex plugin that is old,
  disabled, both editions at once or still the old `cmos` plugin; a `config.json` that stops the
  plugin's server; a manual Reasonbook server where the plugin belongs, beside it, or running an old
  release, and a project `.mcp.json` pin that migrate refuses; saved permissions for tools that no
  longer exist; records on the old `cmos/` layout or with an interrupted move, and client settings
  migrate would refuse before such a move; the config folder and its setting, registered projects
  that are gone, and a default never confirmed. A file it cannot read is reported as not checked,
  never as clean, and without its text. It writes nothing and exits 0 only when every check ran and
  nothing needs fixing; `--format json` gives the same as data. It makes one GET of the npm registry
  for the latest version unless `--offline` is given, and is not part of the local directory edition.

### Changed

- `rbook_session(action="list", sessionId)` reads a session too large for one answer a page at a
  time: the captures in stored order, then the summary, each page under 20,000 characters, with
  `nextPageCall` for the next. Completing the session, or a change of the store's own identity,
  while it is read moves no page. A capture, its context or the summary larger than a page comes in
  parts (`part`, `parts` and `fullLength`; `summaryPart`, `summaryParts` and `summaryFullLength`);
  a context too large to ride on a capture's first part follows its content's parts in parts of its
  own, and joining each field across the parts gives it back exactly. Such a read adds
  `pageCount` and `capturesShown`, counts only readable captures, and carries the summary cut
  (`summaryTruncated`, `summaryFullLength`) on the pages that do not read it; asking for a page past
  the last says so instead of "No sessions found". A session that fits on one page answers as
  before, however long its fields, and one with a field too long to page, its own or a capture's,
  is answered whole as before, with a warning; this repository's largest session answered 314,266
  characters in one piece.
- Review and sprint close warn about a stale build only in a project whose build writes
  `dist/.build-manifest.json`. A project with `dist/`, `.next/`, `build/` or `out/` output and no
  manifest got a warning it could not act on; those folders are no longer read, and such a
  project's `src/` is not walked. A check that cannot read the manifest or the source is kept in
  the answer and said, "Build freshness could not be checked", where it used to read as fresh.
- For a plain approval, the approval offer and the record-decision skill teach
  `rbook_decisions(action="record", fromDraft="P1")` alone, which records the draft's own words;
  `content` is only for a draft with the operator's nuance folded in.

### Fixed

- `rbook_context(action="search")` with `searchTypes` holding `session` searched no sessions and
  said nothing; it now warns and names `rbook_session(action="search", …)`, and with `session` as
  the only type its no-results suggestions name that search.
- Five "read it in full" hints (the session list and session search, context search's mission
  hits, and onboard's blocked and in-progress missions) quoted the id by hand, so an id holding a
  quote or a backtick named a call that reads nothing; they now quote it as every other hint does.
- `migrate` names a client file it cannot parse, or a `.mcp.json` server entry that is not an object
  or whose `args` is not a list, and refuses; it used to stop with the parser's message, which quotes
  the file's text, or with a TypeError.
- A constraint, rule or profile draft whose own text holds a tool-call tag outside backticks, or such
  a decision draft sent in its own words, is refused and stays pending. With the tag late in the
  line, a constraint or rule was written cut short and a profile line with the raw tag, under a
  receipt that said "written as drafted", and the decision was recorded cut short. The refusal asks
  for the line again with the tag in backticks; a decision restated in other words still records.
- A drafted line that opens with a code span or a bold mark keeps it. A mark right after
  "Would record:" was read as closing the label, so the stored text lost its opening backtick, and a
  line that opened with a quoted tag made no draft at all. A placeholder in a code span or emphasis
  is still not a draft: beside placeholders a line needs three words and 15 characters, and two
  more words and ten more characters for each placeholder after the first, so slots joined by
  connectors stay a template. There a word is a run of letters or digits, or one Han, Hiragana or
  Katakana character. A tool-call tag, bare or with `name="…"` attributes, a URL, or a generic whose
  `<` follows an ASCII letter or digit, such as `Array<T>`, is not a placeholder.

- The newest saved user key is the one issued last, whether its time ends in `Z`, carries an offset
  such as `+02:00`, or uses SQLite's `YYYY-MM-DD HH:MM:SS`. The sign-in state and the dashboard
  client's newest-key fallback compared `issuedAt` as text, so such a credentials file could pick an
  older key; they now compare instants, as the upload fallback already did, and a time they cannot
  read ranks oldest.

## [4.8.0] — 2026-10-30

### Changed

- The tool descriptions `tools/list` sends say more of what an agent needs before a call: each
  action's required inputs, the main things the calls write, delete or send (adding a sprint
  demotes the other open sprints by default), and where to go instead (review, onboard and context;
  mission and mission transition; where next steps live). Most parameters now carry a short hint,
  `rbook_message`'s `messageId` first, since it drew the most refusals with no hint. Review, onboard
  and status say why they are annotated destructive. The list is 31,964 characters, within the
  32,000 ceiling; schemas, enums and annotations are unchanged, and the local directory edition gets
  the same text where its actions exist.
- Record an approved draft by sending `fromDraft` without `content`: `rbook_decisions` record takes
  the draft's own words, with every approval check a verbatim restatement gets. The refusals on this
  path now name that resend, a record without `fromDraft` names the content it needs, and a draft
  whose own text holds a tool-call tag the sanitizer cuts, so that its cut copy cannot be recorded,
  says it must be proposed again with the tag in backticks instead of naming a resend that fails. A
  line that begins with a code span can still lose its opening backtick when stored; that case is
  open.
- A value the content sanitizer empties (a mission's `name`, a block or reopen `reason` made only of a
  stray tool-call tag) is refused as `INVALID_PARAMETER` naming what happened, not as missing.
- `rbook_mission` add without `missionId` says add needs the new id and shows its form; an unknown
  parameter's refusal suggests the published parameters whose names end with it and that the call's
  action uses (`limit` on a context search: `searchLimit`). The `missionId` and `fromDraft` hints say
  the same.
- MCP telemetry rows record the identity lookup's time (`lookupMs`) and, on a refusal, the published
  parameter it named, or `unknown` for a key the tool does not publish, or `unspecified`
  (`refusedField`, never the agent's own text). `reasonbook stats --export`
  reports misuse refusals by tool, action and field, and lookups over 100 ms, each with the
  anonymous bucket beside it as a bound.
- List, search and report answers whose default ran past 20,000 characters on any registered store
  now return a page: fewer rows, each with every field, the total for its filter, and a `Next page:`
  line naming the call that reads the next page with the same filters and project root (`nextPage`
  and `nextPageCall` in the structured answer). New `page` parameter on `rbook_feedback` list,
  `rbook_mission` list, `rbook_sprint` list, retro and analytics, and `rbook_session` search;
  `rbook_decisions` review and the `rbook_context` view, next-steps list and constraints list and
  review take `page` and `pageSize`. Defaults per page: feedback 10 (with `acrossProjects` 5, or
  2 at status resolved), missions 6, sprints 15, decisions 12 (8 in review), next steps 15,
  constraints 4 (6 in review), sessions 15, session search 5, a retro's missions, sessions,
  decisions and learnings 3 each, analytics rows 20 counted from the newest. Decisions search
  returns its top 15 by default; its `Found` count is the candidates it ranked, which grows with
  `limit`.
- Long text is a preview of at most 300 characters with its full length wherever a show action
  reads it whole: mission objectives and notes, a sprint's focus in the list, the work queue and the
  retro, the objectives in sprint show, a retro's notes, decisions, learnings and carry-forwards (its
  commit summary too), and the review's decisions (cut at 200 characters before, unflagged). A listed
  mission keeps its first three success criteria and deliverables, with their counts.
- On the lists you act on (feedback, the review, next steps, constraints), `pageNote` says that a
  row you change leaves the list and moves the later rows up, so re-read a page after acting on it
  before its Next page call. A feedback list whose count cannot be read now refuses, as the
  next-steps list does, rather than ending its pages early.
- Every count, total and figure still covers all the rows: a retro's KPIs, commit summary and
  carry-forwards, analytics' aggregates and trends over its whole window, the review's counts by
  suggested action. Session search ranks every match, where it used to rank only the newest
  `limit + 10`, and keeps three matched captures per session with `matchedCaptureCount`; the rest
  are in the session's whole read (`rbook_session` list with `sessionId`), which a large session
  can put past the cap. The cross-project decisions list now pages and reports the true total
  across readable stores.
- `rbook_context` view defaults to its digest: the newest four decisions and learnings as previews,
  and the context documents' constraints and next steps whole, one of each per page (no other read
  returns them), with their totals and the calls that read further (`compact.reads`). A constraint
  kept as an object now goes out as its JSON and counts in the total, and a `quality_standards` list
  is read when `constraints` holds none. `compact=false` returns both context documents and every
  row, as the default did before.
- A `Next page:` call or a digest read escapes backticks and line separators in its values, as the
  answer's `Project:` line does, so a crafted project folder name cannot open a code fence. The calls
  added in this release that read a preview whole are written the same way, so an id holding a quote
  still names its row.

## [4.7.1] — 2026-10-29

- Clarify required inputs and effects for sprint and messaging actions, preserving safety guidance
  within the existing tool-text budget. Directory mode describes only its available sprint actions.
- Update the hosted-recovery disclosure after reasonbook.ai adopted the 4.7.0 recovery support and
  verified admission and removal changes missing from the recovered record.
- Record each MCP call's local telemetry under its own project when another process briefly holds
  the store. The identity lookup now waits as long as the call itself does (5 s in the server)
  instead of 100 ms, so a hold that ends within that budget no longer files the row as unattributed.
  While a store stays held, a call can answer several seconds later. A Codex call whose hook runtime
  is busy keeps its row without a session. Hook and CLI timing is unchanged.

## [4.7.0] — 2026-10-28

- Add the local directory edition in the same package: requested project records without hooks,
  profile/draft access, sharing or runtime network calls. Its status response has `edition`,
  `rbook_address` and `local_health`; dashboard/auth/sync fields remain exclusive to full mode.
- Complete hosted recovery when the frozen census has a membership change absent from every
  surviving record, while keeping removed members removed and reporting reconciliation in the plan.
- Correct privacy/recovery disclosures, make next-step carry honor its mission filter, and harden
  local release gates and mirror checks.
- Exclude browser-disconnection notices from draft approval evidence. Explain the Codex exec/resume
  session boundary and direct users to propose and approve within one running conversation.

## [4.6.1] — 2026-10-27

### Changed

- Clarify action-specific tool defaults, approval requirements and project-scoped invocation without
  changing tool names, actions, input contracts or effects.
- Explain stored draft excerpts, durable approval words, later transfers and possible record text
  in dashboard diagnostic errors. Runtime excerpt validity is distinct from physical cleanup.
- Add an isolated fictional local reviewer sample and five positive/three negative workflow cases.
  Directory eligibility, portal attestations and live privacy-notice propagation remain separate gates.

## [4.6.0] — 2026-10-24

### Changed

- Shorter tool descriptions leave room for new actions while preserving cross-project
  untrusted-data warnings; the digest size guidance now says “about 4 KB.”
- Use measurement recognizes citations in reasoning fields and explicit evidence links.
  Local statistics report unjoinable uses and cross-session references separately from
  same-store, same-session cite-through; exports retain counts without item identities.
  Digest costs separate startup/resume/clear, compact and unknown legacy sources. Stability
  now compares consecutive emitted digest pairs with hashes and no observed successful write
  between them: `stableDigestPairs` and `comparableDigestPairs` replace the session counters,
  with write-separated and missing-hash pairs reported separately.
- MCP refusal fields carrying caller input preserve up to 512 serialized JSON characters;
  larger fields become previews of at most 160 characters, retaining ordinary remedies.
  Oversized values disclose their original serialized length; oversized `validValues` retain
  an array containing one preview. Refusal project stamps, unknown-tool errors, CLI feedback
  errors and unexpected-argument echoes are bounded too. Success answers retain their values.
- Mission status names parked work and distinguishes an empty queue from a closed sprint.
  Sprint-close untagged-session warnings use the sprint window and state the counting rule.
- Brief JSON adds `droppedDrafts` and `unreadableProjects`; `unreadable` keeps its original IDs.
  Draft counts from reports older than seven days are omitted and disclosed; fresh aggregates
  retain their counts because individual draft ages are unavailable. Unreadable projects use
  their names in the brief header.
- A repeated bulk feedback resolve now says nothing changed and the supplied note was not stored;
  `RbookFeedbackBulkResult.resolutionNote` is null when no row stored the note.

- The Builder digest shows up to three next steps beside its mission; Ledger and Planner show
  up to five. Lease urgency, current sprint and creation time determine order, and visible next
  steps reduce recent decisions to six. Solo records retain room for pending drafts.
- Next-step lists now return 300-character content previews with `NextStepRecord.truncated` and
  `fullLength`. `rbook_context` adds `nextStepAction="show"` to return named rows whole;
  `NextStepsResult.missingIds` identifies requested rows that do not exist. Returned rows include
  `projectId`, and list/show receipts include `localProjectId`, so explicit expansion counts only
  local and NULL-origin rows as use.

- An unexpired draft can receive an answer after two hours in the same live conversation. Late
  approvals record as agent-judged; late declines persist across sessions and excerpt expiry.
  Shown identifiers follow draft expiry, while words and direct-record windows retain two hours.
  Busy-store declines retain their original showing and retry once after delivery.

- Queued missions can be blocked before starting. Default unblock returns to Queued only with a
  matching block-origin timestamp and no start timestamp; explicit targets take precedence.
- Mission transitions add `reopen` with a required reason for Completed work in an active sprint.
  Reopen clears `completed_at`, appends a shared note and local audit event, and preserves the old
  completion time in domain metadata. Concurrent peer replacement can lose that metadata; local
  events are not shared. A disconnected sprint close can still require reconciliation.
  The new `MissionReopenResult` returns missionId, previousStatus, currentStatus, reason,
  completedAt (nullable), reopenedAt and message; invalid mission state uses the existing
  string form of `currentState`.

- Decision recording adds optional `RbookDecisionsRecordResult.currentSuccessorId` when a repeat
  names a superseded historical row. Correction refusals carry `decisionId` and `supersededBy`
  in the existing object form of `RbookToolError.currentState`.
- Superseding decisions can correct reasoning without changing the headline. Retries reuse
  matching rows, reverts create new occurrences, and earlier successor links cannot be redirected.
  Mission start and completion retain caller session links transactionally; retrospectives include
  sessions linked to the sprint's missions even without a sprint tag. Keyless explicit sessions
  remain unlinked.
- CLI initialization explains the workflow without hooks and fills new AGENTS.md files with the
  stored project name. CLI and MCP initialization produce the same content for the same name
  and level; shipped templates retain their hard rules and learned practices without unfinished
  project placeholders. Existing files and hookless guidance survive later plugin initialization.

### Fixed

- Shared one-line and SSH displays strip bidirectional controls and zero-width spaces while
  preserving joiners and emoji tag sequences. Import field diffs show Unicode format characters
  as escapes; stored values and structured reports remain unchanged.
- Snapshot ages require an offset-bearing ISO timestamp or SQLite UTC timestamp; ambiguous
  dates show unknown age. CLI feedback length refusals name `--content`, and bare init level
  names suggest `--level`. Older sibling-store guidance now names executable session start and
  completion calls at the registered project root to apply its missing schema migration.
- Build freshness uses a manifest source-content hash when mtimes suggest stale code, so an
  identical checkout or rewrite stays current. Changed bytes or paths still report stale on
  that path; preserved-mtime changes, excluded assets and manifest-less projects retain their
  existing limits. Loaded-server health still compares the compiled build hash.

- The privacy page reflects the move to Render, its current recovery and log retention,
  and confirmed nightly offsite copies to Cloudflare R2. Deletion controls are unchanged.

### Development

- Restored the bounded concurrent load check with audited process-group cleanup and retained
  failure reports. Test fixtures avoid redundant compilation and publish child argument markers
  atomically; fixture startup allowances leave product deadlines unchanged.

## [4.5.1] — 2026-10-23

### What's new since the demo

The demo was recorded on a 4.0.0 candidate; it remains a replay of those runs.
Since then, records gained direct sharing, hosted referee support and arrival-based id claims.
Decisions still belong to the person making them; agents keep the local record.
This update keeps older copies visible before and after a record-protocol switch.
It makes upload retries, interruptions and deleted-project holds visible in the review.
Explicit closes wait for their bounded upload drain before the server exits.
Manual backfill now sends a consistent snapshot, including committed WAL pages.
New projects get clearer first steps, and concurrent initialization preserves the first writer.
A fresh store cannot take over another dashboard project merely by using its name.
The README, first-ten-minutes guide and privacy disclosures explain the current behavior.
Hosted recovery still needs the dashboard's routes and owner controls before people can use it.

### Fixed

- Weekly briefs keep aging a stored report's quiet-day count when uploads stop, and say how
  many whole days came after its last upload. The 21-day listing threshold stays unchanged.
- Concurrent initialization claims identity atomically and preserves the first context writer.
  New-record digests and seed instructions explain what to do next; running the bare CLI in a
  terminal shows a hint instead of appearing to hang.
- Registration for a fresh named store uses the dashboard's atomic create-only endpoint.
  Existing and archived names refuse without purging data; a concurrent registration has
  one winner. Existing registered stores retain their identity.

- Shared records wait for active former owners and re-invited members before switching to
  protocol 2. Retired referees stay exempt. Re-inviting an older reader after the switch
  names the upgrade-and-sync remedy; removing a member preserves its factual reader reports.
- Older copies are told when sync withholds newer-protocol changes, including SSH, local
  exchange and catch-up, hosted sync, and bundle-out warnings. Their own pushes still land.
  Published 4.4.0 clients can truncate the upgrade instruction when an SSH route is long;
  upgrade that client before retrying. Older review text can also truncate route errors.
- Dashboard sharing counts an owner's copy joined by request and answer files before its
  first exchange. Preview guidance stays offline; a confirmed refusal checks the referee
  version before suggesting a permanent set-aside. Hosted refusals no longer name an
  unavailable control, and a refused join after a protocol switch names a fresh request.
- Explicit-close uploads drain before server exit, with token-bound lease recovery and durable
  retry debt. Manual backfill shares the lease and uploads a consistent WAL-inclusive snapshot.
  Transient outages back off, auth failures are rechecked, and owner-confirmed deleted/replaced
  projects remain held across automatic and explicit uploads without adopting a reused name.

### Changed

- Sharing and privacy documentation now reflects the dashboard's narrowed directory,
  invitation acceptance and recipient-controlled messaging. The directory's tool text names
  the projects it can show: those you own or that are shared with you.
- The signals library's `unreadableReport` accepts optional `projectId` and `projectName`
  in its options, so hosts can retain known identity while every failed count remains unknown.
- Owner-copy share refusals add `reason`, `replicaId` and `dashboardProjectId` in the existing
  object form of `RbookToolError.currentState`; confirmed refusals also carry `refereeVersion`
  and any `refereeCapabilityError`. Set-aside previews report `lastCallAt` separately from
  `lastExchangeAt` and explain that a cut cannot be undone.
- `RbookReviewResult.recordProtocol.stranded` lists active older readers after a switch.
  Member reviews leave blockers empty; hosted reviews offer no unavailable set-aside action.
  Long blocking or stranded lists remain complete and explain their digest budget overage.
- Hosted delivery returns `REFEREE_READS_OLD_PROTOCOL` with HTTP 409 and an upgrade remedy
  when a recipient cannot read the withheld stream. The dashboard must treat re-invite
  refusals as lasting before its owner can see that refusal, and deploy the updated referee.
- Session and sprint completion answers add `dashboardUpload`, with started/why, last success,
  pause reason and next-attempt information. Status, review and session-start notices disclose
  upload interruptions and holds. Dashboard HTTP errors retain status and Retry-After evidence
  in the existing object form of `RbookToolError.currentState`.

## [4.5.0] — 2026-10-22

This release finishes the client and referee library for hosted recovery, re-sharing, setting aside
a gone copy, and arrival-based id claims. The dashboard must deploy its retained history, routes
and owner controls before these flows are available through reasonbook.ai.

### Changed

- **Protocol status is separate from conflicts in the review.** `RbookReviewResult.recordProtocol`
  adds the write protocol, counted switch, complete named blockers and explanatory text. Healthy
  protocol status does not count as a state needing a person. The usual digest budget stays 4 KB;
  an unusually long blocker list remains complete, with its exact size and explicit overage.
  Compact shared-record summaries retain quarantined and other non-live transaction counts;
  `SharedRecordReview.waitingCounts` adds optional typed counts for those states.
  `SharedRecordReview.recoveryConditions` retains held-recovery condition names in compact
  reviews beside the confirmation command and the instruction to correct invalid chains first.
- **The referee library can recover a lost hosted record from surviving copies.** Intake, plan
  and finalization validate streams against recorded head history, expose losses and missing
  copies, and preserve quarantined work. Client uploads and recovery moves are supported; the
  dashboard must deploy its routes, retained head history and owner confirmation controls before
  this is available through reasonbook.ai.
- **Shared records switch to arrival-based id claims when every active copy supports them.**
  The library reads record protocol 2 but keeps writing protocol 1 until every active copy
  reports `reads >= 2`. The review names blockers; a gone copy must be set aside. After the
  switch, the first counted acceptance fixes a claim's position, including through handover.
  Earlier claims keep their names and outrank later back-dated creates. An accepted id is final
  once a copy holds the data of every earlier-positioned claim; predictable ids can still be
  claimed first, and recovery judges unjudged transactions in clock order.
- **Older readers receive only complete readable transactions.** Delivery stops each stream
  before its first protocol-2 transaction, protecting 4.2.0 as well as later old clients.
  Switched records refuse joins, successors, handovers and move-backs to older or unreported
  readers. A downgrade after the switch can still upload local work but receives nothing past
  that boundary and may rename local ids; an old authority holds members' protocol-2 changes.
  Recovery preserves the switch only inside its adopted prefix. Checked writable opens and
  authorized merges retry supported historical protocol refusals and unjudged newer-protocol
  transactions, preserving unrelated refusals and current membership guards.
- **Catch-up receipts name only a move the receiving copy actually holds.** Direct exchanges and
  bundle imports distinguish a withheld move from a pending or competing move. Hello adds optional
  `forks` entries with epoch, authority and change id for held competing moves; older hellos may
  omit the field.
  `ChangeRecipient.catchUp` adds an optional flag for an SSH recovery pull before a late join's
  admission proof arrives. Its historical hello supplies delivery capacity only; it grants no
  membership, ordinary stream access or complete recovery fetch.
- **Owner copies that exchanged successfully count before a dashboard share.** A saved SSH
  route or recorded work also counts, including an observed or routed former owner copy.
  Dashboard-route rows, cut copies and this folder's former identities do not count. A refusal
  names the copies that would be stranded and offers a preview of setting aside a gone copy.
- **Set aside one gone copy without removing its person.** On the direct authority copy,
  `reasonbook set-aside --replica <id>` previews the held cutoff and last exchange; add `--yes`
  to record it. Role changes, removal and re-admission retain these cuts. Later writes stay
  quarantined for the person to redo, and recovery does not wait for the cut copy. The referee
  library's dashboard-only `setAside` requires `confirmGone: true` if the copy called in the
  last seven days; it is unavailable through the peer API. A dashboard host must deploy this
  operation before its owner page can offer it.
- **Copies report their library version and supported record reads.** Reports travel in hello,
  near-end SSH hello, exchange receipts, join requests and bundle headers; old or absent reports
  remain unknown, and a downgrade replaces previous knowledge. With any set-aside held, a
  planned handover requires the target to report library 4.5.0 or later, and a share checks that
  referee version before uploading. A refused authority target returns `RECORD_COPY_TOO_OLD`;
  peer answers keep the named version and direct the caller to upgrade its copy.
  **Recovery run by a pre-4.5.0 binary can undo a set-aside**;
  this guard covers planned moves, not recovery by an older installed engine.
- **Joining can reattach a copy after the same dashboard project is shared again.**
  `DashboardJoined` now has two mutually exclusive result arms: a new copy returns `joined`
  as before, while an existing copy returns `reattached: { replicaId, block }` and omits
  `joined`. Both retain `dashboard`, `dashboardProjectId` and `sync`. Consumers must check
  which arm was returned. Reattachment preserves the existing store and local log; ordinary
  sync can take a successor, and `reattached` reports the resulting replica and block. Existing
  dashboard history requires the exact retained origin and project id, plus verified referee
  history. A copy set aside before the first dashboard share has no such route: it may attach
  only after an authenticated referee proves the same record, its admission and an explicit
  cut. Ordinary handovers still require the returning person's confirmation.

## [4.4.0] — 2026-10-22

This release checks tool calls before opening a store, makes CLI help safe to ask for, and
keeps record ownership and refusal advice accurate. The public signals and referee libraries
bring their own SQLite type dependency. Hosted recovery and record protocol 2 remain planned
for the following sharing release.

### Fixed

- **Recording a follow-on choice keeps an earlier, different approval available.** Backward draft
  settlement now uses the same subject-coverage gate as the forward walk. A capture that races a
  session's close or takeover returns the existing session refusal after rolling back its writes,
  for decisions, learnings and next steps.
- **First-copy inputs and hosted remedies respect their boundaries.** Copied source tables must
  be ordinary tables; virtual tables are refused before their rows are read. Referee peer answers
  retain error codes and diagnostics while replacing host repair instructions with advice the
  calling member can use.
- **Sprint close keeps concurrent implicit sessions visible.** `RbookSprintCompleteResult` adds
  `implicitSessionsAtClose`, listing active implicit sessions across the project at the close
  boundary. The existing `activeSessionsAtClose` list keeps its direct sprint membership rule;
  neither list closes another process's session.
- **Refusals retain the remedy and CLI help is safe to ask for.** Failure renderers preserve the
  offered next step, including generic router failures. A second response to a message has its
  own conflict code and directs a follow-up to a new message. CLI help exits without opening a
  server or writing a record, unknown flags are refused outside hooks, and brief days are bounded.
- **The public library types bring their own declaration dependency.** Consumers of `./signals`
  and `./referee` install only Reasonbook; `@types/better-sqlite3` is now its dependency. Both
  exports are checked with `skipLibCheck: false` under Node16 and bundler resolution.
- **Routine answers carry less noise.** Mission status includes sprint focus once, preserving
  each nested mission sprint's `focus` field as null. Source-running projects can set
  `project_identity.type_fields.build_freshness_check` to false to omit the build advisory.
  A fresh record starts with the current context shape, and a project with no upload history
  or debt has no empty upload-status line.
- **Foreign CLI and brief text stays bounded and inert.** A shared renderer strips terminal
  controls, folds lines and caps displayed values. The brief neutralizes automatic links, caps
  displayed ids, includes unclassified friction, shows report age and differing windows, and
  enforces its 60-line limit while preserving raw structured data.
- **Signals parse timestamps consistently and bound classification cost.** Calendar timestamps
  now follow SQLite's UTC grammar instead of locale-dependent parsing; capture refuses unreadable
  expiry values before writing. Feedback classification caps input at 4,000 characters and avoids
  repeated scans in its matching rules, with unchanged results on the frozen labelled sample.
- **Feedback resolution preserves prior receipts and names its project.** Bulk resolve adds
  `projectId`, `projectName` and `skipped`; already resolved rows keep their original time and
  note. Fleet `AgentFeedbackEntry.id` values are project-qualified strings, while local list ids
  remain numbers, so fleet ids cannot accidentally resolve a same-numbered local row.
- **Citation reads index identities once per read.** Both persisted edges and the old-store
  typed fallback revalidate against one fresh index. Review skips locked sibling stores without
  waiting and bounds optional portfolio work. The signals contract now states SQLite's WAL
  sidecars and the shared snapshot lock that can outlast a rollback-mode writer's busy timeout.
- **Upload consent is respected in answers and manual backfill.** Purge no longer recommends
  uploading the deleted mirror again, and a sync-count mismatch recommends only reconciliation.
  `RBOOK_CHECKPOINT_SYNC=off` also refuses manual backfill before any dashboard request. Codex
  forwards both sharing switches. Temporary record copies from sharing, joining, importing and
  replaying now receive the same ownership and age checks as interrupted upload copies.
- **Privacy wording names the remaining limits.** Logout leaves project keys valid; feedback has
  no per-call offline flag. A share can still strand an owner's copy that has only synced, written
  no changes and has no saved SSH route. Counting those copies and setting one aside are planned
  together for 4.5.0.
- **Malformed tool arguments refuse before opening a store.** All fifteen tools now check every
  supplied field against their whole schema, including fields for another action. Type and bound
  errors name the field and expected value; for example, a fractional `pageSize` now refuses at
  the server. CLI capture, decision recording and feedback use the same validator. A top-level
  null means omitted unless the field accepts null; supported nested mission-field clears remain
  available. In particular, `maxSnapshots=null` can no longer prune all retained snapshots.

### Known limitations

- A scratch referee with 8,195 change rows still materialized all 8,195 for each page call,
  including three caught-up calls that returned zero rows. Page size does not bound that read.
- The stream setting defaults to 1,073,741,824 units but counts JSON UTF-16 length after a
  nonterminal page is appended. It is not a strict UTF-8 byte limit, and terminal pages and
  legacy-array replies bypass its accounting. No 1 GiB allocation was measured.
- In a scratch removed-member probe, each of three active recipients received ten quarantined
  change bodies (21,514 JSON UTF-8 bytes each). None became live decisions. Quarantine prevents
  materialization; it does not keep those payloads from active members.

## [4.3.0] — 2026-10-21

Portfolio intelligence: what needs a person, in each project on this machine and, once reasonbook.ai
runs it, across the operator's accounts. One read-only library, `@aquex/reasonbook/signals`, counts
nine signals in a store and renders the weekly brief; `reasonbook signals` and `reasonbook brief` run
it here, and `rbook_review` lists the other projects that need a person. Agent feedback is now
sorted into kinds by published rules, and many rows resolve at once. The referee's engine is
unchanged in kind: reasonbook.ai need not pin 4.3.0 for sharing, only to run the signals.

### Added

- **Agent feedback counted by kind.** `rbook_feedback(action="list")` counts every matching row by
  kind (`countsByKind`) and names each entry's `kind`, in one project and across projects:
  ceremony, surfacing, identity, sync or payload, with `unclassified` beside them. The kinds come
  from published rules over a row's text (`src/signals/feedback-kinds.ts`), and a row that names
  Reasonbook nowhere is never counted as friction with it. Each retained kind reached precision 0.9 or more when a prediction counted as correct if it matched
  either the row's primary label or an additional applicable label; under primary-only counting, only sync reached 0.9. A separate agent labelled 157 rows without seeing the rules; setup and silent-loss fell
  short, so their rows read as unclassified. On the machine that measured them the rules classify a
  quarter of 884 rows, and unclassified still holds friction they miss.
- **Resolve many feedback rows in one call.** `rbook_feedback(action="resolve", feedbackIds=[…])`
  resolves up to 200 rows in one transaction. An unknown id refuses the call, names the id, and
  resolves none.
- **Signals: what needs a person, in each project.** `@aquex/reasonbook/signals` is a library that
  reads one store, read-only, and reports nine signals at the time you give it: drafts awaiting a
  decision, next steps about to lapse, records due for review, rows citing a replaced decision,
  blocked missions, open agent friction by kind, days the project has been quiet, constraints about
  to expire, and a shared copy's unsettled conflicts. Each comes with its count, up to 20 row ids
  and its rule. A signal the store cannot answer is reported unavailable with the reason, never as
  zero, and one whose rule failed on the store is also marked `failed`. The report's drafts rule
  says whether a draft runtime was given, and the drafts entry names one that was not found. The
  same file, time and draft runtime give the same report, byte for byte. On the 25 stores of the
  machine that re-measured the published 4.3.0 package, a report took 33.87 ms at the nearest-rank
  95th percentile across 125 reports: five rounds over fixed copies of all 25 active stores,
  including the first call without a warm-up. This includes opening and closing the read-only
  connection; it does not mean the operating-system cache was cold. The re-measurement used current
  data and dependency versions, so it does not attribute a performance change to code.
- **`reasonbook signals`** prints those signals for every project registered on this machine, or for
  one with `--project-root`, with this machine's draft runtime; `--format json` prints the reports.
- **The weekly brief.** `renderBrief(reports, { now, windowDays })` in `@aquex/reasonbook/signals`
  turns reports into one page of markdown: what needs a decision, what is stuck, what has gone quiet,
  what is drifting, the week's friction and what moved. Each section lists five items, the most
  pressing first, then says how many more; every listed row is named by its id; the brief is at most
  60 lines. It reads no clock, time zone or locale, so the same reports and time give the same bytes
  on any machine, which is how the dashboard will show the same brief. `buildBrief` gives the
  sections as data. `reasonbook brief [--days 7] [--format md|json]` renders it over this machine's
  projects. A report now also gives each ranked signal's `oldestAt`, and `reviews_due` gives
  `becameDue`, the records that became due within the window.
- **The review shows what needs a person in your other projects.** `rbook_review`'s portfolio names
  up to eight other projects with drafts awaiting a decision, next steps about to lapse, blocked
  missions or unsettled conflicts, with their counts, and how many other projects' signals could
  not be read. The optional signal reads took 10.58 ms per fleet review in the same published-package
  re-measurement: their elapsed time on already-open handles summed across 25 stores and divided
  by five rounds, after the drift probe. This is the optional-read cost, not whole-review latency.

### Changed (answer shapes)

- `rbook_feedback`'s list gains `countsByKind`, and each entry gains `kind`. A resolve with
  `feedbackIds` answers `resolved`, one `{feedbackId, previousStatus, currentStatus}` per row.
  Additive.
- `rbook_review`'s `portfolio` gains `signals`: `{projects, top, unread?}`, each of `top` naming
  `projectId` and `name` with any of `drafts`, `lapsing`, `blocked` and `conflicts`, or `null` when
  no other project needs a person and every other project's signals were read. Additive. Under the
  4,096-byte budget the list is trimmed after recent learnings and decisions, the sprint's focus,
  the work queue, active missions and the drift list, so on a machine with many projects the
  structured answer can carry fewer recent learnings and decisions, work-queue items, active
  missions and drift entries; the text answer's own project part, from the digest, is unchanged.

## [4.2.1] — 2026-10-20

Fixes to sharing, through reasonbook.ai and directly, from the sprint-97 review, and docs that
say what sharing uploads, what reasonbook.ai keeps and what its referee checks. Fixes marked
_(referee)_ are in the engine reasonbook.ai runs for a project shared through it, so they reach such
projects once reasonbook.ai pins 4.2.1; until then its referee runs 4.2.0.

### Fixed

- **Re-adding a removed member judges their set-aside changes again** _(referee, and the owner's
  copy of a project shared directly)_. Every change set aside while they were removed used to be
  accepted on re-add, owner-only edits their role cannot make included. Each is now judged, in clock
  order, as their role's would be, and the invite answer counts those it refused.
- **A share through reasonbook.ai refuses over known owner copies** _(referee, and the share)_. It
  names copies identified from their own recorded changes or a saved SSH route, since they could
  not sync afterwards. A copy that has only synced, written no changes and has no saved route can
  still be stranded. There is no step yet that sets one of the owner's own copies aside.
- **A referee whose clock once ran ahead no longer stops every copy** _(referee)_. Intake refuses a
  change only when its clock runs more than a week past the host's clock and past the referee's own
  latest reading, and the refusal tells the member that their changes stay safe on their copy. One
  hole remains: at the last count of a millisecond, each delivery can carry the referee's clock one
  millisecond on, which real time outruns.
- **Changes in a newer record protocol are kept out, not refused.** A copy that receives one leaves
  it, with the rest of its writer's stream, on the copy that sent it, exchanges everything else, and
  takes them in after it upgrades; its review says to upgrade meanwhile. A referee still refuses a
  delivery that holds such changes, whole, and the member's changes stay on its copy until the
  dashboard upgrades. A join, a recovery and a first copy refuse a store that holds such changes,
  and say to upgrade.
- **A member that missed a move back can be caught up.** The owner's copy that moved the project
  back catches up, over SSH, a member's copy that still syncs through reasonbook.ai. That copy serves
  it only what a catch-up needs, and holds the move until its operator confirms it with
  `reasonbook sync --confirm-owner`. Both machines need 4.2.1.
- **A removed member keeps knowing it was removed after a move.** Its review, digest and status keep
  the removal when it syncs with the new owner's copy, and it is no longer told to set its route
  again. One whose project moved back off reasonbook.ai forgets its route there when the dashboard
  no longer serves the project to it.
- **A handover to a copy behind the owner's latest move refuses** and says to sync that copy first.
- **A member's copy joined through reasonbook.ai reads as one.** It shows the address it joined by,
  is not offered a fresh project's setup or a reconcile, and does not show the account's unread
  messages as the project's.
- **One approved choice is recorded once.** A revision declined anywhere along a chain of revisions
  of an approved draft, or an approved draft recorded before its revision, let one choice be
  recorded twice. A new revision now joins the chain at its newest pending draft that still states
  its subject, retiring one the operator never approved; recording a draft settles the approved
  drafts before it, and the revisions after it that still state its subject, while a follow-on
  line or a changed key term stays a choice of its own; and a refusal names where the chain stands.
- **`rbook_mission_transition` refuses a `targetStatus` outside In Progress and Current.** A start
  to `Dropped` used to drop the mission and say it started, and an unblock could move a Blocked
  mission to Dropped or Deferred.
- **`RBOOK_DASHBOARD_SHARING`, `RBOOK_CHECKPOINT_SYNC` and `RBOOK_SHARED_SYNC` read `off`, `false`,
  `0` and `no` in any case.** `OFF` and `false` used to leave sharing, whole-store uploads and
  automatic syncs on.
- **A share refused for a project not on reasonbook.ai yet names the cause.** Signed out, it names
  the sign-in; with `RBOOK_CHECKPOINT_SYNC=off`, it says a never-uploaded project cannot be shared,
  rather than prescribing a session close that would upload nothing.
- **Every sign-in remedy names `rbook_auth(action="login_init")`, then `login_complete`.** Some
  named `login`, which holds the call open until the person approves.
- **Sign-out and revoke go with this machine's account key**, never a project's, so the dashboard
  can refuse a project key that revokes account keys. A project key is now revoked while signed in.
- **The share's dry run and the sharing switch say what is true.** The dry run says what the shared
  record leaves out, and that this copy's uploads send the whole store until the handover; the
  switch's refusal no longer says every copy moves a project back.
- **A next step is a row from the moment it is captured.** A next-step capture used to wait in its
  session until the session closed, so a session that stayed open hid its next steps from the
  next-step list, the review and the sprint close: sprint 97's build chat held 12 that way all
  sprint. The capture now writes the row with the capture and returns its id; in an implicit
  session the row takes the sprint open when it is captured, not the one open at the close. A
  session's close finds that row and writes only next steps without one: those captured before
  4.2.1, or whose write at capture failed. The close's `missionId` stamps only the rows the close
  writes. The same step captured again in that session is that row, open or not; when the row is
  completed or dropped, the capture says so and names the call that opens it again. A next-step
  capture naming a mission that does not exist is refused by name, as a sprint that does not exist
  already was. A sprint close no longer counts a running session's next step that has its row as
  deferred.
- **A next step or constraint that came from another copy is not written twice.** Its text hash is
  kept per copy, so a row that arrived by an import or a merge had none, and the dedups keyed on
  it missed the row: closing an imported open session wrote each of its active constraints again.
  A row without the hash now matches by its text.

### Docs

- **What sharing through reasonbook.ai uploads and keeps.** The privacy, trust, security, README
  and getting-started pages now cover the whole-file uploads before a share, what the share sends,
  what reasonbook.ai keeps and for how long, what purge and deletion leave, what other accounts see,
  the activity feed's paging, removal, the sharing switch, and one live copy per machine.
- **What the referee checks, and its limits.** It binds each copy to its account, and refuses a
  member's change that names anyone but that member as its author. It does not check a change that
  names no author, the names on the owner's own copies, a change's account id or the author fields
  of the rows a change writes, and it checks a change's time only against the member's admission
  and a week past the referee's clock: so a member who edits their own copy can put rows, and feed
  entries, under another member's name, and claim an id with a back-dated time, since the earliest
  create keeps an id by its time, not its arrival.
- **Stated limits.** If reasonbook.ai loses a project's referee copy, this release has no step that
  shares that project through it again. After a move back, sharing the project through
  reasonbook.ai again cannot include the people it was shared with: the share refuses a project
  with members, and a new referee copy refuses a removed member's username. Purge is refused on
  every copy while a project is shared through reasonbook.ai; the owner moves it back first. After a
  move back, a member's copy that syncs with the dashboard before the owner's copy catches it up,
  and one the owner's machine cannot reach over SSH, were not measured.
- **Moving back, as measured.** getting-started says how the owner's copy catches up a member's
  copy over SSH after a move back and how that member confirms it. This was measured live through
  reasonbook.ai with one member present and automatic syncs off, the move made through
  `rbook_project`, so the README and the privacy page no longer say moving back was untested.
- getting-started's step 8 says what the digest shows; the README's Codex heading names no release.

### Changed (answer shapes)

- An exchange's applied report and a bundle import gain `newerProtocol`, the changes a newer record
  protocol kept out. Additive.
- `rbook_context`'s identity view gains an optional `joinedAddress` on a member's copy joined
  through reasonbook.ai. Additive.
- `rbook_project(action="invite")` gains an optional `refused` when it re-adds a member. Additive.
- `rbook_session(action="capture")` gains an optional `nextStepId` for a next-step capture. That
  capture's `structuredMaterialization` is now `immediate`, with outcome `materialized`, `existing`
  or `failed`, where it was `session-close` and `deferred`; and a close's `nextStepsExtracted`
  counts only the next steps that close wrote.

## [4.2.0] — 2026-10-19

Share a project through reasonbook.ai. The dashboard keeps the project's referee copy, every member's
copy syncs with it over HTTPS, and the dashboard shows the project, its members and each member's
changes. Sharing directly over SSH or with bundles stays as in 4.1.0. Sharing through reasonbook.ai
is on by default after its live test on real hardware, with two accounts operated by one person on
two machines. Its limits are below. This section lists what changed since 4.2.0-rc.3. The 4.2.0-rc.3
and 4.2.0-rc.2 sections below list the rest since 4.1.0: approval provenance, the instruments, a
removed member told so, and the transport, sharing and joining through the dashboard.

### Changed

- **Sharing through reasonbook.ai is on by default.** Its live test passed on real hardware against
  the deployed reasonbook.ai, with two accounts operated by one person on two machines:
  - 3 of 3 fresh agents joined from the dashboard's join sentence alone.
  - No change was lost over 20 interleaved sessions, 5 of them with the owner's machine offline.
  - 5 of 5 conflicts were kept, shown and settled.
  - A removed member was cut off and told so.
  - Nothing was lost with reasonbook.ai unreachable for 10 minutes.
  - An independent audit re-derived every count from the raw logs.

  `RBOOK_DASHBOARD_SHARING=off` where Reasonbook runs turns it off on a machine. The limits:
  - Moving a project back off reasonbook.ai waits for the dashboard to deploy it.
  - The dashboard's activity feed shows 100 events a page and its decisions page 20.
  - A project the dashboard does not know yet needs an explicit session start and close before its
    first share.

### Fixed

- **Sharing a project reasonbook.ai does not know yet says how to put it there.** The refusal told
  the agent to register the project and share again, which was refused again: registering records
  the project on this machine only, and the project reaches reasonbook.ai at its first upload from an
  explicit close. It now names an explicit session start and close, with the fields each requires.
- **The privacy page says what accounts see today.** Other accounts see a user's display name and
  username, never their email address, and resolving a project address returns no email address.
- **Links in the installed package lead somewhere.** The trust, method and privacy pages now ship in
  the package, and links to pages it leaves out (the demo, the templates, a test and a source file)
  point at the public repository.

### Added

- **Sharing through reasonbook.ai in the user docs.** The README, getting started, method, trust and
  privacy pages cover the prerequisites, sharing, inviting, joining, syncing and removal; what the
  dashboard keeps, for how long and who sees it; what stays on each machine; the measured scope (two
  accounts operated by one person, on two machines) and the limits, moving back included. Joining by
  bundle is documented.

## [4.2.0-rc.3] — 2026-10-19

Sprint 97's second published candidate, the one the live test through reasonbook.ai runs. It adds
approval provenance, the instruments, and the fix for what the dashboard's own live test on
production found: a removed member was told nothing. Sharing through the dashboard is still off by
default: it works only where `RBOOK_DASHBOARD_SHARING=on` is set, until that live test passes.

### Fixed

- **A removed member is told so.** Its sync says that everything the owner's copy did not hold when
  it removed the member is set aside, what it made before the removal and had not synced included,
  and counts only if the owner shares the project with it again; its review, the session digest and
  `rbook_status` show the removal until it is a member again.
- **A share or a join through the dashboard no longer warns about a file it built.** Each answered
  that its record "could not be checked for conflicts" at the file its copy was built in, already
  renamed into place, and the share also said its upkeep was skipped; an agent read the join as
  failed. An answer now checks only the copies still there when it answers.
- **A member who joins through the dashboard is told what it has.** The join no longer says its
  upkeep was skipped because the server, which had looked the folder up before the join, still
  remembered it holding no store. A member's review names the project rather than "Reasonbook
  Project", says the copy is shared and how it syncs in the structured answer Claude Code's model
  reads, and no longer asks a member's copy, which never registers, to mint a project key.
- **Approval provenance.**
  - A message the harness sends itself is no longer read as the operator's answer: a background
    task's notification, another session's message, a compaction summary, an injected context item,
    or a scheduled wakeup binds no draft, and the shown drafts wait for the operator's next message.
    Drafts a harness turn left unanswered bind to that message only as words the agent judges.
  - A revision retires the draft it revises even when the operator's last message answered none,
    once it holds three quarters of the old draft's subject; one part of a longer draft no longer
    retires the rest.
  - An approval stays with what was approved: a plainly approved draft that is revised stays
    recordable in its own words, and recording its revision, or a later one, settles it. A record
    without `fromDraft` answers a draft only when it holds 0.85 of the draft's own subject, and a
    record of part of a draft says what it leaves out.
- **The work queue follows Requires edges.** Queued missions are listed in dependency order and each
  names what it waits on; mission status, the review and the session-start digest name the first
  mission whose prerequisites are complete. `rbook_mission_transition(action="start",
targetStatus="Current")` promotes a mission without starting it.
- **The review age counts sprints that closed.** A decision's or learning's age is the number of
  sprints closed after its own sprint closed, by close time, never sprint labels; the counting rule
  is published beside the counts.
- **Every documented launch line pins this release** (`docs/harnesses.md`,
  `docs/migrating-from-cmos.md`, `docs/trust.md` and the plugin README besides the README and
  getting-started), and the launch-recipe check now reads every page that holds one.

### Changed (answer shapes)

- `rbook_mission(action="status")` queued items and `rbook_agent_onboard`'s pending missions gain an
  optional `waitsOn`, the prerequisites not yet Completed. Additive.
- `rbook_mission_transition(action="start")`'s `startedAt` is absent when `targetStatus="Current"`
  promotes the mission without starting it. Not additive, for that new path only.
- An exchange report (the `rbook_project` sync, join and share answers) gains an optional
  `removedCopy`, naming whose member was removed, and `rbook_status`'s `shared_sync` rows an optional
  `removed_at`. Additive.
- The `rbook_project` answers for a share through the dashboard, its dry run and a join name the
  dashboard's id for the project `dashboardProjectId`, not `projectId`, which every other answer
  uses for the store's own project id. Not additive, for those answers only.
- `rbook_review` gains an optional `sharedRecord` on a copy of a shared record: the digest's
  shared-record lines, or their short form. Additive.
- `reasonbook stats`' staleness read drops `currentSprintNumber` and `cutoffSprintNumber` and carries
  its `countingRule`; `rbook_decisions(action="review")`'s `currentSprintNumber` is now the open
  sprint's number, for display.

## [4.2.0-rc.2] — 2026-10-18

Sprint 97 "Shared Through the Dashboard", first published release candidate, for the dashboard to
deploy against. 4.2.0-rc.1 was tagged but never published: its publish run failed a timing-dependent
installer test, now repaired.
Sharing through the dashboard is off by default in this candidate: it works only where
`RBOOK_DASHBOARD_SHARING=on` is set, until its live test through reasonbook.ai passes. Approval
provenance, the instruments, the live test and the sharing docs follow in 4.2.0.

### Added

- **Sharing through the dashboard, behind `RBOOK_DASHBOARD_SHARING`.**
  - An owner shares a project with `rbook_project(action="share", via="dashboard")` or
    `reasonbook share --dashboard`. A dry run first lists what goes up and what stays on the
    machine; nothing is sent without `confirm=true` or `--yes`.
  - The dashboard then holds the project's referee copy. A member joins by the project's address,
    without SSH: `rbook_project(action="join", via="dashboard", project="rbook://…")` or
    `reasonbook join --dashboard <address>`. The first copy is rebuilt on the member's machine with
    this version's schema.
  - Copies sync with the dashboard over HTTPS, in pages of whole transactions within the limit it
    publishes, and an automatic sync waits out a failing dashboard.
  - The owner moves a project back to their own copy in one step:
    `rbook_project(action="move", to="owner")` or `reasonbook move --to owner`. The dashboard
    archives its copy only after the owner's copy holds the record and has synced again; members'
    copies then hear that the dashboard no longer shares the project.
- **The referee library, `@aquex/reasonbook/referee`.** The engine the dashboard runs to host a
  project's referee copy: a published table of who may call what, an intake that refuses a forged
  or malformed delivery whole, membership and roles by dashboard account (`setRole`), first copies,
  snapshots and migrations.
- **Owner-role copies edit the project identity of a dashboard-shared project.** The dashboard's
  referee accepts the project identity, and identity and lineage settles, from any copy with the
  owner role. A directly shared project keeps 4.1.0's rule. A role set on the dashboard is the role
  each of that member's copies writes with.

### Fixed

- **A former owner copy that takes a new identity keeps following its own handover.** Before, the
  handover it had written turned pending under its new identity, and the copy read itself as the
  owner's copy again.
- **Every copy goes by the first baseline it holds whose value names the replica that wrote it**,
  so a member's forged baseline changes no copy's owner copy, move or owner name.

## [4.1.0] — 2026-10-18

- **Shared records across machines.** An owner can share a project; members keep full copies,
  write locally and exchange changes with the owner over SSH or bundle files. Conflicting
  field values remain visible until explicitly settled. The logged acceptance run covers
  two accounts operated by one person on a MacBook Air and Mac Studio in an SSH star.
  It does not establish larger-team or multi-human support.
- **Re-initializing a shared project preserves its identity.** Schema setup retains the original
  creation timestamp and leaves absent optional identity metadata untouched.
- **Restored copies report known losses precisely.** Re-identifying an admitted copy whose
  authority has received none of its changes reports the exact lost range when the local
  registry has the later sequence. Missing or stale registry evidence still yields an
  explicitly unknown loss.
- **Behavior change: the old dashboard event sync is retired.** `rbook_db` pull and
  clone, event backfill replay, mutable pushes and dashboard lock hooks now refuse
  with `LEGACY_SYNC_RETIRED` and direct callers to `reasonbook sync`. Local mission,
  sprint and project-identity edits still succeed; old collaborative stores receive
  a warning instead of a lock/pull/push. Whole-file dashboard uploads remain available.
  The pull/clone action values remain until 5.0.0.
- **Message reads preserve provenance.** `rbook_message get` reads the dashboard's
  nested message response and recovers missing sender/target IDs from paged lists,
  including messages older than the newest 100. Generated source labels use validated
  addresses and escaped fences; sender/target email metadata is omitted.
- **Interrupted uploads clean up their copies.** SIGTERM, SIGINT and closing stdin
  remove this server's active temporary upload directories. Abrupt termination still
  relies on the existing stale-copy sweep.
- **Members cannot replace the owner's dashboard project keys.** Explicit rotation,
  reissue and startup recovery check the shared record's current authority first.

- **`reasonbook migrate` never writes `npx reasonbook`.** The unscoped `reasonbook` package on npm
  belongs to someone else. 4.0.1 and 4.0.2 turned a document's `npx -y cmos-mcp` into
  `npx -y reasonbook`, which runs that package. Migrate now writes `npx -y @aquex/reasonbook`, after
  any package runner (`npx`, `bunx`, `pnpm dlx`, `yarn dlx`), its flags and a tag. In `.mcp.json` it
  renames an exact `"cmos-mcp"` only as a command, or as the package an npx entry runs. No registered
  project held such a line.
- **`reasonbook migrate` tells history from use more closely.**
  - It keeps:
    - an old name beside its own new form on the line, as in a mapping table or a note on the old
      setting name: a tool, setting, record path or folder, the package or the address;
    - the old command on a line that also runs the new one;
    - every old name in a parenthesis that opens with "formerly";
    - the old package after an uninstall, or on a line about deprecation unless a plain install
      names it;
    - file and folder names, by a common extension or a following slash;
    - a project slug an option names.
  - It renames:
    - the command only where it runs: at a line start, a prompt or a list marker, in backticks or
      quotes, after `run`, `sudo`, a setting or a shell operator, or in a quoted server entry. Prose
      such as "the cmos-mcp review cadence" stays;
    - tool notation such as `cmos_session.capture`, and alternatives such as `cmos_review/cmos_status`;
    - `./cmos`, and the record folder named in words ("from cmos root");
    - setting names in an `.mcp.json` `env` block, as 4.0.1 did.
  - In a checkout of the old package itself, it moves its documents' links into the record folder.
  - It lists any line that keeps an old record path beside its new one, because such a line may
    describe the move as still to come.
- **The Stop hook keeps its drafts when another process writes.** The hook read the pending drafts
  before inserting new ones. A commit by another process in between made SQLite refuse the insert,
  and that turn's drafts were lost. When it has drafts to write, the hook now takes the store's write
  lock before it reads.
- **An embedding that could not be written says so.** When another process held the store's write
  lock past the busy timeout, a new record was saved without its embedding and the answer said
  nothing. The answer now carries a warning.
- **Every record names who wrote it.** New decisions, learnings, missions, sprints, sessions, next
  steps, constraints and context snapshots carry an author name, as git does.
  - Set yours with `reasonbook config author <name>`; `reasonbook config author` shows where the
    name comes from.
  - When you set none and are signed in to the dashboard, your account's username is the name. It
    is learned when you sign in, and kept for that sign-in only: signing out or revoking its key,
    or pointing at another dashboard, stops its use. A project's own dashboard key names you as
    the sign-in it was issued under; signing out leaves that key working, so it can keep naming
    you until you revoke it. A sign-in from an earlier version is learned at each project's next
    checkpoint, or at your next sign-in for a project without a key of its own.
  - A name is one line with a visible character. Hidden marks are refused, except the joiners
    some scripts and emoji need, and so are the two readings below.
  - Decision show and list, mission show and session list show the author. An older record
    reads "before authors were recorded", and a newer one written without a name reads "author
    not recorded". The review shows a recent decision's author when it is not the name you
    write as now.
  - While you are signed in, a record also keeps your account's id.
  - The name and id travel with the record, including the copy the dashboard upload sends. The
    privacy page lists them.
- **One folder under two spellings is one project.** On macOS a folder can be reached as
  `/System/Volumes/Data/Users/…` as well as `/Users/…`, and resolving the path does not fold the two.
  The project registry and the dashboard upload's folder checks now compare folders by device and
  inode, so the second spelling no longer reads as a different folder.

## 4.0.2 — 2026-10-15

- **Two processes can open one store at once.** When a new store, a new project registry or a
  store kept in rollback-journal mode (a copy from a zip, say) was opened by two processes at the
  same moment, one could fail at once with "database is locked", whatever the busy timeout: SQLite
  refuses a concurrent switch into WAL mode without waiting. The switch now waits within the busy
  timeout.
- **First writes from two processes no longer crash.** On a new store, the schema migrations a first
  write runs could race, and the second process threw on a schema the first had already changed.
  They now run under the store's write lock and check again once they hold it.
- **Two processes recording at once both succeed.** Recording a decision, updating one, capturing,
  and completing a mission or session read before they write, and a commit by another process in
  between made SQLite refuse the write at once with "database is locked". Those writes now take the
  store's write lock when they begin, and wait for it within the busy timeout.
- **No vector-table warning on a new store's first record.** A new store's first decision, learning
  or mission warned that `decisions_vec` did not exist when the optional embedding package was
  installed, because its vector tables were made only at its first search. They are now made before
  the first embedding write.
- **`reasonbook migrate` renames only the old names that still mean the old tooling.** It keeps hosts
  such as `cmos-mcp.com`, file names such as `cmos_context.py`, project slugs, the old name after
  "formerly", and an old form on a line that names its new form on purpose (`cmos://` beside
  `rbook://`, the old package beside `@aquex/reasonbook`, the `cmos/` folder beside `rbook/`). It
  renames the command only where it runs: after `npx`, or before one of its verbs or a flag. In
  `.mcp.json` it renames values, never a server name outside `mcpServers`. In a checkout of the old
  `@aquex/cmos-mcp` package itself, it leaves the root documents unchanged, because they describe
  that code, and reports how many lines name the record folder. It still renames the tool glob
  `cmos_*`.
- _Correction, added after release:_ 4.0.2's migrate kept less than the entry above says.
  - **Transition notes.** It kept an old form beside its new form only for `cmos://`, the package and a
    bare `cmos/`.
  - **File names.** It kept them only with 14 common extensions.
  - **Slugs.** It renamed a slug that a flag followed.
  - **`.mcp.json`.** It stopped renaming the setting names there, which 4.0.1 renamed.
  - **npx.** It also wrote `npx -y reasonbook`, which runs another publisher's package.

  The Unreleased entry fixes these.

## 4.0.1 — 2026-10-12

- Restore dashboard sync-status table recognition after the rename. Reconciliation and the
  onboarding status fallback compare the dashboard's existing entity labels again; an empty
  or unrecognized status response can no longer report a verified match.
- Update this repository's current record references after its offline folder migration.
  Historical evidence and the dashboard's stored names remain unchanged.

## 4.0.0 — 2026-10-12

- **Breaking: CMOS is now Reasonbook.** The npm package is `@aquex/reasonbook`, the CLI is
  `reasonbook`, and MCP tools use `rbook_*`. New records use `rbook/db/rbook.sqlite`, settings use
  `RBOOK_*`, addresses use `rbook://`, and shared configuration defaults to `~/.config/rbook`.
  The MCP entry name is `rbook`; response fields and error codes use the same short name.
  The plugins are `reasonbook` and `reasonbook-chat`, skills are `/reasonbook:*`, and the repository
  is `kneelinghorse/reasonbook`. Old CLI and MCP tool names are no longer registered aliases.
- **Answer names follow the rename.** Public identity fields use `rbook_address`, and public
  directory fields use `rbookDirectory`; stored identity keys and dashboard wire keys retain their
  existing spelling. `RbookDecisionsShowResult.alternatives` and
  `RbookDecisionsShowResult.deciders` retain their existing array-or-historical-string behavior.
- **Existing records stay readable.** Legacy record and config folders, settings, addresses,
  and stored keys remain supported inputs. Current settings and folders take precedence.
  Reading a record does not move files or rewrite history, including its recorded tool names.
- **Preview migration before moving files.** `reasonbook migrate` reports proposed changes;
  `--docs-only --apply` updates supported instructions, while `--apply` moves the project record
  during an offline window with backups and crash recovery. Shared configuration moves separately
  with `--config --apply`. See [the migration guide](docs/migrating-from-cmos.md) for installation
  order, plugin recovery and exact commands.
- **Upgrade plugins explicitly.** Uninstall the old plugin in its original scope before refreshing
  its marketplace, then install `reasonbook@reasonbook` or `reasonbook-chat@reasonbook`. The guide
  includes recovery for a marketplace already refreshed. Replace any global old package too.
- **The dashboard default is `https://reasonbook.ai`.** Authentication, directory access and the
  existing dashboard wire format remain compatible; user-facing addresses use `rbook://`.
- **Remedies name the package.** A remedy a reader may run without a global install prints
  `npx @aquex/reasonbook@<version> …`, never the unscoped `reasonbook`, which is an unrelated npm
  package. CLI messages begin `reasonbook <verb>:`.
- **Each level gets its own files and words.** `rbook_project(action="init")` and
  `rbook_project(action="update")` write only the seed files a Ledger, Planner or Builder needs, and
  replace `rbook/README.md` only when Reasonbook wrote it unedited. `ProjectUpdateResult` adds optional
  `filesWritten`; `RbookSessionStartResult` and `RbookDecisionsRecordResult` add optional
  `projectLevel`.
- **The plugin's skills stop when the tools are absent,** telling an install in progress (start a
  new session) from a missing local server (an install pointer).
- Dashboard uploads remove their own stale temporary copies (older than a day and owned by the
  current user). A purge whose answer names no tables succeeds with a warning that the number of
  deleted rows is unknown.
- The package carries `mcpName` for the MCP Registry, and `server.json` describes it.
- Documentation: a documentation home, the trust and privacy pages, the method page, a starter template for each
  level, and a recorded demo. The public pages name Claude Code and Codex as verified and other MCP
  clients as untested, and no longer describe a paid tier.

## 3.5.0 — 2026-10-11

- Two Codex plugins share one local CMOS runtime: `cmos` adds seven developer skills and five
  lifecycle hooks; `cmos-chat` adds six conversation skills without hooks. A portable chat entry
  and the developer compatibility entry coexist with the unchanged Claude Code plugin layout.
  Cold starts answer while npm installs the exact version; a new session loads the project tools.
  The default runtime root is shared. Developer custom roots must be absolute; the portable
  chat loader requires the default root or a manually configured server for custom roots.
- Codex requests select the project from the conversation's folder and can link to the session
  established by its hooks. Explicit `projectRoot` still wins. Invalid Codex metadata refuses
  instead of borrowing another project; background uploads do not inherit a caller's folder.
- Project tools accept exact registered `cmos://owner/project` addresses. Discovery reads every
  active registered store without migrations or repairs and refuses unknown, duplicate or
  unreadable identities. Project listing includes stored ids and addresses. Folder-only actions
  reject addresses rather than interpreting them as paths.
  Freshly initialized stores with a valid canonical id and no identity row remain local-only
  and do not block other registered addresses; corrupt or unreadable stores still refuse.
  `ResolvedBy` and `SenderResolutionSource` add `client-cwd`, including the review and whoami
  source fields. `MessageWhoamiResult.resolved` adds optional `requestedAddress`;
  `ProjectListItem` adds nullable `id` and `address`, plus optional `identityError`.
- Every MCP tool publishes a title and complete effect hints. Common telemetry expiration makes
  all current tools non-read-only, destructive and non-idempotent; message and sprint tools also
  advertise open-world effects. These honest hints do not promise fewer approval prompts.
- The README explains the `Would record:` approval convention, draft inspection and replacement
  of the older Codex adapter. Security documentation names the hook inputs and the narrow MCP
  metadata read by CMOS. Codex CLI and app-server are exercised; **ChatGPT Work remains unverified**.

## 3.4.0 — 2026-10-10

- Retrieval follows explicit stored decision citations and uses measured ranking defaults.
  First-prompt recall requires a minimum number of keyword matches, reducing unrelated output; the sealed
  acceptance gate reports retrieval quality and prompt behavior separately.
- Registered projects checkpoint actual MCP writes after five quiet minutes or thirty minutes
  of continuous activity. Eligible work starts on the next sixty-second tick while the server
  is running, subject to leases and backoff. Uploads include the whole local database, including
  pending, declined and expired drafts. `off` disables automatic uploads; implicit session exit
  does not upload. See [the upload policy](README.md#what-leaves-your-machine).
- Registry and credential diagnostics use the supported `cmos-mcp` command paths, including
  remedies that interpolate a project path.
- Public class-sweep records validate current tracked UTF-8 source witnesses, residual predicates
  and historical ledger arithmetic for the session-query, snapshot-insert and CLI-remedy sweeps.
  The gate preserves occurrence multiplicity and runs without private history; pre-edit timing,
  semantic classifications and whole-tree compliance remain review obligations.

- `cmos-mcp spin-out` previews or applies an explicit source-to-target transfer. Its `SpinOutResult`
  reports the copied kind counts, both roots, operation, backups and affected sprint progress;
  repeat receipts retain original copied counts while separately flagging later matching rows.
  Source records remain historical with additive `spunOutTo` pointers, and copied records expose
  `spinOutOrigin`. `SpinOutPointer.sourceId` and `SpinOutPointer.targetId` preserve string mission
  IDs or numeric record IDs. The CLI copy plan retains original references and approvals in
  provenance; `SpinOutProvenance.originalProjectId` preserves historical null, string or numeric
  values. Sprint history and analytics retain original counts with transfer pointers and warnings.
- Mission drop now requires its audit event and final row state to verify inside the same
  transaction. Failed or silently ignored writes refuse and roll back instead of reporting a drop.

- Decisions accept separate `context`, `alternatives`, `consequences` and `deciders` fields,
  plus `mode: autonomous`; approved drafts retain their own approval path. The CLI adds
  `decisions record`. Search, recall and embeddings use the full record while previews retain
  the statement. Statements over 600 stored JavaScript characters warn without refusing.
  `CmosDecisionsShowResult` adds optional nullable `context`, `consequences`, `approvalMode`,
  `approvalDraft` and `approvalWords`. `CmosDecisionsShowResult.alternatives` and
  `CmosDecisionsShowResult.deciders` return string arrays or null; malformed historical text
  remains a string with a warning. Missing historical approval modes remain unknown.
- The MCP server now uses SDK v2 and Zod 4 on Node.js 20 or newer. Stdio supports
  legacy initialization and the 2026-07-28 protocol; named projects never wait for
  client roots. The fresh-process helper pins legacy negotiation to launch exactly
  one application process. Modern tool listings include a private 60-second cache hint.

- Missions can be unscheduled: omit `sprintId` to infer the unique open sprint, or pass
  `null` explicitly. Init uses the same rules, and status/onboard retain unscheduled work.
  Historical completion spellings read as Completed without changing stored records; unknown
  mission statuses can be repaired only to Queued, Deferred or Dropped with an atomic history entry.
  `MissionAddResult.sprintId` and `mission.sprintId` may now be null;
  `MissionUpdateResult.previousStatus` can contain an unrecognized historical string.
- Starting a mission activates its Planned parent only when no other sprint is open, persists
  sprint tracking and propagates the sprint before the mission. Reopening a carried next-step
  preserves its last carry lease anchor. Context condensation reports remaining section sizes
  in UTF-8 bytes, including unchanged sections. The additive receipt fields are
  `MissionStartResult.activatedSprintId` and `CmosContextCondenseResult.remainingSectionBytes`.

## 3.3.0 — 2026-10-09

This stable release includes the CLI, Claude Code plugin, digest, recall, feedback and local
measurements described in the development candidate below, plus proposal approvals and the
portable adapters listed here.

### Added

- **Portable harness adapters and MCP prompts.** Native hook files for Codex, Cursor, Devin,
  Copilot and VS Code Local share the installed CLI, with a dated coverage matrix and explicit
  live-verification limits in [the harness guide](docs/harnesses.md). The four MCP prompts
  `cmos-start`, `cmos-close-out`, `cmos-plan` and `cmos-build` read their corresponding skill
  sources; the plugin gains the read-only start skill. Foreign transcripts are not interpreted
  as Claude transcripts, and native adapters cannot inherit a parent Claude project's identity.
- **Proposals: agents draft, the operator approves.** An agent ends a reply that puts a choice to
  the operator with `Would record: <decision and reason>` (or `Would record (constraint|rule|profile): …`),
  up to three trailing lines. The silent Stop hook stores each as a draft (`P<n>`) in a new
  `proposals` table; the operator's next message binds only to the drafts that reply showed. A plain
  approval, nuance, a question, an amendment (a revised line replaces the draft) and a plain decline
  are read by published phrase lists. `cmos_decisions(action="record", content, fromDraft="P<n>")`
  records it, and the record says how the approval was known: `approved`, `agent-judged` (the
  operator's words attached) or `agent-attested`. Decision rows gain nullable `approval_mode`,
  `approval_draft` and `approval_words`. The record answer gains optional `approval` (draft, kind,
  mode, words), `answeredDrafts` and `stillPendingDrafts`; constraint, rule and profile drafts answer
  with `recorded` (kind, id, typedId, materialization) and are never recorded as agent-attested.
  New error codes: `DRAFT_NOT_FOUND`, `DRAFT_NOT_PENDING`, `APPROVAL_REQUIRED`. Drafts expire unanswered
  after 7 days or 3 session starts, flag outside content the session read, appear in the digest, and
  are listed by `cmos-mcp drafts list`; `stats` reports their outcomes and acceptance rate. The
  operator's words stay outside the store for at most two hours until a record copies them.

### Fixed

- Release E2E tests consume the existing build; implicit-session scenarios run the installed
  tarball. CI verifies the built server before running artifact consumers. The release scan
  rejects failed or empty tarball listings, and the public mirror compares exact Git paths,
  modes and objects before committing or tagging.
- Telemetry and recall identify a physical store by its native real path, so alternate path
  casing cannot split measurements or repeat same-session recall on case-insensitive disks.
  Prerelease files keyed from a differently cased path remain on disk; their opaque keys are
  not automatically reassigned, so old alias history may not appear in stable-version stats
  and first recall may replay once after upgrade. Draft approval state already uses native paths.
- Decision-timing statistics ignore undated completed missions with no linked decisions,
  because those missions cannot enter the measure. Undated missions with any linked decision
  still make timing unavailable; no historical timestamps are inferred or rewritten.

### Documentation corrections

- Measurement correction, checked 2026-10-09 on the published 3.2.0 package: an empty
  macOS arm64 install with `npm install --omit=dev @aquex/cmos-mcp@3.2.0` used 45,972 KiB
  under `node_modules` by `du -sk` (44.9 MiB). Earlier 44.7 MB and 44.9 MB labels below
  are corrected to that measured allocation and unit; this is not a portable install-size
  guarantee. The actual `tools/list` tool array has 19,523 JSON characters
  (`JSON.stringify(result.tools).length`, 15 tools), correcting the earlier 18,906 figure.
- The front door describes decisions that survive the session, includes a three-command first
  digest and plugin commands, and explains what leaves the machine. Onboard previews and selected
  list caps do not enforce a total response size: the earlier 28 KB claim was a fixture budget.
- The earlier 3.2.0 upload and snapshot descriptions were too broad. Successful explicit
  completion calls start a best-effort checkpoint, with a user-key or environment-credential
  gate; they do not guarantee an upload. Shared-store propagation is a separate path.
  Sprint backup failures warn, and restore's pre-restore copy requires manual recovery.
  [SECURITY.md](SECURITY.md) states the current contract and failure cases.

## 3.3.0-rc.1 — 2026-10-08

Prerelease published under the `next` dist-tag. Proposal drafts and the additional portable
adapters landed afterward in 3.3.0.

### Added

- **A Claude Code plugin and marketplace.** The canonical `plugins/cmos` subtree contains six
  skills, lifecycle hooks and an MCP server entrypoint. Hooks use a pinned package validated for
  the current platform, architecture and Node ABI; a detached installer publishes a complete
  native SQLite installation atomically. Hooks never invoke npx. Explicit commands and server
  startup may use the pinned npx fallback. `pluginServer: off` exposes an empty MCP surface even
  on a cold install without npm. Named hook sources elect one adapter per verified harness
  lifetime; real prompt IDs suppress successful repeated turn events. Missing IDs and
  unverifiable process lifetimes retain documented duplication limits. Compact reloads the
  digest; session end closes only an existing owned session and records bounded Git observations.
- **Later-prompt keyword recall.** After the first eligible prompt, hooks emit at most three
  unseen local decisions within 1,500 characters, requiring three whole-keyword matches. Seen
  state records complete delivered spans from recall and the digest. Short later prompts, slash
  commands and acknowledgements skip retrieval after telemetry. First-prompt policy is unchanged.
- **Standalone feedback and a read-only fleet view.** `cmos-mcp feedback --content <text>` files
  friction without a session or mission, with dry-run and JSON receipts; the package ships a
  feedback skill. `cmos_feedback(list, acrossProjects=true)` returns bounded newest rows with
  source-store provenance, full filtered counts, and explicit missing-store coverage. Additive
  result fields are `entries[].sourceProjectId`, `entries[].provenance`, and `fleet` with `complete`
  and per-store `projectId`, `totalCount`, `state`, and optional `error`. Sibling stores are never
  written by fleet reads; their dispositions are requested through authorized messages. Triage
  accepts `resolutionNote`. The shared digest includes open fleet feedback with a bounded read
  budget and marks unavailable coverage instead of presenting it as zero.
- **Digest v2 and first-prompt recall.** Session start, CLI review and MCP review share a stable
  local digest with the whole approved operator profile, binding rules, recent decisions and
  learnings, and open work within 4,000 characters. MCP keeps its bounded legacy structured result
  and appends portfolio context below the text pointer. Superseded choices are excluded. The first
  eligible prompt returns up to five decision previews using keyword retrieval and one hop of
  explicit local decision citations, without a vector model. External runtime state serializes
  delivery across processes and survives resume/compact; errors remain retryable. Typed item spans
  measure what actually survives output caps.
  The new `RecallResult`, `RecallItem` and `RecallVia` types are internal hook retrieval data;
  they do not add fields to MCP review's structured response.
- **Local usage measurements and `cmos-mcp stats`.** One best-effort record per MCP call or CLI
  invocation records typed IDs, counts, hashes and outcomes, never prompt text or record bodies.
  Measurements live outside repositories and SQLite under `<configDir>/telemetry/`, retaining the
  three newest monthly files per store; they are neither uploaded nor packed. Prompt hooks record
  procedure-pattern and rule-restatement matches before skips. `stats` reads these files and the
  store for G1 and sprint-close reports, states each counting rule, and marks missing evidence as
  unavailable. `stats --export` emits aggregate counts and ratios without local record details.
- **A command-line interface for hooks, inside the same bin.** `cmos-mcp` with no verb (or with
  `serve`) is still the MCP server, and `node dist/index.js` still starts it too. The verbs load only
  what they need, never the server:
  - `cmos-mcp hook session-start|prompt|stop|pre-compact|session-end` reads a harness hook's JSON on
    stdin. Session start injects the record's digest (Claude Code's
    `hookSpecificOutput.additionalContext`, at most 6,000 characters; `--format text` for plain text).
    Every hook verb exits 0, writes at most one stderr line (anything else written to stderr while it
    runs is held back), and prints nothing past its deadline, counted from process start (session
    start 3 s, prompt 0.8 s, stop 0.5 s, session end 1 s); stop, pre-compact and session end never
    print. A missing, locked or unreadable store gets that one line and a record in
    `<configDir>/runtime/fail-open.jsonl`, never an init offer. A word the CLI does not know is a
    usage error with exit 1 (exit 2 would block a prompt in Claude Code), never the MCP server.
  - `cmos-mcp review --format=context` prints the digest, and `cmos-mcp relevant --query <text>`
    prints matching decisions and learnings as previews, superseded rows dropped.
  - `cmos-mcp capture` and `cmos-mcp session ensure|close` write with `--session-id`; without one they
    refuse rather than open a session per process.
  - `cmos-mcp ambient on|off|digest-off` sets how present CMOS is in a project's sessions, and
    `CMOS_AMBIENT` overrides it for one session. In a git repository with no CMOS record, session
    start offers `/cmos:init` in one line; `cmos-mcp ambient off` there stops the offer.
- **One harness session is one CMOS session, in the conversation's own project.** Session start
  records which session a harness process is in (`<configDir>/runtime/harness/<pid>.json`, holding
  hashes of the session ids that process has had, never the ids, and the conversation's folder).
  The MCP server that harness started writes into that session, across a server restart and after
  `/clear`, whether it is the harness's direct child or runs through a launcher such as `npx` (it
  matches the session id it was spawned with). The session opens at the conversation's first write,
  so a conversation that never uses CMOS adds no row, and session end closes it. A server never
  closes it when it exits; it closes only the sessions it opened for itself. Writes to another
  project, and servers no hook links (Codex, editor extension hosts, Claude Desktop), keep a session
  per server process, as in 3.2.0. Hooks and the server must share `CMOS_CONFIG_DIR` (both default
  to `~/.config/cmos-mcp`).
- **One AGENTS.md for every new project.** `cmos_project(action="init")` and the new
  `cmos-mcp init` write the same AGENTS.md: the universal rules, about a dozen learned practices
  (probe before you encode, fix the class, no silent fail-open, tests never touch the network or
  live data, stay in your own repository, and more), trimmed placeholders, about 120 lines in all,
  and exactly one CMOS line naming the project's level and how to turn the hooks off. How to use
  CMOS arrives through its tools, hooks and tier guides instead. Init's CLAUDE.md now imports the
  agents file (`@AGENTS.md`) and names no tool prefix. The `--level` option of `cmos-mcp init`
  (ledger, planner or builder) answers the init question, and `--no-hooks` adds a labelled block
  of CMOS steps for a harness without hooks. The CMOS line follows the project: a level change
  (`cmos_project(action="update")`, or init run again with a level) and `cmos-mcp ambient` rewrite
  it in place, and a rules file without the line is left alone. Init says what it leaves undone:
  an existing CLAUDE.md that does not import the agents file, or a hook-less block it could not
  add.
- **The operator profile.** `<configDir>/profile.md` holds how the operator likes to work, for
  every project: outside every repository and store, so never uploaded. `cmos-mcp profile show`
  prints it. CMOS adds a line only from a draft the operator approved, refuses one past the
  1,100-character cap, and never cuts the profile to fit; the operator edits the file directly.

### Changed

- **An explicit session started inside a harness session belongs to that conversation.**
  `cmos_session(action="start")` records the harness session's key; the session absorbs only that
  conversation's writes, and session end (a `/clear` included) closes it. One started without a
  harness link stays keyless and absorbs every caller's writes, as in 3.2.0, so a server restart
  never orphans it. A write that names no session lands in the caller's own explicit session, else a
  keyless one, else the caller's implicit session. Another conversation's explicit session no longer
  blocks a start, and the refusal from one's own names the session to complete by id, as does
  onboard's "complete active session" command.
- **A new project is a Ledger by default.** With no level chosen, init stores the tier `general`
  (decisions and lessons) instead of `build`, unless the folder's AGENTS.md already names a level
  in its CMOS line (a team's committed file, or a store recreated beside it), which init keeps; its
  answer names the level and where it came from (`level` and `levelSource` on init's answer). A store that has no tier recorded still reads as
  `build`, as before. The tier guides now teach only calls the server accepts: the general guide
  opens with `cmos_review` and has no session ritual, the managed guide starts a cycle before
  adding tasks to it (each task names its id and cycle), and the build guide records decisions one
  way. Every `cmos_*(…)` example in the shipped seed now runs without a refusal.
- Onboard's "last session" is the most recent one, except that an automatic close that held nothing
  never displaces a handoff. The untagged-session advisory counts explicit sessions only.
- **Automatic session closes register nothing.** Reconcile, a server's exit and session end close
  sessions without registering the project, so a second checkout of a registered project no longer
  hits the registry's collision refusal on close. The registry's 5-second lock wait gives way to a
  hook's shorter one.

- **Reads never write the record.** Every read-classified call leaves the store as it found it, with
  or without `CMOS_AGENT_ROLE=review`. In 3.2.0, `cmos_review`, `cmos_agent_onboard` and
  `cmos_context(action="view")` marked old decisions and learnings `stale` on every call (the review
  role skipped only the view's copy); onboard resolved the owner through the dashboard and wrote it
  to metadata; every call, reads included, rewrote a `cmos://unknown/...` address; the view ran the
  master_context blob migration (a snapshot, a rewrite, and the event-column backfill); both searches
  raised the schema label, and rebuilt a search index that already existed (rewriting its completion
  marker); and a read, the identity view included, seeded a missing project_identity row. A
  migration may still run on a read when it is DDL, the filling of what that call added, and its own
  new marker row in a call that ran that DDL. A read that finds a search index out of step with its
  table says so on its answer ("Store upkeep"), since it may miss rows until a write rebuilds it.
- **Staleness is computed when read and never written.** Onboard, the review and the context view
  show the rows past the review age (20 sprints, as before) beside the rows stored as `stale`, with
  `cmos_decisions(action="review")` for each one's age and suggested action. The review now lists
  the learnings past the review age or marked stale too (`learnings` in its data, with their ages),
  and it is read-classified, so an agent under `CMOS_AGENT_ROLE=review` can run it. Onboard's `staleness`
  gains `dueForReviewDecisions` and `dueForReviewLearnings`. The clock counts Completed sprints and
  the open one, in any letter case; a Planned sprint no longer moves it, and the context view's
  `recentSprintCount` uses the same rule.
- **An explicit decision status update stamps `last_reviewed_at`** (update and batch_update), as the
  learnings update already did, including one that leaves the status as it was: keeping a decision
  `stale` on purpose is recorded as a review. Where the stamp cannot be written, an explicit `stale`
  is refused.
- **A server process's first write to a store restores the rows an older CMOS marked stale on its
  own**: a `stale` row in a `sprint-N` at least 10 sprints below the highest, with no evidence, not
  the target of a supersession, not evergreen, and never reviewed. It runs after a call that answered
  without error and changed a row in that store for its caller: never after a read, a report, a
  refusal or onboard (which makes no status write, feedback or not), and a repair made on a call's
  way (an address heal, a seeded identity row, the schema label) does not count as its write. It keeps
  a ledger in the store's metadata (`staleness_repair`, which also states what the repair cannot tell
  apart), the write's answer says what it restored under "Store upkeep", and `cmos_review` says when
  rows it restored are marked stale again with no review stamp, because only an older server writes
  that. Across copies of the 24 stores on the maintainer's machine it restores 453 of 457 stale rows
  and itemizes the 4 it leaves. The same first write migrates a pending master_context blob (a read
  shows the migrated shape without writing it) and rebuilds a search index a read found out of step
  or built before its completion marker; a server whose read found a gap after its first write
  rebuilds it at its next one.
- **Previews, not bodies**, in `cmos_decisions(action="search")`, `cmos_decisions(action="list")`,
  `cmos_learnings(action="list")`, `cmos_session(action="search")` and `cmos_session(action="list")`:
  each decision, learning, summary and capture is cut at 300 characters with `truncated` and
  `fullLength` (`summaryTruncated` and `summaryFullLength` for a session), and the answer says how to
  read one in full. `cmos_session(action="list", sessionId=...)` reads one session whole, its summary
  and every capture, in its text and its data (`captures`). A list never points `show` at another
  project's id. Next steps and constraints stay whole: each is the item an agent acts on, and no
  action reads one by id.
- **Compact mission receipts.** `cmos_mission(action="add")` names the stored fields in `fields`,
  and its `mission` keeps the mission's `id`, `name`, `sprintId` and `status` but no longer echoes
  the optional `objective`, `context`, `successCriteria`, `deliverables`, `referenceDocs`,
  `domainFields` and `notes`; `cmos_mission(action="show")` reads them. They were optional members of
  the receipt, so no published field is removed or renamed, but a caller that read them from add's
  answer now finds them absent. `update` adds `name` and `status`.
- **Every answer that touched a project names it** on its first line, however the project was
  chosen, an error answer from a call that resolved its project included.
- **Timestamps compare and sort as times** (`julianday()`) everywhere a stored timestamp is compared
  or ordered, in SQL and in TypeScript (a decisions list's order, search ties, the `since`/`until`
  filter over session-capture decisions, the backfill cursor, and every parse of a stored time for
  an age, a duration or a freshness lag), which reads SQLite's zone-less spelling as UTC as
  `julianday()` does. Mixed spellings (`T` and space separators, offsets,
  date-only values) used to compare as text: a session that went stale earlier the same day was not
  flagged until the date rolled over, and a list put #480 (`2026-06-30 03:10:21`) after #475
  (`2026-06-30T02:14:08.987Z`). A `since` or `until` of a year or a month (`2026-10`) covers that
  period, in every read that takes one (decisions list, learnings list, session search, context
  history and context update); one no stored time can be compared with is refused instead of
  matching nothing.
- **CMOS describes itself as the project's record, never its memory**, in the server instructions,
  the tool text, the general tier and the seed.

### Fixed

- **A re-init keeps the project's identity.** Running init again on an existing project minted a
  new project id and blanked its name, after which every write was refused as an identity
  conflict. Init now keeps the project's id (the store's own; for a store that was deleted and
  recreated while its `cmos/` folder stayed, the id the project registry holds for the folder) and
  its name, TraceLab link and
  level unless they are passed, and refuses a different project id before it writes anything. A
  new project in a folder a moved project left behind gets an id of its own. A new project's
  identity also names its real tier.

- `cmos_project(action="list")` never prunes: with `prune` it refuses and names `prune` and
  `validate`, which archive registry rows.
- `roots/list` is sent only to a client that declared the roots capability; a client that ignored it
  stalled the first CMOS call until the request timed out.
- `cmos_review` and onboard show a server running older code than its `dist/`: in the server's own
  checkout they name `scripts/restart-session-server.sh`, elsewhere they say to restart the MCP
  server, and the stale-server warning states the fact without a remedy of its own that could
  contradict that. whoami is prescribed only to a user who has the dashboard in their setup.
  whoami and the startup lines write nothing, from a call or from the command line: they resolve
  with the address the next write will store (so whoami's verdict on a send matches the send), and
  whoami says that repair is still to come.
- A brand-new project is not reported as drifting in the portfolio section.
- `cmos_project(action="init")` without `projectRoot` refuses with the call to make, and init in a
  temporary folder warns as `register` does.
- A failed learnings count at mission completion says so instead of reporting none recorded.
- Onboard (and so `cmos_review`) no longer fails when the dashboard's sync status carries no
  `tables`: the error escaped its catch, un-awaited. It answers without sync health and says so.
- The evergreen parameter's description says what it does now: the learning is never shown as past
  the review age.
- `cmos_sprint(action="list")` says how many Planned sprints a page left out.
- The shutdown lines on SIGINT and SIGTERM print only with `CMOS_DEBUG=1`.
- Onboard's text shows the tierSelectionPrompt its suggested action points at.

## 3.2.0 — 2026-10-07

Sprint 92 "Safe & Light": a stranger's first hour is safe and quiet, and no ceremony is destructive
by default. This is a **MINOR** release under this project's rule: no published receipt field is
removed or renamed. A 3.1.0 caller can observe four behaviour changes, each detailed below:

- **Every answer names its project.** `projectRoot` and `resolvedBy` are on every response's data. A
  call from a folder that is not a CMOS project is refused instead of routed to the one registered
  project.
- **A capture never fails for lack of a session.** With none open, it lands in the calling process's
  implicit session, which the server closes when the process ends.
- **A registry default set before 3.2.0 must be re-confirmed** with
  `cmos_project(action="register", projectRoot=…, setAsDefault=true)` before it is applied.
- **Sprint close no longer archives decisions and learnings by default.** `archive: true` opts in,
  with the itemized receipt.

Install and audit, measured on the packed tree installed with `npm install --omit=dev` into an empty
project: 44.9 MiB on disk across 138 production dependencies (3.1.0: 305.7 MB), and
`npm audit --omit=dev` reports no vulnerabilities (3.1.0: 1 critical and 5 high, all through the
embedding stack, now an optional peer). The tarball is 1.19 MB, 5.17 MB unpacked.

### Changed

- **A call never acts on a project the caller did not name.** With exactly one registered project,
  3.1.0 answered every folder with that project: a decision and a session recorded from an
  uninitialised folder B were written into project A. That registry-singleton step is gone for reads
  and writes. Resolution now selects one store by detection — the explicit `projectRoot`, then the
  first MCP root inside a CMOS project, then the working directory or the nearest folder above it
  that is a CMOS project (one holding `cmos/db/`; a plain folder named `cmos`, such as a source
  module, does not count) — and the selected store is final: when it cannot be used, the call is
  refused instead of falling through to another project. **Consequences a 3.1.0 caller can
  observe:**
  - `projectRoot` naming a folder that is not a CMOS project is refused (`CMOS_NOT_DETECTED`); 3.1.0
    fell through and acted on the cwd project. A folder inside a project is refused with the
    enclosing project's path as the remedy.
  - A call from a folder that is not a CMOS project is refused: a write names
    `cmos_project(action="init", projectRoot=…)`, a read answers "No CMOS project in '<dir>'".
  - A working directory, or an advertised MCP root, inside a project now resolves to that project
    (the walk-up stops below `$HOME`). 3.1.0 only looked at the folder itself.
  - When the client advertised roots that hold no CMOS project and the working directory answered
    instead, the answer says so in one rendered line.
  - `cmos_message(action="send")` from the server's own install directory resolves to the store
    there; the 3.1.0 cwd-vs-install-root guard is retired.
  - A registry default applies only to a call with no project context at all (no `projectRoot`, no
    MCP roots, and a working directory of `/`, `$HOME` or the install directory), and only once
    confirmed with `cmos_project(action="register", projectRoot=…, setAsDefault=true)`. **A default
    set before this release is not applied until re-confirmed**; the startup log,
    `cmos_message(action="whoami")` and `cmos_review` say so.
  - `cmos_project(action="unregister")` takes its path literally: a path that is no longer a CMOS
    project is unregistered by path, and no longer unregisters the cwd project instead.
    `cmos_project` list/validate/prune/sweep and the user-level `cmos_auth` actions no longer need a
    resolvable project.
- **`cmos_message` validates an explicit `projectRoot` on every action.** list, get, respond, ack and
  directory used to pass it through unchecked; a folder that is not a CMOS project is now refused.
- **`SenderResolutionSource`** (`whoami`'s `resolved.source`, candidate traces) loses
  `registry-singleton` and gains `server-project-root` and `registry-default`.
  **`ProjectValidationItem.status`** gains `ephemeral`.

- **The next-step lease counts real closes, within the operator's calendar bounds.** In 3.1.0,
  `cmos_sprint(action="complete")` kept a sprint's planned end date (`COALESCE(end_date, ?)`), and the
  lease counts a close by `end_date` — so a sprint planned for next week but closed today counted as a
  close every row carried after it had survived. TraceLab lost 58 freshly carried rows that way.
  - A close now stamps its **actual close time** into `end_date`; the receipt reports the planned date
    as `plannedEndDate`. `cmos_sprint(action="update", fields: {status: "Completed"})` — the close by
    status update some projects use — stamps it too (`endDateStamped`, `plannedEndDate`), unless the
    same update sets `endDate`; a future `endDate` is honoured with a warning.
  - The lease ignores any `end_date` still in the future.
  - **One-time repair, at the first close after upgrading:** Completed sprints whose `end_date` is later
    than their recorded close (the `sprint_complete` event, else its context snapshot) are re-dated to
    it. The close receipt's `endDateRepair` lists each re-dated sprint (`from` → `to`) and every
    Completed sprint left as found because nothing records when it closed. Only later dates move, so a
    correctly dated store sees no lease change. Measured: 9 sprints on a TraceLab copy, 1 here.
  - **Calendar bounds (operator decision #1161):** no row is dropped before it is 14 days past its last
    carry or creation, however many closes it survived (the close receipt lists such rows under
    `heldByMinAge`); a row that has survived no close for 6 weeks is flagged `idle` — in the
    next-steps list, the close receipt and the opener's next actions — and is never dropped by the
    calendar alone. `LeaseState` gains `idle`; the published counting rule says all of this.
- **A sprint close no longer archives the sprint's decisions and learnings** (operator decision
  #1160). Through 3.1.0, `cmos_sprint(action="complete")` archived every active decision and learning
  bound to the closing sprint. Across the fleet 78% of decisions ended up archived, mostly by that
  step, and projects worked around it by closing sprints with a status update or recording
  corrections without a sprint. They now stay active; a decision still leaves the active set when a
  new row supersedes it.
  - `archive: true` opts back in and reproduces the old step exactly: the same rows, evergreen
    learnings kept active, every archived id named. Measured on identical copies of this repo's
    store: the pre-change close and `archive: true` archived the same 12 decisions and 2 learnings
    and rendered the same receipt line.
  - The receipt's `lifecycle` gains `archived`, true only when `archive: true` was passed. By default
    `decisionsArchived` and `learningsArchived` read 0 and `archivedDecisionIds` and `learningIds`
    read `[]`; all four stay in the receipt.
  - The pre-close database snapshot is still taken: the close still writes the end date and the
    lease drops.
- **A capture never fails for lack of a session.** In 3.1.0, `cmos_session(action="capture")` with
  no session open was refused with `SESSION_NOT_ACTIVE`. Neither `cmos_review` nor
  `cmos_agent_onboard` opens a session, so the first capture of most conversations failed. Since
  3.2.0 a capture, a `cmos_decisions` record, or a mission completion with `decisions[]` that names
  no session lands in the caller's session. That is the project's open explicit session when one
  exists, as before. Otherwise it is the calling process's own **implicit session**, opened on first
  use.
  - **Attribution is per process.** Each server process writes under its own implicit session, and
    no call writes into another process's. Naming another live process's implicit session on
    `capture` is refused however idle that session is (`INVALID_PARAMETER` on `sessionId`). On
    `complete` it is refused until the session has been idle for more than 12 hours. A recorded
    decision is now attributed to the caller's session, where 3.1.0 left `author_session_id` NULL
    when no session was open. One limit: on a store that pulls collaborators' sessions through
    collab sync, a pulled active session counts as the project's explicit session, as it did in
    3.1.0.
  - **Who closes them.** The server closes its implicit sessions when its client goes away (stdin
    end, SIGINT, SIGTERM). A process's first write to a store, of any kind, also closes implicit
    sessions there whose process is gone from this host, or that have been idle for more than 12
    hours. Each carries a deterministic summary and is listed under `closedSessions` on a capture,
    record or start, or as a warning line on a mission completion. These closes call the session
    handler directly and **never upload a checkpoint**.
  - **Sprint tagging.** An implicit session carries no sprint. Every row it writes resolves its
    sprint when it is written, as any untagged write does, instead of inheriting the sprint that was
    open when its process started.
  - **Explicit sessions** keep one-at-a-time per project, and implicit sessions never block a start.
    A start first closes an explicit session idle for more than 12 hours, and lists it under
    `closedSessions`. A start refused by a live session closes nothing.
  - Orphan detection, the cross-project sweep and the onboard active session list explicit sessions
    only.
  - `sessions` gains `implicit` and `owner_key`, added by a one-time migration. `owner_key` stores a
    hash of the hostname, never the name.

- **Retrieval answers carry previews, not bodies.** Hits in `cmos_context(action="search")` and
  `cmos_learnings(action="search")`, and the decisions `cmos_mission_transition(action="start")`
  surfaces, now carry a preview of at most 300 characters. Each one keeps its id and gains `status`,
  `truncated` and `fullLength`. The fields keep their names (`text`, `content`, `decisionText`), so
  a caller that read the full text from them now reads the preview; the full text comes from the new
  `show` actions. Measured on a fixture of 2,000-character rows, a 10-hit search answer went from
  24,796 characters to 7,226. Rows are still scored on their full text.
- **`tools/list` is about half the size.** The descriptions clients receive are short:
  19,523 characters, about 4,881 tokens, where they were 38,141. The schemas are unchanged, and
  TOOL_REFERENCE.md keeps every full description. A test holds the list under 6,000 tokens at four
  characters a token.
- **Completing a mission counts the decisions it recorded.** The recommended path records each
  decision with `cmos_decisions(action="record", missionId)` and then completes the mission. 3.1.0
  counted only the completion call's own `decisions[]`, so that path was told "No decisions captured
  for this mission" — the most reported pain since 3.1.0. The advice now fires only when the mission
  has no non-superseded decision at all, counting rows recorded at any time: before the mission
  started, and on missions with no recorded start. The receipt gains `missionDecisionCount` and
  renders "Decisions recorded for this mission: N"; `decisionCount` still counts this call's own
  inserts.
- **No more automatic supersession offers or implicit reaffirms.** A captured or recorded decision
  used to come back with `supersessionCandidates` and a `supersessionMessage`, and a capture bumped
  `last_reviewed_at` on any learning whose text it resembled (`implicitlyReaffirmedLearningIds`).
  Replayed over every historical capture, 69 of 9,035 offers were true, and 20 of 3,973 implicit
  bumps touched a learning the author cited. Both are retired. The three fields stay in the answer
  types, deprecated and never populated. Explicit paths are unchanged: `supersedes=[…]` on record,
  `citesLearningIds`, and `cmos_learnings(action="reaffirm")`.
- **The opener tells the truth.** On a fresh project, `cmos_review`'s top next actions used to be a
  pointer to a `tierSelectionPrompt` the digest does not carry, a whoami nudge, and a dashboard login
  nag. Now:
  - The review never forwards an action that points into onboard's own payload. On a fresh project
    it leads with `cmos_agent_onboard()`.
  - Whoami is prescribed only when the project was inferred rather than named. An explicit
    `projectRoot`, the client's MCP roots and the server's `--project-root` all name it, and the
    review now passes the client's roots through.
  - The login nag and the "messaging block omitted" warning appear only after the user opts into the
    dashboard: a stored credential, a legacy env credential, or an explicit `CMOS_DASHBOARD_URL`. The
    built-in default URL is not a choice the user made.
  - "Start a planning or review session" is retired, since a session is optional.
  - The digest gains `recentLearnings`: up to three, trimmed before any decision when its 4 KB budget
    binds. Decisions and learnings carry their ids, in the data and on each rendered line.
- **`cmos_agent_onboard` is bounded, and says so.** It claimed "<4KB" and measured 36,142 bytes on
  this repository's store. Recent decisions are now 300-character previews with `id`, `truncated` and
  `fullLength`. Open items and the top-level next steps are previews too. The last session's summary
  is capped at 1,000 characters, and its decisions and next steps at the newest five previews (the
  full session is on `cmos_session(action="list")`). The same store now measures about 21,000
  characters, and a test holds a long-history fixture under the documented 28,000.
- **Search finds archived decisions, and fills its page.** In 3.1.0, `cmos_context(action="search")`
  and mission-start surfacing returned active rows only, but a sprint close archived decisions: 46%
  of the rows later records cite were no longer active when cited. The filter also ran after the
  candidate pool was cut, so 26-33% of searches came back short; one returned a single row for
  `limit 5`.
  - Both surfaces now drop only superseded rows, and each hit shows its status: search labels each
    hit `decision #N, archived`, and mission start marks its bullets the same way. An explicit
    `statusFilter` keeps its include-list meaning (`["active"]` restores the old behaviour), and
    `[]` still disables the filter.
  - The search answer's `options` gains `excludedStatuses`: `["superseded"]` when the caller named no
    statuses. `statusFilter` then reads `[]`, where 3.1.0 reported `["active"]`.
  - The filter runs inside the candidate queries, so a page is never short because the pool was cut
    first.
  - The keyword arm reads every distinct query keyword, up to 64, where it read the first 10.
  - Measured on 2,154 natural citation labels in four stores, with no embedding package installed:
    recall@10 went from 0.331 to 0.638, mission-start recall@5 from 0.149 to 0.429, and short pages
    from 54.8% to 0% (`cmos/docs/s92-m07-retrieval-evaluation.md`).
- **The embedding stack is an optional peer dependency.** `@xenova/transformers` is no longer
  installed with cmos-mcp. On the same labels, keyword-only retrieval beats the old equal-weight
  hybrid, and the stack was most of the install.
  - Measured on packed tarballs installed with `npm install --omit=dev`: 305.7 MB → 44.9 MiB, and
    `npm audit` went from 1 critical and 5 high advisories (all through `@xenova/transformers`:
    protobufjs, onnx-proto, onnxruntime-web, sharp) to none.
  - Without the package, writes record no embedding and searches are keyword-only, both silently,
    and nothing contacts HuggingFace. To keep semantic search, install `@xenova/transformers` next to
    cmos-mcp; the vector term then counts 0.25 in the fusion (it counted 1.0).
- **A normal start writes two stderr lines**: the version, and the project a call with no context
  would use. A clean-room 3.1.0 start wrote 16. Startup and per-call diagnostics (the `.env` loader,
  attribution self-test, registry, health, MCP roots probe) are behind `CMOS_DEBUG=1`. Real
  misconfigurations still print.
- **Launch recipes pin the version.** README and getting-started recommend
  `npm install -g @aquex/cmos-mcp@3.2.0`, or `npx --prefer-offline -y @aquex/cmos-mcp@3.2.0` in every
  client config. An unpinned `npx -y` could look the package up again on every launch and silently
  move to the latest release.

- **Session and mission closes stop storing snapshot content.** The copy a close writes after
  persisting its context is now content-less: its row is written with `content` empty,
  `content_pruned_at` stamped and its hash prefixed `pruned:`, so it is never a dedup hit, and
  `cmos_context(action="history")` marks it `contentPruned`. These copies were 282.7 MB of the
  367.6 MB of snapshot content on the 24 stores measured, and no query reads them; the context row
  holds the same content. Sprint milestones, explicit snapshots, update and auto-refresh copies, and
  every recovery copy taken before a trim, condense or migration keep their content.
  - When the context write fails, the copy keeps its content as the only durable copy, and its
    source ends `:only_copy` so no prune reclaims it.
  - A session close no longer overwrites a context it cannot read or parse. It leaves it as it is
    and reports a `CONTEXT_UNREADABLE` write failure.
  - Retention archives now carry the source `retention_archive:<caller source>`, so a session
    close's archive no longer shares its source string with that close's content-less copy.
- **A snapshot no longer stands on a row a prune would reclaim sooner.** Every snapshot site skips
  writing when a row of the same context already holds identical content. A milestone, a named
  snapshot or a recovery copy now does so only when that row is never pruned, so its own retention
  holds. A recovery copy is kept 30 days from its own creation, so it may also stand on an identical
  recovery copy under a minute old: a retried migration still writes one row. Before, a named
  snapshot, a sprint-close milestone or a condense backup taken just after an update returned the
  update copy's id under the copy's source, and on this repository's store 67 of 70 recorded sprint
  closes left no milestone row of their own. `cmos_context(action="snapshot")` now refuses a source
  that reads as one of CMOS's automatic copies (`Context update:`, `session_complete:`,
  `context_condense:` and the like).
- **The sprint-close growth advisory counts only snapshots that still hold content**, so it clears
  once a prune has run (the prune keeps every row), and it names
  `cmos_db(action="prune_snapshots")`.
- **`cmos_project(action="init")` writes `AGENTS.md`** at the project root, the file many coding
  agents read, unless an agents file of any case is already there; an existing `agents.md` is left
  as it is. The seed template now ships as `cmos-seed/templates/AGENTS.md`, and the CLAUDE.md init
  writes points at whichever agents file the project has.
- **Node.js 20 or newer.** `engines` now says `>=20`, which is what `better-sqlite3` 12 needs; the
  docs said 18.
- **`cmos_review` no longer prescribes missions to a general-tier project.** With no missions, its
  answer leaves out the work-queue and `Next:` lines, and `workQueue.nextAction` reads "Nothing in
  progress." Other tiers are unchanged.

### Removed

- **`fast-xml-parser`**, a runtime dependency nothing imported.

### Fixed

- **`acrossProjects=true` no longer redirects a write.** `cmos_mission`, `cmos_decisions` and
  `cmos_learnings` skipped project resolution whenever the flag was set, on every action — so
  `cmos_decisions(action="record", projectRoot=B, acrossProjects=true)` dropped `B` and wrote the
  working directory's project. Only the three portfolio reads (`cmos_mission` status, `cmos_decisions`
  list, `cmos_learnings` list) skip the local requirement now; every other action resolves normally.
- **The docs are true for a stranger.** Each item was re-checked against the code:
  - Snapshots: README, SECURITY.md and getting-started now say the same thing. `cmos_db` takes a
    snapshot on demand, and CMOS takes one before and after every sprint close and before a
    snapshot prune applies; restore copies the live database aside first. They used to say backups
    were manual only, or that nothing snapshots before a destructive step.
  - SECURITY.md states that once any dashboard credential exists, every session or sprint close
    uploads the entire SQLite file, and documents `CMOS_CHECKPOINT_SYNC=off`, now also in README's
    environment block.
  - `cmos_message`'s full description no longer says it requires password environment variables; it
    names the device-code sign-in. `maxSnapshots` is described as the retention cap it is.
  - `DASHBOARD_NOT_CONFIGURED` means there is no sign-in. Its suggestion, README and the
    troubleshooting guide no longer blame an empty `CMOS_DASHBOARD_URL`, which has a default.
  - getting-started: `cmos_project(action="register")` records the project locally; the first close
    after you sign in registers it on the dashboard. The no-network claim says when it holds, and the
    loop opens with `cmos_review`.
  - README's first call starts with `cmos_project(action="init")`; onboard refuses without a
    database like every other tool.
  - SECURITY.md cites source by repository link and symbol name instead of line numbers that drifted
    and were dead links in the npm package.
- **No internal references in published text.** Tool descriptions, TOOL_REFERENCE.md, SECURITY.md
  and the seed schema every project receives no longer cite this repository's sprint, mission,
  decision or issue numbers, and a test keeps them out. Runtime messages that cited them (the
  `CMOS_PROJECT_ROOT` warnings, a pull warning, the untagged-decision advisory) say what they mean
  instead.

### Added

- **`cmos_db(action="prune_snapshots")`**, a supported prune for old context snapshots, requested by
  Stage1 (1,192 snapshots, 49.2 MB, and no safe way to remove them).
  - It is a dry run unless `confirm=true`. The dry run reports counts and bytes per context and why
    each kept snapshot is kept.
  - Applying takes a database snapshot first and stops if that fails. It then empties content in one
    transaction and never deletes a row, so ids, foreign keys and `snapshot_taken` events survive and
    a pull or backfill has nothing to restore.
  - It reclaims only copies the server wrote on its own (close copies, including legacy
    `session_runtime`/`mission_runtime` rows, update copies, and recovery copies older than 30 days).
    It always keeps:
    - the newest and last `keepLast` (default 30) per context, counting only snapshots that still
      hold content;
    - every snapshot a decision or a context's `archived_sprint_summaries` references;
    - sprint milestones, and the state each sprint close landed on when that close stored no
      milestone of its own. The answer counts closes as recorded (an event, or the close's own
      milestone row) or approximate (only an end_date), and counts Completed sprints with neither;
    - snapshots someone named;
    - the caller's `keepIds`, `keepSince` and `keepSources` (`*` patterns).
  - It refuses to apply while a decision column, a context, the event log or the sprints table
    cannot be read, since a reference or a sprint close there could not be honoured. It re-reads
    and re-selects under the write lock, and empties only rows the database snapshot holds.
  - The applied answer reports the content emptied, counted row by row per context and in total,
    and the content left.
  - A retention archive is kept while a context's `archived_sprint_summaries` names it. Once a
    re-archive, an aggressive condense or the 100-summary cap drops that entry, it is an ordinary
    recovery copy and is reclaimed once it is 30 days old.
- **`cmos_db(action="health")` reports `semanticSearch`**: whether the vector term can take part
  (`loaded`, `installed`, `not-installed` or `failed`) and why, without loading anything.
- **`CMOS_DEBUG=1`** brings back every startup and per-call diagnostic on stderr.
- **Server instructions.** `initialize` now returns instructions every MCP client can use without a
  rules file. The first 512 characters state the loop on their own: open with `cmos_review`, record
  a decision with `cmos_decisions(action="record")`, never edit one (supersede it), and pass
  `projectRoot` outside the project folder.
- **`cmos_decisions(action="show", decisionId)` and `cmos_learnings(action="show", learningId)`**
  read one row in full by id, the way to expand a preview. An id the project does not hold is
  refused by name (`INVALID_PARAMETER`).
- **An explicit `sprintId` on `cmos_session` start and capture.** It names an existing sprint of any
  status, for example a planned sprint for a planning session. A sprint that does not exist is
  refused by name (`SPRINT_NOT_FOUND`). On capture it tags the rows the capture writes, including
  the next-steps and constraints materialized at the session's close. A mission's sprint still wins
  when `missionId` is given, and since this release it decides those deferred rows too, where 3.1.0
  gave them the session's sprint.
- **Every success payload names the store it touched**: `data.projectRoot` and `data.resolvedBy`
  (`explicit`, `mcp-roots`, `cwd`, `server-project-root`, `registry-default`, or `none` with a null
  `projectRoot` for a portfolio, registry or dashboard-only call), plus one rendered line
  ("Project: <root> (resolved by …)") whenever `resolvedBy` is not `explicit` or `cwd`.
  `cmos_review` carries both fields inside its 4 KB digest budget.
- **`--project-root <dir>`**, a server argument for one MCP config: the project used by calls that
  carry no project context. This is the Claude Desktop recipe — local to that config, unlike a
  machine-global default.
- **Ephemeral stores.** `cmos_project(action="register")` returns `ephemeral` (with a warning) for a
  store under the OS temp directory, `/tmp`, `/private/tmp`, or a path in the new
  `CMOS_EPHEMERAL_PATHS` variable; `validate` reports them as `ephemeral`, and `validate` with
  `prune=true` archives them even while the store exists. Registry rows gain `defaultApplied`
  (`register`, `list`); `whoami` gains `registryDefault` and `serverProjectRoot`; `cmos_review`
  gains `registryDefault` when a default exists but is not applied.

### Internal

- **A test run can no longer rewrite the real build manifest.** The manifest generator takes
  `--dist <dir>`, its tests run the real script against a temporary directory, and the suite's
  global teardown fails the run if `dist/.build-manifest.json` changed. The server reads that file to
  report a stale build, so a full run used to make a running server think it was stale.
- **The unit suite denies outbound network.** A connection to any host that is not loopback fails,
  and fails the test that made it even when the code swallowed the error; a test opts in per origin
  with `allowNetworkOrigins`. A nested-jest test proves the failure is loud.
- **The packed-tarball E2E lane runs the clean-room scenarios** against the installed package: no
  write lands in another project from an unrelated folder or an explicit non-project root, a fresh
  project's opener carries nothing misleading, record → start → complete counts the decision, and
  `tools/list` stays under its ceiling. The publish workflow now runs the lane before it publishes.
- The session-capture tests drive the shipped handler instead of a private copy of an older one.
- The first test of the server-runtime suite no longer pays the module-compile cost under load; a
  warm-up does, under its own timeout.
- The Last Updated provenance oracle follows a renamed file across an older merge when every such
  merge predates the latest body change it found.

## 3.1.0 — 2026-09-18

Sprint 91 "What the Field Said". Fifteen days of field use of 3.0.0 reported that the write surface
still dropped data silently at the boundary an adopter touches first, and that a decision's
lifecycle status stood in for whether it was still true. This release fixes the first and encodes
the operator's three-lifecycle policy for the second. It is a **MINOR** release under this project's
rule: no published receipt field is removed or renamed. Every receipt change is additive, and
supersession candidates keep `decisionText` with a bounded value. Two behaviour changes are
disclosed under Changed with their consequence, because a caller of 3.0.0 can observe them:
undeclared top-level parameters are now refused, and a sprint close drops next-steps whose lease
lapsed.

### Added

- **`cmos_decisions(action="record")` writes a decision without a session, and supersedes what it
  corrects in the same call.** Parameters: `content` (required), `missionId`, `sprintId`,
  `supersedes` (decision ids), `evidence`, `citesLearningIds`, `domain`. The row's sprint is the
  mission's sprint when `missionId` is given, else an existing `sprintId`, else the open sprint, else
  `null` (disclosed as a warning). Each `supersedes` id must exist and is set
  `status='superseded', superseded_by=<new id>` in the same transaction as the INSERT; the receipt
  echoes `previousStatus → newStatus` per target. A retry with identical text by the same author
  returns the existing row (`materialization: "existing"`) instead of writing a second one. This is
  the recovery path for decisions lost on `cmos_mission_transition(action="complete")`: record them
  with `missionId` after the mission has completed. Decision text is never amended in place; a
  correction is a new row that names what it supersedes.

### Changed

- **Unknown top-level parameters are refused before dispatch; update refusals name the `fields`
  wrapper.** Every published tool schema has declared `additionalProperties: false` since it was
  published, and nothing enforced it: a misplaced key was dropped silently and the call succeeded
  without it. A call carrying a key its tool does not declare now returns `INVALID_PARAMETER` with
  `field` set to that key, after the existing action and `projectRoot` checks and before any store
  is opened; when the key belongs to a nested object on the same tool, the suggestion names it (for
  example `metadata` → `fields` on `cmos_mission(update)`). **Consequence:** a caller that sends an
  undeclared key and received a success on 3.0.0 receives a refusal on this release. Inside
  `fields`, `cmos_mission(update)` and `cmos_sprint(update)` refuse an unknown key by name instead of
  skipping it while reporting it in `updatedFields` — and an all-unknown `fields` object no longer
  executes an empty `UPDATE` that failed with `DB_QUERY_FAILED` and the advice "Check the SQL syntax".
  The no-fields refusal now says `fields: { ... }` and that a bare top-level `notes`/`status` is not
  read.
- **Mission and session completion refuse to transition when a sibling array was absorbed into a
  free-text field.** When a host drops a closing tag, `decisions=[...]` (or `agentFeedback`, or for
  sessions `nextSteps`) lands inside `notes`/`summary` as a literal `<parameter name="…">` token;
  the sanitizer strips it and the parameter arrives empty. The server used to complete the mission
  anyway, report "no decisions captured", and answer a retry with "No action needed". It now
  refuses with `INVALID_PARAMETER` (`field` = the lost parameter) before the transition, so the
  mission or session stays open, and names the retry plus `cmos_decisions(action="record")`. An
  absorbed tag that names no missing sibling completes as before with `sanitizedFields`. An
  already-Completed retry that carries `decisions` or `agentFeedback` now names the record remedy.
  The build tier guide, getting-started guide, and build-session prompt now teach notes-only
  completion with a separate `record` per decision.
- **Sprint close drops next-steps whose lease lapsed; the survey includes carried rows and per-row
  age.** A next-step now holds a lease. Its age is the number of sprint closes it has survived:
  Completed sprints with a recorded `end_date` later than its last carry (or, if never carried, its
  creation). The closing sprint never counts toward its own close. At 3 the row is warned; at 4,
  unless carried in between, `cmos_sprint(action="complete")` sets it `dropped` inside the close
  transaction and lists it in the new `lapsedDroppedIds`, with the exact
  `cmos_context(action="next_steps", nextStepAction="reopen", nextStepIds=[...])` undo printed
  beside it. Carrying renews the lease; reopening restarts it from creation. The close still never
  writes `completed`. `nextStepsSurvey` now covers pending **and carried** rows and gains
  `totalOpen` and a `lease` block (thresholds, counting rule, warned and lapsed ids); `totalPending`
  keeps its meaning. `cmos_context(action="next_steps", nextStepAction="list")` with no status now
  lists every open row with `closesSurvived` and `lease`, and `cmos_review` names the ids the next
  close will drop. **Consequence:** a store taking this release with rows already four or more
  closes old drops them at its first close, before any earlier warning could have appeared; each is
  one pasted `reopen` from restored.
- **Sprint transitions write the identity pointers the digest reads; the digest labels a fallback
  sprint.** `cmos_sprint` add (with an open status), update (on a status change), and complete now
  keep `master_context.sprint_tracking.current_sprint` (`{id, title, status, focus}`, or `null` when
  nothing is open) and `last_completed_sprint` in step; the close writes them inside its transaction.
  `project_identity.status` is not written by sprint handlers (it is the project's status), and no
  `metadata.current_sprint` / `metadata.sprint_status` keys are created (nothing reads them).
  `cmos_review`'s `sprint` block gains `resolvedBy: "open" | "fallback"`, and a sprint named because
  none is open renders as `[Completed, most recent; none open]` or `[Planned, next; none open]`.
- **Untagged decisions age on wall-clock time in staleness review.** `cmos_decisions(action="review")`
  used to filter out every decision with no sprint tag, so one captured while no sprint was open
  could never be flagged stale however old it was. Untagged rows are now scored by age in 14-day
  periods since creation, and the advisory says so.
- **Supersession candidates are scoped to the capturing sprint and rare-term weighted; receipts are
  bounded.** Eight field reports showed decision capture offering the historical review verdicts a
  close cites as rows to supersede. Candidates now come only from the new decision's own sprint
  (untagged matches untagged); overlap is counted on whole tokens (`sprint` no longer matches
  `sprints`), weighted by inverse document frequency over active decisions with house-style terms
  in more than 30% of them contributing nothing, and ranked by length-normalized similarity; a
  decision the new text cites as `#<id>` is never offered. Each candidate carries a new
  100-character `preview` and a `score`; `decisionText` is kept and now holds the same preview
  rather than the full text, so no key is removed. The rendered capture receipt echoes the first
  100 characters of the content plus its stored length. **Consequence:** a genuine supersession of
  a decision from an earlier sprint is no longer suggested; record it explicitly with
  `cmos_decisions(action="record", supersedes=[...])`.

### Fixed

- **Dependency advisories cleared within existing ranges.** `package-lock.json` moves
  `@hono/node-server`, `hono`, `body-parser`, `qs`, `ip-address`, `fast-uri`, and `fast-xml-parser`
  in the production tree (and eight dev-only packages) to patched versions without changing any
  declared range; `npm audit --omit=dev` goes from 9 findings to 2. The two that remain are
  `@xenova/transformers` → `sharp`, accepted because the text-embedding path never decodes an image
  and the only fix npm offers is a semver-major downgrade of `@xenova/transformers`.

## 3.0.0 — 2026-09-01

Sprint 90 "The Front Door". This is a **MAJOR** release because
`cmos_sprint(action="complete")` removes the published `nextStepsReconciled`,
`nextStepsCarried`, and `pendingFlagged` receipt fields and replaces them with
`nextStepsSurvey`. The published `reopen` next-step sub-action is additive, while the remaining
wire and first-run behavior changes correct defects; neither makes the removed fields
backward-compatible. A 2.9.0 or 2.8.2 cut was therefore rejected.

### Added

### Changed

- **Once a CMOS project is initialized and resolved, fresh installs can start dashboard device-code
  authentication without setting `CMOS_DASHBOARD_URL`.** Explicitly invoking
  `cmos_auth(action="login")` or `login_init` now uses the canonical URL resolver — environment value,
  then baked `https://cmos.aquex.ai` for normal MCP calls — instead of returning
  `DASHBOARD_NOT_CONFIGURED` when the environment variable is absent or empty. Either action can
  therefore make an outbound request to the baked host. `login_complete` uses the same host when
  supplied a `deviceCode`; without one it returns local `MISSING_PARAMETER` and sends nothing. The
  large-delta database-backfill upload remedy now uses the same canonical resolver.
- **Release-version coherence is now one executable class gate instead of a hand-copied
  checklist.** The gate couples `package.json` to both package-lock root stamps, the newest dated
  CHANGELOG heading, and the private authority-document version stamps while explicitly
  classifying schema, template, scaffold, and release-boundary tag axes. It runs on the
  mirror-visible members in the public suite, and the release runbook invokes that same test
  instead of carrying a second inline comparison. The two stale package-lock root stamps were
  corrected from 2.8.0 to match 2.8.1 before this cut and now move with the package version; the
  published `v2.8.1` tag and history are unchanged.
- **Sprint close now treats next-step mission links as provenance, not proof of delivery.** It no
  longer auto-completes `next_steps` rows or deletes context prose merely because it contains a
  completed mission or closing-sprint token, including when optional close-time condensation is
  requested. Close-time retention for the canonical master-resume and project-working-memory
  arrays is count-only (newest 15 / newest 10 respectively); legacy array shapes are left intact.
  The old `nextStepsReconciled`, `nextStepsCarried`, and `pendingFlagged` receipt fields are
  replaced by a whole-ledger `nextStepsSurvey` grouped by closing-sprint, other-sprint, and
  missing-sprint provenance. `cmos_context(action="next_steps")` also adds explicit-ID `reopen`,
  while `carry` to a nonexistent sprint now returns a named `carryToSprint` refusal with
  create-or-park remedies instead of a raw foreign-key failure.
- **The MCP stdio boundary now refuses a wrong-typed `projectRoot` before sender resolution.**
  Re-measured over every (tool, action) pair published by the server's own `tools/list` (83) × six
  non-null wrong JSON values (498 calls), 455 calls in the original 2.8.1 live-store measurement
  change code or outcome. Twenty calls that had succeeded with `projectRoot: 0` now return
  `INVALID_PARAMETER` because that falsy value was treated as absent and silently substituted the
  discovered project, including on registry writes. JSON `null` remains absent-equivalent, and
  `INVALID_ACTION` takes precedence. `projectRoot` is the only published string parameter read
  unsafely before dispatch; the standing AST gate separately re-derives every raw pre-dispatch
  read and the rule-classified unsafe-string subset instead of trusting that sentence.

### Fixed

- **Literal first-run failures over MCP stdio now name the reachable local cause instead of
  reporting an unhandled internal error.** With an empty working directory, a fresh
  `CMOS_CONFIG_DIR`, and no arguments beyond each published action, 74 of 82 driven pairs returned
  `TOOL_EXECUTION_ERROR` with a correlation ID and “report this” advice; the server published 83
  pairs, but the legacy blocking `cmos_auth(login)` action was explicitly excluded. Those 74 paths
  now return `CMOS_NOT_DETECTED`. Separate missing-database, unreadable-database, invalid-identity,
  and ambiguous-sender fixtures pin `DB_NOT_FOUND`, `DB_CONNECTION_FAILED`, and
  `SENDER_UNRESOLVABLE`; none of these known first-run/setup refusals reaches the catch-all.
  The final gate derives and drives all 83 published tool/action pairs with zero exclusions,
  re-drives the network-bearing no-argument auth actions against loopback, and proves missing-code
  `login_complete` refuses locally. `CMOS_NOT_DETECTED` and `DB_NOT_FOUND` repair advice now carries
  a JSON-string `projectRoot`; the gate extracts that emitted value, initializes that exact physical
  root, and proves the original call succeeds on retry.
- **Unknown tool calls now retain the MCP protocol's `-32601` `MethodNotFound` response.** The
  registered boundary previously remapped that already-classified protocol error to `-32603`
  `InternalError`; schema preflight and protocol lookup now run before the review-role write guard,
  while known valid writes remain blocked for review agents.
- **Public mirroring now pushes the filtered branch and release tag as one atomic boundary.** The
  prior sequential pushes could leave public `main` advanced without its tag, and a retry then
  exited early because the tree already matched. The no-diff path now creates or validates the
  missing tag, the branch and tag move in one `git push --atomic` transaction, and the script
  reports the exact public commit id used for independent verification.

## 2.8.1 — 2026-08-30

Sprint 89 "Sweep the Class" — Arc F sprint 3. Corrections and hardening for the 2.8.1 patch.

### Fixed

- **The 2.8.0 notes now disclose the `currentState` response-shape change they were the stated
  reason for accepting.** Decision #1066 admitted the change because "the 2.8.0 release boundary
  makes the shape change explicit"; the 2.8.0 section named the field zero times, filed the change
  under `### Added`, and justified MINOR with a tool-inventory sentence that cannot see a field
  type. The disclosure is now the first bullet of 2.8.0's `### Changed`, and that section's
  preamble states the scope of its MINOR claim and what the claim cannot see.
- A standing repository gate now fingerprints declaration composition (type-alias right-hand
  sides, type parameters, heritage, and every interface member signature) for every `*Error` /
  `*Result` root exported by a CMOS tool module and its `src/`-wide transitive closure, then
  snapshots the 1,486 direct property rows with declared and checker-resolved kinds. It also ledgers mixed-runtime-kind
  rows and explicit opaque/generic blind spots. The tool INPUT surface has had a checked-in snapshot
  since `tests/tools/__snapshots__/tool-definitions.test.ts.snap`; this bounded answer-type surface
  had none, which is why a tool-inventory sentence was the only shape claim the 2.8.0 preamble had
  available.
- `agents.md`'s response-pattern block declared `currentState?: any` and `validValues?: any[]`,
  neither of which is what `src/tools/cmos/types.ts` declares. Both corrected; the block's other
  six fields were checked against the same source and were already right.
- README's error-response section now says what `currentState` actually carries.
- **The seed schema reference no longer names a nonexistent `strategic_decisions.decision`
  column.** The real column is `decision_text`. The false row shipped in 2.8.0 and is copied into
  every new project by `cmos_project(action="init")`; following it made SQLite report
  `no such column: decision`. The shipped-prose gate now executes the seed schema in memory and
  checks column, executable-SQL, and tool/action claims against the artifact that owns each role
  instead of merely checking whether a token exists somewhere in source.
- **Staleness detection now orders canonical sprint IDs numerically instead of by row
  insertion.** Stores whose sprint rows were inserted out of numeric order may flag additional
  stale decisions or learnings on the first staleness-maintenance pass after upgrading.
- **The public clone now has honest tests and a single-source release path.** Tests that require
  private-only evidence skip loudly only in the public mirror and still fail on partial absence
  in the private source. README no longer claims disabled public CI, and the private npm-publish
  workflow is no longer mirrored alongside release tags.
- **Store-level schema labels no longer downgrade or masquerade as migration-completion proof.**
  `metadata.schema_version` is now a monotonic high-water label whose guarded writes re-check the
  current value atomically, while vector storage owns the new
  `metadata.vector_storage_columns = '2.3'` completion marker. A store without that marker performs
  one forced double-FTS rebuild on its next retrieval and then stamps the marker, both provisioning
  missing structures and making the repair self-healing; the current dogfood baseline rebuilt 765
  indexed rows. `cmos_project(action="init")` now preserves and reports an existing 2.4 label
  instead of overwriting and reporting it as 2.1.
- **A wrong-typed published string parameter crashed the tool instead of being refused.** A JSON
  number, object, array or boolean sent for a property the shipped `inputSchema` declares
  `type: "string"` reached an unguarded string method or `path.resolve` and threw, and the
  catch-all boundary dressed the crash as `TOOL_EXECUTION_ERROR` with the message
  `params.missionId.trim is not a function`. Measured across every (tool, valid action,
  declared-string-parameter) triple: **42 of 714 triples crashed; 0 do now.** One schema-driven
  guard at each of the 15 router entry points refuses them as `INVALID_PARAMETER` naming the field.
  > CORRECTION (3.0.0). The sentence “Measured across every (tool, valid action,
  > declared-string-parameter) triple: 42 of 714 triples crashed; 0 do now” is true of the universe
  > it measured and false of the surface a caller touches. Those 714 triples invoked the 15 router
  > functions directly, and the guard sits inside those routers, so it answers for them. It does
  > not answer for MCP stdio: `src/index.ts` resolves `params.projectRoot` through
  > `resolveToolSenderContext` before router dispatch, so a wrong-typed value can throw from
  > `path.resolve` before the guard runs. A historical real-stdio remeasurement over all 83 pairs
  > published by `tools/list` × six non-null wrong JSON values (498 calls) found 380
  > `TOOL_EXECUTION_ERROR` results. The predicate was right; the universe was wrong. The corrected
  > wire claim and its standing gate are recorded in 3.0.0's entries above.
- **A malformed value for a parameter the action actually uses was silently ignored, so filters
  came back unfiltered.** `cmos_learnings(action="list", category=12345)` and
  `cmos_decisions(action="list", since=12345)` dropped the malformed filter and returned the
  UNFILTERED result set, which a caller has every reason to read as filtered. 31 triples were in
  this shape. They are now refused as `INVALID_PARAMETER` naming the field. See `### Changed` for
  the wire-level detail.

- **Two error suggestions prescribed a remedy that reproduced the refusal, and one hid a
  precondition.** `CmosErrors.contextNotFound` and `cmos_context(action="condense")` both told the
  caller to "use `cmos_context(action="view")` to list available contexts"; there is no listing
  action, `view` needs the very row that is missing, and executing it returned the same
  `CONTEXT_NOT_FOUND`. Both now state that the row is absent and must be recreated, and the
  recognized types stay on `validValues`. `cmos_db(action="purge")`'s confirmation refusal now
  discloses that the prescribed retry only runs when the project has a configured dashboard
  mirror. Found by executing the remedies, not by reading them.

### Changed

- **Error codes change for malformed input on parameters an action uses.** The guard above is
  scoped by the published per-action applicability contract (the per-action tables in
  TOOL_REFERENCE.md), so it only inspects parameters the action actually reads — 219 of the 714
  triples. Measured over those 714 triples x four wrong JSON types = 2,856 calls, the transitions
  are:
  - **`TOOL_EXECUTION_ERROR` → `INVALID_PARAMETER`** — 168 calls that previously crashed.
  - **success → `INVALID_PARAMETER`** — 76 calls across 31 triples, all of them a filter or
    identifier the action reads and was silently discarding.
  - **another refusal code → `INVALID_PARAMETER`** — 588 calls that already failed, but under a
    downstream code (`MISSING_PARAMETER`, `DB_QUERY_FAILED` and others) rather than one naming the
    malformed field.

  **1,980 calls are deliberately left untouched**: a malformed value on a parameter the action does
  not read — `cmos_message(action="whoami", body=12345)` — still succeeds, because the call did
  what the caller asked and failing it buys nothing. **JSON `null` is also unaffected** and is still
  treated as an absent optional: all 714 of its outcomes are byte-identical before and after.

- **The catch-all tool boundary no longer claims to know why a call failed.** It used to answer
  every unhandled exception with "This is an internal error, not an input-validation problem —
  retry the call", which was false for the whole wrong-typed-parameter class above and prescribed a
  loop with no exit. It now reports only what that frame knows: an unexpected exception, the raw
  message, the correlationId, and that a repeat with the same inputs indicates a deterministic
  fault.

## 2.8.0 — 2026-08-29

Sprint 88 "Fix the Instrument" — Arc F sprint 2. This release repairs the claims and gates that
made 2.7.0's behavioural audit look more complete than it was, makes sprint close evidence
self-describing, separates read-only discovery from identity registration, and carries migration
warnings all the way to the agent-visible answer.

It is a MINOR release, and the scope of that claim is the TOOL INVENTORY AND ITS INPUTS: the 15
consolidated MCP tools, their `action` values, and their published `inputSchema` properties are
unchanged apart from one added optional input (`evergreen`). **That claim structurally cannot see
a response-shape change, and this release contains one** — no tool declares an MCP `outputSchema`,
so the protocol publishes no response schema for automatic validation of a widened field. The
response change is the first entry under **Changed** below.

> CORRECTION (2.8.1). This preamble originally ended "It remains a MINOR release: no consolidated
> MCP tool was added or removed." That sentence is true and was checked, but it is a tool-inventory
> rule and a reader takes it for a compatibility guarantee it does not provide. Decision #1066
> accepted the `currentState` shape change specifically because "the 2.8.0 release boundary makes
> the shape change explicit"; this section did not make it explicit. The entry below is that debt
> paid, and it is dated to 2.8.1 rather than backdated. On `SESSION_ALREADY_ACTIVE` specifically,
> `currentState` changed from a session-id string to `{ id, type, title, startedAt, captureCount }`.
> Consumers should branch on `error.code`, read `.id` for that error, and narrow the field before
> applying generic string operations.

### Changed

- **`error.currentState` can now be an object instead of a string — on one error code.**
  `cmos_session(action="start")` returning `SESSION_ALREADY_ACTIVE` used to put the active
  session's id there as a bare string (`"PS-2026-08-29-006"`). It now puts a five-field object —
  `{ id, type, title, startedAt, captureCount }` — where `captureCount` is `null` when the stored
  capture value is missing, malformed, or not an array. `CmosToolError.currentState` widened from `string` to
  `string | Record<string, unknown>` to allow it, and the value reaches MCP clients on
  `structuredContent`, not only in the rendered text. **No other error uses an object today**: 13
  other sites set a status string (`"In Progress"`, `"Completed"`, `"Dropped"`, …), and the
  sprint-complete site passes its status when present or omits the field when it is null. Branch
  on `error.code` and read `error.currentState.id` for this one code. Calling a string method such
  as `startsWith` without narrowing now throws, direct equality with the former id returns false,
  and interpolation yields `[object Object]`. Code that handles `currentState` generically across
  error codes should test `typeof currentState === 'string'` first. The rendered
  `content[0].text` channel did not suffer this coercion break; it now adds a five-line
  active-session detail block (id plus type, title, start time, and capture count). This stayed a
  MINOR bump on measured grounds: the field is diagnostic data for one error code, the supported
  type entrypoint (`dist/index.d.ts`) does not export `CmosToolError`, and `exports` publishes no
  subpath, so modern exports-aware Node and TypeScript resolution reject the deep import. The
  underlying `dist/tools/cmos/types.d.ts` does ship, however, and legacy exports-blind TypeScript
  resolution can reach it; a bespoke consumer may therefore observe the break. No tool declares
  an `outputSchema`, so MCP metadata exposes no response schema for automatic client validation.
  Pin `2.7.0` if your integration cannot accommodate the change.
- **Read-classified calls and `cmos_review` no longer register a project or mint its identity.**
  `getProjectId` is now a pure lookup. Explicit `cmos_project(action="register")` and ordinary
  write boundaries perform registration and identity persistence instead, including an explicit
  `projectRoot`. Identity-less reads continue to work and now disclose their unattributed state
  on the answer rather than only on process stderr.
- **Project identity collisions fail closed at registration and restore boundaries.** Physical
  path aliases resolve to the same store, identity-less snapshots are reconciled to the live
  identity, and a foreign snapshot is rejected with database and graph state rolled back.
- **Sprint ordering is numeric for canonical ids.** `sprint-9` now sorts before `sprint-10` while
  mixed or non-canonical ids retain a deterministic fallback order.
- **Dependency relationships are documented as record-only.** `Blocks`, `Requires`, and `Enables`
  feed ordering and graph expansion; they do not prevent a mission from starting or completing.
- **Migration and sync warnings reach the existing response warning channel.** All 41 answer-bound
  calls to the 21 exported `MigrationResult`-compatible schema helpers now consume or forward
  warnings; the 7 remaining calls have no answer carrier. Pull-before-push warnings also survive
  every mutable-push success and error path, with exact-string deduplication.

### Added

- **Sprint-close receipts now audit the process that produced them.** The result includes
  `activeSessionsAtClose`, `startupBuildTime`, and `driftMinutes`, verifies that the archival id
  arrays exist, and renders reconnect guidance from the measured process state.
- **Session-capture receipts identify what was written and when it materializes.** Decision and
  learning captures return their row id, next-step captures disclose that they materialize at
  session close, learning capture accepts `evergreen`, and `SESSION_ALREADY_ACTIVE` identifies the
  active session and its pending captures.
- Standing tests now inventory legacy tool-definition modules, prove shipped `Last Updated` stamps
  change when their body changes, cover both `.execute()` and `.raw()` write guards, and publish
  executable semantic warning censuses. The formatter census closes from 93 of 103 genuine render
  returns carrying warnings to 103 of 103; deliberate error preambles and delegations are counted
  separately.

### Fixed

- Rejected next-step writes no longer misreport SQL failures as `unmatchedIds`, and completed sprint
  guidance no longer tells an operator to complete work that is already complete. Seven shipped
  assertions found by the sprint-87 review were corrected rather than preserved as compatibility
  text.
- `cmos_sprint(action="analytics")` now states that its counts use direct `sprint_id` membership and
  reports an unavailable count as unknown rather than zero.
- Advisory schema migrations no longer report false-current after a failed or incomplete DDL step.
  They validate same-named virtual tables and triggers before claiming them, rebuild empty FTS
  indexes when source rows exist, retry when a missing base table later appears, preserve schema
  markers newer than 2.3, and warn without throwing or overwriting a conflicting object.
- The schema write guard now sees raw DDL as well as prepared execution, closing the path that could
  swallow a failed `CREATE VIRTUAL TABLE` and still return `alreadyCurrent: true`.

## 2.7.0 — 2026-08-28

Sprint 87 "Mean What You Say" — Arc F sprint 1. Sprint 86 closed the axis a mechanical gate can
see: every identifier a surface names now exists. This one is the behavioural half — a surface
that asserts something that is not so where no name-existence sweep can look. A remedy that names
the wrong cause. A count that reports a write while hiding which rows it touched. An instrument
that reads evidence it created.

### Changed

- **`cmos_sprint(action="complete")` names the ids it archived, and hands back an undo handle.**
  The result gains `archivedDecisionIds`, `learningIds` and `preCloseSnapshotId`, and the rendered
  close line prints the ids rather than only a count, truncating past 30 with an explicit
  `+K more`. The archival was previously unnamed on the tool's published description, unitemised
  in its return, and irreversible.
- **`evergreen = 1` learnings are no longer archived at sprint close.** A behaviour change on a
  ratified write: an institutional-rule learning an operator flagged is no longer demoted every
  time a sprint ends. Decisions have no equivalent flag and are unaffected.
- **`cmos_status.last_sync_at` and `cmos_agent_onboard`'s sync-health counts now describe THIS
  project.** They were fetched unscoped and reported a platform-wide figure inside a
  project-scoped payload, so **these numbers change value on every install**. On this machine
  `last_sync_at` was 32 days optimistic.
- **Portfolio drift reasons now read "no new CMOS rows in Nd" instead of "no CMOS write in Nd",
  because the mechanism changed with the word.** Store freshness is derived from the newest row
  stamp across six domain tables rather than from a file mtime — a signal `cmos_review`'s own
  cross-store fan-out created by opening each store. Measured effect: silent stores 3 → 5, with
  two previously-understated ages corrected (41d → 105d, 41d → 78d) and one store that had been
  classified FRESH for months newly reported at 48d.
- **`MISSION_TERMINAL_STATUSES` no longer contains `Failed`,** which widens a live
  orphan-detection predicate: a sprint-less mission stored as `Failed` now reports as orphaned.
  Unwitnessed — no such row exists in this store or across the fleet.
- **Provenance tags stop naming `unknown-project`.** A row whose store records no identity now
  renders as `unattributed` rather than `proj:unknown-project`, which named a project that does
  not exist on the prompt-injection defence surface. **The untrusted fence is unchanged** — those
  rows are still framed as foreign.
- **`MessageSendResult.messageId` is now optional.** The dashboard's send route returns
  `messageId`; this field read `id` and rendered `ID: undefined` on every successful send. When no
  id comes back the line is omitted and an envelope warning names the absence.
- **`cmos_agent_onboard`'s messaging block reports a project-scoped unread count**, replacing
  `unreadCount` with `unreadCountScoped` / `unreadCountUserWide` / `unreadScope`.
- **The next-steps transition accepts `carried` rows.** Rows carried to a later sprint could not
  previously be completed, dropped or re-carried by id.
- **`skipped-unconfigured` is gone from the startup key-recovery status union.**

### Added

- `preCloseSnapshotId` on the sprint-close result — a database snapshot taken BEFORE the closeout
  transaction, so every archived row is restorable.
- `unmatchedIds` on the next-steps result: which requested ids a transition did not match.
- `unreadCountScoped` / `unreadScope` on `ListMessagesResult`.
- `--strict` on `npm run baseline:cross-store`, which exits non-zero when any store's counts are
  unreliable rather than publishing a partial share under a zero exit code.
- A per-store identity disclosure that names the store whose identity is unrecorded. It was one
  process-wide line naming no path, so in a portfolio fan-out the first affected store silenced
  every other one. **It is a disclosure, and heals no already-stamped row** — restamping rows that
  already carry the `unknown-project` literal is an operator action outside this package. Swept at
  close with `find <home> -maxdepth 7 -path '*/cmos/db/cmos.sqlite' -not -path '*/node_modules/*'`:
  45 stores, 32 resolving by a non-empty `project_id`, 13 collapsing to the literal, 0
  unclassifiable. Scope limit: one home directory on one machine — the count bounds nothing beyond
  it.

### Fixed

- **The mission-transition surface no longer crashes on a mission row this repo's own store
  holds.** Six handlers dereferenced a state-transition table with a status read from the
  database, throwing an unhandled `TypeError` that the MCP boundary reported as "an internal
  error … retry the call" — a loop with no exit. 15 mission rows across 4 of 21 registered stores
  were unusable through `cmos_mission_transition`.
- Two false refusal strings: a terminal mission was said to be unchangeable when only its STATUS
  is settled, and an unrecognized status was answered with a transition error rather than being
  named.
- A read-only client could not open a store that was not already in WAL mode, because the
  `journal_mode` pragma is itself a write and was issued unconditionally. Latent: no shipped code
  path passes `readonly: true` to that client today.
- The published seed no longer ships three empty-string identity rows, and its `Schema Version`
  stamps and one documented column name (`event_data` → `payload`) now match the schema it ships.
- The `whoami` no-roots warning no longer fires alongside a fully resolved payload.
- A `cmos_auth(action="reissue")` that fails dashboard-side no longer destroys the local project
  key, and its error message no longer double-prefixes `Dashboard error:`.

### Removed

Every entry here is unreachable or ignored surface **by measurement**, which is what keeps this
release MINOR rather than MAJOR. Each cites its evidence.

- `CmosReviewResult.warnings` — assigned `[]` at `cmos-review.ts` exactly once and never written
  anywhere, so its renderer could only ever print an empty list and its size-trim stage could only
  ever remove nothing. The **envelope** warnings channel is a different object and is unaffected.
- `MessagingSummary.unreadCount`, replaced by `unreadCountScoped` / `unreadCountUserWide` /
  `unreadScope`. Measured live: `.data.messaging === null` — the block carrying this field did not
  render at all, because its client resolved through an env-only path that errors on a device-code
  install. See the revival below.
- `'none'` from the `KeySource` union — **no producer in `src/` ever emitted it**; a resolver that
  finds no credential returns a failure rather than a success carrying `keySource: 'none'`. Now
  asserted by a standing gate that every union member has a producer
  (`tests/auth/user-scoped-resolution-gate.test.ts`).
- `skipped-unconfigured` from the startup-recovery status union — **zero producers** once the
  null-client path routes through classification, asserted by the same gate. It was not repointed:
  filing a genuine internal inconsistency under a word meaning "not configured" would name the
  wrong cause, and a store holding keys is not unconfigured.

**The one genuine consumer break is in `### Changed`, not here:** `MessageSendResult.messageId`
becomes optional. It ships MINOR on this project's own measured precedent — `## 2.4.0`'s "One
consumer-visible break — see **Changed**" and 2.6.0's `unreadCount` → `unreadCountUserWide`
rename — and it carries its own named bullet rather than being bundled.

### Revived

Two surfaces that were silently absent, not wrong. Said as revivals deliberately: claiming a wrong
number was corrected would assert something that never happened on screen.

- **`cmos_agent_onboard`'s messaging block STARTS APPEARING** for device-code installs. It
  resolved its client through an env-only path, so on such installs it errored and returned null
  with an explicit "don't warn" comment — the block rendered nothing at all.
- **The `Healed stale cmos_address from X to Y` notice STARTS APPEARING** on the strict-success
  path, where it has been silently dropped since sprint 53.

## 2.6.0 — 2026-08-12

Sprint 86 "Say Only What You Know" — the honest-surface release. Sprint 85 made the durable
**record** honest; this release makes the **surface** honest: a shipped string, count or schema
that confidently asserts something that is not so. The **15-tool contract holds** —
`cmos_mission` gains a `move` action, which is a new action on an existing tool, not a 16th tool.

Nothing that worked was taken away. The two `### Removed` entries below are unreachable or
ignored surface, which is why this is a MINOR and not a MAJOR.

### Changed

- **Counts and success flags returned by write actions are now computed from what the database
  did, rather than from what the handler intended (s86 m02).** The one operators have been
  reading is `cmos_sprint(action="complete").nextStepsReconciled`: it now reports the rows the
  bulk `UPDATE` actually changed. That number can differ from the intended count for **two
  different reasons, and they are not the same news**. Either the statement errored — which is
  now surfaced as a `writeFailures` entry carrying the database's own error code — or a target
  row was simply no longer `pending` when the statement ran, which is a benign `WHERE`-miss and
  produces **no** `writeFailures` entry. A lower number is not by itself evidence that anything
  went wrong; read `writeFailures` to tell the two apart.
- **`cmos_sprint(action="list")` and `cmos_sprint(action="show")` now report `totalMissions`
  EXCLUDING Deferred and Dropped missions, accompanied by a new `parkedMissions` count
  (s86 m08).** This is a corrected count on two **read** actions, and it is a separate risk
  from the write-side change above: the numbers move on every store, for every sprint that ever
  deferred or dropped a mission, with no call-site change on the consumer's part. A sprint that
  completed all its live work while parking some now reads as complete instead of being
  permanently punished in its own denominator. Both actions read the `sprint_summary` view
  directly, so a store gets the new numbers as soon as the view migration runs. Where the view
  cannot be upgraded (a read-only store, or a same-named base table already occupying the name),
  both actions report `parkedMissions: 0` and carry the migration's reason rather than failing.
- **33 published numeric declarations tighten from `"type": "number"` to `"type": "integer"`
  (s86 m04).** CLIENT-SIDE VALIDATION ONLY — no server behaviour changes, and no call that was
  correct before is rejected now. 30 scalar parameters plus 3 array item types (`nextStepIds`,
  `constraintIds`, `decisionIds`). Three parameters deliberately remain `number` because they
  are genuinely non-integer: `cmos_sprint.targetSizePercent`, `cmos_context.targetSizePercent`
  and `cmos_context.recencyWeight`.
- **SEPARATE, and a different risk class: three input schemas change their accepted value sets
  (s86 m04), and one of them WIDENS.** `cmos_learnings.status`'s **published** enum widens from
  `['active','archived','superseded']` to include **`'stale'`** — the server has been writing
  that value itself (`src/tools/cmos/staleness-detection.ts:519`,
  `UPDATE learnings SET status = 'stale'`), and 246 such rows exist
  across 7 of the 18 stores measured, so the published contract had been forbidding callers from
  naming a value the server writes. `cmos_decisions` never had this asymmetry, which is the
  evidence the enum was the wrong side rather than the data. With the set corrected,
  `cmos_learnings.status` and `cmos_decisions.status` tighten from a bare string to that
  four-member enum, so a value outside it is now a validation error instead of a silent no-match.
  `cmos_learnings.category` goes the **other** way: its published enum is **dropped entirely**
  and its input stays a free string, because the column is `TEXT` with no `CHECK` constraint and
  a closed set claimed an enforcement the server does not perform — the fleet already carries an
  out-of-set value. The four canonical categories are documented as guidance, not as a contract.
- **Every leaf formatter now renders the envelope `warnings` channel (s86 m02).**
  `CmosToolResult.warnings` ships inside `structuredContent`, but an agent reads
  `content[0].text` — so a warning no formatter rendered was present in the payload and
  unreadable in practice. Measured before the fix, across 76 leaf formatters: **14 rendered the
  envelope channel, 57 rendered nothing at all, a further 4 rendered only a data-level
  `warnings` field of their own** (a different channel), and 1 takes no result at all. So 61
  leaves were silent on the envelope channel. **Consumer-visible consequence: advisories that
  have been shipping invisible since 2.5.0 — including s85-m04's `missionId` advisory — appear
  in the text channel for the first time.** Answers get longer; nothing else about them changes.
- **Separately: the write actions that can partially fail now render a data-level
  `writeFailures` block (s86 m02b).** This is a **different channel** from the envelope
  `warnings` above — it is `result.data.writeFailures`, not an envelope field — and it is
  carried by the seven actions whose writes can fail row-wise while the answer still succeeds:
  `cmos_sprint(complete)`, `cmos_session(capture)`, `cmos_session(complete)`,
  `cmos_context(next_steps)`, `cmos_context(constraints)`, `cmos_decisions(batch_update)` and
  `cmos_project(update)`. An empty list renders nothing, deliberately: a `WHERE` that matched no
  rows is a legitimate outcome, not a failure. Other actions do not carry this field.
- **`cmos_message(action="list").unreadCount` is renamed to `unreadCountUserWide`, joined by a
  new view-scoped `unreadInThisView` (s86 m07).** The dashboard's unread number is USER-WIDE
  across every project you own, while the rows returned beside it are scoped to the calling
  credential, tab and filters — under one name they produced a header that read
  `0 total, 7 unread` against an empty pending inbox, a badge that names no project and can
  never clear. `unreadInThisView` counts the returned rows with status `pending`. **Consumer
  risk: a JSON key disappears — anything reading `unreadCount` off this result now gets
  `undefined`.** A non-fatal warning also names the scope mismatch whenever the resolved
  credential is not project-scoped.
- **The exported TypeScript type `ResolveAddressResult` is corrected to the wire shape
  (s86 m07).** `resolved` changes from `boolean` to an object
  (`{userId?, username?, displayName?, projectId?, projectName?, projectSlug?}`), and the
  never-populated top-level `projectName` / `agentId` members are gone. The endpoint has always
  returned an object here; the declaration described a response it does not send. **Consumer
  risk: a TypeScript compile break for anyone importing the type** — a different risk class
  from the rename above, which no TS consumer sees at compile time.
- **`cmos_message(action="send")` may now return non-fatal `warnings`, and
  `cmos_message(action="directory")` rows gain `createdAt`, `ownerDisplayName`, `ambiguousWith`
  and a correctly-populated `isOwner` (s86 m07).** A send whose target shares a slug prefix with
  another project under the same owner — the `cmos://derek/cmos-mcp` vs
  `cmos://derek/cmos-mcp-pro` case — now says so in the rendered answer and carries
  `targetProjectId` / `targetProjectName` for the project it actually reached. **The send is
  never blocked by this check.** Directory rows carry the ambiguity annotation and, for the
  first time, a real ownership signal: the public directory route never returns `isOwner`, so
  every row (including your own) was previously framed as foreign. `createdAt` is the
  REGISTRATION date and is labelled as such — it is not an activity or freshness signal.
  **Consumer risk: additive only.**
- **`cmos_auth(action="reissue").revokedKeyIds` reports the keyIds the dashboard actually
  revoked** instead of always `[]`, and names them in the rendered answer rather than only in
  `structuredContent`. A success answer previously asserted "nothing was revoked" while the
  dashboard had revoked N keys. A companion **`revokedKeyIdsReported`** boolean distinguishes
  "the dashboard reported an empty list" from "the dashboard reported no list at all" — the
  response body is not validated, so an absent field must not be rendered as an empty one.
- **Attribution failures are two distinct errors, not one wrong cause.** The single
  `DEVICE_CODE_REQUIRED` message asserted that the device-code flow "must be run", which is
  false whenever the credential store already holds a user-scoped key — the credentials existed
  and worked, they simply were not the ones selected. `DEVICE_CODE_REQUIRED` is now returned
  only for a store with zero user-scoped keys (and names the store's path); a resolved
  credential that cannot be attributed (caller-supplied override, legacy
  `CMOS_DASHBOARD_API_KEY`, or the user+password fallback) returns the new
  **`CREDENTIAL_NOT_ATTRIBUTABLE`** naming which arm supplied it.
- **`cmos_auth(action="rotate")` no longer passes a dashboard 401 through blind.** The generic
  suggestion pointed every install at `CMOS_DASHBOARD_USER`/`CMOS_DASHBOARD_PASSWORD`; rotate
  now names the local row's keyId, states that it authenticates with the project-scoped
  credential resolved for that root, and points at `reissue`. The error **code is unchanged**
  (`DASHBOARD_AUTH_FAILED`) and rotate's credential selection is deliberately untouched.
- **The `DASHBOARD_AUTH_FAILED` suggestion no longer names only the password fallback.**
  Device code has been the default bootstrap since 2.x; the suggestion now covers the arms that
  exist without asserting which one authenticated.
- **Startup project-key recovery: `skipped-no-parent-key-id` is replaced by
  `skipped-no-user-scoped-key` and `skipped-unattributable-credential`, both logged at
  `[WARN]`** (previously one status at `[INFO]`). Its message also no longer claims that
  `/reissue` on the next startup will recover the key — startup recovery skips outright whenever
  a local row exists. Consumers matching the old status string must update.

### Added

- **`cmos_mission(action="move", missionId, toSprintId)` — a supported sprint re-bind
  (s86 m08).** `missions.sprint_id` carried two facts in one column ("which sprint created
  this" and "which sprint owns its execution"), and until now the only way to correct it was
  raw SQL against durable state. The move refuses a terminal mission and refuses a closed
  destination sprint, and it distinguishes a destination that does not exist from one that is
  closed — the two need different corrective actions. A new **action on an existing tool**: the
  15-tool contract is unchanged.
- **`sprint_summary.parked_missions`** — the view now carries the Deferred/Dropped count
  alongside the corrected `total_missions`. Applied by a lazy migration on first read.
- **Three parameters that the handlers supported but the tool schema never published, and the
  router never forwarded (s86 m03): `cmos_context.statusFilter`, `cmos_session.expiresAt` and
  `cmos_session.agentFeedback`.** Stated precisely, because it is easy to describe wrongly: at
  2.5.0 none of these three appeared on the tool it belongs to. `agentFeedback` was published
  only on `cmos_agent_onboard` and `cmos_mission_transition`; `statusFilter` only on
  `cmos_project`; `expiresAt` appeared in no shipped artifact at all. The behaviour existed in
  the handlers and there was no way for a caller to reach it. 2.6.0 publishes all three on the
  right tools and wires the router through to them. **Consumer risk: additive.** These are new
  parameters, not repairs to a contract you could already have depended on — the input schemas
  are strict, so a 2.5.0 client passing them got a validation error rather than a silent no-op.
- **`cmos_learnings(action="reaffirm").evergreen` is live**, and the answer carries
  `previousEvergreen` / `newEvergreen` so a caller can see whether the flag actually moved.
- **Per-action parameter tables in `TOOL_REFERENCE.md`.** The generated reference now shows
  which parameters belong to which action, rather than one flat table per tool.

### Fixed

- **`cmos_auth(action="reissue")` now works in the state it exists for (s86 m06).** Reissue is
  the documented lost-key recovery path, and it succeeded only when the local project-key row
  was **absent** — the one state it is not needed in. Client resolution returns a
  project-scoped credential whenever a local row merely EXISTS (the local store has no
  revocation or expiry concept), so a present-but-revoked row short-circuited resolution,
  the mint could not be attributed to a parent credential, and the call failed. Reissue now
  resolves through a new user-scoped entry point (`DashboardClient.fromEnvForUser`, arms
  3 → 4 → 5). **Arm order and `keySource` values are unchanged for every other caller** — both
  entry points share one copy of the chain.
- **A reissue that cannot attribute the mint no longer destroys the local project-key row.**
  The row was removed _before_ the handler discovered the credential problem, so an operator
  asking for a repair was left with no project key at all — strictly worse off than before the
  call. Classification now precedes every write. **Scope, stated precisely:** this covers the
  credential-attribution failures, which are the ones an operator reaches when already broken.
  A reissue that gets past attribution and then fails dashboard-side (the mint 500s or 401s)
  still clears the row first — unchanged from previous releases, and load-bearing, because the
  underlying recovery call is a no-op while a row is present. Restoring the row on a
  dashboard-side failure is tracked as follow-up hardening.
- **The reissue error suggestion is rendered.** `cmos_auth`'s formatter dropped
  `error.suggestion` entirely, and only the formatted text becomes `content[0].text` — so every
  auth suggestion string was invisible in the channel agents read.
- **`cmos_sprint(action="analytics", limit=N)` returned the OLDEST N sprints and called them
  "recent" (s86 m05).** The bound was applied to an ascending ordering, so an operator asking
  for the last 5 sprints got sprints 9–13 of an 86-sprint history, with trend directions
  computed over them. The `LIMIT` now binds a descending ordering inside a subquery with
  oldest-first restored outside it — the trend comparison depends on ascending input, so a bare
  `ORDER BY` flip would have inverted every reported direction instead. The answer also echoes
  the window it actually analysed.
- **`cmos_message(action="send")` could deliver to the wrong project when two projects under
  the same owner share a slug prefix (s86 m07)** — the `cmos://derek/cmos-mcp` vs
  `cmos://derek/cmos-mcp-pro` case. Resolution is exact-match first, and an ambiguous address is
  named in the answer with the project actually reached.
- **Shipped documentation that contradicted the security document in the same tarball
  (s86 m05).** `README.md` asserted three data-loss guarantees — a `deleted_at`-style soft
  delete, automatic pre-destructive snapshots, and blanket dry-run support — that `SECURITY.md`
  in the same published package explicitly refuted, and that contradiction shipped in 2.3.0,
  2.4.0 and 2.5.0. **`SECURITY.md` was the correct document**; `README.md` and
  `docs/getting-started.md` were moved toward it, never the reverse, and each claim was verified
  at source (no table has a `deleted_at` column; `CMOS_AUTO_SNAPSHOT` is read by nothing in the
  tree). A gate now resolves every code-shaped identifier in the shipped prose against `src/`,
  the seed schema, and `package.json` scripts and `files[]`.
- **`cmos-seed/README.md`'s Quick Start named a command the server rejects** — the seed's own
  recommended first call.

### Removed

Both entries are surface that was unreachable or ignored. Neither is a working capability, which
is why 2.6.0 is a MINOR.

- **`cmos_context(action="update").arrayUpdates.decisions_made` and `.learnings` (s86 m04).**
  Dead since Sprint 51's context-blob reduction: the handler's `hasArrayUpdates` check tested
  only the two surviving keys, so a caller passing `decisions_made` **alone** received
  `INVALID_PARAMETER` — from an error whose own suggestion told them to pass `decisions_made`.
  `arrayUpdates.constraints` and `arrayUpdates.context_notes` are unaffected.
- **`CMOS_ERROR_CODES.BUILD_STALE` and the `errors.buildStale` factory (s86 m05).** Unreachable
  since the s74 review retired the enforced build-freshness gate — no caller, and no test
  enumerated the constant. Its `suggestion:` string also told operators to "pass
  `forceComplete: true` to override", a parameter the same package documents as a no-op. The
  live, unrelated `buildStaleAdvisory` in `cmos_sprint(action="complete")` is untouched:
  build-freshness remains advisory and never blocks a close.

## 2.5.0 — 2026-08-10

Sprint 85 "Honest Provenance" — the write-behavior release. The **15-tool contract holds**.
This release changes what the durable record says when nothing is open: the stamp is now
honest, at the cost of some sprint-scoped reporting no longer counting untagged work.

### Changed

- **A session started when no sprint is in an open status now records
  `sessions.sprint_id = NULL` (s85 m03).** Previously the session inherited the most recent
  **Completed** sprint — a durable stamp naming a sprint that was already closed. Decisions,
  learnings, constraints **and next-steps** captured in such a session likewise record
  `sprint_id = NULL`. Display is deliberately unchanged: onboard, review and mission status
  still _name_ the most recent sprint — "which sprint am I looking at" and "which sprint
  should this row carry" are now answered by two different resolvers, on purpose.
- **A `Planned` sprint with only Queued missions no longer receives the write-side tag
  either**, though display still names it. A `Planned` sprint carrying an In Progress or
  Current mission, or any sprint in an open status (Active / In Progress / Current), still
  tags writes normally.
- **Decisions captured with no open sprint are excluded from `cmos_decisions(action="review")`
  staleness triage** — its scoring filters `sprint_id IS NOT NULL`. A new advisory on that
  action reports the excluded count (`N active decisions have no sprint tag and are excluded
from staleness scoring`) rather than hiding the gap.
- **Sprint-scoped retro, analytics and close-summary counts drop for untagged work.**
  `cmos_sprint(action="retro")` and `cmos_sprint(action="complete")` each now name the
  untagged count explicitly instead of under-reporting silently. No `session_missions`
  fallback attribution is performed — that would reinvent the guessing the write path
  refuses to do.
- **Context retention no longer prunes untagged sessions.** A session with NULL `sprint_id`
  is retained by `removeArchivedDetail` rather than swept with its (former) sprint.
- **`cmos_sprint(action="carry_forward")` no longer emits the `null_sprint_sessions` item.**
  Its stated cause ("require dashboard event processor update") was never a dashboard bug,
  and after this release a NULL `sprint_id` is the intended record, not a defect to escalate.
- **No migration, no backfill — go-forward only.** Existing rows are untouched by design:
  the dashboard mirror's session upsert is `COALESCE(existing, incoming)` and cannot clear a
  value, so a local NULL-out of historical rows would diverge from the mirror permanently.
- `cmos_session(action="start")` on a store with nothing open returns `sprintId: null`,
  `sprintAutoTagged: false`, a new **`advisorySprintId`** field carrying the read-resolved
  hint, and a warning telling the caller the session is recorded untagged. The hint rides a
  separate field because `{sprintId, sprintAutoTagged: false}` already means "the caller
  passed `sprintId` explicitly".

### Added

- **`missionId` on `cmos_session(action="complete")` (s85 m04, #487).** The consolidated
  router now forwards the existing top-level param to the complete path, and the
  `decisions[]` / `nextSteps[]` INSERT paths stamp `mission_id`. Per-capture `missionId`
  still wins for next-steps; the call-level value applies uniformly to decisions.
- **`missionId` filters on `cmos_decisions(action="list")`, `cmos_learnings(action="list")`
  and `cmos_context(action="next_steps")` (s85 m04).** The mission → row trail is now
  queryable end-to-end; rows with NULL `mission_id` are excluded by the filter, not errored.
- **A non-blocking warning on decision/learning captures that omit `missionId`** while at
  least one mission is In Progress/Current, naming the candidate mission ids and the exact
  param. Next-step captures never warn (96.4% of next-steps are born at session-complete
  with no mission in progress — it would be pure noise). Nothing is ever silently inferred.
- **Two indexes**: `idx_learnings_mission` and `idx_next_steps_mission`, in the seed schema
  and as marker-gated migrations, so the new filters don't table-scan.

### Fixed

- **`mission_id` was omitted from two `cmos_session(action="complete")` INSERT paths**
  (the `nextSteps[]` and `decisions[]` column lists), so rows born there could never carry
  provenance even when the caller knew the mission.
- **The dedup-ordering shadow bug**: identical text passed in both `nextSteps[]` and a
  next-step capture carrying `missionId` let the unstamped insert win and skip the stamped
  twin. The mission-bearing capture loop now runs first.

## 2.4.0 — 2026-08-10

Sprint 84 "Messaging-Cutover Adoption + Trust-Hardening" plus sprint 85's published-surface
hygiene. The **15-tool contract holds**. One consumer-visible break — see **Changed**.

### Changed

- **A dashboard 403 now surfaces as `DASHBOARD_FORBIDDEN`, not `DASHBOARD_AUTH_FAILED` (s84 m02).**
  **This is the one break in this release.** 401 and 403 previously shared an arm in the
  `DashboardClient` request path, so an authorization failure was reported as an authentication
  failure. Any consumer branching on the error-code string must update. Beyond the naming, the
  split fixes a latent bug the sprint-47 dashboard cutover triggers: an `apiKey` client that read
  a 403 as "auth failed" cleared its cached token and sent `Bearer null` on the next call.
- **Foreign mission / sprint / session text is framed at read time (s84 m03).** After a
  `cmos_db(action="pull")`, local tables can hold rows authored in another project. Mission
  name/objective/context, sprint title/focus and session title now render inside the untrusted
  provenance fence when the row's `project_id` differs from the resolved local project, across
  ~10 read surfaces (`cmos_agent_onboard` pending/blocked, `cmos_mission` list/show/status, the
  `cmos_review` portfolio and sprint fields). Local rows still render bare. Column-presence is
  PRAGMA-guarded, so ancient stores degrade to `NULL` rather than throwing. This closes the
  known limitation documented in 2.3.0 and the SECURITY.md mission-start gap.
- **Build-freshness advisories are gated to `projectType === 'build'` (s84 m05).** A `general` or
  `managed` project no longer receives build-tier staleness advice it has no use for.

### Added

- **`offset` + `returnedCount` on `cmos_message(action="list")` (s84 m02).** SQL-side pagination
  against the dashboard's own paging, so large inboxes page without re-fetching. Omitting
  `offset` reproduces the previous request byte-for-byte.
- **`cmos_message(action="get")` (s84 m02).** Read one message by id with its full body, notes and
  evidence — the byte-capped `list` summaries stay small and the body is fetched on demand.
  Shipped as an **action**, not a 16th tool.
- **`evergreen` on the constraint reaffirm path (s84 m05).** `cmos_context(action="constraints",
constraintAction="reaffirm", evergreen=true)` sets a durable flag that permanently excludes an
  institutional rule from staleness review and the stale-constraint banner. Unlike a plain
  reaffirm — which only resets the clock and ages out again — this does not decay.
- **`npm run prune:snapshots` (s84 m04).** Reclaims the write-only `context_snapshots.content`
  blob (~99% of that table) by **content-tombstone**: the row, all metadata, `content_hash`, the
  `strategic_decisions.snapshot_id` foreign key and the `snapshot_taken` event are all kept; only
  the content bytes are released. **Dry-run by default**; `--apply` is required and is
  irreversible. `cmos_context(action="history")` now surfaces `contentPruned` per row, and
  `cmos_sprint(action="complete")` emits a non-blocking growth advisory — never an auto-prune.
- **Additive identity UUIDs on message rows (s84 m01).** `senderUserId` / `senderProjectId` /
  `targetUserId` / `targetProjectId` alongside the existing fields.

### Fixed

- **`TOOL_REFERENCE.md` shipped a malformed table row (s85 m01).** The renderer interpolated a
  JSON-Schema type union (`string | object`) raw into a markdown table cell, and the bare pipe
  split that row into an extra column. The type cell now passes through the table-cell escaper.
  A new render-validity gate asserts a column-count invariant over the real definitions plus an
  adversarial synthetic — the existing freshness gate compares rendered against committed output
  and is structurally unable to catch a formatting defect.
- **181 agent-facing references named tools or actions that do not exist (s85 m01).** Strings that
  teach an agent how to call CMOS were left behind by the 38→15 tool consolidation, in error
  `suggestion` fields, `warnings[]`, tool descriptions and rendered output — including two invalid
  actions in the general-tier first-session prompt and two non-existent tools emitted on every
  stale-context session start. All corrected to their consolidated forms, now guarded by a
  mechanical AST-based gate over `src/` with no allowlist.
- **The bundled seed docs taught a tool surface that no longer exists (s85 m01).** `cmos-seed/`
  ships in the package and is copied into every project by `cmos_project(action="init")`; its five
  docs — including `build-session-prompt.md`, the recipe a fresh project's build agent follows —
  carried 118 stale references, advertised "27+ tools", and listed a `cmos_backlog_export()` that
  has never existed. Rewritten to the 15-tool action-dispatched surface and covered by the same
  gate.
- **Version-tolerant message NAME reads (s84 m01).** The sprint-47 dashboard cutover repurposes
  `targetProject` / `senderProject` to slugs and adds `*Name` twins; reads now prefer the name
  field and fall back, so they are correct in both eras. Byte-identical to 2.3.0 on pre-cutover
  rows.
- **Schema fidelity on two dual-surface params (s85 m01).** `cmos_mission`'s `context` (top-level
  and nested in `fields`) declared no type while zod already accepted a string-or-object union, so
  the reference published a bare `object` for a param where a string is legal;
  `cmos_context`'s `fieldUpdates[].value` now declares the complete JSON Schema type set, matching
  its deliberately unconstrained zod side.

### Internal

- `TierConfig.toolsUse` removed — unreachable, since the exports map allows only `.` and
  `./package.json` (s84 m05).
- `npm run snapshots:update` added; the bare `snapshots` script omits `-u` and fails rather than
  rewriting, which every re-baseline hit (s85 m01).
- `verify:dist` extended with the s84 answer shapes: the pagination param on the built schema, the
  evergreen flag's durable round-trip, and `contentPruned` on `cmos_context(action="history")`.

## 2.3.0 — 2026-07-11

Arc E "Retrieval + Tiers" — the **last phase-2 arc; phase 2 is complete.** Two sprints: **E1 (s82) Retrieval Spine** — an honest recall gate plus the mission-recall lever — and **E2 (s83) Tiers + Framing** — tier config that works for npm strangers and read-time `project_id`-aware retrieval trust. No new tools — the **15-tool contract holds**; all new behavior rides on existing paths.

### Added

- **Retrieval recall gate (s82 m02).** The un-runnable recall reporter became a `dist/`-backed pass/fail gate: 24 golden fixtures (8/type) re-authored against the post-flush corpus, per-type floors, a baseline-delta regression assert, and an embedder-loaded check (an adversarial reviewer caught the original check was structurally always-true; fixed). Honest baseline recorded: mission top-3 **0.25** (not the stale 43% the plan carried).
- **Mission-recall graph arm (s82 m04).** A **mission-only** 1-hop graph-neighbor arm (same `sprint_id` + `mission_dependencies`) fused as a depth-decayed third RRF term behind a default-**off** `expandGraph` (on only for `cmos_context` search). Lifts mission top-3 recall **0.25 → 0.50**; decisions/learnings unchanged (structural). A 12-agent adversarial review caught + fixed 5 real defects before close.
- **`projectType` on `cmos_project(init)` (s83 m05).** `init` now writes a `project_type` metadata row (default `build`, no-clobber on idempotent re-init) so the first onboard emits the matching `tierSelectionPrompt` (`managed` → Sprint Zero, `general` → first-session) instead of always `build`.

### Changed

- **Tier config now resolves for npm consumers (s83 m05).** `loadTierConfig` resolves against the **resolved store root** (dirname³ of the connected DB path), and falls back to the bundled `cmos-seed/tiers` when a store has no copied `cmos/tiers` (two-pass: exact tier across all dirs, then `build.md`) — fixing the silent no-op that left every auto-discovery npm consumer with a `null` tierConfig. The `agents.md` and `platform-vision.md` tier tables were rewritten as onboarding **vocabulary** only: tiers are **advisory framing, not tool gating** — every tool is always callable in every tier (the `tools_use`/`tools_skip` lists filter only advisory `suggestedAction` hints).
- **Stale-learnings flush (s82 m01).** 28 stale learnings triaged (evergreen / reaffirm / archive) so the onboard staleness banner stops being ~50% noise; the s73 leak-gap decisions were re-surfaced as active learnings; the constraint-reaffirm path folded under `cmos_context`.

### Security

- **Foreign decision/learning provenance framing at every local read surface (s83 m06).** After a `cmos_db pull`, the local `strategic_decisions` / `learnings` tables can hold rows authored in another project. `project_id` is now derived **read-time** (no migration; column-presence guarded so ancient stores degrade to `NULL` and render bare, never throw), and a **foreign** decision/learning row (its `project_id` ≠ the resolved local project) renders inside the untrusted provenance fence — while local rows stay bare — at every surface that renders such rows: mission-start "relevant decisions" (decision text **and** evidence), `cmos_context(action="search")`, `cmos_decisions(action="search")`, `cmos_learnings(action="search")`, `cmos_context(action="view")` (full + compact), `cmos_agent_onboard` "Recent Decisions", and the `cmos_review` digest's recent-decisions. Two adversarial review passes hardened this: the first caught four bare-text surfaces beyond the four originally planned (now framed); the second confirmed the decision/learning coverage is complete. Closes the SECURITY.md mission-start limitation for decision/learning content.
- **Known limitation (honestly documented, deferred):** foreign **mission / sprint / session** text (name / objective / context / title / focus from pull-merged rows) is **not yet framed** at its read surfaces (`cmos_agent_onboard` pending/blocked, `cmos_mission` list/show/status, the `cmos_review` portfolio + sprint title/focus). That is a distinct row-type sweep tracked as a follow-up; the hostile-injection exposure is gated on the parked multi-party collaboration arc (today's pulled rows are the operator's own single-owner projects). See [SECURITY.md](SECURITY.md).

### Internal

- **Mission-embedding trim — negative result (s82 m03).** Trimming the mission embedding input to name+objective did **not** lift mission recall (the "notes dilute" premise was refuted — the cause is corpus density); reverted to the 4-field input per the recorded decision. The recall win came from the graph arm (m04). No user-facing change.

## 2.2.0 — 2026-07-10

Arc D "One Portfolio Brain" — **Sprint 3, closing the arc.** T4 client-side sync convergence stops a same-owner second machine from minting duplicate dashboard project containers, the session-opener gains a machine-local "unsynced" drift signal, sprint closeout now reconciles the `next_steps` table automatically, and the master_context↔Layer-0 `project_identity` identity split-brain is fixed at the root (metadata is now the canonical identity source). No new tools — the **15-tool contract holds**; new behavior rides on existing paths.

### Added

- **T4 — same-owner sync convergence (client push-keying).** The client now ADOPTS the incumbent dashboard `(owner_id, slug)` key before every push, so a same-owner file-copy on a second machine converges into the incumbent project row instead of minting a duplicate container. The convergence reuses the existing pure-identity reconcile (`resolveAndPersistOwner` → `getMyProjects` → `selectMatchingProject`) with **zero entity merge** — it imports none of the pull-merge machinery. Three client defects that mis-routed data are fixed: `selectMatchingProject` no longer mis-adopts an arbitrary first project's slug/id in a multi-project account (single-project fallback only); `getProjectIdentity` repairs identity from the reconciled `dashboard_slug` before the directory-basename fallback so a registered store never pushes as `'Unknown'`; and the `expectedSlug` guard is relaxed to the reconciled incumbent slug **only when that incumbent was positively confirmed against a live dashboard row this cycle** (a stale/wrong slug still refuses with `EXPECTED_SLUG_MISMATCH` rather than mis-routing). Scope: **same-owner only** — the cross-account duplicate case is server-derived and stays a dashboard-side concern.
- **"Local ahead of dashboard (unsynced)" drift class on `cmos_review`.** The always-on portfolio digest now flags a store whose local writes have run more than 3 days ahead of its last dashboard-converged push from **this machine** — read for free off the registry with **no network round-trip**. It rides on the existing per-project drift list; `last_synced_at` is a new nullable column on the per-user project-graph registry (`NULL` = never-pushed-from-here = no signal, so it never false-positives), written on each converged checkpoint push. The four-bucket partition and the ≤4 KB digest budget are unchanged.
- **Closeout `next_steps` reconciliation.** `cmos_sprint(complete)` now reconciles the `next_steps` **table** (previously only the context-JSON arrays were pruned, so done-but-unmarked rows piled up). It AUTO-completes only the machine-certain subset — pending rows whose `mission_id` is a Completed, non-blocked mission of the closing sprint — CARRIES blocked-linked rows, and FLAGS the sprint-linked remainder on the receipt (`nextStepsReconciled` / `nextStepsCarried` / `pendingFlagged`). It never auto-closes on a "did it ship" guess, and never touches free-text or other-sprint rows.

### Changed

- **Project identity fields now converge across all three projections.** The mission-complete guard is the single convergence point for `{description, status, project_name}`: it stamps BOTH the master_context blob AND the Layer-0 `project_identity` row from `metadata` — the now-canonical source — so the two can no longer drift. Only those three fields are stamped (never `cmos_address` / `objectives` / `foundational_docs`, which stay user-owned). The Layer-0 row-write is failure-isolated: it can never fail a mission-complete.

### Fixed

- **Fork B — the master_context↔Layer-0 `project_identity` identity split-brain.** The Layer-0 row's `description` had gone empty while master_context held the correct string; the durability seed (`metadata.project_description` / `project_status`) was never written, so nothing re-anchored it. This release writes that seed (making metadata canonical), heals the empty Layer-0 row, and fixes the `ensureProjectIdentityRow` seed-precedence bug that seeded an empty description in the first place. With metadata as the sole edit surface, arming the convergence guard can no longer recreate the split-brain.
- **#391 — large-store file-sync** is confirmed **resolved by the dashboard's June upload-cap raise** (500 MB decompressed): a live push of the 61.4 MB store succeeded with zero errors, so no client change was needed. The silent file-sync→event-replay fallback now surfaces a structured `warnings[]` entry instead of a stderr-only log.

## 2.1.0 — 2026-07-09

Arc D "One Portfolio Brain" — Sprints 1 **and** 2. "What's happening across my projects" collapses to **one** answer path, the two registry split-brains collapse to one genuine source, and the session-opener payloads become honest and cheap. The sqlite `ProjectGraphRegistry` (keyed by `project_id`) is now the **sole** discovery store — the JSON `ProjectRegistry` and its `project-registry.json` derivation layer are **deleted** (not merely derived). Every local read pins to its sender; portfolio-wide reads are the explicit `acrossProjects=true` opt-in on the graph-backed `queryAcrossStores`.

> **Answer shapes changed (response payloads, not the input contract).** Every read now pins to the resolved project by default — no more silent cross-project fan-out. `cmos_message(list)` returns a byte-capped **summary**; the full body comes from `cmos_message(get, messageId=…)`. `cmos_review`'s portfolio reports a strict `reachable | silent | unmigrated | unreadable` partition plus a per-project drift list. The **15-tool contract holds** — new capability rides as params (`acrossProjects`) and actions (`cmos_message get`), never new tools.

### Added

- **`acrossProjects=true` on `cmos_mission` and `cmos_learnings`** (additive, matching `cmos_decisions`). `cmos_mission(status, acrossProjects=true)` returns active missions (In Progress/Current) across your registered projects; `cmos_learnings(list, acrossProjects=true, category=X)` returns learnings tagged X across projects. Both merge through the graph-backed `queryAcrossStores`, carry per-row `projectId`, surface per-store failures on `errors[]`, and emit the same metadata envelope as `cmos_decisions(acrossProjects)`.
- **`cmos_message(get, messageId=…)`** — a new **action** (not a tool) returning one message's full body, response notes, and evidence. `cmos_message(list)` now returns byte-capped **summaries** (dropping the heavy body/notes/evidence that produced a ~410 KB / 250-message overflow), with the sender labeled from the populated `senderProject` / `senderDisplayName` rather than a misleading "unknown source". The sent tab carries a user-scoped advisory.
- **Always-on cross-store `portfolio` section on `cmos_review`.** The session-opener digest carries a ≤4 KB portfolio rollup — active missions across your registered projects — built on `queryAcrossStores`. Stores are classified into a strict **partition** (`reachable` = read & fresh, `silent` = read but no CMOS write in >21 d, `unmigrated` = missions table predates the per-row rebuild, `unreadable` = other) that sums to the queried count, plus a top-N **drift** list naming the projects that need attention (with a backfill hint for un-migrated stores). Degrades to `portfolio=null` for a single-project setup. Supersedes the decision-#672 project-only exclusion.
- **Self-capture advisory on `cmos_agent_onboard` + `cmos_review`.** When your local commits run more than 7 days ahead of the last CMOS write (decision / learning / mission — sessions excluded), the opener nudges you to capture the work. Fail-open and project-local; never fires without both signals.

### Changed

- **The project-graph registry is the GENUINE single discovery source.** Every registration/mutation (`cmos_project` init/register/unregister, cwd auto-register) and every internal discovery read resolves through `~/.config/cmos-mcp/project-graph.sqlite`. There is no `project-registry.json` mirror any more; a leftover file from a pre-2.1.0 install is inert and **safe to delete**.
- **`cmos_mission(status)` / `cmos_session(list)` (and every other unpinned read) pin to the sender.** They no longer fan out across every registered project — a neutral multi-project dir now fails closed rather than returning colliding cross-project rows. "Across the portfolio" is the explicit `acrossProjects=true` opt-in.

### Removed

- **BREAKING (internal API) — the JSON `ProjectRegistry` + `project-registry.json` compat layer removed.** The JSON `ProjectRegistry` class, its `deriveJson()` / `replaceWithDerived()` derivation writers, and the five graph→JSON write sites are deleted; a ~10-line marker-gated `readLegacyJsonRegistry()` preserves the one-time v1.x→2.1.0 default-pointer migration (reads the legacy file once if present, writes nothing). Also removed: `withMultiClient` / `MultiClientEntry` (the last fan-out vestiges) and the dead `FTS5Retriever` class + sync `IRetriever` interface. None are on the package `.` export surface or the 15-tool contract — only code importing these internal helpers directly is affected. **Operator note:** `~/.config/cmos-mcp/project-registry.json` is safe to delete.

## 2.0.0 — 2026-07-09

Major release cutting the **honest surface + trustworthy base** work (sprints 76–78). One BREAKING change — the unauthenticated HTTP transport is removed — drives the major bump. The stdio server (`cmos-mcp`), which is the product, is unchanged in its tool contract: the surface holds at **15 tools** and gains only additive actions/flags. What changed is the posture: one truthful identity, a generated tool reference, machine-enforced read-only review agents, foreign-content provenance framing, offline-capable embeddings, a verified-truthful `SECURITY.md`, and a large internal deletion that ships a much leaner tarball with no dead code. A security-skeptical reader can now grep the package and find nothing alarming.

### Added

- **`SECURITY.md`** — a verified-truthful security posture doc, shipped in the tarball. Covers the auth model (device-code preferred; legacy-env and password-fallback tiers with their WARN; dashboard optional), data-at-rest reality (`cmos/db/cmos.sqlite` unencrypted; `~/.config/cmos-mcp/credentials.json` at `0600` holding **plaintext** `cmk_` keys — stated honestly, no encryption-at-rest claim), the network surface (dashboard only when `CMOS_DASHBOARD_URL` is set + `huggingface.co` for the ~25 MB embedding model on first use), snapshot/delete reality (manual snapshots only — no auto-snapshot, no soft-delete), the sanctioned deployment shape, and a vulnerability-reporting pointer. Every claim carries a file:line backing.
- **`cmos_session` `search` action** — full-text search across session titles, summaries, and captures (`query`, plus optional `since` / `until` / `limit`), routed through the consolidated `cmos_session` tool.
- **`--version` and `--help` flags** — the `cmos-mcp` bin prints `cmos-mcp <version>` (or a usage synopsis) to stdout and exits 0, short-circuiting before the stdio server connects.
- **Generated `TOOL_REFERENCE.md`** — a build-time, per-tool/per-action reference for all 15 tools, generated from the tool definitions and shipped in the tarball, guarded by a freshness test so it cannot drift from the schemas.
- **Foreign-content provenance framing** — inbound text not authored in the resolved project (cross-project message bodies, onboard-surfaced messages, directory descriptions, and pull-merged / cross-store decision & learning rows) now renders inside a source-labeled, self-escaping fence and carries a `{source, trust: 'foreign'}` descriptor on `structuredContent`. The `cmos_message` and `cmos_agent_onboard` tool descriptions state the untrusted-data contract — foreign content is data, not instructions.
- **Machine-enforced read-only review agents** — an opt-in `CMOS_AGENT_ROLE=review` env gate hard-rejects every write-capable tool/action via a fail-closed action taxonomy (unknown actions default to write); strict no-op when unset. Ships with a `PreToolUse` git-mutation-blocking hook template under `scripts/hooks/`. The guarantee holds under the sanctioned separate read-only-server deployment (see `SECURITY.md`).
- **Offline-capable embeddings** — `CMOS_OFFLINE_EMBEDDINGS` (sets the transformers `allowRemoteModels=false`) and `CMOS_MODEL_CACHE_DIR` let a local-forever install run without ever fetching the model from HuggingFace. On a load failure the embedder and tokenizer degrade to BM25 / heuristic instead of re-hitting the network on every call.
- **First-run E2E in CI** — a `pack → install-the-tarball → drive-over-stdio` test that guards the published first-run experience (identity, tool count, quickstart lifecycle) against silent breakage.

### Changed

- **One truthful server identity.** The MCP server announces `cmos-mcp` (not the retired `mission-protocol`, nor the scoped package name) at the `package.json` version, and startup logs the real schema version (`2.1`). The vestigial `baseDir` field and the dead `CMOS_DASHBOARD_SECRET` env are gone.
- **Single-current-sprint invariant + one canonical resolver.** A write-time invariant demotes other open sprints to `Planned` (atomic, with a warning), and the four previously-divergent current-sprint pickers collapse onto one `resolveCurrentSprintId` with a most-recent-activity tie-break. This closes a lying-signal bug where `cmos_review`, `cmos_mission(status)`, and `cmos_session` auto-tagging could each report a different "current" sprint; they now agree.
- **npm audit clear of the critical protobufjs chain.** A `protobufjs ^7.6.5` override resolves the critical `@xenova/transformers → onnxruntime-web → onnx-proto → protobufjs` advisory (embedding output verified byte-identical before/after). Zero critical/high remain; 4 moderate **dev-only** advisories are an accepted residual documented in `SECURITY.md`.
- **Quieter local boot.** The empty-credential-store login WARN is suppressed when no dashboard is configured (`CMOS_DASHBOARD_URL` unset), so a local-forever install boots silent; sign-up nudges point to the working `/register` route; a startup topology diagnostic warns only in the ambiguous pinned-`CMOS_PROJECT_ROOT` + multiple-registered-project case.
- **Docs truth pass.** `agents.md`, the README opener, and `docs/getting-started.md` were reconciled to reality — 15 tools via a link to the generated `TOOL_REFERENCE.md` instead of drifted hand-maintained action tables, `cmos_review` documented as the session opener, and removed live-claim references to subsystems deleted in the Great Deletion. The project's own `master_context` identity was refreshed to the open-core description.

### Removed

- **BREAKING — the unauthenticated HTTP transport is removed (hard-delete).** The `cmos-mcp-http` bin, the `./http-server` package export, the `start:http` script, the `src/http-server.ts` source, the transport docs (`HTTP_TRANSPORT.md`, `README_HTTP.md`), and the PM2 config (`ecosystem.config.js`) are all deleted. The bin exposed an unauthenticated channel — `Access-Control-Allow-Origin: *`, no auth, full read-write to every registered store — had no known consumers, and ran nowhere. The stdio bin (`cmos-mcp`) — the product — is unchanged. Consumers importing `@aquex/cmos-mcp/http-server` or invoking the `cmos-mcp-http` bin must pin to an earlier version; if a genuine remote-client need appears, recover the source from git history and rebuild **with authentication** rather than restoring this surface as-is.
- **`gpt-tokenizer` dependency and the GPT token-counting apparatus.** Removed the `gpt-tokenizer` dependency, the boot-time tokenizer preload (and its `[INFO] Tokenizer preload status` startup line), and the scheduled `token-validation.yml` workflow. Token counting keeps an honest Claude (`@xenova`) + Gemini (heuristic) counter; requesting `gpt` now throws `Unsupported model: gpt`. `@xenova/transformers` and the token-counter / tokenizer modules are retained.
- **Dead code and stale docs (the "Great Deletion").** Removed ~69 dead source modules and their tests, the unused domain-pack data (`templates/`, `examples/`), tracked repo cruft (`artifacts/`, `tmp/`, orphaned scripts), and ~34 `docs/` guides describing deleted or superseded subsystems plus the whitepaper. **No tool or API surface changed** — this is internal-only, verified by a two-bin import-graph reachability proof. Consumer-observable effect: a much smaller install with no misleading documentation (the tarball now ships only live `dist/`, `cmos-seed/`, `TOOL_REFERENCE.md`, and `docs/getting-started.md`).

### Security

- The single most alarming grep result — the zero-auth, `CORS *`, full-store-write HTTP channel — is gone (see Removed, BREAKING).
- Review/adversarial agents can be **machine-prevented** from writing to the store or running git-mutating commands (`CMOS_AGENT_ROLE=review`), closing the prose-only gap behind two prior data-loss incidents.
- Inbound foreign content is framed as data, not instructions, across every surface where non-project-authored text reaches agent context.
- The critical protobufjs advisory chain is cleared; the remaining posture (including the plaintext-key and no-encryption-at-rest disclosures) is documented honestly in `SECURITY.md`.

## 1.1.1 — 2026-07-07

Patch release. Four fixes — three triaged from sibling-project bug reports (aquex.ai, Synthesis-Workbench, Forge) against 1.1.0, plus an auth-resolution fix — and one build-freshness **policy change**. **Additive and non-breaking** over 1.1.0: no tools added or removed, no parameter, type, or required-field changes. The only schema-visible edit is the description of the existing `cmos_sprint` `forceComplete` parameter, now documented as a no-op (see Changed). Drop-in upgrade — no consumer action required.

### Fixed

- **Build-freshness now detects real build layouts instead of only `dist/index.js`.** `readDistBuildInfo` keeps `dist/.build-manifest.json` as the deterministic primary, then falls back to the newest-mtime file from a capped walk of the first candidate build dir that has output — `dist/` → `.next/` (excluding `.next/cache`) → `build/` → `out/`. `dist-missing` now fires only when none of those has output. This clears the permanent false `BUILD_STALE` that hit Next.js projects building to `.next/` (Synthesis-Workbench), monorepo `dist/src/` and `dist/server/entry.mjs` layouts (aquex.ai), and non-`dist` roots (Forge). A concurrent adversarial review also closed a corrupt-manifest false-pass (the manifest file is now excluded from the walk) and corrected a misleading `dist/`-only message in `cmos_review`.
- **`getCurrentSprint()` no longer surfaces a terminal sprint as "current".** The picker previously excluded only `Archived`, so `Failed`, `Dropped`, and `Reverted` sprints leaked into `currentSprint` during the review→plan gap, and a lowercase `completed` dodged the case-sensitive comparison. The terminal set is now `{Archived, Failed, Dropped, Reverted}`, case-folded, applied across every step of the selection cascade — including the Completed-aware fallbacks — so it cannot be re-defeated. Consumers no longer need to mint placeholder Active sprints to re-point the opener.
- **Write-path handler exceptions return a structured error instead of a bare `-32603`.** A tool handler that throws a non-protocol exception (e.g. a store-specific write crash on `cmos_sprint(action="complete")` or `cmos_session(action="capture")`) now returns a `CmosToolResult` error — `TOOL_EXECUTION_ERROR` with the real message, a suggestion, and a `correlationId` — as an `isError` result, instead of the generic JSON-RPC `-32603` that swallowed the cause. Genuine protocol errors (`McpError`) keep their JSON-RPC shape.
- **`cmos_db` sync ops resolve the dashboard client via the credential store, not env-only auth.** `backfill` / `reconcile` / `identify_orphans` / `purge` were the last sync surface still on `DashboardClient.fromEnv()` (env `CMOS_DASHBOARD_API_KEY` or user+password → `/api/auth/login`), so they returned `401` after a dashboard password rotation and `.env` scrub while every credential-store path kept working. They now route through `fromEnvForProject()` — credential-store key first, legacy env preserved as a script/CI fallback — so the MCP-tool path needs zero `.env` secrets. Behavior-preserving for standalone callers.

### Changed

- **Build-freshness is now advisory, never blocking (policy change).** `cmos_sprint(action="complete")` no longer blocks closeout on `BUILD_STALE`; staleness is surfaced as a warning and the sprint closes normally. `forceComplete` is retained for backward compatibility but is now a **no-op** (its parameter description says so). The running-server-stale signal on `cmos_agent_onboard` / `cmos_review` is scoped to this project and startup-manifest-gated, so it no longer reports "server is running stale code / restart required" over unrelated projects' rebuilds. This reverses the previously-blocking gate, which over-fired on foreign build layouts; the generalized probe plus advisory warnings preserve the signal without the false-positive tax.

## 1.1.0 — 2026-06-08

First public release cut from the pro tree (sprints 64–72). A drop-in minor upgrade over 1.0.1 — additive only, no breaking changes. Adds five tool/action surfaces, refreshes the bundled seed schema's cross-store indexes, and relicenses to Apache-2.0.

### Added

- **`cmos_review`** — a bundled session-opener that returns a ≤4 KB project digest (identity, current sprint, project-scoped work queue, recent decisions, freshness, and the top-3 next actions promoted to a flat field) in a single call, replacing the older `cmos_agent_onboard` + `cmos_context(view)` + `cmos_mission(status)` opener.
- **`cmos_db` `pull` / `clone` actions** — plus `slug`, `limit`, and `maxPages` parameters for paginated pulls of dashboard-mirrored project state.
- **`cmos_message` `ack` action + `acknowledged` status** — explicit acknowledgement on the cross-project messaging rail.
- **`cmos_sprint` `forceComplete`** — an operator override to close a sprint past the build-freshness gate; it records an override warning rather than closing silently.
- **`cmos_decisions` `acrossProjects`** — fan `list` out across all registered projects for a recency-ordered cross-store portfolio view, each decision tagged with its source project.

### Changed

- **Seed schema cross-store indexes.** The bundled `cmos-seed/` starter schema gains the cross-store aggregation indexes and the `author_session_id` index rename. `schema_version` stays `2.1` — the internal index rename migrates via the schema-migration path, not as a consumer-facing contract change.

### Notes

- Verified **additive-only** vs 1.0.1 (15 tools vs 14; zero removals, renames, required-parameter tightening, or type/default changes; `bin` + `exports` byte-identical), so this is a **drop-in** upgrade — no consumer action required.
- **Relicensed ISC → Apache-2.0** (permissive + attribution via `NOTICE` + patent grant). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## 1.0.1 — 2026-05-15

Patch release. Triages an OODS-Foundry-MCP intel report (2026-05-15) covering three CMOS-MCP server behaviors: one real bug fix, one verify-back to an existing fix, and one architectural item deferred to a future release.

### Fixed

- **`cmos_agent_onboard` cascade now trusts real activity over `sprints.end_date`.** When no Active/In Progress sprint exists (the steady-state for fork-and-forget projects), the cascade previously fell back to a status-and-`end_date` ordering. But `end_date` is admin-editable and frequently drifts later than the sprint's actual activity — closeout scripts and post-hoc backfills can write a date-only string (`'2026-05-14'`) that sorts after a younger sprint's ISO timestamp (`'2026-05-08T...'`). The result: `currentSprint` could surface a much older Completed sprint instead of the genuinely most-recent one. New Step 5 in `getCurrentSprint` queries `MAX(missions.completed_at, sessions.completed_at)` per non-Archived sprint and picks the highest, falling back to the legacy status-and-`end_date` ordering only when no activity rows exist. See `src/tools/cmos/cmos-agent-onboard.ts` — `getCurrentSprint` + `getMostRecentlyActiveSprintIdIncludingCompleted`.

### Verified (no code change)

- **`cmos_session(action="complete", decisions=[…])` fan-out into `strategic_decisions`** — already shipped by Sprint 55 m02 on 2026-04-17 at `cmos-session-complete.ts:476-522`. Dedup key `(decision_text, session_id)`; `sprint_id` inherited from the session row; `decisions_fts_insert` trigger maintains FTS5 automatically. The intel report cited an example from 2026-04-16 — one day before the fix shipped. Sessions completed on or after 2026-04-17 land their `decisions[]` correctly. Historical pre-fix decisions remain in `sessions.captures` JSON and are not auto-backfilled; operator-side SQL is the right path if you want them surfaced.

### Deferred

- **PG-mirror drift between SQLite and the dashboard's Postgres replica** has been deferred to a future release. This is an architectural item, not a quick fix.

### Other

- Foundational docs and research papers (`cmos/foundational-docs/`, `cmos/research/`) swept for residual `cmos-mcp.com` references — 8 swapped to `cmos.aquex.ai`. Completes the URL cutover started in 1.0.0 (`s62-m04`), which was scoped to `.env` and runtime code.

## 1.0.0 — 2026-05-08

First public release. Published to npm as [`@aquex/cmos-mcp`](https://www.npmjs.com/package/@aquex/cmos-mcp). Local-first by default; the hosted dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is optional.

cmos-mcp has been in continuous internal development since November 2025. v1.0 marks the point where the protocol surface, auth model, attribution boundary, and context layer are stable enough to draw a line and version against.

### Highlights

- 14 consolidated MCP tools with action parameters, structured error envelopes, and a uniform cold-start payload.
- Device-code auth (RFC 8628) with a per-machine credential store. No shared secrets, no env-var token paste.
- Sender attribution rebuilt around an explicit boundary module — the previous implementation could mis-attribute messages between sibling projects.
- Context v2: project identity at Layer 0, FTS5 retrieval, and a versioned blob migration system. Master context typically sits under 20KB instead of 80KB+.
- Staleness signal hygiene: auto-reaffirm-on-cite, evergreen flag, and a saner threshold default.
- Hosted dashboard is opt-in. Set `CMOS_DASHBOARD_URL` to connect; leave it unset to stay fully local.

### Auth (originally shipped Sprints 57–59)

- **`cmos_auth` tool** with `login_init`, `login_complete`, `logout`, `rotate`, `revoke`, `list`, `reissue`. Agents can run the full credential lifecycle without leaving the conversation.
- **Two-call device-code login** (`login_init` + `login_complete`) for IDE MCP hosts where stderr prompts are invisible. The legacy single-call `login` action is kept for terminal callers.
- **Per-machine credential store** at `~/.config/cmos-mcp/credentials.json`. Atomic writes, mode 0600, two trees (`userScopedKeys` and `projectKeys`) with `parentKeyId` linkage. Honors `CMOS_CONFIG_DIR`.
- **Auto-issue capture on register** — `POST /api/projects/register` returns `{key, keyId, label}` on first registration; cmos-mcp persists it transparently. Lost project keys recover on next startup via `runStartupProjectKeyRecovery()`.
- **Symmetric logout** — revokes the current user-scoped key on the dashboard and clears the local row in one atomic operation. Project-scoped child keys are deliberately not cascade-revoked.
- **Scope-aware unified revoke** — `POST /api/keys/:keyId/revoke` covers both user-scoped and project-scoped rows; the MCP determines scope locally before calling so cleanup routes correctly.
- **`whoami` + `authState` on onboard** — every cold-start payload reports `identitySource`, `authTier`, project/user keys, and last delivery observed. Surfaces `cmos_auth` suggestedActions when credentials drift.
- **Legacy-auth WARN** on stderr when falling back to `CMOS_DASHBOARD_API_KEY` or password auth, with a one-line migration pointer.

### Attribution (originally shipped Sprints 53–54)

- **Sender-context boundary module** at `src/tools/cmos/sender-identity.ts`. Single source of truth for sender attribution: matches `metadata.dashboard_project_id` first, then the local `cmos_address` against `/api/projects/me`, then fail-closed (`undefined`) — never picks a sibling.
- **Dispatcher refactor.** `CMOS_PROJECT_ROOT` no longer leaks into the tool-dispatch chain. Sender resolution is independent of working directory.
- **Self-send probe.** Sending `cmos://derek/<own>` to itself is rejected with HTTP 400. The MCP uses this as a runtime sanity check.
- **Sibling hardening.** Verified across 12 active projects post-rebuild — no cross-project mis-attribution observed.

### Context v2 (originally shipped Sprints 49–51)

- **Project identity (Layer 0)** as a first-class context type. `cmos_context(action="view", contextType="project_identity")` reads/writes the canonical identity payload — `project_id`, `cmos_address`, `platform`, `tier`, `objectives`, etc. Consumed by every onboard.
- **FTS5 retrieval** for decisions, learnings, missions, and sessions. `cmos_context(action="search")` runs relevance-scored queries with optional recency boost; the same retriever powers `cmos_decisions(action="search")` and the supersession detector.
- **Onboard v2.** `cmos_agent_onboard` returns a curated <4KB payload optimized for cold-start, with explicit warnings for staleness, sync drift, orphans, and credential issues.
- **Blob reduction.** `master_context` blobs that previously ran 86KB+ now typically sit under 20KB. Versioned blob migration system (`schema-migrations.ts` + lazy migration on read/write) lets the schema evolve without breaking existing databases.
- **Last-reviewed tracking.** Decisions and learnings carry `last_reviewed_at`; cited items get bumped automatically (see staleness hygiene below).

### Staleness hygiene (originally shipped Sprint 61)

- **Auto-reaffirm-on-cite.** Decisions and learnings cited via `citesLearningIds[]` (explicit) or detected via JS keyword overlap (implicit, floor 15) get their `last_reviewed_at` bumped automatically. Citing a learning in a session capture or mission completion treats it as fresh.
- **Threshold default 10 → 20 sprints.** `DEFAULT_STALENESS_THRESHOLD` is exported from the staleness module so downstream tools share the value.
- **Evergreen flag.** `cmos_learnings(action="update", evergreen=true)` marks an institutional rule excluded from the staleness signal. Lazy migration on first read/write of the learnings table.

### Tool-surface changes

This is the section to read carefully if you've been tracking pre-1.0 internal builds.

- **`cmos_learnings(action="update")` now requires `status` OR `evergreen`** (decision #634). Previously `status` was the only mutation field; the evergreen flag is now a peer. At least one of the two must be set per update call. Impact: any caller passing only `learningId` with no other fields will now error — pass at least `status` or `evergreen=...`.
- **14 consolidated tools.** `cmos_status` is the newest, added in v1.0 for cross-side parity with `cmos_agent_onboard.authState`. It returns five fields: `cmos_address`, `dashboard_url`, `auth_tier`, `last_sync_at`, `last_delivery_observed_at`.
- **`cmos_auth(action="logout")` is symmetric with `login`.** Logout revokes the user-scoped key on the dashboard and clears the local row atomically. Project-scoped child keys are not cascade-revoked.
- **Dashboard-not-configured is now actionable.** Tools that relay to the dashboard (sync, messaging, registry) return a structured `DASHBOARD_NOT_CONFIGURED` error with a sign-up pointer when `CMOS_DASHBOARD_URL` is unset, instead of a generic network error.
- **HTTP 402 = `DASHBOARD_UPGRADE_REQUIRED`.** Paid-tier denial (e.g., cross-user messaging from a free account) returns a typed error code with the dashboard's detail message and a sign-up URL.
- **Content-field sanitizer.** Free-text fields on write paths (`cmos_session(capture|complete)`, `cmos_mission(add|update)`, `cmos_mission_transition(complete|block|defer)`, `cmos_context(update)`) strip XML-marshalling fingerprints (`<content …>`, `<parameter …>`, `<invoke …>`, `<function_calls …>` outside code fences). The write succeeds but `sanitizedFields[]` surfaces what was trimmed — re-emit cleanly to store the full content.
- **`agentFeedback` field.** `cmos_agent_onboard`, `cmos_session(complete)`, and `cmos_mission_transition(complete)` accept an optional `agentFeedback` (≤2000 chars) to log UX rough edges. Reviewable via `cmos_feedback(action="list")`.
- **Test isolation.** Jest provisions a per-run `CMOS_CONFIG_DIR` tmpdir so the test suite never touches `~/.config/cmos-mcp/`. Set `CMOS_CONFIG_DIR` outside tests to override the default config directory.

### Packaging

- **Package name: `@aquex/cmos-mcp`** (scoped). v1.0.0 is the first public version.
- **`bin` field exposes `cmos-mcp` and `cmos-mcp-http`.**
- **`files` allowlist** ships only `dist/`, `cmos-seed/`, `LICENSE`, `README.md`. Working DB, planning docs, internal docs, and test fixtures are excluded — verified by `npm pack --dry-run`.
- **Default `CMOS_DASHBOARD_URL=https://cmos.aquex.ai`** baked at the dashboard-client level. Empty-string env values are treated as unset (avoids the IDE-spawn empty-env trap).
- **Bundled-env safety guard.** `runStartupBundledEnvCheck` warns on stderr if the server starts from `node_modules/` and finds a stray `.env` adjacent — protects against accidental secret publish.
- **`engines.node >= 18`.** No preinstall/postinstall scripts.

### URL cutover

- **`https://cmos.aquex.ai`** is the canonical dashboard URL going forward (per decision #620).
- **`https://cmos-mcp.com`** is soft-deprecated. The dashboard team's allowlist keeps it accepting in-flight clients during the transition; new installs default to the aquex.ai URL.
- The cutover is env-only — no code-level URL hardcoding survives in `src/`.

### Known issues at v1.0

- **Sync is checkpoint-driven, not continuous.** Sprint 41 replaced the continuous sync pipeline with explicit `cmos_db(action="backfill")` operations. This is the intended model — there's no plan to restore continuous sync.
- **One-way mirror.** SQLite is source of truth; Postgres is a read replica. Restoring state from a different machine requires a fresh login plus a backfill flow.
- **Cross-user messaging is paid-tier.** Same-user multi-device messaging and receive-from-paid are free. Paid-tier denial returns HTTP 402 with the structured `DASHBOARD_UPGRADE_REQUIRED` error.
- **28 evergreen-candidate learnings** flagged in the staleness audit are pending an institutional-rule sweep — operator-driven, not blocking.
- **Historical corrupted rows.** Sprint 60 surfaced 26 historical rows with XML-marshalling artifacts; the sanitizer prevents new corruption but the existing rows are report-only (run `npm run detect:corrupted` to audit).

### Migration notes

- **Coming from `cmos-mcp` (unscoped)?** The package was never publicly published under that name — internal builds installed from a tarball or git URL. Switch your MCP client config to `@aquex/cmos-mcp`:

  ```json
  { "command": "npx", "args": ["-y", "@aquex/cmos-mcp"] }
  ```

- **Existing CMOS databases are forward-compatible.** Lazy schema migrations run on first read/write. No manual migration step.
- **Custom `cmos_learnings(action="update")` callers** should pass at least one of `status` or `evergreen` per call (see Tool-surface changes above).

[1.0.0]: https://www.npmjs.com/package/@aquex/cmos-mcp/v/1.0.0
[4.7.0]: https://github.com/kneelinghorse/reasonbook/compare/v4.6.1...v4.7.0
[4.6.1]: https://github.com/kneelinghorse/reasonbook/compare/v4.6.0...v4.6.1
[4.6.0]: https://github.com/kneelinghorse/reasonbook/compare/v4.5.1...v4.6.0
[4.5.1]: https://github.com/kneelinghorse/reasonbook/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/kneelinghorse/reasonbook/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/kneelinghorse/reasonbook/tree/v4.4.0
[4.3.0]: https://github.com/kneelinghorse/reasonbook/tree/v4.3.0
[4.2.1]: https://github.com/kneelinghorse/reasonbook/tree/v4.2.1
[4.2.0]: https://github.com/kneelinghorse/reasonbook/tree/v4.2.0
[4.2.0-rc.3]: https://www.npmjs.com/package/@aquex/reasonbook/v/4.2.0-rc.3
[4.2.0-rc.2]: https://www.npmjs.com/package/@aquex/reasonbook/v/4.2.0-rc.2
[4.1.0]: https://github.com/kneelinghorse/reasonbook/tree/v4.1.0

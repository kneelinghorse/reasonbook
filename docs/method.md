# The method

One project, one record. Its owner can share it; every collaborator keeps a full copy, and changes
sync between them.

The method is how that record is kept: five lines, and three levels of structure a project can grow
into.

## Five lines

1. **One project, one record.** Each project keeps its own decisions, lessons, rules and next steps.
   When shared, its copies exchange changes through the owner's copy, or through reasonbook.ai when
   the project is shared there. Reading across different projects remains a view of separate records.
2. **Every session starts from the record.** Where hooks run (the Claude Code and Codex plugins), a
   digest of the record comes into each session on its own; elsewhere the agent starts with
   `rbook_review`.
3. **Decisions are deliberate.** Record one when someone will later ask why. Never edit a decision;
   record a new one that supersedes it.
4. **Nothing is forgotten silently.** Records expire, go stale or are superseded in the open. A
   sprint close keeps decisions and lessons active unless you ask it to archive them, and lists any
   next step it drops with the command that restores it.
5. **The record outlives the tool.** Each copy is a SQLite file in its project folder. Its agents
   read the local copy; sync brings in changes from the other copies.

Sharing is supported in the measured setup: two accounts operated by one person, on two machines,
either connected to the owner's copy over SSH or sharing through reasonbook.ai. A second person's
collaboration and privacy experience remain unvalidated. Read the [sharing steps](getting-started.md#share-a-projects-record) and
[trust boundary](trust.md#shared-copies) before inviting someone.

## Corrections and work sessions

To correct a decision, record the corrected choice with `supersedes=[<old id>]`. The headline may
stay the same while its context, alternatives, consequences, deciders or mode changes. The old row
keeps its history and points to the correction. Repeating the same call returns the existing row;
returning to an older choice records a new occurrence instead of reviving the old row. A target
already superseded by a different correction cannot be redirected. Two shared copies correcting
the same target independently can still produce a `superseded_by` conflict when they sync; resolve
that conflict through the existing shared-record conflict flow.

Retry comparison uses only supplied decision fields; omission matches any stored value. Changing
only `evidence` or `missionId` still counts as a repeat. Changing reasoning without naming a
`supersedes` target preserves the existing row and warns that the changed fields were not written.

A queued mission can be blocked before work starts. Unblock returns it to Queued only when the
saved origin belongs to the current block and `started_at` is still empty; otherwise it resumes
In Progress. An explicit unblock target wins. If a peer replaces the block metadata, the default
falls back to In Progress.

Use `rbook_mission_transition(action="reopen", missionId, reason)` to reopen completed work in an
Active, In Progress or Current sprint. Reopen clears the completion timestamp and appends a
`[Reopened]` note. For a completed sprint, create a successor mission in an open sprint and link
it to the original with `rbook_mission(action="depends")`. The appended note is the shared audit:
`domain_fields.reopened[]` can be replaced by a concurrent peer write, and `session_events` stays
local. The open-sprint check is local and atomic. A disconnected peer can close the sprint at the
same time; after exchange, `rbook_db(action="conflicts")` reports the completed sprint's open work
for a person to reconcile.

Starting or completing a mission links the caller's session when it has an owner key. The
retrospective includes those links even when an implicit session has no sprint label, and counts
each session once per sprint. A manually opened keyless session absorbs callers but creates no
mission link. Codex's per-call helper creates a separate process-owned session for each call;
these can be sub-second sessions rather than one continuous conversation. The separate analytics
session count still uses explicitly sprint-tagged sessions.

## Three levels

| Level       | What the project keeps                            | What Reasonbook does on its own, where hooks run                                                                                                                                                    |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ledger**  | Decisions and lessons, with rules and constraints | A digest at session start; the past decisions related to each prompt; records the agent proposes wait as drafts for your approval, at most three at a time; sessions open and close by themselves   |
| **Planner** | Adds next steps, as tasks in cycles               | Also: the digest lists up to five open next steps and flags the ones going stale                                                                                                                    |
| **Builder** | Adds sprints and missions                         | Also: the digest names the current mission, starting a mission returns related past decisions, and a sprint close keeps the record active by default; a retrospective is there when you ask for one |

The levels share one record and one set of tools. A level changes what the digest shows and which
starter files the project gets.

## Moving up

Start at the level the project needs today, and move up when it needs more structure:

- in the project folder, `reasonbook init --level planner` (or `builder`);
- or ask the agent, which calls `rbook_project(action="update", projectType="managed")` for Planner
  or `projectType="build"` for Builder.

Moving up stores the new level, adds that level's files under `rbook/` without overwriting yours, and
updates the record line in `AGENTS.md` if Reasonbook wrote it. Nothing is converted or removed, and
moving down removes nothing either. The digest suggests the move: a Ledger with five or more open
next steps is told to consider Planner, and a Planner with ten or more open tasks to consider
Builder.

The [starter templates](https://github.com/kneelinghorse/reasonbook/tree/main/templates) hold the `AGENTS.md` and `CLAUDE.md` each level starts with.

# The method

One project, one record. Its owner can share it; every collaborator keeps a full copy, and changes
sync between them.

The method is how that record is kept: five lines, and three levels of structure a project can grow
into.

## Five lines

1. **One project, one record.** Each project keeps its own decisions, lessons, rules and next steps.
   When shared, its copies exchange changes through the owner's copy. Reading across different
   projects remains a view of separate records.
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

Sharing is supported in the measured setup: two accounts operated by one person, on two machines
connected to the owner's copy over SSH. A second person's collaboration and privacy experience
remain unvalidated. Read the [sharing steps](getting-started.md#share-a-projects-record) and
[trust boundary](trust.md#shared-copies) before inviting someone.

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

The [starter templates](../templates/) hold the `AGENTS.md` and `CLAUDE.md` each level starts with.

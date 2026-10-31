# Getting Started with Reasonbook

**Day 0 Setup**: From fresh project to Reasonbook-enabled in minutes.

---

## What is Reasonbook?

**Reasonbook** keeps decisions, lessons and next steps in a local record that survives an agent session. At the Builder level, it provides:

- **SQLite-backed mission tracking** - History, sprints, dependencies
- **Context management** - PROJECT_IDENTITY, PROJECT_CONTEXT, MASTER_CONTEXT with snapshots
- **Mission-based workflow** - Research → Plan → Build → Ship
- **Session management** - Capture planning, onboarding, reviews
- **MCP integration** - Database-backed operations via MCP tools, no CLI required

**Critical Principle**: Reasonbook is **project management**, NOT your application code.

---

## Quick Start

### 1. Initialize the Project

```
rbook_project({
  action: "init",
  projectRoot: "/path/to/your/project",
  projectName: "My Project",
  projectType: "build",   // Builder: keeps sprints and missions, which this guide uses
  initialSprint: {
    id: "sprint-01",
    title: "Initial Sprint"
  },
  initialMissions: [
    { id: "s01-m01", name: "First mission", sprintId: "sprint-01" }
  ]
})
```

This creates:

```
yourproject/
└── rbook/
    ├── db/
    │   └── rbook.sqlite  # All Reasonbook state
    ├── context/         # Seed snapshots; database wins after initialization
    ├── foundational-docs/
    ├── templates/       # Project README and AGENTS.md templates
    ├── tiers/           # Tier behavioral guides
    └── docs/            # Documentation (always copied)
```

Commit the rest of `rbook/`, including `rbook/.gitignore`, and the root `AGENTS.md` and
`CLAUDE.md` that init writes. The ignore file keeps the local store, its WAL and SHM files and
snapshots out of git. Remove those ignore rules only if you deliberately want to track the store;
Reasonbook refuses to share a store git tracks.

### 2. Onboard a New Project

```
rbook_agent_onboard()
```

Use this long-form payload for a first-run cold start. Returning work sessions normally open with
`rbook_review()` for the bounded project digest.

### 3. Start Working

```
rbook_mission(action="status")  # See work queue
rbook_mission_transition(action="start", missionId="s01-m01")  # Begin work
```

---

## Project Structure

```
yourproject/                    # Project root
├── README.md                   # About YOUR PROJECT
├── AGENTS.md                   # Repository-wide AI rules, written by init with the project name
│
├── src/                        # YOUR APPLICATION CODE
├── tests/                      # YOUR APPLICATION TESTS
│
└── rbook/                       # PROJECT MANAGEMENT (separate!)
    ├── db/
    │   └── rbook.sqlite         # Mission tracking database
    ├── context/                # Seed snapshots only
    ├── foundational-docs/      # Registered durable planning documents
    ├── templates/              # Customizable project templates
    ├── tiers/                  # Tier behavioral guides (general/managed/build)
    └── docs/                   # Reasonbook documentation
```

**Golden Rule**:

- Write YOUR CODE in project root
- Manage YOUR WORK in rbook/
- NEVER write application code in rbook/

---

## Core MCP Tools

| Call                                                                        | Purpose                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| `rbook_review()`                                                            | Session-opener digest (start here)                 |
| `rbook_project(action="init", projectRoot="...", projectType="build")`      | Initialize a new Builder project                   |
| `rbook_agent_onboard()`                                                     | Get project context for cold-start                 |
| `rbook_db(action="health")`                                                 | Check database status                              |
| `rbook_mission(action="status")`                                            | View work queue                                    |
| `rbook_mission_transition(action="start", missionId="...")`                 | Begin mission                                      |
| `rbook_mission_transition(action="complete", missionId="...", notes="...")` | Mark mission done                                  |
| `rbook_session(action="start", type="planning", title="...")`               | Start planning session                             |
| `rbook_session(action="capture", category="decision", content="...")`       | Record decisions                                   |
| `rbook_session(action="complete", summary="...")`                           | Complete session                                   |
| `rbook_context(action="update")`                                            | Recover constraint captures into master_context    |
| `rbook_context(action="view")`                                              | Context digest; `compact=false` for both documents |

---

## Build Session Workflow

1. **Review**: `rbook_review()`
2. **Check Queue**: `rbook_mission(action="status")`
3. **Start Mission**: `rbook_mission_transition(action="start", missionId="...")`
4. **Execute Work**: Write code, create tests
5. **Complete**: `rbook_mission_transition(action="complete", missionId="...", notes="...")`
6. **Repeat**: Continue with next mission

---

## Session Workflow

For planning, research, or review (not mission execution):

1. **Start**: `rbook_session(action="start", type="planning", title="Sprint Planning")`
2. **Capture**: `rbook_session(action="capture", category="decision", content="...")`
3. **Complete**: `rbook_session(action="complete", summary="...")`

---

## Keeping Context Fresh

Ordinary session completion already persists decisions, learnings, constraints, and context. Use
the aggregate update only as a recovery/backfill path for constraint captures:

```
rbook_context(action="update", since="<ISO timestamp>")
```

It creates a snapshot only when it changes `master_context`; it is not a routine post-session step.

---

## Next Steps

1. Run `rbook_review()` to open a normal work session (`rbook_agent_onboard()` is the cold-start path)
2. Run `rbook_mission(action="status")` to see work queue
3. Start your first mission with `rbook_mission_transition(action="start", missionId="...")`
4. See the active `rbook/tiers/{tier}.md` guide for tier-specific behavior

---

**Last Updated**: 2026-10-29
**Schema Version**: 2.1

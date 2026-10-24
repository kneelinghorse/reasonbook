# Reasonbook Documentation

**Guides to Reasonbook's local record and the Builder workflow.**

---

## Quick Start

**New to Reasonbook?** Start here:

1. [Getting Started](./getting-started.md) - Quick setup guide
2. [Build Session Prompt](./build-session-prompt.md) - Template for build sessions
3. [Session Management Guide](./session-management-guide.md) - Planning, reviews, research

---

## Core Documentation

| Document                                                  | Description                          |
| --------------------------------------------------------- | ------------------------------------ |
| [Getting Started](./getting-started.md)                   | Day 0 setup from fresh install       |
| [Build Session Prompt](./build-session-prompt.md)         | Template for starting build sessions |
| [Session Management Guide](./session-management-guide.md) | Planning, onboarding, reviews        |
| [SQLite Schema Reference](./sqlite-schema-reference.md)   | Database structure and queries       |

---

## Documentation by Use Case

### "I'm setting up Reasonbook for the first time"

1. Read [Getting Started](./getting-started.md)
2. Use `rbook_project(action="init", projectRoot="...", projectType="build")` to initialize a Builder project (without `projectType`, a Ledger, unless the folder's AGENTS.md already names a level)

### "I'm starting a build session"

1. Use [Build Session Prompt](./build-session-prompt.md) as your template
2. Follow: review → status → start → execute → complete

### "I'm planning a sprint"

1. Read [Session Management Guide](./session-management-guide.md)
2. Use `rbook_session(action="start", type="planning", title="Sprint planning")`

### "I need database information"

1. See [SQLite Schema Reference](./sqlite-schema-reference.md)
2. Use `rbook_db(action="health")` for quick status

---

## Key Concepts

### Sessions

Non-build work: planning, onboarding, reviews. Managed via the `rbook_session` tool.

**Types:** planning, onboarding, review, research, check-in, custom

### Missions

Build work: implementing features, writing code. Managed via `rbook_mission` (queries) and `rbook_mission_transition` (state changes).

**Lifecycle:** Queued → Current → In Progress → Completed (or Blocked)

### Contexts

- **project_identity**: Stable identity and foundational-document registry
- **project_context**: Current session state and next steps
- **master_context**: Project history, decisions, constraints

### Database

SQLite at `rbook/db/rbook.sqlite` is source of truth. All operations via MCP tools.

---

## MCP Tools Quick Reference

Reasonbook provides **15 consolidated tools** for complete project management. The selected calls
below use an `action` parameter except `rbook_review`, `rbook_agent_onboard`, and `rbook_status`,
which take no `action` parameter.

```
# Onboarding
rbook_review()                                                 # Session-opener digest
rbook_agent_onboard()                                          # Cold-start project state
rbook_project(action="init", projectRoot="...", projectType="build")  # New Builder project

# Missions — queries on rbook_mission, state changes on rbook_mission_transition
rbook_mission(action="status")                                 # View work queue
rbook_mission(action="show", missionId="...")                  # Mission details
rbook_mission(action="add", ...)                               # Create mission
rbook_mission(action="update", missionId="...", fields={...})  # Update fields
rbook_mission(action="depends", ...)                           # Add dependency
rbook_mission_transition(action="start", missionId="...")      # Begin mission
rbook_mission_transition(action="complete", missionId="...")   # Mark done
rbook_mission_transition(action="block", missionId="...", reason="...")  # Block mission
rbook_mission_transition(action="unblock", missionId="...")    # Unblock mission

# Sessions
rbook_session(action="start", type="...", title="...")
rbook_session(action="capture", category="...", content="...")
rbook_session(action="complete", summary="...")
rbook_session(action="list")                                   # List sessions
rbook_session(action="search", query="...")                    # Search sessions

# Sprints
rbook_sprint(action="list")                                    # List sprints
rbook_sprint(action="show", sprintId="...")                    # Sprint details
rbook_sprint(action="add", ...)                                # Create sprint
rbook_sprint(action="update", ...)                             # Update sprint
rbook_sprint(action="complete", sprintId="...", summary="...")  # Close a sprint

# Context
rbook_context(action="view")                                   # View context
rbook_context(action="snapshot", ...)                          # Create snapshot
rbook_context(action="history")                                # View timeline
rbook_context(action="update")                                 # Backfill constraint captures

# Decisions and learnings
rbook_decisions(action="list")                                 # List decisions
rbook_decisions(action="search", query="...")                  # Search decisions
rbook_learnings(action="list")                                 # List learnings

# Health
rbook_db(action="health")                                      # Check database
rbook_db(action="snapshot")                                    # Snapshot the database
```

---

**Last Updated**: 2026-10-22
**Schema Version**: 2.1 (MCP-first)
**Tool Count**: 15 consolidated tools

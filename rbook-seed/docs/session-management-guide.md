# Session Management Guide

Sessions capture planning, onboarding, research, and review activities that fall outside mission-oriented build work.

---

## Session Types

| Type       | Use Case                                         |
| ---------- | ------------------------------------------------ |
| onboarding | Ramp up a new agent or hand off a feature        |
| planning   | Sprint, roadmap, or architecture planning        |
| review     | Weekly reviews, retrospectives, evaluations      |
| research   | Exploratory spikes, benchmarking, investigations |
| check-in   | Quick syncs to capture status and blockers       |
| custom     | Any structured collaboration needing a record    |

All types share the same lifecycle: **start → capture → complete**.

Starting is optional. A capture with no session open lands in an implicit session the server opens for its process. The server closes that session when the process ends, or after 12 idle hours. Start a session explicitly when you want the work titled, typed, or tagged to a sprint.

---

## Basic Workflow

### 1. Start a Session

```
rbook_session({
  action: "start",
  type: "planning",
  title: "Sprint 17 Planning",
  sprintId: "..."  // optional: an existing sprint's id
})
```

### 2. Capture Insights (repeat as needed)

```
rbook_session({
  action: "capture",
  category: "decision",
  content: "Focus on API performance"
})

rbook_session({
  action: "capture",
  category: "constraint",
  content: "Must maintain backward compatibility"
})

rbook_session({
  action: "capture",
  category: "next-step",
  content: "Profile current latency"
})
```

**Categories**: `decision`, `learning`, `constraint`, `context`, `next-step`

### 3. Complete the Session

```
rbook_session({
  action: "complete",
  summary: "Sprint 17 scoped and prioritized",
  nextSteps: ["Finalize API metrics", "Update backlog"]
})
```

---

## Worked Examples

### Sprint Planning

```
rbook_session(action="start", type="planning", title="Sprint 17 Planning")

rbook_session(action="capture", category="decision", content="Focus on API performance")
rbook_session(action="capture", category="constraint", content="Backward compatibility required")
rbook_session(action="capture", category="next-step", content="Profile API endpoints")

rbook_session(action="complete", summary="Sprint 17 planned: 6 missions for API optimization")
```

### Agent Onboarding

```
rbook_session(action="start", type="onboarding", title="Onboarding for Feature X")

rbook_session(action="capture", category="context", content="Feature X requires real-time updates")
rbook_session(action="capture", category="decision", content="Use WebSockets for real-time")

rbook_session(action="complete",
  summary="Onboarded to Feature X implementation",
  nextSteps=["Review WebSocket libraries", "Design message protocol"]
)
```

### Weekly Review

```
rbook_session(action="start", type="review", title="Week 47 Review")

rbook_session(action="capture", category="learning", content="CI/CD pipeline needs optimization")
rbook_session(action="capture", category="learning", content="Velocity improved with pair programming")

rbook_session(action="complete", summary="Week 47: Good progress, CI/CD needs work")
```

---

## Viewing Sessions

```
rbook_session(action="list")                    // List all sessions
rbook_session(action="list", status="completed")  // Filter by status
rbook_session(action="list", type="planning")     // Filter by type
```

---

## Tips

- Keep captures concise (<1000 chars)
- Use next-steps to seed future missions
- Complete sessions before starting new ones
- Use `rbook_agent_onboard()` to see active sessions

---

## Keeping Context Fresh

Session completion already persists structured decisions and learnings, routes constraint/context/
next-step captures, updates the working contexts, and snapshots them. Use aggregate update only as
a recovery/backfill path for constraint captures that were not incorporated into `master_context`:

```
rbook_context(action="update", since="<ISO timestamp>")
```

This tool:

- Scans constraint captures, optionally bounded by `since`
- Adds previously unaggregated constraints to `master_context`
- Creates a snapshot only when it changes `master_context`

Decisions and learnings are table-backed when captured; this action does not re-aggregate them.
Normal completed sessions need no follow-up update call.

**Recovery example**:

```
# Backfill constraint captures from a known point
rbook_context(action="update", since="2026-08-01T00:00:00Z")

# View the updated master context in full (the view's default is a digest)
rbook_context(action="view", contextType="master_context", compact=false)
```

---

**Last Updated**: 2026-10-29

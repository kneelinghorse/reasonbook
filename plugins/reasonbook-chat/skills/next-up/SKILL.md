---
name: next-up
description: Discuss the next useful actions from a project's Reasonbook record. Use when someone asks what to do next, wants to prioritize open work, or wants an approved next step captured or marked complete.
---

Read `rbook_review()` in the chosen project, using its exact address as `projectRoot` when needed.
Name the project from the receipt. If selection is unclear, call `rbook_project(action="list")`
and let the user choose. Read open next steps with
`rbook_context(action="next_steps", nextStepAction="list")`. Use mission status only when the
project already uses missions.

Talk through the most useful next actions, their dependencies and any recorded constraints.
Distinguish a suggestion from an existing commitment. Do not create a sprint or mission simply
because the user asks what comes next.

Write only after the user approves the specific change. Capture a new next step with
`rbook_session(action="capture", category="next-step")`; its receipt gives the next step's row id.
For an existing next-step row, use the matching `rbook_context` next-step action and its returned
id. Mark work complete only when the user says it is complete or the
requested work has actually been verified. Preserve the exact selected project on every write.

Report the recorded change and any warnings in plain words. A failed or uncertain call is not a
completed update; inspect the record before retrying.

---
name: capture-notes
description: Save selected learnings, constraints and next steps from a conversation into Reasonbook after the user confirms each item. Use for retaining useful notes without turning the entire conversation into a record.
---

Select only reusable learnings, real constraints and concrete next steps. Present the proposed
items with their categories and ask which to save. A single explicit confirmation can cover a
clearly identified group; preserve approval already given for the exact items. Do not infer a
permanent rule or an operator preference from an incidental remark.

Use the selected project's exact address as `projectRoot`, or use this chat's project. If the
project is unclear, call `rbook_project(action="list")` and clarify before writing. Check relevant
existing records when a note may already be present.

For each confirmed item call `rbook_session(action="capture")` with its text in `content` and the
matching `category`: `learning`, `constraint`, or `next-step`. Omit `sessionId` to let Reasonbook use the
caller's session. Keep separate items in separate calls and include only supported context; do
not open or close an unrelated session merely to save a note.

Check each receipt and its materialization result. A next step is written as a row when it is
captured, and its receipt gives that row's id. Report any failed write separately and avoid
retrying an uncertain write until checking whether it persisted. End with the confirmed items and
their returned identifiers.

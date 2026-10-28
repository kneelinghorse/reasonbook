---
name: propose-decision
description: Propose and, after the user's explicit approval, record one project choice through Reasonbook Chat. Use when a conversation reaches a decision whose reasons should remain available later.
---

Resolve the project using its exact address or this chat's project, and keep the same `projectRoot`
for every call. When the project is unclear, use `rbook_project(action="list")` and ask the user to
choose. Search relevant existing decisions before proposing a duplicate or a correction.

State the choice and its reason in one trailing line:

Would record: <the choice and why, in one sentence>

Wait for an explicit yes to that concrete choice. Approval already present in this conversation
counts; do not ask again. A question, silence or an amendment is not approval of changed wording.
Clarify or revise the proposal as needed, and never save a declined choice.

After approval, call `rbook_decisions(action="record")` with the agreed sentence in `content`.
This is a direct record: omit `fromDraft` and do not invent a draft id or approval mode. Put the
reasons and relevant alternatives in `context`, and state that the user approved it in this conversation.
Do not copy conversation excerpts or quotations into the record.

Read the receipt, including `decisionId`, `materialization`, warnings and `writeFailures`. Report
the saved id only when persistence succeeded. If a call's outcome is uncertain, search for the
decision before retrying so a retry does not create a duplicate. For a correction, preserve the
old decision and use the tool's supersession field after the user approves the replacement.

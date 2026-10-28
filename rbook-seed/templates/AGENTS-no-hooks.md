<!-- Reasonbook hook-less block: written by `reasonbook init --no-hooks` for a harness without hooks. Delete it if the harness gains them. -->

## Reasonbook in a harness without hooks

This harness runs no Reasonbook hooks, so these steps do their work:

1. For Reasonbook project work, call `rbook_review()` and read the digest it returns.
2. When you settle a choice someone will later ask about, record it:
   `rbook_decisions(action="record", content="...")`.
3. Save a lesson or an open thread as you go:
   `rbook_session(action="capture", category="learning", content="...")`, or `category="next-step"`.
4. Before you stop, capture anything unfinished as a next step.

<!-- /Reasonbook hook-less block -->

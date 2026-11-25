---
name: record-decision
description: Record a meaningful project choice in Reasonbook with its reasons and evidence, or propose an unresolved choice for the operator. Use when someone will later need to know why a choice was made.
---

# Reasonbook record-decision

**First, check that the Reasonbook tools are here.** If `rbook_review` and the other Reasonbook
tools are not available, do not do the work: stop and tell the user which case applies. If the
session-start message or the server's instructions say Reasonbook is installing, they should start
a new session once installation finishes. Otherwise Reasonbook needs its local server, which runs in
Claude Code or Codex but not in claude.ai chat; the install steps are at
https://github.com/kneelinghorse/reasonbook#readme.

Open with one sentence stating the decision. Apply the “someone will later ask why” test:
architecture, scope and tradeoffs belong in the record; routine edits and a narration of actions
usually do not. Read the relevant existing decisions with `rbook_decisions(action="search")` or
`rbook_decisions(action="show")` before adding a duplicate or correction.

Use a compact MADR-style record, scaled to the choice:

- **Context:** the problem and constraints that made a choice necessary.
- **Decision:** the chosen approach and why it fits.
- **Alternatives:** serious options considered and why they were rejected.
- **Consequences:** benefits, costs and accepted limitations.
- **Evidence:** actual code, tests, measurements or research references supporting the choice.

Record an explicit user decision, a requested decision capture, or an implementation choice
within already authorized work directly. Do not add another approval ritual.

**Choices that wait for the operator** are those that change product scope, commit a budget or
cost, create an outside commitment, settle an operator preference, add a constraint or standing
rule, or change the operator profile. Put one to the operator by ending your reply with one line,
up to three such lines per reply:

    Would record: <the decision and its reason, in one sentence>
    Would record (constraint): <the constraint>
    Would record (rule): <the standing rule>
    Would record (profile): <one line for the operator profile>

Use the label at the start of a trailing line, outside code blocks; `Would record (decision):`
also names a decision. Leading list or quote markers and Markdown wrappers are accepted. A label
may also start the final sentence of the reply's final line, after `.`, `?` or `!` and whitespace;
an inline label after a colon or the abbreviations `e.g.`, `i.e.`, `etc.`, `vs.` or `cf.` does not
count. A placeholder or "nothing" is not a proposal, even in a code span or emphasis. The text needs
at least three words, counted between spaces, and 15 characters. A placeholder (a `<…>` span that is
not a tool-call tag, bare or with `name="…"` attributes, a URL, or a generic whose `<` follows an
ASCII letter or digit, such as `Array<T>`) is not counted: beside placeholders the
text needs three words and 15 characters, and two more words and ten more characters for each
placeholder after the first, where a word is a run of letters or digits, or one Han, Hiragana or
Katakana character. Text over 1,000 characters is cut at a word.
Where Reasonbook hooks run, the line becomes a draft with an id (`P<n>`). The operator's current
message must identify the choice they approve unless the client verifies the immediately preceding
question. The current Claude and Codex hook inputs require a named choice even in an uninterrupted chat.
Copy the entire choice exactly after the confirmation prefix, including its spaces and punctuation.
A question mark inside a named URL is part of the choice. Continue independent authorized work while the choice is open.

For one freshly shown profile, rule or constraint with a numeric setting after a single colon,
show its proposal on its own or ask its exact confirmation question. Shorthand works for these
labels, optionally numbered: Plan critics, Review budget, Review rounds, Critic rounds, Review
passes, Test budget, Meeting budget, Stop checks, Retry limit, Retry delay, Timeout and Retention
period. The operator can approve by repeating the value and its complete recognized unit. For example,
`Yes. 3 days.` approves a single setting that ends in `3 days.`. The affirmative and setting
must fit on one line within 60 UTF-16 units, including spaces. A different value, an added condition,
a question or more than one matching draft leaves the setting pending. Recognized units are rounds
(including critic or review rounds), passes (including review passes), attempts, retries, seconds,
minutes, hours, days, weeks, months and years, in singular or plural. For other labels or units, and for qualified
settings, ask the operator to name the full choice.

**Published reply grammar** ([source](https://github.com/kneelinghorse/reasonbook/blob/main/src/tools/rbook/draft-reply.ts)): a plain reply
is at most 60 normalized characters and consists entirely of phrases below, joined by whitespace,
commas, periods, semicolons, exclamation marks, ellipses or dashes, with optional courtesies.
Matching ignores case, normalizes curly apostrophes, removes double quotes and collapses
whitespace. A question mark makes it a question. A message that opens with an approval phrase, with
no quote marker (`>`) or backtick before it and no decline phrase or "dont" in its first clause, is
other instead in two cases: its only question marks are in code (fenced, indented or inline,
backticks typed as apostrophes included), a link target or a URL, where a "?" with an ASCII letter,
a digit or one of `=&%+/#-` after it in the URL is the URL's and any other ends a question; or every
question starts with a topic word such as "also", "separately", "by the way" or "PS" (alone, or
after "and", "but", "so", "we", "I" or "I'm"), and none names a draft (`P<n>` or `#<n>`), says this,
that, these, those, draft, proposal or "the decision", holds a decline phrase, has fewer than two
keywords, or shares a quarter of the subject words of the shorter of it and a draft. A question is
read as a sentence that ends at ".", "!", "?" or "…" and at every line break, so a hard-wrapped
question is read from its last line. A message over 10,000 characters is not read this way. Extra
words, or a mixture of approval and decline phrases, make it other. Courtesies alone do not approve
or decline.

- Approval phrases: `approved`, `approve`, `approve it`, `yes`, `yep`, `yeah`, `y`, `ok`, `okay`,
  `sure`, `proceed`, `go ahead`, `go for it`, `do it`, `record it`, `yes record it`, `that's good`,
  `thats good`, `that is good`, `sounds good`, `looks good`, `lgtm`, `agreed`, `agree`, `i agree`,
  `confirmed`, `confirm`, `correct`.
- Decline phrases: `no`, `nope`, `nah`, `don't`, `do not`, `don't record that`, `do not record that`,
  `don't record it`, `do not record it`, `skip it`, `skip that`, `skip`, `decline`, `declined`,
  `reject`, `rejected`, `drop it`, `not that`, `no thanks`, `no thank you`, `leave it`, `never mind`,
  `nevermind`.
- Courtesies: `please`, `thanks`, `thank you`, `thx`, `ty`.

**When the operator answers:**

- When the hook binds the operator’s approval to the choice, record it with
  `rbook_decisions(action="record", fromDraft="P<n>")`, which records the draft's own words; send
  nothing else. Content about something else is refused. Constraint, rule and profile drafts are
  written as drafted; different content passed to the call is not used and produces a warning,
  except for whitespace changes.
- If the operator adds a condition, asks a question or suggests an amendment, answer it. Show the
  revised choice when it changes and ask the operator to name the choice they approve. A question
  about another subject can be answered independently while the draft stays pending.
- A plain decline ("no", "don't record that", "skip it"…): do not record it.
- No answer: never record it. A draft expires unanswered after 7 days or 3 session starts.
- When a pending choice still needs an answer, look up its full text privately with
  `reasonbook drafts list --project-root DIR`. Send the full proposal as written, a blank line, and
  the instruction and question for its kind. For a decision, use the exact second paragraph
  `Reply “I approve this decision:” followed by the full choice. Should I record this decision?`
  Use the same instruction with
  `constraint`, `rule`, or `profile`, and finish with “Should I record this constraint?”, “Should I
  make this a standing rule?”, or “Should I add this to your operator profile?” Keep identifiers in
  your own tool calls. A bare yes leaves the choice pending unless the client verifies which question
  immediately preceded it. If binding is unavailable, ask the operator to name what they approve.
  Record a decision without `fromDraft` only once the operator explicitly names the choice. The
  whole named reply, including its prefix, must fit in 1,000 UTF-16 units for hook approval. If the
  proposal is too long to repeat within that limit, offer a shorter decision for confirmation.

**When a recorded decision already answers a pending decision draft**, read the existing
decision and draft privately. With the full edition installed, run
`reasonbook drafts settle --draft P<n> --decision N --project-root DIR` with their identifiers
and project directory. Add `--dry-run` to preview. Check the returned outcome and recorded target.
A successful link marks the draft `settled`, which is a draft's mode and never a decision's.
The command checks the identities, timing and wording. It may decline a link whose meaning is
clear to a person. If the CLI is unavailable or refuses the pair, report a settlement only if a
receipt confirms one. Resolve any open choice with the operator in ordinary words. For a clear
answer, use the normal recording workflow. Where hooks run, the next prompt also reports draft
lines that took no effect. Explain any choice the operator still needs to make. When the prompt
reports omitted entries, rely only on the individual drafts and reasons it actually shows.

A draft ends approved (recorded with `fromDraft`), declined, replaced by a revision, expired, or
answered, by a record that covered it automatically or by a settle that named it. Only a Would
record line makes a draft: Reasonbook never detects decision-shaped statements in a reply.

A decision records as `approved` when the named approval is bound to that draft in this
conversation and the submitted decision text matches the draft verbatim.
A change in wording, case, word order or punctuation can make the decision `agent-judged`;
the record keeps the operator’s named approval. An answer that depends on a lost or expired
showing supplies no approval. The operator can give fresh approval of an eligible pending draft
by naming its kind and full choice. That approval is usable for two hours. A late decline persists
after its excerpt expires. Every kind requires session-bound approval to record from its draft.
If the client cannot bind the approval, a decision can be recorded directly with its full content
once the operator explicitly names and approves that choice.

Write a one- or two-sentence headline in `content`. Put the reasons and constraints in `context`,
other options in `alternatives` (an array of strings), effects in `consequences`, and people or agents
in `deciders` (an array of strings). For an implementation choice made within authorized work,
use `mode="autonomous"`; omission leaves the mode unrecorded. Do not use autonomous to claim approval.
A headline over 600 UTF-16 units warns but still records; split separate choices or move details to
these fields. Approved drafts are exempt from that headline warning. A `fromDraft` call cannot
add mode or these fields because they were not part of the approved draft.

Add `missionId` when the choice belongs to a mission, and use structured `evidence` only for real
TraceLab references supported by the tool. Put ordinary source paths and URLs in `context` or
`consequences`. With the package installed globally, the CLI uses the same handler:
`reasonbook decisions record --session-id <harness-id> --content "<headline>" --context "<why>" --mode autonomous`.
Pass `--alternatives` and `--deciders` as JSON arrays; `--project-root` selects the store and
`--format json` returns the structured receipt. A retry preserves existing metadata; if supplied
fields differ, its warning recommends a new superseding record.
To correct a decision, record the replacement with `supersedes=[<old decision id>]`; preserve the
old record instead of editing its historical meaning. A decision needs no session opened merely
to file it. Verify `decisionId` and `materialization`, and inspect any `writeFailures`; report a
failed capture rather than implying it persisted. This skill does not authorize messaging another
project or changing global operator preferences.

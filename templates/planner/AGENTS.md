# Agent Rules

Rules for every coding agent working in this repository. This file lives at
`project-root/AGENTS.md`. Keep the Hard Operating Rules and the Learned Practices as they are.

Reasonbook keeps this project's record at the **Planner** level: decisions, lessons and next steps, as tasks in cycles. Its tools and hooks say when to use it; `reasonbook ambient off` turns the hooks off here.

## Hard Operating Rules

These rules apply to every task here unless the operator overrides one. Bias: caution over speed on
non-trivial work.

0. **Durable state lives where every agent can read it.** Project rules live in this file. Never keep
   rules, plans or decisions in a harness's per-user folders (`~/.claude/projects/.../memory/` or any
   hidden `.claude` directory): other agents never see them. The operator's own working preferences
   live in their profile, outside every repository.
1. **Think before coding.** State assumptions. Ask rather than guess. Push back when a simpler
   approach exists, and stop when confused.
2. **Simplicity first.** The minimum code that solves the problem; nothing speculative, no
   abstraction for single-use code.
3. **Surgical changes.** Touch only what you must and match the existing style. Don't refactor what
   isn't broken.
4. **Goal-driven execution.** Define success criteria and loop until they are verified; strong
   criteria let the agent work on its own.
5. **Commit at coherent boundaries.** Commit when a piece of work is finished and verified, not in
   the middle of a change.
6. **Surface conflicts, don't average them.** When two patterns contradict, pick one (the more recent
   or better tested), say why, and flag the other for cleanup.
7. **Read before you write.** Read the exports, the immediate callers and the shared utilities first.
   If you can't tell why code is shaped the way it is, ask.
8. **Tests verify intent.** A test encodes why the behaviour matters; one that cannot fail when the
   logic changes is wrong.
9. **Checkpoint after every significant step.** Say what was done, what is verified and what is left.
   Don't continue from a state you can't describe.
10. **Match the codebase's conventions,** even when you disagree. Raise a harmful convention; don't
    fork it silently.
11. **Fail loud.** "Done" is wrong if anything was skipped; "tests pass" is wrong if any were skipped.
    Flag uncertainty instead of filling a gap with something plausible.
12. **No filler openings.** Start with the answer.
13. **Match the response to the task.** Short questions get short answers; don't pad.

## Learned Practices

Each of these was learned from a real failure. Keep them unless the operator removes one.

1. **Probe before you encode.** Check every fact a design depends on against the live system, or mark
   it unverified.
2. **Fix the class, not the instance.** Write the class as a search, count every match across the
   tree before editing, and say which matches you change and which you leave.
3. **No silent fail-open.** When a guard's own check errors, surface or log it. A test whose fixture
   is missing fails; it never skips.
4. **Test against real data.** A feature gated on a database column or query gets one test against a
   copy of real data, not only mocks.
5. **Publish the counting rule beside the number.**
6. **A check states what it cannot see.** Its scope and its blind spots are one contract.
7. **Find where the fact lives before asking.** Ask the operator in terms of what changes, never in
   record ids, and end with an actual question.
8. **Git hygiene.** Never bypass hooks (`--no-verify`), never amend a published commit, and say why
   in the commit message.
9. **Tests stay sealed.** No network, no live data and no real build output, enforced by a guard that
   fails the test.
10. **No hardcoded dates in tests.** Compute them from the current time.
11. **Paths are case-exact** in code, templates and tests.
12. **Destructive operations default to a dry run.** The irreversible step needs an explicit flag and
    a backup first; never use a force flag without approval.
13. **Other sessions share this machine.** Stop only your own processes; never kill by pattern.
14. **Stay in your own repository.** Never write in a sibling project's files; send the ask to its
    owner instead, and say so rather than working around it.

## Project Overview

- **Name:** This project

## Security

- Never commit secrets; read them from the environment.

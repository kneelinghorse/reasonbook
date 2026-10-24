# Reasonbook documentation

Reasonbook is the project record your agents keep: what was decided, why, what was
learned, and what remains. It lives in the project, in `rbook/db/rbook.sqlite`, so the next session
can pick up from it, even in another tool. No dashboard account is required.

[See it work](https://github.com/kneelinghorse/reasonbook/blob/main/docs/demo/README.md): a 75-second replay of recorded runs in Claude Code and Codex.

## Install

Start with [Your first ten minutes](first-ten-minutes.md): install, record a choice and find its reason in a new session.

- **Claude Code:** install the plugin once for all your projects; see
  [Install it in Claude Code](../README.md#install-it-in-claude-code).
- **Codex:** the developer plugin, or the conversation-focused chat plugin; see
  [Codex](harnesses.md#codex).
- **Another MCP client:** run the server with `npx`. [Getting started](getting-started.md) has a
  configuration block for each client. Claude Code and Codex are verified; the others are untested.

## Choose a level

- **Ledger:** decisions and lessons.
- **Planner:** decisions, lessons and next steps.
- **Builder:** all of that, plus sprints and missions.

In Claude Code, `/reasonbook:init` asks which level a new record should start at. With the CLI, run
`reasonbook init --level ledger`, `planner` or `builder` in the project folder. [The method](method.md)
explains what Reasonbook does at each level and how to move up, and the
[starter templates](https://github.com/kneelinghorse/reasonbook/tree/main/templates) hold the files each level starts with.

## Trust

[What Reasonbook does on your machine](trust.md): what leaves it and when, what the hooks read and
add, credentials, dependencies, and how to turn each part off or remove your data.
[Privacy](privacy.md) covers collection, dashboard visibility, retention and removal. Security
reports go through [SECURITY.md](../SECURITY.md).

## Reference

- [Getting started](getting-started.md): client configuration and an optional Builder walkthrough.
- [Harness coverage](harnesses.md): the plugins, the adapters and the fallback without hooks.
- [Tool reference](../TOOL_REFERENCE.md): every tool, action and parameter.
- [Changelog](../CHANGELOG.md): release notes and tool-surface changes.

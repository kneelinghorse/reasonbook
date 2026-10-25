# Reasonbook starter: Planner

A Planner keeps a project's decisions and lessons, plus its next steps, as tasks in cycles. This folder holds the two files a project at this level starts with: `AGENTS.md`, the
project's rules for every agent, and `CLAUDE.md`, which imports them for Claude Code.

## Start

Copy the two files into the project folder, start the record at this level, and read the first
review. With the CLI installed (see [the three-step quickstart](../../README.md#get-a-project-digest-in-three-steps)):

```sh
cp templates/planner/AGENTS.md templates/planner/CLAUDE.md /absolute/path/to/your/project/
cd /absolute/path/to/your/project
reasonbook init --level planner
reasonbook review --format=context
```

With the Claude Code plugin ([install it](../../README.md#install-it-in-claude-code)), copy the two
files, start a session in the project and run `/reasonbook:init`, choosing Planner; `/reasonbook:start`
reads the record.

When a project has no rules files, `init` writes these files and fills in the project's name. It
keeps your copies as they are. Its
line about the record names this level: decisions, lessons and next steps.

## Then

Add this project's established commands and conventions to `AGENTS.md` as they become known. The
[method](../../docs/method.md) explains what Reasonbook does at each level and how to move up.

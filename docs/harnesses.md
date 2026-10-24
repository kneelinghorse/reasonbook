# Reasonbook in your harness

The Codex developer plugin was verified in a live bundled Codex app-server on **2026-10-11**,
using `codex-cli 0.159.0-alpha.12.1` and an isolated candidate installation. ChatGPT Work remains
**UNVERIFIED**. The other non-Claude adapters below remain **UNVERIFIED in a live harness**;
their vendor documentation was checked on **2026-10-09**. Local fixtures alone check the CLI
contract and package contents, not whether a vendor delivers hook output to a model.

The Codex plugin below installs its own pinned runtime. For the other adapters,
install the CLI before enabling hooks:

```sh
npm install -g @aquex/reasonbook@4.5.1
reasonbook --version
npm root -g
```

If the former package is installed globally, run `npm uninstall -g @aquex/cmos-mcp` first. Version 4 provides only the `reasonbook` command; update scripts and MCP configurations that use the old command. The adapters below run `reasonbook`. See [the migration guide](migrating-from-cmos.md) when upgrading.

The last command locates the global packages directory. The configuration sources
listed below live in its `@aquex/reasonbook/adapters/` directory. Merge entries into an
existing destination instead of replacing unrelated hooks. Make `reasonbook` available
on the harness process's PATH. Hooks call the installed CLI directly: invoking `npx`
inside a hook would spend its short deadline finding or downloading the package.

Configure the Reasonbook MCP server in your harness separately when using an adapter; it adds lifecycle
hooks, not an MCP server. See [getting started](getting-started.md).

## Coverage

“Start” means the adapter can provide the project digest. “Prompt” means it can
inject recall and a pending draft offer before a user turn. “Reply” means it can
read the next user reply through a hook. These describe the implemented adapter
contract, subject to the live-verification limitation above.

| Harness                                      | Start         | Prompt / draft offer                                     | Reply observation                | Close                          | Decision approval through MCP                                         |
| -------------------------------------------- | ------------- | -------------------------------------------------------- | -------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| Claude Code plugin                           | Yes           | Yes                                                      | Yes                              | SessionEnd                     | Hook evidence when the MCP server shares the verified harness session |
| Codex developer plugin                       | Yes           | Yes; Stop captures a draft from `last_assistant_message` | Yes                              | SessionEnd                     | Hook evidence bound to the MCP conversation and enclosing project     |
| Cursor IDE / CLI adapter                     | Yes           | No                                                       | No                               | Manual                         | Agent-attested                                                        |
| Devin CLI / Devin Local adapter              | Yes           | Yes for existing drafts; no automatic Stop draft capture | Observed; no named-draft binding | Hook cleanup; manual MCP close | Agent-attested; MCP session linkage is unverified                     |
| Copilot CLI / cloud adapter                  | Yes           | No                                                       | No                               | Manual                         | Agent-attested                                                        |
| VS Code Local adapter                        | Yes           | No                                                       | No                               | Manual                         | Agent-attested                                                        |
| Zed / Warp / goose, using the fallback below | Agent-invoked | Agent-invoked                                            | Agent judgment                   | Agent-invoked                  | Agent-attested                                                        |

Agent-attested decisions mean the agent states that the operator approved the text.
Constraint, rule and profile drafts require verified hook approval and cannot use
agent-attested capture. A stable ID in hook stdin alone does not establish a
connection to the MCP server process. Non-Claude
transcripts are not scanned as Claude transcripts; their outside-content provenance
remains unknown. Without MCP session linkage, SessionEnd cleans up hook-owned
state but cannot close the MCP process's separate session; close that session through
MCP. Stop, compaction and end hooks never request an extra model turn.

## Codex

Install the developer plugin from the Reasonbook marketplace:

```sh
codex plugin marketplace add kneelinghorse/reasonbook
codex plugin add reasonbook@reasonbook
```

If the plugin is installed under its former name, remove it first, because both plugins answer as the
same server: `codex plugin remove cmos@cmos`, and `codex plugin remove cmos-chat@cmos` for the chat
plugin.

It includes the MCP server, skills and five lifecycle hooks. Node 20 or newer is
required. The server launcher checks PATH, the login shell and the usual Homebrew
folders. The plugin installs its exact Reasonbook version in
`~/.config/rbook/plugins`, or the selected legacy config folder for an existing installation.
Both Codex plugins and the developer hooks share that installation; no package is installed
in Codex's private plugin data directory. The developer plugin requests forwarding of
`RBOOK_CONFIG_DIR` and the other supported settings. The portable chat plugin uses the
environment inherited from its host. Both retain legacy `CMOS_*` fallback.
Set a custom root to an absolute folder; shared entries refuse empty or relative values
because hooks and servers run in different folders. Actual forwarding depends on the
client's plugin loader; custom-root forwarding through every loader is unverified.
Use the default root or a
manually configured server if your loader does not forward the setting.
During a cold install the server answers immediately
with an installing message. Start a new session after installation finishes to
load the tools reliably. The bootstrap fixture kept the original thread at zero
tools. A candidate-runtime status probe listed all 15 as connected; the published
runtime listed 15 while reporting a failed connection. New sessions in the same
app connected successfully with all 15 tools. Model access to tools in the
original session remains unverified.

In the Codex CLI, use `/hooks` to inspect and review the five commands from
[`hooks/codex.json`](../plugins/reasonbook/hooks/codex.json). For the desktop app, use its
bundled Codex CLI with the same Codex home if the app does not expose hook review.
Trust applies to the exact definition. The commands contain no release version,
and an isolated version-update probe preserved their trust. Changed definitions
require review again. Do not bypass review or write trust records on the
operator's behalf. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

If you enabled the CMOS 3.3.0 adapter, remove its five CMOS entries from
`.codex/hooks.json` before enabling the plugin. Preserve unrelated entries. Also
remove any other imported CMOS hook registration: the adapter and plugin can both
run, and duplicate delivery is not prevented without verified process identity.
The plugin supplies its own MCP server; remove a duplicate manual Reasonbook server or
set `pluginServer` to `off` in the Reasonbook user config when deliberately retaining the
manual server.

The hooks map `session_id`, `cwd`, `turn_id` and `last_assistant_message` into the
shared CLI. They wire SessionStart, UserPromptSubmit, Stop, PreCompact and SessionEnd;
start and prompt use the nested `hookSpecificOutput.additionalContext` envelope.
Use the plugin's skills for the guided workflows. Bootstrap, hook-trust updates and
tool refresh were probed with `codex-cli 0.159.0-alpha.12.1`.

The live two-turn acceptance separately verified a project digest, a trailing
`Would record:` draft captured by Stop, and a literal `yes` on the next turn. The
model recorded that draft through MCP with `approval_mode=approved` and
`approval_words=yes`. Its author session belonged to the hash of that Codex
conversation, and SessionEnd completed it. The run used actual plugin hooks, with
no manually supplied hook events. This establishes the tested Codex boundary;
VS Code extension-host and Claude Desktop linkage remain unverified.

For an ordinary call without `projectRoot`, Codex supplies the client folder and
Reasonbook reports `resolvedBy=client-cwd`. Approval linkage additionally requires hook
evidence for that conversation in the same physical project store. A call naming
a different project or lacking that evidence keeps process ownership; a decision
may be agent-attested, while constraint, rule and profile drafts still require
hook-bound approval. The [boundary fixtures](https://github.com/kneelinghorse/reasonbook/blob/main/tests/integration/codex-request-dispatch.test.ts)
cover missing metadata, first drafts, other projects and SessionEnd cleanup.

## Cursor IDE and CLI

Merge [`adapters/cursor/hooks.json`](../adapters/cursor/hooks.json) into
`.cursor/hooks.json`. Trust the workspace. If Reasonbook hooks are also imported from
Claude configuration, turn off **Settings → Agents → Third-Party Imports → Include
Third-Party Plugins, Skills, and Other Configs**, or remove the duplicate imported
Reasonbook hook registration. That switch affects other imported configuration too.
Cursor runs matching hooks from every source; native priority does not suppress
duplicates. [Third-party imports](https://cursor.com/docs/reference/third-party-hooks)

This adapter wires only `sessionStart`, returning `additional_context`. Current
docs identify its `session_id` as the same ID as `conversation_id`. Cursor's prompt
hook cannot inject the pending offer, so this adapter does not wire it. Hosted cloud
agents do not provide this session-start boundary; this adapter therefore does not
claim cloud coverage. Check Customize's Hooks tab and the Hooks output channel.
**Live runtime: UNVERIFIED.** [Cursor hooks](https://cursor.com/docs/hooks)

## Devin CLI and Devin Local

Merge [`adapters/devin/hooks.v1.json`](../adapters/devin/hooks.v1.json) into
`.devin/hooks.v1.json`. This file is the event map itself, without a `hooks` wrapper.
It wires SessionStart, UserPromptSubmit and SessionEnd. The adapter uses
`DEVIN_PROJECT_DIR`, `session_id` and `prompt_id`; start/prompt output uses the nested
`hookSpecificOutput.additionalContext` envelope. Run `/hooks` to inspect loaded
sources. **Live runtime: UNVERIFIED.** [Devin hooks](https://docs.devin.ai/cli/extensibility/hooks/overview)

Merge [`adapters/devin/config.json`](../adapters/devin/config.json) into
`.devin/config.json` to set `read_config_from.claude` to `false` and prevent imported
Claude hooks from running alongside these native hooks. This also disables imported
Claude rules, skills and MCP configuration; retain the required native configuration
and AGENTS.md. Do not install the Reasonbook plugin's hooks alongside this adapter.
[Devin import controls](https://docs.devin.ai/cli/reference/configuration/read-config-from)

The documented Stop payload has no assistant reply, and PostCompaction is a different
boundary from Reasonbook's pre-compact hook. Neither event is wired. Prompt hooks observe
replies, but without Stop they cannot establish which named draft the assistant
showed for approval. Record agreed decisions
through MCP; without verified session linkage, their draft approval is agent-attested.
[Devin lifecycle](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)

## GitHub Copilot and VS Code Local

Choose **one** of these alternatives for `.github/hooks/rbook.json`:

- **Copilot CLI or cloud agent:** [`adapters/copilot/rbook.json`](../adapters/copilot/rbook.json).
  Uses `version: 1`, `sessionStart`, `sessionId`, and top-level `additionalContext`.
  Its Bash and PowerShell commands invoke the same installed CLI. Cloud jobs require
  the package and project store to be available in the job; their network access is
  restricted and their filesystem is ephemeral. No prompt hook is wired because
  config-file prompt output is discarded. **Live runtime: UNVERIFIED.**
  [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- **VS Code Local session target:** [`adapters/vscode/rbook.json`](../adapters/vscode/rbook.json).
  Uses `SessionStart` without a numeric `version`, optional `session_id`, and nested
  `hookSpecificOutput.additionalContext`. Local hook support is preview. Enable
  `chat.useHooks`, trust the workspace, and leave `chat.useClaudeHooks` off when using
  this adapter. Inspect **Chat: Configure Hooks** and the **GitHub Copilot Chat Hooks**
  output channel. **Live runtime: UNVERIFIED.**
  [Local hook configuration](https://code.visualstudio.com/docs/agent-customization/hooks),
  [Local schemas](https://code.visualstudio.com/docs/agents/reference/hooks-reference)

VS Code can parse Copilot configuration, but its Local runtime sends different
payloads and consumes a different output envelope. Select the adapter for the actual
session target, and replace the Reasonbook entry when switching targets. Installing both
files would run both. Remove any duplicate Reasonbook hook registrations from imported
Claude settings or installed plugins. These adapters intentionally provide only the
start digest: close the Reasonbook session explicitly with the close-out command or MCP.

## MCP prompts and harnesses without hooks

Reasonbook exposes four MCP prompts from the same source files as its skills:
`rbook-start`, `rbook-close-out`, `rbook-plan`, and `rbook-build`. Select them through your
client's MCP prompt picker or slash-command menu when available. They are invoked by
the user or agent; exposing a prompt does not make it run automatically. Client
support varies, so no prompt-only client is described as having lifecycle hooks.

For Zed, Warp, goose, or any harness without this adapter support, run:

```sh
reasonbook init --no-hooks
```

Use the AGENTS.md output from that command. Its labelled hook-less block is at most
15 lines and comes from the same init source used for every project; do not maintain
a second copy of the procedure in a client-specific rules file. If the harness does
not load AGENTS.md automatically, include that file through its project instructions.
The fallback asks the agent to review the project record and capture unfinished work,
so delivery depends on the agent following the instructions. **Live runtimes: UNVERIFIED.**

## Duplicate execution and verification limits

Enable one Reasonbook hook source in each harness. Cross-source election requires a real,
verified harness-process lifetime; turn deduplication requires a stable turn ID.
Missing identity means no deduplication guarantee. Do not substitute a guessed PID,
hook process PID, timestamp, or prompt-text hash. Native filenames prevent Claude
Code from loading these adapters, but they do not prevent another harness from also
importing existing Claude hooks.

Repository fixture tests cover native config structure, shipped files, payload
normalization and output envelopes. A live verification must additionally show that
the selected harness discovers the configuration, executes the installed CLI, and
delivers the digest exactly once. None of the non-Claude rows above claims that
verification has happened.

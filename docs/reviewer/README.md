# Review Reasonbook locally

Reasonbook keeps project decisions, their reasons, lessons and next steps in a local SQLite record.
The developer plugin adds hooks and skills for Claude Code and Codex. This sample tests the local
MCP workflows without a Reasonbook account. Your AI client may require its own account or subscription.
The optional dashboard and shared-record workflows are separate from this sample.

This is a review aid, not a directory approval or a hosted service. Anthropic policy interpretation
and OpenAI local-partner/package acceptance remain unresolved. The developer plugin has hooks;
the local directory edition `reasonbook-chat` is hook-free but has not been accepted for a public directory.

## Exact sample setup and reset

Use Node.js 20 or newer and an installed or built candidate package whose `dist/bin.js` and
dependencies are present. Use the exact package folder supplied with the release's version/hash
receipt. Installing dependencies can contact npm, GitHub or nodejs.org as [Privacy](../privacy.md)
describes; the sample does not install them or sign in.

From the public repository, run:

```sh
node docs/reviewer/sample.cjs /absolute/path/to/candidate-package resume
```

The script creates a new temporary folder on every run. Its JSON output gives the `project` folder,
the deliberately absent `missingProject`, the candidate version/build, and the MCP configuration.
The same output is saved as `setup.json` in the new root, including the complete case prompt.
Use the case id from the table below in place of `resume`. For seeded cases it creates a Ledger named **Cedar Reading
Log**, with exactly these fictional seed records:

- Decision: “Use SQLite for Cedar Reading Log because it works offline and keeps reading entries portable.”
- Open next step: “Catalog the first five fictional books in Cedar Reading Log.”

The generated `mcp.json` launches `server.cjs`, which replaces the server environment with an
isolated configuration directory, no inherited dashboard credentials, all automatic sharing/upload
switches off, embeddings offline and a loopback-only dashboard address. The sample uses manual
stdio MCP and no installed hooks. It does not demonstrate plugin installation or hook trust.
Keep the generated wrapper: copying only its inner server command into a client could inherit
your normal credentials instead.

To reset, run the setup command again and use the new project's configuration. Run each case on a
fresh sample, so a correction in one case cannot change another's expected answer. The `missing`
and `unrelated` cases create empty project folders without initializing or seeding a record; the
other six cases use the seed above. To remove a
sample, stop that sample's client/server and delete only the generated root named in its `setup.json`.
Do not delete your normal Reasonbook configuration or an existing project.

## Connect a client

Use the generated `mcp.json` as a manual MCP configuration in Claude Code. For a CLI check:

```sh
cd /absolute/sample/project
claude --strict-mcp-config --mcp-config /absolute/sample/mcp.json
```

In a scratch Codex configuration, use the `command` and sole `args` entry printed in `setup.json`:

```toml
[mcp_servers.rbook]
command = "/absolute/path/to/node"
args = ["/absolute/sample/server.cjs"]
```

Start Codex in the printed project folder. Permit the listed tools through the client's normal
approval controls. The measured cases use review, decisions, context and project; other optional
tool requests may need separate approval. Do not bypass plugin hook trust. If no `rbook` tools
appear, check the Node path, candidate dependencies and sample's `server-stderr.txt` before retrying.

## Three core examples

On separate seeded samples (the full measured prompts also include the tool-use instruction in `cases.json`):

1. “Record this decision for Cedar Reading Log: store dates in ISO 8601 format because sorting
   must work across locales. This is the decision I want recorded.” Expect a new decision.
2. “Why did we choose SQLite for the fictional Cedar Reading Log? Retrieve the recorded reason.”
   Expect the stored offline and portability rationale.
3. “Correct our SQLite decision: use a JSON file instead because this reading log must run without
   native SQLite extensions. Preserve the earlier decision as history and record the replacement.”
   Expect the original to remain as superseded, linked to its replacement.

## Full case set

[cases.json](cases.json) gives the exact prompts, expected tools and observable results for five
positive cases and three negative cases. The setup output supplies the complete prompt with `{missing}` resolved. Every prompt includes
the measured instruction to use connected record tools and avoid shell/filesystem tools.

| Case         | Expected result                                          |
| ------------ | -------------------------------------------------------- |
| `resume`     | Read the SQLite choice and catalog next step.            |
| `record`     | Save the explicitly requested ISO date decision.         |
| `recall`     | Retrieve the recorded reason for SQLite.                 |
| `supersede`  | Preserve the old decision and record its replacement.    |
| `next_steps` | Return the open catalog task.                            |
| `unrelated`  | Use no Reasonbook tools.                                 |
| `missing`    | Refuse lookup without creating a project.                |
| `unapproved` | Discuss/propose; do not record the purchase as approved. |

The candidate's eight cases passed in both Claude Code and Codex through manual stdio configurations
using these same seed texts, empty-folder cases and full prompts. The measured harness also disabled
shell/filesystem tools and used fresh client sessions; interactive client defaults may differ. This is local workflow evidence, not evidence of a clean
OpenAI desktop-directory installation. Final submission must identify the released artifact and
replay or prove equivalence to those receipts.

## Walkthrough and review links

The [65-second demo](../demo/README.md) replays recorded Reasonbook 4.6.0 plugin sessions: initial
decision and next step, correction in Codex, then recall in Claude Code. Its captioned receipts are
the evidence; it is not a screen recording. It does not show all three negative cases, the optional
dashboard, or an OpenAI directory installation. This guide and the case set cover the additional
local checks. A full-case video for an accepted OpenAI submission remains a separate review gate.

- Product and installation: [repository](https://github.com/kneelinghorse/reasonbook).
- Support: [issue tracker](https://github.com/kneelinghorse/reasonbook/issues).
- Security: [reporting instructions](../../SECURITY.md#reporting-a-vulnerability).
- Data handling: [Privacy](../privacy.md), [Trust](../trust.md), and the
  [live notice](https://reasonbook.ai/privacy). A local edit does not update the live notice.
- Hosted-service terms: [reasonbook.ai/terms](https://reasonbook.ai/terms); the local software is
  separately [Apache-2.0 licensed](../../LICENSE).
- Versioned release notes: [Changelog](../../CHANGELOG.md).

No reviewer secrets or real project data belong in this package. Dashboard review is not claimed:
if included in a submission later, supply a separate accessible sample-data account and test its
sign-in instructions. Publisher identity, audience, endpoint ownership and legal attestations must
be supplied by the authorized publisher; they are not inferred from the manifest's display name.

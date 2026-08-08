---
name: subagent-delegation
description: Delegate coding tasks to user-configured DevSpace subagents.
---

# Subagent Delegation

Use this skill when the user explicitly asks to delegate work to another coding
agent, use a named subagent, get a second opinion, compare approaches, or run
a subagent-like workflow.

Do not use subagents silently. Tell the user when another subagent is
being used.

## Core commands

Use only these commands for normal delegation:

```bash
devspace agents ls
devspace agents run <profile-or-provider-or-id> "<prompt>"
devspace agents wait <id> [--timeout <seconds>]
devspace agents show <id>
```

`ls` shows existing subagent sessions for the current workspace. DevSpace scopes
it automatically from the shell environment injected by the workspace tool.

`run <profile> "<prompt>"` starts a new configured profile and prints a
DevSpace agent id.

`run <provider> "<prompt>"` starts a raw built-in provider when no configured
profile is needed. Built-in providers are listed by `open_workspace`.

`run <id> "<prompt>"` sends a follow-up to an existing agent. Follow-ups
continue the same provider conversation; they do not start over.

`wait <id>` blocks until the agent finishes, errors, or stops, then prints the
final response once. Use it right after `run` instead of polling `show`. The
default timeout is 300 seconds (override with `--timeout <seconds>` or
`DEVSPACE_AGENTS_WAIT_TIMEOUT`). A timeout never stops the worker — call
`wait` again to keep waiting.

`show <id>` prints status and the latest response for quick checks and manual
debugging. If the agent is still running, `show` waits briefly; prefer `wait`
when you actually want the result.

Do not run provider CLIs such as `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, or `copilot` directly unless you are explicitly debugging
DevSpace agent integration.

## Diagnostics and security

If a subagent provider is unavailable, run `devspace doctor` to check provider
availability, local listener health, and the public URL reachability advisory.

Subagent workers inherit the local-user authority of the DevSpace process. ACP
auto-approval inside a worker is a convenience, not a security boundary. The real
boundary is the OS user account that runs DevSpace. Recommend that the user runs
DevSpace as a dedicated, non-administrator account with access only to the
intended project roots.

## Choosing a profile

Choose profiles from the compact subagent profile catalog returned by
`open_workspace`. Use the profile name with `devspace agents run`. If no
profile fits and delegation is still appropriate, use a built-in provider name
from `open_workspace`.

Profiles may declare a model and optional thinking level. To override the
configured/default provider model or thinking level for a run, pass `--model`
or `--thinking`:

```bash
devspace agents run <profile-or-provider> --model <model> "<prompt>"
devspace agents run <profile-or-provider> --thinking <level> "<prompt>"
```

Use `--thinking` only when the user asks for a specific reasoning depth or when
the task clearly needs a different effort than the configured profile default.
Thinking values are provider-specific passthrough values. Use names supported by
the selected local agent harness; DevSpace does not translate values between
providers.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation.
- `implementer`: focused implementation when the user asked for delegation.

Do not delegate ordinary coding work just because a profile exists. Use normal
DevSpace tools unless the user asked for delegation, another agent's opinion,
parallel work, or a named subagent.

## Worker prompts

Agents start with only the prompt you send plus their configured profile
instructions. Make prompts self-contained.

Implementation prompt shape:

```text
Goal:
<clear goal>

Context:
<repo/module/user constraints>

Relevant files:
<paths and why they matter>

Acceptance criteria:
- <criterion>

Rules:
- Keep changes focused.
- Do not perform unrelated refactors.
- Report blockers clearly.
```

Read-only investigation prompt shape:

```text
Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
```

## Project memory

Workers can read and write durable project memory through DevSpace. Use these
tools so the same memory is available to the host brain and other workers:

- `list_project_memory({ workspaceId })`
- `read_project_memory({ workspaceId, file })`
- `write_project_memory({ workspaceId, file, content })`

Well-known file names:

- `decisions.md` — key decisions and rationale.
- `progress.md` — what has been completed.
- `next-steps.md` — remaining work or checkpoints.

Memory is stored outside the repo under DevSpace state. It persists across
sessions for the same canonical project root. Use it only for durable project
facts, decisions, and checkpoints; do not store secrets or transient
chain-of-thought there. File names must end with `.md` and contain no path
separators or hidden names.

## After the worker responds

Always review the result before presenting it as verified.

For write-capable tasks, inspect changed files and run or explain relevant
tests. For read-only tasks, verify that important claims are supported by repo
evidence.

Be transparent in the final response:

```text
I used <profile>. It reported <summary>. I verified <checks>. Remaining risk:
<risk or none>.
```

Never hide that a subagent was used.

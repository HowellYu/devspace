# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

## Brain/Worker Delegation

The intended high-leverage workflow is for the host model to act as the brain
and for configured subagents to act as workers: the host designs, specifies,
and reviews; workers run the local edit-test-fix loop.

1. Open the workspace and write a self-contained worker prompt (goal, context,
   relevant files, acceptance criteria, rules).
2. Start a worker: `devspace agents run luna-worker "<prompt>"`.
3. Wait once: `devspace agents wait <id> --timeout 300`. Do not poll
   `agents show` in a loop; `wait` returns the final response exactly once and
   a timeout never stops the worker.
4. Review through the change checkpoint (`show_changes` with
   `DEVSPACE_WIDGETS=changes`) rather than rereading the repository.
5. Send corrections as a follow-up to the same session:
   `devspace agents run <id> "<review findings>"`. ACP providers (`cursor`,
   `copilot`, `luna`) resume the stored provider conversation through
   `session/load`. If the provider cannot load the previous session, the run
   fails instead of silently starting over.

Security posture for workers:

- A subagent process runs with the permissions of the operating-system user
  that runs DevSpace. `cwd = workspace` is not a sandbox, and DevSpace allowed
  roots restrict DevSpace file tools, not provider child processes.
- Run DevSpace and workers under a dedicated, non-admin operating-system user
  with access only to the intended project directories.
- Profiles such as `luna-explorer` are instruction-level read-only. Do not
  describe them as security-enforced read-only unless an external sandbox
  exists.
- Use worktrees for workflow isolation between parallel workers, not as a
  security boundary.

Concurrency guardrails: start with one implementation worker and at most two
explorers, keep parallel workers on non-overlapping files, and prefer targeted
tests before full-suite runs.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from `open_workspace`; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Project Memory

DevSpace keeps a small durable project memory store scoped to each canonical
project root. It lives inside the workspace at `.devspace/memory/` (for
example, `<workspace>/.devspace/memory/`), so it survives server restarts and
new ChatGPT sessions for the same project can read it. DevSpace creates
`.devspace/.gitignore` with `memory/` so memory files are not committed by
default; if you already have a `.devspace/.gitignore`, add `memory/` to keep
memory local.

Use these tools to access memory:

- `list_project_memory({ workspaceId })`
- `read_project_memory({ workspaceId, file })`
- `write_project_memory({ workspaceId, file, content })`

Well-known memory file names:

- `decisions.md` — durable project decisions and rationale.
- `progress.md` — current progress and completed milestones.
- `next-steps.md` — pending work and next checkpoints.

`open_workspace` returns the existing `memoryFiles` for the project so new
sessions can discover prior memory without extra calls. Memory namespaces are
stable for the same canonical root, so checkout and worktree modes for the same
project share the same memory.

Memory is only for durable project facts, decisions, and checkpoints. Do not
store secrets, credentials, owner passwords, or transient chain-of-thought
there. File names are validated: they must end with `.md`, contain no path
separators, and must not be hidden.

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `DEVSPACE_WIDGETS=off` to disable widget UI, or `DEVSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, call it exactly once after the final file
modification in any turn that changes files. It shows the combined changes for
that turn and advances the review point automatically. Reusing a workspace does
not change this workflow.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.

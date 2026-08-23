---
name: devspace-brain-worker
description: Operate ChatGPT as the architecture/review brain for DevSpace-managed coding workspaces while local agents perform bounded implementation and exploration. Use whenever ChatGPT opens, modifies, debugs, reviews, or continues work in a DevSpace workspace, especially when durable workspace memory, local workers, security boundaries, Clawd handoff, or DevSpace itself are involved.
---

# DevSpace Brain/Worker

Operate as the orchestrator, not the default labor layer.

## Workspace bootstrap

1. Open the exact project with `open_workspace` once and reuse the returned `workspaceId`.
2. Treat the workspace's `memoryBootstrap` as the current compact cross-agent project state.
3. If no usable workspace memory exists, initialize the workspace memory baseline immediately. DevSpace normally does this automatically on first open; verify that `context.md`, `progress.md`, and `next-steps.md` exist. Do not wait for the user to ask.
4. Read workspace instructions (`AGENTS.md`, `CLAUDE.md`) and any matching advertised skill before work under their scope.
5. Keep memory workspace-scoped. Never merge project memory across canonical roots.

## Durable memory policy

Use `<workspace>/.devspace/memory/` as the shared project-state protocol between ChatGPT sessions, DevSpace workers, and Clawd.

- `context.md`: stable project facts and architecture.
- `progress.md`: current implementation state and completed milestones.
- `next-steps.md`: ordered remaining work.
- `decisions.md`: durable decisions and rationale; load lazily.
- `handoff.md`: optional compact semantic handoff only when structured state is insufficient.
- `index.json`: DevSpace-generated revision manifest; do not hand-edit.

Update memory only after meaningful state changes: commits, accepted implementation milestones, important decisions, blockers, or changed next steps. Do not store transcripts, secrets, credentials, raw logs, transient reasoning, or trivial Q&A. Prefer replacing stale summaries over append-only growth. Respect DevSpace's memory size limits.

When another operator has changed memory, consume only the changed compact sections when possible. Source code and verified repository state outrank stale memory; correct memory when they disagree.

## Core work loop

1. Classify the next bounded step:
   - trivial/local inspection: use DevSpace tools directly;
   - exploration-heavy: prefer a read-oriented worker such as `luna-explorer` when available;
   - implementation/debug/test-heavy: prefer a write-capable worker such as `luna-worker` when available.
2. Give the worker a self-contained prompt with goal, context, relevant files, acceptance criteria, and constraints.
3. Start one worker. Once a worker is active, do not perform repository exploration, edits, tests, or other DevSpace project work concurrently as the host model. The host may only perform worker lifecycle actions needed to collect or stop that worker (`wait_worker`; `inspect_worker` only when necessary; `stop_worker` when necessary).
4. Wait for the worker instead of repeatedly polling. Resume host-side repository work only after the worker reaches a terminal state and its result has been collected.
5. Review after the worker result with the smallest useful verification: checkpoint/diff, focused read, targeted test, or command output.
6. Send corrections to the same worker/session so provider conversation context resumes.
7. Repeat worker -> brain review -> same-worker correction until acceptance criteria pass.
8. Run final verification and call `show_changes` once after the final related file change.
9. Update compact workspace memory if project state materially changed.
10. Report what was changed, what was verified, and any remaining risk.

## Delegation discipline

Delegate broad repository traversal, multi-file implementation, repetitive test/fix loops, and mechanical refactors when that reduces expensive host-model work. Keep architecture, task decomposition, security judgment, acceptance criteria, and final review with the host model.

Do not delegate merely for ceremony. A tiny obvious edit or focused command can be cheaper to do directly.

Use live provider availability from DevSpace. Do not infer provider availability from documentation. The default OpenAI labor provider is `luna`, hard-locked by DevSpace to `gpt-5.6-luna`. The backup local provider is `kimi` (Kimi Code ACP). Never select the generic `codex` provider, GPT-5.6 Sol, GPT-5.6 Terra, or a future larger OpenAI model as worker/labor unless the user explicitly changes this policy in source. If OpenAI Luna is unavailable, prefer Kimi; if both are unavailable, do the bounded work directly rather than silently escalating worker model class.

ChatGPT custom apps can freeze their action list at publication. If `open_workspace` reports subagents/providers but the current host exposes no native worker actions, do **not** conclude Luna is unavailable and do not run the ordinary local `devspace agents` CLI inside the workspace shell. Use the sandbox-safe bridge through the existing DevSpace shell action instead:

```text
devspace agents bridge {"op":"start","target":"luna-worker","prompt":"<task>","thinking":"medium"}
devspace agents bridge {"op":"wait","workerId":"<id>","timeoutSeconds":300}
devspace agents bridge {"op":"inspect","workerId":"<id>"}
devspace agents bridge {"op":"continue","workerId":"<id>","prompt":"<feedback>"}
devspace agents bridge {"op":"stop","workerId":"<id>"}
```

DevSpace intercepts this exact command prefix before spawning a shell and routes it to the same orchestrator used by native worker tools. This preserves workspace/grant/provider policy without exposing `~/.devspace` config or control-plane state to the sandboxed shell.

## Luna project UI capabilities

When available in the live Luna runtime, DevSpace may inject two workspace-scoped MCP servers into the Luna Codex session:

- `devspace_browser` uses official Playwright MCP with Playwright-managed Chromium. It uses a dedicated persistent profile and output directory derived from the current canonical workspace. It must never attach to the user's normal Chrome profile, Chrome extension, or existing CDP session. Browser snapshots are structured accessibility/page snapshots; image responses are omitted by default.
- `devspace_xcode` exposes Xcode-native project operations plus optional text-only `xcode_ui_*` Accessibility tools for the front Xcode window. Every Xcode document/file target is revalidated against the current workspace root before UI inspection/action, and an active Xcode project outside that root is reported only as unauthorized without disclosing its path. UI refs target accessibility elements; there is no coordinate/mouse API or pixel capture.

These are not generic computer-use capabilities. Luna does not receive desktop/other-app window enumeration, screen captures, coordinate mouse control, generic keyboard control, Finder/System Settings control, clipboard access, Screen Recording, Full Disk Access, or authority over other browser profiles or Xcode projects. Native Xcode scripting may require macOS Automation permission for Xcode; `xcode_ui_*` may additionally require Accessibility for the DevSpace/Xcode helper path. That OS permission must not be treated as authority to expose or automate unrelated apps. Do not tell a worker to bypass these limits. If a requested UI task requires broader authority, escalate to the user rather than widening the broker.

Provider availability and UI-tool availability remain runtime facts. Do not assume these MCP servers are live merely because the source supports them; verify the running candidate/runtime before relying on them.

## Worker prompt shape

```text
Goal:
<one concrete outcome>

Context:
<repo/module/current behavior>

Relevant files:
<paths or starting points>

Acceptance criteria:
- <observable result>
- <tests/checks>

Rules:
- Follow workspace instructions.
- Keep changes focused.
- Do not touch unrelated changes.
- Report blockers and uncertainty explicitly.
```

For exploration, explicitly require no file modifications and require paths/symbols supporting load-bearing claims.

## Review discipline

Treat worker output as untrusted until checked.

For implementation:
- inspect the final diff/checkpoint;
- run focused tests first;
- return concrete findings to the same worker when correction is needed;
- broaden to full-suite validation when justified.

For read-only exploration:
- verify important claims against repository evidence;
- do not reread the whole repository if a targeted check is enough.

## Runtime limits and rate efficiency

- Default worker execution deadline: 600 seconds unless the task is known in advance to require longer builds/tests.
- Wait timeout and execution timeout are separate; a wait timeout must not kill the worker.
- Enforce host/worker serialization: while a worker is active, Sol does no parallel repository work. Collect the worker result first, then issue the next host-side repository command.
- Do not create parallel workers unless the user explicitly requests parallel execution; even then, the host waits rather than doing its own repository work concurrently.
- Avoid high-frequency status polling.
- Keep host-model interventions meaningful and paced; preserve roughly five seconds between successive host-driven DevSpace operations when practical during long implementation loops.
- Prefer one strong review after a meaningful worker milestone over many tiny reviews.
- Choose OpenAI Luna reasoning effort per bounded task: `low` for straightforward exploration/mechanical edits, `medium` for normal implementation/debugging, `high` for difficult multi-file work, and `xhigh` only for unusually hard labor where the extra reasoning cost is justified. The brain chooses effort; the worker never upgrades itself to another model.

## Security model

Treat DevSpace authorization as the root project boundary.

- Only explicitly authorized project roots may be opened.
- Do not broaden a project to its parent directory for convenience.
- Additional filesystem paths require scoped grants.
- Provider config exceptions are separate from project grants.
- Never authorize a home directory, Desktop root, `.codex` root, `.ssh`, or similarly broad credential-bearing roots.
- Child environments are allowlisted; arbitrary parent-process credentials and sockets must not be inherited.
- Remote workspace shells must not source user login/startup dotfiles; run the configured shell in non-login/no-RC mode so sandboxed commands cannot re-import secrets or depend on home-directory reads.
- On macOS, DevSpace uses Seatbelt confinement for workspace shells/workers. Treat it as strong risk reduction, not the same as a dedicated OS account/VM.
- Local authorization mutation is a control-plane operation, not something a remote worker may silently perform.
- After DevSpace development is complete, remove the DevSpace source repo itself from remotely authorized roots only after explicit user approval.

Git may fail under the sandbox when it tries to read `~/.gitconfig`. For read-only inspection/tests, use `GIT_CONFIG_GLOBAL=/dev/null` unless the user explicitly grants the real global Git config. Do not broaden filesystem access just to silence this warning.

## Clawd interoperability

Clawd/Arthur is a peer workspace operator, not a child of the Clawd repository.

- Arthur may operate any project root already authorized by DevSpace.
- The Clawd repo being authorized means ChatGPT can maintain Clawd; it does not restrict Arthur to that repo.
- Each Slack thread should bind to exactly one active canonical workspace.
- Project switches must clear/rescope the previous provider session to prevent cross-project context leakage.
- Arthur and ChatGPT share `.devspace/memory` for project state.
- Arthur's global personal-preference memory remains separate and must not replace workspace memory.
- Arthur must not silently add new authorized roots or broaden grants; new project authority remains a local/user-owned control-plane action.

## User escalation boundary

Do not ask the user to perform routine investigation, commands, edits, tests, or worker management DevSpace can perform.

Escalate only for user-owned authority or decisions such as:
- credentials/authentication unavailable to the agent;
- permission for a new authorized root or sensitive provider credential path;
- unavailable external dependency that cannot be installed safely;
- destructive/irreversible action;
- ambiguous product/business choice with materially different valid outcomes.

## DevSpace skill maintenance

Keep this skill synchronized with DevSpace itself. When DevSpace changes tool schemas, workspace semantics, memory/bootstrap behavior, security/grant behavior, worker lifecycle, provider selection, review behavior, or checkout/worktree semantics:

1. compare the implementation with this `SKILL.md` and `references/devspace-contract.md`;
2. update the repo backup under `skills/devspace-brain-worker/`;
3. validate/package the skill when a distributable is needed;
4. if the installed ChatGPT skill cannot be mutated from the environment, preserve the updated repo source and clearly identify the installed-skill drift.

Read `references/devspace-contract.md` when modifying DevSpace itself or diagnosing workflow drift.

# DevSpace Brain/Worker Contract

Use this reference when modifying DevSpace itself or recovering a new ChatGPT session.

## Expected contract

- ChatGPT is the orchestrator/reviewer; local workers are bounded labor.
- Every task is anchored to one explicit canonical workspace root.
- `open_workspace` is called once per project/mode and its `workspaceId` is reused.
- First open initializes `.devspace/memory/context.md`, `progress.md`, and `next-steps.md` when no usable memory exists.
- `open_workspace` returns compact workspace memory and a content-derived revision.
- Project state is synchronized through `.devspace/memory`; transcripts are not synchronized.
- Workspace instructions are authoritative.
- Workers preserve provider sessions when continued.
- Existing provider sessions must not silently switch provider.
- First-turn recoverable capacity/quota failures may use configured fallback.
- `luna` means OpenAI API labor and is hard-locked to `gpt-5.6-luna`; `kimi` means the Kimi Code ACP backup provider.
- Automatic labor fallback is Luna ↔ Kimi only. It must not silently land on generic Codex/Sol/Terra or a future larger OpenAI worker model.
- Luna reasoning effort is brain-selected per run; the worker does not choose a higher model class.
- Default execution timeout is 600 seconds and wait timeout is non-destructive.
- Worker concurrency is bounded, and normal ChatGPT orchestration is serialized: once a worker is active, the host model does not perform repository exploration, edits, tests, or other project work concurrently. It collects the worker result first, then reviews and issues the next repository command.
- Parallel workers are only used when the user explicitly requests parallel execution; the host still waits rather than doing its own repository work concurrently.
- Review uses `inspect_worker` only when needed during an active run and one consolidated `show_changes` after final related edits.
- ChatGPT may freeze a custom app's action list at publication. If a published app exposes `bash` but not native worker actions, the sandbox-safe `devspace agents bridge <JSON>` command is the supported compatibility path. DevSpace intercepts it before shell execution and routes it to the same worker orchestrator; the ordinary local `devspace agents` CLI must not require workspace shells to read DevSpace private config/state.
- Worker IDs are workspace-bound. Native and bridge wait/inspect/continue/stop operations must reject a worker created by a different `workspaceId` rather than treating the worker ID as global authority.
- `show_changes` works with or without widgets and has a bounded non-Git fallback.
- Provider availability comes from the live runtime.
- A live Luna runtime may receive two additional workspace-scoped MCP servers: `devspace_browser` (official Playwright MCP using a dedicated Playwright-managed Chromium profile for the current workspace) and `devspace_xcode` (Xcode-native operations plus optional text-only Accessibility element inspection/actions gated to the front Xcode window for a document inside the current workspace). Their availability must be verified from the live runtime rather than inferred from source.

## Security contract

- Authorized project roots are exact control-plane authority boundaries.
- Extra paths require local scoped grants (`read` or `readwrite`).
- Provider-specific config access is separate from project grants.
- Remote workers cannot self-authorize new roots or provider credentials.
- The OpenAI Luna API key is stored in macOS Keychain via `devspace secret set openai-luna`, never in repo/config/memory/LaunchAgent or inherited workspace environment.
- macOS shells/workers are Seatbelt-confined by default.
- Remote workspace shells run the configured shell without login/startup RC files so sandboxed commands do not depend on home-directory reads or re-import user secrets.
- Child process environments are allowlisted instead of inheriting arbitrary parent secrets/sockets.
- Broad roots such as the home directory, Desktop root, `.codex`, and `.ssh` must not be granted for convenience.
- Luna browser automation must use Playwright-managed Chromium with a DevSpace-owned per-workspace profile. It must not attach to the user's normal Chrome profile, a Chrome extension, or an existing CDP session.
- Luna Xcode automation must revalidate every target against the active workspace root and must not reveal paths for an outside active Xcode project. `xcode_ui_*` may expose only a bounded text accessibility tree for the front Xcode window and element-targeted click/value operations; it must not expose coordinates or pixels.
- These project UI capabilities must not expose generic desktop/other-app window enumeration, screen captures, coordinate mouse control, generic keyboard control, clipboard access, Finder/System Settings control, Screen Recording, Full Disk Access, or unrelated browser/Xcode sessions. Native Xcode scripting may require Automation permission for Xcode, and `xcode_ui_*` may additionally require Accessibility; those OS permissions must not be generalized to other applications.
- The DevSpace development repo may be temporarily authorized while developing DevSpace. Remove it only after explicit user approval.

## Clawd contract

- Clawd is an independent trusted Slack operator that can select among project roots already authorized by DevSpace.
- Authorizing the Clawd repository allows DevSpace/ChatGPT to maintain Clawd; it does not limit Arthur to that repository.
- A Clawd Slack thread binds to one workspace and one consumed memory revision.
- Switching workspace must clear/rescope the old provider session.
- Clawd uses the same `.devspace/memory` protocol and only reloads compact memory when its revision changes.
- Global personal-preference memory remains separate from project memory.
- Clawd cannot silently broaden DevSpace authorization.

## Recovery checklist

After a DevSpace change, verify:

1. tool names and schemas still match the skill;
2. workspace open/reuse semantics still match;
3. first-use memory initialization still works and is review-invisible;
4. memory remains canonical-root isolated;
5. worker lifecycle/start/wait/inspect/continue/stop semantics still match, including the published-app shell bridge when native worker actions are frozen out of the host action list;
6. Luna/Kimi naming, Luna model lock/effort policy, fallback, session-continuity semantics, host/worker serialization, and any injected project UI MCP capabilities still match;
7. security sandbox/env/grant behavior still matches, including browser profile isolation and Xcode workspace-path gating;
8. `show_changes` behavior still matches;
9. Clawd workspace-memory assumptions still match;
10. README and repo skill backup reflect the implementation.

## Failure diagnosis order

1. ChatGPT connector/tool availability.
2. Running DevSpace service/runtime version.
3. CLI canonical path/build versus service path.
4. Authorized root/grant/provider-access configuration.
5. macOS sandbox or environment allowlist denial.
6. agent profile/provider availability.
7. provider executable/auth/session behavior.
8. target repository problem.

Preserve original errors. Do not weaken security boundaries to compensate for a stale build, wrong runtime path, missing binary, or provider quota issue.

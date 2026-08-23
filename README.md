# DevSpace — HowellYu fork recovery and operations manual

This repository is a customized DevSpace fork used as the local execution/control layer between ChatGPT and explicitly authorized projects on this Mac.

The intended operating model is:

```text
user
  |
  +-- ChatGPT session for project A ----+
  +-- ChatGPT session for project B ----+--> DevSpace --> exact authorized workspace
  +-- Arthur / Clawd in Slack ----------+       |
                                                +--> local workers (OpenAI Luna default, Kimi backup)
                                                +--> workspace memory
                                                +--> sandboxed shell/file operations
```

ChatGPT is normally the **brain/orchestrator/reviewer**. Local agents such as Luna are optional labor. Arthur/Clawd is a peer operator using the same authorized project set and the same workspace-memory protocol.

This README is deliberately operational and redundant. A fresh ChatGPT session should be able to recover the architecture, security assumptions, setup, and development workflow from this file plus the repo-backed Skill without relying on prior chat history.

---

## 1. Current fork purpose

Upstream DevSpace provides an MCP server that lets ChatGPT work against local project directories. This fork adds the pieces needed for a persistent multi-agent local development environment:

- native local worker lifecycle;
- OpenAI `gpt-5.6-luna` API worker support plus Kimi Code ACP backup;
- durable workspace-local memory shared across ChatGPT sessions and Clawd;
- execution deadlines and stale-worker recovery;
- provider fallback with session-continuity rules;
- worker concurrency limits;
- macOS Seatbelt process confinement;
- child environment allowlisting;
- exact authorized project roots;
- scoped additional filesystem grants;
- provider-specific configuration grants;
- consistent change review, including non-Git folders;
- LaunchAgent/service support;
- OAuth/CSRF/rate-limit hardening;
- recovery-oriented diagnostics;
- a repo backup of the ChatGPT Brain/Worker Skill.

The main fork branch is currently:

```text
feat/kimi-agent-layer
```

Important recent checkpoints include:

```text
cc39477  isolate child process environments
1f2df41  local scoped path authorization
59f339e  provider-specific access control
0d698dc  worker recovery and concurrency
46bcada  unified worker/change review
71854da  automatic workspace memory sync
42444c4  canonical linked CLI-path diagnostics
69f4618  initialize workspace memory automatically
```

Use `git log --oneline` rather than assuming this list is current.

---

## 2. Non-negotiable architecture

### 2.1 Workspace authority

A DevSpace project is an **exact authorized root**, not a general permission to explore neighboring directories.

Good:

```text
/Users/qianhaoyu/Desktop/Clawd
/Users/qianhaoyu/Desktop/utils/home-assistant
/Users/qianhaoyu/.codex/.chatgpt-projects/<exact-health-hub-project-id>
```

Bad:

```text
/Users/qianhaoyu
/Users/qianhaoyu/Desktop
/Users/qianhaoyu/Desktop/utils
/Users/qianhaoyu/.codex
```

Do not broaden a root merely because a tool wants a config file elsewhere. Use scoped grants or provider-access grants instead.

### 2.2 Control plane versus project data

DevSpace authentication/configuration/runtime is control-plane state. Project roots are data-plane authority.

The following should never become ordinary project roots:

- `~/.devspace/auth.json`;
- the whole home directory;
- `~/.ssh`;
- the whole `~/.codex` directory;
- cloud credential directories;
- Keychain databases;
- arbitrary Desktop/Documents parents.

The DevSpace source repo itself is temporarily authorized while this fork is under development. After development is declared complete, remove it from authorized roots **only after explicit user approval**.

### 2.3 Arthur / Clawd authority

Arthur is **not restricted to the Clawd repository**.

The correct rule is:

> Arthur may operate any project root already authorized by DevSpace.

Authorizing `/Users/qianhaoyu/Desktop/Clawd` means ChatGPT can maintain Clawd. It does not define Arthur's project universe.

Arthur discovers the current authorized roots through the local DevSpace control plane. Each Slack thread binds to one active workspace. A thread may continue in that workspace without rereading memory if its revision is unchanged. If a thread switches projects, the old provider session must be cleared/rescoped so one project's context cannot leak into another.

Arthur must not silently expand the DevSpace root list. New roots remain a local/user-owned control-plane decision.

---

## 3. Current workstation layout

The paths below are local-machine recovery information, not portable defaults.

```text
DevSpace source:
  /Users/qianhaoyu/Desktop/devspace

Clawd source:
  /Users/qianhaoyu/Desktop/Clawd

Health Hub source:
  /Users/qianhaoyu/.codex/.chatgpt-projects/g-p-6a6225b4a5ec81918d303a0eec7b3d0c

Home Assistant source:
  /Users/qianhaoyu/Desktop/utils/home-assistant
```

At the time this README section was written, the persisted authorized root list included:

```text
/Users/qianhaoyu/.codex/.chatgpt-projects/g-p-6a6225b4a5ec81918d303a0eec7b3d0c
/Users/qianhaoyu/Desktop/devspace
/Users/qianhaoyu/Desktop/Clawd
```

Home Assistant was known but was not yet necessarily in the persisted list. Always treat this section as historical guidance and check the live control plane:

```bash
devspace access list
```

Never infer authority from this README alone.

---

## 4. Workspace memory: shared state between GPT sessions and Clawd

Every canonical workspace gets local memory at:

```text
<workspace>/.devspace/memory/
```

On first usable workspace bootstrap, DevSpace automatically initializes:

```text
context.md
progress.md
next-steps.md
```

Optional/lazy files:

```text
decisions.md
handoff.md
```

DevSpace also generates a revision manifest (`index.json`) internally. Do not hand-edit the manifest.

### Memory semantics

- `context.md`: stable architecture/project facts.
- `progress.md`: current implementation state and completed milestones.
- `next-steps.md`: ordered pending work.
- `decisions.md`: durable decisions/rationale; load only when needed.
- `handoff.md`: optional semantic handoff when structured state is insufficient.

### What must never go into workspace memory

- transcripts;
- chain-of-thought;
- credentials;
- access tokens;
- owner passwords;
- raw logs;
- large command output;
- copied source files;
- transient Q&A.

Each memory file is capped (currently 32 KiB) and automatic bootstrap content is much smaller. The design goal is cheap continuation, not archival storage.

### Automatic synchronization model

```text
GPT session A ----+
GPT session B ----+--> <workspace>/.devspace/memory/ <-- Arthur / Clawd
GPT session C ----+
```

A new ChatGPT workspace open returns a compact `memoryBootstrap` and a content-derived `memoryRevision`.

Clawd stores the last consumed revision per Slack thread. If the revision is unchanged, project memory does not need to be reinjected. If another operator changed the project state, only the compact bootstrap is loaded.

Repository/source truth outranks stale memory. If memory and verified code disagree, correct memory.

### Local memory CLI

```bash
devspace memory bootstrap --workspace /absolute/project/root
devspace memory manifest  --workspace /absolute/project/root
devspace memory read progress.md --workspace /absolute/project/root
devspace memory put progress.md --workspace /absolute/project/root --content '<compact text>'
```

These commands operate only on authorized workspaces.

---

## 5. ChatGPT Brain/Worker Skill backup

The canonical repo backup is:

```text
skills/devspace-brain-worker/
  SKILL.md
  agents/openai.yaml
  references/devspace-contract.md
```

This source exists specifically so a future ChatGPT session can recover the expected DevSpace behavior even if the installed ChatGPT Skill is stale, unavailable, or read-only.

The installed Skill should be treated as a deployment artifact; the repo copy is the recoverable source of truth for this fork's workflow contract.

When DevSpace changes any of these surfaces, update the repo Skill in the same development phase:

- tool names/schemas;
- `open_workspace` behavior;
- workspace memory bootstrap/init;
- worker lifecycle;
- provider fallback/session behavior;
- review/checkpoint behavior;
- authorization/grants;
- sandbox/environment semantics;
- Clawd interop;
- checkout/worktree semantics.

---

## 6. Fresh ChatGPT setup — minimal-friction recovery

This is the procedure a completely new ChatGPT interface/session should follow.

### 6.1 Local machine prerequisites

Recommended:

- macOS for the hardened Seatbelt path used on this workstation;
- Node in the package-supported range;
- npm;
- Git;
- Bash-compatible shell;
- Tailscale if using the current public tunnel strategy;
- OpenAI API access for the default Luna worker;
- optional Kimi Code CLI for backup workers;
- any other local worker CLIs you intend to use.

Clone/build the fork if it is not already present:

```bash
git clone https://github.com/HowellYu/devspace.git
cd devspace
git switch feat/kimi-agent-layer
npm install --include=dev
npm run typecheck
npm test
npm run build
```

For the default OpenAI Luna worker, configure the API key after build with:

```bash
devspace secret set openai-luna
```

The native macOS Keychain prompt hides the key; it is not stored in the repository, DevSpace config, workspace memory, LaunchAgent environment, or normal child process environment. The Keychain item is identified by service/name `devspace` and account `OPENAI_DEVSPACE_KEY`.

Optional Kimi backup worker:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
kimi
```

Use the Kimi Code subscription/OAuth flow if the intent is to consume subscription quota rather than a separate metered platform API key.

### 6.2 Initialize DevSpace

```bash
node dist/cli.js init
```

or, when the linked `devspace` command points at this build:

```bash
devspace init
```

Setup creates persistent config under `~/.devspace`. Authentication secrets are intentionally outside project roots.

Inspect without exposing credentials:

```bash
devspace doctor
```

### 6.3 Configure exact project roots

Use local control-plane commands:

```bash
devspace access list
devspace access add /absolute/exact/project
devspace access remove /absolute/exact/project
```

Do not add broad parents for convenience.

Example desired project granularity:

```bash
devspace access add /Users/qianhaoyu/Desktop/Clawd
devspace access add /Users/qianhaoyu/Desktop/utils/home-assistant
devspace access add /Users/qianhaoyu/.codex/.chatgpt-projects/g-p-6a6225b4a5ec81918d303a0eec7b3d0c
```

The DevSpace repo may remain temporarily authorized during active DevSpace development. Before removing it, ask the user explicitly.

### 6.4 Additional filesystem grants

For a project that needs one external path:

```bash
devspace grants list
devspace grants add /exact/extra/path \
  --workspace /exact/project/root \
  --access read \
  --ttl 3600
devspace grants remove <grant-id>
```

Use `readwrite` only when the task truly needs writes.

These grants are local control-plane mutations. A remote worker must not silently grant itself more authority.

### 6.5 Provider config access

Provider config/credential exceptions are intentionally separate from project filesystem grants:

```bash
devspace provider-access list
devspace provider-access add <provider> /exact/provider/config/path --access read
devspace provider-access remove <id>
```

Never grant an entire provider root just to make one file available. Secret-bearing auth/token files are explicit user-owned decisions.

### 6.6 Runtime environment

Useful variables are documented in `.env.example`. Important current controls include:

```text
HOST=127.0.0.1
PORT=7676
DEVSPACE_PUBLIC_BASE_URL=...
DEVSPACE_TOOL_MODE=...
DEVSPACE_WIDGETS=changes
DEVSPACE_SUBAGENTS=1
KIMI_COMMAND=...       # optional backup worker; LUNA_COMMAND is a legacy alias
DEVSPACE_AGENTS_WAIT_TIMEOUT=300
DEVSPACE_AGENTS_EXECUTION_TIMEOUT=600
DEVSPACE_AGENTS_MAX_CONCURRENT=3
DEVSPACE_MACOS_SANDBOX=workspace
DEVSPACE_SANDBOX_NETWORK=1
```

Do not put persistent secrets into project `.env` files just because the example lists environment knobs.

### 6.7 Start the service

Development foreground:

```bash
scripts/serve.sh
```

or:

```bash
node dist/cli.js serve
```

macOS LaunchAgent:

```bash
devspace service install
```

Install without starting:

```bash
devspace service install --no-start
```

Validate:

```bash
devspace doctor
```

Do not run two servers against the same port.

### 6.8 Public connector

Local MCP endpoint:

```text
http://127.0.0.1:7676/mcp
```

A ChatGPT interface outside the Mac normally needs an HTTPS endpoint, e.g. a Tailscale/Cloudflare/ngrok-style tunnel:

```text
https://<public-host>/mcp
```

This workstation has used Tailscale Funnel. **Funnel is public Internet exposure**, not a tailnet-only ACL boundary. Authentication and DevSpace's own authorization remain essential.

If public access is not required, prefer a private exposure mechanism.

### 6.9 Add the connector/app in ChatGPT

The exact ChatGPT UI can change. Conceptually:

1. Add/connect the custom MCP/ChatGPT App endpoint at `https://<public-host>/mcp`.
2. Complete DevSpace's owner-password/OAuth approval flow.
3. Ensure the connector exposes the DevSpace tool set.
4. Install/use the `devspace-brain-worker` Skill from the repo-backed source/package.
5. Start one ChatGPT conversation per project/workspace.
6. In a new conversation, ask ChatGPT to work in the exact project path.
7. ChatGPT should invoke `open_workspace` once, receive `workspaceId` + memory bootstrap, and reuse the ID.

A fresh ChatGPT session should not need prior conversation history if:

- the connector is working;
- the project root is authorized;
- the repo Skill is installed/available;
- workspace memory has been maintained.

### 6.10 Expected first action in a new project conversation

```text
User: Work on Health Hub. <task>

ChatGPT:
1. load devspace-brain-worker Skill;
2. open exact Health Hub workspace;
3. consume memoryBootstrap;
4. read AGENTS/CLAUDE instructions if present;
5. execute/delegate bounded work;
6. review;
7. update project memory after meaningful state changes.
```

No manual “read the old chat” handoff should be necessary.

---

## 7. Worker model

Native worker lifecycle conceptually provides:

```text
start_worker
wait_worker
inspect_worker
continue_worker
stop_worker
```

ChatGPT freezes a custom app's action list when that app is published, so an older published DevSpace app can expose the generic workspace tools while omitting newer native worker actions. In that case use the sandbox-safe worker bridge through the existing `bash` action:

```text
devspace agents bridge {"op":"start","target":"luna-worker","prompt":"...","thinking":"medium"}
devspace agents bridge {"op":"wait","workerId":"<id>","timeoutSeconds":300}
devspace agents bridge {"op":"inspect","workerId":"<id>"}
devspace agents bridge {"op":"continue","workerId":"<id>","prompt":"..."}
devspace agents bridge {"op":"stop","workerId":"<id>"}
```

DevSpace parses that exact prefix before spawning a shell and routes the request to the same worker orchestrator as the native tools. This avoids granting the sandboxed workspace shell access to `~/.devspace` config or control-plane state. The ordinary `devspace agents ...` CLI remains a trusted-local-terminal/debugging interface, not the remote workspace-shell fallback.

### Execution timeout versus wait timeout

These are deliberately different:

- execution deadline: actual worker runtime budget; default 600 s;
- wait timeout: how long the caller blocks waiting; default 300 s.

A wait timeout must not stop the worker. An execution timeout terminates it and records `timed_out`.

### Concurrency

Default active-worker cap is currently 3.

Prefer one worker at a time unless parallelism is intentional. This workstation's preferred ChatGPT workflow is sequential because it improves review clarity and avoids needless provider/rate pressure.

### Fallback

Fallback is session-safe and model-class constrained:

- `luna` means OpenAI API labor and is hard-locked to `gpt-5.6-luna`;
- `kimi` means the Kimi Code ACP backup provider;
- automatic labor fallback is Luna ↔ Kimi only;
- first-turn provider capacity/quota/rate failures may switch between those labor providers when fallback is enabled;
- once a provider conversation/session exists, do not silently move it to another provider;
- auth/config/security errors should be surfaced, not hidden by switching providers;
- generic Codex/Sol/Terra or future larger OpenAI models are not automatic worker fallbacks.

---

## 8. OpenAI Luna / Kimi labor role

OpenAI Luna is the default labor layer; Kimi is the optional backup. Neither replaces ChatGPT as the supervising brain.

Recommended split:

```text
ChatGPT:
  architecture
  security decisions
  decomposition
  acceptance criteria
  code review
  final verification

OpenAI Luna (`gpt-5.6-luna` only):
  default repo exploration
  mechanical multi-file changes
  implementation loops
  test/fix loops

Kimi Code:
  backup labor when Luna is unavailable or intentionally selected
```

Use `luna-explorer` for bounded read-oriented investigation and `luna-worker` for implementation. DevSpace hard-locks those OpenAI Luna runs to `gpt-5.6-luna`. The supervising brain chooses reasoning effort per task: `low` for straightforward work, `medium` for normal implementation/debugging, `high` for difficult multi-file work, and `xhigh` only when justified. The worker cannot upgrade itself to Sol/Terra/another model.

Use `kimi-explorer` / `kimi-worker` when the Kimi backup path is desired. Check live provider availability for both.

When present in the live Luna runtime, DevSpace injects two narrowly scoped project UI servers. `devspace_browser` is official Playwright MCP running Playwright-managed Chromium with a persistent profile/output directory derived from the current workspace; it never attaches to the user's normal Chrome profile, Chrome extension, or existing CDP session, and image responses are omitted by default. `devspace_xcode` uses Xcode's native scripting interface and revalidates every Xcode document/file against the current workspace root before acting. An outside active Xcode project is reported only as unauthorized without exposing its path.

These are intentionally **not** generic computer-use tools. Luna receives no desktop/window enumeration, arbitrary screenshots, mouse/keyboard control, clipboard access, Finder/System Settings control, Screen Recording, Accessibility, Full Disk Access, or authority over unrelated browser/Xcode sessions.

Quota exhaustion is a provider-capacity condition, not a reason to weaken security or treat a stale worker as running forever.

---

## 9. Security implementation

### 9.1 macOS process sandbox

On macOS, workspace shell and detached worker processes are wrapped with Seatbelt (`sandbox-exec`) by default.

The sandbox is intended to deny arbitrary access outside authorized workspace/state/runtime paths while allowing enough metadata/runtime access for Node/macOS tooling to start.

`sandbox-exec` is deprecated by Apple, so this is risk reduction rather than a perfect long-term security primitive. For the strongest boundary, run DevSpace under a dedicated non-admin macOS user or inside a VM/container with explicit filesystem mounts.

### 9.2 Environment isolation

Workspace processes do not inherit arbitrary `process.env` secrets by default.

Do not automatically pass through:

- `SSH_AUTH_SOCK`;
- arbitrary API keys;
- AWS/GCP/Azure credentials;
- database URLs;
- unrelated service tokens.

Only explicitly required operational/provider variables should cross into a child process.

### 9.3 Git under confinement

A sandboxed Git command may fail with:

```text
fatal: unable to access '/Users/qianhaoyu/.gitconfig': Operation not permitted
```

For commands that do not require the user's global Git config, use:

```bash
GIT_CONFIG_GLOBAL=/dev/null git status
GIT_CONFIG_GLOBAL=/dev/null git diff
GIT_CONFIG_GLOBAL=/dev/null git log --oneline
```

Do not grant the whole home directory merely to silence Git.

If commit identity or other explicitly needed Git configuration is required, solve it narrowly rather than broadening the workspace boundary.

### 9.4 Authentication is not filesystem authorization

Owner password/OAuth answers **who may connect**.

Authorized roots/grants/sandbox answer **what a connected process may touch**.

Do not treat a strong password as a filesystem sandbox.

### 9.5 DevSpace source self-modification risk

While `/Users/qianhaoyu/Desktop/devspace` is an authorized root, a remotely authenticated coding session can modify this source tree. Depending on the installed service path and restart behavior, a later restart can execute modified code.

Therefore the final deployment step is:

1. finish development;
2. verify/install the intended runtime;
3. confirm control-plane files/runtime are outside remotely writable project authority;
4. ask the user for explicit permission;
5. remove `/Users/qianhaoyu/Desktop/devspace` from authorized roots.

Never perform step 5 implicitly.

---

## 10. Change review

`show_changes` is a core review surface and should remain available even when visual widgets are disabled.

Git workspaces use durable Git/checkpoint behavior.

Non-Git folders use a bounded filesystem snapshot fallback that skips common dependency/build trees and symlinks, hashes files, and produces bounded text previews.

Automatic `.devspace/memory` initialization should be treated as workspace infrastructure, not user code. Its initialization must be part of the review baseline so it does not appear as a meaningful source change.

Call `show_changes` once after the final related edit, not after every file mutation.

---

## 11. Clawd integration

Clawd source:

```text
/Users/qianhaoyu/Desktop/Clawd
```

Arthur's intended project-memory behavior:

1. read `devspace access list` locally;
2. resolve the target workspace from the Slack request/current thread binding;
3. bind the Slack thread to one canonical workspace;
4. compare the workspace memory revision with the thread's last consumed revision;
5. inject compact memory only when changed;
6. run Codex with the selected workspace as `cwd`;
7. keep project memory updates hidden from Slack and persist them through DevSpace;
8. keep global personal-preference memory separate;
9. clear the old provider session when switching projects.

Arthur's access set is the DevSpace authorized root set, not `config.root == Clawd`.

This distinction matters:

```text
Clawd repo authorization:
  allows ChatGPT/DevSpace to maintain Arthur's code

DevSpace authorized root list:
  defines which projects Arthur may operate
```

The two concepts must not be conflated.

---

## 12. Known sensitive projects

### Health Hub

Source root:

```text
/Users/qianhaoyu/.codex/.chatgpt-projects/g-p-6a6225b4a5ec81918d303a0eec7b3d0c
```

Do not authorize the parent `~/.codex` directory.

Health/runtime databases such as `~/.health-hub` or WHOOP state are separate sensitive resources. Use narrow task-specific grants if they are ever needed.

### Home Assistant

Source root:

```text
/Users/qianhaoyu/Desktop/utils/home-assistant
```

Editing source/config and controlling the physical home are not the same privilege. Avoid turning repository write access into automatic live-device/Docker/SSH/camera authority.

### Clawd

Source root:

```text
/Users/qianhaoyu/Desktop/Clawd
```

Normal engineering access is appropriate when authorized. Arthur's own private Slack/message/memory runtime content remains subject to Clawd's privacy rules; Kimi infrastructure maintenance must not receive prohibited private content.

---

## 13. Diagnostics

Start with:

```bash
devspace doctor
```

Then inspect the failing layer in this order:

1. ChatGPT connector/tool availability;
2. running DevSpace service/runtime;
3. CLI path/build versus service path;
4. authorization/grants/provider-access;
5. sandbox/environment denials;
6. agent profile/provider availability;
7. provider executable/auth/session;
8. target repository problem.

Do not patch provider code because the wrong DevSpace build is running.

### CLI path note

A globally linked `devspace` command can resolve through symlinks back to this repo. `doctor` compares canonical real paths so a valid npm-link/symlink chain should not be reported as a mismatch.

---

## 14. Local development

Install:

```bash
npm install --include=dev
```

Fast checks:

```bash
npm run typecheck
```

Targeted tests:

```bash
npx tsx --test src/<relevant>.test.ts
```

Full verification:

```bash
npm test
npm run build
```

Build also restores executable permission on `dist/cli.js`.

When the sandbox blocks Git's global config for inspection:

```bash
GIT_CONFIG_GLOBAL=/dev/null git status --short
GIT_CONFIG_GLOBAL=/dev/null git diff --check
```

Keep unrelated local files untouched. Historically there have been local untracked `.agents/plan/*` files that are not part of normal feature commits.

---

## 15. Service operation

A macOS LaunchAgent can keep DevSpace running.

Typical commands:

```bash
devspace service install
devspace service install --no-start
devspace service uninstall
```

Before changing service state, check whether another foreground server already owns the configured port.

Do not start two copies on `127.0.0.1:7676`.

After a rebuild/reload:

```bash
devspace doctor
```

Verify local health before assuming public tunnel failure.

---

## 16. Public exposure / Tailscale

This installation has used Tailscale Funnel.

Important distinction:

```text
Tailscale Serve  -> tailnet/private-oriented exposure
Tailscale Funnel -> public Internet exposure
```

Do not assume tailnet ACLs restrict public Funnel visitors.

If Funnel remains enabled, rely on DevSpace authentication plus exact authorization/sandboxing and keep the control-plane runtime outside ordinary remote-writable roots after development.

For `*.ts.net` public URLs, DevSpace now verifies Funnel through the public DNS/ingress addresses instead of trusting same-node tailnet resolution. The Funnel watchdog is enabled by default for those URLs: after three consecutive public health/MCP discovery failures it may reassert the already-existing mapping to this DevSpace port. A full Funnel reset is attempted only when the current Tailscale configuration contains exactly one simple mapping for this DevSpace endpoint; unrelated Funnel mappings are never reset. Set `DEVSPACE_TAILSCALE_FUNNEL_WATCH=0` to disable this behavior. On macOS DevSpace prefers the CLI bundled with `/Applications/Tailscale.app` so diagnostics and recovery use the same build as the running Network Extension rather than a mismatched Homebrew CLI.

---

## 17. Rate and token efficiency

The system is designed to conserve expensive host-model turns:

- one ChatGPT conversation per workspace;
- compact automatic memory instead of transcript replay;
- lazy memory revision loading;
- Luna/local workers for traversal/mechanical work when useful;
- meaningful review checkpoints instead of constant polling;
- worker wait calls instead of status loops;
- sequential work by default;
- provider fallback only where session semantics are safe.

Do not use a local worker just because one exists. For a one-file obvious change, worker setup can cost more than the work.

Do not ask a cheap model to summarize every exchange merely to maintain project memory. Persist state at meaningful milestones.

---

## 18. Development completion checklist

Before declaring this fork complete:

- [ ] exact authorized-root behavior verified;
- [ ] scoped grants verified;
- [ ] provider-access verified;
- [ ] macOS sandbox regression tests green;
- [ ] child environment isolation tests green;
- [ ] worker timeout/stale reconciliation green;
- [ ] provider fallback/session continuity green;
- [ ] concurrency limits green;
- [ ] Git and non-Git review green;
- [ ] automatic first-workspace memory init green;
- [ ] cross-workspace memory isolation green;
- [ ] Clawd consumes any authorized workspace, not only itself;
- [ ] Clawd workspace switching clears old provider session;
- [ ] Clawd project-memory sync is revision-aware and token-bounded;
- [ ] repo-backed Brain/Worker Skill matches implementation;
- [ ] README matches implementation;
- [ ] full `npm test` green;
- [ ] `npm run build` green;
- [ ] intended service runtime path verified;
- [ ] user explicitly approves removal of the DevSpace development root;
- [ ] `/Users/qianhaoyu/Desktop/devspace` removed from remote authorization only after approval.

---

## 19. Recovering from a completely fresh ChatGPT conversation

If a future ChatGPT session knows nothing except this repository:

1. Read `README.md`.
2. Read `skills/devspace-brain-worker/SKILL.md`.
3. Read `skills/devspace-brain-worker/references/devspace-contract.md` if modifying DevSpace or diagnosing workflow drift.
4. Run `devspace doctor` through the available local/DevSpace shell.
5. Run `devspace access list` locally; do not assume README root state is current.
6. Open the target project with `open_workspace` exactly once.
7. Consume `memoryBootstrap`.
8. Read workspace `AGENTS.md`/`CLAUDE.md` instructions.
9. Continue from `progress.md` and `next-steps.md`.
10. Use workers only when they reduce traversal/mechanical work.
11. Review all worker changes.
12. Update workspace memory after meaningful milestones.
13. Never silently broaden access or remove the DevSpace root.

This is the intended zero-history recovery path.

---

## 20. Upstream

Original project/upstream:

```text
https://github.com/Waishnav/devspace
```

Fork/origin:

```text
https://github.com/HowellYu/devspace
```

To refresh against upstream, first inspect the current branch and local changes. A typical maintenance sequence is:

```bash
git fetch upstream
git switch feat/kimi-agent-layer
git rebase upstream/main
npm install
npm run typecheck
npm test
npm run build
```

Do not force-push or rewrite history unless explicitly intended and reviewed.

---

## 21. Final mental model

```text
Authentication
  answers: who connected?

Authorized roots + scoped grants + provider-access
  answer: what project/resources may this session use?

Seatbelt + environment isolation
  reduce: what can spawned code escape to?

Workspace memory
  answers: what durable project state should the next GPT/Clawd session know?

Workers
  answer: who does the repetitive local labor?

ChatGPT
  owns: architecture, judgment, review, security, and final acceptance.

Clawd
  owns: persistent Slack operation across the same authorized workspaces.
```

If a proposed change collapses these boundaries—for example by using one broad home-directory root, synchronizing raw transcripts, letting a worker self-authorize, or treating Slack trust as permission to read the entire Mac—it is moving the architecture in the wrong direction.

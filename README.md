<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

---

> ## ⚠️ This is the Luna fork — read this section first
>
> This fork (`HowellYu/devspace`, branch `feat/kimi-agent-layer`) turns DevSpace
> into a two-tier agentic layer: **ChatGPT is the brain** (design, specs,
> review) and **Luna is the worker** (implementation, exploration, test-fix
> loops). ChatGPT's scarce rate limit is spent on a few high-value turns;
> Luna does the heavy local work on the flat Kimi Code subscription quota.
>
> ### What the fork adds over upstream
>
> - **Reliable ACP session resume** — follow-up runs use `session/load`, so
>   workers keep their conversation context. A failed load aborts loudly
>   instead of silently starting over.
> - **`luna` subagent provider** — runs the Kimi Code CLI (`kimi acp`) through
>   the generic ACP adapter. Binary override: `LUNA_COMMAND`.
> - **`devspace agents wait <id>`** — blocking completion; one start + one wait
>   instead of polling `agents show`.
> - **`luna-worker` / `luna-explorer` example profiles** (`examples/agents/`).
> - **`DEVSPACE_PI_TIMEOUT_MS`** — configurable pi timeout (fallback worker path).
> - Docs: brain/worker playbook in `docs/chatgpt-coding-workflow.md`.
>
> ### Install
>
> Prerequisites: Node `>=22.19 <27`, Git, Bash, Tailscale (for the tunnel),
> and a Kimi membership that includes Kimi Code (Moderato or higher).
>
> ```bash
> # 1. The fork (this is what you run for the Luna workflow)
> git clone git@github.com:HowellYu/devspace.git
> cd devspace
> git switch feat/kimi-agent-layer
> npm install --include=dev
> npm run build
>
> # 2. Kimi Code CLI (the Luna worker binary)
> curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
> kimi            # then: /login  → choose "Kimi Code OAuth" (subscription)
> ```
>
> **Login matters:** choose **Kimi Code OAuth**, not a Moonshot Open Platform
> API key. OAuth draws from your flat weekly plan quota (`kimi-for-coding`);
> a platform API key bills per token separately. Confirm with `/usage` in the
> CLI. The binary lands in `~/.kimi-code/bin/kimi` — add it to PATH or set
> `LUNA_COMMAND` (below).
>
> ### Configure
>
> ```bash
> # 3. Install the Luna profiles (global, or .devspace/agents/ per project)
> mkdir -p ~/.devspace/agents
> cp examples/agents/luna-worker.md examples/agents/luna-explorer.md ~/.devspace/agents/
>
> # 4. Server environment
> export DEVSPACE_SUBAGENTS=1
> export DEVSPACE_WIDGETS=changes
> export DEVSPACE_TOOL_MODE=minimal
> export LUNA_COMMAND="$HOME/.kimi-code/bin/kimi"
>
> # 5. First-time setup (allowed roots, port, public tunnel URL)
> node dist/cli.js init
> ```
>
> ### Run
>
> ```bash
> scripts/serve.sh     # sets the env below, then serves http://127.0.0.1:7676/mcp
> ```
>
> The launcher exports `DEVSPACE_WIDGETS=changes`, `DEVSPACE_TOOL_MODE=minimal`,
> and `LUNA_COMMAND=~/.kimi-code/bin/kimi` (override any of them by exporting
> first), and fails fast with a clear error if the build or the Luna CLI is
> missing — including typo'd paths like the classic `kimi~`. To run by hand
> instead, export the same three variables and run `node dist/cli.js serve`.
> The server runs in the foreground; keep the terminal open.
>
> Expose it through your Tailscale Funnel as before and point the ChatGPT
> connector at `https://<your-tailscale-host>/mcp`. The owner-password
> approval flow is unchanged. (The released npm package
> `@waishnav/devspace` still works as a stable fallback without Luna.)
>
> ### Daily workflow (ChatGPT side)
>
> 1. `open_workspace` a project inside an allowed root.
> 2. Write a self-contained spec and delegate:
>    `devspace agents run luna-worker "<goal / context / files / acceptance criteria>"`
> 3. Wait once: `devspace agents wait <id> --timeout 300`.
> 4. Review the consolidated checkpoint diff (`show_changes`), not the repo.
> 5. Corrections go back to the **same** session:
>    `devspace agents run <id> "<review findings>"` — Luna resumes, never restarts.
>
> Use `luna-explorer` for read-only investigations. Its read-only behavior is
> instruction-level, not sandboxed — see the security notes in
> `docs/chatgpt-coding-workflow.md` (dedicated OS user recommended).
>
> ### Maintaining the fork
>
> ```bash
> git fetch upstream
> git switch feat/kimi-agent-layer
> git rebase upstream/main
> npm install && npm run typecheck && npm test && npm run build
> git push --force-with-lease origin feat/kimi-agent-layer
> ```
>
> One branch, one concern — keep unrelated changes off it. The full plan and
> acceptance criteria live in `.agents/plan/` (local, untracked working docs).
>
> ---

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

## Sponsors and Special Thanks

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>

<p>
  DevSpace is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

DevSpace requires Node `>=22.19 <27`.

Install the DevSpace CLI:

```bash
npm install -g @waishnav/devspace
```

Then initialize and start the server:

```bash
devspace init
devspace serve
```

Or run it without a global install:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

During setup, DevSpace asks for:

- the local project folders ChatGPT is allowed to open through DevSpace
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or
  another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Documentation

- [Setup Guide](https://github.com/Waishnav/devspace/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/devspace/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/devspace/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/devspace/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and Artifacts is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on DevSpace itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

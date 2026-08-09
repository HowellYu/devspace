# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Project Memory

Project memory is stored inside the workspace at `.devspace/memory/` (for example, `<workspace>/.devspace/memory/`). It is scoped to the canonical project root and shared by checkout and worktree modes for the same project. DevSpace creates `.devspace/.gitignore` with `memory/` so memory files are ignored from version control by default; if you already have a `.devspace/.gitignore`, add `memory/` there to keep memory local.

Use memory only for durable project facts, decisions, and checkpoints. Do not store secrets, credentials, owner passwords, or transient chain-of-thought in memory files. Memory file names are validated to prevent hidden files, path separators, and traversal.

## Subagents and ACP Providers

When subagents are enabled (`DEVSPACE_SUBAGENTS=1`), DevSpace can delegate tasks
to local providers such as `luna`, `codex`, or `claude`. On macOS, DevSpace now
wraps workspace shell sessions and detached worker processes with Seatbelt
(`sandbox-exec`) by default. The policy blocks reads under other user/volume
paths and blocks writes globally except the current workspace, DevSpace state,
temporary storage, and explicitly approved scoped path grants. Network access is
allowed by default because model providers and common development commands need
it; set `DEVSPACE_SANDBOX_NETWORK=0` to deny it.

Seatbelt is a substantial reduction in local authority, but it is not equivalent
to a container, VM, or separate operating-system account. Provider authentication
may require narrowly scoped read access to provider installation/config paths,
and permissions inherited by provider child processes cannot be made stronger
than the parent Seatbelt profile. `sandbox-exec` is also deprecated by Apple and
may change in future macOS releases.

ACP connectors may auto-approve tool requests within the delegated session. That
auto-approval is a convenience inside the worker, not a security boundary. For
the strongest isolation, run DevSpace as a dedicated, non-administrator OS user
with filesystem permissions only for the intended projects and DevSpace state.
Do not run DevSpace as root or an administrator.

Review subagent output before acting on it, and keep subagent profiles narrow.
Each worker run has a separate execution deadline (600 seconds by default,
configurable up to 7200 seconds). Overlong workers are terminated and recorded as
`timed_out`; inspection/wait also reconcile persisted running workers against the
recorded process id so vanished workers do not remain `running` indefinitely.

Remote shell sessions and subagent processes also use a default-deny child
environment. DevSpace forwards only basic process metadata (`PATH`, home/temp,
locale, shell/user), explicitly supported DevSpace operational variables, and
provider executable-path overrides when needed. It does **not** implicitly
forward `SSH_AUTH_SOCK`, cloud credentials, API keys, database URLs, or arbitrary
parent-process environment variables. A provider that genuinely requires a
credential must receive it through an explicit provider credential mechanism rather
than widening the global child environment.

## Project authorization and scoped grants

Persisted project authorization is a local control-plane action (`devspace access`).
It is intentionally not exposed through MCP, and it changes only the persisted
`allowedRoots` configuration, never `auth.json`. DevSpace rejects broad or
security-sensitive roots such as the home directory, Desktop root, system trees,
`~/.devspace`, and exact `~/.codex`.

Additional filesystem access for an already-authorized project uses `devspace
grants`. Grant records and their audit log live under `DEVSPACE_STATE_DIR`, outside
the project, so a remotely writable workspace cannot edit its own grant state.
Grants are scoped to the canonical project root, can be `read` or `readwrite`,
can expire, and are shared by managed worktrees for that project. Revocation is
consumed dynamically by file tools and new process/worker sandboxes.

Generic grants reject DevSpace control-plane paths, SSH/cloud credential trees,
system directories, broad home roots, and `~/.codex`. Provider credentials are a
separate security surface rather than an excuse to grant an entire credential
directory. A remote MCP session cannot create, approve, or revoke path grants.

Provider-specific configuration exceptions use the local-only `devspace
provider-access` control plane. Entries are bound to one provider and must name
a file or subdirectory inside that provider's known configuration tree; the
provider root itself cannot be granted wholesale. These entries feed only that
provider worker's Seatbelt profile and are never generic workspace roots. Prefer
read-only access and treat secret-bearing files such as provider auth databases
or token files as explicit user-owned credential decisions.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

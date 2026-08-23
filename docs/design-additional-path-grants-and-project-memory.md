# Design: Scoped Path Grants and Persistent Project Memory

Status: implemented.

This document records the implemented security model for additional filesystem
access and project memory. The original proposal used project-local grant files
and MCP approval tools; that design was intentionally replaced with a stricter
local-control-plane model.

---

## 1. Explicit additional-path grants

### Security goal

An authenticated remote workspace must not be able to broaden its own filesystem
authority. Global project authorization and extra-path grants therefore remain
local administrative operations rather than MCP tools.

### Whole-project authorization

Use the local CLI:

```bash
devspace access list
devspace access add /absolute/project/root
devspace access remove /absolute/project/root
```

`devspace access` updates only `allowedRoots` in the persisted DevSpace config.
It does not read or modify `auth.json`. New project roots must exist, are
canonicalized, and broad/security-sensitive roots are rejected (for example the
home directory, Desktop root, system trees, DevSpace control-plane directories,
and exact `~/.codex`).

A running server must be restarted/reloaded before a changed global root list is
used.

### Scoped grants for an authorized project

Use the local CLI:

```bash
devspace grants list --workspace /absolute/project/root

devspace grants add /absolute/reference/path \
  --workspace /absolute/project/root \
  --access read --ttl 3600 --reason "reference data"

devspace grants add /absolute/output/path \
  --workspace /absolute/project/root \
  --access readwrite --persistent

devspace grants remove grant_0123456789
```

Grant properties:

- exact existing directory, canonicalized with realpath;
- `read` or `readwrite`;
- temporary (one hour by default, configurable up to 30 days) or persistent;
- scoped to the canonical source project so managed worktrees share the same
  grant;
- stored under `DEVSPACE_STATE_DIR/path-grants.json` with mode `0600`;
- mutations are recorded in `DEVSPACE_STATE_DIR/path-grants.log`;
- grant state is outside the project repository and cannot be edited by the
  remotely writable workspace;
- revocation is picked up dynamically by workspace file tools; new shell/worker
  process sandboxes consume the current active grant set.

Generic grants reject broad/system/control-plane/credential paths including `/`,
the home/Desktop/Documents/Downloads roots, system trees, DevSpace state/config,
`~/.ssh`, `~/.gnupg`, common cloud credential directories, and `~/.codex`.
Provider authentication/configuration uses a separate narrow mechanism rather
than generic grants.

### Process enforcement

Both MCP process surfaces use the same security boundary:

- Codex-style `exec_command` / PTY sessions;
- normal/minimal/full `bash` tools.

On macOS they use the Seatbelt workspace policy plus the active project grants.
They also use the default-deny child environment, so arbitrary parent-process
credentials are not inherited.

Detached subagents store the project grant-scope root in their session record.
That keeps checkout/worktree semantics stable across worker subprocesses and
resumed sessions.

### Why there is no MCP approval tool

A two-tool `request/approve` MCP flow still leaves an authorization surface inside
the remotely reachable service and complicates the trust boundary. The current
model deliberately requires a local administrative actor (the user, or a trusted
local steward such as Clawd operating outside the DevSpace sandbox) to run the
CLI. A remote worker may report that it needs a path, but it cannot grant itself
that path.

---

## 2. Persistent per-project memory

Project memory is implemented under the canonical project itself:

```text
<canonical-project>/.devspace/memory/
```

The memory namespace is shared by checkout and managed worktree sessions for the
same project. The implementation retains a non-destructive legacy fallback from
the prior global namespace and migrates legacy content on write. Existing legacy
data is not deleted automatically.

For Git workspaces, DevSpace hides `.devspace/` through the repository-local `.git/info/exclude` so automatic memory initialization never dirties source status or requires a tracked ignore change. For non-Git workspaces it falls back to `.devspace/.gitignore` containing `memory/` and never overwrites an existing file.

Available MCP operations are:

- `read_project_memory`
- `write_project_memory`
- `list_project_memory`

Memory filenames are constrained markdown names with traversal/hidden-file
protection. Memory is intended only for durable project facts, decisions,
checkpoints, and next steps; secrets, credentials, or private chain-of-thought do
not belong there.

`open_workspace` exposes the stable memory namespace and existing memory files so
a brain/worker workflow can recover durable project context across ChatGPT
sessions.

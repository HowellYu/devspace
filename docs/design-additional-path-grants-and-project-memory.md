# Design: Explicit Additional-Path Grants and Persistent Project Memory

Status: proposal — not implemented.

This doc sketches two small, self-contained features that prepare DevSpace for
a brain/worker workflow without weakening security. Each section states the
problem, the concrete change, the files involved, and the open decisions.

---

## 1. Explicit user-approved additional-path grant flow

### Problem

`allowedRoots` is configured once during `devspace init` and stored in
`~/.devspace/config.json`. When a tool call asks for a path outside those roots,
`src/roots.ts` throws `AccessDeniedError` and the request fails. There is no
safe, inspectable way for the host to ask the user to approve a one-off or
persisted additional root at runtime.

### Goal

Add a runtime grant flow so the host can request access to a path, the user
must explicitly approve it, and the grant is recorded. No sudo/root. No silent
broadening of `DEVSPACE_ALLOWED_ROOTS`.

### Concrete design

1. **Structured denial response**
   - Update `assertAllowedPath` in `src/roots.ts` so callers can distinguish a
     containment failure from other errors. Keep the existing error message for
     backward compatibility, but add a public helper:
     ```ts
     export interface PathGrantRequest {
       path: string;
       requestedRoot: string;
       isTransient?: boolean;
     }
     ```
   - Tool handlers that hit containment errors return a result shape such as
     `{ granted: false, grantRequired: { path, requestedRoot } }` instead of
     only throwing, when the protocol supports it. The minimal first cut can
     keep throwing and let a dedicated tool surface the request.

2. **New tool: `request_additional_root`**
   - Input: `{ path: string, reason?: string, persist?: boolean }`.
   - Validation:
     - `path` must be absolute and must exist as a directory.
     - It must not be a parent of an already-allowed root (redundant).
     - It must not be `/` or a system path on a blocklist (`/etc`, `/private/var`,
       etc.). The exact blocklist is the main open decision.
   - Approval surface:
     - If stdin is a TTY, `devspace` prompts with `[y/N]` and prints the reason.
     - In MCP mode, the tool returns a widget (or a structured grant request)
       and waits for the user to approve via the host. The current server does
     not support async tool continuation, so the first implementation would
       return a request token and a companion tool `approve_additional_root`
       would record the grant.
   - On approval, the root is added to the active workspace state. If
     `persist: true`, it is also written to the project-level file
     `<workspaceRoot>/.devspace/roots.json`.

3. **Where grants live**
   - **Session grants**: stored on the in-memory `Workspace` object (or the
     existing `workspace_sessions` row as JSON) and discarded when the session
     ends.
   - **Persisted grants**: stored in `<workspaceRoot>/.devspace/roots.json`,
     committed to the repo by default. This makes the grant visible and
     reviewable, and it survives server restarts. If the user does not want it
     in version control, they can add `.devspace/` to `.gitignore`; DevSpace
     reads it regardless.

4. **Containment check update**
   - `src/roots.ts`: `assertAllowedPath` accepts an optional `additionalRoots`
     array. `src/workspaces.ts` feeds it the union of global allowed roots,
     session grants, and persisted project grants.

5. **Audit and revocation**
   - Log every grant to `~/.devspace/grants.log`:
     ```text
     2026-08-08T03:00:00Z GRANT /Users/qianhaoyu/.cargo persisted workspace=/Users/qianhaoyu/work/myproj
     ```
   - CLI additions:
     ```bash
     devspace config roots ls
     devspace config roots add <path>   # explicit offline addition
     devspace config roots rm <path>
     ```

### Files touched

- `src/roots.ts` — grant request type, blocklist, additional-roots parameter.
- `src/workspaces.ts` — load/surface project roots, hold session grants.
- `src/server.ts` — register `request_additional_root` and
  `approve_additional_root` tools (or widget equivalent).
- `src/ui/` — approval widget, if widgets are enabled.
- `docs/configuration.md` and `.env.example` — document runtime grants.

### Open decisions

- Approval UX in MCP: sync prompt only works for local CLI; async host approval
  needs either a widget or a two-tool request/approve pattern.
- Blocklist for grantable paths: start conservative (`/`, `/System`, `/etc`,
  `/private`, `/usr`, `~/.ssh`, `~/.devspace/auth.json` parent) and expand only
  when a real use case appears.
- Should persisted project grants be committed to the repo? Default yes, with
  documentation so users can opt out.

### Why not implement now

It touches the MCP tool surface, workspace lifecycle, UI widgets, and the
security boundary. That is larger than the requested `--no-start` change and
needs an explicit product decision on the approval UX.

---

## 2. Persistent per-project memory for `devspace-brain-worker`

### Problem

`devspace-brain-worker` (the Luna/Kimi worker skill) has no durable project
context across sessions. Everything it learns is lost when the MCP session ends.
The existing `workspace_sessions` table tracks sessions, but there is no place
for small project facts, owner preferences, or the last review summary to live.

### Goal

Give each project a small, scoped key-value store that survives server restarts
and can be read/written by the worker skill. Keep it local, inspectable, and
free of secrets.

### Concrete design

1. **Storage**
   - Add a new table to the existing SQLite state:
     ```sql
     create table project_memory (
       workspace_root text not null,
       scope text not null,           -- 'project' | 'session'
       key text not null,
       value text not null,
       tags_json text,
       created_at text not null,
       updated_at text not null,
       primary key (workspace_root, scope, key)
     );
     create index project_memory_lookup_idx
       on project_memory(workspace_root, scope, key, updated_at desc);
     ```
   - Reuse `src/db/schema.ts` and `src/db/migrations.ts` (migration version 5).
   - Store is under `DEVSPACE_STATE_DIR` (`~/.local/share/devspace`), so it is
     not accidentally committed and it is scoped to the local machine.

2. **Tools**
   - `remember_project_memory({ key, value, scope?, tags? })`
   - `recall_project_memory({ key?, tags?, limit? })`
   - `forget_project_memory({ key, scope? })`
   - All calls are scoped to the current workspace root. `scope` defaults to
     `'project'`. `session` entries are automatically cleaned up when the
     workspace session is closed or after a TTL.

3. **Security**
   - Reject writes that contain known secret patterns
     (`DEVSPACE_OAUTH_OWNER_TOKEN`, `ownerToken`, etc.).
   - Only write for the active workspace root; the tool handler passes the
     root from the workspace, never from the caller.
   - User can inspect or wipe via CLI:
     ```bash
     devspace memory show <key>
     devspace memory ls
     devspace memory rm <key>
     ```

4. **Skill consumption**
   - The `devspace-brain-worker` skill's `SKILL.md` documents a stable key
     convention, for example:
     - `project:context` — one-sentence summary of what the project does.
     - `owner:preferences` — style/taste notes from previous reviews.
     - `last:review:summary` — what the last review concluded.
   - The worker reads these keys at the start of a task and writes updates at
     the end.

### Files touched

- `src/db/schema.ts` — new `projectMemory` table and types.
- `src/db/migrations.ts` — migration version 5.
- `src/db/client.ts` — no change needed; migration runs automatically.
- `src/server.ts` — register memory tools when tool mode permits.
- `src/ui/` — optional widgets to render memory entries.
- `skills/subagent-delegation/SKILL.md` or a new skill — document keys.
- `docs/configuration.md` — document memory tools and TTL env vars.

### Open decisions

- Whether `session` memory needs a TTL or is tied to workspace session lifecycle.
- Whether to expose memory to the ChatGPT brain as well, or only to workers.
- Key naming convention: should DevSpace reserve a prefix (e.g., `devspace:`)?

### Why not implement now

It adds a database migration, new MCP tools, and a skill contract. The schema and
interface are small, but changing them later is harder than changing a CLI flag,
so the contract should be reviewed before code is written.

---

## Relationship to this change set

Neither feature is implemented here. The `--no-start` service-install flag is
independent and shipped first. These two designs are ready to be picked up as
separate, scoped follow-ups.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped" | "timed_out";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  grantScopeRoot?: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  workerPid?: number;
  executionTimeoutSeconds?: number;
  fallbackEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  grantScopeRoot?: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  workerPid?: number;
  executionTimeoutSeconds?: number;
  fallbackEnabled?: boolean;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  grant_scope_root: string | null;
  profile_name: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  worker_pid: number | null;
  execution_timeout_seconds: number | null;
  fallback_enabled: number;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      grantScopeRoot: input.grantScopeRoot ? resolve(input.grantScopeRoot) : undefined,
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      workerPid: input.workerPid,
      executionTimeoutSeconds: input.executionTimeoutSeconds,
      fallbackEnabled: input.fallbackEnabled ?? false,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          grant_scope_root,
          profile_name,
          provider,
          model,
          thinking,
          status,
          worker_pid,
          execution_timeout_seconds,
          fallback_enabled,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.grantScopeRoot ?? null,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        record.status,
        record.workerPid ?? null,
        record.executionTimeoutSeconds ?? null,
        record.fallbackEnabled ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  get(idOrPrefix: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ? or provider_session_id = ?
         limit 1`,
      )
      .get(idOrPrefix, idOrPrefix) as LocalAgentRow | undefined;
    if (exact) return rowToLocalAgentRecord(exact);

    const matches = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id like ? escape '\\' or provider_session_id like ? escape '\\'
         order by updated_at desc`,
      )
      .all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`) as LocalAgentRow[];

    return matches.length === 1 ? rowToLocalAgentRecord(matches[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          grant_scope_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          thinking = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          worker_pid = ?,
          execution_timeout_seconds = ?,
          fallback_enabled = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.grantScopeRoot ? resolve(updated.grantScopeRoot) : null,
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.thinking ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.workerPid ?? null,
        updated.executionTimeoutSeconds ?? null,
        updated.fallbackEnabled ? 1 : 0,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  close(): void {
    this.database.close();
  }

  private getById(id: string): LocalAgentRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_sessions where id = ?")
      .get(id) as LocalAgentRow | undefined;
    return row ? rowToLocalAgentRecord(row) : undefined;
  }
}

export function createLocalAgentStore(config: ServerConfig): LocalAgentStore {
  return new LocalAgentStore(config.stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    grantScopeRoot: row.grant_scope_root ?? undefined,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    workerPid: row.worker_pid ?? undefined,
    executionTimeoutSeconds: row.execution_timeout_seconds ?? undefined,
    fallbackEnabled: row.fallback_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped" ||
    status === "timed_out"
  ) {
    return status;
  }
  return "error";
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

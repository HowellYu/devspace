import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export type PathGrantAccess = "read" | "readwrite";

export interface PathGrantRecord {
  id: string;
  workspaceRoot: string;
  path: string;
  access: PathGrantAccess;
  reason?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AddPathGrantInput {
  workspaceRoot: string;
  path: string;
  access: PathGrantAccess;
  reason?: string;
  persistent?: boolean;
  ttlSeconds?: number;
}

interface StoredPathGrants {
  version: 1;
  grants: PathGrantRecord[];
}

const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export class PathGrantStore {
  private readonly filePath: string;
  private readonly auditPath: string;
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = resolve(expandHomePath(stateDir));
    this.filePath = join(this.stateDir, "path-grants.json");
    this.auditPath = join(this.stateDir, "path-grants.log");
  }

  list(workspaceRoot?: string, now = Date.now()): PathGrantRecord[] {
    const scope = workspaceRoot ? canonicalExistingDirectory(workspaceRoot, "workspace root") : undefined;
    const stored = this.read();
    return stored.grants
      .filter((grant) => !scope || grant.workspaceRoot === scope)
      .filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  add(input: AddPathGrantInput, now = Date.now()): PathGrantRecord {
    const workspaceRoot = canonicalExistingDirectory(input.workspaceRoot, "workspace root");
    const path = canonicalExistingDirectory(input.path, "grant path");
    assertSafeGrantPath(path, workspaceRoot, this.stateDir);

    const reason = normalizeReason(input.reason);
    const ttlSeconds = input.persistent
      ? undefined
      : validateTtlSeconds(input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const createdAt = new Date(now).toISOString();
    const expiresAt = ttlSeconds === undefined
      ? undefined
      : new Date(now + ttlSeconds * 1000).toISOString();

    const stored = this.read();
    const existing = stored.grants.find(
      (grant) => grant.workspaceRoot === workspaceRoot && grant.path === path,
    );
    const record: PathGrantRecord = {
      id: existing?.id ?? `grant_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      workspaceRoot,
      path,
      access: input.access,
      reason,
      createdAt,
      expiresAt,
    };

    stored.grants = stored.grants.filter((grant) => grant.id !== record.id);
    stored.grants.push(record);
    this.write(stored);
    this.audit("GRANT", record);
    return record;
  }

  remove(id: string): PathGrantRecord | undefined {
    const stored = this.read();
    const record = stored.grants.find((grant) => grant.id === id);
    if (!record) return undefined;
    stored.grants = stored.grants.filter((grant) => grant.id !== id);
    this.write(stored);
    this.audit("REVOKE", record);
    return record;
  }

  readRoots(workspaceRoot: string): string[] {
    return this.list(workspaceRoot).map((grant) => grant.path);
  }

  writeRoots(workspaceRoot: string): string[] {
    return this.list(workspaceRoot)
      .filter((grant) => grant.access === "readwrite")
      .map((grant) => grant.path);
  }

  private read(): StoredPathGrants {
    if (!existsSync(this.filePath)) return { version: 1, grants: [] };
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredPathGrants>;
    if (parsed.version !== 1 || !Array.isArray(parsed.grants)) {
      throw new Error(`Invalid DevSpace path grant store: ${this.filePath}`);
    }
    return { version: 1, grants: parsed.grants as PathGrantRecord[] };
  }

  private write(value: StoredPathGrants): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  private audit(action: "GRANT" | "REVOKE", record: PathGrantRecord): void {
    mkdirSync(dirname(this.auditPath), { recursive: true, mode: 0o700 });
    const expiry = record.expiresAt ?? "persistent";
    appendFileSync(
      this.auditPath,
      `${new Date().toISOString()} ${action} ${record.id} access=${record.access} workspace=${JSON.stringify(record.workspaceRoot)} path=${JSON.stringify(record.path)} expiry=${expiry}\n`,
      { mode: 0o600 },
    );
  }
}

export function createPathGrantStore(stateDir: string): PathGrantStore {
  return new PathGrantStore(stateDir);
}

export function validatePathGrantAccess(value: string): PathGrantAccess {
  if (value === "read" || value === "readwrite") return value;
  throw new Error(`Invalid path grant access: ${value}. Expected read or readwrite.`);
}

export function validateTtlSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) {
    throw new Error(`Invalid path grant TTL: ${value}. Expected 1-${MAX_TTL_SECONDS} seconds.`);
  }
  return value;
}

function canonicalExistingDirectory(input: string, label: string): string {
  const absolute = resolve(expandHomePath(input));
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new Error(`${label} does not exist: ${input}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a directory: ${input}`);
  }
  return canonical;
}

function assertSafeGrantPath(path: string, workspaceRoot: string, stateDir: string): void {
  if (isPathInsideRoot(path, workspaceRoot)) {
    throw new Error(`Grant path is already inside the workspace: ${path}`);
  }
  if (isPathInsideRoot(workspaceRoot, path)) {
    throw new Error(`Grant path may not contain the workspace root: ${path}`);
  }
  if (isPathInsideRoot(path, stateDir)) {
    throw new Error("DevSpace state/control-plane paths cannot be granted to a workspace.");
  }

  const home = resolve(homedir());
  const exactBlocked = [
    "/",
    home,
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
  ].map((value) => resolve(value));
  if (exactBlocked.includes(path)) {
    throw new Error(`Grant path is too broad: ${path}`);
  }

  const blockedTrees = [
    "/System",
    "/etc",
    "/private",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".config", "gcloud"),
    join(home, ".devspace"),
    join(home, ".codex"),
  ].map((value) => resolve(value));
  const blocked = blockedTrees.find((root) => isPathInsideRoot(path, root));
  if (blocked) {
    throw new Error(`Grant path is security-sensitive and cannot use generic grants: ${path}`);
  }
}

function normalizeReason(value: string | undefined): string | undefined {
  const reason = value?.trim();
  if (!reason) return undefined;
  return reason.slice(0, 240);
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export type ProviderAccessMode = "read" | "readwrite";
export type ProviderAccessKind = "file" | "directory";

export interface ProviderAccessRecord {
  id: string;
  provider: LocalAgentProvider;
  path: string;
  kind: ProviderAccessKind;
  access: ProviderAccessMode;
  createdAt: string;
}

interface StoredProviderAccess {
  version: 1;
  records: ProviderAccessRecord[];
}

export interface ProviderSandboxAccess {
  readPaths: string[];
  readFiles: string[];
  writePaths: string[];
  writeFiles: string[];
}

export class ProviderAccessStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(resolve(expandHomePath(stateDir)), "provider-access.json");
  }

  list(provider?: LocalAgentProvider): ProviderAccessRecord[] {
    return this.read().records
      .filter((record) => !provider || record.provider === provider)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  add(provider: LocalAgentProvider, inputPath: string, access: ProviderAccessMode): ProviderAccessRecord {
    const path = canonicalExistingPath(inputPath);
    validateProviderPath(provider, path);
    const kind: ProviderAccessKind = statSync(path).isDirectory() ? "directory" : "file";
    const stored = this.read();
    const existing = stored.records.find((record) => record.provider === provider && record.path === path);
    const record: ProviderAccessRecord = {
      id: existing?.id ?? `provider_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      provider,
      path,
      kind,
      access,
      createdAt: new Date().toISOString(),
    };
    stored.records = stored.records.filter((candidate) => candidate.id !== record.id);
    stored.records.push(record);
    this.write(stored);
    return record;
  }

  remove(id: string): ProviderAccessRecord | undefined {
    const stored = this.read();
    const record = stored.records.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    stored.records = stored.records.filter((candidate) => candidate.id !== id);
    this.write(stored);
    return record;
  }

  sandboxAccess(provider: LocalAgentProvider): ProviderSandboxAccess {
    const result: ProviderSandboxAccess = { readPaths: [], readFiles: [], writePaths: [], writeFiles: [] };
    for (const record of this.list(provider)) {
      if (record.kind === "directory") result.readPaths.push(record.path);
      else result.readFiles.push(record.path);
      if (record.access === "readwrite") {
        if (record.kind === "directory") result.writePaths.push(record.path);
        else result.writeFiles.push(record.path);
      }
    }
    return result;
  }

  private read(): StoredProviderAccess {
    if (!existsSync(this.filePath)) return { version: 1, records: [] };
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredProviderAccess>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid DevSpace provider access store: ${this.filePath}`);
    }
    return { version: 1, records: parsed.records as ProviderAccessRecord[] };
  }

  private write(value: StoredProviderAccess): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

export function createProviderAccessStore(stateDir: string): ProviderAccessStore {
  return new ProviderAccessStore(stateDir);
}

export function validateProviderAccessMode(value: string): ProviderAccessMode {
  if (value === "read" || value === "readwrite") return value;
  throw new Error(`Invalid provider access mode: ${value}. Expected read or readwrite.`);
}

function canonicalExistingPath(input: string): string {
  const absolute = resolve(expandHomePath(input));
  try {
    return realpathSync.native(absolute);
  } catch {
    throw new Error(`Provider access path does not exist: ${input}`);
  }
}

function validateProviderPath(provider: LocalAgentProvider, path: string): void {
  const home = resolve(homedir());
  const allowedHomes: Partial<Record<LocalAgentProvider, string[]>> = {
    codex: [join(home, ".codex")],
    claude: [join(home, ".claude")],
    luna: [join(home, ".kimi-code")],
    cursor: [join(home, ".cursor")],
    copilot: [join(home, ".config", "github-copilot")],
    pi: [join(home, ".pi")],
    opencode: [join(home, ".config", "opencode")],
  };
  const roots = allowedHomes[provider] ?? [];
  if (!roots.some((root) => isPathInsideRoot(path, root))) {
    throw new Error(`Provider access for ${provider} must stay inside its provider-specific configuration root.`);
  }
  if (roots.some((root) => resolve(root) === path)) {
    throw new Error(`Provider access must name a narrower file or directory, not the entire ${provider} configuration root.`);
  }
}

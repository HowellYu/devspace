import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_FILE_NAMES = new Set([
  "decisions.md",
  "progress.md",
  "next-steps.md",
]);

const MEMORY_DIR_NAME = "memory";
const DEVSPACE_DIR_NAME = ".devspace";
const NAMESPACE_HASH_BYTES = 16;
const MAX_MEMORY_FILENAME_LENGTH = 128;

export interface MemoryFileInfo {
  file: string;
  size: number;
  updatedAt?: string;
}

export interface ProjectMemoryManager {
  listFiles(root: string): Promise<MemoryFileInfo[]>;
  readFile(root: string, file: string): Promise<string | undefined>;
  writeFile(root: string, file: string, content: string): Promise<void>;
}

export function createProjectMemoryManager(stateDir: string): ProjectMemoryManager {
  return new FileProjectMemoryManager(stateDir);
}

class FileProjectMemoryManager implements ProjectMemoryManager {
  constructor(private readonly stateDir: string) {}

  async listFiles(root: string): Promise<MemoryFileInfo[]> {
    const localNamespace = localMemoryNamespacePath(root);
    if (await directoryExists(localNamespace)) {
      return listMemoryFiles(localNamespace);
    }

    return listMemoryFiles(memoryNamespacePath(this.stateDir, root));
  }

  async readFile(root: string, file: string): Promise<string | undefined> {
    assertValidMemoryFilename(file);

    const localPath = join(localMemoryNamespacePath(root), file);
    try {
      return await readFile(localPath, "utf8");
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const globalPath = join(memoryNamespacePath(this.stateDir, root), file);
    try {
      return await readFile(globalPath, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async writeFile(root: string, file: string, content: string): Promise<void> {
    assertValidMemoryFilename(file);

    const localNamespace = localMemoryNamespacePath(root);
    await mkdir(localNamespace, { recursive: true, mode: 0o700 });
    await ensureDevspaceGitignore(root);
    await maybeMigrateGlobalMemory(memoryNamespacePath(this.stateDir, root), localNamespace);

    const path = join(localNamespace, file);
    await writeFile(path, content, { mode: 0o600 });
  }
}

export function localMemoryNamespacePath(root: string): string {
  return join(root, DEVSPACE_DIR_NAME, MEMORY_DIR_NAME);
}

export function memoryNamespacePath(stateDir: string, root: string): string {
  const hash = createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, NAMESPACE_HASH_BYTES * 2);
  return join(stateDir, MEMORY_DIR_NAME, hash);
}

export function memoryNamespaceId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, NAMESPACE_HASH_BYTES * 2);
}

export function isValidMemoryFilename(file: string): boolean {
  if (typeof file !== "string") return false;
  if (file.length === 0 || file.length > MAX_MEMORY_FILENAME_LENGTH) return false;
  if (file.startsWith(".")) return false;
  if (!file.endsWith(".md")) return false;
  if (file.includes("/") || file.includes("\\")) return false;

  const basename = file.slice(0, -3);
  if (basename.length === 0) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(basename);
}

export function assertValidMemoryFilename(file: string): string {
  if (!isValidMemoryFilename(file)) {
    throw new Error(
      `Invalid memory file name: ${JSON.stringify(file)}. Names must be non-hidden, end with .md, contain no path separators, and use only letters, digits, dots, underscores, and hyphens.`,
    );
  }
  return file;
}

async function listMemoryFiles(namespace: string): Promise<MemoryFileInfo[]> {
  const files: MemoryFileInfo[] = [];

  let entries;
  try {
    entries = await opendir(namespace);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  for await (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isValidMemoryFilename(entry.name)) continue;

    const path = join(namespace, entry.name);
    const stats = await stat(path).catch(() => undefined);
    files.push({
      file: entry.name,
      size: stats?.size ?? 0,
      updatedAt: stats?.mtime.toISOString(),
    });
  }

  return files.sort((a, b) => a.file.localeCompare(b.file));
}

async function maybeMigrateGlobalMemory(globalNamespace: string, localNamespace: string): Promise<void> {
  let entries;
  try {
    entries = await opendir(globalNamespace);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for await (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isValidMemoryFilename(entry.name)) continue;

    const source = join(globalNamespace, entry.name);
    const dest = join(localNamespace, entry.name);

    const [sourceStats, destStats] = await Promise.all([
      stat(source).catch(() => undefined),
      stat(dest).catch(() => undefined),
    ]);
    if (!sourceStats) continue;
    if (destStats && destStats.mtime >= sourceStats.mtime) continue;

    const data = await readFile(source);
    await writeFile(dest, data, { mode: 0o600 });
  }
}

async function ensureDevspaceGitignore(root: string): Promise<void> {
  const devspaceDir = join(root, DEVSPACE_DIR_NAME);
  const gitignorePath = join(devspaceDir, ".gitignore");

  try {
    await stat(gitignorePath);
    return;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(gitignorePath, "memory/\n", { mode: 0o644 });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

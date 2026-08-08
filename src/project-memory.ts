import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_FILE_NAMES = new Set([
  "decisions.md",
  "progress.md",
  "next-steps.md",
]);

const MEMORY_DIR_NAME = "memory";
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
    const namespace = memoryNamespacePath(this.stateDir, root);
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

  async readFile(root: string, file: string): Promise<string | undefined> {
    assertValidMemoryFilename(file);
    const path = join(memoryNamespacePath(this.stateDir, root), file);

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async writeFile(root: string, file: string, content: string): Promise<void> {
    assertValidMemoryFilename(file);
    const namespace = memoryNamespacePath(this.stateDir, root);
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    const path = join(namespace, file);
    await writeFile(path, content, { mode: 0o600 });
  }
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

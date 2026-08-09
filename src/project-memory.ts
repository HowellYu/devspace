import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
const MEMORY_INDEX_FILE = "index.json";
const MEMORY_BOOTSTRAP_FILES = ["progress.md", "next-steps.md", "context.md", "handoff.md"] as const;
const MEMORY_BOOTSTRAP_MAX_CHARS = 6_000;
const MEMORY_BOOTSTRAP_FILE_MAX_CHARS = 2_500;
const MEMORY_FILE_MAX_BYTES = 32 * 1024;
const INITIAL_MEMORY_FILES: Readonly<Record<string, string>> = {
  "context.md": "# Context\n\n",
  "progress.md": "# Progress\n\n",
  "next-steps.md": "# Next Steps\n\n",
};

export interface MemoryFileInfo {
  file: string;
  size: number;
  updatedAt?: string;
}

export interface ProjectMemoryManifestFile {
  revision: string;
  size: number;
  updatedAt?: string;
}

export interface ProjectMemoryManifest {
  version: 1;
  revision: string;
  updatedAt?: string;
  files: Record<string, ProjectMemoryManifestFile>;
}

export interface ProjectMemoryBootstrap {
  manifest: ProjectMemoryManifest;
  sections: Record<string, string>;
  truncated: boolean;
}

export interface ProjectMemoryManager {
  listFiles(root: string): Promise<MemoryFileInfo[]>;
  readFile(root: string, file: string): Promise<string | undefined>;
  writeFile(root: string, file: string, content: string): Promise<void>;
  manifest(root: string): Promise<ProjectMemoryManifest>;
  bootstrap(root: string): Promise<ProjectMemoryBootstrap>;
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
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MEMORY_FILE_MAX_BYTES) {
      throw new Error(`Project memory file ${file} is ${bytes} bytes; maximum is ${MEMORY_FILE_MAX_BYTES}. Compact the durable state instead of storing transcripts or logs.`);
    }

    const localNamespace = localMemoryNamespacePath(root);
    await mkdir(localNamespace, { recursive: true, mode: 0o700 });
    await ensureDevspaceGitignore(root);
    await maybeMigrateGlobalMemory(memoryNamespacePath(this.stateDir, root), localNamespace);

    const path = join(localNamespace, file);
    await writeFile(path, content, { mode: 0o600 });
    await writeManifestIndex(localNamespace, await buildManifest(localNamespace));
  }

  async manifest(root: string): Promise<ProjectMemoryManifest> {
    await this.ensureInitialized(root);
    const namespace = await effectiveMemoryNamespace(this.stateDir, root);
    return buildManifest(namespace);
  }

  async bootstrap(root: string): Promise<ProjectMemoryBootstrap> {
    await this.ensureInitialized(root);
    const namespace = await effectiveMemoryNamespace(this.stateDir, root);
    const manifest = await buildManifest(namespace);
    const sections: Record<string, string> = {};
    let remaining = MEMORY_BOOTSTRAP_MAX_CHARS;
    let truncated = false;

    for (const file of MEMORY_BOOTSTRAP_FILES) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (!manifest.files[file]) continue;
      const content = await readFile(join(namespace, file), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      const limit = Math.min(remaining, MEMORY_BOOTSTRAP_FILE_MAX_CHARS);
      if (content.length > limit) truncated = true;
      sections[file] = content.slice(0, limit);
      remaining -= sections[file]!.length;
    }

    return { manifest, sections, truncated };
  }

  private async ensureInitialized(root: string): Promise<void> {
    if ((await this.listFiles(root)).length > 0) return;
    for (const [file, content] of Object.entries(INITIAL_MEMORY_FILES)) {
      await this.writeFile(root, file, content);
    }
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

async function effectiveMemoryNamespace(stateDir: string, root: string): Promise<string> {
  const localNamespace = localMemoryNamespacePath(root);
  return (await directoryExists(localNamespace)) ? localNamespace : memoryNamespacePath(stateDir, root);
}

async function buildManifest(namespace: string): Promise<ProjectMemoryManifest> {
  const files = await listMemoryFiles(namespace);
  const entries: Array<[string, ProjectMemoryManifestFile]> = [];
  let latestUpdatedAt: string | undefined;

  for (const file of files) {
    const content = await readFile(join(namespace, file.file)).catch(() => undefined);
    if (!content) continue;
    const revision = createHash("sha256").update(content).digest("hex").slice(0, 16);
    entries.push([
      file.file,
      {
        revision,
        size: file.size,
        updatedAt: file.updatedAt,
      },
    ]);
    if (file.updatedAt && (!latestUpdatedAt || file.updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = file.updatedAt;
    }
  }

  const filesByName = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  const revision = createHash("sha256")
    .update(JSON.stringify(Object.entries(filesByName).map(([file, info]) => [file, info.revision])))
    .digest("hex")
    .slice(0, 16);

  return {
    version: 1,
    revision,
    updatedAt: latestUpdatedAt,
    files: filesByName,
  };
}

async function writeManifestIndex(namespace: string, manifest: ProjectMemoryManifest): Promise<void> {
  const tempPath = join(namespace, `${MEMORY_INDEX_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const indexPath = join(namespace, MEMORY_INDEX_FILE);
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, indexPath);
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

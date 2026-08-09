import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "workspace_open";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

interface FilesystemFileSnapshot {
  hash: string;
  size: number;
  text?: string;
  lineCount: number;
}

type FilesystemSnapshot = Map<string, FilesystemFileSnapshot>;

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  filesystemOpen?: FilesystemSnapshot;
  filesystemBaseline?: FilesystemSnapshot;
  openRef: string;
  baselineRef: string;
  openRefAvailable: boolean;
  baselineRefAvailable: boolean;
  diagnostic?: string;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";
const FILESYSTEM_SNAPSHOT_MAX_TEXT_BYTES = 1024 * 1024;
const FILESYSTEM_PATCH_MAX_CHARS = 200_000;
const FILESYSTEM_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "DerivedData",
  "Pods",
]);

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const initializations = new Map<string, Promise<void>>();

  return {
    async initializeWorkspace({ workspaceId, root }) {
      const existingState = states.get(workspaceId);
      assertWorkspaceRoot(existingState, workspaceId, root);
      if (existingState?.root === root && existingState.gitRoot !== undefined) {
        return;
      }

      const pending = initializations.get(workspaceId);
      if (pending) {
        await pending;
        assertWorkspaceRoot(states.get(workspaceId), workspaceId, root);
        return;
      }

      const initialize = initializeWorkspaceState(states, workspaceId, root);
      initializations.set(workspaceId, initialize);
      try {
        await initialize;
      } finally {
        if (initializations.get(workspaceId) === initialize) {
          initializations.delete(workspaceId);
        }
      }
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
      let state = states.get(workspaceId);
      assertWorkspaceRoot(state, workspaceId, root);
      if (!isReadyState(state)) {
        await this.initializeWorkspace({ workspaceId, root });
        state = states.get(workspaceId);
      }
      assertWorkspaceRoot(state, workspaceId, root);

      if (!state?.gitRoot) {
        if (!state?.filesystemOpen || !state.filesystemBaseline) {
          throw new Error(state?.diagnostic ?? "Review state is unavailable for this workspace.");
        }
        const baseline = since === "workspace_open" ? state.filesystemOpen : state.filesystemBaseline;
        const current = await createFilesystemSnapshot(root);
        const review = compareFilesystemSnapshots(baseline, current);
        if (markReviewed) state.filesystemBaseline = current;
        return review;
      }

      let effectiveSince = since;
      let usedWorkspaceOpenFallback = false;
      if (since === "last_shown" && !state.baselineRefAvailable) {
        if (!state.openRefAvailable) {
          throw new Error("Review checkpoints are missing; show_changes cannot reconstruct that history safely.");
        }
        effectiveSince = "workspace_open";
        usedWorkspaceOpenFallback = true;
      } else if (since === "workspace_open" && !state.openRefAvailable) {
        throw new Error(
          "The workspace-open review checkpoint is missing; show_changes cannot reconstruct that history safely.",
        );
      }

      const baselineRef = effectiveSince === "workspace_open" ? state.openRef : state.baselineRef;
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
      const current = await createWorkingTreeSnapshot(state.gitRoot);
      const patch = (await git(state.gitRoot, ["diff", "--binary", "--no-color", baseline, current], {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current], {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const files = parseNumstat(numstat);
      const summary = summarizeFiles(files);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
        state.baselineRefAvailable = true;
      }

      const fallbackNote = usedWorkspaceOpenFallback
        ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
        : "";
      return {
        result: `${
          summary.files === 0
            ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`
        }${fallbackNote}`,
        summary,
        files,
        patch,
      };
    },
  };
}

function assertWorkspaceRoot(
  state: WorkspaceReviewState | undefined,
  workspaceId: string,
  root: string,
): void {
  if (state && state.root !== root) {
    throw new Error(`Review checkpoint workspace root mismatch for ${workspaceId}.`);
  }
}

async function initializeWorkspaceState(
  states: Map<string, WorkspaceReviewState>,
  workspaceId: string,
  root: string,
): Promise<void> {
  const refs = reviewRefs(workspaceId);
  const state: WorkspaceReviewState = {
    root,
    ...refs,
    openRefAvailable: false,
    baselineRefAvailable: false,
  };

  try {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) {
      if (eligibility.reason === "not_git") {
        const snapshot = await createFilesystemSnapshot(root);
        state.filesystemOpen = snapshot;
        state.filesystemBaseline = snapshot;
      }
      state.diagnostic = eligibility.message ?? "Review initialization failed.";
      return;
    }

    const [openCommit, baselineCommit] = await Promise.all([
      commitForRef(eligibility.gitRoot, state.openRef),
      commitForRef(eligibility.gitRoot, state.baselineRef),
    ]);

    if (!openCommit && !baselineCommit) {
      const initialCommit = await createWorkingTreeSnapshot(eligibility.gitRoot);
      await git(eligibility.gitRoot, ["update-ref", state.openRef, initialCommit]);
      await git(eligibility.gitRoot, ["update-ref", state.baselineRef, initialCommit]);
      state.openRefAvailable = true;
      state.baselineRefAvailable = true;
    } else {
      state.openRefAvailable = openCommit !== undefined;
      state.baselineRefAvailable = baselineCommit !== undefined;
    }

    state.gitRoot = eligibility.gitRoot;
  } catch (error) {
    state.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    states.set(workspaceId, state);
  }
}

function isReadyState(state: WorkspaceReviewState | undefined): boolean {
  return state?.gitRoot !== undefined || state?.filesystemBaseline !== undefined;
}

async function commitForRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function reviewRefs(
  workspaceId: string,
): Pick<WorkspaceReviewState, "openRef" | "baselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function createWorkingTreeSnapshot(gitRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

async function createFilesystemSnapshot(root: string): Promise<FilesystemSnapshot> {
  const snapshot: FilesystemSnapshot = new Map();
  await walkFilesystemSnapshot(root, root, snapshot);
  return snapshot;
}

async function walkFilesystemSnapshot(
  root: string,
  directory: string,
  snapshot: FilesystemSnapshot,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && FILESYSTEM_IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFilesystemSnapshot(root, absolutePath, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = absolutePath.slice(root.length + 1);
    const info = await stat(absolutePath);
    const content = await readFile(absolutePath);
    const hash = createHash("sha256").update(content).digest("hex");
    const isText = info.size <= FILESYSTEM_SNAPSHOT_MAX_TEXT_BYTES && !content.includes(0);
    const text = isText ? content.toString("utf8") : undefined;
    snapshot.set(relativePath, {
      hash,
      size: info.size,
      text,
      lineCount: text === undefined ? 0 : splitLines(text).length,
    });
  }
}

function compareFilesystemSnapshots(
  baseline: FilesystemSnapshot,
  current: FilesystemSnapshot,
): ReviewChangesResult {
  const paths = Array.from(new Set([...baseline.keys(), ...current.keys()])).sort();
  const files: ReviewFile[] = [];
  const patchParts: string[] = [];

  for (const path of paths) {
    const before = baseline.get(path);
    const after = current.get(path);
    if (before?.hash === after?.hash) continue;

    if (!before && after) {
      files.push({ path, type: "new", additions: after.lineCount, removals: 0 });
      patchParts.push(filesystemPatch(path, undefined, after));
      continue;
    }
    if (before && !after) {
      files.push({ path, type: "deleted", additions: 0, removals: before.lineCount });
      patchParts.push(filesystemPatch(path, before, undefined));
      continue;
    }
    if (!before || !after) continue;

    const counts = changedLineCounts(before.text, after.text);
    files.push({ path, type: "change", additions: counts.additions, removals: counts.removals });
    patchParts.push(filesystemPatch(path, before, after));
  }

  const summary = summarizeFiles(files);
  let patch = patchParts.filter(Boolean).join("\n");
  if (patch.length > FILESYSTEM_PATCH_MAX_CHARS) {
    patch = `${patch.slice(0, FILESYSTEM_PATCH_MAX_CHARS)}\n... filesystem patch preview truncated ...\n`;
  }
  return {
    result: summary.files === 0
      ? "No changes since last shown changes."
      : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
    summary,
    files,
    patch,
  };
}

function changedLineCounts(before: string | undefined, after: string | undefined): { additions: number; removals: number } {
  if (before === undefined || after === undefined) return { additions: 0, removals: 0 };
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: Math.max(0, afterLines.length - prefix - suffix),
    removals: Math.max(0, beforeLines.length - prefix - suffix),
  };
}

function filesystemPatch(
  path: string,
  before: FilesystemFileSnapshot | undefined,
  after: FilesystemFileSnapshot | undefined,
): string {
  if (before?.text === undefined && after?.text === undefined) {
    return `--- ${before ? path : "/dev/null"}\n+++ ${after ? path : "/dev/null"}\nBinary or large file changed (${before?.size ?? 0} -> ${after?.size ?? 0} bytes).\n`;
  }
  const beforeLines = splitLines(before?.text ?? "");
  const afterLines = splitLines(after?.text ?? "");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const lines = [
    `--- ${before ? path : "/dev/null"}`,
    `+++ ${after ? path : "/dev/null"}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}

import { spawn } from "node:child_process";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { shouldUseMacosSandbox, wrapMacosSandboxCommand } from "./macos-sandbox.js";
import { buildSafeChildEnvironment } from "./process-environment.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  workspaceId?: string;
  readRoots?: string[];
  writeRoots?: string[];
  sandbox?: Pick<ServerConfig, "macosSandbox" | "sandboxNetwork" | "sandboxReadPaths" | "sandboxWritePaths">;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.writeRoots ?? [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, context.writeRoots ?? [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path
    ? resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root])
    : undefined;
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), { ...input, path }, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path
    ? resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root])
    : undefined;
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), { ...input, path }, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path ?? ".", context.cwd, context.readRoots ?? [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), { ...input, path }, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const operations = context.sandbox ? createSandboxedBashOperations(context) : undefined;
  const tool = createBashTool(context.cwd, operations ? { operations } : undefined);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}

function createSandboxedBashOperations(context: ToolContext): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const base = resolveShellCommand(command);
      const wrapped = context.sandbox && shouldUseMacosSandbox(context.sandbox)
        ? wrapMacosSandboxCommand(base, {
            workspaceRoot: context.root,
            readPaths: [
              ...context.sandbox.sandboxReadPaths,
              ...(context.readRoots ?? []).filter((path) => path !== context.root),
            ],
            writePaths: [
              ...context.sandbox.sandboxWritePaths,
              ...(context.writeRoots ?? []).filter((path) => path !== context.root),
            ],
            allowNetwork: context.sandbox.sandboxNetwork,
          })
        : base;
      const detached = process.platform !== "win32";

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const child = spawn(wrapped.executable, wrapped.args, {
          cwd,
          detached,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: buildSafeChildEnvironment({
            extra: {
              DEVSPACE_WORKSPACE_ID: context.workspaceId,
              DEVSPACE_WORKSPACE_ROOT: context.root,
              NO_COLOR: "1",
              TERM: "dumb",
              PAGER: "cat",
              GIT_PAGER: "cat",
              GH_PAGER: "cat",
            },
          }),
        });

        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const stop = (killSignal: NodeJS.Signals = "SIGTERM") => {
          terminateProcessTree(child, killSignal, detached);
        };
        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            stop("SIGKILL");
          }, timeout * 1000);
          timer.unref?.();
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });

        const onAbort = () => stop("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

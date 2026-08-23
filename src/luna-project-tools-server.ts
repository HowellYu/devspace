import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { ProjectXcodeSession, type XcodeAction } from "./xcode-project.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const workspaceRoot = resolveWorkspaceRoot(process.env.DEVSPACE_LUNA_WORKSPACE_ROOT);
const xcode = new ProjectXcodeSession(workspaceRoot);

export const lunaProjectXcodeTools: ToolDefinition[] = [
  {
    name: "xcode_status",
    description: "Inspect Xcode's active workspace only if its document path is inside the current authorized DevSpace workspace. Outside projects are reported only as unauthorized and their paths are never returned.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "xcode_open_workspace",
    description: "Open an .xcodeproj or .xcworkspace path that resolves inside the current authorized DevSpace workspace.",
    inputSchema: objectSchema({ path: stringSchema("Workspace-relative .xcodeproj or .xcworkspace path.") }, ["path"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_open_file",
    description: "Open a file in Xcode only when the file resolves inside the current authorized DevSpace workspace and the active Xcode workspace is also authorized.",
    inputSchema: objectSchema({ path: stringSchema("Workspace-relative file path.") }, ["path"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_select_scheme",
    description: "Select a scheme in the currently authorized Xcode workspace.",
    inputSchema: objectSchema({ name: stringSchema("Exact Xcode scheme name.") }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_select_run_destination",
    description: "Select a run destination in the currently authorized Xcode workspace.",
    inputSchema: objectSchema({ name: stringSchema("Exact Xcode run destination name.") }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_ui_snapshot",
    description: "Read a bounded text-only Accessibility snapshot of the front Xcode window after revalidating that Xcode's active document is inside the current DevSpace workspace. No pixels, desktop, or other app windows are captured.",
    inputSchema: objectSchema({
      maxDepth: { type: "integer", minimum: 1, maximum: 8, description: "Optional accessibility-tree depth. Defaults to 6." },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "xcode_ui_click",
    description: "Click an Xcode accessibility element ref returned by xcode_ui_snapshot. The active Xcode project is revalidated before and after the click; no coordinate or other-app click API is exposed.",
    inputSchema: objectSchema({ ref: stringSchema("Xcode element ref such as x1.2.3 from xcode_ui_snapshot.") }, ["ref"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_ui_set_value",
    description: "Set the value of an Xcode accessibility element ref after project revalidation. Secure text fields are refused, and no generic keystroke API is exposed.",
    inputSchema: objectSchema({
      ref: stringSchema("Xcode element ref such as x1.2.3 from xcode_ui_snapshot."),
      text: stringSchema("Text to set in the Xcode UI element."),
    }, ["ref", "text"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_action",
    description: "Invoke Xcode's native build, clean, run, test, or debug command on the currently authorized workspace. It cannot target an Xcode document outside the DevSpace workspace.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["build", "clean", "run", "test", "debug"] },
      timeoutSeconds: { type: "integer", minimum: 0, maximum: 600, description: "Optional wait time. Build/clean/test default to 120 seconds; run/debug default to 0." },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "xcode_stop",
    description: "Stop the active scheme action in the currently authorized Xcode workspace.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const toolMap = new Map(lunaProjectXcodeTools.map((tool) => [tool.name, tool]));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  if (!request.method) {
    if (request.id !== undefined) sendError(request.id ?? null, -32600, "Invalid Request");
    return;
  }

  if (request.method.startsWith("notifications/")) return;

  try {
    switch (request.method) {
      case "initialize": {
        const params = asRecord(request.params);
        const protocolVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
        sendResult(request.id ?? null, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "devspace-project-xcode", version: "1.0.0" },
          instructions: "Xcode-only project automation. Every target document must resolve inside the current DevSpace workspace. The optional xcode_ui_* tools expose only the front Xcode window's text accessibility tree and element-targeted actions after project revalidation. No pixels, desktop, other-app windows, clipboard, generic mouse/keyboard, Finder, or System Settings access is exposed.",
        });
        return;
      }
      case "ping":
        sendResult(request.id ?? null, {});
        return;
      case "tools/list":
        sendResult(request.id ?? null, { tools: lunaProjectXcodeTools });
        return;
      case "tools/call": {
        const params = asRecord(request.params);
        const name = typeof params?.name === "string" ? params.name : "";
        if (!toolMap.has(name)) {
          sendError(request.id ?? null, -32602, `Unknown Xcode tool: ${name}`);
          return;
        }
        const args = asRecord(params?.arguments) ?? {};
        try {
          const value = await callTool(name, args);
          sendResult(request.id ?? null, {
            content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          });
        } catch (error) {
          sendResult(request.id ?? null, {
            content: [{ type: "text", text: errorMessage(error) }],
            isError: true,
          });
        }
        return;
      }
      default:
        sendError(request.id ?? null, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    sendError(request.id ?? null, -32603, errorMessage(error));
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "xcode_status": return xcode.status();
    case "xcode_open_workspace": return xcode.openWorkspace(requiredString(args.path, "path"));
    case "xcode_open_file": return xcode.openFile(requiredString(args.path, "path"));
    case "xcode_select_scheme": return xcode.selectScheme(requiredString(args.name, "name"));
    case "xcode_select_run_destination": return xcode.selectRunDestination(requiredString(args.name, "name"));
    case "xcode_ui_snapshot": {
      const maxDepth = args.maxDepth === undefined ? undefined : requiredInteger(args.maxDepth, "maxDepth");
      return xcode.uiSnapshot(maxDepth);
    }
    case "xcode_ui_click": return xcode.uiClick(requiredString(args.ref, "ref"));
    case "xcode_ui_set_value": return xcode.uiSetValue(requiredString(args.ref, "ref"), requiredString(args.text, "text"));
    case "xcode_action": {
      const action = requiredString(args.action, "action") as XcodeAction;
      if (!["build", "clean", "run", "test", "debug"].includes(action)) throw new Error(`Unsupported Xcode action: ${action}`);
      const timeout = args.timeoutSeconds === undefined ? undefined : requiredInteger(args.timeoutSeconds, "timeoutSeconds");
      return xcode.action(action, timeout);
    }
    case "xcode_stop": return xcode.stop();
    default: throw new Error(`Unknown Xcode tool: ${name}`);
  }
}

function resolveWorkspaceRoot(value: string | undefined): string {
  if (!value) throw new Error("DEVSPACE_LUNA_WORKSPACE_ROOT is required for the Xcode MCP server.");
  const root = resolve(value);
  if (!existsSync(root)) throw new Error("DevSpace workspace root does not exist.");
  return realpathSync.native(root);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function sendResult(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id: JsonRpcRequest["id"], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

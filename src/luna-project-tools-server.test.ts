import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

interface RpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

test("Luna Xcode MCP exposes only project-scoped Xcode tools", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/luna-project-tools-server.ts")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEVSPACE_LUNA_WORKSPACE_ROOT: process.cwd(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new LineRpcClient(child);
  try {
    const initialized = await client.call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const initResult = initialized.result as Record<string, unknown>;
    assert.match(String(initResult.instructions), /Xcode-only project automation/);
    assert.match(String(initResult.instructions), /No pixels, desktop, other-app windows/);

    const listed = await client.call("tools/list", {});
    const result = listed.result as { tools?: Array<{ name?: string; description?: string }> };
    const names = (result.tools ?? []).map((tool) => tool.name).filter((name): name is string => Boolean(name));
    assert.ok(names.includes("xcode_status"));
    assert.ok(names.includes("xcode_ui_snapshot"));
    assert.ok(names.includes("xcode_ui_click"));
    assert.ok(names.includes("xcode_ui_set_value"));
    assert.ok(names.includes("xcode_action"));
    assert.ok(names.every((name) => name.startsWith("xcode_")));
    assert.equal(names.some((name) => /browser|computer|desktop|screen|screenshot|window|mouse|keyboard/i.test(name)), false);

    const allDescriptions = (result.tools ?? []).map((tool) => tool.description ?? "").join("\n");
    assert.doesNotMatch(allDescriptions, /capture the desktop|enumerate all windows|generic computer control/i);
  } finally {
    child.kill("SIGTERM");
  }
});

class LineRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      if (typeof response.id !== "number") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? "RPC error"));
      else pending.resolve(response);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      const error = new Error(`Project Xcode MCP exited with code ${code}: ${this.stderr.trim()}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
  }

  call(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out for ${method}: ${this.stderr.trim()}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}

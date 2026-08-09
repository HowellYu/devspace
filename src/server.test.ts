import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type {
  ContinueWorkerInput,
  InspectWorkerOptions,
  InspectWorkerResult,
  LocalAgentOrchestrator,
  StartWorkerInput,
  StartWorkerResult,
  WaitWorkerResult,
} from "./local-agent-orchestrator.js";

const execFileAsync = promisify(execFile);

class FakeOrchestrator implements LocalAgentOrchestrator {
  private records = new Map<string, LocalAgentRecord>();
  private nextId = 1;

  get(workerId: string): LocalAgentRecord | undefined {
    return this.records.get(workerId);
  }

  async start(input: StartWorkerInput): Promise<StartWorkerResult> {
    const id = `agt_fake_${this.nextId++}`;
    const record: LocalAgentRecord = {
      id,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      profileName: input.target,
      provider: input.target,
      status: "starting",
      model: input.model,
      thinking: input.thinking,
      executionTimeoutSeconds: input.executionTimeoutSeconds ?? 600,
      fallbackEnabled: input.fallback ?? true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, record);
    return { record, fallbackUsed: input.fallback ?? false };
  }

  async continue(workerId: string, input: ContinueWorkerInput): Promise<LocalAgentRecord> {
    const record = this.get(workerId);
    if (!record) throw new Error(`Unknown workerId: ${workerId}`);
    record.status = "starting";
    record.executionTimeoutSeconds = input.executionTimeoutSeconds ?? record.executionTimeoutSeconds;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  async wait(workerId: string, _timeoutSeconds: number): Promise<WaitWorkerResult> {
    const record = this.get(workerId);
    if (!record) throw new Error(`Unknown workerId: ${workerId}`);
    record.status = "idle";
    record.latestResponse = "fake response";
    record.updatedAt = new Date().toISOString();
    return { record, timedOut: false };
  }

  async inspect(workerId: string, _options?: InspectWorkerOptions): Promise<InspectWorkerResult> {
    const record = this.get(workerId);
    if (!record) throw new Error(`Unknown workerId: ${workerId}`);
    return { record };
  }

  async stop(workerId: string): Promise<LocalAgentRecord> {
    const record = this.get(workerId);
    if (!record) throw new Error(`Unknown workerId: ${workerId}`);
    record.status = "stopped";
    record.updatedAt = new Date().toISOString();
    return record;
  }

  async executeWorker(): Promise<void> {}
}

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same checkout previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.ok(Array.isArray(card.agents));
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same checkout previously opened/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same checkout previously opened/);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same checkout previously opened/);
  } finally {
    await closeRestored();
  }
});

test("open_workspace exposes project memory namespace and existing memory files", async (t) => {
  const context = await fixture(t);
  const workspaceId = structuredContent(await callOpen(context.client, context.project, "chat-1")).workspaceId as string;
  await callTool(context.client, "write_project_memory", { workspaceId, file: "decisions.md", content: "# Decisions\n\nUse SQLite.\n" });
  await callTool(context.client, "write_project_memory", { workspaceId, file: "progress.md", content: "# Progress\n\nSetup done.\n" });

  const opened = await callOpen(context.client, context.project, "chat-1");
  const structured = structuredContent(opened);
  assert.equal(typeof structured.memoryNamespace, "string");
  assert.ok(Array.isArray(structured.memoryFiles));
  assert.deepEqual((structured.memoryFiles as string[]).sort(), ["decisions.md", "progress.md"]);
  assert.match(responseText(opened), /Project memory: decisions\.md, progress\.md/);

  const card = responseCard(opened);
  assert.equal(typeof card.memoryNamespace, "string");
  assert.ok(Array.isArray(card.memoryFiles));
});

test("project memory persists across server restarts for the same workspace", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const workspaceId = structuredContent(first).workspaceId as string;
  await callTool(context.client, "write_project_memory", { workspaceId, file: "next-steps.md", content: "- Write tests\n" });

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    const restoredWorkspaceId = structuredContent(restored).workspaceId as string;
    assert.equal(restoredWorkspaceId, workspaceId);
    const content = structuredContent(
      await callTool(restoredClient, "read_project_memory", { workspaceId: restoredWorkspaceId, file: "next-steps.md" }),
    ).result as string;
    assert.equal(content, "- Write tests\n");
  } finally {
    await closeRestored();
  }
});

test("project memory is isolated by canonical workspace root", async (t) => {
  const context = await fixture(t);
  const projectA = join(context.config.allowedRoots[0], "project-a");
  const projectB = join(context.config.allowedRoots[0], "project-b");

  const openA = await callOpen(context.client, projectA, "chat-a");
  const openB = await callOpen(context.client, projectB, "chat-b");
  const idA = structuredContent(openA).workspaceId as string;
  const idB = structuredContent(openB).workspaceId as string;

  await callTool(context.client, "write_project_memory", { workspaceId: idA, file: "decisions.md", content: "A\n" });
  await callTool(context.client, "write_project_memory", { workspaceId: idB, file: "decisions.md", content: "B\n" });

  const readA = structuredContent(
    await callTool(context.client, "read_project_memory", { workspaceId: idA, file: "decisions.md" }),
  ).result as string;
  const readB = structuredContent(
    await callTool(context.client, "read_project_memory", { workspaceId: idB, file: "decisions.md" }),
  ).result as string;

  assert.equal(readA, "A\n");
  assert.equal(readB, "B\n");
});

test("memory filename validation rejects traversal, hidden, and non-markdown names", async (t) => {
  const context = await fixture(t);
  const workspaceId = structuredContent(await callOpen(context.client, context.project, "chat-1")).workspaceId as string;

  for (const file of ["../decisions.md", "subdir/file.md", ".hidden.md", "notes.txt"]) {
    const result = await callTool(context.client, "write_project_memory", { workspaceId, file, content: "x" });
    assert.equal(result.isError, true, `expected error for ${file}`);
    assert.match(responseText(result), /Invalid memory file name/);
  }
});

test("write_project_memory overwrites and updates existing memory files", async (t) => {
  const context = await fixture(t);
  const workspaceId = structuredContent(await callOpen(context.client, context.project, "chat-1")).workspaceId as string;

  await callTool(context.client, "write_project_memory", { workspaceId, file: "decisions.md", content: "v1\n" });
  const firstRead = structuredContent(await callTool(context.client, "read_project_memory", { workspaceId, file: "decisions.md" })).result as string;
  assert.equal(firstRead, "v1\n");

  await callTool(context.client, "write_project_memory", { workspaceId, file: "decisions.md", content: "v2\n" });
  const secondRead = structuredContent(await callTool(context.client, "read_project_memory", { workspaceId, file: "decisions.md" })).result as string;
  assert.equal(secondRead, "v2\n");

  const listed = (await callTool(context.client, "list_project_memory", { workspaceId })).structuredContent as { files: string[] };
  assert.deepEqual(listed.files, ["decisions.md"]);
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  orchestrator: LocalAgentOrchestrator;
  close: () => Promise<void>;
}

async function fixture(t: TestContext, options: { git?: boolean } = {}): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "true",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const orchestrator = new FakeOrchestrator();
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
    undefined,
    orchestrator,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, orchestrator, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}

async function callTool(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({ name, arguments: arguments_ });
}


test("start_worker returns a worker id and structured status", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const result = await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "check changes",
  });
  const structured = structuredContent(result);
  assert.match(structured.workerId as string, /^agt_/);
  assert.equal(structured.status, "starting");
  assert.equal(structured.provider, "reviewer");
  assert.equal(structured.profile, "reviewer");
  assert.equal(structured.executionTimeoutSeconds, 600);
  assert.equal(structured.fallbackUsed, false);
  assert.ok((structured.result as string).includes(structured.workerId as string));
});

test("wait_worker returns latest response and timedOut flag", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const started = structuredContent(await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "check changes",
  }));

  const result = await callTool(context.client, "wait_worker", {
    workspaceId,
    workerId: started.workerId,
  });
  const structured = structuredContent(result);
  assert.equal(structured.workerId, started.workerId);
  assert.equal(structured.status, "idle");
  assert.equal(structured.latestResponse, "fake response");
  assert.equal(structured.timedOut, false);
});

test("inspect_worker returns status without changes when no checkpoint is available", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const started = structuredContent(await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "check changes",
  }));
  const result = await callTool(context.client, "inspect_worker", {
    workspaceId,
    workerId: started.workerId,
  });
  const structured = structuredContent(result);
  assert.equal(structured.workerId, started.workerId);
  assert.equal(structured.status, "starting");
  assert.ok(Array.isArray(structured.changedFiles));
  assert.deepEqual(structured.changedFiles, []);
  assert.equal(structured.checkpointSummary, undefined);
});

test("continue_worker resumes the same worker id", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const started = structuredContent(await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "first",
  }));

  const result = await callTool(context.client, "continue_worker", {
    workspaceId,
    workerId: started.workerId,
    prompt: "second",
    executionTimeoutSeconds: 1800,
  });
  const structured = structuredContent(result);
  assert.equal(structured.workerId, started.workerId);
  assert.equal(structured.status, "starting");
  assert.equal(structured.executionTimeoutSeconds, 1800);
});

test("worker tools are not registered when subagents are disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-no-workers-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-no-workers-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const tools = await client.listTools();
  for (const name of ["start_worker", "wait_worker", "inspect_worker", "continue_worker", "stop_worker"]) {
    assert.equal(tools.tools.some((tool) => tool.name === name), false, `expected ${name} to be absent`);
  }
});


test("stop_worker stops a running worker", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const started = structuredContent(await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "check changes",
  }));

  const result = await callTool(context.client, "stop_worker", {
    workspaceId,
    workerId: started.workerId,
  });
  const structured = structuredContent(result);
  assert.equal(structured.workerId, started.workerId);
  assert.equal(structured.status, "stopped");
});

test("continue_worker preserves providerSessionId", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const started = structuredContent(await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "first",
  }));

  // Simulate the worker completing with a provider session id.
  const fakeRecord = context.orchestrator.get(started.workerId as string);
  if (fakeRecord) {
    fakeRecord.status = "idle";
    fakeRecord.providerSessionId = "sess_preserved";
    fakeRecord.latestResponse = "first response";
  }

  await callTool(context.client, "continue_worker", {
    workspaceId,
    workerId: started.workerId,
    prompt: "second",
  });

  const continued = context.orchestrator.get(started.workerId as string);
  assert.equal(continued?.providerSessionId, "sess_preserved");
});

test("start_worker with unavailable provider and explicit fallback", async (t) => {
  const context = await fixture(t);
  const openResult = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const workspaceId = openResult.workspaceId as string;

  const result = await callTool(context.client, "start_worker", {
    workspaceId,
    target: "reviewer",
    prompt: "check changes",
    fallback: true,
  });
  const structured = structuredContent(result);
  assert.match(structured.workerId as string, /^agt_/);
  assert.equal(structured.status, "starting");
  assert.equal(structured.fallbackUsed, true);
  assert.equal(structured.chosenProvider, "reviewer");
  assert.equal(structured.chosenProfile, "reviewer");
});

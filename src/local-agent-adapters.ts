import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ActiveSession, ClientContext } from "@agentclientprotocol/sdk";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { buildSafeChildEnvironment } from "./process-environment.js";
import { projectBrowserMcpServerConfig } from "./project-browser.js";
import { createLunaSecretStore, type LunaSecretStore } from "./luna-secret.js";
import {
  createCodexSdkLocalAgentRuntime,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
  type LocalAgentRuntime,
} from "./local-agent-runtime.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

export interface LocalAgentAdapterOptions {
  /** Explicit child-only environment additions for controlled integrations/tests. */
  childEnvironment?: NodeJS.ProcessEnv;
  /** Luna key supplied by the trusted parent process over a private worker pipe. */
  lunaApiKey?: string;
  /** Injectable secret store for the OpenAI Luna adapter. */
  lunaSecretStore?: LunaSecretStore;
  /** Injectable runtime factory so Luna policy can be tested without live API calls. */
  lunaRuntimeFactory?: (apiKey: string, workspace: string) => Promise<LocalAgentRuntime>;
}

export type AcpLocalAgentProvider = "cursor" | "copilot" | "kimi";

export const OPENAI_LUNA_MODEL = "gpt-5.6-luna";
export const OPENAI_LUNA_DEFAULT_EFFORT = "medium";
const OPENAI_LUNA_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const PI_AGENT_DEFAULT_TIMEOUT_MS = 120_000;
const PI_AGENT_MIN_TIMEOUT_MS = 1_000;
const PI_AGENT_MAX_TIMEOUT_MS = 3_600_000;

export function resolvePiAgentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEVSPACE_PI_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return PI_AGENT_DEFAULT_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid DEVSPACE_PI_TIMEOUT_MS: ${raw}. Expected a positive integer number of milliseconds.`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < PI_AGENT_MIN_TIMEOUT_MS || value > PI_AGENT_MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid DEVSPACE_PI_TIMEOUT_MS: ${raw}. Expected between ${PI_AGENT_MIN_TIMEOUT_MS} and ${PI_AGENT_MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

export function acpCommandFor(
  provider: AcpLocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): [string, ...string[]] {
  switch (provider) {
    case "cursor":
      return [env.CURSOR_COMMAND ?? "cursor-agent", "acp"];
    case "copilot":
      return [env.COPILOT_COMMAND ?? "copilot", "--acp"];
    case "kimi":
      return [env.KIMI_COMMAND ?? env.LUNA_COMMAND ?? "kimi", "acp"];
  }
}

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input);
}

export function createLocalAgentAdapter(
  provider: LocalAgentProvider,
  options: LocalAgentAdapterOptions = {},
): LocalAgentAdapter {
  switch (provider) {
    case "luna":
      return new OpenAiLunaLocalAgentAdapter(
        options.lunaSecretStore ?? createLunaSecretStore(),
        options.lunaRuntimeFactory ?? createOpenAiLunaRuntime,
        options.lunaApiKey,
      );
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
    case "kimi":
      return new AcpLocalAgentAdapter(provider, options.childEnvironment);
  }
}

async function createOpenAiLunaRuntime(apiKey: string, workspace: string): Promise<LocalAgentRuntime> {
  const safeEnv = buildSafeChildEnvironment();
  const stateDir = process.env.DEVSPACE_STATE_DIR ?? join(homedir(), ".local", "share", "devspace");
  const codexHome = join(stateDir, "providers", "openai-luna", "codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  safeEnv.CODEX_HOME = codexHome;

  return createCodexSdkLocalAgentRuntime({
    apiKey,
    env: Object.fromEntries(
      Object.entries(safeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    config: {
      allow_login_shell: false,
      shell_environment_policy: {
        inherit: "core",
        exclude: ["^(CODEX_API_KEY|OPENAI_API_KEY|DEVSPACE_OAUTH_OWNER_TOKEN)$"],
      },
      ...lunaProjectUiMcpConfig(workspace, stateDir),
    },
  });
}

export function lunaProjectUiMcpConfig(
  workspace: string,
  stateDir: string = process.env.DEVSPACE_STATE_DIR ?? join(homedir(), ".local", "share", "devspace"),
  options: { playwrightMcpCliPath?: string } = {},
): Record<string, unknown> {
  const root = resolve(workspace);
  const helperPath = fileURLToPath(new URL("./luna-project-tools-server.js", import.meta.url));
  return {
    mcp_servers: {
      devspace_browser: projectBrowserMcpServerConfig(root, stateDir, {
        playwrightMcpCliPath: options.playwrightMcpCliPath,
      }),
      devspace_xcode: {
        command: process.execPath,
        args: [helperPath],
        cwd: root,
        env: {
          DEVSPACE_LUNA_WORKSPACE_ROOT: root,
        },
        startup_timeout_sec: 10,
        tool_timeout_sec: 600,
      },
    },
  };
}

class OpenAiLunaLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "luna" as const;

  constructor(
    private readonly secrets: LunaSecretStore,
    private readonly runtimeFactory: (apiKey: string, workspace: string) => Promise<LocalAgentRuntime>,
    private readonly apiKey?: string,
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (input.model && input.model !== OPENAI_LUNA_MODEL) {
      throw new Error(
        `OpenAI Luna workers are hard-locked to ${OPENAI_LUNA_MODEL}; refusing model ${input.model}.`,
      );
    }
    const thinking = input.thinking ?? OPENAI_LUNA_DEFAULT_EFFORT;
    if (!OPENAI_LUNA_EFFORTS.has(thinking)) {
      throw new Error(
        `Unsupported OpenAI Luna reasoning effort '${thinking}'. Use low, medium, high, or xhigh.`,
      );
    }

    const apiKey = this.apiKey ?? this.secrets.read();
    const runtime = await this.runtimeFactory(apiKey, input.workspace);
    const result = await runtime.run({
      ...input,
      model: OPENAI_LUNA_MODEL,
      thinking,
    });
    return { ...result, provider: this.provider };
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createCodexSdkLocalAgentRuntime();
    return runtime.run(input);
  }
}

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const claudeExecutable = process.env.CLAUDE_COMMAND ?? resolveExecutable("claude");
    const messages = query({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        ...(input.thinking ? { thinking: { type: "adaptive" } as const, effort: input.thinking as EffortLevel } : {}),
        resume: input.providerSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: claudeCommandEnvironment(process.env),
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      },
    });

    let providerSessionId = input.providerSessionId ?? null;
    let finalResponse = "";
    const items: unknown[] = [];
    for await (const message of messages) {
      items.push(message);
      const record = message as Record<string, unknown>;
      if (typeof record.session_id === "string") providerSessionId = record.session_id;
      if (record.type === "result" && typeof record.result === "string") {
        const resultError = claudeResultError(record);
        if (resultError) throw new Error(resultError);
        finalResponse = record.result;
      }
    }

    finalResponse = requireFinalResponse("Claude", finalResponse);
    return {
      provider: this.provider,
      providerSessionId,
      finalResponse,
      items,
    };
  }
}

function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
  const isError = record.is_error === true || subtype?.startsWith("error");
  if (!isError) return undefined;
  const message =
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";
  return `Claude returned an error result: ${message}`;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveExecutable(command: string): string | undefined {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", [
    ...(process.platform === "win32" ? [command] : ["-v", command]),
  ], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildSafeChildEnvironment({
    source: env,
    includeProviderCommands: true,
  });
}

class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const { client, server } = await createOpencode();
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(client, input);
      const promptResult = await promptOpencodeSession(client, sessionId, input);
      await waitForOpencodeSession(client, sessionId);
      const messages = await readOpencodeMessages(client, sessionId);
      const finalResponse = requireFinalResponse(
        "OpenCode",
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
      };
    } finally {
      server.close();
    }
  }
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: AcpLocalAgentProvider,
    private readonly childEnvironment?: NodeJS.ProcessEnv,
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { client } = await import("@agentclientprotocol/sdk");
    const { methods } = await import("@agentclientprotocol/sdk");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = acpCommandFor(this.provider);
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: buildSafeChildEnvironment({
        includeProviderCommands: true,
        extra: this.childEnvironment,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // A missing or non-executable provider binary surfaces as an asynchronous
    // ChildProcess 'error' event. Turn it into a normal run failure instead of
    // an unhandled event that would crash the CLI worker process.
    const childStartupError = new Promise<never>((_resolve, reject) => {
      child.once("error", (error: Error) => {
        reject(new Error(`${command} failed to start: ${error.message}`));
      });
    });
    childStartupError.catch(() => {});

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      let providerSessionId = input.providerSessionId ?? null;
      const finalResponse = await Promise.race([
        client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .connectWith(stream, async (context) => {
          const session = input.providerSessionId
            ? await loadExistingAcpSession(context, this.provider, input.workspace, input.providerSessionId)
            : await context.buildSession(input.workspace).start();
          providerSessionId = session.sessionId;
          try {
            if (input.model) {
              const config = resolveAcpModelConfigUpdate(session, input.model, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            if (input.thinking) {
              const config = resolveAcpThinkingConfigUpdate(session, input.thinking, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            const prompt = session.prompt(input.prompt);
            const textParts: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                await prompt;
                return textParts.join("").trim();
              }

              const update = message.update;
              if (update.sessionUpdate !== "agent_message_chunk") continue;
              const content = update.content;
              if (content.type === "text") textParts.push(content.text);
            }
          } finally {
            session.dispose();
          }
        }),
        childStartupError,
      ]);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse: finalResponse.trim(),
        items: [],
      };
    } catch (error) {
      throw new Error(`${this.provider} ACP run failed: ${errorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`);
    } finally {
      child.kill();
    }
  }
}

/**
 * Resumes an existing ACP conversation through `session/load` and attaches the
 * SDK's update routing to the loaded session.
 *
 * A failed load must never fall back to a fresh session: the caller relies on
 * the stored providerSessionId for conversation continuity, and silently
 * starting over would lose context while reporting success.
 */
async function loadExistingAcpSession(
  context: ClientContext,
  provider: string,
  cwd: string,
  sessionId: string,
): Promise<ActiveSession> {
  let loadResponse: unknown;
  try {
    loadResponse = await context.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
  } catch (error) {
    throw new Error(
      `${provider} could not load ACP session '${sessionId}': ${errorMessage(error)}. ` +
        "The follow-up was not started and no new session was created.",
    );
  }

  // The SDK only exposes its ActiveSession helper for `session/new` responses.
  // `session/load` responses omit the session id (the client already knows it),
  // so reattach it before handing the response to the same attach machinery.
  const attacher = context as unknown as {
    attachSession(response: Record<string, unknown>): ActiveSession;
  };
  return attacher.attachSession({ sessionId, ...(asRecord(loadResponse) ?? {}) });
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
  });
}

export function resolveAcpThinkingConfigUpdate(
  session: unknown,
  thinking: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "thinking option",
    provider,
    value: thinking,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session did not return session metadata.`);
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);

  const response = asRecord(record.newSessionResponse);
  const configOptions = response ? readArray(response, "configOptions") ?? [] : [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) {
    throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  }

  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);

  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value: options.value };
}

function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

function selectAcpAllowPermissionOption(options: Array<{ optionId: string; kind: string }>): { optionId: string } | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

class PiRpcLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.thinking) args.push("--thinking", input.thinking);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const child = spawn(process.env.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const rpc = new JsonLineRpc(child);
    const events: unknown[] = [];
    rpc.onEvent((event) => events.push(event));
    try {
      const state = await rpc.request({ type: "get_state" });
      const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
      const done = rpc.waitForEvent((event) => asRecord(event)?.type === "agent_end", resolvePiAgentTimeoutMs());
      await rpc.request({ type: "prompt", message: input.prompt });
      const agentEnd = await done;
      const sessionMessages = await rpc.request({ type: "get_messages" });
      const finalResponse =
        extractPiFinalResponse(agentEnd) ||
        extractPiFinalResponse(sessionMessages) ||
        extractPiStreamingText(events);
      if (!finalResponse) {
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          extractPiProviderError(events);
        if (providerError) throw new Error(`Pi returned an error: ${providerError}`);
      }
      requireFinalResponse("Pi", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
        items: [...events, sessionMessages],
      };
    } finally {
      child.kill();
    }
  }
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = buildSafeChildEnvironment({
    source: env,
    includeProviderCommands: true,
  });
  if (next.PI_COMMAND) return next;
  const path = next.PATH;
  if (!path) return next;

  return {
    ...next,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: unknown) => void>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: unknown) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  waitForEvent(predicate: (event: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderr += `${line}\n`;
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${line}`));
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const sessionClient = client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  };
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSession(
  client: unknown,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  const session = (client as {
    session: {
      prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session;
  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    prompt: { parts: [{ type: "text", text: input.prompt }] },
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
    ...(input.thinking ? { variant: input.thinking } : {}),
  };
  return session.prompt(promptInput, { throwOnError: true });
}

async function waitForOpencodeSession(client: unknown, sessionId: string): Promise<void> {
  const session = (client as {
    session?: { wait?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.wait) return;
  await session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(client: unknown, sessionId: string): Promise<unknown> {
  const session = (client as {
    session?: {
      messages?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
    };
  }).session;
  if (!session?.messages) return undefined;
  return session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

export function extractPiFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: unknown[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return typeof update.delta === "string" ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: unknown): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return typeof error === "string" ? error.trim() : "";
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function extractPiAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}

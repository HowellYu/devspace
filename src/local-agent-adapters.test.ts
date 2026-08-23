import assert from "node:assert/strict";
import { delimiter } from "node:path";
import {
  claudeCommandEnvironment,
  createLocalAgentAdapter,
  lunaProjectUiMcpConfig,
  OPENAI_LUNA_MODEL,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  extractPiStreamingText,
  piCommandEnvironment,
  resolveAcpModelConfigUpdate,
  resolveAcpThinkingConfigUpdate,
  resolvePiAgentTimeoutMs,
} from "./local-agent-adapters.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

const providers: LocalAgentProvider[] = [
  "luna",
  "kimi",
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

for (const provider of providers) {
  const adapter = createLocalAgentAdapter(provider);
  assert.equal(adapter.provider, provider);
  assert.equal(typeof adapter.run, "function");
}

{
  let readCount = 0;
  let runtimeKey = "";
  let runtimeWorkspace = "";
  let runtimeInput: unknown;
  const adapter = createLocalAgentAdapter("luna", {
    lunaSecretStore: {
      available: () => true,
      read: () => { readCount += 1; return "sk-test-luna"; },
      setInteractive: () => {},
      delete: () => true,
    },
    lunaRuntimeFactory: async (apiKey, workspace) => {
      runtimeKey = apiKey;
      runtimeWorkspace = workspace;
      return {
        provider: "fake-codex-runtime",
        run: async (input) => {
          runtimeInput = input;
          return {
            provider: "fake-codex-runtime",
            providerSessionId: "luna-session-1",
            finalResponse: "done",
            items: [],
          };
        },
      };
    },
  });
  const result = await adapter.run({
    prompt: "implement it",
    workspace: "/tmp/project",
    thinking: "high",
    writeMode: "allowed",
  });
  assert.equal(readCount, 1);
  assert.equal(runtimeKey, "sk-test-luna");
  assert.equal(runtimeWorkspace, "/tmp/project");
  assert.deepEqual(runtimeInput, {
    prompt: "implement it",
    workspace: "/tmp/project",
    thinking: "high",
    writeMode: "allowed",
    model: OPENAI_LUNA_MODEL,
  });
  assert.equal(result.provider, "luna");
  assert.equal(result.providerSessionId, "luna-session-1");

  const uiConfig = lunaProjectUiMcpConfig("/tmp/project", "/tmp/devspace-state", {
    playwrightMcpCliPath: "/devspace/node_modules/@playwright/mcp/cli.js",
  });
  const mcpServers = uiConfig.mcp_servers as Record<string, Record<string, unknown>>;
  const browser = mcpServers.devspace_browser;
  const xcode = mcpServers.devspace_xcode;
  assert.equal(browser.command, process.execPath);
  assert.equal(browser.cwd, "/tmp/project");
  assert.ok((browser.args as string[]).includes("--browser=chromium"));
  assert.ok((browser.args as string[]).includes("--image-responses=omit"));
  assert.doesNotMatch((browser.args as string[]).join(" "), /--extension|--cdp-endpoint|Google Chrome\.app/);
  assert.deepEqual(browser.env, { PLAYWRIGHT_BROWSERS_PATH: "0" });
  assert.equal(xcode.command, process.execPath);
  assert.equal(xcode.cwd, "/tmp/project");
  assert.deepEqual(xcode.env, { DEVSPACE_LUNA_WORKSPACE_ROOT: "/tmp/project" });
  assert.match(String((xcode.args as string[])[0]), /luna-project-tools-server\.js$/);
  assert.equal(mcpServers.devspace_project_ui, undefined);

  await assert.rejects(
    () => adapter.run({ prompt: "bad", workspace: "/tmp/project", model: "gpt-5.6-sol" }),
    /hard-locked to gpt-5\.6-luna/,
  );
  await assert.rejects(
    () => adapter.run({ prompt: "bad", workspace: "/tmp/project", thinking: "ultra" }),
    /Unsupported OpenAI Luna reasoning effort/,
  );
}

{
  let readCount = 0;
  let runtimeKey = "";
  const adapter = createLocalAgentAdapter("luna", {
    lunaApiKey: "parent-pipe-key",
    lunaSecretStore: {
      available: () => true,
      read: () => { readCount += 1; return "should-not-be-read"; },
      setInteractive: () => {},
      delete: () => true,
    },
    lunaRuntimeFactory: async (apiKey, workspace) => {
      runtimeKey = `${apiKey}:${workspace}`;
      return { provider: "fake", run: async () => ({ provider: "fake", providerSessionId: "pipe-session", finalResponse: "done", items: [] }) };
    },
  });
  await adapter.run({ prompt: "read only", workspace: "/tmp/project" });
  assert.equal(runtimeKey, "parent-pipe-key:/tmp/project");
  assert.equal(readCount, 0);
}

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [
            { value: "claude-sonnet-4.5", name: "Sonnet" },
            { value: "gpt-5.4", name: "GPT 5.4" },
          ],
        },
      ],
    },
  }, "gpt-5.4", "cursor"),
  { sessionId: "session_model_1", configId: "model", value: "gpt-5.4" },
);

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model_config",
          category: "model",
          options: [
            {
              group: "claude",
              name: "Claude",
              options: [
                { value: "claude-sonnet-4.5", name: "Sonnet" },
                { value: "claude-opus-4.5", name: "Opus" },
              ],
            },
          ],
        },
      ],
    },
  }, "claude-opus-4.5", "copilot"),
  { sessionId: "session_model_2", configId: "model_config", value: "claude-opus-4.5" },
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [{ value: "gpt-5.4", name: "GPT 5.4" }],
        },
      ],
    },
  }, "unknown-model", "cursor"),
  /Available values: gpt-5\.4/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate(undefined, "gpt-5.4", "cursor"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({ newSessionResponse: { configOptions: [] } }, "gpt-5.4", "cursor"),
  /session id/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_4",
    newSessionResponse: { configOptions: [] },
  }, "gpt-5.4", "cursor"),
  /does not expose a model/,
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "effort",
          category: "thought_level",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
  }, "high", "cursor"),
  { sessionId: "session_1", configId: "effort", value: "high" },
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [
            {
              group: "reasoning",
              name: "Reasoning",
              options: [
                { value: "medium", name: "Medium" },
                { value: "xhigh", name: "X High" },
              ],
            },
          ],
        },
      ],
    },
  }, "xhigh", "copilot"),
  { sessionId: "session_2", configId: "thoughts", value: "xhigh" },
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [{ value: "low", name: "Low" }],
        },
      ],
    },
  }, "max", "cursor"),
  /Available values: low/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate(undefined, "high", "copilot"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({ newSessionResponse: { configOptions: [] } }, "high", "copilot"),
  /session id/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_4",
    newSessionResponse: { configOptions: [] },
  }, "high", "copilot"),
  /does not expose a thinking option/,
);

{
  const env = claudeCommandEnvironment({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_AGENT_SDK_VERSION: "test",
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "do-not-leak",
    SSH_AUTH_SOCK: "/tmp/do-not-leak.sock",
  });

  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
  assert.equal(env.CLAUDE_AGENT_SDK_VERSION, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PATH, "/usr/bin");
}

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        info: { id: "msg_user", role: "user" },
        parts: [{ type: "text", text: "Review the change." }],
      },
      {
        info: { id: "msg_assistant", role: "assistant" },
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "grep", input: { pattern: "secret" }, output: "src/foo.ts" },
          { type: "text", text: "Final OpenCode response." },
        ],
      },
    ],
  }),
  "Final OpenCode response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        id: "msg_user",
        type: "user",
        text: "Review the change.",
      },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", name: "grep", state: { status: "completed", result: "src/foo.ts" } },
          { type: "text", text: "Final OpenCode v2 response." },
        ],
      },
    ],
  }),
  "Final OpenCode v2 response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: {
        id: "msg_structured",
        role: "assistant",
        structured: { summary: "structured answer" },
      },
      parts: [{ type: "reasoning", text: "thinking" }],
    },
  }),
  '{"summary":"structured answer"}',
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: { id: "msg_tool_only", role: "assistant" },
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", tool: "bash", input: { command: "cat src/secret.ts" }, output: "secret" },
      ],
    },
  }),
  "",
);

assert.equal(
  extractPiFinalResponse({
    data: {
      messages: [
        { role: "user", content: "Review the change." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/foo.ts" } },
            { type: "text", text: "Final Pi response." },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "tool output" }],
        },
      ],
    },
  }),
  "Final Pi response.",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first part" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
          { type: "text", text: "second part" },
        ],
      },
    ],
  }),
  "first part\n\nsecond part",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: "secret output" },
      { role: "bashExecution", command: "cat src/secret.ts", output: "secret output", timestamp: 1 },
    ],
  }),
  "",
);

assert.equal(
  extractPiProviderError({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
      },
    ],
  }),
  "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
);

assert.equal(
  extractPiStreamingText([
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Final " }] },
      assistantMessageEvent: { type: "text_delta", delta: "Final " },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Pi response." }] },
      assistantMessageEvent: { type: "text_delta", delta: "Pi response." },
    },
  ]),
  "Final Pi response.",
);

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const userBin = "/home/user/.local/bin";
  assert.equal(
    removeDevspaceNodeModulesBinFromPath([devspaceBin, userBin].join(delimiter)),
    userBin,
  );

  const env = piCommandEnvironment({
    PATH: [devspaceBin, userBin].join(delimiter),
  });

  assert.equal(env.PATH, userBin);
}

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const env = piCommandEnvironment({
    PI_COMMAND: "/custom/pi",
    PATH: [devspaceBin, "/home/user/.local/bin"].join(delimiter),
  });

  assert.equal(env.PATH, [devspaceBin, "/home/user/.local/bin"].join(delimiter));
}

// DEVSPACE_PI_TIMEOUT_MS parsing.

assert.equal(resolvePiAgentTimeoutMs({}), 120_000);
assert.equal(resolvePiAgentTimeoutMs({ DEVSPACE_PI_TIMEOUT_MS: "" }), 120_000);
assert.equal(resolvePiAgentTimeoutMs({ DEVSPACE_PI_TIMEOUT_MS: "300000" }), 300_000);
assert.equal(resolvePiAgentTimeoutMs({ DEVSPACE_PI_TIMEOUT_MS: " 45000 " }), 45_000);
assert.equal(resolvePiAgentTimeoutMs({ DEVSPACE_PI_TIMEOUT_MS: "3600000" }), 3_600_000);

for (const invalid of ["abc", "10.5", "-5", "0", "500", "3600001", "99999999999"]) {
  assert.throws(
    () => resolvePiAgentTimeoutMs({ DEVSPACE_PI_TIMEOUT_MS: invalid }),
    /Invalid DEVSPACE_PI_TIMEOUT_MS/,
  );
}

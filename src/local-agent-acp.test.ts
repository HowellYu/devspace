import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpCommandFor, createLocalAgentAdapter } from "./local-agent-adapters.js";

// Command resolution: defaults and env overrides.

assert.deepEqual(acpCommandFor("cursor", {}), ["cursor-agent", "acp"]);
assert.deepEqual(acpCommandFor("copilot", {}), ["copilot", "--acp"]);
assert.deepEqual(acpCommandFor("kimi", {}), ["kimi", "acp"]);
assert.deepEqual(
  acpCommandFor("cursor", { CURSOR_COMMAND: "/opt/tools/cursor-agent" }),
  ["/opt/tools/cursor-agent", "acp"],
);
assert.deepEqual(
  acpCommandFor("copilot", { COPILOT_COMMAND: "/opt/tools/gh-copilot" }),
  ["/opt/tools/gh-copilot", "--acp"],
);
assert.deepEqual(
  acpCommandFor("kimi", { KIMI_COMMAND: "/opt/kimi/bin/kimi" }),
  ["/opt/kimi/bin/kimi", "acp"],
);

// ACP lifecycle integration against the fake agent. The fake speaks real ACP
// over stdio and persists sessions to disk, so separate adapter runs behave
// like separate `devspace agents run` invocations against one provider.

if (process.platform !== "win32") {
  const fixturePath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
  const sandbox = mkdtempSync(join(tmpdir(), "devspace-acp-test-"));
  const workspace = join(sandbox, "workspace");
  mkdirSync(workspace, { recursive: true });
  const storePath = join(sandbox, "fake-store.json");
  const eventsPath = join(sandbox, "fake-events.log");
  const shimPath = join(sandbox, "fake-acp-shim.sh");

  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);

  const savedEnv = { ...process.env };
  process.env.CURSOR_COMMAND = shimPath;
  process.env.FAKE_ACP_STORE = storePath;
  process.env.FAKE_ACP_EVENTS = eventsPath;
  delete process.env.FAKE_ACP_STDERR;
  delete process.env.FAKE_ACP_CONFIG_OPTIONS;

  const readStore = () => JSON.parse(readFileSync(storePath, "utf8"));

  async function waitForEvent(text: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for fake agent event: ${text}`);
  }

  const adapter = createLocalAgentAdapter("cursor");

  try {
    // 1. A new run uses session/new and returns the provider session id.
    const first = await adapter.run({
      prompt: "remember marker zebra-4217",
      workspace,
    });
    assert.equal(first.provider, "cursor");
    assert.equal(first.providerSessionId, "fake-session-1");
    assert.equal(first.finalResponse, "ack: remember marker zebra-4217");
    {
      const store = readStore();
      assert.equal(store.newCalls, 1);
      assert.equal(store.loadCalls, 0);
    }

    // 2. A follow-up uses session/load, keeps the session id stable, routes
    //    session updates on the loaded session, and retains first-turn context.
    const followUp = await adapter.run({
      prompt: "recall the marker",
      workspace,
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(followUp.providerSessionId, "fake-session-1");
    assert.equal(followUp.finalResponse, "recalled: remember marker zebra-4217");
    {
      const store = readStore();
      assert.equal(store.newCalls, 1);
      assert.equal(store.loadCalls, 1);
      assert.deepEqual(Object.keys(store.sessions), ["fake-session-1"]);
    }

    // 3. A failed load reports the session id, includes provider stderr, and
    //    never silently creates a fresh session.
    process.env.FAKE_ACP_STDERR = "fake diagnostic output";
    await assert.rejects(
      adapter.run({
        prompt: "continue",
        workspace,
        providerSessionId: "fake-session-999",
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not load ACP session 'fake-session-999'/);
        assert.match(error.message, /no new session was created/);
        assert.match(error.message, /fake diagnostic output/);
        return true;
      },
    );
    delete process.env.FAKE_ACP_STDERR;
    {
      const store = readStore();
      assert.equal(store.newCalls, 1);
      assert.deepEqual(Object.keys(store.sessions), ["fake-session-1"]);
    }

    // 4. Model and thinking config options resolve on a loaded session.
    process.env.FAKE_ACP_CONFIG_OPTIONS = JSON.stringify([
      {
        type: "select",
        id: "model",
        category: "model",
        options: [{ value: "fake-model-a" }, { value: "fake-model-b" }],
      },
      {
        type: "select",
        id: "effort",
        category: "thought_level",
        options: [{ value: "high" }, { value: "xhigh" }],
      },
    ]);
    const configured = await adapter.run({
      prompt: "apply config",
      workspace,
      providerSessionId: "fake-session-1",
      model: "fake-model-b",
      thinking: "xhigh",
    });
    assert.equal(configured.finalResponse, "ack: apply config");
    {
      const store = readStore();
      assert.deepEqual(store.setConfigOptionCalls, [
        { sessionId: "fake-session-1", configId: "model", value: "fake-model-b" },
        { sessionId: "fake-session-1", configId: "effort", value: "xhigh" },
      ]);
    }
    delete process.env.FAKE_ACP_CONFIG_OPTIONS;

    // 5. The child process is terminated after each run.
    await waitForEvent("sigterm");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    rmSync(sandbox, { recursive: true, force: true });
  }

  // Kimi runs through the same generic ACP adapter, resolved via KIMI_COMMAND,
  // including loaded-session follow-ups.
  {
    const kimiSandbox = mkdtempSync(join(tmpdir(), "devspace-acp-kimi-test-"));
    const kimiWorkspace = join(kimiSandbox, "workspace");
    mkdirSync(kimiWorkspace, { recursive: true });
    const kimiStorePath = join(kimiSandbox, "fake-store.json");
    const kimiShim = join(kimiSandbox, "fake-kimi-shim.sh");
    writeFileSync(
      kimiShim,
      `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(kimiShim, 0o755);

    process.env.KIMI_COMMAND = kimiShim;
    process.env.FAKE_ACP_STORE = kimiStorePath;
    delete process.env.FAKE_ACP_EVENTS;
    try {
      const kimi = createLocalAgentAdapter("kimi");
      assert.equal(kimi.provider, "kimi");

      const first = await kimi.run({
        prompt: "remember token quokka-99",
        workspace: kimiWorkspace,
      });
      assert.equal(first.providerSessionId, "fake-session-1");

      const followUp = await kimi.run({
        prompt: "recall the token",
        workspace: kimiWorkspace,
        providerSessionId: first.providerSessionId ?? undefined,
      });
      assert.equal(followUp.providerSessionId, "fake-session-1");
      assert.equal(followUp.finalResponse, "recalled: remember token quokka-99");

      const store = JSON.parse(readFileSync(kimiStorePath, "utf8"));
      assert.equal(store.newCalls, 1);
      assert.equal(store.loadCalls, 1);
    } finally {
      delete process.env.KIMI_COMMAND;
      delete process.env.FAKE_ACP_STORE;
      rmSync(kimiSandbox, { recursive: true, force: true });
    }
  }
}

console.log("local-agent-acp tests passed");

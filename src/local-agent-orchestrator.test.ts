import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import {
  createLocalAgentOrchestrator,
  parseAgentsExecutionTimeoutSeconds,
  type LocalAgentOrchestrator,
} from "./local-agent-orchestrator.js";

const ALL_AVAILABLE: LocalAgentProviderAvailability[] = [
  "codex", "claude", "opencode", "pi", "cursor", "copilot", "luna",
].map((name) => ({ name: name as LocalAgentProvider, available: true }));

interface RunCapture {
  provider: LocalAgentProvider;
  input: LocalAgentRunInput;
}

function fakeRunProvider(captures: RunCapture[]): (
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
) => Promise<LocalAgentRunResult> {
  return async (provider, input) => {
    captures.push({ provider, input });
    const sessionId = input.providerSessionId ?? `session_${captures.length}`;
    return {
      provider,
      providerSessionId: sessionId,
      finalResponse: `response:${input.prompt}`,
      items: [],
    };
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-orchestrator-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  const configDir = join(root, ".config");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(project, ".devspace", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Reviews project changes.", "provider: codex", "---", "Review changes."].join("\n"),
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "true",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new LocalAgentStore(stateDir);
  const captures: RunCapture[] = [];
  const orchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: async (recordId: string, promptFile: string) => {
      setTimeout(() => orchestrator.executeWorker(recordId, promptFile), 0);
    },
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });

  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  return { root, project, config, orchestrator, store, captures };
}

test("start creates a worker, wait returns the final response", async (t) => {
  const { project, orchestrator, captures } = await fixture(t);
  const { record } = await orchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "check the code",
  });

  assert.match(record.id, /^agt_/);
  assert.equal(record.profileName, "reviewer");
  assert.equal(record.provider, "codex");
  assert.equal(record.executionTimeoutSeconds, 600);

  const waited = await orchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "idle");
  assert.equal(waited.record.latestResponse, "response:Review changes.\n\nTask:\ncheck the code");
  assert.equal(waited.timedOut, false);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].provider, "codex");
  assert.equal(captures[0].input.providerSessionId, undefined);
});

test("continue resumes the same provider session id", async (t) => {
  const { project, orchestrator, captures } = await fixture(t);
  const { record } = await orchestrator.start({
    workspaceRoot: project,
    target: "codex",
    prompt: "first",
  });
  await orchestrator.wait(record.id, 5);

  const continued = await orchestrator.continue(record.id, {
    prompt: "second",
    executionTimeoutSeconds: 1200,
  });
  assert.equal(continued.id, record.id);
  assert.equal(continued.executionTimeoutSeconds, 1200);
  await orchestrator.wait(record.id, 5);

  assert.equal(captures.length, 2);
  assert.equal(captures[0].input.providerSessionId, undefined);
  assert.equal(captures[0].provider, "codex");
  assert.equal(captures[1].input.providerSessionId, captures[0].input.providerSessionId ?? "session_1");
  assert.equal(captures[1].provider, "codex");
});

test("start with an unavailable provider and fallback disabled fails", async (t) => {
  const { project, config, store } = await fixture(t);
  const availability = ALL_AVAILABLE.map((entry) =>
    entry.name === "pi" ? { name: entry.name, available: false, reason: "missing" } : entry,
  );
  const orchestrator = createLocalAgentOrchestrator(config, store, {
    spawnWorker: async () => {},
    refreshAvailability: () => availability,
    checkProviderAvailability: (provider) => availability.find((entry) => entry.name === provider)!,
  });

  await assert.rejects(
    () => orchestrator.start({
      workspaceRoot: project,
      target: "pi",
      prompt: "do work",
      fallback: false,
    }),
    /pi provider is not available/,
  );
});

test("fallback defaults on and picks the first available built-in provider", async (t) => {
  const { project, config, store, captures } = await fixture(t);
  const availability = ALL_AVAILABLE.map((entry) =>
    entry.name === "pi" ? { name: entry.name, available: false, reason: "missing" } : entry,
  );
  let orchestrator: LocalAgentOrchestrator;
  orchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: async (recordId, promptFile) => {
      setTimeout(() => orchestrator.executeWorker(recordId, promptFile), 0);
    },
    refreshAvailability: () => availability,
    checkProviderAvailability: (provider) => availability.find((entry) => entry.name === provider)!,
  });

  const { record, fallbackUsed } = await orchestrator.start({
    workspaceRoot: project,
    target: "pi",
    prompt: "do work",
  });

  assert.equal(fallbackUsed, true);
  assert.equal(record.provider, "codex");
  assert.equal(record.fallbackEnabled, true);
  const waited = await orchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "idle");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].provider, "codex");
});

test("continue refuses to start a second process for an active worker", async (t) => {
  const { project, config, store } = await fixture(t);
  const orchestrator = createLocalAgentOrchestrator(config, store, {
    spawnWorker: async () => {},
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });
  const { record } = await orchestrator.start({
    workspaceRoot: project,
    target: "codex",
    prompt: "first",
  });
  await assert.rejects(
    () => orchestrator.continue(record.id, { prompt: "duplicate" }),
    /already starting/,
  );
});

test("global concurrency limit rejects additional active workers", async (t) => {
  const { project, config, store } = await fixture(t);
  const orchestrator = createLocalAgentOrchestrator({ ...config, agentsMaxConcurrent: 1 }, store, {
    spawnWorker: async () => {},
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });
  await orchestrator.start({ workspaceRoot: project, target: "codex", prompt: "first" });
  await assert.rejects(
    () => orchestrator.start({ workspaceRoot: project, target: "claude", prompt: "second" }),
    /concurrency limit reached \(1\/1\)/,
  );
});

test("first-turn quota failure falls back to another available provider", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  const runProvider = async (provider: LocalAgentProvider, input: LocalAgentRunInput): Promise<LocalAgentRunResult> => {
    captures.push({ provider, input });
    if (provider === "codex") throw new Error("quota exhausted for current billing cycle");
    return {
      provider,
      providerSessionId: "fallback_session",
      finalResponse: "fallback-ok",
      items: [],
    };
  };
  let orchestrator: LocalAgentOrchestrator;
  orchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider,
    spawnWorker: async (recordId, promptFile) => {
      setTimeout(() => orchestrator.executeWorker(recordId, promptFile), 0);
    },
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });

  const { record } = await orchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "review it",
  });
  const waited = await orchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "idle");
  assert.equal(waited.record.provider, "claude");
  assert.equal(waited.record.latestResponse, "fallback-ok");
  assert.deepEqual(captures.map((capture) => capture.provider), ["codex", "claude"]);
  assert.equal(captures[1].input.model, undefined);
  assert.equal(captures[1].input.thinking, undefined);
  assert.match(captures[1].input.prompt, /Review changes\.\n\nTask:\nreview it/);
});

test("runtime fallback never moves an existing provider session", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  let failWithQuota = false;
  const runProvider = async (provider: LocalAgentProvider, input: LocalAgentRunInput): Promise<LocalAgentRunResult> => {
    captures.push({ provider, input });
    if (failWithQuota) throw new Error("quota exhausted for billing cycle");
    return {
      provider,
      providerSessionId: "stable_session",
      finalResponse: "first-ok",
      items: [],
    };
  };
  let orchestrator: LocalAgentOrchestrator;
  orchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider,
    spawnWorker: async (recordId, promptFile) => {
      setTimeout(() => orchestrator.executeWorker(recordId, promptFile), 0);
    },
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });

  const { record } = await orchestrator.start({ workspaceRoot: project, target: "codex", prompt: "first" });
  assert.equal((await orchestrator.wait(record.id, 5)).record.status, "idle");
  failWithQuota = true;
  await orchestrator.continue(record.id, { prompt: "second" });
  const waited = await orchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "error");
  assert.equal(waited.record.provider, "codex");
  assert.deepEqual(captures.map((capture) => capture.provider), ["codex", "codex"]);
  assert.equal(captures[1].input.providerSessionId, "stable_session");
});

test("runtime fallback does not mask non-capacity provider errors", async (t) => {
  const { project, config, store } = await fixture(t);
  let orchestrator: LocalAgentOrchestrator;
  orchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: async () => { throw new Error("authentication denied"); },
    spawnWorker: async (recordId, promptFile) => {
      setTimeout(() => orchestrator.executeWorker(recordId, promptFile), 0);
    },
    refreshAvailability: () => ALL_AVAILABLE,
    checkProviderAvailability: (provider) => ({ name: provider, available: true }),
  });
  const { record } = await orchestrator.start({ workspaceRoot: project, target: "codex", prompt: "work" });
  const waited = await orchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "error");
  assert.equal(waited.record.provider, "codex");
  assert.match(waited.record.error ?? "", /authentication denied/);
});

test("inspect returns status, provider, profile, and latest response", async (t) => {
  const { project, orchestrator } = await fixture(t);
  const { record } = await orchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "check it",
  });
  await orchestrator.wait(record.id, 5);

  const inspected = await orchestrator.inspect(record.id);
  assert.equal(inspected.record.id, record.id);
  assert.equal(inspected.record.status, "idle");
  assert.equal(inspected.record.provider, "codex");
  assert.equal(inspected.record.profileName, "reviewer");
  assert.ok(inspected.record.latestResponse?.includes("check it"));
});

test("wait returns timedOut true for a still-running worker", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  const noOpOrchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: async () => {},
  });
  const { record } = await noOpOrchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "slow task",
  });

  assert.equal(noOpOrchestrator.get(record.id)!.status, "starting");
  const waited = await noOpOrchestrator.wait(record.id, 1);
  assert.equal(waited.timedOut, true);
  assert.equal(waited.record.status, "starting");
});

test("runtime watchdog terminates an overlong detached worker", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  const timedOrchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child;
    },
  });

  const { record } = await timedOrchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "hang",
    executionTimeoutSeconds: 1,
  });
  const waited = await timedOrchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "timed_out");
  assert.match(waited.record.error ?? "", /execution timeout of 1s/);
});

test("child exit observer marks an unfinished worker as error", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  const observedOrchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child;
    },
  });

  const { record } = await observedOrchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "exit immediately",
  });
  const waited = await observedOrchestrator.wait(record.id, 5);
  assert.equal(waited.record.status, "error");
  assert.match(waited.record.error ?? "", /exited without reporting completion/);
});

test("inspect marks a vanished worker process as error", async (t) => {
  const { project, orchestrator, store } = await fixture(t);
  const record = store.create({
    workspaceRoot: project,
    profileName: "reviewer",
    provider: "codex",
    workerPid: 2_147_483_647,
    executionTimeoutSeconds: 600,
  });
  store.update(record.id, { status: "running" });

  const inspected = await orchestrator.inspect(record.id);
  assert.equal(inspected.record.status, "error");
  assert.equal(inspected.record.workerPid, undefined);
  assert.match(inspected.record.error ?? "", /exited without reporting completion/);
});

test("inspect marks a worker timed_out after its execution deadline", async (t) => {
  const { project, orchestrator, store } = await fixture(t);
  const record = store.create({
    workspaceRoot: project,
    profileName: "reviewer",
    provider: "codex",
    executionTimeoutSeconds: 1,
  });
  store.update(record.id, { status: "running" });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const inspected = await orchestrator.inspect(record.id);
  assert.equal(inspected.record.status, "timed_out");
  assert.match(inspected.record.error ?? "", /execution timeout of 1s/);
});

test("execution timeout parser validates explicit values", () => {
  assert.equal(parseAgentsExecutionTimeoutSeconds(600), 600);
  assert.equal(parseAgentsExecutionTimeoutSeconds("1800"), 1800);
  assert.throws(() => parseAgentsExecutionTimeoutSeconds(0), /Invalid agent execution timeout/);
  assert.throws(() => parseAgentsExecutionTimeoutSeconds(7201), /Invalid agent execution timeout/);
});

test("stop marks a running worker as stopped", async (t) => {
  const { project, config, store } = await fixture(t);
  const captures: RunCapture[] = [];
  const noOpOrchestrator = createLocalAgentOrchestrator(config, store, {
    runProvider: fakeRunProvider(captures),
    spawnWorker: async () => {},
  });
  const { record } = await noOpOrchestrator.start({
    workspaceRoot: project,
    target: "reviewer",
    prompt: "slow task",
  });

  const stopped = await noOpOrchestrator.stop(record.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(noOpOrchestrator.get(record.id)!.status, "stopped");
});

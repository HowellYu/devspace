import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";

const execFileAsync = promisify(execFile);

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// devspace agents wait

const waitRoot = mkdtempSync(join(tmpdir(), "devspace-cli-wait-test-"));
try {
  const configDir = join(waitRoot, ".devspace");
  const stateDir = join(waitRoot, ".state");
  const projectRoot = join(waitRoot, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const cliEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKSPACE_ID: "ws_wait",
    DEVSPACE_WORKSPACE_ROOT: projectRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };

  const runCli = (args: string[]): string =>
    execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: cliEnv,
    });

  const runCliFailure = (args: string[]): string => {
    try {
      runCli(args);
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };
      return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    throw new Error(`Expected CLI to fail: ${args.join(" ")}`);
  };

  const seedAgent = (patch: { status: "idle" | "error" | "running"; latestResponse?: string; error?: string }) => {
    const store = new LocalAgentStore(stateDir);
    try {
      return store.update(
        store.create({
          workspaceId: "ws_wait",
          workspaceRoot: projectRoot,
          profileName: "luna-worker",
          provider: "luna",
        }).id,
        patch,
      );
    } finally {
      store.close();
    }
  };

  // Finished worker: prints the final response exactly once, promptly.
  {
    const record = seedAgent({ status: "idle", latestResponse: "worker final answer 12345" });
    const output = runCli(["agents", "wait", record.id]);
    assert.match(output, new RegExp(`${record.id} idle luna-worker luna`));
    assert.equal(output.split("worker final answer 12345").length - 1, 1);
  }

  // Failed worker: prints the recorded error.
  {
    const record = seedAgent({ status: "error", error: "luna acp exploded cleanly" });
    const output = runCli(["agents", "wait", record.id]);
    assert.match(output, /luna acp exploded cleanly/);
  }

  // Active worker at timeout: reports status, does not stop the worker.
  {
    const record = seedAgent({ status: "running" });
    const output = runCli(["agents", "wait", record.id, "--timeout", "1"]);
    assert.match(output, /Still running after 1s/);
    assert.match(output, /not stopped/);

    const store = new LocalAgentStore(stateDir);
    try {
      assert.equal(store.get(record.id)?.status, "running");
    } finally {
      store.close();
    }
  }

  // Worker finishing while wait is active: one start, one wait, one response.
  {
    const record = seedAgent({ status: "running" });
    const pending = execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "wait", record.id, "--timeout", "10"],
      { cwd: process.cwd(), encoding: "utf8", env: cliEnv },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const store = new LocalAgentStore(stateDir);
    try {
      store.update(record.id, { status: "idle", latestResponse: "async worker done 67890" });
    } finally {
      store.close();
    }
    const { stdout } = await pending;
    assert.equal(stdout.split("async worker done 67890").length - 1, 1);
  }

  // Invalid timeouts and unknown ids are rejected.
  for (const bad of ["abc", "0", "-5", "99999"]) {
    assert.match(runCliFailure(["agents", "wait", "agt_any", "--timeout", bad]), /Invalid agents wait timeout/);
  }
  assert.match(runCliFailure(["agents", "wait", "agt_missing"]), /Unknown subagent id/);
  assert.match(runCliFailure(["agents", "wait"]), /Usage: devspace agents wait/);

  // DEVSPACE_AGENTS_WAIT_TIMEOUT provides the default when --timeout is absent.
  {
    const record = seedAgent({ status: "running" });
    const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "wait", record.id], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cliEnv, DEVSPACE_AGENTS_WAIT_TIMEOUT: "1" },
    });
    assert.match(output, /Still running after 1s/);
  }

  // agents show keeps working for quick status checks.
  {
    const record = seedAgent({ status: "idle", latestResponse: "show compat response" });
    const output = runCli(["agents", "show", record.id]);
    assert.match(output, /show compat response/);
  }
} finally {
  rmSync(waitRoot, { recursive: true, force: true });
}

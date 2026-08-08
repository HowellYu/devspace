import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// devspace access (local-only persisted project authorization)

if (process.platform !== "win32") {
  const accessRoot = mkdtempSync(join(homedir(), ".devspace-cli-access-test-"));
  const configDir = join(accessRoot, ".config");
  const projectRoot = join(accessRoot, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const accessEnv = { ...process.env, DEVSPACE_CONFIG_DIR: configDir };
  const runAccessCli = (args: string[]): string =>
    execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: accessEnv,
    });

  try {
    assert.match(runAccessCli(["access", "add", projectRoot]), /Authorized project root/);
    assert.match(runAccessCli(["access", "list"]), new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(runAccessCli(["access", "remove", projectRoot]), /Removed authorized project root/);
    assert.match(runAccessCli(["access", "list"]), /No persisted project roots are authorized/);

    assert.throws(
      () => runAccessCli(["access", "add", homedir()]),
      /Command failed/,
    );
  } finally {
    rmSync(accessRoot, { recursive: true, force: true });
  }
}

// devspace grants (local-only scoped filesystem grants)

if (process.platform !== "win32") {
  const grantRoot = mkdtempSync(join(homedir(), ".devspace-cli-grants-test-"));
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cli-grants-state-"));
  const configDir = join(grantRoot, ".config");
  const projectRoot = join(grantRoot, "project");
  const externalRoot = join(grantRoot, "external");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(externalRoot, { recursive: true });

  const grantEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
  const runGrantCli = (args: string[]): string =>
    execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: grantEnv,
    });

  try {
    const added = runGrantCli([
      "grants",
      "add",
      externalRoot,
      "--workspace",
      projectRoot,
      "--access",
      "read",
      "--ttl",
      "60",
      "--reason",
      "cli-test",
    ]);
    const grantId = added.match(/Granted (grant_[a-f0-9]+):/)?.[1];
    assert.ok(grantId);
    assert.match(added, / read /);
    assert.match(added, /expires=/);

    const listed = runGrantCli(["grants", "list", "--workspace", projectRoot]);
    assert.match(listed, new RegExp(grantId));
    assert.match(listed, new RegExp(externalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const removed = runGrantCli(["grants", "remove", grantId]);
    assert.match(removed, /Revoked/);
    assert.match(runGrantCli(["grants", "list", "--workspace", projectRoot]), /No active path grants/);
  } finally {
    rmSync(grantRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
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

// devspace service install --no-start

const serviceRoot = mkdtempSync(join(tmpdir(), "devspace-cli-service-test-"));
try {
  const configDir = join(serviceRoot, ".devspace");
  mkdirSync(configDir, { recursive: true });

  const serviceCliEnv = (homeDir?: string): NodeJS.ProcessEnv => ({
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    ...(homeDir && { HOME: homeDir }),
  });

  const runServiceCli = (args: string[], homeDir?: string): string =>
    execFileSync("node", ["--import", "tsx", "src/cli.ts", "service", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: serviceCliEnv(homeDir),
    });

  if (process.platform === "darwin") {
    const homeDir = join(serviceRoot, "home");
    mkdirSync(homeDir, { recursive: true });

    const output = runServiceCli(["install", "--no-start"], homeDir);
    assert.match(output, /LaunchAgent installed/);
    assert.match(output, /not started/);

    const plist = join(homeDir, "Library", "LaunchAgents", "dev.devspace.agent.plist");
    assert.equal(existsSync(plist), true);
    assert.match(readFileSync(plist, "utf8"), /<string>serve<\/string>/);
  } else {
    // On non-macOS the command is rejected cleanly without touching the real home directory.
    assert.throws(
      () => runServiceCli(["install", "--no-start"]),
      (error: unknown) =>
        error instanceof Error && /LaunchAgent service is only supported on macOS/.test(error.message),
    );
  }
} finally {
  rmSync(serviceRoot, { recursive: true, force: true });
}

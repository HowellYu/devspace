import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadLocalAgentProfiles, summarizeLocalAgentProfile } from "./local-agent-profiles.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));

try {
  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Global reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "Project reviewer #1."',
      "provider: claude",
      "model: sonnet",
      "thinking: high",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "disabled.md"),
    [
      "---",
      "name: disabled",
      "description: Disabled agent.",
      "provider: codex",
      "disabled: true",
      "---",
      "",
      "Disabled body.",
      "",
    ].join("\n"),
  );

  const enabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "reviewer");
  assert.equal(profiles[0]?.description, "Project reviewer #1.");
  assert.equal(profiles[0]?.provider, "claude");
  assert.equal(profiles[0]?.model, "sonnet");
  assert.equal(profiles[0]?.thinking, "high");
  assert.equal(profiles[0]?.body, "Project body.");
  assert.deepEqual(summarizeLocalAgentProfile(profiles[0]!), {
    name: "reviewer",
    description: "Project reviewer #1.",
    provider: "claude",
    model: "sonnet",
    thinking: "high",
  });

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Unsupported custom agent.",
      "provider: custom",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithInvalid.map((profile) => profile.name), ["reviewer"]);

  await writeFile(
    join(configDir, "agents", "luna-worker.md"),
    [
      "---",
      "name: luna-worker",
      "description: Kimi implementation worker.",
      "provider: kimi",
      "model: kimi-k2.5",
      "thinking: xhigh",
      "---",
      "",
      "Worker body.",
      "",
    ].join("\n"),
  );
  const profilesWithKimi = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  const kimiProfile = profilesWithKimi.find((profile) => profile.name === "luna-worker");
  assert.equal(kimiProfile?.provider, "kimi");
  assert.equal(kimiProfile?.model, "kimi-k2.5");
  assert.equal(kimiProfile?.thinking, "xhigh");
  assert.deepEqual(summarizeLocalAgentProfile(kimiProfile!), {
    name: "luna-worker",
    description: "Kimi implementation worker.",
    provider: "kimi",
    model: "kimi-k2.5",
    thinking: "xhigh",
  });

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

// Packaged example profiles must stay valid and loadable.
{
  const examplesRoot = await mkdtemp(join(tmpdir(), "devspace-example-profiles-test-"));
  try {
    const configDir = join(examplesRoot, ".devspace-home");
    const workspaceRoot = join(examplesRoot, "project");
    await mkdir(join(configDir, "agents"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });

    const examplesDir = new URL("../examples/agents/", import.meta.url);
    for (const name of ["luna-worker.md", "luna-explorer.md"]) {
      const source = await readFile(new URL(name, examplesDir), "utf8");
      await writeFile(join(configDir, "agents", name), source);
    }

    const config = loadConfig({
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    });
    const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
    assert.deepEqual(profiles.map((profile) => profile.name), ["luna-explorer", "luna-worker"]);
    for (const profile of profiles) {
      assert.equal(profile.provider, "kimi");
      // Model and thinking stay unset until validated against live Kimi ACP
      // config options; the Kimi CLI defaults apply when omitted.
      assert.equal(profile.model, undefined);
      assert.equal(profile.thinking, undefined);
      assert.ok(profile.body.length > 0);
    }
  } finally {
    await rm(examplesRoot, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  browserProfileLabel,
  projectBrowserMcpServerConfig,
  projectBrowserOutputDirectory,
  projectBrowserProfileDirectory,
} from "./project-browser.js";

test("project browser profiles are stable per workspace and isolated across workspaces", () => {
  const stateDir = "/tmp/devspace-state";
  const first = projectBrowserProfileDirectory("/tmp/project-a", stateDir);
  assert.equal(first, projectBrowserProfileDirectory("/tmp/project-a", stateDir));
  assert.notEqual(first, projectBrowserProfileDirectory("/tmp/project-b", stateDir));
  assert.match(first, /\/project-browser\/[a-f0-9]{64}\/profile$/);
  assert.match(projectBrowserOutputDirectory("/tmp/project-a", stateDir), /\/project-browser\/[a-f0-9]{64}\/output$/);
  assert.match(browserProfileLabel("/tmp/project-a"), /^devspace-[a-f0-9]{12}$/);
});

test("Playwright MCP browser never attaches to Google Chrome or an existing CDP session", () => {
  const stateDir = "/tmp/devspace-state";
  const workspace = "/tmp/project-a";
  const config = projectBrowserMcpServerConfig(workspace, stateDir, {
    playwrightMcpCliPath: "/devspace/node_modules/@playwright/mcp/cli.js",
  });
  const commandLine = [config.command, ...config.args].join(" ");

  assert.equal(config.command, process.execPath);
  assert.equal(config.cwd, workspace);
  assert.ok(config.args.includes("--browser=chromium"));
  assert.ok(config.args.includes("--image-responses=omit"));
  assert.ok(config.args.includes("--snapshot-mode=full"));
  assert.ok(config.args.includes("--codegen=none"));
  assert.doesNotMatch(commandLine, /Google Chrome\.app/);
  assert.doesNotMatch(commandLine, /--extension(?:\s|=)/);
  assert.doesNotMatch(commandLine, /--cdp-endpoint(?:\s|=)/);
  assert.doesNotMatch(commandLine, /--executable-path(?:\s|=)/);
  assert.equal(config.env.PLAYWRIGHT_BROWSERS_PATH, "0");
  assert.equal(config.startup_timeout_sec, 30);
  assert.equal(config.tool_timeout_sec, 120);

  const profileIndex = config.args.indexOf("--user-data-dir");
  const outputIndex = config.args.indexOf("--output-dir");
  assert.ok(profileIndex >= 0 && outputIndex >= 0);
  assert.equal(config.args[profileIndex + 1], projectBrowserProfileDirectory(workspace, stateDir));
  assert.equal(config.args[outputIndex + 1], projectBrowserOutputDirectory(workspace, stateDir));
});

test("project browser state stays under the configured DevSpace state directory", () => {
  const stateDir = "/tmp/devspace-owned-state";
  const profile = projectBrowserProfileDirectory("/tmp/project-a", stateDir);
  const output = projectBrowserOutputDirectory("/tmp/project-a", stateDir);
  assert.equal(profile.startsWith(join(stateDir, "project-browser")), true);
  assert.equal(output.startsWith(join(stateDir, "project-browser")), true);
});

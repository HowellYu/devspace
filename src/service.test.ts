import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServiceEnvironment, renderLaunchdPlist, printServiceHelp, installLaunchdService } from "./service.js";

test("renderLaunchdPlist contains program arguments and no secrets", () => {
  const cliPath = "/usr/local/bin/devspace";
  const env = buildServiceEnvironment({
    cliPath,
    env: { PATH: "/usr/bin:/bin", LUNA_COMMAND: "/opt/kimi/bin/kimi" },
    configDir: "/Users/dev/.devspace",
  });
  const plist = renderLaunchdPlist(cliPath, env);

  assert.match(plist, /<string>\/usr\/local\/bin\/devspace<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>/);
  assert.match(plist, /<key>LUNA_COMMAND<\/key>\s*<string>\/opt\/kimi\/bin\/kimi<\/string>/);
  assert.doesNotMatch(plist, /ownerToken|DEVSPACE_OAUTH_OWNER_TOKEN/);
});

test("buildServiceEnvironment preserves only explicit operational env and PATH", () => {
  const env = buildServiceEnvironment({
    cliPath: "/devspace",
    env: {
      PATH: "/x",
      LUNA_COMMAND: "kimi",
      DEVSPACE_OAUTH_OWNER_TOKEN: "must-not-appear",
      HOME: "/home/dev",
    },
  });

  assert.equal(env.PATH, "/x");
  assert.equal(env.LUNA_COMMAND, "kimi");
  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(env.HOME, undefined);
});

test("printServiceHelp documents --no-start", () => {
  const help = printServiceHelp();
  assert.match(help, /install\s+\[--no-start\]/);
});

test("installLaunchdService with start: false writes plist without loading", { skip: process.platform !== "darwin" }, async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "devspace-service-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // Import a fresh module instance so the LaunchAgent path is resolved against
    // the temporary home directory.
    const { installLaunchdService, getLaunchdServicePath } = await import(`./service.js?test=${Date.now()}`);
    const result = installLaunchdService({ cliPath: "/usr/local/bin/devspace", start: false });

    assert.equal(result.installed, true);
    assert.match(result.message ?? "", /not started/);

    const plistPath = getLaunchdServicePath();
    assert.equal(existsSync(plistPath), true);

    const content = readFileSync(plistPath, "utf8");
    assert.match(content, /<string>serve<\/string>/);
  } finally {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("installLaunchdService with start: false is rejected on non-macOS", { skip: process.platform === "darwin" }, () => {
  const result = installLaunchdService({ cliPath: "/usr/local/bin/devspace", start: false });
  assert.equal(result.installed, false);
  assert.match(result.message ?? "", /macOS/);
});

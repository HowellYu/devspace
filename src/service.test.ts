import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServiceEnvironment, renderLaunchdPlist, printServiceHelp, installLaunchdService } from "./service.js";

test("renderLaunchdPlist contains program arguments and no secrets", () => {
  const cliPath = "/usr/local/bin/devspace";
  const env = buildServiceEnvironment({
    cliPath,
    env: { PATH: "/usr/bin:/bin", KIMI_COMMAND: "/opt/kimi/bin/kimi", DEVSPACE_TRUST_PROXY: "1" },
    configDir: "/Users/dev/.devspace",
  });
  const plist = renderLaunchdPlist(cliPath, env);

  assert.match(plist, /<string>\/usr\/local\/bin\/devspace<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>/);
  assert.match(plist, /<key>KIMI_COMMAND<\/key>\s*<string>\/opt\/kimi\/bin\/kimi<\/string>/);
  assert.match(plist, /<key>DEVSPACE_TRUST_PROXY<\/key>\s*<string>1<\/string>/);
  assert.doesNotMatch(plist, /ownerToken|DEVSPACE_OAUTH_OWNER_TOKEN/);
});

test("buildServiceEnvironment preserves only explicit operational env and PATH", () => {
  const env = buildServiceEnvironment({
    cliPath: "/devspace",
    env: {
      PATH: "/x",
      KIMI_COMMAND: "kimi",
      DEVSPACE_TRUST_PROXY: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "must-not-appear",
      HOME: "/home/dev",
    },
  });

  assert.equal(env.PATH, "/x");
  assert.equal(env.KIMI_COMMAND, "kimi");
  assert.equal(env.DEVSPACE_TRUST_PROXY, "1");
  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(env.HOME, undefined);
});

test("printServiceHelp documents --no-start and preserves a running service", () => {
  const help = printServiceHelp();
  assert.match(help, /install\s+\[--no-start\]/);
  assert.match(help, /never unloads an already-running DevSpace service/);
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

test("installLaunchdService never unloads an already-running service", { skip: process.platform !== "darwin" }, async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "devspace-service-running-test-"));
  const binDir = join(tmpHome, "bin");
  const launchctlLog = join(tmpHome, "launchctl.log");
  mkdirSync(binDir, { recursive: true });
  const fakeLaunchctl = join(binDir, "launchctl");
  writeFileSync(
    fakeLaunchctl,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DEVSPACE_TEST_LAUNCHCTL_LOG\"\n[ \"$1\" = \"print\" ] && exit 0\nexit 99\n",
  );
  chmodSync(fakeLaunchctl, 0o755);

  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalLog = process.env.DEVSPACE_TEST_LAUNCHCTL_LOG;
  process.env.HOME = tmpHome;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.DEVSPACE_TEST_LAUNCHCTL_LOG = launchctlLog;
  try {
    const { installLaunchdService } = await import(`./service.js?running=${Date.now()}`);
    const result = installLaunchdService({ cliPath: "/project/devspace/dist/cli.js" });

    assert.equal(result.installed, true);
    assert.match(result.message ?? "", /currently running service was left untouched/);
    const calls = readFileSync(launchctlLog, "utf8");
    assert.match(calls, /^print gui\//m);
    assert.doesNotMatch(calls, /bootout|bootstrap|kickstart/);
  } finally {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.DEVSPACE_TEST_LAUNCHCTL_LOG;
    else process.env.DEVSPACE_TEST_LAUNCHCTL_LOG = originalLog;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("installLaunchdService with start: false is rejected on non-macOS", { skip: process.platform === "darwin" }, () => {
  const result = installLaunchdService({ cliPath: "/usr/local/bin/devspace", start: false });
  assert.equal(result.installed, false);
  assert.match(result.message ?? "", /macOS/);
});

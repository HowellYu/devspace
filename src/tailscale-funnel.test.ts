import assert from "node:assert/strict";
import test from "node:test";
import {
  funnelTargetsExpectedDevspace,
  isTailscalePublicUrl,
  resolveTailscaleCommand,
  safeToResetSingleFunnel,
} from "./tailscale-funnel.js";

test("Tailscale public URL detection is limited to ts.net", () => {
  assert.equal(isTailscalePublicUrl("https://host.example.ts.net"), true);
  assert.equal(isTailscalePublicUrl("https://example.com"), false);
  assert.equal(isTailscalePublicUrl("not-a-url"), false);
});

test("Funnel ownership check accepts only the current project proxy", () => {
  const good = JSON.stringify({
    Web: {
      "qianhaos-mac-studio.tail35a51e.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:7677" } },
      },
    },
  });
  assert.equal(
    funnelTargetsExpectedDevspace("https://qianhaos-mac-studio.tail35a51e.ts.net", 7677, good),
    true,
  );

  const wrongPort = good.replace("7677", "8123");
  assert.equal(
    funnelTargetsExpectedDevspace("https://qianhaos-mac-studio.tail35a51e.ts.net", 7677, wrongPort),
    false,
  );

  const wrongHost = good.replace("qianhaos-mac-studio", "someone-else");
  assert.equal(
    funnelTargetsExpectedDevspace("https://qianhaos-mac-studio.tail35a51e.ts.net", 7677, wrongHost),
    false,
  );
});

test("Funnel reset guard refuses to erase unrelated mappings", () => {
  const one = JSON.stringify({
    Web: {
      "qianhaos-mac-studio.tail35a51e.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:7677" } },
      },
    },
  });
  assert.equal(safeToResetSingleFunnel("https://qianhaos-mac-studio.tail35a51e.ts.net", one), true);
  const multiple = JSON.stringify({
    Web: {
      "qianhaos-mac-studio.tail35a51e.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7677" } } },
      "other.tail35a51e.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } },
    },
  });
  assert.equal(safeToResetSingleFunnel("https://qianhaos-mac-studio.tail35a51e.ts.net", multiple), false);
});

test("macOS diagnostics prefer the CLI bundled with the running Tailscale app when available", () => {
  const command = resolveTailscaleCommand({ PATH: process.env.PATH });
  if (process.platform === "darwin" && command.source === "macos-app") {
    assert.equal(command.executable, "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    assert.equal(command.env.TAILSCALE_BE_CLI, "1");
  } else {
    assert.equal(command.source, "path");
  }
});

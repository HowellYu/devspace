import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLocalAgentProviderAvailability,
  clearLocalAgentProviderAvailabilityCache,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  LocalAgentProviderAvailabilityCache,
  refreshLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";

clearLocalAgentProviderAvailabilityCache();

assert.equal(checkLocalAgentProviderAvailability("codex").available, true);

{
  const availability = checkLocalAgentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot", "luna"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);

// Luna availability: default lookup, LUNA_COMMAND override, spaced paths, and
// bounded preflight time. The default executable is the `kimi` binary.

{
  const availability = checkLocalAgentProviderAvailability("luna", {
    PATH: "/definitely/empty",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /kimi executable not found/);
}

{
  const availability = checkLocalAgentProviderAvailability("luna", {
    LUNA_COMMAND: "/definitely/missing/kimi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

if (process.platform !== "win32") {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const sandbox = mkdtempSync(join(tmpdir(), "devspace-luna-availability-test-"));
  try {
    const binDir = join(sandbox, "bin with spaces");
    mkdirSync(binDir, { recursive: true });
    const kimiPath = join(binDir, "kimi");
    writeFileSync(kimiPath, "#!/bin/sh\necho kimi 0.0.1\n", { mode: 0o755 });
    chmodSync(kimiPath, 0o755);

    const found = checkLocalAgentProviderAvailability("luna", {
      LUNA_COMMAND: kimiPath,
    });
    assert.equal(found.available, true);

    const hangingPath = join(binDir, "kimi-hanging");
    writeFileSync(hangingPath, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    chmodSync(hangingPath, 0o755);

    const started = Date.now();
    const hanging = checkLocalAgentProviderAvailability("luna", {
      LUNA_COMMAND: hangingPath,
    });
    // The preflight must stay bounded even when the binary never exits.
    assert.ok(Date.now() - started < 15_000, "luna preflight exceeded its timeout budget");
    assert.equal(hanging.available, true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("availability cache reuses results within TTL and refreshes on demand", () => {
  const cache = new LocalAgentProviderAvailabilityCache(100_000);
  const env = { ...process.env, PATH: process.env.PATH };
  const first = cache.snapshot(env, { refresh: true });
  assert.equal(first.length, 7);

  const cached = cache.snapshot(env);
  assert.equal(cached, first);

  const refreshed = cache.snapshot(env, { refresh: true });
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.length, 7);

  cache.clear();
  const afterClear = cache.snapshot(env);
  assert.notEqual(afterClear, refreshed);
  assert.equal(afterClear.length, 7);
});

test("default snapshot cache returns cached results and refresh bypasses cache", () => {
  clearLocalAgentProviderAvailabilityCache();
  const first = getLocalAgentProviderAvailabilitySnapshot(process.env);
  const second = getLocalAgentProviderAvailabilitySnapshot(process.env);
  assert.equal(first, second);

  const refreshed = refreshLocalAgentProviderAvailabilitySnapshot(process.env);
  assert.notEqual(refreshed, second);
  assert.equal(refreshed.length, first.length);
});

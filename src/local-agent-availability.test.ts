import assert from "node:assert/strict";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";

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
    ["codex", "claude", "opencode", "pi", "cursor", "copilot", "kimi"],
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

// Kimi availability: default lookup, KIMI_COMMAND override, spaced paths, and
// bounded preflight time.

{
  const availability = checkLocalAgentProviderAvailability("kimi", {
    PATH: "/definitely/empty",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /kimi executable not found/);
}

{
  const availability = checkLocalAgentProviderAvailability("kimi", {
    KIMI_COMMAND: "/definitely/missing/kimi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

if (process.platform !== "win32") {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const sandbox = mkdtempSync(join(tmpdir(), "devspace-kimi-availability-test-"));
  try {
    const binDir = join(sandbox, "bin with spaces");
    mkdirSync(binDir, { recursive: true });
    const kimiPath = join(binDir, "kimi");
    writeFileSync(kimiPath, "#!/bin/sh\necho kimi 0.0.1\n", { mode: 0o755 });
    chmodSync(kimiPath, 0o755);

    const found = checkLocalAgentProviderAvailability("kimi", {
      KIMI_COMMAND: kimiPath,
    });
    assert.equal(found.available, true);

    const hangingPath = join(binDir, "kimi-hanging");
    writeFileSync(hangingPath, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    chmodSync(hangingPath, 0o755);

    const started = Date.now();
    const hanging = checkLocalAgentProviderAvailability("kimi", {
      KIMI_COMMAND: hangingPath,
    });
    // The preflight must stay bounded even when the binary never exits.
    assert.ok(Date.now() - started < 15_000, "kimi preflight exceeded its timeout budget");
    assert.equal(hanging.available, true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, runDoctorDiagnostics, nodeVersionStatus, checkSqliteNative } from "./doctor.js";

test("nodeVersionStatus reports supported or unsupported", () => {
  const status = nodeVersionStatus();
  assert.ok(status.includes("supported") || status.includes("unsupported"));
});

test("checkSqliteNative reports ok when dependency loads", () => {
  assert.equal(checkSqliteNative(), "ok");
});

test("runDoctorDiagnostics returns report without credentials", async () => {
  const report = await runDoctorDiagnostics({
    host: "127.0.0.1",
    port: 17676,
    publicBaseUrl: "http://127.0.0.1:17676",
    allowedRoots: [process.cwd()],
    allowedHosts: ["localhost"],
    subagents: false,
  });

  assert.equal(report.nodeVersion, process.version);
  assert.equal(report.platform, `${process.platform} ${process.arch}`);
  assert.equal(report.sqliteNativeStatus, "ok");
  assert.equal(report.allowedRoots[0], process.cwd());
  assert.equal(report.localMcpUrl, "http://127.0.0.1:17676/mcp");
  assert.equal(report.publicMcpUrl, "http://127.0.0.1:17676/mcp");
  assert.equal(report.localHealth?.ok, false);
  assert.equal(report.publicHealth?.skipped, true);
  assert.equal(report.cliVersion.length > 0, true);
  // Never include the owner token or auth file contents.
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /ownerToken/);
  assert.doesNotMatch(serialized, /DEVSPACE_OAUTH_OWNER_TOKEN/);
});

test("formatDoctorReport includes expected sections and omits secrets", () => {
  const report = {
    configDir: "/Users/dev/.devspace",
    configPath: "/Users/dev/.devspace/config.json",
    authPath: "/Users/dev/.devspace/auth.json",
    configExists: true,
    authExists: true,
    nodeVersion: process.version,
    nodeVersionStatus: "supported",
    nodeAbi: "123",
    platform: "darwin arm64",
    gitVersion: "git version 2.0.0",
    bashShell: "/bin/bash -c",
    sqliteNativeStatus: "ok",
    localMcpUrl: "http://127.0.0.1:7676/mcp",
    publicMcpUrl: "https://dev.example.com/mcp",
    allowedRoots: ["/Users/dev/projects"],
    allowedHosts: ["localhost"],
    localHealth: { ok: true, status: 200 },
    publicHealth: { ok: false, error: "timeout" },
    cliVersion: "1.0.0",
    cliPath: "/devspace",
    cliPathMismatch: true,
    providerAvailability: [
      { name: "codex" as const, available: true },
      { name: "luna" as const, available: false, reason: "kimi executable not found" },
    ],
    tailscale: { installed: true, serve: "no serve", funnel: "funnel on 443" },
  };
  const formatted = formatDoctorReport(report);

  assert.match(formatted, /Config dir:/);
  assert.match(formatted, /Local MCP URL:/);
  assert.match(formatted, /Public MCP URL:/);
  assert.match(formatted, /Local health: ok/);
  assert.match(formatted, /Public health: advisory/);
  assert.match(formatted, /CLI mismatch:/);
  assert.match(formatted, /Provider availability:/);
  assert.match(formatted, /Tailscale serve:/);
  assert.match(formatted, /Tailscale funnel:/);
  assert.doesNotMatch(formatted, /ownerToken/);
});

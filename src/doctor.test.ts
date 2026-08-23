import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessTailscaleFunnelState, formatDoctorReport, runDoctorDiagnostics, nodeVersionStatus, checkSqliteNative, pathsReferToSameFile } from "./doctor.js";

test("nodeVersionStatus reports supported or unsupported", () => {
  const status = nodeVersionStatus();
  assert.ok(status.includes("supported") || status.includes("unsupported"));
});

test("checkSqliteNative reports ok when dependency loads", () => {
  assert.equal(checkSqliteNative(), "ok");
});

test("pathsReferToSameFile resolves symlink chains before comparing", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-doctor-cli-path-"));
  try {
    const target = join(root, "target.js");
    const link = join(root, "devspace");
    writeFileSync(target, "#!/usr/bin/env node\n");
    symlinkSync(target, link);
    assert.equal(pathsReferToSameFile(link, target), true);
    assert.equal(pathsReferToSameFile(link, join(root, "other.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctorDiagnostics returns report without credentials", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-doctor-config-"));
  try {
    const report = await runDoctorDiagnostics({
      host: "127.0.0.1",
      port: 17676,
      publicBaseUrl: "http://127.0.0.1:17676",
      allowedRoots: [process.cwd()],
      allowedHosts: ["localhost"],
      subagents: false,
    }, {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
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
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("assessTailscaleFunnelState detects the active public host and stale Funnel hosts", () => {
  const statusJson = JSON.stringify({ Self: { DNSName: "qianhaos-mac-studio.tail35a51e.ts.net." } });
  const funnelJson = JSON.stringify({
    Web: {
      "qianhaos-mac-studio.tail35a51e.ts.net:443": {},
      "qianhaos-mac-studio-1.tail35a51e.ts.net:443": {},
    },
    AllowFunnel: {
      "qianhaos-mac-studio.tail35a51e.ts.net:443": true,
      "qianhaos-mac-studio-1.tail35a51e.ts.net:443": true,
    },
  });

  const result = assessTailscaleFunnelState(
    "https://qianhaos-mac-studio.tail35a51e.ts.net",
    statusJson,
    funnelJson,
  );

  assert.equal(result.dnsName, "qianhaos-mac-studio.tail35a51e.ts.net");
  assert.equal(result.funnelMatchesPublicHost, true);
  assert.deepEqual(result.extraFunnelHosts, ["qianhaos-mac-studio-1.tail35a51e.ts.net"]);
});

test("assessTailscaleFunnelState flags a configured public host missing from Funnel", () => {
  const result = assessTailscaleFunnelState(
    "https://dev.example.com",
    JSON.stringify({ Self: { DNSName: "qianhaos-mac-studio.tail35a51e.ts.net." } }),
    JSON.stringify({ Web: {}, AllowFunnel: {} }),
  );

  assert.equal(result.funnelMatchesPublicHost, false);
  assert.deepEqual(result.funnelHosts, []);
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
      { name: "luna" as const, available: false, reason: "API key missing" },
      { name: "kimi" as const, available: false, reason: "kimi executable not found" },
    ],
    tailscale: {
      installed: true,
      serve: "no serve",
      funnel: "funnel on 443",
      dnsName: "dev.example.com",
      funnelMatchesPublicHost: true,
      extraFunnelHosts: ["old-dev.example.com"],
    },
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
  assert.match(formatted, /Tailscale node DNS: dev\.example\.com/);
  assert.match(formatted, /Funnel covers public host: yes/);
  assert.match(formatted, /Extra Funnel hosts: old-dev\.example\.com/);
  assert.doesNotMatch(formatted, /ownerToken/);
});

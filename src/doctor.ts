import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalAgentProviderAvailabilitySnapshot, refreshLocalAgentProviderAvailabilitySnapshot, type LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { expandHomePath } from "./roots.js";
import { devspaceConfigDir, loadDevspaceFiles } from "./user-config.js";

export interface DoctorConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedRoots: string[];
  allowedHosts: string[];
  subagents: boolean;
}

export interface DoctorReport {
  configDir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  nodeVersion: string;
  nodeVersionStatus: string;
  nodeAbi: string;
  platform: string;
  gitVersion: string;
  bashShell: string;
  sqliteNativeStatus: string;
  localMcpUrl: string;
  publicMcpUrl: string;
  allowedRoots: string[];
  allowedHosts: string[];
  localHealth?: { ok: boolean; status: number; error?: string };
  publicHealth?: { ok: boolean; status?: number; error?: string; skipped?: boolean };
  cliVersion: string;
  cliPath: string;
  cliPathMismatch?: boolean;
  providerAvailability: LocalAgentProviderAvailability[];
  tailscale?: { installed: boolean; serve?: string; funnel?: string; error?: string };
}

const require = createRequire(import.meta.url);

export async function runDoctorDiagnostics(config: DoctorConfig, env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const files = loadDevspaceFiles(env);
  const packageJson = require("../package.json") as { version?: string };
  const cliVersion = typeof packageJson.version === "string" ? packageJson.version : "unknown";
  const cliPath = process.argv[1] ?? "unknown";
  const resolvedCli = resolveCliPath(env);
  const cliPathMismatch = resolvedCli !== undefined && resolve(resolvedCli) !== resolve(cliPath);

  return {
    configDir: files.dir,
    configPath: files.configPath,
    authPath: files.authPath,
    configExists: files.configExists,
    authExists: files.authExists,
    nodeVersion: process.version,
    nodeVersionStatus: nodeVersionStatus(),
    nodeAbi: process.versions.modules,
    platform: `${process.platform} ${process.arch}`,
    gitVersion: checkGitAvailable(),
    bashShell: checkBashShell(),
    sqliteNativeStatus: checkSqliteNative(),
    localMcpUrl: `http://${config.host}:${config.port}/mcp`,
    publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
    allowedRoots: config.allowedRoots,
    allowedHosts: config.allowedHosts,
    localHealth: await checkLocalHealth(config.host, config.port),
    publicHealth: await checkPublicHealthAdvisory(config.publicBaseUrl),
    cliVersion,
    cliPath,
    cliPathMismatch,
    providerAvailability: config.subagents
      ? refreshLocalAgentProviderAvailabilitySnapshot(env)
      : getLocalAgentProviderAvailabilitySnapshot(env),
    tailscale: checkTailscaleStatus(),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Config dir: ${report.configDir}`,
    `Config file: ${report.configExists ? report.configPath : "missing"}`,
    `Auth file: ${report.authExists ? report.authPath : "missing"}`,
    `Node: ${report.nodeVersion} (${report.nodeVersionStatus})`,
    `Node ABI: ${report.nodeAbi}`,
    `Platform: ${report.platform}`,
    `Git: ${report.gitVersion}`,
    `Bash shell: ${report.bashShell}`,
    `SQLite native dependency: ${report.sqliteNativeStatus}`,
    `Local MCP URL: ${report.localMcpUrl}`,
    `Public MCP URL: ${report.publicMcpUrl}`,
    `Allowed roots: ${report.allowedRoots.join(", ")}`,
    `Allowed hosts: ${report.allowedHosts.join(", ")}`,
  ];

  if (report.localHealth) {
    const health = report.localHealth;
    lines.push(`Local health: ${health.ok ? `ok (${health.status})` : `unreachable${health.error ? `: ${health.error}` : ""}`}`);
  }

  if (report.publicHealth?.skipped) {
    lines.push("Public health: skipped (no publicBaseUrl configured)");
  } else if (report.publicHealth) {
    const health = report.publicHealth;
    lines.push(`Public health: ${health.ok ? `reachable (${health.status})` : `advisory: unreachable${health.error ? `: ${health.error}` : ""}`}`);
  }

  lines.push(`CLI version: ${report.cliVersion}`);
  lines.push(`CLI path: ${report.cliPath}`);
  if (report.cliPathMismatch) {
    lines.push("CLI mismatch: the devspace command in PATH resolves to a different script than this process");
  }

  const available = report.providerAvailability.filter((p) => p.available).map((p) => p.name);
  const unavailable = report.providerAvailability.filter((p) => !p.available).map((p) => `${p.name} (${p.reason ?? "unavailable"})`);
  lines.push(`Provider availability: ${available.length > 0 ? `available: ${available.join(", ")}` : "none available"}${unavailable.length > 0 ? `; unavailable: ${unavailable.join(", ")}` : ""}`);

  if (report.tailscale) {
    if (!report.tailscale.installed) {
      lines.push("Tailscale: not installed (advisory)");
    } else {
      if (report.tailscale.error) {
        lines.push(`Tailscale: installed (status check failed: ${report.tailscale.error})`);
      } else {
        lines.push(`Tailscale serve: ${report.tailscale.serve?.trim() || "no serve status"}`);
        lines.push(`Tailscale funnel: ${report.tailscale.funnel?.trim() || "no funnel status"}`);
      }
    }
  }

  return lines.join("\n");
}

export function nodeVersionStatus(): string {
  const SUPPORTED_NODE_RANGE = ">=20.12 <27";
  return satisfies(process.version, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

export function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

export function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function resolveCliPath(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const resolved = execFileSync(command, ["devspace"], { encoding: "utf8", env, timeout: 5_000 }).trim().split("\n")[0];
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

async function checkLocalHealth(host: string, port: number): Promise<{ ok: boolean; status: number; error?: string } | undefined> {
  const { request } = require("node:http") as typeof import("node:http");
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${formattedHost}:${port}/healthz`;

  return new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: 3_000 }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      resolve({ ok: status >= 200 && status < 300, status });
    });
    req.on("error", (error: Error) => {
      resolve({ ok: false, status: 0, error: error.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout" });
    });
    req.end();
  });
}

async function checkPublicHealthAdvisory(publicBaseUrl: string): Promise<{ ok: boolean; status?: number; error?: string; skipped?: boolean } | undefined> {
  const localUrl = new URL(publicBaseUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(localUrl.hostname)) {
    return { skipped: true, ok: false };
  }

  const { request } = publicBaseUrl.startsWith("https:")
    ? require("node:https") as typeof import("node:https")
    : require("node:http") as typeof import("node:http");
  const url = new URL("/healthz", publicBaseUrl).toString();

  return new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: 5_000 }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      resolve({ ok: status >= 200 && status < 300, status });
    });
    req.on("error", (error: Error) => {
      resolve({ ok: false, error: error.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.end();
  });
}

function checkTailscaleStatus(): { installed: boolean; serve?: string; funnel?: string; error?: string } | undefined {
  try {
    execFileSync("tailscale", ["version"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { installed: false };
  }

  try {
    const serve = execTailscale("serve", "status");
    const funnel = execTailscale("funnel", "status");
    return { installed: true, serve, funnel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { installed: true, error: message };
  }
}

function execTailscale(...args: string[]): string | undefined {
  try {
    return execFileSync("tailscale", args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch (error) {
    return undefined;
  }
}

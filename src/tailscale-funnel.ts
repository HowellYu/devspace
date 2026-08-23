import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LoggingConfig } from "./logger.js";
import { logEvent } from "./logger.js";

const MACOS_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const WATCH_INTERVAL_MS = 60_000;
const WATCH_FAILURE_THRESHOLD = 3;
const REPAIR_COOLDOWN_MS = 10 * 60_000;

export interface TailscaleCommand {
  executable: string;
  env: NodeJS.ProcessEnv;
  source: "macos-app" | "path";
}

export interface PublicProbeResult {
  ok: boolean;
  addresses: string[];
  status?: number;
  error?: string;
}

export interface FunnelWatchConfig {
  enabled: boolean;
  publicBaseUrl: string;
  port: number;
  logging: LoggingConfig;
}

export function resolveTailscaleCommand(env: NodeJS.ProcessEnv = process.env): TailscaleCommand {
  const childEnv = tailscaleChildEnvironment(env);
  if (process.platform === "darwin" && existsSync(MACOS_TAILSCALE_APP_CLI)) {
    return {
      executable: MACOS_TAILSCALE_APP_CLI,
      env: { ...childEnv, TAILSCALE_BE_CLI: "1" },
      source: "macos-app",
    };
  }
  return {
    executable: env.DEVSPACE_TAILSCALE_CLI?.trim() || "tailscale",
    env: childEnv,
    source: "path",
  };
}

export function execTailscale(args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const command = resolveTailscaleCommand(env);
  try {
    return execFileSync(command.executable, args, {
      encoding: "utf8",
      timeout: 8_000,
      env: command.env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isTailscalePublicUrl(publicBaseUrl: string): boolean {
  try {
    return new URL(publicBaseUrl).hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

export async function resolvePublicTailscaleAddresses(
  publicBaseUrl: string,
  resolver = new Resolver(),
): Promise<string[]> {
  if (!isTailscalePublicUrl(publicBaseUrl)) return [];
  const host = new URL(publicBaseUrl).hostname;
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  try {
    const addresses = await resolver.resolve4(host);
    return Array.from(new Set(addresses)).sort();
  } catch {
    return [];
  }
}

export async function probePublicHealth(
  publicBaseUrl: string,
  addresses?: string[],
): Promise<PublicProbeResult> {
  const url = new URL("/healthz", publicBaseUrl);
  const forced = addresses ?? await resolvePublicTailscaleAddresses(publicBaseUrl);
  if (isTailscalePublicUrl(publicBaseUrl) && forced.length === 0) {
    return { ok: false, addresses: [], error: "public DNS returned no Funnel IPv4 addresses" };
  }
  if (forced.length === 0) {
    const result = await requestStatus(url);
    return { ...result, addresses: [] };
  }

  const failures: string[] = [];
  let status: number | undefined;
  for (const address of forced) {
    const result = await requestStatus(url, address);
    if (!result.ok) failures.push(`${address}: ${result.error ?? `HTTP ${result.status ?? 0}`}`);
    status ??= result.status;
  }
  return failures.length === 0
    ? { ok: true, addresses: forced, status }
    : { ok: false, addresses: forced, status, error: failures.join("; ") };
}

export async function probePublicMcpDiscovery(
  publicBaseUrl: string,
  addresses?: string[],
): Promise<PublicProbeResult> {
  const url = new URL("/mcp", publicBaseUrl);
  const forced = addresses ?? await resolvePublicTailscaleAddresses(publicBaseUrl);
  if (isTailscalePublicUrl(publicBaseUrl) && forced.length === 0) {
    return { ok: false, addresses: [], error: "public DNS returned no Funnel IPv4 addresses" };
  }
  const candidates = forced.length > 0 ? forced : [undefined];
  const failures: string[] = [];
  let status: number | undefined;

  for (const address of candidates) {
    const initialize = await requestStatus(url, address, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "devspace-funnel-watch", version: "1" } } }),
    });
    if (!initialize.ok) {
      failures.push(`${address ?? "default"}: initialize ${initialize.error ?? initialize.status}`);
      continue;
    }
    const initialized = await requestStatus(url, address, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      acceptedStatuses: new Set([200, 202]),
    });
    if (!initialized.ok) {
      failures.push(`${address ?? "default"}: initialized ${initialized.error ?? initialized.status}`);
      continue;
    }
    const tools = await requestStatus(url, address, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    status ??= tools.status;
    if (!tools.ok) failures.push(`${address ?? "default"}: tools/list ${tools.error ?? tools.status}`);
  }

  return failures.length === 0
    ? { ok: true, addresses: forced, status }
    : { ok: false, addresses: forced, status, error: failures.join("; ") };
}

export function funnelTargetsExpectedDevspace(
  publicBaseUrl: string,
  port: number,
  funnelJson?: string,
): boolean {
  if (!funnelJson) return false;
  try {
    const status = JSON.parse(funnelJson) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> };
    const host = new URL(publicBaseUrl).hostname.toLowerCase();
    const entries = Object.entries(status.Web ?? {});
    const matching = entries.find(([key]) => key.replace(/:\d+$/, "").toLowerCase() === host);
    const proxy = matching?.[1]?.Handlers?.["/"]?.Proxy;
    return proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`;
  } catch {
    return false;
  }
}

export async function repairTailscaleFunnel(
  publicBaseUrl: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ attempted: boolean; reset: boolean; reason?: string }> {
  if (!isTailscalePublicUrl(publicBaseUrl)) return { attempted: false, reset: false, reason: "public URL is not Tailscale Funnel" };
  const before = execTailscale(["funnel", "status", "--json"], env);
  if (!funnelTargetsExpectedDevspace(publicBaseUrl, port, before)) {
    return { attempted: false, reset: false, reason: "existing Funnel mapping is not the expected DevSpace proxy" };
  }

  const command = resolveTailscaleCommand(env);
  const run = (args: string[]) => execFileSync(command.executable, args, {
    encoding: "utf8",
    timeout: 15_000,
    env: command.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    run(["funnel", "--bg", String(port)]);
  } catch (error) {
    return { attempted: true, reset: false, reason: error instanceof Error ? error.message : String(error) };
  }

  await sleep(3_000);
  const afterReassertHealth = await probePublicHealth(publicBaseUrl);
  const afterReassertMcp = afterReassertHealth.ok ? await probePublicMcpDiscovery(publicBaseUrl) : undefined;
  if (afterReassertHealth.ok && afterReassertMcp?.ok) return { attempted: true, reset: false };

  // Reset only when this host has exactly one simple Funnel mapping, so DevSpace
  // cannot silently erase unrelated Funnel services.
  if (!safeToResetSingleFunnel(publicBaseUrl, before)) {
    return { attempted: true, reset: false, reason: "reasserted Funnel but public ingress is still unhealthy; reset skipped because other Funnel configuration exists" };
  }
  try {
    run(["funnel", "reset"]);
    run(["funnel", "--bg", String(port)]);
    await sleep(3_000);
    const finalHealth = await probePublicHealth(publicBaseUrl);
    const finalMcp = finalHealth.ok ? await probePublicMcpDiscovery(publicBaseUrl) : undefined;
    if (finalHealth.ok && finalMcp?.ok) return { attempted: true, reset: true };
    return {
      attempted: true,
      reset: true,
      reason: `Funnel was reset/reapplied but public verification still failed: health=${finalHealth.error ?? finalHealth.status ?? "unknown"}; mcp=${finalMcp?.error ?? finalMcp?.status ?? "not checked"}`,
    };
  } catch (error) {
    return { attempted: true, reset: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function startTailscaleFunnelWatchdog(config: FunnelWatchConfig): { close: () => void } {
  if (!config.enabled || !isTailscalePublicUrl(config.publicBaseUrl)) return { close: () => undefined };
  let consecutiveFailures = 0;
  let running = false;
  let lastRepairAt = 0;

  const check = async () => {
    if (running) return;
    running = true;
    try {
      const addresses = await resolvePublicTailscaleAddresses(config.publicBaseUrl);
      if (addresses.length === 0) {
        logEvent(config.logging, "warn", "tailscale_funnel_public_dns_failed", {});
        consecutiveFailures = 0;
        return;
      }
      const health = await probePublicHealth(config.publicBaseUrl, addresses);
      const mcp = health.ok ? await probePublicMcpDiscovery(config.publicBaseUrl, addresses) : { ok: false, addresses, error: "health failed" };
      if (health.ok && mcp.ok) {
        if (consecutiveFailures > 0) {
          logEvent(config.logging, "info", "tailscale_funnel_recovered", { consecutiveFailures, addresses });
        }
        consecutiveFailures = 0;
        return;
      }

      consecutiveFailures += 1;
      logEvent(config.logging, "warn", "tailscale_funnel_probe_failed", {
        consecutiveFailures,
        addresses,
        healthError: health.error,
        mcpError: mcp.error,
      });
      if (consecutiveFailures < WATCH_FAILURE_THRESHOLD || Date.now() - lastRepairAt < REPAIR_COOLDOWN_MS) return;

      lastRepairAt = Date.now();
      const repair = await repairTailscaleFunnel(config.publicBaseUrl, config.port);
      logEvent(config.logging, repair.reason ? "warn" : "info", "tailscale_funnel_repair", repair);
      if (repair.attempted) consecutiveFailures = 0;
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void check(), 20_000);
  initial.unref();
  const timer = setInterval(() => void check(), WATCH_INTERVAL_MS);
  timer.unref();
  return {
    close: () => {
      clearTimeout(initial);
      clearInterval(timer);
    },
  };
}

export function safeToResetSingleFunnel(publicBaseUrl: string, funnelJson?: string): boolean {
  if (!funnelJson) return false;
  try {
    const status = JSON.parse(funnelJson) as { Web?: Record<string, { Handlers?: Record<string, unknown> }> };
    const entries = Object.entries(status.Web ?? {});
    if (entries.length !== 1) return false;
    const [key, value] = entries[0]!;
    if (key.replace(/:\d+$/, "").toLowerCase() !== new URL(publicBaseUrl).hostname.toLowerCase()) return false;
    return Object.keys(value.Handlers ?? {}).length === 1 && Object.prototype.hasOwnProperty.call(value.Handlers ?? {}, "/");
  } catch {
    return false;
  }
}

async function requestStatus(
  url: URL,
  forcedAddress?: string,
  options: { method?: string; body?: string; acceptedStatuses?: Set<number> } = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const method = options.method ?? "GET";
  const body = options.body;
  const accepted = options.acceptedStatuses ?? new Set([200]);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const req = request({
      protocol: url.protocol,
      hostname: forcedAddress ?? url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      timeout: 5_000,
      headers: {
        host: url.host,
        accept: "application/json, text/event-stream",
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        "user-agent": "openai-mcp/devspace-funnel-watch",
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      resolve({ ok: accepted.has(status), status });
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    if (body) req.write(body);
    req.end();
  });
}

function tailscaleChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL"] as const;
  const child: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (env[key]) child[key] = env[key];
  }
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import {
  checkBashShell,
  checkGitAvailable,
  checkSqliteNative,
  formatDoctorReport,
  nodeVersionStatus,
  runDoctorDiagnostics,
} from "./doctor.js";
import { parseLocalAgentRunArgs } from "./local-agent-targets.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  refreshLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  createLocalAgentStore,
  type LocalAgentRecord,
} from "./local-agent-store.js";
import {
  createLocalAgentOrchestrator,
  parseAgentsWaitTimeoutSeconds,
} from "./local-agent-orchestrator.js";
import {
  ensureDevspaceDefaultSkills,
  generateOwnerToken,
  loadDevspaceFiles,
  resolveSubagentsFlag,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import {
  installLaunchdService,
  launchdServiceIsInstalled,
  printServiceHelp,
  resolveDevspaceCliPath,
  uninstallLaunchdService,
} from "./service.js";
import { shutdownHttpServer } from "./server-shutdown.js";

type Command = "serve" | "init" | "doctor" | "config" | "agents" | "service" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "service":
      await runServiceCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config" || command === "agents" || command === "service") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
      subagents: resolveSubagentsFlag(files.config),
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);
    const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      ...seededSkillPaths.map((path) => `Default skill: ${path}`),
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  runStartupPreflight(config);
  const { app, close, localAgentProviders } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runDoctor(): Promise<void> {
  try {
    const config = loadConfig();
    const report = await runDoctorDiagnostics({
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      allowedRoots: config.allowedRoots,
      allowedHosts: config.allowedHosts,
      subagents: config.subagents,
    });
    console.log(formatDoctorReport(report));
  } catch (error) {
    const files = loadDevspaceFiles();
    const report = await runDoctorDiagnostics({
      host: "127.0.0.1",
      port: 7676,
      publicBaseUrl: "http://127.0.0.1:7676",
      allowedRoots: files.config.allowedRoots ?? [],
      allowedHosts: files.config.allowedHosts ?? [],
      subagents: files.config.subagents ?? false,
    });
    console.log(formatDoctorReport(report));
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runStartupPreflight(config: ReturnType<typeof loadConfig>): void {
  const { statSync } = require("node:fs") as typeof import("node:fs");
  for (const root of config.allowedRoots) {
    try {
      const info = statSync(root);
      if (!info.isDirectory()) {
        console.warn(`warning: allowed root is not a directory: ${root}`);
      }
    } catch (error) {
      console.warn(`warning: allowed root does not exist or is inaccessible: ${root}`);
    }
  }

  if (config.subagents) {
    const providers = refreshLocalAgentProviderAvailabilitySnapshot();
    const unavailable = providers.filter((p) => !p.available);
    if (unavailable.length > 0) {
      console.warn(`warning: subagents enabled but some providers are unavailable: ${formatLocalAgentProviderAvailabilitySummary(unavailable)}`);
    }
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, network, and provider status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
      "  devspace agents show <id>",
      "  devspace agents wait <id> [--timeout <seconds>]",
      "  devspace service install [--no-start]  Install a macOS LaunchAgent (start by default)",
      "  devspace service uninstall Remove the macOS LaunchAgent",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList();
      return;
    case "run":
      await runAgentsRun(rest);
      return;
    case "show":
      await runAgentsShow(rest);
      return;
    case "wait":
      await runAgentsWait(rest);
      return;
    case "__worker":
      await runAgentsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsList(): Promise<void> {
  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const agents = store.list(resolveCurrentWorkspaceScope());

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const agent of agents) {
    console.log(formatAgentLine(agent));
  }
}

async function runAgentsRun(args: string[]): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot();
  const store = createLocalAgentStore(config);
  const orchestrator = createLocalAgentOrchestrator(config, store);
  const existing = store.get(parsed.target);

  const record = existing
    ? await orchestrator.continue(existing.id, {
        prompt: parsed.prompt,
        model: parsed.model,
        thinking: parsed.thinking,
      })
    : (await orchestrator.start({
        workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
        workspaceRoot,
        target: parsed.target,
        prompt: parsed.prompt,
        model: parsed.model,
        thinking: parsed.thinking,
      })).record;
  console.log(formatAgentLine(record));
}

async function runAgentsShow(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace agents show <id>");

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const orchestrator = createLocalAgentOrchestrator(config, store);
  const { record } = await orchestrator.inspect(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  console.log(formatAgentLine(record));
  if (record.latestResponse) {
    console.log(record.latestResponse);
    return;
  }
  if (record.error) {
    console.log(record.error);
    return;
  }
  if (record.status === "starting" || record.status === "running") {
    console.log(`No final response yet. Call \`devspace agents show ${record.id}\` again later.`);
  }
}

function parseAgentsWaitArgs(args: string[]): { id: string; timeoutRaw?: string } {
  const [id, ...rest] = args;
  if (!id) throw new Error("Usage: devspace agents wait <id> [--timeout <seconds>]");

  let timeoutRaw: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--timeout") {
      timeoutRaw = rest[index + 1];
      if (timeoutRaw === undefined) {
        throw new Error("Missing value for --timeout. Expected seconds.");
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown agents wait argument: ${flag}`);
  }
  return { id, timeoutRaw };
}

async function runAgentsWait(args: string[]): Promise<void> {
  const { id, timeoutRaw } = parseAgentsWaitArgs(args);
  const timeoutSeconds = parseAgentsWaitTimeoutSeconds(
    timeoutRaw ?? process.env.DEVSPACE_AGENTS_WAIT_TIMEOUT,
  );

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const orchestrator = createLocalAgentOrchestrator(config, store);
  const { record, timedOut } = await orchestrator.wait(id, timeoutSeconds);

  console.log(formatAgentLine(record));
  if (record.latestResponse) {
    console.log(record.latestResponse);
    return;
  }
  if (record.error) {
    console.log(record.error);
    return;
  }
  if (timedOut) {
    console.log(
      `Still ${record.status} after ${timeoutSeconds}s. The worker was not stopped; ` +
        `call \`devspace agents wait ${record.id}\` again, or \`devspace agents show ${record.id}\` for a quick status check.`,
    );
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile] = args;
  if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
    throw new Error("Usage: devspace agents __worker <id> --prompt-file <path>");
  }

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const orchestrator = createLocalAgentOrchestrator(config, store);
  await orchestrator.executeWorker(id, promptFile);
}

function formatAgentLine(agent: Pick<
  LocalAgentRecord,
  "id" | "status" | "profileName" | "provider" | "model" | "thinking"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}

function resolveCurrentWorkspaceRoot(): string {
  return resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
}

function resolveCurrentWorkspaceScope(): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
  };
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
      "  devspace agents show <id>",
      "  devspace agents wait <id> [--timeout <seconds>]",
    ].join("\n"),
  );
}

async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  switch (subcommand) {
    case "install": {
      const cliPath = resolveDevspaceCliPath();
      const result = installLaunchdService({
        cliPath,
        configDir: process.env.DEVSPACE_CONFIG_DIR,
        env: process.env,
        start: !args.includes("--no-start"),
      });
      if (result.installed) {
        console.log(`LaunchAgent installed: ${result.path}`);
        if (result.message) {
          console.log(result.message);
        }
      } else {
        throw new Error(result.message ?? "LaunchAgent installation failed");
      }
      return;
    }
    case "uninstall": {
      const result = uninstallLaunchdService();
      if (result.removed) {
        console.log(`LaunchAgent removed: ${result.path}`);
      } else {
        console.log(result.message ?? "No LaunchAgent was installed");
      }
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
    case "status":
      console.log(printServiceHelp());
      if (subcommand === "status") {
        console.log(`\nInstalled: ${launchdServiceIsInstalled() ? "yes" : "no"}`);
      }
      return;
    default:
      throw new Error(`Unknown service command: ${subcommand}`);
  }
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

class SetupCancelledError extends Error {}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

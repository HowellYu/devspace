import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_LABEL = "dev.devspace.agent";
const PLIST_FILE = join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);
const LOG_DIR = join(expandHomePath("~/.devspace"), "logs");

export interface ServiceInstallOptions {
  cliPath: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When `false`, write and validate the LaunchAgent plist without calling
   * `launchctl load`/`start`. Defaults to `true` so plain `service install`
   * keeps its existing behavior.
   */
  start?: boolean;
}

export function installLaunchdService(options: ServiceInstallOptions): { installed: boolean; path: string; message?: string } {
  if (process.platform !== "darwin") {
    return { installed: false, path: PLIST_FILE, message: "LaunchAgent service is only supported on macOS." };
  }

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const env = buildServiceEnvironment(options);
  const plist = renderLaunchdPlist(options.cliPath, env);
  writeFileSync(PLIST_FILE, plist, { mode: 0o644 });

  if (options.start === false) {
    return {
      installed: true,
      path: PLIST_FILE,
      message: `LaunchAgent installed but not started. Load it later with: launchctl bootstrap gui/$(id -u) ${PLIST_FILE}`,
    };
  }

  const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
  const serviceTarget = `${domain}/${PLIST_LABEL}`;
  if (launchdServiceIsLoaded()) {
    return {
      installed: true,
      path: PLIST_FILE,
      message: "LaunchAgent plist updated; the currently running service was left untouched. Restart it only after validating the replacement build.",
    };
  }

  try {
    execFileSync("launchctl", ["bootstrap", domain, PLIST_FILE], { encoding: "utf8", timeout: 10_000 });
    execFileSync("launchctl", ["kickstart", "-k", serviceTarget], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return { installed: false, path: PLIST_FILE, message: stderr || "launchctl bootstrap failed" };
  }

  return { installed: true, path: PLIST_FILE };
}

export function uninstallLaunchdService(): { removed: boolean; path: string; message?: string } {
  if (process.platform !== "darwin") {
    return { removed: false, path: PLIST_FILE, message: "LaunchAgent service is only supported on macOS." };
  }

  if (!existsSync(PLIST_FILE)) {
    return { removed: false, path: PLIST_FILE, message: "No LaunchAgent is installed." };
  }

  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? "$(id -u)"}/${PLIST_LABEL}`], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if (stderr && !stderr.includes("Could not find specified service")) {
      return { removed: false, path: PLIST_FILE, message: stderr };
    }
  }

  rmSync(PLIST_FILE, { force: true });
  return { removed: true, path: PLIST_FILE };
}

export function getLaunchdServicePath(): string {
  return PLIST_FILE;
}

export function launchdServiceIsInstalled(): boolean {
  return process.platform === "darwin" && existsSync(PLIST_FILE);
}

export function launchdServiceIsLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
  try {
    execFileSync("launchctl", ["print", `${domain}/${PLIST_LABEL}`], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function printServiceHelp(): string {
  return [
    "DevSpace service (macOS)",
    "",
    "Usage:",
    "  devspace service install [--no-start]",
    "                             Install a LaunchAgent to start DevSpace at login",
    "                             (never unloads an already-running DevSpace service)",
    "  devspace service uninstall Remove the LaunchAgent",
    "  devspace service status    Show whether the LaunchAgent is installed",
    "",
    "The LaunchAgent runs the resolved DevSpace CLI with `devspace serve` and logs",
    `to ${LOG_DIR}. It does not contain owner tokens or credentials. Operational env`,
    "such as KIMI_COMMAND is preserved only when explicitly set (LUNA_COMMAND remains a legacy alias).",
    "",
    "Tailscale Funnel exposes the server to the public internet; Tailscale Serve is",
    "tailnet-only. Start whichever tunnel you need separately from DevSpace.",
  ].join("\n");
}

export function buildServiceEnvironment(options: ServiceInstallOptions): Record<string, string> {
  const env: Record<string, string> = {
    PATH: options.env?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };

  if (options.configDir) {
    env.DEVSPACE_CONFIG_DIR = options.configDir;
  }

  // Preserve only explicitly-configured operational env that is safe to embed.
  // Never copy owner tokens, secrets, or general process env.
  for (const key of [
    "KIMI_COMMAND",
    "LUNA_COMMAND",
    "CURSOR_COMMAND",
    "COPILOT_COMMAND",
    "PI_COMMAND",
    "DEVSPACE_AGENTS_MAX_CONCURRENT",
    "DEVSPACE_AGENTS_WAIT_TIMEOUT",
    "DEVSPACE_AGENTS_EXECUTION_TIMEOUT",
    "DEVSPACE_TRUST_PROXY",
    "DEVSPACE_TAILSCALE_FUNNEL_WATCH",
    "DEVSPACE_TAILSCALE_CLI",
  ]) {
    const value = options.env?.[key] ?? process.env[key];
    if (value) env[key] = value;
  }

  return env;
}

export function renderLaunchdPlist(cliPath: string, env: Record<string, string>): string {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(cliPath)}</string>
      <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(LOG_DIR, "devspace.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(LOG_DIR, "devspace-error.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function resolveDevspaceCliPath(): string {
  if (process.argv[1]) {
    return resolve(process.argv[1]);
  }
  return process.execPath;
}

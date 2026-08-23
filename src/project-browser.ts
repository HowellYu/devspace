import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ProjectBrowserMcpServerConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
}

const require = createRequire(import.meta.url);

/**
 * Builds the Playwright MCP server configuration exposed only to a Luna worker.
 *
 * Important isolation properties:
 * - uses Playwright-managed Chromium, never Google Chrome or a Chrome extension;
 * - never attaches to an existing browser over CDP;
 * - uses a dedicated persistent profile keyed by the canonical workspace root;
 * - keeps Playwright output and browser state under DevSpace-owned state;
 * - does not enable vision, clipboard permissions, unrestricted file access, or devtools.
 */
export function projectBrowserMcpServerConfig(
  workspaceRoot: string,
  stateDir: string = defaultDevspaceStateDir(),
  options: { playwrightMcpCliPath?: string } = {},
): ProjectBrowserMcpServerConfig {
  const root = resolve(workspaceRoot);
  const profileDir = projectBrowserProfileDirectory(root, stateDir);
  const outputDir = projectBrowserOutputDirectory(root, stateDir);
  const cliPath = options.playwrightMcpCliPath ?? resolvePlaywrightMcpCliPath();

  return {
    command: process.execPath,
    args: [
      cliPath,
      "--browser=chromium",
      "--user-data-dir",
      profileDir,
      "--output-dir",
      outputDir,
      "--image-responses=omit",
      "--snapshot-mode=full",
      "--codegen=none",
    ],
    cwd: root,
    env: {
      // The Chromium binary is installed hermetically inside DevSpace's
      // playwright-core package instead of ~/Library/Caches or a system browser.
      PLAYWRIGHT_BROWSERS_PATH: "0",
    },
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  };
}

export function projectBrowserProfileDirectory(
  workspaceRoot: string,
  stateDir: string = defaultDevspaceStateDir(),
): string {
  return join(resolve(stateDir), "project-browser", workspaceKey(workspaceRoot), "profile");
}

export function projectBrowserOutputDirectory(
  workspaceRoot: string,
  stateDir: string = defaultDevspaceStateDir(),
): string {
  return join(resolve(stateDir), "project-browser", workspaceKey(workspaceRoot), "output");
}

export function browserProfileLabel(workspaceRoot: string): string {
  return `devspace-${workspaceKey(workspaceRoot).slice(0, 12)}`;
}

export function resolvePlaywrightMcpCliPath(): string {
  const packageJsonPath = require.resolve("@playwright/mcp/package.json");
  return join(dirname(packageJsonPath), "cli.js");
}

export function defaultDevspaceStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DEVSPACE_STATE_DIR ?? join(homedir(), ".local", "share", "devspace"));
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(resolve(workspaceRoot)).digest("hex");
}

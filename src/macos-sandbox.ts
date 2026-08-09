import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { ServerConfig } from "./config.js";

export interface MacosSandboxPolicyInput {
  workspaceRoot: string;
  stateDir?: string;
  readPaths?: string[];
  readFiles?: string[];
  writePaths?: string[];
  writeFiles?: string[];
  allowNetwork?: boolean;
}

export interface WrappedCommand {
  executable: string;
  args: string[];
}

export function shouldUseMacosSandbox(config: Pick<ServerConfig, "macosSandbox">): boolean {
  return process.platform === "darwin" && config.macosSandbox;
}

export function buildMacosSandboxProfile(input: MacosSandboxPolicyInput): string {
  const workspaceRoot = resolve(input.workspaceRoot);
  const readPaths = uniquePaths([
    workspaceRoot,
    ...(input.stateDir ? [input.stateDir] : []),
    ...(input.readPaths ?? []),
  ]);
  const readFiles = uniquePaths(input.readFiles ?? []);
  const writePaths = uniquePaths([
    workspaceRoot,
    ...(input.stateDir ? [input.stateDir] : []),
    tmpdir(),
    ...(input.writePaths ?? []),
  ]);
  const writeFiles = uniquePaths(input.writeFiles ?? []);

  const metadataPaths = ancestorPaths([...readPaths, ...readFiles, ...writePaths, ...writeFiles]);
  const forms = [
    "(version 1)",
    "(allow default)",
    '(deny file-read* (subpath "/Users"))',
    '(deny file-read* (subpath "/Volumes"))',
    "(deny file-write*)",
    allowLiterals("file-read-metadata", metadataPaths),
    allowSubpaths("file-read*", readPaths),
    allowLiterals("file-read*", readFiles),
    allowSubpaths("file-write*", writePaths),
    allowLiterals("file-write*", writeFiles),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stderr") (literal "/dev/stdout"))',
    ...(input.allowNetwork === false ? ["(deny network*)"] : []),
  ];

  return forms.filter(Boolean).join("\n");
}

export function wrapMacosSandboxCommand(
  command: WrappedCommand,
  policy: MacosSandboxPolicyInput,
): WrappedCommand {
  if (process.platform !== "darwin") return command;
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", buildMacosSandboxProfile(policy), command.executable, ...command.args],
  };
}

export function workerSandboxReadPaths(
  config: Pick<ServerConfig, "devspaceAgentsDir" | "sandboxReadPaths">,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths = [config.devspaceAgentsDir, ...config.sandboxReadPaths];
  const providerCommand = configuredProviderCommand(provider as LocalAgentProvider, env);
  if (providerCommand && isAbsolute(providerCommand)) paths.push(dirname(resolve(providerCommand)));
  return uniquePaths(paths);
}

function configuredProviderCommand(provider: LocalAgentProvider, env: NodeJS.ProcessEnv): string | undefined {
  switch (provider) {
    case "luna":
      return env.LUNA_COMMAND;
    case "cursor":
      return env.CURSOR_COMMAND;
    case "copilot":
      return env.COPILOT_COMMAND;
    case "claude":
      return env.CLAUDE_COMMAND;
    case "pi":
      return env.PI_COMMAND;
    case "codex":
    case "opencode":
      return undefined;
  }
}

function uniquePaths(paths: string[]): string[] {
  const resolved: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    resolved.push(absolute);
    try {
      resolved.push(realpathSync.native(absolute));
    } catch {
      // Keep the resolved path for explicit grants that do not exist yet.
    }
  }
  return Array.from(new Set(resolved));
}

function ancestorPaths(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const value of paths) {
    let current = resolve(value);
    while (current !== "/") {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  return Array.from(ancestors);
}

function allowSubpaths(operation: string, paths: string[]): string {
  if (paths.length === 0) return "";
  return `(allow ${operation} ${paths.map((path) => `(subpath ${schemeString(path)})`).join(" ")})`;
}

function allowLiterals(operation: string, paths: string[]): string {
  if (paths.length === 0) return "";
  return `(allow ${operation} ${paths.map((path) => `(literal ${schemeString(path)})`).join(" ")})`;
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}


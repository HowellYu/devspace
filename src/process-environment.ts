const BASE_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
] as const;

const DEVSPACE_CHILD_ENV_KEYS = [
  "DEVSPACE_CONFIG_DIR",
  "DEVSPACE_STATE_DIR",
  "DEVSPACE_WORKTREE_ROOT",
  "DEVSPACE_SUBAGENTS",
  "DEVSPACE_AGENTS_WAIT_TIMEOUT",
  "DEVSPACE_AGENTS_EXECUTION_TIMEOUT",
  "DEVSPACE_PI_TIMEOUT_MS",
  "DEVSPACE_SANDBOX",
  "DEVSPACE_SANDBOX_NETWORK",
  "DEVSPACE_SANDBOX_READ_PATHS",
  "DEVSPACE_SANDBOX_WRITE_PATHS",
] as const;

const PROVIDER_COMMAND_ENV_KEYS = [
  "LUNA_COMMAND",
  "CURSOR_COMMAND",
  "COPILOT_COMMAND",
  "CLAUDE_COMMAND",
  "PI_COMMAND",
] as const;

export interface ChildEnvironmentOptions {
  source?: NodeJS.ProcessEnv;
  extra?: Record<string, string | undefined>;
  includeProviderCommands?: boolean;
}

/**
 * Build the environment for remotely-triggered child processes.
 *
 * The parent process may contain credentials, SSH agent sockets, database URLs,
 * cloud tokens, or unrelated application secrets. Those values must not flow
 * into workspace shells or subagents merely because DevSpace itself inherited
 * them at launch. Keep the default allowlist intentionally small; provider
 * credentials that genuinely require environment forwarding should use an
 * explicit future credential/grant surface rather than widening this list.
 */
export function buildSafeChildEnvironment(
  options: ChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const result: NodeJS.ProcessEnv = {};

  copyDefined(source, result, BASE_CHILD_ENV_KEYS);
  copyDefined(source, result, DEVSPACE_CHILD_ENV_KEYS);
  if (options.includeProviderCommands) {
    copyDefined(source, result, PROVIDER_COMMAND_ENV_KEYS);
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined) result[key] = value;
  }

  return result;
}

function copyDefined(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

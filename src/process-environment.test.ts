import assert from "node:assert/strict";
import { buildSafeChildEnvironment } from "./process-environment.js";

const source: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/test",
  TMPDIR: "/tmp/test",
  LANG: "en_US.UTF-8",
  SHELL: "/bin/zsh",
  USER: "test",
  LOGNAME: "test",
  LUNA_COMMAND: "/opt/kimi",
  DEVSPACE_CONFIG_DIR: "/Users/test/.devspace",
  DEVSPACE_AGENTS_EXECUTION_TIMEOUT: "600",
  SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
  OPENAI_API_KEY: "openai-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_URL: "postgres://secret",
  RANDOM_APP_SECRET: "secret",
};

const shellEnv = buildSafeChildEnvironment({ source });
assert.equal(shellEnv.PATH, "/usr/bin:/bin");
assert.equal(shellEnv.HOME, "/Users/test");
assert.equal(shellEnv.DEVSPACE_CONFIG_DIR, "/Users/test/.devspace");
assert.equal(shellEnv.DEVSPACE_AGENTS_EXECUTION_TIMEOUT, "600");
assert.equal(shellEnv.LUNA_COMMAND, undefined);
assert.equal(shellEnv.SSH_AUTH_SOCK, undefined);
assert.equal(shellEnv.OPENAI_API_KEY, undefined);
assert.equal(shellEnv.ANTHROPIC_API_KEY, undefined);
assert.equal(shellEnv.AWS_SECRET_ACCESS_KEY, undefined);
assert.equal(shellEnv.DATABASE_URL, undefined);
assert.equal(shellEnv.RANDOM_APP_SECRET, undefined);

const providerEnv = buildSafeChildEnvironment({ source, includeProviderCommands: true });
assert.equal(providerEnv.LUNA_COMMAND, "/opt/kimi");
assert.equal(providerEnv.OPENAI_API_KEY, undefined);
assert.equal(providerEnv.SSH_AUTH_SOCK, undefined);

const withExtra = buildSafeChildEnvironment({
  source,
  extra: {
    DEVSPACE_WORKSPACE_ID: "ws_test",
    NO_COLOR: "1",
  },
});
assert.equal(withExtra.DEVSPACE_WORKSPACE_ID, "ws_test");
assert.equal(withExtra.NO_COLOR, "1");

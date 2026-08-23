import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMacosSandboxProfile,
  wrapMacosSandboxCommand,
  workerSandboxReadPaths,
} from "./macos-sandbox.js";

const workspace = "/Users/example/project";
const stateDir = "/Users/example/.devspace";

const profile = buildMacosSandboxProfile({
  workspaceRoot: workspace,
  stateDir,
  readPaths: ["/Users/example/.codex"],
  writePaths: ["/Users/example/shared-output"],
  allowNetwork: false,
});
assert.match(profile, /\(deny file-read\* \(subpath "\/Users"\)\)/);
assert.match(profile, /\(deny file-write\*\)/);
assert.match(profile, /\(subpath "\/Users\/example\/project"\)/);
assert.match(profile, /\(subpath "\/Users\/example\/\.devspace"\)/);
assert.match(profile, /\(subpath "\/Users\/example\/\.codex"\)/);
assert.match(profile, /\(subpath "\/Users\/example\/shared-output"\)/);
assert.match(profile, /\(deny network\*\)/);
assert.match(profile, new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const networkAllowed = buildMacosSandboxProfile({
  workspaceRoot: workspace,
  allowNetwork: true,
});
assert.doesNotMatch(networkAllowed, /deny network/);

const wrapped = wrapMacosSandboxCommand(
  { executable: "/bin/sh", args: ["-c", "echo ok"] },
  { workspaceRoot: workspace },
);
if (process.platform === "darwin") {
  assert.equal(wrapped.executable, "/usr/bin/sandbox-exec");
  assert.equal(wrapped.args[0], "-p");
  assert.equal(wrapped.args.at(-3), "/bin/sh");
} else {
  assert.deepEqual(wrapped, { executable: "/bin/sh", args: ["-c", "echo ok"] });
}

const providerPaths = workerSandboxReadPaths(
  {
    devspaceAgentsDir: "/Users/example/.devspace/agents",
    sandboxReadPaths: ["/Users/example/explicit"],
  },
  "kimi",
  { KIMI_COMMAND: "/Users/example/.kimi-code/bin/kimi" },
);
assert.ok(!providerPaths.includes("/Users/example/.codex"));
assert.ok(providerPaths.includes("/Users/example/.devspace/agents"));
assert.ok(providerPaths.includes("/Users/example/explicit"));
assert.ok(providerPaths.includes("/Users/example/.kimi-code/bin"));

const lunaPaths = workerSandboxReadPaths(
  {
    devspaceAgentsDir: "/Users/example/.devspace/agents",
    sandboxReadPaths: [],
  },
  "luna",
  {},
);
assert.ok(lunaPaths.includes(dirname(dirname(fileURLToPath(import.meta.url)))));
assert.ok(!lunaPaths.includes("/Users/example"));
assert.ok(!lunaPaths.includes("/Users/example/.codex"));

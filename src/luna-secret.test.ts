import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createLunaSecretStore,
  OPENAI_LUNA_KEYCHAIN_SERVICE,
} from "./luna-secret.js";

const calls: Array<{ command: string; args: readonly string[] }> = [];
const run = ((command: string, args?: readonly string[]) => {
  calls.push({ command, args: args ?? [] });
  const operation = args?.[0];
  return {
    pid: 123,
    output: [null, operation === "find-generic-password" ? "sk-test\n" : "", ""],
    stdout: operation === "find-generic-password" ? "sk-test\n" : "",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
  };
}) as unknown as typeof spawnSync;

assert.equal(OPENAI_LUNA_KEYCHAIN_SERVICE, "devspace.openai-luna");

const store = createLunaSecretStore("darwin", "test-user", run);
assert.equal(store.available(), true);
assert.equal(store.read(), "sk-test");
store.setInteractive();
assert.equal(store.delete(), true);

const setCall = calls.find((call) => call.args[0] === "add-generic-password");
assert.ok(setCall);
assert.equal(setCall.command, "/usr/bin/security");
assert.deepEqual(setCall.args.slice(-2), ["-U", "-w"]);
assert.ok(setCall.args.includes(OPENAI_LUNA_KEYCHAIN_SERVICE));
assert.ok(setCall.args.includes("test-user"));
assert.ok(!setCall.args.some((value) => value.startsWith("sk-")));

const unsupported = createLunaSecretStore("linux", "test-user", run);
assert.equal(unsupported.available(), false);
assert.throws(() => unsupported.read(), /macOS only/);

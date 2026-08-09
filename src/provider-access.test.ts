import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderAccessStore,
  validateProviderAccessMode,
} from "./provider-access.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-provider-access-state-"));
const codexRoot = join(homedir(), ".codex");
const testDir = join(codexRoot, ".devspace-provider-access-test");
const configFile = join(testDir, "config.toml");
mkdirSync(testDir, { recursive: true });
writeFileSync(configFile, "test = true\n", { mode: 0o600 });

try {
  const store = createProviderAccessStore(stateDir);
  const fileGrant = store.add("codex", configFile, "read");
  assert.equal(fileGrant.kind, "file");
  assert.equal(fileGrant.access, "read");

  const dirGrant = store.add("codex", testDir, "readwrite");
  assert.equal(dirGrant.kind, "directory");

  const sandbox = store.sandboxAccess("codex");
  assert.deepEqual(sandbox.readFiles, [configFile]);
  assert.deepEqual(sandbox.readPaths, [testDir]);
  assert.deepEqual(sandbox.writePaths, [testDir]);
  assert.deepEqual(sandbox.writeFiles, []);

  assert.equal(store.remove(fileGrant.id)?.id, fileGrant.id);
  assert.equal(store.remove("provider_missing"), undefined);

  assert.throws(
    () => store.add("codex", codexRoot, "read"),
    /narrower file or directory/,
  );
  assert.throws(
    () => store.add("codex", homedir(), "read"),
    /provider-specific configuration root/,
  );
  assert.throws(
    () => store.add("luna", configFile, "read"),
    /provider-specific configuration root/,
  );
  assert.equal(validateProviderAccessMode("read"), "read");
  assert.equal(validateProviderAccessMode("readwrite"), "readwrite");
  assert.throws(() => validateProviderAccessMode("write"), /Invalid provider access mode/);
} finally {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

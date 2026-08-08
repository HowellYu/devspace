import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPathGrantStore,
  validatePathGrantAccess,
  validateTtlSeconds,
} from "./path-grants.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-path-grants-state-"));
const root = mkdtempSync(join(homedir(), ".devspace-path-grants-test-"));
const workspace = join(root, "workspace");
const externalRead = join(root, "external-read");
const externalWrite = join(root, "external-write");
mkdirSync(workspace);
mkdirSync(externalRead);
mkdirSync(externalWrite);

try {
  const store = createPathGrantStore(stateDir);
  const now = Date.now();

  const readGrant = store.add({
    workspaceRoot: workspace,
    path: externalRead,
    access: "read",
    ttlSeconds: 60,
    reason: "test read dependency",
  }, now);
  assert.equal(readGrant.access, "read");
  assert.equal(Date.parse(readGrant.expiresAt ?? ""), now + 60_000);

  const writeGrant = store.add({
    workspaceRoot: workspace,
    path: externalWrite,
    access: "readwrite",
    persistent: true,
  }, now);
  assert.equal(writeGrant.expiresAt, undefined);

  assert.deepEqual(store.readRoots(workspace).sort(), [externalRead, externalWrite].sort());
  assert.deepEqual(store.writeRoots(workspace), [externalWrite]);
  assert.deepEqual(store.list(workspace, now + 61_000).map((grant) => grant.id), [writeGrant.id]);

  const replacement = store.add({
    workspaceRoot: workspace,
    path: externalWrite,
    access: "read",
    persistent: true,
  }, now + 1_000);
  assert.equal(replacement.id, writeGrant.id);
  assert.deepEqual(store.writeRoots(workspace), []);

  assert.equal(store.remove(readGrant.id)?.id, readGrant.id);
  assert.equal(store.remove("grant_missing"), undefined);

  assert.throws(
    () => store.add({ workspaceRoot: workspace, path: root, access: "read", persistent: true }),
    /may not contain the workspace root/,
  );
  assert.throws(
    () => store.add({ workspaceRoot: workspace, path: workspace, access: "read", persistent: true }),
    /already inside the workspace/,
  );
  assert.throws(
    () => store.add({ workspaceRoot: workspace, path: homedir(), access: "read", persistent: true }),
    /too broad|may not contain the workspace root/,
  );
  if (process.platform !== "win32") {
    mkdirSync(join(homedir(), ".ssh"), { recursive: true });
    assert.throws(
      () => store.add({ workspaceRoot: workspace, path: join(homedir(), ".ssh"), access: "read", persistent: true }),
      /security-sensitive/,
    );
  }

  assert.equal(validatePathGrantAccess("read"), "read");
  assert.equal(validatePathGrantAccess("readwrite"), "readwrite");
  assert.throws(() => validatePathGrantAccess("write"), /Invalid path grant access/);
  assert.equal(validateTtlSeconds(3600), 3600);
  assert.throws(() => validateTtlSeconds(0), /Invalid path grant TTL/);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

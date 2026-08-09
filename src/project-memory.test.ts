import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertValidMemoryFilename,
  createProjectMemoryManager,
  isValidMemoryFilename,
  localMemoryNamespacePath,
  memoryNamespaceId,
  memoryNamespacePath,
  MEMORY_FILE_NAMES,
  type ProjectMemoryManager,
} from "./project-memory.js";

const WELL_KNOWN_FILES = ["decisions.md", "next-steps.md", "progress.md"];

function* invalidFilenames(): Generator<string> {
  yield "";
  yield ".hidden.md";
  yield "../decisions.md";
  yield "dir/decisions.md";
  yield "decisions.txt";
  yield "decisions";
  yield "decisions.md\x00";
  yield "a b.md";
  yield "decisions?.md";
  yield "decisions*.md";
  yield "decisions:.md";
  yield "-decisions.md";
}

test("well-known memory filenames are valid", () => {
  for (const file of MEMORY_FILE_NAMES) {
    assert.equal(isValidMemoryFilename(file), true);
    assert.equal(assertValidMemoryFilename(file), file);
  }
});

test("invalid memory filenames are rejected", () => {
  for (const file of invalidFilenames()) {
    assert.equal(isValidMemoryFilename(file), false);
    assert.throws(() => assertValidMemoryFilename(file), /Invalid memory file name/);
  }
});

test("memory namespace id is stable for the same root", () => {
  const root = "/Users/example/project";
  assert.equal(memoryNamespaceId(root), memoryNamespaceId(root));
  assert.notEqual(memoryNamespaceId(root), memoryNamespaceId("/Users/example/other"));
});

test("write, read, list, and overwrite memory files locally", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  for (const file of WELL_KNOWN_FILES) {
    await manager.writeFile(root, file, `content for ${file}\n`);
  }

  const localNamespace = localMemoryNamespacePath(root);
  assert.equal(localNamespace.startsWith(root), true);

  const listed = await manager.listFiles(root);
  assert.deepEqual(
    listed.map((entry) => entry.file),
    WELL_KNOWN_FILES,
  );

  for (const file of WELL_KNOWN_FILES) {
    const content = await manager.readFile(root, file);
    assert.equal(content, `content for ${file}\n`);
  }

  await manager.writeFile(root, "decisions.md", "updated decisions\n");
  assert.equal(await manager.readFile(root, "decisions.md"), "updated decisions\n");

  await cleanup();
});

test("manifest revisions change only when memory content changes", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  const empty = await manager.manifest(root);
  assert.equal(empty.version, 1);
  assert.deepEqual(empty.files, {});

  await manager.writeFile(root, "progress.md", "phase one\n");
  const first = await manager.manifest(root);
  assert.equal(first.files["progress.md"]?.size, "phase one\n".length);
  assert.match(first.files["progress.md"]?.revision ?? "", /^[a-f0-9]{16}$/);

  const same = await manager.manifest(root);
  assert.equal(same.revision, first.revision);

  await manager.writeFile(root, "progress.md", "phase two\n");
  const second = await manager.manifest(root);
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.files["progress.md"]?.revision, first.files["progress.md"]?.revision);

  const index = JSON.parse(await readFile(join(localMemoryNamespacePath(root), "index.json"), "utf8"));
  assert.equal(index.revision, second.revision);

  await cleanup();
});

test("bootstrap returns only compact high-value sections", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  await manager.writeFile(root, "progress.md", "current progress\n");
  await manager.writeFile(root, "next-steps.md", "next action\n");
  await manager.writeFile(root, "context.md", "stable context\n");
  await manager.writeFile(root, "decisions.md", "large decision history should stay lazy\n");

  const bootstrap = await manager.bootstrap(root);
  assert.equal(bootstrap.sections["progress.md"], "current progress\n");
  assert.equal(bootstrap.sections["next-steps.md"], "next action\n");
  assert.equal(bootstrap.sections["context.md"], "stable context\n");
  assert.equal(bootstrap.sections["decisions.md"], undefined);
  assert.equal(bootstrap.manifest.files["decisions.md"] !== undefined, true);
  assert.equal(bootstrap.truncated, false);

  await cleanup();
});

test("bootstrap caps large memory sections to protect token budgets", async (t) => {
  const { manager, root, cleanup } = await fixture(t);
  await manager.writeFile(root, "progress.md", "x".repeat(10_000));

  const bootstrap = await manager.bootstrap(root);
  assert.equal(bootstrap.sections["progress.md"]?.length, 2_500);
  assert.equal(bootstrap.truncated, true);

  await cleanup();
});

test("memory writes reject transcript-sized payloads", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  await assert.rejects(
    () => manager.writeFile(root, "progress.md", "x".repeat(33 * 1024)),
    /maximum is 32768/,
  );

  await cleanup();
});

test("different canonical roots are isolated", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");

  await manager.writeFile(projectA, "decisions.md", "project-a decision\n");
  await manager.writeFile(projectB, "decisions.md", "project-b decision\n");

  assert.equal(await manager.readFile(projectA, "decisions.md"), "project-a decision\n");
  assert.equal(await manager.readFile(projectB, "decisions.md"), "project-b decision\n");

  const listedA = await manager.listFiles(projectA);
  const listedB = await manager.listFiles(projectB);
  assert.equal(listedA.length, 1);
  assert.equal(listedB.length, 1);
  assert.equal(listedA[0]?.file, "decisions.md");
  assert.equal(listedB[0]?.file, "decisions.md");

  await cleanup();
});

test("read returns undefined for missing memory files", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  assert.equal(await manager.readFile(root, "missing.md"), undefined);

  await cleanup();
});

test("listing ignores hidden and invalid files", async (t) => {
  const { root, manager, cleanup } = await fixture(t);
  const namespace = localMemoryNamespacePath(root);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(namespace, { recursive: true });
  writeFileSync(join(namespace, ".hidden.md"), "hidden");
  mkdirSync(join(namespace, "subdirectory"), { recursive: true });
  writeFileSync(join(namespace, "subdirectory", "nested.md"), "nested");
  writeFileSync(join(namespace, "valid.md"), "valid");

  const listed = await manager.listFiles(root);
  assert.deepEqual(
    listed.map((entry) => entry.file),
    ["valid.md"],
  );

  await cleanup();
});

test("falls back to global namespace when local memory does not exist", async (t) => {
  const { manager, root, stateDir, cleanup } = await fixture(t);
  const globalNamespace = memoryNamespacePath(stateDir, root);

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(globalNamespace, { recursive: true });
  writeFileSync(join(globalNamespace, "decisions.md"), "global decision\n");

  assert.equal(await manager.readFile(root, "decisions.md"), "global decision\n");

  const listed = await manager.listFiles(root);
  assert.deepEqual(
    listed.map((entry) => entry.file),
    ["decisions.md"],
  );

  await cleanup();
});

test("writing migrates existing global memory into local namespace", async (t) => {
  const { manager, root, stateDir, cleanup } = await fixture(t);
  const globalNamespace = memoryNamespacePath(stateDir, root);
  const localNamespace = localMemoryNamespacePath(root);

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(globalNamespace, { recursive: true });
  writeFileSync(join(globalNamespace, "decisions.md"), "global decision\n");
  writeFileSync(join(globalNamespace, "progress.md"), "global progress\n");

  await manager.writeFile(root, "next-steps.md", "local next step\n");

  assert.equal(await manager.readFile(root, "decisions.md"), "global decision\n");
  assert.equal(await manager.readFile(root, "progress.md"), "global progress\n");
  assert.equal(await manager.readFile(root, "next-steps.md"), "local next step\n");

  const listed = await manager.listFiles(root);
  assert.deepEqual(
    listed.map((entry) => entry.file),
    ["decisions.md", "next-steps.md", "progress.md"],
  );

  const localStats = await stat(join(localNamespace, "decisions.md"));
  assert.ok(localStats.isFile());

  await cleanup();
});

test("creates .devspace/.gitignore on first write if absent", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  await manager.writeFile(root, "decisions.md", "decision\n");

  const gitignore = await readFile(join(root, ".devspace", ".gitignore"), "utf8");
  assert.equal(gitignore, "memory/\n");

  await cleanup();
});

test("does not overwrite an existing .devspace/.gitignore", async (t) => {
  const { manager, root, cleanup } = await fixture(t);

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(root, ".devspace"), { recursive: true });
  writeFileSync(join(root, ".devspace", ".gitignore"), "custom/\n");

  await manager.writeFile(root, "decisions.md", "decision\n");

  const gitignore = await readFile(join(root, ".devspace", ".gitignore"), "utf8");
  assert.equal(gitignore, "custom/\n");

  await cleanup();
});

interface MemoryFixture {
  root: string;
  stateDir: string;
  manager: ProjectMemoryManager;
  cleanup(): Promise<void>;
}

async function fixture(t: TestContext): Promise<MemoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-memory-test-"));
  const stateDir = join(root, "state");
  const manager = createProjectMemoryManager(stateDir);

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    stateDir,
    manager,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

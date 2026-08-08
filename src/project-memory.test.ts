import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertValidMemoryFilename,
  createProjectMemoryManager,
  isValidMemoryFilename,
  memoryNamespaceId,
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

test("write, read, list, and overwrite memory files", async (t) => {
  const { manager, cleanup } = await fixture(t);

  for (const file of WELL_KNOWN_FILES) {
    await manager.writeFile("/project", file, `content for ${file}\n`);
  }

  const listed = await manager.listFiles("/project");
  assert.deepEqual(
    listed.map((entry) => entry.file),
    WELL_KNOWN_FILES,
  );

  for (const file of WELL_KNOWN_FILES) {
    const content = await manager.readFile("/project", file);
    assert.equal(content, `content for ${file}\n`);
  }

  await manager.writeFile("/project", "decisions.md", "updated decisions\n");
  assert.equal(await manager.readFile("/project", "decisions.md"), "updated decisions\n");

  await cleanup();
});

test("different canonical roots are isolated", async (t) => {
  const { manager, cleanup } = await fixture(t);

  await manager.writeFile("/project-a", "decisions.md", "project-a decision\n");
  await manager.writeFile("/project-b", "decisions.md", "project-b decision\n");

  assert.equal(await manager.readFile("/project-a", "decisions.md"), "project-a decision\n");
  assert.equal(await manager.readFile("/project-b", "decisions.md"), "project-b decision\n");

  const listedA = await manager.listFiles("/project-a");
  const listedB = await manager.listFiles("/project-b");
  assert.equal(listedA.length, 1);
  assert.equal(listedB.length, 1);
  assert.equal(listedA[0]?.file, "decisions.md");
  assert.equal(listedB[0]?.file, "decisions.md");

  await cleanup();
});

test("read returns undefined for missing memory files", async (t) => {
  const { manager, cleanup } = await fixture(t);

  assert.equal(await manager.readFile("/project", "missing.md"), undefined);

  await cleanup();
});

test("listing ignores hidden and invalid files", async (t) => {
  const { stateDir, manager, cleanup } = await fixture(t);
  const namespace = join(stateDir, "memory", memoryNamespaceId("/project"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(namespace, { recursive: true });
  writeFileSync(join(namespace, ".hidden.md"), "hidden");
  mkdirSync(join(namespace, "subdirectory"), { recursive: true });
  writeFileSync(join(namespace, "subdirectory", "nested.md"), "nested");
  writeFileSync(join(namespace, "valid.md"), "valid");

  const listed = await manager.listFiles("/project");
  assert.deepEqual(
    listed.map((entry) => entry.file),
    ["valid.md"],
  );

  await cleanup();
});

interface MemoryFixture {
  stateDir: string;
  manager: ProjectMemoryManager;
  cleanup(): Promise<void>;
}

async function fixture(t: TestContext): Promise<MemoryFixture> {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-memory-test-"));
  const manager = createProjectMemoryManager(stateDir);

  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  return {
    stateDir,
    manager,
    cleanup: async () => {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const sandboxRoot = process.platform === "darwin"
  ? mkdtempSync(join(homedir(), ".devspace-pi-tools-test-"))
  : mkdtempSync(join(tmpdir(), "devspace-pi-tools-test-"));
const workspace = join(sandboxRoot, "workspace");
const privateDir = join(sandboxRoot, "private");
const privateFile = join(privateDir, "secret.txt");
mkdirSync(workspace, { recursive: true });
mkdirSync(privateDir, { recursive: true });
writeFileSync(privateFile, "outside-secret\n");

process.env.DEVSPACE_TEST_SECRET = "environment-secret";
try {
  const envResult = await runShellTool(
    { command: `${JSON.stringify(process.execPath)} -e "console.log(process.env.DEVSPACE_TEST_SECRET ?? 'missing')"`, timeout: 5 },
    {
      cwd: workspace,
      root: workspace,
      workspaceId: "ws_test",
      sandbox: {
        macosSandbox: true,
        sandboxNetwork: false,
        sandboxReadPaths: [],
        sandboxWritePaths: [],
      },
    },
  );
  assert.equal(envResult.isError, undefined);
  assert.match(envResult.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /missing/);

  if (process.platform === "darwin") {
    const outsideResult = await runShellTool(
      { command: `/bin/cat ${JSON.stringify(privateFile)}`, timeout: 5 },
      {
        cwd: workspace,
        root: workspace,
        workspaceId: "ws_test",
        sandbox: {
          macosSandbox: true,
          sandboxNetwork: false,
          sandboxReadPaths: [],
          sandboxWritePaths: [],
        },
      },
    );
    const text = outsideResult.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.doesNotMatch(text, /outside-secret/);
    assert.match(text, /Operation not permitted|Permission denied/);
  }
} finally {
  delete process.env.DEVSPACE_TEST_SECRET;
  rmSync(sandboxRoot, { recursive: true, force: true });
}

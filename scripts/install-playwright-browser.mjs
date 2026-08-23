import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const playwrightPackageJson = require.resolve("playwright/package.json");
const playwrightCli = join(dirname(playwrightPackageJson), "cli.js");

const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  stdio: "inherit",
  env: {
    ...process.env,
    // Keep the managed browser binary inside DevSpace's own dependency tree.
    // This avoids ~/Library/Caches and never uses the user's installed Chrome.
    PLAYWRIGHT_BROWSERS_PATH: "0",
  },
});

if (result.error) {
  console.error(`Unable to install Playwright Chromium: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

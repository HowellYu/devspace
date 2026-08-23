// Legacy placeholder retained only to make the removal of the old Chrome-tab broker
// explicit in the source tree. Browser automation now goes through Playwright MCP
// with a DevSpace-owned profile and never attaches to the user's browser session.
export {
  browserProfileLabel,
  projectBrowserMcpServerConfig,
  projectBrowserOutputDirectory,
  projectBrowserProfileDirectory,
  resolvePlaywrightMcpCliPath,
} from "./project-browser.js";

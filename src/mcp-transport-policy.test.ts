import assert from "node:assert/strict";
import test from "node:test";
import { prefersStatelessMcpTransport } from "./mcp-transport-policy.js";

test("OpenAI hosted MCP clients use stateless transport", () => {
  assert.equal(prefersStatelessMcpTransport("openai-mcp/1.0.0"), true);
  assert.equal(prefersStatelessMcpTransport("OpenAI-MCP/2.1"), true);
  assert.equal(prefersStatelessMcpTransport("codex-mcp-client/0.148.0"), false);
  assert.equal(prefersStatelessMcpTransport(undefined), false);
});

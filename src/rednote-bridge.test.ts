import assert from "node:assert/strict";
import {
  invokeRednoteBridge,
  rednoteReadArgs,
  type RednoteBridgeRunner,
} from "./rednote-bridge.js";

assert.deepEqual(rednoteReadArgs("https://www.xiaohongshu.com/explore/example"), [
  "read",
  "https://www.xiaohongshu.com/explore/example",
  "--no-video",
]);

let receivedArgs: readonly string[] = [];
const runner: RednoteBridgeRunner = async (args) => {
  receivedArgs = args;
  return '{"mcp_healthy":true,"public_share_ready":true}';
};
assert.equal(
  await invokeRednoteBridge(runner, ["status"]),
  '{\n  "mcp_healthy": true,\n  "public_share_ready": true\n}',
);
assert.deepEqual(receivedArgs, ["status"]);

await assert.rejects(
  invokeRednoteBridge(async () => "not-json", ["status"]),
  /invalid JSON/,
);

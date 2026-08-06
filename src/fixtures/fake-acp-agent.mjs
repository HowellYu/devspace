// Fake ACP agent used by local-agent-acp.test.ts.
//
// Speaks newline-delimited JSON-RPC over stdio and persists session state to
// the JSON file named by FAKE_ACP_STORE so that separate processes can load
// sessions created by earlier runs, mirroring how real ACP agents persist
// conversations on disk.
//
// Environment:
//   FAKE_ACP_STORE          required; path to the JSON state file
//   FAKE_ACP_EVENTS         optional; lifecycle event log (one per line)
//   FAKE_ACP_STDERR         optional; written to stderr at startup
//   FAKE_ACP_CONFIG_OPTIONS optional; JSON array returned as configOptions
//                           from session/new and session/load

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const storePath = process.env.FAKE_ACP_STORE;
if (!storePath) {
  console.error("FAKE_ACP_STORE is required");
  process.exit(2);
}
const eventsPath = process.env.FAKE_ACP_EVENTS;
const configOptions = process.env.FAKE_ACP_CONFIG_OPTIONS
  ? JSON.parse(process.env.FAKE_ACP_CONFIG_OPTIONS)
  : undefined;

if (process.env.FAKE_ACP_STDERR) {
  console.error(process.env.FAKE_ACP_STDERR);
}

function logEvent(event) {
  if (!eventsPath) return;
  appendFileSync(eventsPath, `${event}\n`, "utf8");
}

process.on("SIGTERM", () => {
  logEvent("sigterm");
  process.exit(0);
});

function readStore() {
  if (!existsSync(storePath)) {
    return { newCalls: 0, loadCalls: 0, setConfigOptionCalls: [], sessions: {} };
  }
  return JSON.parse(readFileSync(storePath, "utf8"));
}

function writeStore(store) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function handleRequest(message) {
  const { id, method, params } = message;
  const store = readStore();

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: { name: "fake-acp-agent", title: "Fake ACP Agent", version: "0.0.1" },
      authMethods: [],
    });
    return;
  }

  if (method === "session/new") {
    store.newCalls += 1;
    const sessionId = `fake-session-${store.newCalls}`;
    store.sessions[sessionId] = { prompts: [] };
    writeStore(store);
    sendResult(id, {
      sessionId,
      ...(configOptions ? { configOptions } : {}),
    });
    return;
  }

  if (method === "session/load") {
    const sessionId = params?.sessionId;
    if (!sessionId || !store.sessions[sessionId]) {
      sendError(id, -32000, `unknown session: ${sessionId ?? "<missing>"}`);
      return;
    }
    store.loadCalls += 1;
    writeStore(store);
    sendResult(id, {
      ...(configOptions ? { configOptions } : {}),
    });
    return;
  }

  if (method === "session/set_config_option") {
    store.setConfigOptionCalls.push({
      sessionId: params?.sessionId,
      configId: params?.configId,
      value: params?.value,
    });
    writeStore(store);
    sendResult(id, {});
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const session = store.sessions[sessionId];
    if (!session) {
      sendError(id, -32000, `unknown session: ${sessionId ?? "<missing>"}`);
      return;
    }
    const text = promptText(params);
    session.prompts.push(text);
    writeStore(store);
    const reply = /recall/i.test(text) ? `recalled: ${session.prompts[0]}` : `ack: ${text}`;
    const midpoint = Math.ceil(reply.length / 2);
    for (const chunk of [reply.slice(0, midpoint), reply.slice(midpoint)]) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          },
        },
      });
    }
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  sendError(id, -32601, `method not found: ${method}`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notification
    handleRequest(message);
  }
});

logEvent("start");

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 130_000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export const DEFAULT_REDNOTE_BRIDGE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Clawd",
  "bin",
  "clawd-rednote",
);

export type RednoteBridgeRunner = (args: readonly string[]) => Promise<string>;

export function createRednoteBridgeRunner(
  bridgePath = DEFAULT_REDNOTE_BRIDGE_PATH,
): RednoteBridgeRunner {
  return (args) => new Promise((resolve, reject) => {
    execFile(
      bridgePath,
      [...args],
      {
        encoding: "utf8",
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(new Error(detail || "RedNote bridge failed."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function rednoteReadArgs(shareText: string): readonly string[] {
  return ["read", shareText, "--no-video"];
}

export async function invokeRednoteBridge(
  runner: RednoteBridgeRunner,
  args: readonly string[],
): Promise<string> {
  const raw = await runner(args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RedNote bridge returned invalid JSON.");
  }
  return JSON.stringify(parsed, null, 2);
}

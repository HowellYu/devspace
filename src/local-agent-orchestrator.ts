import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import {
  checkLocalAgentProviderAvailability,
  refreshLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  formatAvailableLocalAgentTargets,
  resolveLocalAgentTarget,
  type LocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStatus,
  type LocalAgentStore,
} from "./local-agent-store.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import { resolveDevspaceCliPath } from "./service.js";
import type { ServerConfig } from "./config.js";

export interface StartWorkerInput {
  workspaceId?: string;
  workspaceRoot: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
  fallback?: boolean;
}

export interface StartWorkerResult {
  record: LocalAgentRecord;
  fallbackUsed: boolean;
}

export interface ContinueWorkerInput {
  prompt: string;
  model?: string;
  thinking?: string;
}

export interface WaitWorkerResult {
  record: LocalAgentRecord;
  timedOut: boolean;
}

export interface InspectWorkerOptions {
  reviewCheckpoints?: ReviewCheckpointManager;
}

export interface InspectWorkerResult {
  record: LocalAgentRecord;
  checkpoint?: {
    summary: { files: number; additions: number; removals: number };
    files: Array<{
      path: string;
      type: string;
      additions: number;
      removals: number;
      previousPath?: string;
    }>;
  };
}

export interface LocalAgentOrchestrator {
  get(workerId: string): LocalAgentRecord | undefined;
  start(input: StartWorkerInput): Promise<StartWorkerResult>;
  continue(workerId: string, input: ContinueWorkerInput): Promise<LocalAgentRecord>;
  wait(workerId: string, timeoutSeconds: number): Promise<WaitWorkerResult>;
  inspect(workerId: string, options?: InspectWorkerOptions): Promise<InspectWorkerResult>;
  stop(workerId: string): Promise<LocalAgentRecord>;
  executeWorker(recordId: string, promptFile: string): Promise<void>;
}

export interface CreateLocalAgentOrchestratorOptions {
  runProvider?(
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult>;
  spawnWorker?(
    recordId: string,
    promptFile: string,
  ): ChildProcess | { pid?: number } | void | Promise<void>;
}

const AGENTS_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;
const AGENTS_WAIT_MAX_TIMEOUT_SECONDS = 3600;
const AGENTS_WAIT_POLL_MS = 750;

export function createLocalAgentOrchestrator(
  config: ServerConfig,
  store: LocalAgentStore,
  options: CreateLocalAgentOrchestratorOptions = {},
): LocalAgentOrchestrator {
  const runProvider = options.runProvider ?? runLocalAgentProvider;
  const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;

  return {
    get: (workerId) => store.get(workerId),

    async start(input): Promise<StartWorkerResult> {
      refreshLocalAgentProviderAvailabilitySnapshot();

      const profiles = await loadLocalAgentProfiles(config, input.workspaceRoot);
      const target = resolveLocalAgentTarget(input.target, profiles, input.model, input.thinking);
      if (!target) {
        throw new Error(
          `Unknown subagent profile, provider, or id: ${input.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
        );
      }

      const availability = refreshLocalAgentProviderAvailabilitySnapshot();
      const selected = selectProvider(target, availability, input.fallback);

      const record = store.create({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        profileName: target.name,
        provider: selected.provider,
        model: selected.model,
        thinking: selected.thinking,
      });

      const promptFile = writeAgentPromptFile(input.prompt);
      const child = await spawnWorker(record.id, promptFile);
      const workerPid = extractPid(child);
      if (workerPid) {
        store.update(record.id, { workerPid });
      }

      return { record: store.get(record.id)!, fallbackUsed: selected.fallbackUsed };
    },

    async continue(workerId, input): Promise<LocalAgentRecord> {
      let record = store.get(workerId);
      if (!record) {
        throw new Error(`Unknown subagent id: ${workerId}`);
      }

      refreshLocalAgentProviderAvailabilitySnapshot();
      assertProviderAvailable(record.provider);

      record = store.update(record.id, {
        status: "starting",
        model: input.model ?? record.model,
        thinking: input.thinking ?? record.thinking,
        latestResponse: undefined,
        error: undefined,
        workerPid: undefined,
      });

      const promptFile = writeAgentPromptFile(input.prompt);
      const child = await spawnWorker(record.id, promptFile);
      const workerPid = extractPid(child);
      if (workerPid) {
        record = store.update(record.id, { workerPid });
      }

      return record;
    },

    async wait(workerId, timeoutSeconds): Promise<WaitWorkerResult> {
      const deadline = Date.now() + timeoutSeconds * 1000;
      let record = store.get(workerId);
      if (!record) {
        throw new Error(`Unknown subagent id: ${workerId}`);
      }

      while (!isTerminalStatus(record.status) && Date.now() < deadline) {
        await sleep(AGENTS_WAIT_POLL_MS);
        record = store.get(workerId) ?? record;
      }

      return { record, timedOut: !isTerminalStatus(record.status) };
    },

    async inspect(workerId, options = {}): Promise<InspectWorkerResult> {
      const record = store.get(workerId);
      if (!record) {
        throw new Error(`Unknown subagent id: ${workerId}`);
      }

      const result: InspectWorkerResult = { record };

      if (options.reviewCheckpoints && record.workspaceId) {
        try {
          const review = await options.reviewCheckpoints.reviewChanges({
            workspaceId: record.workspaceId,
            root: record.workspaceRoot,
            since: "last_shown",
            markReviewed: false,
          });
          result.checkpoint = {
            summary: {
              files: review.summary.files,
              additions: review.summary.additions,
              removals: review.summary.removals,
            },
            files: review.files.map((file) => ({
              path: file.path,
              type: file.type,
              additions: file.additions,
              removals: file.removals,
              previousPath: file.previousPath,
            })),
          };
        } catch {
          // Omit checkpoint data when review checkpoints are unavailable.
        }
      }

      return result;
    },

    async stop(workerId): Promise<LocalAgentRecord> {
      const record = store.get(workerId);
      if (!record) {
        throw new Error(`Unknown subagent id: ${workerId}`);
      }
      if (isTerminalStatus(record.status)) {
        return record;
      }

      if (record.workerPid) {
        terminateWorker(record.workerPid);
      }

      return store.update(record.id, { status: "stopped" });
    },

    async executeWorker(recordId, promptFile): Promise<void> {
      const record = store.get(recordId);
      if (!record) {
        throw new Error(`Unknown subagent id: ${recordId}`);
      }

      const prompt = readFileSync(promptFile, "utf8");
      store.update(record.id, { status: "running", error: undefined });

      try {
        const profiles = await loadLocalAgentProfiles(config, record.workspaceRoot);
        const profile = profiles.find((candidate) => candidate.name === record.profileName);
        const result = profile
          ? await runProfileProvider(profile, record, prompt, runProvider)
          : await runRawProvider(record, prompt, runProvider);

        store.update(record.id, {
          providerSessionId: result.providerSessionId ?? undefined,
          status: "idle",
          latestResponse: result.finalResponse,
          error: undefined,
        });
      } catch (error) {
        store.update(record.id, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function defaultSpawnWorker(recordId: string, promptFile: string): ChildProcess {
  const cliPath = resolveDevspaceCliPath();
  const child = spawn(process.execPath, [
    ...process.execArgv,
    cliPath,
    "agents",
    "__worker",
    recordId,
    "--prompt-file",
    promptFile,
  ], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child;
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

async function runProfileProvider(
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt: string,
  runProvider: (
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ) => Promise<LocalAgentRunResult>,
): Promise<LocalAgentRunResult> {
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return runProvider(record.provider as LocalAgentProvider, {
    prompt: fullPrompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model ?? profile.model,
    thinking: record.thinking ?? profile.thinking,
  });
}

async function runRawProvider(
  record: LocalAgentRecord,
  prompt: string,
  runProvider: (
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ) => Promise<LocalAgentRunResult>,
): Promise<LocalAgentRunResult> {
  if (!isLocalAgentProvider(record.provider)) {
    throw new Error(`Unknown subagent provider: ${record.provider}`);
  }
  return runProvider(record.provider as LocalAgentProvider, {
    prompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model,
    thinking: record.thinking,
  });
}

function extractPid(
  child: ChildProcess | { pid?: number } | void | Promise<void>,
): number | undefined {
  if (child && typeof child === "object" && "pid" in child && typeof child.pid === "number") {
    return child.pid;
  }
  return undefined;
}

function terminateWorker(pid: number): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ESRCH") return;
      throw error;
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ESRCH") {
      throw error;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (innerError) {
      if (isErrnoException(innerError) && innerError.code === "ESRCH") return;
      throw innerError;
    }
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

interface SelectedProvider {
  provider: LocalAgentProvider;
  model?: string;
  thinking?: string;
  fallbackUsed: boolean;
}

function selectProvider(
  target: LocalAgentTarget,
  availability: LocalAgentProviderAvailability[],
  fallback?: boolean,
): SelectedProvider {
  const requested = target.provider;
  const requestedAvailability = availability.find((provider) => provider.name === requested);
  if (requestedAvailability?.available) {
    return {
      provider: requested,
      model: target.model,
      thinking: target.thinking,
      fallbackUsed: false,
    };
  }

  if (!fallback) {
    throw new Error(
      `${requested} provider is not available: ${requestedAvailability?.reason ?? "provider preflight failed"}`,
    );
  }

  const fallbackProvider = LOCAL_AGENT_PROVIDERS.find((provider) =>
    availability.find((candidate) => candidate.name === provider)?.available,
  );
  if (!fallbackProvider) {
    throw new Error("No subagent provider is available for fallback.");
  }

  return {
    provider: fallbackProvider,
    model: target.model,
    thinking: target.thinking,
    fallbackUsed: true,
  };
}

function assertProviderAvailable(provider: string): void {
  const availability = checkLocalAgentProviderAvailability(provider as LocalAgentProvider);
  if (availability.available) return;
  throw new Error(`${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`);
}

function isTerminalStatus(status: LocalAgentStatus): boolean {
  return status === "idle" || status === "error" || status === "stopped";
}

export function parseAgentsWaitTimeoutSeconds(raw: string | number | undefined): number {
  if (raw === undefined) {
    const env = process.env.DEVSPACE_AGENTS_WAIT_TIMEOUT;
    if (env) return parseAgentsWaitTimeoutSeconds(env);
    return AGENTS_WAIT_DEFAULT_TIMEOUT_SECONDS;
  }
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > AGENTS_WAIT_MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Invalid agents wait timeout: ${raw}. Expected between 1 and ${AGENTS_WAIT_MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

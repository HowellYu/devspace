import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

export const OPENAI_LUNA_KEYCHAIN_SERVICE = "devspace.openai-luna";

export interface LunaSecretStore {
  available(): boolean;
  read(): string;
  setInteractive(): void;
  delete(): boolean;
}

type SpawnSyncLike = typeof spawnSync;

export function createLunaSecretStore(
  platform: NodeJS.Platform = process.platform,
  account: string = userInfo().username,
  run: SpawnSyncLike = spawnSync,
): LunaSecretStore {
  if (platform !== "darwin") {
    return {
      available: () => false,
      read: () => {
        throw new Error("OpenAI Luna Keychain storage is currently supported on macOS only.");
      },
      setInteractive: () => {
        throw new Error("OpenAI Luna Keychain storage is currently supported on macOS only.");
      },
      delete: () => false,
    };
  }

  const base = ["-a", account, "-s", OPENAI_LUNA_KEYCHAIN_SERVICE];
  return {
    available(): boolean {
      const result = run("/usr/bin/security", ["find-generic-password", ...base], {
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0;
    },

    read(): string {
      const result = run("/usr/bin/security", ["find-generic-password", ...base, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const value = result.stdout?.trim();
      if (result.status !== 0 || !value) {
        throw new Error(
          "OpenAI Luna API key is not available in macOS Keychain. Run `devspace secret set openai-luna` locally.",
        );
      }
      return value;
    },

    setInteractive(): void {
      // `security` explicitly recommends putting `-w` last with no argument so
      // it prompts securely. The API key never appears in argv, shell history,
      // DevSpace config, or a workspace environment.
      const result = run(
        "/usr/bin/security",
        ["add-generic-password", ...base, "-U", "-w"],
        { stdio: "inherit", windowsHide: true },
      );
      if (result.status !== 0) {
        throw new Error(`Unable to store OpenAI Luna API key in Keychain (security exit ${result.status ?? "unknown"}).`);
      }
    },

    delete(): boolean {
      const result = run("/usr/bin/security", ["delete-generic-password", ...base], {
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0;
    },
  };
}

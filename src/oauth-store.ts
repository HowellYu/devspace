import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

function previouslyApprovedRedirectMatches(
  approvedRedirectUri: string,
  requestedRedirectUri: string,
): boolean {
  if (approvedRedirectUri === requestedRedirectUri) return true;

  try {
    const approved = new URL(approvedRedirectUri);
    const requested = new URL(requestedRedirectUri);
    return approved.origin === "https://chatgpt.com" && requested.origin === approved.origin;
  } catch {
    return false;
  }
}

function reusableApprovalOrigin(
  client: OAuthClientInformationFull,
  redirectUri: string,
): string | undefined {
  if (client.client_name !== "ChatGPT") return undefined;
  try {
    const parsed = new URL(redirectUri);
    return parsed.origin === "https://chatgpt.com" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  rememberAuthorization(input: {
    client: OAuthClientInformationFull;
    redirectUri: string;
    scopes: string[];
    resource?: string;
    nowSeconds?: number;
  }): void {
    const redirectOrigin = reusableApprovalOrigin(input.client, input.redirectUri);
    if (!redirectOrigin) return;

    const resource = input.resource ?? null;
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `delete from oauth_client_approvals
           where client_name = ? and redirect_origin = ? and resource is ?`,
        )
        .run(input.client.client_name ?? "", redirectOrigin, resource);
      this.database.sqlite
        .prepare(
          `insert into oauth_client_approvals
             (client_name, redirect_origin, scopes_json, resource, approved_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(
          input.client.client_name ?? "",
          redirectOrigin,
          JSON.stringify(input.scopes),
          resource,
          input.nowSeconds ?? Math.floor(Date.now() / 1000),
        );
    });
    transaction.immediate();
  }

  hasReusableAuthorization(input: {
    client: OAuthClientInformationFull;
    redirectUri: string;
    scopes: string[];
    resource?: string;
    nowSeconds?: number;
  }): boolean {
    const redirectOrigin = reusableApprovalOrigin(input.client, input.redirectUri);
    if (redirectOrigin) {
      const approvals = this.database.sqlite
        .prepare(
          `select scopes_json, resource
           from oauth_client_approvals
           where client_name = ? and redirect_origin = ?`,
        )
        .all(input.client.client_name ?? "", redirectOrigin) as Array<{
          scopes_json: string;
          resource: string | null;
        }>;
      const remembered = approvals.some((row) => {
        const approvedScopes = JSON.parse(row.scopes_json) as string[];
        return input.scopes.every((scope) => approvedScopes.includes(scope))
          && (row.resource ?? undefined) === input.resource;
      });
      if (remembered) return true;
    }

    // Migration path for installations that already have valid refresh tokens
    // from before durable approval records were introduced.
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const rows = this.database.sqlite
      .prepare(
        `select c.client_json, t.scopes_json, t.resource
         from oauth_refresh_tokens t
         join oauth_clients c on c.client_id = t.client_id
         where t.expires_at >= ?`,
      )
      .all(nowSeconds) as Array<{
        client_json: string;
        scopes_json: string;
        resource: string | null;
      }>;

    return rows.some((row) => {
      const approvedClient = JSON.parse(row.client_json) as OAuthClientInformationFull;
      if ((approvedClient.client_name ?? "") !== (input.client.client_name ?? "")) return false;
      if (!approvedClient.redirect_uris.map(String).some((uri) =>
        previouslyApprovedRedirectMatches(uri, input.redirectUri)
      )) return false;

      const approvedScopes = JSON.parse(row.scopes_json) as string[];
      if (!input.scopes.every((scope) => approvedScopes.includes(scope))) return false;
      return (row.resource ?? undefined) === input.resource;
    });
  }

  forgetAuthorizationsForClient(client: OAuthClientInformationFull): void {
    const origins = Array.from(new Set(
      client.redirect_uris
        .map(String)
        .map((uri) => reusableApprovalOrigin(client, uri))
        .filter((origin): origin is string => Boolean(origin)),
    ));
    if (origins.length === 0) return;

    const clientRows = this.database.sqlite
      .prepare("select client_id, client_json from oauth_clients")
      .all() as Array<{ client_id: string; client_json: string }>;
    const relatedClientIds = clientRows
      .filter((row) => {
        const candidate = JSON.parse(row.client_json) as OAuthClientInformationFull;
        if ((candidate.client_name ?? "") !== (client.client_name ?? "")) return false;
        return candidate.redirect_uris.map(String).some((uri) => {
          const origin = reusableApprovalOrigin(candidate, uri);
          return origin !== undefined && origins.includes(origin);
        });
      })
      .map((row) => row.client_id);

    const removeApproval = this.database.sqlite.prepare(
      "delete from oauth_client_approvals where client_name = ? and redirect_origin = ?",
    );
    const removeAccessTokens = this.database.sqlite.prepare(
      "delete from oauth_access_tokens where client_id = ?",
    );
    const removeRefreshTokens = this.database.sqlite.prepare(
      "delete from oauth_refresh_tokens where client_id = ?",
    );
    const transaction = this.database.sqlite.transaction(() => {
      for (const origin of origins) removeApproval.run(client.client_name ?? "", origin);
      for (const clientId of relatedClientIds) {
        removeAccessTokens.run(clientId);
        removeRefreshTokens.run(clientId);
      }
    });
    transaction.immediate();
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

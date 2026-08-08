import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

const ownerToken = "test-owner-token-that-is-long-enough";
const oauthConfig = {
  ownerToken,
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

const client = {
  client_id: "client-1",
  client_name: "ChatGPT",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_id_issued_at: Math.floor(Date.now() / 1000),
};

const params = {
  redirectUri,
  codeChallenge: "challenge",
  scopes: ["devspace"],
  resource: mcpUrl,
};

function makeResponse(options: {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  ip?: string;
  remoteAddress?: string;
}): MockResponse {
  const statusCodes: number[] = [];
  const headers: Record<string, string | string[] | undefined> = {};
  const bodies: unknown[] = [];
  const redirects: string[] = [];

  const req = {
    method: options.method ?? "GET",
    body: options.body ?? {},
    headers: options.headers ?? {},
    header(name: string) {
      return this.headers[name.toLowerCase()];
    },
    ip: options.ip,
    socket: { remoteAddress: options.remoteAddress },
  };

  const res: MockResponse = {
    req,
    status(code: number) {
      statusCodes.push(code);
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      headers[name] = value;
      return this;
    },
    send(body: unknown) {
      bodies.push(body);
      return this;
    },
    redirect(code: number, url: string) {
      statusCodes.push(code);
      redirects.push(url);
      return this;
    },
    get statusCode() {
      return statusCodes[statusCodes.length - 1];
    },
    get sentHeaders() {
      return headers;
    },
    get sentBody() {
      return bodies[bodies.length - 1];
    },
    get redirectUrl() {
      return redirects[redirects.length - 1];
    },
  } as unknown as MockResponse;

  return res;
}

interface MockResponse extends Response {
  sentHeaders: Record<string, string | string[] | undefined>;
  sentBody: unknown;
  redirectUrl: string | undefined;
}

async function withProvider(testFn: (provider: SingleUserOAuthProvider) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "devspace-oauth-provider-test-"));
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, root, mcpUrl.origin, false);
  try {
    await testFn(provider);
  } finally {
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

function extractCookieNonce(setCookie: string | string[] | undefined): string | undefined {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) return undefined;
  const match = value.match(/devspace_auth_nonce=([^;]+)/);
  return match?.[1];
}

function extractFormNonce(body: string): string | undefined {
  const match = body.match(/name="devspace_auth_nonce" value="([^"]+)"/);
  return match?.[1];
}

test("GET authorize sets a CSRF nonce cookie and form field", async () => {
  await withProvider(async (provider) => {
    const res = makeResponse({});
    await provider.authorize(client, params, res);

    assert.equal(res.statusCode, 200);
    const cookie = res.sentHeaders["Set-Cookie"];
    assert.ok(cookie, "expected Set-Cookie header");
    const body = String(res.sentBody);
    const formNonce = extractFormNonce(body);
    const cookieNonce = extractCookieNonce(cookie);
    assert.ok(formNonce, "expected nonce in form");
    assert.ok(cookieNonce, "expected nonce in cookie");
    assert.equal(formNonce, cookieNonce);
    assert.match(String(cookie), /SameSite=Strict/);
    assert.match(String(cookie), /HttpOnly/);
  });
});

test("POST authorize with valid token, origin, and nonce redirects with code", async () => {
  await withProvider(async (provider) => {
    const getRes = makeResponse({});
    await provider.authorize(client, params, getRes);
    const cookie = getRes.sentHeaders["Set-Cookie"];
    const nonce = extractCookieNonce(cookie);

    const postRes = makeResponse({
      method: "POST",
      body: { owner_token: ownerToken, devspace_auth_nonce: nonce },
      headers: {
        cookie: `devspace_auth_nonce=${nonce}`,
        origin: mcpUrl.origin,
      },
      ip: "1.2.3.4",
    });
    await provider.authorize(client, params, postRes);

    assert.equal(postRes.statusCode, 302);
    assert.ok(postRes.redirectUrl?.includes("code="));
  });
});

test("POST authorize rejects mismatched or missing CSRF nonce", async () => {
  await withProvider(async (provider) => {
    const res = makeResponse({
      method: "POST",
      body: { owner_token: ownerToken },
      headers: { origin: mcpUrl.origin },
      ip: "1.2.3.4",
    });
    await provider.authorize(client, params, res);
    assert.equal(res.statusCode, 403);
    assert.match(String(res.sentBody), /Missing authorization session/);

    const res2 = makeResponse({
      method: "POST",
      body: { owner_token: ownerToken, devspace_auth_nonce: "wrong" },
      headers: { cookie: "devspace_auth_nonce=different", origin: mcpUrl.origin },
      ip: "1.2.3.4",
    });
    await provider.authorize(client, params, res2);
    assert.equal(res2.statusCode, 403);
    assert.match(String(res2.sentBody), /expired or mismatched/);
  });
});

test("POST authorize rejects wrong origin", async () => {
  await withProvider(async (provider) => {
    const getRes = makeResponse({});
    await provider.authorize(client, params, getRes);
    const cookie = getRes.sentHeaders["Set-Cookie"];
    const nonce = extractCookieNonce(cookie);

    const res = makeResponse({
      method: "POST",
      body: { owner_token: ownerToken, devspace_auth_nonce: nonce },
      headers: {
        cookie: `devspace_auth_nonce=${nonce}`,
        origin: "https://attacker.example.com",
      },
      ip: "1.2.3.4",
    });
    await provider.authorize(client, params, res);
    assert.equal(res.statusCode, 403);
    assert.match(String(res.sentBody), /Invalid Origin header/);
  });
});

test("POST authorize rejects wrong owner token and rate limits after max attempts", async () => {
  await withProvider(async (provider) => {
    const getRes = makeResponse({});
    await provider.authorize(client, params, getRes);
    const cookie = getRes.sentHeaders["Set-Cookie"];
    const nonce = extractCookieNonce(cookie);

    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = makeResponse({
        method: "POST",
        body: { owner_token: "wrong", devspace_auth_nonce: nonce },
        headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
        ip: "1.2.3.4",
      });
      await provider.authorize(client, params, res);
      lastStatus = res.statusCode ?? 0;
    }
    assert.equal(lastStatus, 429);
  });
});

test("successful authorization clears rate limit failures", async () => {
  await withProvider(async (provider) => {
    const getRes = makeResponse({});
    await provider.authorize(client, params, getRes);
    const cookie = getRes.sentHeaders["Set-Cookie"];
    const nonce = extractCookieNonce(cookie);

    const failRes = makeResponse({
      method: "POST",
      body: { owner_token: "wrong", devspace_auth_nonce: nonce },
      headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
      ip: "2.3.4.5",
    });
    await provider.authorize(client, params, failRes);
    assert.equal(failRes.statusCode, 401);

    const okRes = makeResponse({
      method: "POST",
      body: { owner_token: ownerToken, devspace_auth_nonce: nonce },
      headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
      ip: "2.3.4.5",
    });
    await provider.authorize(client, params, okRes);
    assert.equal(okRes.statusCode, 302);

    const failRes2 = makeResponse({
      method: "POST",
      body: { owner_token: "wrong", devspace_auth_nonce: nonce },
      headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
      ip: "2.3.4.5",
    });
    await provider.authorize(client, params, failRes2);
    assert.equal(failRes2.statusCode, 401);
  });
});

test("rate limit keys are separated by IP", async () => {
  await withProvider(async (provider) => {
    const getRes = makeResponse({});
    await provider.authorize(client, params, getRes);
    const cookie = getRes.sentHeaders["Set-Cookie"];
    const nonce = extractCookieNonce(cookie);

    for (let i = 0; i < 12; i++) {
      const res = makeResponse({
        method: "POST",
        body: { owner_token: "wrong", devspace_auth_nonce: nonce },
        headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
        ip: i % 2 === 0 ? "10.0.0.1" : "10.0.0.2",
      });
      await provider.authorize(client, params, res);
    }

    const res = makeResponse({
      method: "POST",
      body: { owner_token: "wrong", devspace_auth_nonce: nonce },
      headers: { cookie: `devspace_auth_nonce=${nonce}`, origin: mcpUrl.origin },
      ip: "10.0.0.1",
    });
    await provider.authorize(client, params, res);
    assert.equal(res.statusCode, 401);
  });
});

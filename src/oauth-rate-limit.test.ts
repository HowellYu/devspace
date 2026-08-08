import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEquals, OAuthRateLimiter, requestRateLimitKey } from "./oauth-rate-limit.js";

function makeRequest(headers: Record<string, string | undefined>, ip?: string, socketRemoteAddress?: string): unknown {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    ip,
    socket: { remoteAddress: socketRemoteAddress },
  };
}

test("constantTimeEquals rejects mismatched lengths and values", () => {
  assert.equal(constantTimeEquals("short", "short"), true);
  assert.equal(constantTimeEquals("short", "longer-value"), false);
  assert.equal(constantTimeEquals("a", "b"), false);
  assert.equal(constantTimeEquals("", ""), true);
});

test("requestRateLimitKey prefers direct address and ignores forwarded headers unless trustProxy is true", () => {
  const direct = makeRequest({}, "1.2.3.4", "5.6.7.8") as Parameters<typeof requestRateLimitKey>[0];
  assert.equal(requestRateLimitKey(direct, false), "direct:1.2.3.4");
  assert.equal(requestRateLimitKey(direct, true), "direct:1.2.3.4");

  const proxied = makeRequest({ "x-forwarded-for": "9.10.11.12, 1.2.3.4" }, "1.2.3.4", "5.6.7.8") as Parameters<typeof requestRateLimitKey>[0];
  assert.equal(requestRateLimitKey(proxied, false), "direct:1.2.3.4");
  assert.equal(requestRateLimitKey(proxied, true), "xff:9.10.11.12");

  const cfProxied = makeRequest({ "cf-connecting-ip": "13.14.15.16", "x-forwarded-for": "9.10.11.12" }, "1.2.3.4") as Parameters<typeof requestRateLimitKey>[0];
  assert.equal(requestRateLimitKey(cfProxied, true), "cf:13.14.15.16");

  const empty = makeRequest({}) as Parameters<typeof requestRateLimitKey>[0];
  assert.equal(requestRateLimitKey(empty, false), "unknown");
});

test("rate limiter allows attempts up to the limit then locks out", () => {
  const limiter = new OAuthRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 });
  const key = "client-1";
  const start = 0;

  assert.equal(limiter.isAllowed(key, start).allowed, true);
  limiter.recordFailure(key, start);
  assert.equal(limiter.isAllowed(key, start + 1).allowed, true);
  limiter.recordFailure(key, start + 1);
  assert.equal(limiter.isAllowed(key, start + 2).allowed, true);
  limiter.recordFailure(key, start + 2);

  const blocked = limiter.isAllowed(key, start + 3);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 120_000);
  assert.equal(limiter.isAllowed(key, start + 3 + 120_000).allowed, true);
});

test("rate limiter resets the window after it expires without hitting the limit", () => {
  const limiter = new OAuthRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 });
  const key = "client-2";
  const start = 0;

  limiter.recordFailure(key, start);
  limiter.recordFailure(key, start + 1);
  assert.equal(limiter.isAllowed(key, start + 2).allowed, true);

  assert.equal(limiter.isAllowed(key, start + 60_000).allowed, true);
  limiter.recordFailure(key, start + 60_000);
  limiter.recordFailure(key, start + 60_001);
  assert.equal(limiter.isAllowed(key, start + 60_002).allowed, true);
});

test("rate limiter clears failures on success", () => {
  const limiter = new OAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 120_000 });
  const key = "client-3";

  limiter.recordFailure(key, 0);
  limiter.recordSuccess(key);
  limiter.recordFailure(key, 1);
  limiter.recordFailure(key, 2);
  assert.equal(limiter.isAllowed(key, 3).allowed, false);
});

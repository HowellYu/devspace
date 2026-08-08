import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export interface OAuthRateLimiterConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

export interface OAuthRateLimitAttempt {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

export const DEFAULT_OAUTH_RATE_LIMITER_CONFIG: OAuthRateLimiterConfig = {
  maxAttempts: 10,
  windowMs: 5 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
};

export class OAuthRateLimiter {
  private readonly attempts = new Map<string, OAuthRateLimitAttempt>();

  constructor(private readonly config: OAuthRateLimiterConfig = DEFAULT_OAUTH_RATE_LIMITER_CONFIG) {}

  isAllowed(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const record = this.attempts.get(key);
    if (!record) return { allowed: true };

    if (record.lockedUntil > now) {
      return { allowed: false, retryAfterMs: record.lockedUntil - now };
    }

    if (record.attempts >= this.config.maxAttempts && now - record.firstAttemptAt < this.config.windowMs) {
      const lockedUntil = now + this.config.lockoutMs;
      record.lockedUntil = lockedUntil;
      return { allowed: false, retryAfterMs: this.config.lockoutMs };
    }

    return { allowed: true };
  }

  recordFailure(key: string, now = Date.now()): void {
    const record = this.attempts.get(key);
    if (!record || now - record.firstAttemptAt >= this.config.windowMs) {
      this.attempts.set(key, {
        attempts: 1,
        firstAttemptAt: now,
        lockedUntil: 0,
      });
      return;
    }

    record.attempts += 1;
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  snapshot(key: string): OAuthRateLimitAttempt | undefined {
    return this.attempts.get(key);
  }
}

export function constantTimeEquals(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

export function requestRateLimitKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return `cf:${cfConnectingIp}`;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return `xff:${forwardedFor}`;
  }

  const direct = req.ip ?? req.socket.remoteAddress;
  return direct ? `direct:${direct}` : "unknown";
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

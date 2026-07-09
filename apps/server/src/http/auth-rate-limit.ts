/**
 * Login Rate Limiter (In-Memory Sliding Window)
 *
 * Implements per-IP and per-email rate limiting for the login endpoint.
 * Uses two independent sliding-window buckets per attempt:
 * - IP-based: prevents a single source from brute-forcing any account
 * - Email-based: prevents distributed brute-force on a specific account
 *
 * Design Decision:
 * We intentionally use separate buckets for IP and email rather than a
 * combined key. This prevents an attacker from rotating IPs to bypass
 * the email-level limit, while also preventing a single IP from trying
 * many different emails.
 *
 * Does NOT:
 * - Persist state across server restarts (in-memory only)
 * - Rate-limit other endpoints (those use a separate WS rate limiter)
 *
 * Future Evolution:
 * - Replace with Redis-backed sliding window for horizontal scaling
 */
export type AuthRateLimitDecision = { limited: boolean; retryAfterSeconds?: number };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const windowMs = 60_000;
const maxFailures = 5;

const now = () => Date.now();

const bucketFor = (key: string) => {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now()) return existing;
  const created = { count: 0, resetAt: now() + windowMs };
  buckets.set(key, created);
  return created;
};

export const authRateLimiter = {
  check(ip: string, email: string): AuthRateLimitDecision {
    const ipBucket = bucketFor(`ip:${ip}`);
    const emailBucket = bucketFor(`email:${email.toLowerCase()}`);
    const retryAfterSeconds = Math.ceil((Math.max(ipBucket.resetAt, emailBucket.resetAt) - now()) / 1000);
    return ipBucket.count >= maxFailures || emailBucket.count >= maxFailures ? { limited: true, retryAfterSeconds } : { limited: false };
  },
  recordFailure(ip: string, email: string) {
    bucketFor(`ip:${ip}`).count += 1;
    bucketFor(`email:${email.toLowerCase()}`).count += 1;
  },
  reset() {
    buckets.clear();
  }
};

export const clientIpFromHeaders = (headers: { get(name: string): string | null | undefined }) => {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || headers.get("x-real-ip") || "local";
};

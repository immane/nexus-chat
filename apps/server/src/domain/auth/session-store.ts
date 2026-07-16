/**
 * Refresh Session Store
 *
 * Defines the RefreshSessionStore interface with two implementations:
 * - InMemoryRefreshSessionStore: default for dev, stores in InMemoryStore.refreshSessions
 * - RedisRefreshSessionStore: production-ready, stores in Redis with PXAT expiry
 *
 * Implementation selection is controlled by env.SESSION_STORE ("memory" | "redis").
 *
 * Design Decision:
 * We use an interface rather than a conditional class because the two backends
 * have fundamentally different semantics (Map vs Redis with TTL). The interface
 * allows the auth service to be completely agnostic of the storage backend.
 *
 * Invariants:
 * - Redis implementation uses lazyConnect to avoid blocking server startup
 * - Refresh tokens expire at session.expiresAt (set via Redis PXAT)
 * - Revoked sessions persist with a revokedAt marker until natural expiry
 */
import { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { store, type RefreshSession } from "../store.js";

export interface RefreshSessionStore {
  set(refreshToken: string, session: RefreshSession): Promise<void>;
  get(refreshToken: string): Promise<RefreshSession | undefined>;
  revoke(refreshToken: string): Promise<void>;
}

export class InMemoryRefreshSessionStore implements RefreshSessionStore {
  async set(refreshToken: string, session: RefreshSession) {
    store.refreshSessions.set(refreshToken, session);
  }

  async get(refreshToken: string) {
    return store.refreshSessions.get(refreshToken);
  }

  async revoke(refreshToken: string) {
    const session = store.refreshSessions.get(refreshToken);
    if (session) session.revokedAt = Date.now();
  }
}

export class RedisRefreshSessionStore implements RefreshSessionStore {
  private readonly redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  async set(refreshToken: string, session: RefreshSession) {
    await this.ensureConnected();
    await this.redis.set(this.key(refreshToken), JSON.stringify(session), "PXAT", session.expiresAt);
  }

  async get(refreshToken: string) {
    await this.ensureConnected();
    const raw = await this.redis.get(this.key(refreshToken));
    return raw ? (JSON.parse(raw) as RefreshSession) : undefined;
  }

  async revoke(refreshToken: string) {
    const session = await this.get(refreshToken);
    if (!session) return;
    await this.set(refreshToken, { ...session, revokedAt: Date.now() });
  }

  async ping() {
    await this.ensureConnected();
    await this.redis.ping();
  }

  private key(refreshToken: string) {
    return `auth:refresh:${refreshToken}`;
  }

  private async ensureConnected() {
    if (this.redis.status === "wait") await this.redis.connect();
  }
}

export const refreshSessionStore: RefreshSessionStore = env.SESSION_STORE === "redis" ? new RedisRefreshSessionStore() : new InMemoryRefreshSessionStore();

/** Verifies the configured Redis session backend without touching session data. */
export async function pingSessionStore(): Promise<void> {
  if (refreshSessionStore instanceof RedisRefreshSessionStore)
    await refreshSessionStore.ping();
}

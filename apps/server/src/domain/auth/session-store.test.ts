import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshSession } from "../store.js";
import { resetStore } from "../test-utils.js";

const redisState = new Map<string, string>();
const redisInstances: Array<{ status: string; connect: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }> = [];

vi.mock("ioredis", () => ({
  Redis: class RedisMock {
    status = "wait";
    connect = vi.fn(async () => { this.status = "ready"; });
    get = vi.fn(async (key: string) => redisState.get(key) ?? null);
    set = vi.fn(async (key: string, value: string) => { redisState.set(key, value); });

    constructor() {
      redisInstances.push(this);
    }
  }
}));

describe("refresh session stores", () => {
  beforeEach(() => {
    resetStore();
    redisState.clear();
    redisInstances.length = 0;
  });

  it("stores gets and revokes in-memory refresh sessions", async () => {
    const { InMemoryRefreshSessionStore } = await import("./session-store.js");
    const store = new InMemoryRefreshSessionStore();
    const session: RefreshSession = { userId: "user-1", tokenHash: "hash", expiresAt: Date.now() + 1000 };

    await store.set("refresh", session);
    expect(await store.get("refresh")).toEqual(session);
    await store.revoke("refresh");
    expect(await store.get("refresh")).toMatchObject({ revokedAt: expect.any(Number) });
    await expect(store.revoke("missing")).resolves.toBeUndefined();
  });

  it("stores gets revokes and skips missing Redis refresh sessions", async () => {
    const { RedisRefreshSessionStore } = await import("./session-store.js");
    const store = new RedisRefreshSessionStore();
    const session: RefreshSession = { userId: "user-1", tokenHash: "hash", expiresAt: Date.now() + 1000 };

    await store.set("refresh", session);
    expect(redisInstances[0]?.connect).toHaveBeenCalledOnce();
    expect(await store.get("refresh")).toEqual(session);
    await store.revoke("refresh");
    expect(await store.get("refresh")).toMatchObject({ revokedAt: expect.any(Number) });
    await expect(store.revoke("missing")).resolves.toBeUndefined();
  });
});

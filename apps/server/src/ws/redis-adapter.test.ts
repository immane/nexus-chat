import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  adapter: vi.fn(),
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; duplicate: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn> }>
}));

vi.mock("@socket.io/redis-adapter", () => ({ createAdapter: state.adapter }));

vi.mock("ioredis", () => ({
  Redis: class RedisMock {
    connect = vi.fn(async () => {});
    quit = vi.fn(async () => {});
    duplicate = vi.fn(() => new RedisMock());

    constructor() {
      state.clients.push(this);
    }
  }
}));

describe("Socket.IO Redis adapter", () => {
  beforeEach(() => {
    state.adapter.mockReset();
    state.adapter.mockReturnValue("redis-adapter");
    state.clients.length = 0;
  });

  it("keeps the in-memory adapter without creating Redis clients", async () => {
    const { configureSocketIoAdapter } = await import("./redis-adapter.js");
    const io = { adapter: vi.fn() };

    await configureSocketIoAdapter(io as never, "memory");

    expect(state.clients).toHaveLength(0);
    expect(io.adapter).not.toHaveBeenCalled();
  });

  it("connects Redis pub/sub clients, installs the adapter, and closes both clients", async () => {
    const { configureSocketIoAdapter } = await import("./redis-adapter.js");
    const io = { adapter: vi.fn() };

    const close = await configureSocketIoAdapter(io as never, "redis");

    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]?.connect).toHaveBeenCalledOnce();
    expect(state.clients[1]?.connect).toHaveBeenCalledOnce();
    expect(state.adapter).toHaveBeenCalledWith(state.clients[0], state.clients[1]);
    expect(io.adapter).toHaveBeenCalledWith("redis-adapter");

    await close();
    expect(state.clients[0]?.quit).toHaveBeenCalledOnce();
    expect(state.clients[1]?.quit).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotEvent, BotManifest, SendMessageInput } from "@nexus-chat/shared";

const socket = { on: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() };
vi.mock("socket.io-client", () => ({ io: vi.fn(() => socket) }));

const manifest: BotManifest = {
  id: "bot-help",
  name: "HelpBot",
  description: "Help",
  commands: [{ name: "/help", description: "Help" }],
  scopes: ["commands:handle", "messages:write"]
};

describe("NexusBotClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects to bot namespace and disconnects", async () => {
    const { NexusBotClient } = await import("./index.js");
    const { io } = await import("socket.io-client");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    client.connect();
    expect(io).toHaveBeenCalledWith("http://localhost:4000/bots", { transports: ["websocket"], auth: { token: "nxbot_v1_token" }, reconnection: false });
    expect(socket.on).toHaveBeenCalledWith("bot.event", expect.any(Function));
    client.disconnect();
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.removeAllListeners).toHaveBeenCalled();
  });

  it("handles event subscriptions", async () => {
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await client.subscribe("message.created");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/bots/subscriptions?eventType=message.created", expect.objectContaining({ method: "POST" }));
    await client.unsubscribe("message.created");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/bots/subscriptions?eventType=message.created", expect.objectContaining({ method: "DELETE" }));
  });

  it("dispatches to event handler when no command matches", async () => {
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const calls: string[] = [];
    client.onEvent("message.created", () => { calls.push("event"); });
    client.onCommand("/help", () => { calls.push("command"); });
    client.connect();
    const handler = socket.on.mock.calls.find((c) => c[0] === "bot.event")?.[1] as ((event: BotEvent) => void) | undefined;
    handler?.({ id: "event-1", type: "message.created", workspaceId: "workspace-1", channelId: "channel-1", payload: { text: "hello" }, createdAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["event"]);
  });

  it("handles slash_command event alias", async () => {
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const calls: string[] = [];
    client.on("slash_command", (event: BotEvent) => { calls.push((event.payload as { command?: string }).command ?? ""); });
    client.connect();
    const handler = socket.on.mock.calls.find((c) => c[0] === "bot.event")?.[1] as ((event: BotEvent) => void) | undefined;
    handler?.({ id: "event-1", type: "bot.command.invoke", workspaceId: "workspace-1", channelId: "channel-1", payload: { command: "/ping" }, createdAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["/ping"]);
  });

  it("handles generic on event aliases and ignores events without handlers", async () => {
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const calls: string[] = [];
    client.on("message.created", () => { calls.push("message"); });
    client.connect();
    const handler = socket.on.mock.calls.find((c) => c[0] === "bot.event")?.[1] as ((event: BotEvent) => void) | undefined;
    handler?.({ id: "event-1", type: "message.created", workspaceId: "workspace-1", channelId: "channel-1", payload: {}, createdAt: new Date().toISOString() });
    handler?.({ id: "event-2", type: "workspace.member_added", workspaceId: "workspace-1", channelId: "channel-1", payload: {}, createdAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["message"]);
  });

  it("resets and schedules reconnects from socket lifecycle events", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });

    client.connect();
    const connectHandler = socket.on.mock.calls.find((c) => c[0] === "connect")?.[1] as (() => void) | undefined;
    const disconnectHandler = socket.on.mock.calls.find((c) => c[0] === "disconnect")?.[1] as (() => void) | undefined;
    connectHandler?.();
    disconnectHandler?.();

    await vi.advanceTimersByTimeAsync(1000);
    const { io } = await import("socket.io-client");
    expect(io).toHaveBeenCalledTimes(2);
  });

  it("runs middleware before command handler", async () => {
    const { NexusBotClient } = await import("./index.js");
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const calls: string[] = [];
    client.use(async (_event, next) => {
      calls.push("middleware-before");
      await next();
      calls.push("middleware-after");
    });
    client.onCommand("/help", () => {
      calls.push("handler");
    });
    client.connect();
    const handler = socket.on.mock.calls.find((c) => c[0] === "bot.event")?.[1] as ((event: BotEvent) => void) | undefined;
    handler?.({ id: "event-1", type: "bot.command.invoke", workspaceId: "workspace-1", channelId: "channel-1", payload: { command: "/help" }, createdAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["middleware-before", "handler", "middleware-after"]);
  });

  it("sends messages via bot endpoint and surfaces rate limits", async () => {
    const { NexusBotClient } = await import("./index.js");
    const input: SendMessageInput = { workspaceId: "workspace-1", channelId: "channel-1", clientMsgId: "client-1", content: { type: "text", text: "hello", attachments: [] } };
    const fetchMock = vi.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) }).mockResolvedValueOnce({ status: 429, headers: { get: () => "3" }, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_secret", manifest });
    await expect(client.sendMessage(input)).resolves.toEqual({ ok: true });
    await expect(client.sendMessage(input)).rejects.toThrow("Rate limited, retry after 3");
    fetchMock.mockResolvedValueOnce({ status: 429, headers: { get: () => null }, json: async () => ({}) });
    await expect(client.sendMessage(input)).rejects.toThrow("Rate limited, retry after unknown");
  });

  it("fetches channel info", async () => {
    const { NexusBotClient } = await import("./index.js");
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, data: [{ id: "channel-1", name: "general" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NexusBotClient({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token", manifest });
    const channel = await client.getChannelInfo("workspace-1", "channel-1");
    expect(channel).toEqual({ id: "channel-1", name: "general" });
    const missingMatch = await client.getChannelInfo("workspace-1", "channel-2");
    expect(missingMatch).toBeNull();
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false }) });
    const missing = await client.getChannelInfo("workspace-1", "channel-1");
    expect(missing).toBeNull();
  });

  it("redacts bot tokens", async () => {
    const { redactToken } = await import("./index.js");
    expect(redactToken("token nxbot_v1_abc123_DEF is secret")).toBe("token nxbot_v1_[REDACTED] is secret");
  });
});

describe("reconnect manager", () => {
  it("returns exponential backoff delays with jitter up to max delay", async () => {
    const { createReconnectManager } = await import("./index.js");
    const rm = createReconnectManager({ baseDelayMs: 100, maxDelayMs: 2000 });
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) delays.push(rm.nextDelay() ?? -1);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(600);
    expect(delays[10]).toBe(-1);
    expect(rm.attempt).toBe(10);
    rm.reset();
    expect(rm.attempt).toBe(0);
    const afterReset = rm.nextDelay();
    expect(afterReset).toBeGreaterThanOrEqual(100);
  });
});

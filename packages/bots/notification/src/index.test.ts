import { describe, expect, it, vi } from "vitest";

vi.mock("socket.io-client", () => ({ io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() })) }));

describe("notification bot", () => {
  it("formats announcements", async () => {
    const { announcement, manifest } = await import("./index.js");
    expect(manifest.name).toBe("NotificationBot");
    expect(announcement("Deploy today")).toBe("[Announcement] Deploy today");
  });

  it("createNotificationBot registers event handler for announcements", async () => {
    const { createNotificationBot } = await import("./index.js");
    const { NexusBotClient } = await import("@nexus-chat/bot-sdk");
    const sendSpy = vi.spyOn(NexusBotClient.prototype, "sendMessage").mockResolvedValue({ ok: true });
    const onEventSpy = vi.spyOn(NexusBotClient.prototype, "onEvent");
    createNotificationBot({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token" });
    expect(onEventSpy).toHaveBeenCalledWith("bot.command.invoke", expect.any(Function));
    const handler = onEventSpy.mock.calls[0]?.[1] as ((e: unknown) => void | Promise<void>) | undefined;
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { command: "/announce", args: "Deploy today", channelId: "ch1" } });
    expect(sendSpy).toHaveBeenCalled();
    sendSpy.mockClear();
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { command: "/help", args: "Deploy today", channelId: "ch1" } });
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { command: "/announce", args: "   ", channelId: "ch1" } });
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { command: "/announce", args: "Deploy today" } });
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
    onEventSpy.mockRestore();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("socket.io-client", () => ({ io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() })) }));

describe("welcome bot", () => {
  it("declares manifest and message", async () => {
    const { manifest, welcomeMessage } = await import("./index.js");
    expect(manifest.scopes).toContain("messages:write");
    expect(welcomeMessage("Ada")).toContain("Ada");
  });

  it("createWelcomeBot returns a NexusBotClient and registers events", async () => {
    const { createWelcomeBot } = await import("./index.js");
    const { NexusBotClient } = await import("@nexus-chat/bot-sdk");
    const sendSpy = vi.spyOn(NexusBotClient.prototype, "sendMessage").mockResolvedValue({ ok: true });
    const onEventSpy = vi.spyOn(NexusBotClient.prototype, "onEvent");
    createWelcomeBot({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token" });
    expect(onEventSpy).toHaveBeenCalledWith("workspace.member_added", expect.any(Function));
    const handler = onEventSpy.mock.calls[0]?.[1] as ((e: unknown) => void | Promise<void>) | undefined;
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { userId: "u1", displayName: "Ada" } });
    expect(sendSpy).toHaveBeenCalled();
    sendSpy.mockClear();
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { userId: "u1" } });
    await handler?.({ workspaceId: "ws1", payload: { userId: "u1", displayName: "Ada" } });
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
    onEventSpy.mockRestore();
  });
});

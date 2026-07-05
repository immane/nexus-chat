import { describe, expect, it, vi } from "vitest";

vi.mock("socket.io-client", () => ({ io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() })) }));

describe("help bot", () => {
  it("declares /help command", async () => {
    const { helpText, manifest } = await import("./index.js");
    expect(manifest.commands[0]?.name).toBe("/help");
    expect(helpText()).toContain("/help");
  });

  it("createHelpBot registers /help command", async () => {
    const { createHelpBot } = await import("./index.js");
    const { NexusBotClient } = await import("@nexus-chat/bot-sdk");
    const sendSpy = vi.spyOn(NexusBotClient.prototype, "sendMessage").mockResolvedValue({ ok: true });
    const onCommandSpy = vi.spyOn(NexusBotClient.prototype, "onCommand");
    createHelpBot({ baseUrl: "http://localhost:4000", token: "nxbot_v1_token" });
    expect(onCommandSpy).toHaveBeenCalledWith("/help", expect.any(Function));
    const handler = onCommandSpy.mock.calls[0]?.[1] as ((e: unknown) => void | Promise<void>) | undefined;
    await handler?.({ workspaceId: "ws1", channelId: "ch1", payload: { command: "/help", channelId: "ch1" } });
    expect(sendSpy).toHaveBeenCalled();
    sendSpy.mockRestore();
    onCommandSpy.mockRestore();
  });
});

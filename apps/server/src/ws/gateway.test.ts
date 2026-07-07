import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotManifest, Channel, Workspace } from "@nexus-chat/shared";
import { botService } from "../domain/bots/service.js";
import { messageService } from "../domain/messages/service.js";
import { resetStore } from "../domain/test-utils.js";
import { workspaceService } from "../domain/workspaces/service.js";
import { createWsRateLimiter, handleClientEnvelope, type WsBroadcaster } from "./gateway.js";

const now = () => new Date().toISOString();

const createWorkspaceWithChannels = () => {
  const workspace = workspaceService.createWorkspace("user-owner", "Acme");
  workspaceService.addMember("user-owner", workspace.id, "user-member", "member");
  const normal = workspaceService.createChannel("user-owner", workspace.id, "gateway-general", "normal", false) as Channel;
  const e2e = workspaceService.createChannel("user-owner", workspace.id, "secure", "e2e", false) as Channel;
  workspaceService.addChannelMember("user-owner", normal.id, "user-member");
  workspaceService.addChannelMember("user-owner", e2e.id, "user-member");
  return { workspace, normal, e2e } satisfies { workspace: Workspace; normal: Channel; e2e: Channel };
};

const createBroadcaster = () => {
  const channelEvents: unknown[] = [];
  const userEvents: unknown[] = [];
  const relayedP2pEvents: unknown[] = [];
  const broadcaster: WsBroadcaster = {
    toChannel: (_channelId, event) => channelEvents.push(event),
    toUser: (_userId, event) => userEvents.push(event),
    toWorkspace: (_workspaceId, event) => channelEvents.push(event),
    relayP2pToUser: (_userId, envelope) => relayedP2pEvents.push(envelope)
  };
  return { broadcaster, channelEvents, userEvents, relayedP2pEvents };
};

describe("WebSocket gateway", () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it("validates and broadcasts normal message sends", () => {
    const { workspace, normal } = createWorkspaceWithChannels();
    const { broadcaster, channelEvents } = createBroadcaster();
    const response = handleClientEnvelope(
      "user-owner",
      { type: "message.send", payload: { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "client-1", content: { type: "text", text: "hello", attachments: [] } }, timestamp: now() },
      broadcaster,
      createWsRateLimiter({ windowMs: 1000, maxEvents: 10 })
    );
    expect(response.ok).toBe(true);
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0]).toMatchObject({ type: "message.created" });
  });

  it("stores E2E ciphertext without bot dispatch", () => {
    const { workspace, e2e } = createWorkspaceWithChannels();
    const publish = vi.spyOn(botService, "publishEvent");
    const { broadcaster } = createBroadcaster();
    const response = handleClientEnvelope(
      "user-owner",
      { type: "message.send", payload: { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "client-2", content: { type: "ciphertext", ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", attachments: [] } }, timestamp: now() },
      broadcaster,
      createWsRateLimiter({ windowMs: 1000, maxEvents: 10 })
    );
    expect(response.ok).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("routes bot commands only for normal channels", () => {
    const { workspace, normal, e2e } = createWorkspaceWithChannels();
    const { broadcaster } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 10 });
    const normalResponse = handleClientEnvelope(
      "user-owner",
      { type: "bot.command.invoke", payload: { type: "bot.command.invoke", workspaceId: workspace.id, channelId: normal.id, botName: "HelpBot", command: "help", args: [] }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(normalResponse.ok).toBe(true);
    const e2eResponse = handleClientEnvelope(
      "user-owner",
      { type: "bot.command.invoke", payload: { type: "bot.command.invoke", workspaceId: workspace.id, channelId: e2e.id, botName: "HelpBot", command: "help", args: [] }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(e2eResponse).toMatchObject({ ok: false, error: { code: "E2E_BOT_NOT_ALLOWED" } });
  });

  it("broadcasts inline /help bot responses", () => {
    const { workspace, normal } = createWorkspaceWithChannels();
    const manifest: BotManifest = {
      id: "bot-help",
      name: "HelpBot",
      description: "Help",
      commands: [{ name: "/help", description: "Show help" }],
      scopes: ["commands:handle"]
    };
    botService.install("user-owner", workspace.id, manifest);
    const { broadcaster, channelEvents } = createBroadcaster();

    const response = handleClientEnvelope(
      "user-owner",
      { type: "bot.command.invoke", payload: { type: "bot.command.invoke", workspaceId: workspace.id, channelId: normal.id, botName: "HelpBot", command: "help", args: [] }, timestamp: now() },
      broadcaster,
      createWsRateLimiter({ windowMs: 1000, maxEvents: 10 })
    );

    expect(response).toMatchObject({ ok: true, data: { type: "bot.response" } });
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0]).toMatchObject({ type: "message.created", payload: { senderId: "bot-help", content: { text: expect.stringContaining("/help") } } });
  });

  it("handles typing presence ack invalid payloads and rate limits", () => {
    const { workspace, normal } = createWorkspaceWithChannels();
    const { broadcaster, channelEvents } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 4 });
    const message = messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "ack-1", content: { type: "text", text: "ack me", attachments: [] } });
    expect(handleClientEnvelope("user-owner", { type: "typing.start", payload: { workspaceId: workspace.id, channelId: normal.id }, timestamp: now() }, broadcaster, rateLimiter)).toMatchObject({ ok: true });
    expect(handleClientEnvelope("user-owner", { type: "presence.update", payload: { status: "online" }, timestamp: now() }, broadcaster, rateLimiter)).toMatchObject({ ok: true });
    expect(handleClientEnvelope("user-owner", { type: "message.ack", payload: { messageId: "id" in message ? message.id : "missing" }, timestamp: now() }, broadcaster, rateLimiter)).toMatchObject({ ok: true });
    expect(handleClientEnvelope("user-owner", { type: "typing.stop", payload: { workspaceId: workspace.id }, timestamp: now() }, broadcaster, rateLimiter)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(handleClientEnvelope("user-owner", { type: "message.ack", payload: { messageId: "message-2" }, timestamp: now() }, broadcaster, rateLimiter)).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(channelEvents[0]).toMatchObject({ type: "typing.updated" });
    expect(channelEvents[1]).toMatchObject({ type: "presence.updated" });
  });

  it("relays p2p.offer to target user with sender metadata", () => {
    const { broadcaster, relayedP2pEvents } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 10 });
    const response = handleClientEnvelope(
      "user-alice",
      { type: "p2p.offer", payload: { targetUserId: "user-bob-123456", sdp: "v=0\r\no=- ..." }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(response).toMatchObject({ ok: true, data: { relayed: true } });
    expect(relayedP2pEvents).toHaveLength(1);
    expect(relayedP2pEvents[0]).toMatchObject({ type: "p2p.offer", _senderUserId: "user-alice" });
  });

  it("relays p2p.ice-candidate and p2p.hangup", () => {
    const { broadcaster, relayedP2pEvents } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 10 });
    handleClientEnvelope(
      "user-alice",
      { type: "p2p.ice-candidate", payload: { targetUserId: "user-bob-123456", candidate: { candidate: "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 } }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    handleClientEnvelope(
      "user-bob-123456",
      { type: "p2p.hangup", payload: { targetUserId: "user-alice-3456" }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(relayedP2pEvents).toHaveLength(2);
  });

  it("logs p2p.status and does not relay", () => {
    const { broadcaster, relayedP2pEvents } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 10 });
    const response = handleClientEnvelope(
      "user-alice",
      { type: "p2p.status", payload: { targetUserId: "user-bob-123456", status: "connected" }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(response).toMatchObject({ ok: true, data: { acknowledged: true } });
    expect(relayedP2pEvents).toHaveLength(0);
  });

  it("rejects p2p event with missing targetUserId", () => {
    const { broadcaster } = createBroadcaster();
    const rateLimiter = createWsRateLimiter({ windowMs: 1000, maxEvents: 10 });
    const response = handleClientEnvelope(
      "user-alice",
      { type: "p2p.offer", payload: { sdp: "v=0\r\no=- ..." }, timestamp: now() },
      broadcaster,
      rateLimiter
    );
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});

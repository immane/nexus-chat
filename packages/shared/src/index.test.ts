import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ApiSuccessSchema,
  AttachmentRefSchema,
  BotCommandInvokeSchema,
  E2eDisappearingPolicySchema,
  WsBotCommandInvokeEnvelopeSchema,
  WsMessageSendEnvelopeSchema,
  apiFail,
  apiOk,
  apiSuccessSchema,
  botCommandInvokeSchema,
  botManifestSchema,
  channelSchema,
  createChannelSchema,
  e2eMessageContentSchema,
  idSchema,
  loginRequestSchema,
  messageSchema,
  normalMessageContentSchema,
  registerRequestSchema,
  sendMessageSchema,
  signalPreKeyBundleSchema,
  uploadSessionCreateSchema,
  wsEnvelopeSchema
} from "./index.js";

describe("shared contracts", () => {
  it("exposes proposed module layout entry points", async () => {
    const modules = await Promise.all([
      import("./ids.js"),
      import("./api/envelope.js"),
      import("./api/errors.js"),
      import("./api/pagination.js"),
      import("./auth/session.js"),
      import("./workspace/schemas.js"),
      import("./channel/schemas.js"),
      import("./message/content.js"),
      import("./message/events.js"),
      import("./message/state.js"),
      import("./attachment/schemas.js"),
      import("./bot/commands.js"),
      import("./bot/events.js"),
      import("./bot/manifest.js"),
      import("./bot/scopes.js"),
      import("./signal/schemas.js"),
      import("./ws/client-events.js"),
      import("./ws/server-events.js"),
      import("./ws/envelope.js")
    ]);
    expect(modules.every((module) => Object.keys(module).length > 0)).toBe(true);
  });

  it("validates auth and API envelopes", () => {
    expect(registerRequestSchema.parse({ email: "ada@example.com", password: "Password12345!", displayName: "Ada" }).email).toBe("ada@example.com");
    expect(() => loginRequestSchema.parse({ email: "bad", password: "x" })).toThrow();
    expect(apiOk({ ok: true }).ok).toBe(true);
    expect(apiFail("FORBIDDEN", "no").error.code).toBe("FORBIDDEN");
    expect(ApiSuccessSchema.parse({ ok: true, data: { value: 1 }, requestId: "req-1" }).requestId).toBe("req-1");
    expect(ApiErrorSchema.parse({ ok: false, error: { code: "FORBIDDEN", message: "no" }, requestId: "req-1" }).error.code).toBe("FORBIDDEN");
    expect(() => ApiSuccessSchema.parse({ ok: true, data: null })).toThrow();
  });

  it("validates workspace channel and message contracts", () => {
    const channel = channelSchema.parse({ id: "channel-1", workspaceId: "workspace-1", name: "general", kind: "channel", mode: "normal", isPrivate: false, createdAt: new Date().toISOString() });
    expect(channel.mode).toBe("normal");
    expect(createChannelSchema.parse({ name: "secure", mode: "e2e" }).isPrivate).toBe(false);
    const text = normalMessageContentSchema.parse({ type: "text", text: "hello", attachments: [] });
    const ciphertext = e2eMessageContentSchema.parse({ type: "ciphertext", ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", attachments: [] });
    expect(text.text).toBe("hello");
    expect(ciphertext.algorithm).toBe("signal-v1");
    expect(sendMessageSchema.parse({ workspaceId: "workspace-1", channelId: "channel-1", clientMsgId: "client-1", content: text }).content.type).toBe("text");
    expect(messageSchema.parse({ id: "message-1", workspaceId: "workspace-1", channelId: "channel-1", senderId: "user-123", clientMsgId: "client-1", content: text, state: "sent", createdAt: new Date().toISOString() }).state).toBe("sent");
    expect(E2eDisappearingPolicySchema.parse({ mode: "read_once" }).mode).toBe("read_once");
    expect(E2eDisappearingPolicySchema.parse({ mode: "ttl", ttlSeconds: 60 }).ttlSeconds).toBe(60);
    expect(() => E2eDisappearingPolicySchema.parse({ mode: "ttl" })).toThrow();
    expect(() => E2eDisappearingPolicySchema.parse({ mode: "none", ttlSeconds: 60 })).toThrow();
  });

  it("validates bot attachment signal and websocket contracts", () => {
    expect(botManifestSchema.parse({ id: "bot-help", name: "Help", description: "Help", commands: [{ name: "/help", description: "Help" }], scopes: ["commands:handle"] }).commands[0]?.name).toBe("/help");
    expect(botCommandInvokeSchema.parse({ command: "/help", workspaceId: "workspace-1", channelId: "channel-1", userId: "user-123" }).args).toBe("");
    expect(BotCommandInvokeSchema.parse({ type: "bot.command.invoke", workspaceId: "workspace-1", channelId: "channel-1", botName: "HelpBot", command: "help", args: ["channels"] }).botName).toBe("HelpBot");
    expect(() => BotCommandInvokeSchema.parse({ type: "bot.command.invoke", workspaceId: "workspace-1", channelId: "channel-1", botName: "", command: "help", args: [] })).toThrow();
    expect(AttachmentRefSchema.parse({ fileId: "file-123", name: "a.txt", mimeType: "text/plain", size: 1, scanStatus: "pending" }).mimeType).toBe("text/plain");
    expect(() => AttachmentRefSchema.parse({ fileId: "file-123", name: "a.txt", mimeType: "text/plain", size: 1, scanStatus: "pending", url: "https://example.com/a.txt" })).toThrow();
    expect(uploadSessionCreateSchema.parse({ workspaceId: "workspace-1", fileName: "a.txt", contentType: "text/plain", sizeBytes: 1 }).encrypted).toBe(false);
    expect(signalPreKeyBundleSchema.parse({ userId: "user-123", deviceId: "device-1", identityKey: "i", signedPreKeyId: 1, signedPreKey: "s", signedPreKeySignature: "sig" }).deviceId).toBe("device-1");
    expect(wsEnvelopeSchema.parse({ type: "message.send", payload: {}, timestamp: new Date().toISOString() }).encrypted).toBe(false);
    expect(WsMessageSendEnvelopeSchema.parse({ type: "message.send", payload: { workspaceId: "workspace-1", channelId: "channel-1", clientMsgId: "client-1", content: { type: "text", text: "hello", attachments: [] } }, timestamp: new Date().toISOString() }).payload.clientMsgId).toBe("client-1");
    expect(WsBotCommandInvokeEnvelopeSchema.parse({ type: "bot.command.invoke", payload: { type: "bot.command.invoke", workspaceId: "workspace-1", channelId: "channel-1", botName: "HelpBot", command: "help", args: [] }, timestamp: new Date().toISOString() }).payload.botName).toBe("HelpBot");
    expect(() => WsMessageSendEnvelopeSchema.parse({ type: "message.send", payload: { bad: true }, timestamp: new Date().toISOString() })).toThrow();
  });

  it("builds typed success envelopes", () => {
    expect(apiSuccessSchema(z.object({ id: idSchema })).parse({ ok: true, data: { id: "resource-1" } })).toEqual({ ok: true, data: { id: "resource-1" } });
  });
});

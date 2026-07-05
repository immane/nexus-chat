import {
  BotCommandInvokeSchema,
  messageAckPayloadSchema,
  presenceUpdatePayloadSchema,
  sendMessageSchema,
  typingPayloadSchema,
  wsEnvelopeSchema
} from "@nexus-chat/shared";
import { botService } from "../domain/bots/service.js";
import { messageService } from "../domain/messages/service.js";
import { store } from "../domain/store.js";
import { logger } from "../observability/logger.js";
import { writeAuditEvent } from "../observability/audit.js";

export type WsGatewayResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export type WsBroadcaster = { toChannel(channelId: string, event: unknown): void; toUser(userId: string, event: unknown): void; relayP2pToUser(userId: string, envelope: unknown): void };

type RateBucket = { count: number; resetAt: number };

export const createWsRateLimiter = (options: { windowMs: number; maxEvents: number }) => {
  const buckets = new Map<string, RateBucket>();
  return {
    check(userId: string): WsGatewayResponse | undefined {
      const now = Date.now();
      const existing = buckets.get(userId);
      const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };
      bucket.count += 1;
      buckets.set(userId, bucket);
      if (bucket.count > options.maxEvents) return { ok: false, error: { code: "RATE_LIMITED", message: "Too many WebSocket events" } };
      return undefined;
    },
    reset() {
      buckets.clear();
    }
  };
};

export const wsRateLimiter = createWsRateLimiter({ windowMs: 10_000, maxEvents: 50 });

export const handleClientEnvelope = (userId: string, raw: unknown, broadcaster: WsBroadcaster, rateLimiter = wsRateLimiter): WsGatewayResponse => {
  const limited = rateLimiter.check(userId);
  if (limited) return limited;

  const envelope = wsEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid WebSocket envelope" } };

  if (envelope.data.type === "message.send") {
    const payload = sendMessageSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid message payload" } };
    const result = messageService.send(userId, payload.data);
    if ("ok" in result) return result;
    writeAuditEvent({ type: "message.sent", actor: userId, metadata: { channelId: result.channelId, messageId: result.id } });
    broadcaster.toChannel(result.channelId, { type: "message.created", payload: result, timestamp: new Date().toISOString() });
    return { ok: true, data: result };
  }

  if (envelope.data.type === "bot.command.invoke") {
    logger.info({ payload: envelope.data.payload }, "bot.command.invoke received");
    const payload = BotCommandInvokeSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid bot command payload" } };
    const command = payload.data.command.startsWith("/") ? payload.data.command : `/${payload.data.command}`;
    const result = botService.invokeCommand({ workspaceId: payload.data.workspaceId, channelId: payload.data.channelId, userId, command, args: payload.data.args.join(" ") });
    if ("ok" in result) return result;
    // Broadcast bot response to channel
    if (typeof result === "object" && result !== null && "type" in result && (result as Record<string, unknown>).type === "bot.response") {
      const payloadData = (result as { payload?: { messageId?: unknown } }).payload;
      const msgId = typeof payloadData?.messageId === "string" ? payloadData.messageId : undefined;
      const msg = msgId ? store.messages.get(msgId) : undefined;
      if (msg) broadcaster.toChannel(payload.data.channelId, { type: "message.created", payload: msg, timestamp: new Date().toISOString() });
    }
    return { ok: true, data: result };
  }

  if (envelope.data.type === "typing.start" || envelope.data.type === "typing.stop") {
    const payload = typingPayloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid typing payload" } };
    broadcaster.toChannel(payload.data.channelId, { type: "typing.updated", payload: { ...payload.data, userId, typing: envelope.data.type === "typing.start" }, timestamp: new Date().toISOString() });
    return { ok: true, data: { accepted: true } };
  }

  if (envelope.data.type === "presence.update") {
    const payload = presenceUpdatePayloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid presence payload" } };
    broadcaster.toUser(userId, { type: "presence.updated", payload: { userId, status: payload.data.status }, timestamp: new Date().toISOString() });
    return { ok: true, data: { accepted: true } };
  }

  if (envelope.data.type === "message.ack") {
    const payload = messageAckPayloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid ack payload" } };
    const result = messageService.ackRead(userId, payload.data.messageId);
    if ("ok" in result) return result;
    for (const batch of messageService.flushReadReceipts()) broadcaster.toChannel(batch.channelId, { type: "message.read", payload: batch, timestamp: new Date().toISOString() });
    return { ok: true, data: result };
  }

  if (envelope.data.type === "p2p.offer" || envelope.data.type === "p2p.answer" || envelope.data.type === "p2p.ice-candidate" || envelope.data.type === "p2p.hangup") {
    const targetUserId = (envelope.data.payload as Record<string, unknown>)?.targetUserId;
    if (typeof targetUserId !== "string" || targetUserId.length < 1) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Missing targetUserId" } };
    broadcaster.relayP2pToUser(targetUserId, { ...envelope.data, _senderUserId: userId });
    return { ok: true, data: { relayed: true } };
  }

  if (envelope.data.type === "p2p.status") {
    logger.info({ userId, peerUserId: (envelope.data.payload as Record<string, unknown>)?.targetUserId, status: (envelope.data.payload as Record<string, unknown>)?.status }, "p2p.status");
    return { ok: true, data: { acknowledged: true } };
  }

  return { ok: false, error: { code: "VALIDATION_FAILED", message: "Unsupported client event" } };
};

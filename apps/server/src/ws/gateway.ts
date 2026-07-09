/**
 * WebSocket Event Gateway
 *
 * Processes incoming WS client envelopes and dispatches them to the appropriate
 * domain service. Acts as the WS counterpart to HTTP routes.ts.
 *
 * Envelope Types Handled:
 * - message.send — relay to messageService.send, broadcast to channel
 * - bot.command.invoke — relay to botService.invokeCommand, broadcast bot response
 * - typing.start / typing.stop — broadcast to channel (no persistence)
 * - presence.update — broadcast to all user's workspaces
 * - message.ack — read receipt, triggers pending read receipt flush
 * - p2p.offer / p2p.answer / p2p.ice-candidate / p2p.hangup — relay to target user
 * - p2p.status — log acknowledged
 *
 * Rate Limiting:
 * - createWsRateLimiter with 50 events per 10-second sliding window per user
 * - Returns RATE_LIMITED error when exceeded
 *
 * Does NOT:
 * - Handle connection lifecycle (owned by socket.ts)
 * - Authenticate or authorize (handled before socket.ts delegates to gateway)
 * - Persist typing indicators (ephemeral, broadcast only)
 */
import {
  BotCommandInvokeSchema,
  messageAckPayloadSchema,
  p2pAnswerSchema,
  p2pHangupSchema,
  p2pIceCandidateSchema,
  p2pOfferSchema,
  p2pStatusSchema,
  presenceUpdatePayloadSchema,
  sendMessageSchema,
  typingPayloadSchema,
  wsEnvelopeSchema
} from "@nexus-chat/shared";
import { botService } from "../domain/bots/service.js";
import { messageService } from "../domain/messages/service.js";
import { store } from "../domain/store.js";
import { workspaceService } from "../domain/workspaces/service.js";
import { logger } from "../observability/logger.js";
import { writeAuditEvent } from "../observability/audit.js";

export type WsGatewayResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export type WsBroadcaster = { toChannel(channelId: string, event: unknown): void; toUser(userId: string, event: unknown): void; toWorkspace(workspaceId: string, event: unknown): void; relayP2pToUser(userId: string, envelope: unknown): void };

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
    // botService.invokeCommand returns { type: "bot.response", payload: { messageId, ... } }
    // when a built-in /help handler fires. The message is already in store.messages;
    // we read it by ID and broadcast it so WebSocket-connected clients receive it.
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
    const presenceEvent = { type: "presence.updated", payload: { userId, status: payload.data.status }, timestamp: new Date().toISOString() };
    for (const ws of workspaceService.listWorkspaces(userId)) {
      broadcaster.toWorkspace(ws.id, presenceEvent);
    }
    return { ok: true, data: {} };
  }

  // Ack individual message, then immediately flush pending read receipts so
  // the sender gets batched read-count updates without waiting for a 3-second timer.
  if (envelope.data.type === "message.ack") {
    const payload = messageAckPayloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid ack payload" } };
    const result = messageService.ackRead(userId, payload.data.messageId);
    if ("ok" in result) return result;
    for (const batch of messageService.flushReadReceipts()) broadcaster.toChannel(batch.channelId, { type: "message.read", payload: batch, timestamp: new Date().toISOString() });
    return { ok: true, data: result };
  }

  // P2P signaling relay — the server does NOT inspect SDP or ICE candidate content.
  // It simply forwards the envelope to the target user over their WebSocket.
  // _senderUserId is tacked on so the receiver knows who initiated the handshake.
  if (envelope.data.type === "p2p.offer" || envelope.data.type === "p2p.answer" || envelope.data.type === "p2p.ice-candidate" || envelope.data.type === "p2p.hangup") {
    const schema = envelope.data.type === "p2p.offer" ? p2pOfferSchema
      : envelope.data.type === "p2p.answer" ? p2pAnswerSchema
        : envelope.data.type === "p2p.ice-candidate" ? p2pIceCandidateSchema
          : p2pHangupSchema;
    const payload = schema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid P2P signaling payload" } };
    const targetUserId = payload.data.targetUserId;
    if (typeof targetUserId !== "string" || targetUserId.length < 1) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Missing targetUserId" } };
    broadcaster.relayP2pToUser(targetUserId, { ...envelope.data, payload: payload.data, _senderUserId: userId });
    return { ok: true, data: { relayed: true } };
  }

  if (envelope.data.type === "p2p.status") {
    const payload = p2pStatusSchema.safeParse(envelope.data.payload);
    if (!payload.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid P2P status payload" } };
    logger.info({ userId, peerUserId: payload.data.targetUserId, status: payload.data.status }, "p2p.status");
    return { ok: true, data: { acknowledged: true } };
  }

  return { ok: false, error: { code: "VALIDATION_FAILED", message: "Unsupported client event" } };
};

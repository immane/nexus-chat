import { createId } from "@paralleldrive/cuid2";
import { apiFail, messageSchema, nowIso, type AttachmentRef, type Message, type MessageContent, type SendMessageInput } from "@nexus-chat/shared";
import { messageSends } from "../../observability/metrics.js";
import { botService } from "../bots/service.js";
import { store } from "../store.js";
import { workspaceService } from "../workspaces/service.js";
import { attachmentService } from "../attachments/service.js";

type MessagePage = { items: Message[]; nextCursor?: string };
type ReadReceiptBatch = { messageId: string; channelId: string; readCount: number; readers: string[]; flushedAt: string };

const tombstone = (message: Message, reason: "deleted" | "expired" | "read_once_consumed"): Message => ({
  ...message,
  content: { type: "tombstone", reason },
  state: "deleted",
  deletedAt: message.deletedAt ?? nowIso()
});

const event = (type: "message.updated" | "message.deleted" | "message.reaction" | "message.read", channelId: string, payload: unknown) => {
  store.messageEvents.push({ type, channelId, payload, createdAt: nowIso() });
};

const visibleMessage = (message: Message): Message => {
  if (message.state === "deleted") return tombstone(message, message.content.type === "tombstone" ? message.content.reason : "deleted");
  if (message.content.type === "ciphertext" && message.content.expiresAt && Date.parse(message.content.expiresAt) <= Date.now()) return tombstone(message, "expired");
  return message;
};

export const messageService = {
  send(actorId: string, input: SendMessageInput): Message | ReturnType<typeof apiFail> {
    const channel = store.channels.get(input.channelId);
    if (!channel || channel.workspaceId !== input.workspaceId || !workspaceService.canAccessChannel(actorId, input.channelId)) return apiFail("FORBIDDEN", "Channel access denied");
    if (channel.mode === "e2e" && input.content.type !== "ciphertext") return apiFail("VALIDATION_FAILED", "E2E channels accept ciphertext only");
    if (channel.mode === "normal" && input.content.type === "ciphertext") return apiFail("VALIDATION_FAILED", "Normal channels accept plaintext message content");
    const idempotencyKey = `${actorId}:${input.clientMsgId}`;
    const existingId = store.messagesByClientId.get(idempotencyKey);
    if (existingId) return store.messages.get(existingId) ?? apiFail("CONFLICT", "Message idempotency conflict");
    const attachments: AttachmentRef[] = "attachments" in input.content ? (input.content.attachments as AttachmentRef[]) : [];
    if (attachments.length > 0) {
      const validated = attachmentService.validateAttachmentRefs(attachments);
      if ("ok" in validated) return validated;
    }
    const message = messageSchema.parse({
      id: createId(),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      senderId: actorId,
      clientMsgId: input.clientMsgId,
      content: input.content,
      state: "sent",
      createdAt: nowIso()
    });
    store.messages.set(message.id, message);
    store.messagesByClientId.set(idempotencyKey, message.id);
    if (attachments.length > 0) attachmentService.associateAttachments(message.id, attachments);
    messageSends.inc({ mode: channel.mode });
    if (channel.mode === "normal") botService.publishEvent({ type: "message.created", workspaceId: input.workspaceId, channelId: input.channelId, payload: message });
    return message;
  },
  list(actorId: string, channelId: string, cursor?: string, limit = 50): Message[] {
    return this.listPage(actorId, channelId, cursor, limit).items;
  },
  listPage(actorId: string, channelId: string, cursor?: string, limit = 50): MessagePage {
    if (!workspaceService.canAccessChannel(actorId, channelId)) return { items: [] };
    this.cleanupExpiredMessages();
    const messages = [...store.messages.values()].filter((message) => message.channelId === channelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const start = cursor ? messages.findIndex((message) => message.id === cursor) + 1 : 0;
    const items = messages.slice(Math.max(start, 0), Math.max(start, 0) + limit).map(visibleMessage);
    const nextCursor = items.length === limit ? items.at(-1)?.id : undefined;
    return nextCursor ? { items, nextCursor } : { items };
  },
  edit(actorId: string, messageId: string, text: string): Message | ReturnType<typeof apiFail> {
    const message = store.messages.get(messageId);
    if (!message || message.senderId !== actorId) return apiFail("FORBIDDEN", "Cannot edit this message");
    if (message.content.type !== "text") return apiFail("VALIDATION_FAILED", "Only normal text messages can be edited");
    const updated = { ...message, content: { ...message.content, text } satisfies MessageContent, editedAt: nowIso() };
    store.messages.set(messageId, updated);
    event("message.updated", updated.channelId, updated);
    return updated;
  },
  softDelete(actorId: string, messageId: string): Message | ReturnType<typeof apiFail> {
    const message = store.messages.get(messageId);
    if (!message || message.senderId !== actorId) return apiFail("FORBIDDEN", "Cannot delete this message");
    const updated = tombstone(message, "deleted");
    store.messages.set(messageId, updated);
    event("message.deleted", updated.channelId, updated);
    return updated;
  },
  forward(actorId: string, messageId: string, targetChannelId: string, clientMsgId: string): Message | ReturnType<typeof apiFail> {
    const source = store.messages.get(messageId);
    const target = store.channels.get(targetChannelId);
    if (!source || !target) return apiFail("NOT_FOUND", "Message or target channel not found");
    if (!workspaceService.canAccessChannel(actorId, source.channelId)) return apiFail("FORBIDDEN", "Message access denied");
    const result = this.send(actorId, { workspaceId: target.workspaceId, channelId: targetChannelId, clientMsgId, content: source.content });
    if ("ok" in result) return result;
    const forwarded = { ...result, originalMessageId: source.originalMessageId ?? source.id, originalSenderId: source.originalSenderId ?? source.senderId, originalCreatedAt: source.originalCreatedAt ?? source.createdAt };
    store.messages.set(forwarded.id, forwarded);
    return forwarded;
  },
  save(actorId: string, messageId: string): { messageId: string; saved: true; savedAt: string } | ReturnType<typeof apiFail> {
    const message = store.messages.get(messageId);
    if (!message) return apiFail("NOT_FOUND", "Message not found");
    if (!workspaceService.canAccessChannel(actorId, message.channelId)) return apiFail("FORBIDDEN", "Message access denied");
    const key = `${actorId}:${messageId}`;
    const existing = store.savedMessages.get(key);
    if (existing) return { messageId, saved: true, savedAt: existing.createdAt };
    const savedAt = nowIso();
    store.savedMessages.set(key, { userId: actorId, messageId, createdAt: savedAt });
    return { messageId, saved: true, savedAt };
  },
  listSaved(actorId: string): Message[] {
    return [...store.savedMessages.values()]
      .filter((saved) => saved.userId === actorId)
      .map((saved) => store.messages.get(saved.messageId))
      .filter((message): message is Message => (message ? workspaceService.canAccessChannel(actorId, message.channelId) : false))
      .map(visibleMessage);
  },
  react(actorId: string, messageId: string, emoji: string, action: "add" | "remove" = "add"): { messageId: string; emoji: string; count: number; reacted: boolean } | ReturnType<typeof apiFail> {
    const message = store.messages.get(messageId);
    if (!message) return apiFail("NOT_FOUND", "Message not found");
    if (!workspaceService.canAccessChannel(actorId, message.channelId)) return apiFail("FORBIDDEN", "Message access denied");
    const key = `${messageId}:${actorId}:${emoji}`;
    if (action === "remove") store.messageReactions.delete(key);
    else store.messageReactions.set(key, { messageId, userId: actorId, emoji, createdAt: nowIso() });
    const count = [...store.messageReactions.values()].filter((reaction) => reaction.messageId === messageId && reaction.emoji === emoji).length;
    const payload = { messageId, emoji, count, reacted: action === "add" };
    event("message.reaction", message.channelId, payload);
    return payload;
  },
  ackRead(actorId: string, messageId: string): { accepted: true } | ReturnType<typeof apiFail> {
    const message = store.messages.get(messageId);
    if (!message) return apiFail("NOT_FOUND", "Message not found");
    if (!workspaceService.canAccessChannel(actorId, message.channelId)) return apiFail("FORBIDDEN", "Message access denied");
    if (message.senderId === actorId) return { accepted: true };
    const readAt = nowIso();
    const key = `${messageId}:${actorId}`;
    if (!store.readReceipts.has(key)) store.pendingReadReceipts.push({ messageId, userId: actorId, readAt });
    store.readReceipts.set(key, { messageId, userId: actorId, readAt });
    const updated = { ...message, state: "read" as const };
    if (message.content.type === "ciphertext" && message.content.readOnce) {
      const consumed = tombstone(updated, "read_once_consumed");
      store.messages.set(messageId, consumed);
      event("message.deleted", consumed.channelId, consumed);
    } else {
      store.messages.set(messageId, updated);
    }
    return { accepted: true };
  },
  flushReadReceipts(channelId?: string): ReadReceiptBatch[] {
    const pending = channelId ? store.pendingReadReceipts.filter((receipt) => store.messages.get(receipt.messageId)?.channelId === channelId) : [...store.pendingReadReceipts];
    store.pendingReadReceipts = channelId ? store.pendingReadReceipts.filter((receipt) => store.messages.get(receipt.messageId)?.channelId !== channelId) : [];
    const byMessage = new Map<string, string[]>();
    for (const receipt of pending) byMessage.set(receipt.messageId, [...(byMessage.get(receipt.messageId) ?? []), receipt.userId]);
    return [...byMessage.entries()].flatMap(([messageId, readers]) => {
      const message = store.messages.get(messageId);
      if (!message) return [];
      const batch = { messageId, channelId: message.channelId, readCount: readers.length, readers, flushedAt: nowIso() };
      event("message.read", message.channelId, batch);
      return [batch];
    });
  },
  cleanupExpiredMessages(now = new Date()): Message[] {
    const expired: Message[] = [];
    for (const message of store.messages.values()) {
      if (message.state === "deleted" || message.content.type !== "ciphertext" || !message.content.expiresAt || Date.parse(message.content.expiresAt) > now.getTime()) continue;
      const updated = tombstone(message, "expired");
      store.messages.set(message.id, updated);
      expired.push(updated);
      event("message.deleted", updated.channelId, updated);
    }
    return expired;
  },
  markRead(actorId: string, channelId: string): { ok: true } | ReturnType<typeof apiFail> {
    if (!workspaceService.canAccessChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Channel access denied");
    store.channelLastRead.set(`${channelId}:${actorId}`, nowIso());
    return { ok: true };
  },
  getUnreadCounts(actorId: string, workspaceId: string): Record<string, number> {
    if (!workspaceService.canAccessWorkspace(actorId, workspaceId)) return {};
    const channels = [...store.channels.values()].filter((c) => c.workspaceId === workspaceId && !c.deletedAt && workspaceService.canAccessChannel(actorId, c.id));
    const result: Record<string, number> = {};
    for (const channel of channels) {
      const lastRead = store.channelLastRead.get(`${channel.id}:${actorId}`);
      const unread = [...store.messages.values()].filter((m) => m.channelId === channel.id && m.state === "sent" && (!lastRead || m.createdAt > lastRead) && m.senderId !== actorId).length;
      if (unread > 0) result[channel.id] = unread;
    }
    return result;
  }
};

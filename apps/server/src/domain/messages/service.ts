/**
 * Message Service (Core IM)
 *
 * Owns message lifecycle, pagination, reactions, read receipts, and pin management.
 *
 * Responsibilities:
 * - Send messages with idempotency via clientMsgId deduplication
 * - Cursor-based pagination over channel message history
 * - Edit, soft-delete, forward, and save messages
 * - Add/remove emoji reactions with count aggregation
 * - Track read receipts with batch flush
 * - Pin/unpin messages (max 50 per channel)
 * - Tombstone expired E2E ciphertext and deleted messages
 * - Dispatch message.created events to bots in normal channels
 *
 * Does NOT:
 * - Handle WebSocket broadcasts (caller's responsibility)
 * - Perform channel access checks for listing (delegated to workspace persistence)
 * - Store files directly (delegated to attachment service)
 * - Process E2E cryptographic operations (client-side only)
 *
 * Invariants:
 * - Message idempotency is guaranteed by the database (sender_id, client_msg_id) unique index
 * - Short-lived read-receipt batching uses a process-local queue, flushed through persistence
 * - Tombstones replace deleted/expired messages to preserve history integrity
 * - Domain events (message.updated/deleted/reaction/read) are recorded in a process-local buffer
 *
 * Dependencies:
 * - MessagePersistence (in-memory or PostgreSQL)
 * - workspacePersistenceService (channel access checks)
 * - attachmentService (attachment validation)
 * - botService (event publishing for normal channels)
 *
 * Related Modules:
 * - persistence.ts: MessagePersistence interface and adapters
 * - ws/gateway.ts: WebSocket message.send / ack handling
 */
import { createId } from "@paralleldrive/cuid2";
import {
  apiFail,
  messageSchema,
  nowIso,
  type AttachmentRef,
  type Message,
  type MessageContent,
  type SendMessageInput
} from "@nexus-chat/shared";
import { messageSends } from "../../observability/metrics.js";
import { botService } from "../bots/service.js";
import { workspacePersistenceService } from "../workspaces/persistence-service.js";
import { attachmentService } from "../attachments/service.js";
import { getMessagePersistence } from "./persistence.js";
import { store } from "../store.js";

type MessagePage = { items: Message[]; nextCursor?: string };
const tombstone = (
  message: Message,
  reason: "deleted" | "expired" | "read_once_consumed"
): Message => ({
  ...message,
  content: { type: "tombstone", reason },
  state: "deleted",
  deletedAt: message.deletedAt ?? nowIso()
});
const visible = (message: Message) =>
  message.state === "deleted"
    ? tombstone(
        message,
        message.content.type === "tombstone"
          ? message.content.reason
          : "deleted"
      )
    : message.content.type === "ciphertext" &&
        message.content.expiresAt &&
        Date.parse(message.content.expiresAt) <= Date.now()
      ? tombstone(message, "expired")
      : message;

export const messageService = {
  async send(
    actorId: string,
    input: SendMessageInput
  ): Promise<Message | ReturnType<typeof apiFail>> {
    const channel = await workspacePersistenceService.getChannel(
      input.channelId
    );
    if (
      !channel ||
      channel.workspaceId !== input.workspaceId ||
      !(await workspacePersistenceService.canAccessChannel(
        actorId,
        input.channelId
      ))
    )
      return apiFail("FORBIDDEN", "Channel access denied");
    if (channel.mode === "e2e" && input.content.type !== "ciphertext")
      return apiFail(
        "VALIDATION_FAILED",
        "E2E channels accept ciphertext only"
      );
    if (channel.mode === "normal" && input.content.type === "ciphertext")
      return apiFail(
        "VALIDATION_FAILED",
        "Normal channels accept plaintext message content"
      );
    const persistence = await getMessagePersistence();
    const existing = await persistence.findByClient(actorId, input.clientMsgId);
    if (existing) return existing;
    if (input.replyToMessageId) {
      const reply = await persistence.find(input.replyToMessageId);
      if (
        !reply ||
        reply.channelId !== input.channelId ||
        reply.state === "deleted"
      )
        return apiFail("NOT_FOUND", "Reply target not found or deleted");
    }
    const attachments: AttachmentRef[] =
      "attachments" in input.content ? input.content.attachments : [];
    const validation =
      await attachmentService.validateAttachmentRefs(attachments);
    if ("ok" in validation) return validation;
    const message = messageSchema.parse({
      id: createId(),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      senderId: actorId,
      clientMsgId: input.clientMsgId,
      content: input.content,
      replyToMessageId: input.replyToMessageId,
      state: "sent",
      createdAt: nowIso()
    });
    const created = await persistence.create(
      message,
      attachments.map((a) => a.fileId)
    );
    messageSends.inc({ mode: channel.mode });
    if (channel.mode === "normal")
      await botService.publishEvent({
        type: "message.created",
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        payload: created
      });
    return created;
  },
  async list(actor: string, ch: string, c?: string, l = 50) {
    return (await this.listPage(actor, ch, c, l)).items;
  },
  async listPage(
    actor: string,
    ch: string,
    c?: string,
    l = 50
  ): Promise<MessagePage> {
    if (!(await workspacePersistenceService.canAccessChannel(actor, ch)))
      return { items: [] };
    const items = (await (await getMessagePersistence()).list(ch, c, l)).map(
      visible
    );
    const last = items.at(-1)?.id;
    return items.length === l && last ? { items, nextCursor: last } : { items };
  },
  async edit(actor: string, id: string, text: string) {
    const p = await getMessagePersistence(),
      m = await p.find(id);
    if (!m || m.senderId !== actor)
      return apiFail("FORBIDDEN", "Cannot edit this message");
    if (m.content.type !== "text")
      return apiFail(
        "VALIDATION_FAILED",
        "Only normal text messages can be edited"
      );
    const updated = await p.update({
      ...m,
      content: { ...m.content, text } satisfies MessageContent,
      editedAt: nowIso()
    });
    store.messageEvents.push({
      type: "message.updated",
      channelId: updated.channelId,
      payload: updated,
      createdAt: nowIso()
    });
    return updated;
  },
  async softDelete(actor: string, id: string) {
    const p = await getMessagePersistence(),
      m = await p.find(id);
    if (!m || m.senderId !== actor)
      return apiFail("FORBIDDEN", "Cannot delete this message");
    const updated = await p.update(tombstone(m, "deleted"));
    store.messageEvents.push({
      type: "message.deleted",
      channelId: updated.channelId,
      payload: updated,
      createdAt: nowIso()
    });
    return updated;
  },
  async forward(actor: string, id: string, targetId: string, client: string) {
    const p = await getMessagePersistence(),
      source = await p.find(id),
      target = await workspacePersistenceService.getChannel(targetId);
    if (!source || !target)
      return apiFail("NOT_FOUND", "Message or target channel not found");
    if (
      !(await workspacePersistenceService.canAccessChannel(
        actor,
        source.channelId
      ))
    )
      return apiFail("FORBIDDEN", "Message access denied");
    const sent = await this.send(actor, {
      workspaceId: target.workspaceId,
      channelId: targetId,
      clientMsgId: client,
      content: source.content
    });
    if ("ok" in sent) return sent;
    return p.update({
      ...sent,
      originalMessageId: source.originalMessageId ?? source.id,
      originalSenderId: source.originalSenderId ?? source.senderId,
      originalCreatedAt: source.originalCreatedAt ?? source.createdAt
    });
  },
  async save(actor: string, id: string) {
    const p = await getMessagePersistence(),
      m = await p.find(id);
    if (!m) return apiFail("NOT_FOUND", "Message not found");
    if (
      !(await workspacePersistenceService.canAccessChannel(actor, m.channelId))
    )
      return apiFail("FORBIDDEN", "Message access denied");
    return {
      messageId: id,
      saved: true as const,
      savedAt: await p.save(actor, id)
    };
  },
  async listSaved(actor: string) {
    const persistence = await getMessagePersistence();
    const messages = await persistence.listSaved(actor);
    const results = await Promise.all(
      messages.map(async (message) =>
        (await workspacePersistenceService.canAccessChannel(
          actor,
          message.channelId
        ))
          ? visible(message)
          : undefined
      )
    );
    return results.filter((message): message is Message => Boolean(message));
  },
  async react(
    actor: string,
    id: string,
    emoji: string,
    action: "add" | "remove" = "add"
  ) {
    const p = await getMessagePersistence(),
      m = await p.find(id);
    if (!m) return apiFail("NOT_FOUND", "Message not found");
    if (
      !(await workspacePersistenceService.canAccessChannel(actor, m.channelId))
    )
      return apiFail("FORBIDDEN", "Message access denied");
    const result = {
      messageId: id,
      emoji,
      count: await p.react(id, actor, emoji, action === "add"),
      reacted: action === "add"
    };
    store.messageEvents.push({
      type: "message.reaction",
      channelId: m.channelId,
      payload: result,
      createdAt: nowIso()
    });
    return result;
  },
  async getMessage(id: string) {
    return (await getMessagePersistence()).find(id);
  },
  async getReactions(
    actor: string,
    ch: string
  ): Promise<
    Record<string, Array<{ emoji: string; count: number; reacted: boolean }>>
  > {
    return (await workspacePersistenceService.canAccessChannel(actor, ch))
      ? (await getMessagePersistence()).reactions(ch, actor)
      : {};
  },
  async ackRead(actor: string, id: string) {
    const p = await getMessagePersistence(),
      m = await p.find(id);
    if (!m) return apiFail("NOT_FOUND", "Message not found");
    if (
      !(await workspacePersistenceService.canAccessChannel(actor, m.channelId))
    )
      return apiFail("FORBIDDEN", "Message access denied");
    if (m.senderId !== actor && (await p.receipt(id, actor)))
      store.pendingReadReceipts.push({
        messageId: id,
        userId: actor,
        readAt: nowIso()
      });
    if (m.content.type === "ciphertext" && m.content.readOnce)
      await p.update(tombstone({ ...m, state: "read" }, "read_once_consumed"));
    else await p.update({ ...m, state: "read" });
    return { accepted: true as const };
  },
  async flushReadReceipts(channelId?: string): Promise<
    Array<{
      messageId: string;
      channelId: string;
      readCount: number;
      readers: string[];
      flushedAt: string;
    }>
  > {
    const pending = store.pendingReadReceipts.filter(
      (receipt) =>
        !channelId ||
        store.messages.get(receipt.messageId)?.channelId === channelId
    );
    store.pendingReadReceipts = store.pendingReadReceipts.filter(
      (receipt) =>
        channelId &&
        store.messages.get(receipt.messageId)?.channelId !== channelId
    );
    const groups = new Map<string, string[]>();
    for (const receipt of pending)
      groups.set(receipt.messageId, [
        ...(groups.get(receipt.messageId) ?? []),
        receipt.userId
      ]);
    const persistence = await getMessagePersistence();
    const batches = await Promise.all(
      [...groups].map(async ([messageId, readers]) => {
        const message = await persistence.find(messageId);
        return message
          ? {
              messageId,
              channelId: message.channelId,
              readCount: readers.length,
              readers,
              flushedAt: nowIso()
            }
          : undefined;
      })
    );
    return batches.filter((batch): batch is NonNullable<typeof batch> =>
      Boolean(batch)
    );
  },
  async cleanupExpiredMessages(now = new Date()) {
    const persistence = await getMessagePersistence();
    const expired = await persistence.listExpired(now);
    return Promise.all(
      expired.map((message) =>
        persistence.update(tombstone(message, "expired"))
      )
    );
  },
  async markRead(actor: string, ch: string) {
    if (!(await workspacePersistenceService.canAccessChannel(actor, ch)))
      return apiFail("FORBIDDEN", "Channel access denied");
    await (await getMessagePersistence()).markRead(ch, actor);
    return { ok: true as const };
  },
  async getUnreadCounts(actor: string, w: string) {
    if (!(await workspacePersistenceService.canAccessWorkspace(actor, w)))
      return {};
    const unread = await (await getMessagePersistence()).unread(w, actor),
      channels = await workspacePersistenceService.listChannels(actor, w);
    return Object.fromEntries(
      Object.entries(unread).filter(([channelId]) =>
        channels.some((channel) => channel.id === channelId)
      )
    );
  },
  async pinMessage(actor: string, ch: string, id: string) {
    if (!(await workspacePersistenceService.canManageChannel(actor, ch)))
      return apiFail("FORBIDDEN", "Channel access denied");
    const m = await (await getMessagePersistence()).find(id);
    if (!m || m.channelId !== ch || m.state === "deleted")
      return apiFail("NOT_FOUND", "Message not found in channel");
    return (await (await getMessagePersistence()).pin(ch, id))
      ? { pinned: true as const }
      : apiFail("FORBIDDEN", "Max 50 pinned messages per channel");
  },
  async unpinMessage(actor: string, ch: string, id: string) {
    if (!(await workspacePersistenceService.canManageChannel(actor, ch)))
      return apiFail("FORBIDDEN", "Channel access denied");
    return (await (await getMessagePersistence()).unpin(ch, id))
      ? { pinned: false as const }
      : apiFail("NOT_FOUND", "Message not pinned");
  },
  async listPins(actor: string, ch: string) {
    if (!(await workspacePersistenceService.canAccessChannel(actor, ch)))
      return apiFail("FORBIDDEN", "Channel access denied");
    return (await (await getMessagePersistence()).pins(ch)).filter(
      (m) => m.state !== "deleted"
    );
  }
};

/**
 * Message Persistence
 *
 * Owns message, reaction, saved-message, read-receipt, read-state, and pin storage.
 *
 * Responsibilities:
 * - Create messages with idempotency via (sender_id, client_msg_id) uniqueness
 * - Provide cursor-based pagination over channel messages
 * - Persist reactions, saves, read receipts, and pins
 * - Maintain per-channel per-user read state
 * - Query expired ciphertext messages for cleanup
 *
 * Does NOT:
 * - Enforce access control (delegated to message service + workspace persistence)
 * - Apply tombstone or visibility rules (delegated to message service)
 * - Broadcast real-time events or maintain event buffers
 *
 * Invariants:
 * - Message idempotency is guaranteed by the unique (sender_id, client_msg_id) index
 * - Row mappers translate PostgreSQL timestamps to ISO 8601 strings
 * - All methods are async for both backends
 * - Pins are capped at 50 per channel, enforced at the persistence layer
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI, workspace
 *
 * Future Evolution:
 * - full-text search with PostgreSQL tsvector + GIN index
 * - Message threading via thread_id
 */
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { Message } from "@nexus-chat/shared";
import { getDb, type Database } from "../../db/client.js";
import {
  channelMembers,
  channelPins,
  messageAttachments,
  messageReadReceipts,
  messageReactions,
  messages,
  savedMessages
} from "../../db/schema.js";
import { store } from "../store.js";

const mapMessage = (row: typeof messages.$inferSelect): Message => ({
  id: row.id,
  workspaceId: row.workspaceId,
  channelId: row.channelId,
  senderId: row.senderId,
  clientMsgId: row.clientMsgId,
  content: row.content as Message["content"],
  state: row.state,
  ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
  ...(row.originalMessageId
    ? { originalMessageId: row.originalMessageId }
    : {}),
  ...(row.originalSenderId ? { originalSenderId: row.originalSenderId } : {}),
  ...(row.originalCreatedAt
    ? { originalCreatedAt: row.originalCreatedAt.toISOString() }
    : {}),
  createdAt: row.createdAt.toISOString(),
  ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}),
  ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {})
});

export interface MessagePersistence {
  find(id: string): Promise<Message | undefined>;
  findByClient(senderId: string, clientMsgId: string): Promise<Message | undefined>;
  /**
   * Creates a message with attachment references. Returns the existing message
   * when a duplicate (sender_id, client_msg_id) is detected. Attachment
   * association is atomic with the message insert.
   */
  create(message: Message, fileIds: string[]): Promise<Message>;
  list(channelId: string, cursor?: string, limit?: number): Promise<Message[]>;
  update(message: Message): Promise<Message>;
  save(userId: string, messageId: string): Promise<string>;
  listSaved(userId: string): Promise<Message[]>;
  /**
   * Finds ciphertext messages whose expiresAt timestamp has passed the given date.
   */
  listExpired(before: Date): Promise<Message[]>;
  react(
    messageId: string,
    userId: string,
    emoji: string,
    add: boolean
  ): Promise<number>;
  reactions(
    channelId: string,
    userId: string
  ): Promise<
    Record<string, Array<{ emoji: string; count: number; reacted: boolean }>>
  >;
  /**
   * Records a read receipt. Returns true on first record, false if already exists.
   */
  receipt(messageId: string, userId: string): Promise<boolean>;
  markRead(channelId: string, userId: string): Promise<void>;
  unread(workspaceId: string, userId: string): Promise<Record<string, number>>;
  /**
   * Pins a message. Returns false if the channel already has 50 pins
   * and this message is not already among them.
   */
  pin(channelId: string, messageId: string): Promise<boolean>;
  unpin(channelId: string, messageId: string): Promise<boolean>;
  pins(channelId: string): Promise<Message[]>;
}

export class InMemoryMessagePersistence implements MessagePersistence {
  async find(id: string) {
    return store.messages.get(id);
  }
  async findByClient(s: string, c: string) {
    const id = store.messagesByClientId.get(`${s}:${c}`);
    return id ? store.messages.get(id) : undefined;
  }
  async create(m: Message, ids: string[]) {
    const e = await this.findByClient(m.senderId, m.clientMsgId);
    if (e) return e;
    store.messages.set(m.id, m);
    store.messagesByClientId.set(`${m.senderId}:${m.clientMsgId}`, m.id);
    store.messageAttachments.set(m.id, new Set(ids));
    return m;
  }
  async list(ch: string, c?: string, l = 50) {
    const all = [...store.messages.values()]
      .filter((m) => m.channelId === ch)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = c ? all.findIndex((m) => m.id === c) + 1 : 0;
    return all.slice(Math.max(0, start), Math.max(0, start) + l);
  }
  async update(m: Message) {
    store.messages.set(m.id, m);
    return m;
  }
  async save(u: string, m: string) {
    const key = `${u}:${m}`,
      old = store.savedMessages.get(key);
    if (old) return old.createdAt;
    const createdAt = new Date().toISOString();
    store.savedMessages.set(key, { userId: u, messageId: m, createdAt });
    return createdAt;
  }
  async listSaved(userId: string) {
    return [...store.savedMessages.values()]
      .filter((saved) => saved.userId === userId)
      .flatMap((saved) => store.messages.get(saved.messageId) ?? []);
  }
  async listExpired(before: Date) {
    return [...store.messages.values()].filter(
      (message) =>
        message.state !== "deleted" &&
        message.content.type === "ciphertext" &&
        message.content.expiresAt !== undefined &&
        Date.parse(message.content.expiresAt) <= before.getTime()
    );
  }
  async react(m: string, u: string, e: string, a: boolean) {
    const key = `${m}:${u}:${e}`;
    if (a)
      store.messageReactions.set(key, {
        messageId: m,
        userId: u,
        emoji: e,
        createdAt: new Date().toISOString()
      });
    else store.messageReactions.delete(key);
    return [...store.messageReactions.values()].filter(
      (r) => r.messageId === m && r.emoji === e
    ).length;
  }
  async reactions(ch: string, u: string) {
    const out: Record<
      string,
      Array<{ emoji: string; count: number; reacted: boolean }>
    > = {};
    for (const r of store.messageReactions.values()) {
      if (store.messages.get(r.messageId)?.channelId !== ch) continue;
      const x = (out[r.messageId] ??= []);
      const found = x.find((v) => v.emoji === r.emoji);
      if (found) {
        found.count++;
        if (r.userId === u) found.reacted = true;
      } else x.push({ emoji: r.emoji, count: 1, reacted: r.userId === u });
    }
    return out;
  }
  async receipt(m: string, u: string) {
    const key = `${m}:${u}`;
    if (store.readReceipts.has(key)) return false;
    store.readReceipts.set(key, {
      messageId: m,
      userId: u,
      readAt: new Date().toISOString()
    });
    return true;
  }
  async markRead(ch: string, u: string) {
    store.channelLastRead.set(`${ch}:${u}`, new Date().toISOString());
  }
  async unread(w: string, u: string) {
    const o: Record<string, number> = {};
    for (const ch of store.channels.values())
      if (ch.workspaceId === w) {
        const at = store.channelLastRead.get(`${ch.id}:${u}`);
        const n = [...store.messages.values()].filter(
          (m) =>
            m.channelId === ch.id &&
            m.state === "sent" &&
            m.senderId !== u &&
            (!at || m.createdAt > at)
        ).length;
        if (n) o[ch.id] = n;
      }
    return o;
  }
  async pin(c: string, m: string) {
    const pins = store.pinnedMessages.get(c) ?? new Set<string>();
    if (pins.size >= 50 && !pins.has(m)) return false;
    pins.add(m);
    store.pinnedMessages.set(c, pins);
    return true;
  }
  async unpin(c: string, m: string) {
    return store.pinnedMessages.get(c)?.delete(m) ?? false;
  }
  async pins(c: string) {
    return [...(store.pinnedMessages.get(c) ?? [])].flatMap(
      (id) => store.messages.get(id) ?? []
    );
  }
}

export class DrizzleMessagePersistence implements MessagePersistence {
  constructor(private readonly database: Database) {}
  async find(id: string) {
    const [r] = await this.database
      .select()
      .from(messages)
      .where(eq(messages.id, id));
    return r && mapMessage(r);
  }
  async findByClient(s: string, c: string) {
    const [r] = await this.database
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, s), eq(messages.clientMsgId, c)));
    return r && mapMessage(r);
  }
  async create(m: Message, fileIds: string[]) {
    return this.database.transaction(async (tx) => {
      const inserted = await tx
        .insert(messages)
        .values({
          ...m,
          content: m.content,
          replyToMessageId: m.replyToMessageId ?? null,
          originalMessageId: m.originalMessageId ?? null,
          originalSenderId: m.originalSenderId ?? null,
          originalCreatedAt: m.originalCreatedAt
            ? new Date(m.originalCreatedAt)
            : null,
          createdAt: new Date(m.createdAt),
          editedAt: null,
          deletedAt: null
        })
        .onConflictDoNothing()
        .returning();
      const row =
        inserted[0] ??
        (await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.senderId, m.senderId),
              eq(messages.clientMsgId, m.clientMsgId)
            )
          )
          .then((x) => x[0]));
      if (!row) throw new Error("message insert failed");
      if (inserted.length && fileIds.length)
        await tx
          .insert(messageAttachments)
          .values(fileIds.map((fileId) => ({ messageId: m.id, fileId })))
          .onConflictDoNothing();
      return mapMessage(row);
    });
  }
  async list(ch: string, c?: string, l = 50) {
    const where = c
      ? and(eq(messages.channelId, ch), gt(messages.id, c))
      : eq(messages.channelId, ch);
    return (
      await this.database
        .select()
        .from(messages)
        .where(where)
        .orderBy(asc(messages.id))
        .limit(l)
    ).map(mapMessage);
  }
  async update(m: Message) {
    const [r] = await this.database
      .update(messages)
      .set({
        content: m.content,
        state: m.state,
        editedAt: m.editedAt ? new Date(m.editedAt) : null,
        deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
        originalMessageId: m.originalMessageId ?? null,
        originalSenderId: m.originalSenderId ?? null,
        originalCreatedAt: m.originalCreatedAt
          ? new Date(m.originalCreatedAt)
          : null
      })
      .where(eq(messages.id, m.id))
      .returning();
    return mapMessage(r!);
  }
  async save(u: string, m: string) {
    const now = new Date();
    const [r] = await this.database
      .insert(savedMessages)
      .values({ userId: u, messageId: m, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (r) return r.createdAt.toISOString();
    const [e] = await this.database
      .select()
      .from(savedMessages)
      .where(and(eq(savedMessages.userId, u), eq(savedMessages.messageId, m)));
    return e!.createdAt.toISOString();
  }
  async listSaved(userId: string) {
    const rows = await this.database
      .select({ message: messages })
      .from(savedMessages)
      .innerJoin(messages, eq(savedMessages.messageId, messages.id))
      .where(eq(savedMessages.userId, userId));
    return rows.map(({ message }) => mapMessage(message));
  }
  async listExpired(before: Date) {
    const rows = await this.database
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.state, "sent"),
          sql`${messages.content}->>'type' = 'ciphertext'`,
          lt(sql`(${messages.content}->>'expiresAt')::timestamptz`, before)
        )
      );
    return rows.map(mapMessage);
  }
  async react(m: string, u: string, e: string, a: boolean) {
    if (a)
      await this.database
        .insert(messageReactions)
        .values({ messageId: m, userId: u, emoji: e })
        .onConflictDoNothing();
    else
      await this.database
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, m),
            eq(messageReactions.userId, u),
            eq(messageReactions.emoji, e)
          )
        );
    const [r] = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(messageReactions)
      .where(
        and(eq(messageReactions.messageId, m), eq(messageReactions.emoji, e))
      );
    return r?.count ?? 0;
  }
  async reactions(ch: string, u: string) {
    const rows = await this.database
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactions.userId} = ${u})`
      })
      .from(messageReactions)
      .innerJoin(messages, eq(messageReactions.messageId, messages.id))
      .where(eq(messages.channelId, ch))
      .groupBy(messageReactions.messageId, messageReactions.emoji);
    return rows.reduce<
      Record<string, Array<{ emoji: string; count: number; reacted: boolean }>>
    >((o, r) => {
      (o[r.messageId] ??= []).push({
        emoji: r.emoji,
        count: r.count,
        reacted: r.reacted
      });
      return o;
    }, {});
  }
  async receipt(m: string, u: string) {
    return (
      (
        await this.database
          .insert(messageReadReceipts)
          .values({ messageId: m, userId: u })
          .onConflictDoNothing()
          .returning()
      ).length > 0
    );
  }
  async markRead(c: string, u: string) {
    await this.database
      .update(channelMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(eq(channelMembers.channelId, c), eq(channelMembers.userId, u))
      );
  }
  async unread(w: string, u: string) {
    const rows = await this.database.execute(
      sql`SELECT c.id, count(m.id)::int AS count FROM channels c LEFT JOIN channel_members cm ON cm.channel_id=c.id AND cm.user_id=${u} LEFT JOIN messages m ON m.channel_id=c.id AND m.state='sent' AND m.sender_id<>${u} AND (cm.last_read_at IS NULL OR m.created_at>cm.last_read_at) WHERE c.workspace_id=${w} GROUP BY c.id`
    );
    return (rows.rows as Array<{ id: string; count: number }>).reduce<
      Record<string, number>
    >((o, r) => {
      if (r.count) o[r.id] = r.count;
      return o;
    }, {});
  }
  async pin(c: string, m: string) {
    const count = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(channelPins)
      .where(eq(channelPins.channelId, c));
    if ((count[0]?.count ?? 0) >= 50) {
      const existing = await this.database
        .select()
        .from(channelPins)
        .where(and(eq(channelPins.channelId, c), eq(channelPins.messageId, m)));
      if (!existing.length) return false;
    }
    await this.database
      .insert(channelPins)
      .values({ channelId: c, messageId: m })
      .onConflictDoNothing();
    return true;
  }
  async unpin(c: string, m: string) {
    return (
      (
        await this.database
          .delete(channelPins)
          .where(
            and(eq(channelPins.channelId, c), eq(channelPins.messageId, m))
          )
          .returning()
      ).length > 0
    );
  }
  async pins(c: string) {
    return (
      await this.database
        .select({ message: messages })
        .from(channelPins)
        .innerJoin(messages, eq(channelPins.messageId, messages.id))
        .where(eq(channelPins.channelId, c))
    ).map((x) => mapMessage(x.message));
  }
}

let persistence: MessagePersistence | undefined;

/**
 * Selects InMemoryMessagePersistence or DrizzleMessagePersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getMessagePersistence() {
  if (persistence) return persistence;
  if ((await import("../../config/env.js")).env.PERSISTENCE === "memory")
    return (persistence = new InMemoryMessagePersistence());
  return (persistence = new DrizzleMessagePersistence(await getDb()));
}

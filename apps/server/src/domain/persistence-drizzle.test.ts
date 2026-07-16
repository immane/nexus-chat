import { describe, expect, it } from "vitest";
import type { BotManifest, Channel, FileRecord, Message, SignalPreKeyBundle, Workspace } from "@nexus-chat/shared";
import type { Database } from "../db/client.js";
import { DrizzleAttachmentPersistence } from "./attachments/persistence.js";
import { DrizzleUserPersistence } from "./auth/persistence.js";
import { DrizzleBotPersistence } from "./bots/persistence.js";
import { DrizzleMessagePersistence } from "./messages/persistence.js";
import { DrizzleSignalPersistence } from "./signal/persistence.js";
import { DrizzleWorkspacePersistence } from "./workspaces/persistence.js";

type Row = Record<string, unknown>;
type Query = PromiseLike<Row[]> & Record<string, (...args: unknown[]) => Query | Promise<Row[]>>;

const row: Row = {
  id: "id", messageId: "id", workspaceId: "workspace", channelId: "channel", userId: "user", ownerId: "user", senderId: "sender", peerUserId: "peer", deviceId: "device", email: "user@example.com", displayName: "User", passwordHash: "hash", name: "name", description: null, kind: "channel", mode: "normal", isPrivate: false, createdById: null, clientMsgId: "client", content: { type: "text", text: "hello", attachments: [] }, state: "sent", replyToMessageId: null, originalMessageId: null, originalSenderId: null, originalCreatedAt: null, editedAt: null, deletedAt: null, fileId: "file", fileName: "file.txt", contentType: "text/plain", sizeBytes: 1, objectKey: "object", encrypted: false, scanStatus: "pending", expiresAt: new Date("2030-01-01T00:00:00.000Z"), completedAt: null, status: "pending", tokenHash: "token", manifest: { id: "bot", name: "Bot", description: "Test bot", commands: [], scopes: [] }, eventType: "message.created", role: "member", count: 1, emoji: "+1", reacted: true, identityKey: "identity", signedPreKeyId: 1, signedPreKey: "signed", signedPreKeySignature: "signature", consumedAt: null, metadata: {}, createdAt: new Date("2025-01-01T00:00:00.000Z"), updatedAt: new Date("2025-01-01T00:00:00.000Z")
};
row.bot = row;
row.file = row;
row.message = row;
row.workspace = row;

const fakeDatabase = (...results: Row[][]): Database => {
  const next = () => results.shift() ?? [row];
  const query = (): Query => {
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(next()),
      innerJoin: () => builder,
      orderBy: () => builder,
      groupBy: () => Promise.resolve(next()),
      then: <TResult1 = Row[], TResult2 = never>(onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => Promise.resolve(next()).then(onfulfilled, onrejected)
    };
    return builder as Query;
  };
  const write = () => {
    const builder = {
      values: (value: unknown) => { void value; return builder; },
      set: (value: unknown) => { void value; return builder; },
      where: (value: unknown) => { void value; return builder; },
      onConflictDoNothing: () => builder,
      onConflictDoUpdate: (value: unknown) => { void value; return builder; },
      returning: () => Promise.resolve(next())
    };
    return builder;
  };
  const database = {
    select: (selection?: unknown) => { void selection; return query(); },
    insert: (table: unknown) => { void table; return write(); },
    update: (table: unknown) => { void table; return write(); },
    delete: (table: unknown) => { void table; return write(); },
    execute: async (sql: unknown) => { void sql; return { rows: next() }; },
    transaction: async <T>(operation: (tx: Database) => Promise<T>) => operation(database as unknown as Database)
  };
  return database as unknown as Database;
};

const manifest: BotManifest = { id: "bot", name: "Bot", description: "Test bot", commands: [], scopes: [] };
const workspace: Workspace = { id: "workspace", name: "Workspace", createdAt: "2025-01-01T00:00:00.000Z" };
const channel: Channel = { id: "channel", workspaceId: workspace.id, name: "general", kind: "channel", mode: "normal", isPrivate: false, createdAt: workspace.createdAt };
const message: Message = { id: "message", workspaceId: workspace.id, channelId: channel.id, senderId: "sender", clientMsgId: "client", content: { type: "text", text: "hello", attachments: [] }, state: "sent", createdAt: workspace.createdAt };

describe("PostgreSQL persistence adapters", () => {
  it("maps users and attachments through queries and transactions", async () => {
    const users = new DrizzleUserPersistence(fakeDatabase());
    expect(await users.findByEmail("user@example.com")).toMatchObject({ createdAt: workspace.createdAt });
    expect(await users.findById("id")).toMatchObject({ id: "id" });
    expect(await users.create({ id: "id", email: "user@example.com", displayName: "User", passwordHash: "hash", createdAt: workspace.createdAt })).toBe(true);
    await users.recordAudit({ id: "audit", action: "created", metadata: {}, createdAt: workspace.createdAt });

    const attachments = new DrizzleAttachmentPersistence(fakeDatabase());
    const file: FileRecord = { id: "file", workspaceId: workspace.id, ownerId: "user", fileName: "file.txt", contentType: "text/plain", sizeBytes: 1, objectKey: "object", encrypted: false, scanStatus: "pending", createdAt: workspace.createdAt };
    await attachments.create(file, { id: "upload", fileId: file.id, userId: "user", uploadUrl: "url", expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(await attachments.findFile(file.id)).toMatchObject({ channelId: "channel" });
    expect(await attachments.findSession("upload")).toMatchObject({ uploadUrl: "" });
    expect(await attachments.findSessionForFile(file.id, "user")).toMatchObject({ id: "id" });
    expect(await attachments.completeSession("upload")).toMatchObject({ id: "id" });
    expect(await attachments.updateFile(file.id, { scanStatus: "clean" })).toMatchObject({ scanStatus: "pending" });
    await attachments.associate(message.id, [file.id]);
    expect(await attachments.listForMessage(message.id)).toMatchObject([{ id: "id" }]);
  });

  it("executes bot persistence operations and maps bot records", async () => {
    const bots = new DrizzleBotPersistence(fakeDatabase());
    await bots.create({ id: "bot", workspaceId: workspace.id, manifest, tokenHash: "token" });
    expect(await bots.find("bot")).toMatchObject({ createdAt: workspace.createdAt });
    expect(await bots.findByTokenHash("token")).toMatchObject({ tokenHash: "token" });
    await bots.addChannel("bot", channel.id);
    expect(await bots.removeChannel("bot", channel.id)).toBe(true);
    expect(await bots.hasChannel("bot", channel.id)).toBe(true);
    await bots.subscribe("bot", "message.created");
    expect(await bots.unsubscribe("bot", "message.created")).toBe(true);
    expect(await bots.subscriptions("bot")).toEqual(["message.created"]);
    expect(await bots.matchingBots(channel.id, "message.created")).toMatchObject([{ id: "id" }]);
    expect(await bots.listByWorkspace(workspace.id)).toMatchObject([{ id: "id" }]);
    await new DrizzleBotPersistence(fakeDatabase([])).subscribe("bot", "message.created");
  });

  it("executes message persistence writes, reads, aggregates, and pin limits", async () => {
    const messages = new DrizzleMessagePersistence(fakeDatabase());
    expect(await messages.find(message.id)).toMatchObject({ id: "id" });
    expect(await messages.findByClient(message.senderId, message.clientMsgId)).toMatchObject({ id: "id" });
    expect(await messages.create(message, ["file"])).toMatchObject({ id: "id" });
    expect(await messages.list(channel.id)).toHaveLength(1);
    expect(await messages.update({ ...message, editedAt: workspace.createdAt })).toMatchObject({ id: "id" });
    expect(await messages.save("user", message.id)).toBe(workspace.createdAt);
    expect(await new DrizzleMessagePersistence(fakeDatabase([], [row])).save("user", message.id)).toBe(workspace.createdAt);
    expect(await messages.listSaved("user")).toHaveLength(1);
    expect(await messages.listExpired(new Date())).toHaveLength(1);
    expect(await messages.react(message.id, "user", "+1", true)).toBe(1);
    expect(await messages.react(message.id, "user", "+1", false)).toBe(1);
    expect(await messages.reactions(channel.id, "user")).toEqual({ id: [{ emoji: "+1", count: 1, reacted: true }] });
    expect(await messages.receipt(message.id, "user")).toBe(true);
    await messages.markRead(channel.id, "user");
    expect(await messages.unread(workspace.id, "user")).toEqual({ id: 1 });
    expect(await messages.pin(channel.id, message.id)).toBe(true);
    expect(await messages.unpin(channel.id, message.id)).toBe(true);
    expect(await messages.pins(channel.id)).toHaveLength(1);
    expect(await new DrizzleMessagePersistence(fakeDatabase([{ count: 50 }], [])).pin(channel.id, message.id)).toBe(false);
  });

  it("executes workspace persistence operations including the DM conflict path", async () => {
    const persistence = new DrizzleWorkspacePersistence(fakeDatabase());
    await persistence.createWorkspace({ workspace, owner: { workspaceId: workspace.id, userId: "user", role: "owner" }, channel });
    expect(await persistence.findWorkspace(workspace.id)).toMatchObject({ id: "id" });
    expect(await persistence.listWorkspaces("user")).toHaveLength(1);
    expect(await persistence.getRole("user", workspace.id)).toBe("member");
    expect(await persistence.updateWorkspace(workspace.id, "New")).toMatchObject({ id: "id" });
    await persistence.upsertMember({ workspaceId: workspace.id, userId: "user", role: "member" });
    expect(await persistence.deleteMemberAndChannelMemberships(workspace.id, "user")).toBe(true);
    expect(await persistence.listMembers(workspace.id)).toHaveLength(1);
    expect(await persistence.updateMemberRole(workspace.id, "user", "admin")).toMatchObject({ role: "member" });
    expect(await persistence.findChannel(channel.id)).toMatchObject({ id: "id" });
    expect(await persistence.listChannels(workspace.id)).toHaveLength(1);
    expect(await persistence.createChannel(channel, ["user"])).toMatchObject({ id: "id" });
    expect(await persistence.createOrGetDm({ ...channel, name: "dm:user:peer:normal", kind: "dm", isPrivate: true }, ["user", "peer"])).toMatchObject({ id: "id" });
    await persistence.upsertChannelMember(channel.id, "user");
    expect(await persistence.deleteChannelMember(channel.id, "user")).toBe(true);
    expect(await persistence.listChannelMembers(channel.id)).toHaveLength(1);
    expect(await persistence.updateChannel(channel)).toMatchObject({ id: "id" });
    expect(await persistence.isMuted("user", channel.id)).toBe(true);
    await persistence.setMuted("user", channel.id, true);
    await persistence.setMuted("user", channel.id, false);
  });

  it("executes Signal bundle and session queries", async () => {
    const signal = new DrizzleSignalPersistence(fakeDatabase());
    const bundle: SignalPreKeyBundle = { userId: "user", deviceId: "device", identityKey: "identity", signedPreKeyId: 1, signedPreKey: "signed", signedPreKeySignature: "signature" };
    await signal.upload(bundle, [{ keyId: 1, publicKey: "one" }]);
    expect(await signal.takeBundle("user", "device")).toMatchObject({ userId: "user" });
    expect(await new DrizzleSignalPersistence(fakeDatabase([row], [])).takeBundle("user", "device")).toEqual(bundle);
    expect(await signal.consume("user", "device", 1)).toBe("consumed");
    expect(await new DrizzleSignalPersistence(fakeDatabase([], [row])).consume("user", "device", 1)).toBe("used");
    expect(await signal.count("user", "device")).toBe(1);
    await signal.createSession({ id: "session", ownerUserId: "user", peerUserId: "peer", deviceId: "device", metadata: {}, updatedAt: workspace.createdAt });
    expect(await signal.session("session")).toMatchObject({ updatedAt: workspace.createdAt });
    expect(await signal.sessions("user")).toHaveLength(1);
  });
});

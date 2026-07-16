import { beforeEach, describe, expect, it } from "vitest";
import type { BotManifest, Channel, FileRecord, Message, SignalPreKeyBundle, Workspace } from "@nexus-chat/shared";
import { InMemoryAttachmentPersistence } from "./attachments/persistence.js";
import { InMemoryUserPersistence } from "./auth/persistence.js";
import { InMemoryBotPersistence } from "./bots/persistence.js";
import { InMemoryMessagePersistence } from "./messages/persistence.js";
import { InMemorySignalPersistence } from "./signal/persistence.js";
import { store } from "./store.js";
import { resetStore } from "./test-utils.js";
import { InMemoryWorkspacePersistence } from "./workspaces/persistence.js";

const manifest: BotManifest = { id: "bot", name: "Bot", description: "Test bot", commands: [], scopes: [] };
const workspace: Workspace = { id: "workspace", name: "Workspace", createdAt: "2025-01-01T00:00:00.000Z" };
const channel: Channel = { id: "channel", workspaceId: workspace.id, name: "general", kind: "channel", mode: "normal", isPrivate: false, createdById: "owner", createdAt: workspace.createdAt };
const message = (id: string, overrides: Partial<Message> = {}): Message => ({ id, workspaceId: workspace.id, channelId: channel.id, senderId: "sender", clientMsgId: `client-${id}`, content: { type: "text", text: id, attachments: [] }, state: "sent", createdAt: `2025-01-01T00:00:0${id}.000Z`, ...overrides });

describe("in-memory persistence adapters", () => {
  beforeEach(() => {
    resetStore();
    store.channelLastRead.clear();
    store.pinnedMessages.clear();
    store.channelMutes.clear();
  });

  it("persists users and attachment lifecycle state", async () => {
    const users = new InMemoryUserPersistence();
    const attachments = new InMemoryAttachmentPersistence();
    const user = { id: "owner", email: "owner@example.com", displayName: "Owner", passwordHash: "hash", createdAt: workspace.createdAt };
    const file: FileRecord = { id: "file", workspaceId: workspace.id, ownerId: user.id, fileName: "a.txt", contentType: "text/plain", sizeBytes: 1, objectKey: "pending", encrypted: false, scanStatus: "pending", createdAt: workspace.createdAt };
    const session = { id: "session", fileId: file.id, userId: user.id, uploadUrl: "url", expiresAt: "2030-01-01T00:00:00.000Z" };

    expect(await users.create(user)).toBe(true);
    expect(await users.create(user)).toBe(false);
    expect(await users.findByEmail(user.email)).toEqual(user);
    expect(await users.findById("missing")).toBeUndefined();
    await users.recordAudit({ id: "audit", action: "created", metadata: {}, createdAt: workspace.createdAt });
    expect(store.auditLogs).toHaveLength(1);

    await attachments.create(file, session);
    expect(await attachments.findFile(file.id)).toEqual(file);
    expect(await attachments.findSessionForFile(file.id, user.id)).toEqual(session);
    expect(await attachments.findSession("missing")).toBeUndefined();
    expect(await attachments.completeSession("missing")).toBeUndefined();
    expect(await attachments.completeSession(session.id)).toMatchObject({ completedAt: expect.any(String) });
    expect(await attachments.updateFile(file.id, { objectKey: "ready", scanStatus: "clean" })).toMatchObject({ objectKey: "ready", scanStatus: "clean" });
    expect(await attachments.updateFile("missing", {})).toBeUndefined();
    await attachments.associate("message", [file.id, "missing"]);
    expect(await attachments.listForMessage("message")).toMatchObject([{ id: file.id }]);
  });

  it("handles bot channels, subscriptions, and matching", async () => {
    const bots = new InMemoryBotPersistence();
    await bots.create({ id: "bot", workspaceId: workspace.id, manifest, tokenHash: "token" });
    expect(await bots.find("bot")).toMatchObject({ manifest, tokenHash: "token" });
    expect(await bots.find("missing")).toBeUndefined();
    expect(await bots.findByTokenHash("token")).toMatchObject({ id: "bot" });
    expect(await bots.findByTokenHash("missing")).toBeUndefined();
    await bots.addChannel("bot", channel.id);
    await bots.addChannel("missing", channel.id);
    expect(await bots.hasChannel("bot", channel.id)).toBe(true);
    expect(await bots.hasChannel("missing", channel.id)).toBe(false);
    expect(await bots.removeChannel("missing", channel.id)).toBe(false);
    await bots.addChannel("bot", channel.id);
    await bots.subscribe("bot", "message.created");
    await bots.subscribe("missing", "message.created");
    expect(await bots.subscriptions("bot")).toEqual(["message.created"]);
    expect(await bots.unsubscribe("bot", "missing")).toBe(false);
    expect(await bots.matchingBots(channel.id, "message.created")).toMatchObject([{ id: "bot" }]);
    expect(await bots.listByWorkspace(workspace.id)).toHaveLength(1);
    expect(await bots.removeChannel("bot", channel.id)).toBe(true);
    expect(await bots.unsubscribe("bot", "message.created")).toBe(true);
  });

  it("handles messages, reactions, read state, and pins", async () => {
    const messages = new InMemoryMessagePersistence();
    store.channels.set(channel.id, channel);
    const first = message("1");
    const second = message("2", { senderId: "other", content: { type: "ciphertext", ciphertext: "x", algorithm: "signal-v1", senderDeviceId: "device", readOnce: false, expiresAt: "2025-01-01T00:00:01.000Z", attachments: [] } });
    expect(await messages.create(first, ["file"])).toEqual(first);
    expect(await messages.create({ ...first, id: "duplicate" }, [])).toEqual(first);
    await messages.create(second, []);
    expect(await messages.find(first.id)).toEqual(first);
    expect(await messages.findByClient(first.senderId, first.clientMsgId)).toEqual(first);
    expect(await messages.list(channel.id, first.id, 1)).toEqual([second]);
    expect(await messages.update({ ...first, state: "read" })).toMatchObject({ state: "read" });
    expect(await messages.save("user", first.id)).toBe(await messages.save("user", first.id));
    expect(await messages.listSaved("user")).toHaveLength(1);
    expect(await messages.listExpired(new Date("2025-01-01T00:00:02.000Z"))).toEqual([second]);
    expect(await messages.react(first.id, "user", "+1", true)).toBe(1);
    await messages.react(first.id, "other", "+1", true);
    expect(await messages.reactions(channel.id, "user")).toEqual({ [first.id]: [{ emoji: "+1", count: 2, reacted: true }] });
    expect(await messages.react(first.id, "user", "+1", false)).toBe(1);
    expect(await messages.receipt(first.id, "user")).toBe(true);
    expect(await messages.receipt(first.id, "user")).toBe(false);
    expect(await messages.unread(workspace.id, "user")).toEqual({ [channel.id]: 1 });
    await messages.markRead(channel.id, "user");
    expect(await messages.unread(workspace.id, "user")).toEqual({});
    expect(await messages.pin(channel.id, first.id)).toBe(true);
    expect(await messages.pins(channel.id)).toHaveLength(1);
    expect(await messages.unpin(channel.id, first.id)).toBe(true);
    expect(await messages.unpin(channel.id, first.id)).toBe(false);
    store.pinnedMessages.set(channel.id, new Set(Array.from({ length: 50 }, (_, index) => `pin-${index}`)));
    expect(await messages.pin(channel.id, "new")).toBe(false);
  });

  it("handles workspace membership, channel membership, and mutes", async () => {
    const persistence = new InMemoryWorkspacePersistence();
    await persistence.createWorkspace({ workspace, owner: { workspaceId: workspace.id, userId: "owner", role: "owner" }, channel });
    expect(await persistence.findWorkspace(workspace.id)).toEqual(workspace);
    expect(await persistence.listWorkspaces("owner")).toEqual([workspace]);
    expect(await persistence.getRole("owner", workspace.id)).toBe("owner");
    expect(await persistence.updateWorkspace(workspace.id, "Renamed")).toMatchObject({ name: "Renamed" });
    expect(await persistence.updateWorkspace("missing", "x")).toBeUndefined();
    await persistence.upsertMember({ workspaceId: workspace.id, userId: "member", role: "member" });
    store.users.set("member", { id: "member", email: "member@example.com", displayName: "Member", passwordHash: "hash", createdAt: workspace.createdAt });
    expect(await persistence.listMembers(workspace.id)).toEqual(expect.arrayContaining([expect.objectContaining({ userId: "member", email: "member@example.com" })]));
    expect(await persistence.updateMemberRole(workspace.id, "member", "admin")).toMatchObject({ role: "admin" });
    expect(await persistence.updateMemberRole(workspace.id, "missing", "admin")).toBeUndefined();
    const privateChannel = { ...channel, id: "private", name: "private", isPrivate: true };
    expect(await persistence.createChannel(privateChannel, ["owner"])).toEqual(privateChannel);
    expect(await persistence.createChannel({ ...privateChannel, id: "duplicate" }, [])).toBeUndefined();
    expect(await persistence.createOrGetDm({ ...channel, id: "dm", name: "dm:a:b", kind: "dm", isPrivate: true }, ["owner", "member"])).toMatchObject({ id: "dm" });
    expect(await persistence.createOrGetDm({ ...channel, id: "other", name: "dm:a:b", kind: "dm", isPrivate: true }, [])).toMatchObject({ id: "dm" });
    await persistence.upsertChannelMember(privateChannel.id, "member");
    expect(await persistence.listChannelMembers(privateChannel.id)).toHaveLength(2);
    expect(await persistence.deleteChannelMember(privateChannel.id, "member")).toBe(true);
    expect(await persistence.deleteChannelMember(privateChannel.id, "member")).toBe(false);
    expect(await persistence.updateChannel({ ...privateChannel, description: "Secret" })).toMatchObject({ description: "Secret" });
    await persistence.setMuted("member", privateChannel.id, true);
    expect(await persistence.isMuted("member", privateChannel.id)).toBe(true);
    await persistence.setMuted("member", privateChannel.id, false);
    expect(await persistence.isMuted("member", privateChannel.id)).toBe(false);
    expect(await persistence.deleteMemberAndChannelMemberships(workspace.id, "member")).toBe(true);
    expect(await persistence.deleteMemberAndChannelMemberships(workspace.id, "member")).toBe(false);
  });

  it("consumes Signal pre-keys and finds sessions", async () => {
    const signal = new InMemorySignalPersistence();
    const bundle: SignalPreKeyBundle = { userId: "user", deviceId: "device", identityKey: "identity", signedPreKeyId: 1, signedPreKey: "signed", signedPreKeySignature: "signature" };
    await signal.upload(bundle, [{ keyId: 1, publicKey: "one" }]);
    expect(await signal.count("user", "device")).toBe(1);
    expect(await signal.takeBundle("user", "device")).toMatchObject({ oneTimePreKeyId: 1, oneTimePreKey: "one" });
    expect(await signal.takeBundle("user", "device")).toEqual(bundle);
    expect(await signal.takeBundle("missing", "device")).toBeUndefined();
    expect(await signal.consume("user", "device", 1)).toBe("used");
    expect(await signal.consume("user", "device", 2)).toBe("missing");
    await signal.upload(bundle, [{ keyId: 2, publicKey: "two" }]);
    expect(await signal.consume("user", "device", 2)).toBe("consumed");
    await signal.createSession({ id: "session", ownerUserId: "user", peerUserId: "peer", deviceId: "device", metadata: {}, updatedAt: workspace.createdAt });
    expect(await signal.session("session")).toMatchObject({ ownerUserId: "user" });
    expect(await signal.sessions("peer")).toHaveLength(1);
  });
});

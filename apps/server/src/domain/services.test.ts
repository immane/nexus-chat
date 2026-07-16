import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { BotManifest, Channel, Workspace } from "@nexus-chat/shared";
import { attachmentService } from "./attachments/service.js";
import { authService, verifyAccessToken } from "./auth/service.js";
import { botService } from "./bots/service.js";
import { messageService } from "./messages/service.js";
import { resetStore } from "./test-utils.js";
import { signalService } from "./signal/service.js";
import { store } from "./store.js";
import { workspaceService } from "./workspaces/service.js";

const expectError = (value: unknown, code: string) => {
  const error = (value as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && "ok" in error) expect(error).toMatchObject({ ok: false, error: { code } });
  else expect(value).toMatchObject({ ok: false, error: { code } });
};

const createWorkspaceWithMember = () => {
  const workspace = workspaceService.createWorkspace("user-owner", "Acme");
  workspaceService.addMember("user-owner", workspace.id, "user-member", "member");
  return workspace;
};

const createChannel = (workspace: Workspace, mode: "normal" | "e2e" = "normal") => {
  const channel = workspaceService.createChannel("user-owner", workspace.id, `${mode}-channel-${store.channels.size}`, mode, false) as Channel;
  workspaceService.addChannelMember("user-owner", channel.id, "user-member");
  return channel;
};

describe("server domain services", async () => {
  beforeEach(() => resetStore());

  it("registers logs in refreshes rotates and detects replay", async () => {
    const registered = await authService.register("ada@example.com", "Password12345!", "Ada");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(verifyAccessToken(registered.session.tokens.accessToken)).toBe(registered.session.user.id);
    await expect(authService.login("ada@example.com", "bad")).resolves.toMatchObject({ ok: false });
    const loggedIn = await authService.login("ada@example.com", "Password12345!");
    expect(loggedIn.ok).toBe(true);
    if (!loggedIn.ok) return;
    const refreshed = await authService.refresh(loggedIn.session.tokens.refreshToken);
    expect(refreshed.ok).toBe(true);
    expectError(await authService.refresh(loggedIn.session.tokens.refreshToken), "AUTH_REFRESH_REPLAY");
    await authService.logout(registered.session.tokens.refreshToken);
    expect((await authService.me(registered.session.user.id))?.email).toBe("ada@example.com");
    expect(verifyAccessToken("not-a-token")).toBeNull();
  });

  it("handles auth conflict missing users and missing current user", async () => {
    const registered = await authService.register("grace@example.com", "Password12345!", "Grace");
    expect(registered.ok).toBe(true);
    await expect(authService.register("grace@example.com", "Password12345!", "Grace Again")).resolves.toMatchObject({ ok: false, error: { error: { code: "CONFLICT" } } });
    if (!registered.ok) return;

    expect((await authService.lookupByEmail("grace@example.com"))?.id).toBe(registered.session.user.id);
    expect(await authService.lookupByEmail("nobody@example.com")).toBeUndefined();

    const refreshToken = "nxrefresh_missing_user";
    store.refreshSessions.set(refreshToken, { userId: registered.session.user.id, tokenHash: createHash("sha256").update(refreshToken).digest("hex"), expiresAt: Date.now() + 1000 });
    store.users.delete(registered.session.user.id);

    await expect(authService.refresh(refreshToken)).resolves.toMatchObject({ ok: false, error: { error: { code: "AUTH_REQUIRED" } } });
    expect(await authService.me(registered.session.user.id)).toBeUndefined();
  });

  it("manages workspaces members channels and idempotent DMs", async () => {
    const workspace = createWorkspaceWithMember();
    expect(workspaceService.listWorkspaces("user-owner")).toHaveLength(1);
    expect(workspaceService.getWorkspace("user-member", workspace.id)?.name).toBe("Acme");
    expect(workspaceService.listChannels("user-owner", workspace.id).some((channel) => channel.name === "general")).toBe(true);
    expect(workspaceService.updateWorkspace("user-owner", workspace.id, "Acme Renamed")).toMatchObject({ name: "Acme Renamed" });
    expectError(workspaceService.addMember("user-member", workspace.id, "user-3", "member"), "FORBIDDEN");
    expectError(workspaceService.addMember("user-member", workspace.id, "user-3", "owner"), "FORBIDDEN");
    expect(workspaceService.addMember("user-owner", workspace.id, "user-admin", "admin")).toMatchObject({ role: "admin" });
    expectError(workspaceService.removeMember("user-admin", workspace.id, "user-owner"), "FORBIDDEN");
    expectError(workspaceService.removeMember("user-admin", workspace.id, "user-admin"), "FORBIDDEN");
    expect(workspaceService.transferOwnership("user-owner", workspace.id, "user-member")).toMatchObject({ userId: "user-member", role: "owner" });
    expect(workspaceService.getRole("user-owner", workspace.id)).toBe("admin");
    expect(workspaceService.transferOwnership("user-member", workspace.id, "user-owner")).toMatchObject({ userId: "user-owner", role: "owner" });
    const channel = createChannel(workspace);
    const duplicate = workspaceService.createChannel("user-owner", workspace.id, channel.name, "normal", false);
    expectError(duplicate, "CONFLICT");
    expect(workspaceService.listChannels("user-member", workspace.id).map((item) => item.id)).toContain(channel.id);
    expect(workspaceService.listMembers("user-owner", workspace.id).map((item) => item.userId)).toEqual(expect.arrayContaining(["user-owner", "user-member", "user-admin"]));
    const privateChannel = workspaceService.createChannel("user-owner", workspace.id, "private", "normal", true) as Channel;
    expect(workspaceService.canAccessChannel("user-member", privateChannel.id)).toBe(false);
    expect(workspaceService.canAccessChannel("user-member", channel.id)).toBe(true);
    expect(workspaceService.listChannelMembers("user-owner", channel.id).map((item) => item.userId)).toEqual(expect.arrayContaining(["user-owner", "user-member"]));
    expect(workspaceService.removeChannelMember("user-owner", channel.id, "user-member")).toBe(true);
    workspaceService.addChannelMember("user-owner", channel.id, "user-member");
    expect(workspaceService.archiveChannel("user-owner", channel.id)).toMatchObject({ archivedAt: expect.any(String) });
    expectError(workspaceService.addChannelMember("user-owner", channel.id, "user-3"), "FORBIDDEN");
    expect(workspaceService.deleteChannel("user-owner", privateChannel.id)).toMatchObject({ deletedAt: expect.any(String) });
    expect(workspaceService.canAccessChannel("user-owner", privateChannel.id)).toBe(false);
    const dm1 = workspaceService.createOrGetDm("user-owner", workspace.id, "user-member", "e2e") as Channel;
    const dm2 = workspaceService.createOrGetDm("user-member", workspace.id, "user-owner", "e2e") as Channel;
    expect(dm2.id).toBe(dm1.id);
    expect(workspaceService.removeMember("user-owner", workspace.id, "user-member")).toBe(true);
    expect(workspaceService.listChannels("stranger", workspace.id)).toEqual([]);
    expect(workspaceService.canManageChannel("user-owner", "missing-channel")).toBe(false);
    expectError(workspaceService.archiveChannel("user-owner", "missing-channel"), "FORBIDDEN");
    expectError(workspaceService.deleteChannel("user-owner", "missing-channel"), "FORBIDDEN");
    expectError(workspaceService.createChannel("stranger", workspace.id, "no", "normal", false), "FORBIDDEN");
    expectError(workspaceService.addChannelMember("stranger", channel.id, "user-member"), "FORBIDDEN");
    expectError(workspaceService.removeChannelMember("stranger", channel.id, "user-member"), "FORBIDDEN");
    expectError(workspaceService.createOrGetDm("user-owner", workspace.id, "missing-user", "normal"), "FORBIDDEN");
  });

  it("sends normal and E2E messages with idempotency and validation", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const e2e = createChannel(workspace, "e2e");
    const sent = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "client-1", content: { type: "text", text: "hello", attachments: [] } });
    expect("id" in sent && sent.content.type).toBe("text");
    const duplicate = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "client-1", content: { type: "text", text: "ignored", attachments: [] } });
    expect("id" in duplicate && "id" in sent && duplicate.id).toBe("id" in sent ? sent.id : "");
    expectError(await messageService.send("user-owner", { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "client-2", content: { type: "text", text: "no", attachments: [] } }), "VALIDATION_FAILED");
    expectError(await messageService.send("stranger", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "client-x", content: { type: "text", text: "no", attachments: [] } }), "FORBIDDEN");
    expectError(await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "client-y", content: { type: "ciphertext", ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", readOnce: false, attachments: [] } }), "VALIDATION_FAILED");
    const encrypted = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "client-3", content: { type: "ciphertext", ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", readOnce: false, attachments: [] } });
    expect("id" in encrypted && encrypted.content.type).toBe("ciphertext");
    expect(await messageService.list("user-owner", normal.id, undefined, 10)).toHaveLength(1);
    if ("id" in sent) {
      expect(await messageService.edit("user-owner", sent.id, "edited")).toMatchObject({ content: { text: "edited" } });
      expect(await messageService.react("user-member", sent.id, "👍")).toMatchObject({ messageId: sent.id, emoji: "👍", count: 1, reacted: true });
      expect(await messageService.react("user-member", sent.id, "👍", "remove")).toMatchObject({ messageId: sent.id, emoji: "👍", count: 0, reacted: false });
      expect(await messageService.save("user-member", sent.id)).toMatchObject({ messageId: sent.id, saved: true });
      expect(await messageService.save("user-member", sent.id)).toMatchObject({ messageId: sent.id, saved: true });
      expect((await messageService.listSaved("user-member")).map((message) => message.id)).toEqual([sent.id]);
      expect(await messageService.listSaved("user-owner")).toEqual([]);
      expect(await messageService.forward("user-owner", sent.id, normal.id, "client-4")).toMatchObject({ clientMsgId: "client-4", originalMessageId: sent.id, originalSenderId: "user-owner" });
      expect(await messageService.softDelete("user-owner", sent.id)).toMatchObject({ state: "deleted", content: { type: "tombstone", reason: "deleted" } });
      expect(store.messageEvents.map((item) => item.type)).toEqual(expect.arrayContaining(["message.updated", "message.reaction", "message.deleted"]));
    }
    if ("id" in encrypted) expectError(await messageService.edit("user-owner", encrypted.id, "no"), "VALIDATION_FAILED");
    expectError(await messageService.edit("user-member", "missing", "no"), "FORBIDDEN");
    expectError(await messageService.softDelete("user-member", "missing"), "FORBIDDEN");
    expectError(await messageService.forward("user-owner", "missing", normal.id, "client-5"), "NOT_FOUND");
    expectError(await messageService.save("user-owner", "missing"), "NOT_FOUND");
    expectError(await messageService.react("user-owner", "missing", "👍"), "NOT_FOUND");
    const privateMessage = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: (workspaceService.createChannel("user-owner", workspace.id, "owner-private", "normal", true) as Channel).id, clientMsgId: "private-1", content: { type: "text", text: "private", attachments: [] } });
    if ("id" in privateMessage) {
      expectError(await messageService.save("user-member", privateMessage.id), "FORBIDDEN");
      expectError(await messageService.react("user-member", privateMessage.id, "👍"), "FORBIDDEN");
      expectError(await messageService.ackRead("user-member", privateMessage.id), "FORBIDDEN");
    }
    if ("id" in sent) {
      expect(await messageService.ackRead("user-owner", sent.id)).toEqual({ accepted: true });
      expectError(await messageService.ackRead("stranger", sent.id), "FORBIDDEN");
    }
  });

  it("tracks unread counts and marks channels read per member", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const privateChannel = workspaceService.createChannel("user-owner", workspace.id, "owner-only", "normal", true) as Channel;

    expect(await messageService.getUnreadCounts("stranger", workspace.id)).toEqual({});
    expectError(await messageService.markRead("stranger", normal.id), "FORBIDDEN");

    await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "unread-1", content: { type: "text", text: "one", attachments: [] } });
    await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "unread-2", content: { type: "text", text: "two", attachments: [] } });
    await messageService.send("user-member", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "own-message", content: { type: "text", text: "mine", attachments: [] } });
    await messageService.send("user-owner", { workspaceId: workspace.id, channelId: privateChannel.id, clientMsgId: "private-unread", content: { type: "text", text: "secret", attachments: [] } });

    expect(await messageService.getUnreadCounts("user-member", workspace.id)).toEqual({ [normal.id]: 2 });
    expect(await messageService.getUnreadCounts("user-owner", workspace.id)).toEqual({ [normal.id]: 1 });
    expect(await messageService.markRead("user-member", normal.id)).toEqual({ ok: true });
    expect(await messageService.getUnreadCounts("user-member", workspace.id)).toEqual({});

    const unreadAfterRead = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "unread-after-read", content: { type: "text", text: "new", attachments: [] } });
    if ("id" in unreadAfterRead) store.messages.set(unreadAfterRead.id, { ...unreadAfterRead, createdAt: new Date(Date.now() + 1000).toISOString() });
    expect(await messageService.getUnreadCounts("user-member", workspace.id)).toEqual({ [normal.id]: 1 });
  });

  it("returns workspace members with stored display identities", async () => {
    const createdAt = new Date().toISOString();
    store.users.set("user-owner", { id: "user-owner", email: "owner@example.com", displayName: "Owner", createdAt, passwordHash: "hash" });
    store.users.set("user-member", { id: "user-member", email: "member@example.com", displayName: "Member", createdAt, passwordHash: "hash" });
    const workspace = createWorkspaceWithMember();

    expect(workspaceService.listMembers("user-owner", workspace.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user-owner", role: "owner", email: "owner@example.com", displayName: "Owner" }),
        expect.objectContaining({ userId: "user-member", role: "member", email: "member@example.com", displayName: "Member" })
      ])
    );
  });

  it("paginates messages and flushes read receipts in batches", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    for (let index = 0; index < 105; index += 1) {
      await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: `page-${index}`, content: { type: "text", text: `message ${index}`, attachments: [] } });
    }
    const first = await messageService.listPage("user-member", normal.id, undefined, 50);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    const second = await messageService.listPage("user-member", normal.id, first.nextCursor, 50);
    const third = await messageService.listPage("user-member", normal.id, second.nextCursor, 50);
    expect(new Set([...first.items, ...second.items, ...third.items].map((message) => message.id)).size).toBe(105);
    expect(await messageService.ackRead("user-member", first.items[0]?.id ?? "missing")).toEqual({ accepted: true });
    expect(await messageService.flushReadReceipts(normal.id)).toEqual([{ messageId: first.items[0]?.id, channelId: normal.id, readCount: 1, readers: ["user-member"], flushedAt: expect.any(String) }]);
    store.pendingReadReceipts.push({ messageId: "missing", userId: "user-member", readAt: new Date().toISOString() });
    expect(await messageService.flushReadReceipts()).toEqual([]);
    expect(await messageService.flushReadReceipts(normal.id)).toEqual([]);
  });

  it("returns E2E read-once and TTL messages as tombstones without decrypting content", async () => {
    const workspace = createWorkspaceWithMember();
    const e2e = createChannel(workspace, "e2e");
    const readOnce = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "read-once", content: { type: "ciphertext", ciphertext: "secret", algorithm: "signal-v1", senderDeviceId: "device-1", readOnce: true, attachments: [] } });
    expect("id" in readOnce && await messageService.ackRead("user-member", readOnce.id)).toEqual({ accepted: true });
    expect((await messageService.list("user-member", e2e.id, undefined, 10))[0]).toMatchObject({ content: { type: "tombstone", reason: "read_once_consumed" } });
    const ttl = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "ttl", content: { type: "ciphertext", ciphertext: "ttl-secret", algorithm: "signal-v1", senderDeviceId: "device-1", readOnce: false, expiresAt: new Date(Date.now() - 1000).toISOString(), attachments: [] } });
    if (!("id" in ttl)) return;
    expect(await messageService.cleanupExpiredMessages()).toEqual([expect.objectContaining({ id: ttl.id, content: { type: "tombstone", reason: "expired" } })]);
    expect((await messageService.list("user-member", e2e.id, undefined, 10)).find((message) => message.id === ttl.id)).toMatchObject({ content: { type: "tombstone", reason: "expired" } });
  });

  it("handles attachment lifecycle with workspace and channel authorization", async () => {
    const workspace = createWorkspaceWithMember();
    const channel = createChannel(workspace);
    expectError(await attachmentService.createUploadSession("stranger", { workspaceId: workspace.id, fileName: "x", contentType: "text/plain", sizeBytes: 1, encrypted: false }), "FORBIDDEN");
    expectError(await attachmentService.createUploadSession("user-owner", { workspaceId: workspace.id, channelId: "missing-channel", fileName: "x", contentType: "text/plain", sizeBytes: 1, encrypted: false }), "FORBIDDEN");
    const created = await attachmentService.createUploadSession("user-owner", { workspaceId: workspace.id, channelId: channel.id, fileName: "x.txt", contentType: "text/plain", sizeBytes: 12, encrypted: false });
    if ("file" in created) {
      expect(created.file.scanStatus).toBe("pending");
      expect(created.file.objectKey).toContain("x.txt");
      expect(created.file.channelId).toBe(channel.id);
    }
    const encrypted = await attachmentService.createUploadSession("user-owner", { workspaceId: workspace.id, channelId: channel.id, fileName: "e.bin", contentType: "application/octet-stream", sizeBytes: 5, encrypted: true });
    if ("file" in encrypted) {
      expect(encrypted.file.scanStatus).toBe("skipped");
      expect(encrypted.file.encrypted).toBe(true);
    }
    if ("file" in created) {
      store.files.set(created.file.id, { ...created.file, scanStatus: "blocked" });
      expectError(await attachmentService.validateAttachmentRefs([{ fileId: created.file.id, name: "x.txt", mimeType: "text/plain", size: 12, scanStatus: "blocked" }]), "FORBIDDEN");
      store.files.set(created.file.id, created.file);
      expect(await attachmentService.getFile("user-owner", created.file.id)).toMatchObject({ fileName: "x.txt", objectKey: expect.stringContaining("x.txt") });
      expect(await attachmentService.completeUpload("user-owner", created.uploadSession.id)).toMatchObject({ completedAt: expect.any(String) });
      expect(await attachmentService.createDownloadUrl("user-owner", created.file.id)).toMatchObject({ url: expect.stringContaining(created.file.id) });
      expectError(await attachmentService.completeUpload("user-member", created.uploadSession.id), "NOT_FOUND");
    }
    expect(await attachmentService.getMessageAttachments("missing-message")).toEqual([]);
    expectError(await attachmentService.getFile("user-owner", "missing"), "NOT_FOUND");
    expectError(await attachmentService.createDownloadUrl("user-owner", "missing"), "NOT_FOUND");
  });

  it("validates message attachment refs and tracks message-attachment associations", async () => {
    const workspace = createWorkspaceWithMember();
    const channel = createChannel(workspace);
    const created = await attachmentService.createUploadSession("user-owner", { workspaceId: workspace.id, channelId: channel.id, fileName: "f.txt", contentType: "text/plain", sizeBytes: 12, encrypted: false });
    if (!("file" in created)) return;
    await attachmentService.completeUpload("user-owner", created.uploadSession.id);
    const attachmentRef = { fileId: created.file.id, name: "f.txt", mimeType: "text/plain", size: 12, scanStatus: "pending" as const };
    const sent = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: channel.id, clientMsgId: "with-att", content: { type: "text", text: "file attached", attachments: [attachmentRef] } });
    expect("id" in sent).toBe(true);
    if ("id" in sent) {
      expect(await attachmentService.getMessageAttachments(sent.id)).toEqual([expect.objectContaining({ fileName: "f.txt" })]);
    }
    expectError(await messageService.send("user-owner", { workspaceId: workspace.id, channelId: channel.id, clientMsgId: "bad-att", content: { type: "text", text: "bad", attachments: [{ fileId: "missing-file", name: "x", mimeType: "text/plain", size: 1, scanStatus: "pending" }] } }), "NOT_FOUND");
  });

  it("validates E2E attachment metadata boundary", async () => {
    const workspace = createWorkspaceWithMember();
    const channel = createChannel(workspace);
    const created = await attachmentService.createUploadSession("user-owner", { workspaceId: workspace.id, channelId: channel.id, fileName: "secret.bin", contentType: "application/octet-stream", sizeBytes: 64, encrypted: true });
    if (!("file" in created)) return;
    expect(created.file.encrypted).toBe(true);
    expect(created.file.scanStatus).toBe("skipped");
    expect(await attachmentService.validateAttachmentRefs([{ fileId: created.file.id, name: "secret.bin", mimeType: "application/octet-stream", size: 64, scanStatus: "skipped" }])).toHaveLength(1);
    expectError(await attachmentService.validateAttachmentRefs([{ fileId: created.file.id, name: "secret.bin", mimeType: "application/octet-stream", size: 64, scanStatus: "pending" }]), "VALIDATION_FAILED");
  });

  it("installs bots subscribes to events validates tokens and rejects E2E bot access", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const e2e = createChannel(workspace, "e2e");
    const manifest: BotManifest = { id: "bot-help", name: "Help", description: "Help", commands: [{ name: "/help", description: "Help" }], scopes: ["commands:handle"] };
    const installed = await botService.install("user-owner", workspace.id, manifest);
    expect(installed.token).toMatch(/^nxbot_v1_/);
    expect((await botService.validateToken(installed.token))?.id).toBe("bot-help");
    expect(await botService.validateToken("nxbot_v1_wrong")).toBeUndefined();
    expectError(await botService.addToChannel("missing", normal.id), "NOT_FOUND");
    expect(await botService.addToChannel("bot-help", normal.id)).toEqual({ botId: "bot-help", channelId: normal.id });
    expectError(await botService.addToChannel("bot-help", e2e.id), "E2E_BOT_NOT_ALLOWED");
    expectError(workspaceService.addChannelMember("user-owner", e2e.id, "bot-help"), "E2E_BOT_NOT_ALLOWED");
    expect(await botService.invokeCommand({ workspaceId: workspace.id, channelId: normal.id, userId: "user-owner", command: "/help", args: "" })).toMatchObject({ type: "bot.response" });
    expectError(await botService.invokeCommand({ workspaceId: workspace.id, channelId: e2e.id, userId: "user-owner", command: "/help", args: "" }), "E2E_BOT_NOT_ALLOWED");
    expect(await botService.subscribe("bot-help", "message.created")).toEqual({ botId: "bot-help", subscribed: true });
    expect(await botService.getSubscriptions("bot-help")).toEqual(["message.created"]);
    expect(await botService.unsubscribe("bot-help", "message.created")).toEqual({ botId: "bot-help", unsubscribed: true });
    expect(await botService.getSubscriptions("bot-help")).toEqual([]);
    expect(await botService.removeFromChannel("bot-help", normal.id)).toEqual({ botId: "bot-help", channelId: normal.id });
    expectError(await botService.removeFromChannel("bot-help", e2e.id), "NOT_FOUND");
  });

  it("dispatches bot command events once", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const manifest: BotManifest = { id: "bot-command", name: "CommandBot", description: "Commands", commands: [{ name: "/ping", description: "Ping" }], scopes: ["commands:handle"] };
    await botService.install("user-owner", workspace.id, manifest);
    await botService.addToChannel("bot-command", normal.id);
    await botService.subscribe("bot-command", "bot.command.invoke");

    await botService.invokeCommand({ workspaceId: workspace.id, channelId: normal.id, userId: "user-owner", command: "/ping", args: "" });

    expect(await botService.pollEvents("bot-command")).toHaveLength(1);
  });

  it("sends bot messages validates scopes and dispatches events via queues", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const e2e = createChannel(workspace, "e2e");
    const manifest: BotManifest = { id: "bot-write", name: "Writer", description: "W", commands: [], scopes: ["messages:write"] };
    await botService.install("user-owner", workspace.id, manifest);
    await botService.addToChannel("bot-write", normal.id);
    const botMessage = await botService.sendBotMessage("bot-write", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "bot-msg-1", content: { type: "text", text: "bot says hi", attachments: [] } });
    expect("id" in botMessage && botMessage.senderId).toBe("bot-write");
    expectError(await botService.sendBotMessage("bot-write", { workspaceId: workspace.id, channelId: e2e.id, clientMsgId: "x", content: { type: "text", text: "no", attachments: [] } }), "E2E_BOT_NOT_ALLOWED");
    expectError(await botService.sendBotMessage("bot-write", { workspaceId: workspace.id, channelId: "missing-channel", clientMsgId: "x", content: { type: "text", text: "no", attachments: [] } }), "NOT_FOUND");
    expectError(await botService.sendBotMessage("missing", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "x", content: { type: "text", text: "no", attachments: [] } }), "NOT_FOUND");
    const manifestWithoutWrite: BotManifest = { id: "bot-read", name: "Reader", description: "R", commands: [], scopes: ["messages:read"] };
    await botService.install("user-owner", workspace.id, manifestWithoutWrite);
    await botService.addToChannel("bot-read", normal.id);
    expectError(await botService.sendBotMessage("bot-read", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "x", content: { type: "text", text: "no", attachments: [] } }), "FORBIDDEN");
    await botService.subscribe("bot-write", "message.created");
    const event = await botService.publishEvent({ type: "message.created", workspaceId: workspace.id, channelId: normal.id, payload: {} });
    expect(await botService.pollEvents("bot-write")).toEqual([event]);
    expect(await botService.pollEvents("bot-write")).toEqual([]);
    expectError(await botService.subscribe("missing", "message.created"), "NOT_FOUND");
    expectError(await botService.unsubscribe("missing", "message.created"), "NOT_FOUND");
    expect(await botService.getSubscriptions("missing")).toEqual([]);
  });

  it("stores and fetches signal pre-key bundles and manages one-time pre-key lifecycle", async () => {
    const bundle = { userId: "user-owner", deviceId: "device-1", identityKey: "identity", signedPreKeyId: 1, signedPreKey: "signed", signedPreKeySignature: "signature" };
    const preKeys = [{ keyId: 1, publicKey: "opk-1" }, { keyId: 2, publicKey: "opk-2" }];
    expectError(await signalService.uploadBundle("user-member", bundle), "FORBIDDEN");
    expect(await signalService.uploadBundle("user-owner", bundle, preKeys)).toMatchObject({ identityKey: "identity" });
    expect(await signalService.getRemainingPreKeyCount("user-owner", "device-1")).toBe(2);
    const fetched = await signalService.fetchBundle("user-member", "user-owner", "device-1");
    expect(fetched).toMatchObject({ ...bundle, oneTimePreKeyId: 1, oneTimePreKey: "opk-1" });
    if ("oneTimePreKeyId" in fetched && typeof fetched.oneTimePreKeyId === "number") {
      expect(await signalService.getRemainingPreKeyCount("user-owner", "device-1")).toBe(1);
      expectError(await signalService.consumeOneTimePreKey("user-owner", "device-1", fetched.oneTimePreKeyId), "CONFLICT");
    }
    const secondFetch = await signalService.fetchBundle("user-member", "user-owner", "device-1");
    expect("oneTimePreKeyId" in secondFetch && typeof secondFetch.oneTimePreKeyId === "number" && secondFetch.oneTimePreKeyId).toBe(2);
    expect(await signalService.getRemainingPreKeyCount("user-owner", "device-1")).toBe(0);
    const exhausted = await signalService.fetchBundle("user-member", "user-owner", "device-1");
    expect("oneTimePreKeyId" in exhausted && typeof exhausted.oneTimePreKeyId === "number").toBe(false);
    expectError(await signalService.consumeOneTimePreKey("user-owner", "device-1", 5), "NOT_FOUND");
    expect(store.signalBundles.size).toBe(1);
    // Successful consumption of a fresh key (not auto-consumed by fetchBundle)
    expect(await signalService.uploadBundle("user-owner", { userId: "user-owner", deviceId: "device-2", identityKey: "ik2", signedPreKeyId: 1, signedPreKey: "spk", signedPreKeySignature: "sig" }, [{ keyId: 1, publicKey: "pk" }])).toMatchObject({ identityKey: "ik2" });
    expect(await signalService.consumeOneTimePreKey("user-owner", "device-2", 1)).toEqual({ consumed: true });
    expectError(await signalService.consumeOneTimePreKey("user-owner", "device-2", 1), "CONFLICT");
  });

  it("manages signal sessions lifecycle", async () => {
    const created = await signalService.storeSession("user-owner", "user-member", "device-1");
    expect(created.id).toBeDefined();
    const session = await signalService.getSession(created.id);
    expect(session).toMatchObject({ peerUserId: "user-member", deviceId: "device-1" });
    expect(await signalService.listUserSessions("user-owner")).toHaveLength(1);
    expect(await signalService.listUserSessions("user-member")).toHaveLength(1);
    expect(await signalService.listUserSessions("user-3")).toHaveLength(0);
    expectError(await signalService.getSession("missing"), "NOT_FOUND");
  });

  it("validates replyToMessageId in message send", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");

    const target = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "reply-target", content: { type: "text", text: "target", attachments: [] } });
    expect("id" in target).toBe(true);
    if (!("id" in target)) return;

    // Valid reply
    const reply = await messageService.send("user-member", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "reply-msg", content: { type: "text", text: "reply", attachments: [] }, replyToMessageId: target.id });
    expect("id" in reply && reply.replyToMessageId).toBe(target.id);

    // Reply to missing message
    expectError(await messageService.send("user-member", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "bad-reply", content: { type: "text", text: "bad", attachments: [] }, replyToMessageId: "missing-id" }), "NOT_FOUND");

    // Reply to a deleted message
    await messageService.softDelete("user-owner", target.id);
    expectError(await messageService.send("user-member", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "deleted-reply", content: { type: "text", text: "bad", attachments: [] }, replyToMessageId: target.id }), "NOT_FOUND");

    // Reply from a different channel
    const other = workspaceService.createChannel("user-owner", workspace.id, "other-ch", "normal", false) as Channel;
    const otherMsg = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: other.id, clientMsgId: "other-target", content: { type: "text", text: "other", attachments: [] } });
    if ("id" in otherMsg) {
      expectError(await messageService.send("user-member", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "cross-reply", content: { type: "text", text: "bad", attachments: [] }, replyToMessageId: otherMsg.id }), "NOT_FOUND");
    }
  });

  it("aggregates reactions by message with access control", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const msg = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "react-msg", content: { type: "text", text: "reactable", attachments: [] } });
    expect("id" in msg).toBe(true);
    if (!("id" in msg)) return;

    // No access
    expect(await messageService.getReactions("stranger", normal.id)).toEqual({});

    // Empty reactions
    expect(await messageService.getReactions("user-owner", normal.id)).toEqual({});

    // Add reactions
    await messageService.react("user-owner", msg.id, "👍");
    await messageService.react("user-member", msg.id, "👍");
    await messageService.react("user-member", msg.id, "❤️");

    const reactions = await messageService.getReactions("user-owner", normal.id);
    expect(reactions[msg.id]).toEqual(
      expect.arrayContaining([
        { emoji: "👍", count: 2, reacted: true },
        { emoji: "❤️", count: 1, reacted: false }
      ])
    );

    // Access through channel permission
    const publicCh = workspaceService.createChannel("user-owner", workspace.id, "public", "normal", false) as Channel;
    workspaceService.addChannelMember("user-owner", publicCh.id, "user-member");
    const publicMsg = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: publicCh.id, clientMsgId: "pub-msg", content: { type: "text", text: "hi", attachments: [] } });
    if ("id" in publicMsg) {
      await messageService.react("user-member", publicMsg.id, "🚀");
      expect((await messageService.getReactions("user-member", publicCh.id))[publicMsg.id]).toEqual([{ emoji: "🚀", count: 1, reacted: true }]);
    }
  });

  it("manages pinned messages with access control and limits", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    const msg = await messageService.send("user-owner", { workspaceId: workspace.id, channelId: normal.id, clientMsgId: "pin-msg", content: { type: "text", text: "pin me", attachments: [] } });
    expect("id" in msg).toBe(true);
    if (!("id" in msg)) return;

    // Only admins/creators can pin
    expectError(await messageService.pinMessage("user-member", normal.id, msg.id), "FORBIDDEN");

    // Pin by owner
    expect(await messageService.pinMessage("user-owner", normal.id, msg.id)).toEqual({ pinned: true });
    expect(await messageService.pinMessage("user-owner", normal.id, msg.id)).toEqual({ pinned: true }); // idempotent

    // List pins
    const listResult = await messageService.listPins("user-owner", normal.id);
    expect("ok" in listResult).toBe(false);
    if (!("ok" in listResult)) {
      expect(listResult).toHaveLength(1);
      expect(listResult[0]!.id).toBe(msg.id);
    }

    // Can't access from another channel
    expectError(await messageService.listPins("stranger", normal.id), "FORBIDDEN");

    // Unpin by owner
    expect(await messageService.unpinMessage("user-owner", normal.id, msg.id)).toEqual({ pinned: false });
    expectError(await messageService.unpinMessage("user-owner", normal.id, msg.id), "NOT_FOUND");

    // Cannot pin deleted message
    await messageService.softDelete("user-owner", msg.id);
    expectError(await messageService.pinMessage("user-owner", normal.id, msg.id), "NOT_FOUND");
  });

  it("manages per-user per-channel mute state", async () => {
    const workspace = createWorkspaceWithMember();
    const normal = createChannel(workspace, "normal");
    expect(workspaceService.isChannelMuted("user-owner", normal.id)).toBe(false);
    expectError(workspaceService.muteChannel("stranger", normal.id), "FORBIDDEN");
    expect(workspaceService.muteChannel("user-owner", normal.id)).toEqual({ muted: true });
    expect(workspaceService.isChannelMuted("user-owner", normal.id)).toBe(true);
    expect(workspaceService.isChannelMuted("user-member", normal.id)).toBe(false);
    expect(workspaceService.unmuteChannel("user-owner", normal.id)).toEqual({ muted: false });
    expect(workspaceService.isChannelMuted("user-owner", normal.id)).toBe(false);
  });
});
